import type {
  AgentApi,
  AgentInterrupt,
  AgentRunActivity,
  AgentSubagentActivityStatus,
  AgentThreadSnapshot
} from '@shared/agentTypes'
import type { AgentSnapshotReadiness } from './agentSnapshotReadiness'
import { mergeActivityWindow, mergeSubagentDetails, preserveModelRounds } from './activityPagination'

type AgentRecoveryApi = {
  threads: Pick<AgentApi['threads'], 'get'>
  runs: Pick<AgentApi['runs'], 'recover'>
}

export interface RecoveredAgentRunView extends Omit<AgentRunActivity, 'status'> {
  status: 'running' | 'interrupted'
  interrupts: AgentInterrupt[]
}

export function terminalEventMatchesRun(
  currentRunId: string | undefined,
  eventRunId: string
): boolean {
  return currentRunId === eventRunId
}

export function recoveryFailedSnapshotProjection(
  current: AgentThreadSnapshot | undefined,
  authoritativeSnapshot: AgentThreadSnapshot
): AgentThreadSnapshot
export function recoveryFailedSnapshotProjection(
  current: AgentThreadSnapshot | undefined,
  authoritativeSnapshot?: undefined
): AgentThreadSnapshot | undefined
export function recoveryFailedSnapshotProjection(
  current: AgentThreadSnapshot | undefined,
  authoritativeSnapshot?: AgentThreadSnapshot
): AgentThreadSnapshot | undefined {
  if (authoritativeSnapshot) return authoritativeSnapshot
  if (!current || (current.todos.length === 0 && current.contextStatus === undefined)) return current
  return {
    ...current,
    todos: [],
    contextStatus: undefined
  }
}

export function recoveredAgentRunView(
  snapshot: AgentThreadSnapshot
): RecoveredAgentRunView | undefined {
  const run = snapshot.pendingRun?.status === 'running' || snapshot.pendingRun?.status === 'interrupted'
    ? snapshot.pendingRun : snapshot.settlingRun?.status === 'completed' ? snapshot.settlingRun : undefined
  if (!run) return undefined
  const activity = snapshot.activities.find((item) => item.runId === run.id)
  return {
    runId: run.id,
    operation: run.operation,
    status: run.status === 'interrupted' ? 'interrupted' : 'running',
    error: run.error,
    backgroundCleanup: run.backgroundCleanup,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    models: activity?.models ?? [],
    tools: activity?.tools ?? [],
    subagents: activity?.subagents ?? [],
    memoryRecalls: activity?.memoryRecalls ?? [],
    summaries: activity?.summaries ?? [],
    activityWindow: activity?.activityWindow,
    interrupts: run.status === 'interrupted' ? snapshot.interrupts : []
  }
}

