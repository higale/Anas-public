import {
  backgroundCallsCancelling,
  backgroundCleanupCompleted,
  backgroundCleanupStarted,
  backgroundCleanupUnconfirmed,
  backgroundSubagentsCancelling,
  backgroundTasksPendingError
} from '@shared/backgroundCleanup'
import type { AgentBackgroundCleanup } from '@shared/backgroundCleanup'
import type { AgentDatabase, AgentSubagentCallRecord } from './agentDatabase'
import type { ManagedCallService } from './managedCallService'

function detail(error: unknown): string {
  if (error instanceof AggregateError) return error.errors.map(detail).join('; ')
  return (error instanceof Error ? error.message : String(error)).replaceAll(/\s+/g, ' ').slice(0, 500)
}

export function hasUnresolvedBackgroundTasks(database: AgentDatabase, threadId: string): boolean {
  if (database.hasUnresolvedManagedCallsForThread(threadId)) return true
  const descendants = database.listDescendantSubagentCalls(threadId)
  if (descendants.some((call) => database.hasUnresolvedManagedCallsForThread(call.childThreadId))) return true
  return [...new Set(descendants.map((call) => call.parentRunId))]
    .some((runId) => database.listUnresolvedSubagentCallsForRun(runId, 1).length > 0)
}

// Cancellation belongs to the executor, not to another model turn. Keep its
// report in run metadata; conversation messages and tool results stay intact.
export async function cleanupUnresolvedBackgroundTasks(options: {
  database: AgentDatabase
  managedCalls: ManagedCallService
  threadId: string
  runId: string
  cancelSubagents(list: () => AgentSubagentCallRecord[]): Promise<void>
  subagentIsActive(call: AgentSubagentCallRecord): boolean
  report(cleanup: AgentBackgroundCleanup): void
}): Promise<void> {
  const { database, managedCalls, threadId } = options
  const lines = [backgroundTasksPendingError, backgroundCleanupStarted]
  const report = (status: AgentBackgroundCleanup['status'] = 'running') => options.report({ status, report: lines.join('\n') })
  // A timed-out cancellation keeps running. Limit its dynamic tree to the
  // original runs so it cannot cancel children created by a later user turn.
  const rootRunIds = [...new Set([options.runId, ...database.listDescendantSubagentCalls(threadId)
    .filter((call) => call.parentThreadId === threadId).map((call) => call.parentRunId)])]
  const descendants = () => database.listDescendantSubagentCalls(threadId, rootRunIds)
  const scope = () => [threadId, ...descendants().map((call) => call.childThreadId)]
  const callThreads = new Map<string, string>()
  const subagentIds = new Set<string>()
  const collect = () => {
    const tasks = database.handoffBackgroundTasksToCleanup(options.runId)
    for (const call of tasks.calls) callThreads.set(call.id, call.threadId)
    for (const call of tasks.subagents) subagentIds.add(call.id)
  }
  let unconfirmed = false
  const attempt = async (action: () => Promise<unknown>) => {
    try {
      await action()
    } catch (error) {
      unconfirmed = true
      lines.push(`Cleanup error: ${detail(error)}`)
      report()
    }
  }
  // Failure to record the handoff must not prevent cancellation itself. The
  // second collection below can persist it after a transient storage failure.
  await attempt(async () => collect())
  report()
  let callCancellationReported = false
  const cancelCalls = async () => {
    const activeThreads = scope().filter((id) => managedCalls.hasActiveForThread(id))
    if (activeThreads.length === 0) return
    if (!callCancellationReported) {
      callCancellationReported = true
      lines.push(backgroundCallsCancelling)
      report()
    }
    await managedCalls.cancelThreads(activeThreads, backgroundCleanupStarted)
  }
  // Stop parent/child executors and shell/MCP calls together so neither waits
  // for work that the other cancellation branch has not signalled yet.
  await Promise.all([
    attempt(async () => {
      if (!descendants().some((call) => options.subagentIsActive(call)
        || call.status === 'running' || call.status === 'interrupted')) return
      lines.push(backgroundSubagentsCancelling)
      report()
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          options.cancelSubagents(descendants),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('Subagent cancellation is still pending.')), 5_000)
          })
        ])
      } finally {
        if (timeout) clearTimeout(timeout)
      }
    }),
    attempt(cancelCalls)
  ])
  // A child may have created another child/call while cancellation was being
  // dispatched. Re-read the durable tree after the subagent barrier.
  await attempt(async () => collect())
  await attempt(cancelCalls)
  const activeCallIds = new Set(managedCalls.activeCallIds())
  for (const [callId, id] of callThreads) {
    const call = database.getManagedCall(callId, id)
    if (!call) {
      unconfirmed = true
      lines.push(`Cleanup error: call_id=${callId}: task record unavailable`)
      continue
    }
    const live = activeCallIds.has(call.id) || call.status === 'running' || call.status === 'preparing'
    if (live || call.status === 'uncertain') unconfirmed = true
    lines.push(`call_id=${call.id}: ${live ? 'unconfirmed' : call.status}; ${detail(call.summary)}${call.error ? `; ${detail(call.error)}` : ''}`)
  }
  for (const call of descendants()) {
    if (!subagentIds.has(call.id)) continue
    const live = options.subagentIsActive(call) || call.status === 'running' || call.status === 'interrupted'
    if (live) unconfirmed = true
    lines.push(`subagent_id=${call.id}: ${live ? 'unconfirmed' : call.status}; ${detail(call.description)}${call.error ? `; ${detail(call.error)}` : ''}`)
  }
  lines.push(unconfirmed ? backgroundCleanupUnconfirmed : backgroundCleanupCompleted)
  report(unconfirmed ? 'unconfirmed' : 'completed')
}
