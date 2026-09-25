import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { createMiddleware } from 'langchain'
import { z } from 'zod'
import type { AgentAccessMode } from '@shared/agentTypes'
import type { createShellCommandAuthorization } from '../shellCommandAuthorization'
import { samePath } from '../pathContainment'
import { canonicalAgentToolEffectJson } from './toolEffectMiddleware'
import { pendingModelToolCalls } from './toolInputErrors'
import { HumanMessage, type BaseMessage } from '@langchain/core/messages'
import { toAgentMessage } from './messageMapper'

const receiptSchema = z.object({ runId: z.string(), calls: z.array(z.object({
  id: z.string(), name: z.string(), inputHash: z.string(), requiresApproval: z.boolean(), humanApproved: z.boolean(),
  plan: z.object({ workingDir: z.string(), executable: z.string(), paths: z.array(z.string()),
    skillScript: z.object({ skillId: z.string(), root: z.string(), script: z.string(), executor: z.string() }).optional()
  }).optional()
})) })
export const shellAuthorizationStateSchema = z.object({ anasShellAuthorization: receiptSchema.optional() })
type Receipt = z.infer<typeof receiptSchema>['calls'][number]
type Analyzer = ReturnType<typeof createShellCommandAuthorization>
const dispatch = new AsyncLocalStorage<() => Promise<void>>()

function explicitSkill(messages: BaseMessage[]) {
  const user = [...messages].reverse().find(HumanMessage.isInstance)
  return user ? toAgentMessage(user, '').skillInvocation : undefined
}

function hashArgs(args: unknown): string {
  return createHash('sha256').update(canonicalAgentToolEffectJson(args)).digest('hex')
}

export function shellAuthorizationFor(state: unknown, call: { id?: string; name: string; args: unknown }, runId?: string): Receipt | undefined {
  const parsed = shellAuthorizationStateSchema.safeParse(state)
  const receipt = parsed.success ? parsed.data.anasShellAuthorization : undefined
  if (!receipt || receipt.runId !== (runId ?? '')) return undefined
  return receipt.calls.find((item) => item.id === call.id && item.name === call.name && item.inputHash === hashArgs(call.args))
}

/** Run at the actual Shell boundary, including delayed background dispatch. The
 * checkpoint owns the grant; AsyncLocalStorage only carries this invocation's
 * verifier to the runner and never substitutes for durable authorization. */
export async function verifyCurrentShellAuthorization(): Promise<void> {
  const verify = dispatch.getStore()
  if (!verify) throw new Error('Shell execution requires its checkpointed authorization.')
  await verify()
}

export function createShellAuthorizationMiddleware(options: {
  runId?: string; toolName: string; analyzer: Analyzer; accessMode(): AgentAccessMode
}) {
  return createMiddleware({ name: 'AnasShellAuthorizationMiddleware', stateSchema: shellAuthorizationStateSchema,
    afterModel: async (state) => {
      const pending = pendingModelToolCalls(state.messages).calls
      if (!pending.length) return
      const calls: Receipt[] = []
      for (const call of pending.filter((item) => item.name === options.toolName)) {
        const fullAccess = options.accessMode() === 'full_access'
        const plan = fullAccess ? undefined : await options.analyzer.inspect(call.args, explicitSkill(state.messages))
        calls.push({ id: call.id!, name: call.name, inputHash: hashArgs(call.args),
          requiresApproval: !fullAccess && !plan, humanApproved: false, ...(plan ? { plan } : {}) })
      }
      return { anasShellAuthorization: { runId: options.runId ?? '', calls } }
    },
    wrapToolCall: async (request, handler) => {
      if (request.toolCall.name !== options.toolName) return handler(request)
      const receipt = shellAuthorizationFor(request.state, request.toolCall, options.runId)
      const verify = async () => {
        if (!receipt || receipt.inputHash !== hashArgs(request.toolCall.args)) {
          throw new Error('Missing or changed checkpointed Shell authorization. Submit the command again.')
        }
        if (receipt.humanApproved) return
        if (!receipt.plan) {
          if (options.accessMode() === 'full_access') return
          throw new Error('Shell command requires approval after the access mode changed. Submit the command again.')
        }
        const current = await options.analyzer.inspect(request.toolCall.args, explicitSkill(request.state.messages))
        const expected = receipt.plan
        const currentSkill = current?.skillScript, expectedSkill = expected.skillScript
        const sameSkill = !currentSkill && !expectedSkill || currentSkill && expectedSkill
          && currentSkill.skillId === expectedSkill.skillId && samePath(currentSkill.root, expectedSkill.root)
          && samePath(currentSkill.script, expectedSkill.script) && samePath(currentSkill.executor, expectedSkill.executor)
        if (!current || !samePath(current.executable, expected.executable) || !samePath(current.workingDir, expected.workingDir)
          || !sameSkill
          || current.paths.length !== expected.paths.length || current.paths.some((path, index) => !samePath(path, expected.paths[index]))) {
          throw new Error('Auto-approved Shell targets changed or could not be verified before execution. Submit the original command again for authorization.')
        }
      }
      return dispatch.run(verify, () => handler(request))
    }
  })
}
