import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { ToolMessage } from '@langchain/core/messages'
import { createMiddleware } from 'langchain'
import { z } from 'zod'
import type { AgentAccessMode } from '@shared/agentTypes'
import type { FileEditStore } from '../fileEditStore'
import type { FilePatchRestoreTarget } from '../filePatchRestore'
import type { FilePatchTarget } from '../filePatch'
import { isSameOrInsideDirectory, samePath } from '../pathContainment'
import { canonicalAgentToolEffectJson } from './toolEffectMiddleware'
import { prepareToolPathAuthorization } from './toolAuthorization'
import { pendingModelToolCalls } from './toolInputErrors'

const targetSchema = z.object({
  path: z.string(), lexicalPath: z.string(), locator: z.array(z.union([z.string(), z.number()])),
  kind: z.enum(['file', 'temporary', 'directory']), access: z.enum(['read', 'write'])
})
const receiptSchema = z.object({
  runId: z.string(), calls: z.array(z.object({ id: z.string(), name: z.string(), inputHash: z.string(),
    targets: z.array(targetSchema), requiresApproval: z.boolean(), humanApproved: z.boolean(), error: z.string().optional() }))
})
export const patchAuthorizationStateSchema = z.object({ anasPatchAuthorization: receiptSchema.optional() })
type Receipt = z.infer<typeof receiptSchema>['calls'][number]
const approvedTargets = new AsyncLocalStorage<Receipt['targets']>()
export const isFileEditTool = (name: string): boolean => name === 'apply_patch' || name === 'write_file' || name === 'restore_file_edit'

function hashArgs(args: unknown): string {
  return createHash('sha256').update(canonicalAgentToolEffectJson(args)).digest('hex')
}

export function patchAuthorizationFor(state: unknown, call: { id?: string; name: string; args: unknown }, runId?: string): Receipt | undefined {
  const parsed = patchAuthorizationStateSchema.safeParse(state)
  const receipt = parsed.success ? parsed.data.anasPatchAuthorization : undefined
  if (!receipt || (runId && receipt.runId !== runId)) return undefined
  return receipt.calls.find((item) => (!call.id || item.id === call.id) && item.name === call.name && item.inputHash === hashArgs(call.args))
}

function assertTargets(actual: readonly FilePatchRestoreTarget[], expected: Receipt['targets']): void {
  for (const target of actual) {
    const authorized = expected.filter((item) => item.access === 'write' || target.access === 'read')
    const files = authorized.filter((item) => item.kind === 'file')
    if (authorized.some((item) => item.kind === target.kind && samePath(item.path, target.path))) continue
    // These are validated, managed transaction artifacts, not model-selected
    // write targets. Creating a requested file also authorizes its own staging
    // file and missing parents; recovery may encounter them after a hard exit.
    if (target.kind === 'temporary' && files.some((item) => samePath(dirname(item.path), dirname(target.path)))) continue
    if (target.kind === 'directory' && files.some((item) => isSameOrInsideDirectory(target.path, dirname(item.path)))) continue
    throw new Error(`Patch target was not included in the authorized operation: ${target.path}`)
  }
}

export async function authorizeCurrentPatchTargets(targets: readonly FilePatchRestoreTarget[]): Promise<void> {
  const expected = approvedTargets.getStore()
  if (!expected) throw new Error('Patch execution requires its checkpointed path authorization.')
  assertTargets(targets, expected)
}

export function verifyCurrentPatchInputTargets(targets: readonly FilePatchTarget[]): void {
  const expected = approvedTargets.getStore()
  if (!expected) throw new Error('Patch execution requires its checkpointed path authorization.')
  const files = expected.filter((target) => target.kind === 'file')
  if (targets.length !== files.length || targets.some((target, index) =>
    !samePath(target.canonicalPath, files[index].path)
    || target.access !== files[index].access
    || JSON.stringify(['operations', target.operationIndex, target.field]) !== JSON.stringify(files[index].locator))) {
    throw new Error('Patch file targets changed their operation binding after authorization.')
  }
}

// Product path authorization is checkpointed before native HITL. It must not be
// recomputed as a new grant when an interrupted graph resumes after paths change.
export function createPatchAuthorizationMiddleware(options: {
  runId: string; primaryFolder: string; folders: string[]; accessMode(): AgentAccessMode
  fileEditStore?: Pick<FileEditStore, 'loadOperationRecord'>
}) {
  return createMiddleware({ name: 'AnasPatchAuthorizationMiddleware', stateSchema: patchAuthorizationStateSchema,
    afterModel: async (state) => {
      const pending = pendingModelToolCalls(state.messages).calls
      if (!pending.length) return
      const calls: Receipt[] = []
      for (const call of pending.filter((item) => isFileEditTool(item.name))) {
        try {
          const prepared = await prepareToolPathAuthorization({ toolName: call.name, args: structuredClone(call.args),
            primaryFolder: options.primaryFolder, trustedFolders: options.folders,
            accessMode: options.accessMode() === 'strict_approval' ? 'strict_approval' : 'read_only_allowed',
            requestId: options.runId, fileEditStore: options.fileEditStore })
          calls.push({ id: call.id!, name: call.name, inputHash: hashArgs(call.args), requiresApproval: prepared.requiresApproval, humanApproved: false,
            targets: prepared.targets.map((target) => ({ path: target.canonicalPath, lexicalPath: target.lexicalPath,
              locator: target.locator, kind: target.kind ?? 'file', access: target.access })) })
        } catch (error) {
          calls.push({ id: call.id!, name: call.name, inputHash: hashArgs(call.args), targets: [], requiresApproval: false, humanApproved: false,
            error: `NOT EXECUTED: ${String(error)}. Inspect the operation and decide again.` })
        }
      }
      return { anasPatchAuthorization: { runId: options.runId, calls } }
    },
    wrapToolCall: async (request, handler) => {
      if (!isFileEditTool(request.toolCall.name)) return handler(request)
      const receipt = patchAuthorizationFor(request.state, request.toolCall, options.runId)
      try {
        if (!receipt || receipt.error) throw new Error(receipt?.error ?? 'Missing checkpointed patch authorization.')
        const current = await prepareToolPathAuthorization({ toolName: request.toolCall.name, args: structuredClone(request.toolCall.args),
          primaryFolder: options.primaryFolder, trustedFolders: options.folders, accessMode: options.accessMode(),
          requestId: options.runId, fileEditStore: options.fileEditStore })
        const currentFiles = current.targets.filter((target) => !target.kind || target.kind === 'file')
        const frozenFiles = receipt.targets.filter((target) => target.kind === 'file')
        if (currentFiles.length !== frozenFiles.length || currentFiles.some((target, index) =>
          !samePath(target.canonicalPath, frozenFiles[index].path) || target.access !== frozenFiles[index].access
          || JSON.stringify(target.locator) !== JSON.stringify(frozenFiles[index].locator))) {
          throw new Error('Patch file targets changed their operation binding after authorization.')
        }
        if (current.requiresApproval && !receipt.humanApproved) {
          throw new Error('Patch targets require a new approval after the access mode changed.')
        }
        assertTargets(current.targets.map((target, index) => ({ path: target.canonicalPath, kind: target.kind ?? 'file',
          index, semantics: 'entry', access: target.access })), receipt.targets)
      } catch (error) {
        return new ToolMessage({ name: request.toolCall.name, tool_call_id: request.toolCall.id!, status: 'error',
          content: `NOT EXECUTED: ${String(error)}. Inspect current targets and decide again.` })
      }
      return approvedTargets.run(receipt!.targets, () => handler(request))
    }
  })
}
