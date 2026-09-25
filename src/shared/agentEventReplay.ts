import type { AgentRuntimeEvent } from './agentTypes'

/** Argument progress uses replaceable metadata snapshots. Preserve the newest
 * revision per model/agent while leaving additive events and their order intact.
 */
export function compactToolCallProgress<T extends { event: AgentRuntimeEvent }>(history: Map<number, T>): void {
  const latest = new Map<string, number>()
  for (const [revision, { event }] of history) {
    if (event.type !== 'model_tool_calls') continue
    const key = JSON.stringify([event.runId, event.subagentId, event.modelId])
    const previous = latest.get(key)
    if (previous !== undefined && previous > revision) {
      history.delete(revision)
    } else {
      if (previous !== undefined) history.delete(previous)
      latest.set(key, revision)
    }
  }
}
