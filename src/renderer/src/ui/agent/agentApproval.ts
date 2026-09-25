import type {
  AgentApprovalDecision,
  AgentApprovalPathPreview,
  AgentInterrupt,
  AgentInterruptResponse
} from '@shared/agentTypes'
import { builtinFileToolNames } from '@shared/toolRegistry'
import { isCommandShellToolName } from '@shared/commandShell'

export type ApprovalDescriptionKind = 'shell' | 'host_file' | 'configuration'

const hostFileApprovalToolNames = new Set<string>([
  ...builtinFileToolNames,
  'http_request'
])

export function approvalDescriptionKind(toolName: string): ApprovalDescriptionKind | undefined {
  if (isCommandShellToolName(toolName)) return 'shell'
  if (toolName === 'update_config') return 'configuration'
  return hostFileApprovalToolNames.has(toolName) ? 'host_file' : undefined
}

export interface ApprovalAction {
  interruptId: string
  approvalGeneration: string
  name: string
  args: Record<string, unknown>
  description?: string
  recovery?: {
    ordinal: number
    state: 'uncertain'
  }
  pathPreviews: AgentApprovalPathPreview[]
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

export function interruptActions(interrupts: AgentInterrupt[]): ApprovalAction[] {
  return interrupts.flatMap((interrupt) => {
    const payload = asRecord(interrupt.value)
    const requests = payload.actionRequests
    if (!Array.isArray(requests)) return []
    return requests.map((request, actionIndex) => {
      const action = asRecord(request)
      const recovery = asRecord(action.anasRecovery)
      const recoveryOrdinal = typeof recovery.ordinal === 'number'
        && Number.isInteger(recovery.ordinal)
        && recovery.ordinal > 0
        ? recovery.ordinal
        : undefined
      return {
        interruptId: interrupt.id,
        approvalGeneration: interrupt.approvalGeneration,
        name: typeof action.name === 'string' ? action.name : 'action',
        args: asRecord(action.args),
        description: typeof action.description === 'string' ? action.description : undefined,
        ...(recovery.state === 'uncertain' && recoveryOrdinal !== undefined
          ? { recovery: { ordinal: recoveryOrdinal, state: 'uncertain' as const } }
          : {}),
        pathPreviews: (interrupt.pathPreviews ?? [])
          .filter((preview) => preview.actionIndex === actionIndex)
      }
    })
  })
}

function responsesForEveryAction(
  actions: ApprovalAction[],
  decisionForAction: (action: ApprovalAction) => AgentApprovalDecision
): AgentInterruptResponse[] {
  const responses = new Map<string, {
    decisions: AgentApprovalDecision[]
    expectedGeneration: string
  }>()
  for (const action of actions) {
    const response = responses.get(action.interruptId) ?? {
      decisions: [],
      expectedGeneration: action.approvalGeneration
    }
    if (response.expectedGeneration !== action.approvalGeneration) {
      throw new Error(`Interrupt ${action.interruptId} has conflicting approval generations.`)
    }
    response.decisions.push(decisionForAction(action))
    responses.set(action.interruptId, response)
  }
  return [...responses].map(([interruptId, response]) => ({
    interruptId,
    decisions: response.decisions,
    expectedGeneration: response.expectedGeneration
  }))
}

export function approvalResponses(actions: ApprovalAction[]): AgentInterruptResponse[] {
  return responsesForEveryAction(actions, () => ({ type: 'approve' }))
}

export function rejectionResponses(
  actions: ApprovalAction[],
  guidance = ''
): AgentInterruptResponse[] {
  const userFeedback = guidance.trim()
  return responsesForEveryAction(actions, (action) => userFeedback
    ? {
        type: 'reject',
        message: `User rejected the tool call for \`${action.name}\`.\nUser feedback: ${userFeedback}`
      }
    : { type: 'reject' })
}
