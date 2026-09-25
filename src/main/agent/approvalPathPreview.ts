import { isAbsolute } from 'node:path'
import type {
  AgentApprovalPathPreview,
  AgentInterrupt
} from '@shared/agentTypes'
import {
  resolveCanonicalWorkspacePath,
  type WorkspacePathSemantics
} from '../workspacePath'
import { toolPathArguments } from './toolPathArguments'
import { isCommandShellToolName } from '@shared/commandShell'
import { isFileEditTool, patchAuthorizationFor } from './patchAuthorization'

export function interruptActionRequests(
  interrupt: Pick<AgentInterrupt, 'value'>
): Array<{
  name: string
  args: unknown
}> {
  if (!interrupt.value || typeof interrupt.value !== 'object') return []
  const actions = (interrupt.value as { actionRequests?: unknown }).actionRequests
  if (!Array.isArray(actions)) return []
  return actions.flatMap((action) => {
    if (!action || typeof action !== 'object') return []
    const request = action as { name?: unknown; args?: unknown }
    return typeof request.name === 'string'
      ? [{ name: request.name, args: request.args ?? {} }]
      : []
  })
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

async function relativePathPreview(
  rawPath: unknown,
  primaryFolder: string,
  preview: Omit<AgentApprovalPathPreview, 'absolutePath' | 'source'>,
  semantics: WorkspacePathSemantics
): Promise<AgentApprovalPathPreview | undefined> {
  if (typeof rawPath !== 'string' || !rawPath.trim()) return undefined
  try {
    const target = await resolveCanonicalWorkspacePath(rawPath, primaryFolder, semantics)
    return {
      ...preview,
      absolutePath: target.canonicalPath,
      source: !isAbsolute(rawPath.trim())
        ? 'relative'
        : target.canonicalPath === target.lexicalPath
          ? 'resolved'
          : 'canonical'
    }
  } catch {
    return undefined
  }
}

async function actionPathPreviews(
  name: string,
  args: Record<string, unknown>,
  actionIndex: number,
  primaryFolder: string,
  state?: unknown
): Promise<AgentApprovalPathPreview[]> {
  if (isFileEditTool(name)) {
    const paths = name !== 'restore_file_edit' ? toolPathArguments(name, args) : undefined
    return patchAuthorizationFor(state, { name, args })?.targets.map((target) => {
      const raw = paths?.find((path) => JSON.stringify(path.locator) === JSON.stringify(target.locator))?.value
      return { actionIndex, locator: name === 'write_file' ? ['path'] : target.locator, absolutePath: target.path,
        source: name === 'restore_file_edit' || raw === target.path ? 'resolved' as const
          : typeof raw === 'string' && !isAbsolute(raw) ? 'relative' as const : 'canonical' as const }
    }) ?? []
  }
  if (isCommandShellToolName(name)) {
    const workingDirectory = args.working_dir
    if (typeof workingDirectory !== 'string' || !workingDirectory.trim()) {
      return [{
        actionIndex,
        locator: ['working_dir'],
        absolutePath: primaryFolder,
        source: 'default'
      }]
    }
    const preview = await relativePathPreview(workingDirectory, primaryFolder, {
      actionIndex,
      locator: ['working_dir']
    }, 'follow')
    return preview ? [preview] : []
  }

  const argumentsWithPaths = toolPathArguments(name, args)
  if (!argumentsWithPaths) return []
  const previews = await Promise.all(argumentsWithPaths.map(async (argument) => {
    return relativePathPreview(argument.value, primaryFolder, {
      actionIndex,
      locator: argument.locator
    }, argument.semantics)
  }))
  return previews.filter((preview): preview is AgentApprovalPathPreview => Boolean(preview))
}

export async function projectInterruptPathPreviews(
  interrupts: AgentInterrupt[],
  primaryFolder: string | undefined,
  state?: unknown
): Promise<AgentInterrupt[]> {
  if (!primaryFolder) return interrupts
  return Promise.all(interrupts.map(async (interrupt) => {
    const pathPreviews = (await Promise.all(interruptActionRequests(interrupt).map((action, actionIndex) =>
      actionPathPreviews(
        action.name,
        asRecord(action.args),
        actionIndex,
        primaryFolder,
        state
      )
    ))).flat()
    return pathPreviews.length > 0 ? { ...interrupt, pathPreviews } : interrupt
  }))
}