function terminalActivityStatus(status: AgentSubagentActivityStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function mergeRecoveredActivities<T extends {
  sequence: number
  status: AgentSubagentActivityStatus
}>(
  recovered: T[],
  existing: T[],
  key: (activity: T) => string
): T[] {
  const merged = new Map(recovered.map((activity) => [key(activity), activity]))
  for (const activity of existing) {
    const recoveredActivity = merged.get(key(activity))
    if (
      !recoveredActivity
      || (
        !terminalActivityStatus(recoveredActivity.status)
        && (
          terminalActivityStatus(activity.status)
          || activity.status === recoveredActivity.status
        )
      )
    ) {
      merged.set(key(activity), activity)
    }
  }
  return [...merged.values()].sort((left, right) => left.sequence - right.sequence)
}

function mergeRecoveredRunView(
  recovered: RecoveredAgentRunView,
  existing: RecoveredAgentRunView
): RecoveredAgentRunView {
  const authoritativeTools = new Map(recovered.tools.map((tool) => [
    `${tool.subagentId ?? ''}\0${tool.call.id}`, tool
  ]))
  const ownerStatuses = new Map([...existing.subagents, ...recovered.subagents]
    .map((subagent) => [subagent.id, subagent.status]))
  return {
    ...recovered,
    activityWindow: mergeActivityWindow(recovered.activityWindow, existing.activityWindow),
    models: preserveModelRounds(mergeRecoveredActivities(
      recovered.models,
      existing.models,
      (model) => `${model.subagentId ?? ''}\0${model.id}`
    ), [...recovered.models, ...existing.models]),
    tools: mergeRecoveredActivities(
      recovered.tools,
      existing.tools,
      (tool) => `${tool.subagentId ?? ''}\0${tool.call.id}`
    ).map((tool) => {
      const authoritative = authoritativeTools.get(`${tool.subagentId ?? ''}\0${tool.call.id}`)
      const ownerStatus = tool.subagentId ? ownerStatuses.get(tool.subagentId) : recovered.status
      return {
        ...tool,
        approval: tool.status === 'completed' ? undefined
          : authoritative ? authoritative.approval
            : ownerStatus === 'interrupted' ? tool.approval : undefined
      }
    }),
    subagents: mergeRecoveredActivities(
      recovered.subagents,
      existing.subagents,
      (subagent) => subagent.id
    ).map((item) => mergeSubagentDetails(item, existing.subagents.find((previous) => previous.id === item.id))),
    memoryRecalls: [
      ...(recovered.memoryRecalls ?? []),
      ...(existing.memoryRecalls ?? [])
    ].filter((recall, index, all) => (
      all.findIndex((candidate) => candidate.id === recall.id) === index
    )).sort((left, right) => left.sequence - right.sequence),
    summaries: mergeRecoveredActivities(
      recovered.summaries ?? [],
      existing.summaries ?? [],
      (summary) => summary.id
    )
  }
}

export function reconcileRecoveredAgentRunViews(
  current: Record<string, RecoveredAgentRunView>,
  snapshot: AgentThreadSnapshot
): Record<string, RecoveredAgentRunView> {
  const threadId = snapshot.thread.id
  const recovered = recoveredAgentRunView(snapshot)
  const existing = current[threadId]
  if (recovered) {
    if (existing?.runId === recovered.runId) {
      return {
        ...current,
        [threadId]: mergeRecoveredRunView(recovered, existing)
      }
    }
    return { ...current, [threadId]: recovered }
  }
  if (!existing) return current
  const next = { ...current }
  delete next[threadId]
  return next
}

export function reconcileRecoveryFailedAgentRunViews(
  current: Record<string, RecoveredAgentRunView>,
  threadId: string,
  runId: string,
  error: string,
  authoritativeSnapshot?: AgentThreadSnapshot
): Record<string, RecoveredAgentRunView> {
  const reconciled = authoritativeSnapshot
    ? reconcileRecoveredAgentRunViews(current, authoritativeSnapshot)
    : current
  const run = reconciled[threadId]
  if (!run || run.runId !== runId) return reconciled
  return {
    ...reconciled,
    [threadId]: authoritativeSnapshot
      ? { ...run, status: 'running', error }
      : {
          ...run,
          status: 'running',
          error,
          models: [],
          tools: [],
          subagents: [],
          memoryRecalls: [],
          summaries: [],
          interrupts: []
        }
  }
}

export async function loadAgentThreadSnapshotAndRecover(
  api: AgentRecoveryApi,
  readiness: Pick<AgentSnapshotReadiness, 'load' | 'markProjectionReady'>,
  threadId: string,
  acceptSnapshot: (snapshot: AgentThreadSnapshot) => void,
  refresh = false
): Promise<void> {
  await readiness.load(threadId, async ({ isCurrent }) => {
    const snapshot = await api.threads.get(threadId)
    if (!isCurrent()) return
    acceptSnapshot(snapshot)
    readiness.markProjectionReady(threadId)
    await api.runs.recover(threadId)
  }, refresh)
}
