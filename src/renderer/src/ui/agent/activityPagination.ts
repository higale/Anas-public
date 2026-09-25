import type { AgentModelActivity, AgentRunActivity, AgentSubagentActivity } from '@shared/agentTypes'

function modelKey(model: AgentModelActivity): string {
  return `${model.subagentId ?? ''}\0${model.id}`
}

/** A transient model event cannot erase its already registered round number. */
export function preserveModelRounds(models: AgentModelActivity[], known: AgentModelActivity[]): AgentModelActivity[] {
  const rounds = new Map(known.filter((model) => model.round !== undefined).map((model) => [modelKey(model), model.round]))
  return models.map((model) => model.round === undefined && rounds.has(modelKey(model))
    ? { ...model, round: rounds.get(modelKey(model)) }
    : model)
}

export function mergeSubagentDetails(current: AgentSubagentActivity, details: AgentSubagentActivity | undefined): AgentSubagentActivity {
  if (!current.detailsDeferred || !details || details.detailsDeferred || current.id !== details.id
    || current.status !== details.status || current.completedAt !== details.completedAt) return current
  return { ...current, result: details.result, error: current.error ?? details.error, detailsDeferred: false }
}

export function mergeActivityWindow(
  left: AgentRunActivity['activityWindow'],
  right: AgentRunActivity['activityWindow'],
  rightBeforeSequence?: number
): AgentRunActivity['activityWindow'] {
  if (!left) return right
  if (!right) return left
  const totalCount = Math.max(left.totalCount, right.totalCount)
  if (left.startSequence === null || left.endSequence === null) return { ...right, totalCount }
  // An empty earlier page still proves there are no rows before its request
  // cursor. It cannot close a gap above that cursor after a concurrent refresh.
  if (right.startSequence === null || right.endSequence === null) {
    return { ...left, totalCount, hasEarlier: rightBeforeSequence !== undefined
      && rightBeforeSequence >= left.startSequence && !right.hasEarlier ? false : left.hasEarlier }
  }
  const rightEnd = Math.max(right.endSequence, (rightBeforeSequence ?? 0) - 1)
  const overlaps = left.startSequence <= rightEnd + 1 && right.startSequence <= left.endSequence + 1
  if (!overlaps) {
    // Keep already displayed rows, but paginate from the newest continuous
    // range until the missing interval has actually been read.
    return { ...(left.endSequence >= rightEnd ? left : right), totalCount }
  }
  const startSequence = Math.min(left.startSequence, right.startSequence)
  const earliest = [left, right].filter((window) => window.startSequence === startSequence)
  return { startSequence, endSequence: Math.max(left.endSequence, right.endSequence), totalCount,
    hasEarlier: earliest.every((window) => window.hasEarlier) }
}

function mergeItems<T extends { sequence: number }>(older: T[], current: T[], key: (item: T) => string): T[] {
  const merged = new Map(older.map((item) => [key(item), item]))
  for (const item of current) merged.set(key(item), item)
  return [...merged.values()].sort((left, right) => left.sequence - right.sequence)
}

/** An earlier page cannot replace newer streaming or completed activity values. */
export function mergeActivityPage<T extends AgentRunActivity>(
  current: T,
  page: AgentRunActivity,
  beforeSequence?: number
): T {
  if (current.runId !== page.runId) return current
  return {
    ...current,
    models: preserveModelRounds(mergeItems(page.models, current.models, modelKey), page.models),
    tools: mergeItems(page.tools, current.tools, (item) => `${item.subagentId ?? ''}\0${item.call.id}`),
    subagents: mergeItems(page.subagents, current.subagents, (item) => item.id)
      .map((item) => mergeSubagentDetails(item, page.subagents.find((older) => older.id === item.id))),
    summaries: mergeItems(page.summaries ?? [], current.summaries ?? [], (item) => item.id),
    memoryRecalls: mergeItems(page.memoryRecalls ?? [], current.memoryRecalls ?? [], (item) => item.id),
    activityWindow: mergeActivityWindow(current.activityWindow, page.activityWindow, beforeSequence)
  }
}

/** Refresh the authoritative tail while retaining explicitly loaded earlier rows. */
export function preserveEarlierActivities(
  previous: AgentRunActivity | undefined,
  incoming: AgentRunActivity,
  live?: AgentRunActivity
): AgentRunActivity {
  if (live?.runId === incoming.runId) previous = previous?.runId === incoming.runId
    ? mergeActivityPage(live, previous) : live
  const start = incoming.activityWindow?.startSequence
  if (!previous || previous.runId !== incoming.runId) return incoming
  if (start === undefined || start === null) return { ...incoming, models: preserveModelRounds(incoming.models, previous.models) }
  const earlier = <T extends { sequence: number }>(items: T[]): T[] => items.filter((item) => item.sequence < start)
  const merged = mergeActivityPage(incoming, {
    ...previous, models: earlier(previous.models), tools: earlier(previous.tools), subagents: earlier(previous.subagents),
    summaries: earlier(previous.summaries ?? []), memoryRecalls: earlier(previous.memoryRecalls ?? [])
  })
  return { ...merged, models: preserveModelRounds(merged.models, previous.models),
    subagents: merged.subagents.map((item) => mergeSubagentDetails(item, previous.subagents.find((older) => older.id === item.id))) }
}
