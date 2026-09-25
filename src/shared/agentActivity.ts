import type {
  AgentRunActivity,
  AgentSubagentActivity,
  AgentToolActivity
} from './agentTypes'

export function delegationToolForSubagent(
  activity: AgentRunActivity,
  subagent: AgentSubagentActivity
): AgentToolActivity | undefined {
  return activity.tools.find((tool) =>
    tool.call.name.toLowerCase() === 'start_subagent'
    && subagentIdFromStartOutput(tool.output) === subagent.id
    && tool.subagentId === subagent.parentSubagentId
  )
}

function subagentIdFromStartOutput(output: unknown): string | undefined {
  let value = output
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      return undefined
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const subagentId = (value as Record<string, unknown>).subagent_id
  return typeof subagentId === 'string' ? subagentId : undefined
}

export function visibleToolsForAgent(
  activity: AgentRunActivity,
  agentId?: string
): AgentToolActivity[] {
  return activity.tools.filter((tool) =>
    tool.subagentId === agentId
    && !(
      tool.call.name.toLowerCase() === 'start_subagent'
      && activity.subagents.some((subagent) => (
        subagent.parentSubagentId === agentId
        && subagentIdFromStartOutput(tool.output) === subagent.id
      ))
    )
  )
}

export function upsertSubagentActivity(
  activities: AgentSubagentActivity[],
  update: AgentSubagentActivity
): AgentSubagentActivity[] {
  const existingIndex = activities.findIndex((activity) => activity.id === update.id)
  return existingIndex < 0
    ? [...activities, update]
    : activities.map((activity, index) => index === existingIndex ? update : activity)
}

export function applySubagentActivityUpdate<T extends AgentRunActivity>(
  activity: T,
  update: AgentSubagentActivity
): T {
  const subagents = upsertSubagentActivity(activity.subagents, update)
  const terminal = update.status === 'completed'
    || update.status === 'failed'
    || update.status === 'cancelled'
  if (!terminal) return { ...activity, subagents }

  return {
    ...activity,
    models: activity.models.map((model) => (
      model.subagentId === update.id && model.status === 'running'
        ? {
            ...model,
            toolCallProgress: undefined,
            status: 'completed',
            completedAt: model.completedAt ?? update.completedAt
          }
        : model
    )),
    tools: activity.tools.map((tool) => {
      if (tool.subagentId !== update.id || tool.status !== 'running') return tool
      const { approval: _approval, ...settled } = tool
      return {
        ...settled,
        status: 'completed',
        completedAt: tool.completedAt ?? update.completedAt
      }
    }),
    subagents
  }
}

function compactToolArgument(
  args: unknown,
  keys: readonly string[]
): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  const record = args as Record<string, unknown>
  return keys
    .map((key) => record[key])
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
    ?.replace(/\s+/g, ' ')
    .trim()
}

export function toolProvidedSummary(args: unknown): string | undefined {
  return compactToolArgument(args, ['summary'])
}

export function toolArgumentSummary(args: unknown): string {
  return compactToolArgument(
    args,
    ['summary', 'description', 'path', 'url', 'query', 'command']
  ) ?? ''
}

export function subagentDescription(
  activity: AgentRunActivity,
  subagent: AgentSubagentActivity
): string | undefined {
  const args = delegationToolForSubagent(activity, subagent)?.call.args
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  const description = (args as Record<string, unknown>).description
  return typeof description === 'string'
    ? description.replace(/\s+/g, ' ').trim() || undefined
    : undefined
}
