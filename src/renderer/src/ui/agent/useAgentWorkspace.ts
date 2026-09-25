import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import {
  isAgentThreadLocked,
  type AgentInterruptResponse,
  type AgentAccessMode,
  type AgentContextStatus,
  type AgentMessage,
  type AgentRun,
  type AgentRuntimeEvent,
  type AgentThread,
  type AgentThreadCleanupResult,
  type AgentThreadSnapshot,
  type AgentWorkspaceState
} from '@shared/agentTypes'
import { applySubagentActivityUpdate } from '@shared/agentActivity'
import { DEFAULT_WORKSPACE_PROJECT_ID, type SelectedAttachment } from '@shared/types'
import {
  loadAgentThreadSnapshotAndRecover,
  recoveryFailedSnapshotProjection,
  reconcileRecoveryFailedAgentRunViews,
  reconcileRecoveredAgentRunViews,
  terminalEventMatchesRun,
  type RecoveredAgentRunView
} from './agentRecoveryHandshake'
import { AgentSnapshotReadiness } from './agentSnapshotReadiness'
import {
  createThreadErrorState,
  forgetThreadErrors,
  threadErrorFor,
  updateThreadError
} from './threadErrors'
import { throwIfAborted } from './messagePagination'
import { mergeActivityPage, mergeSubagentDetails, preserveEarlierActivities } from './activityPagination'
import { projectInitialAgentSubmission } from './agentSubmissionProjection'
import { useQueuedAgentMessages } from './useQueuedAgentMessages'
import { selectedAttachmentInput } from '../chat/attachmentUtils'

export type AgentRunView = RecoveredAgentRunView & {
  /** Current instance reports only; run_started clears this on every resume. */
  liveContextStatus?: AgentContextStatus
}

interface AgentWorkspaceProjection {
  snapshots: Record<string, AgentThreadSnapshot>
  runs: Record<string, AgentRunView>
}

interface UseAgentWorkspaceOptions {
  onAppError(message: string | undefined): void
}

function threadTitle(text: string): string {
  const title = text.replace(/\s+/g, ' ').trim()
  if (!title) return 'New Thread'
  return title.length > 48 ? `${title.slice(0, 47)}…` : title
}

function sortThreads(items: AgentThread[]): AgentThread[] {
  return items.sort((left, right) =>
    Number(right.pinned) - Number(left.pinned)
    || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
  )
}

function sameWorkspaceState(left: AgentWorkspaceState | undefined, right: AgentWorkspaceState): boolean {
  if (!left || left.mode !== right.mode) return false
  if (left.mode === 'thread' && right.mode === 'thread') return left.threadId === right.threadId
  if (left.mode !== 'new_thread' || right.mode !== 'new_thread') return false
  return left.projectId === right.projectId
    && left.modelConfigId === right.modelConfigId
    && left.modelParameterPresetId === right.modelParameterPresetId
}

function isApprovalGenerationMismatch(error: unknown): boolean {
  return error instanceof Error
    && error.message.includes('does not match its current approval generation')
}

function updateMessage(
  snapshot: AgentThreadSnapshot,
  message: AgentMessage
): AgentThreadSnapshot {
  const index = snapshot.messages.findIndex((item) => item.id === message.id)
  const appended = index < 0
  return {
    ...snapshot,
    messages: appended
      ? [...snapshot.messages, message]
      : snapshot.messages.map((item) => item.id === message.id ? message : item),
    messageWindow: appended
      ? {
          ...snapshot.messageWindow,
          shown: snapshot.messageWindow.shown + 1,
          total: snapshot.messageWindow.total + 1
        }
      : snapshot.messageWindow
  }
}

export function useAgentWorkspace({ onAppError }: UseAgentWorkspaceOptions) {
  const { t } = useTranslation()
  const [threads, setThreads] = useState<AgentThread[]>([])
  const [{ snapshots, runs }, setProjection] = useState<AgentWorkspaceProjection>({ snapshots: {}, runs: {} })
  const setSnapshots = useCallback((update: SetStateAction<AgentWorkspaceProjection['snapshots']>): void => {
    setProjection((current) => ({ ...current, snapshots: typeof update === 'function' ? update(current.snapshots) : update }))
  }, [])
  const setRuns = useCallback((update: SetStateAction<AgentWorkspaceProjection['runs']>): void => {
    setProjection((current) => ({ ...current, runs: typeof update === 'function' ? update(current.runs) : update }))
  }, [])
  const [activeThreadId, setActiveThreadId] = useState<string>()
  const [draftProjectId, setDraftProjectId] = useState(DEFAULT_WORKSPACE_PROJECT_ID)
  const [workspaceState, setWorkspaceState] = useState<AgentWorkspaceState>()
  const workspaceStateRef = useRef<AgentWorkspaceState | undefined>(undefined)
  const [loadingThreads, setLoadingThreads] = useState(true)
  const [errors, setErrors] = useState(createThreadErrorState)
  const snapshotReadinessRef = useRef(new AgentSnapshotReadiness())
  const onAppErrorRef = useRef(onAppError)
  onAppErrorRef.current = onAppError
  const translationRef = useRef(t)
  translationRef.current = t
  const threadProjectionRevisionRef = useRef(0)
  const reloadThreadsInFlightRef = useRef<Promise<AgentThread[]> | undefined>(undefined)
  const initialRestoreRef = useRef<Promise<void>>(Promise.resolve())
  // Event delivery and React state commits can be batched independently. Keep
  // the currently projected run identity synchronously so a delayed terminal
  // event from run A cannot overwrite or delete the already-started run B.
  const projectedRunIdsRef = useRef(new Map<string, string>())

  const setThreadError = useCallback((threadId: string | undefined, error: string | undefined): void => {
    setErrors((current) => updateThreadError(current, threadId, error))
  }, [])

  const setActiveError = useCallback((error: string | undefined): void => {
    setErrors((current) => updateThreadError(current, activeThreadId, error))
  }, [activeThreadId])

  const handleQueuedDispatchError = useCallback((threadId: string | undefined): void => {
    setThreadError(threadId, t('chat.failed_send'))
  }, [setThreadError, t])
  const readyThreadIds = useMemo(() => new Set(
    threads
      .filter((thread) => !isAgentThreadLocked(thread.status))
      .map((thread) => thread.id)
  ), [threads])
  const queuedMessages = useQueuedAgentMessages({
    readyThreadIds,
    onDispatchError: handleQueuedDispatchError
  })

  const mergeThread = useCallback((thread: AgentThread): void => {
    threadProjectionRevisionRef.current += 1
    setThreads((current) => sortThreads([
      thread,
      ...current.filter((item) => item.id !== thread.id)
    ]))
    setSnapshots((current) => {
      const snapshot = current[thread.id]
      return snapshot
        ? { ...current, [thread.id]: { ...snapshot, thread } }
        : current
    })
  }, [])

  const acceptSnapshot = useCallback((
    snapshot: AgentThreadSnapshot,
    reconcilePendingRun = false
  ): void => {
    const projectedRun = snapshot.pendingRun ?? snapshot.settlingRun
    if (projectedRun) {
      projectedRunIdsRef.current.set(snapshot.thread.id, projectedRun.id)
    } else {
      projectedRunIdsRef.current.delete(snapshot.thread.id)
    }
    mergeThread(snapshot.thread)
    setProjection((current) => {
      const mergedSnapshot = {
        ...snapshot,
        activities: snapshot.activities.map((activity) => preserveEarlierActivities(
          current.snapshots[snapshot.thread.id]?.activities.find((previous) => previous.runId === activity.runId),
          activity,
          current.runs[snapshot.thread.id]
        ))
      }
      return {
        snapshots: { ...current.snapshots, [snapshot.thread.id]: mergedSnapshot },
        runs: reconcilePendingRun ? reconcileRecoveredAgentRunViews(current.runs, mergedSnapshot) : current.runs
      }
    })
  }, [mergeThread])

  const finishProjectedRun = useCallback((run: AgentRun): void => {
    setProjection((current) => {
      const live = current.runs[run.threadId]
      if (!live || live.runId !== run.id) return current
      const snapshot = current.snapshots[run.threadId]
      const stored = snapshot?.activities.find((activity) => activity.runId === run.id)
      const settled = { ...live, status: run.status, error: run.error, backgroundCleanup: run.backgroundCleanup, updatedAt: run.updatedAt }
      const activity = stored ? mergeActivityPage(settled, stored) : settled
      const nextRuns = { ...current.runs }
      delete nextRuns[run.threadId]
      return {
        runs: nextRuns,
        snapshots: snapshot ? { ...current.snapshots, [run.threadId]: {
          ...snapshot,
          pendingRun: snapshot.pendingRun?.id === run.id ? undefined : snapshot.pendingRun,
          settlingRun: snapshot.settlingRun?.id === run.id ? undefined : snapshot.settlingRun,
          activities: stored ? snapshot.activities.map((item) => item.runId === run.id ? activity : item)
            : [...snapshot.activities, activity]
        } } : current.snapshots
      }
    })
  }, [])

  const acceptRecoverySnapshot = useCallback((snapshot: AgentThreadSnapshot): void => {
    acceptSnapshot(snapshot, true)
  }, [acceptSnapshot])

  const acceptAuthoritativeSnapshot = useCallback((snapshot: AgentThreadSnapshot): void => {
    snapshotReadinessRef.current.markReady(snapshot.thread.id)
    acceptSnapshot(snapshot, true)
  }, [acceptSnapshot])

  const loadThreadSnapshot = useCallback(async (
    threadId: string,
    refresh = false
  ): Promise<void> => loadAgentThreadSnapshotAndRecover(
    window.gale.agent,
    snapshotReadinessRef.current,
    threadId,
    acceptRecoverySnapshot,
    refresh
  ), [acceptRecoverySnapshot])

  const reloadThreads = useCallback((): Promise<AgentThread[]> => {
    const existing = reloadThreadsInFlightRef.current
    if (existing) return existing
    const request = (async (): Promise<AgentThread[]> => {
      while (true) {
        const projectionRevision = threadProjectionRevisionRef.current
        const items = await window.gale.agent.threads.list()
        if (projectionRevision !== threadProjectionRevisionRef.current) continue
        setThreads(items)
        return items
      }
    })()
    reloadThreadsInFlightRef.current = request
    const release = (): void => {
      if (reloadThreadsInFlightRef.current === request) {
        reloadThreadsInFlightRef.current = undefined
      }
    }
    void request.then(release, release)
    return request
  }, [])

  const saveWorkspaceState = useCallback((state: AgentWorkspaceState): void => {
    if (sameWorkspaceState(workspaceStateRef.current, state)) return
    workspaceStateRef.current = state
    setWorkspaceState(state)
    void window.gale.agent.workspace.set(state)
      .catch(() => {
        if (sameWorkspaceState(workspaceStateRef.current, state)) {
          workspaceStateRef.current = undefined
        }
        onAppError(t('chat.failed_save_workspace_state'))
      })
  }, [onAppError, t])

  useEffect(() => {
    let cancelled = false
    const restore = (async (): Promise<void> => {
      try {
        const [items, restoredWorkspace] = await Promise.all([
          reloadThreads(),
          window.gale.agent.workspace.get()
        ])
        if (cancelled) return
        workspaceStateRef.current = restoredWorkspace
        setWorkspaceState(restoredWorkspace)
        if (restoredWorkspace.mode === 'new_thread') {
          setDraftProjectId(restoredWorkspace.projectId)
          return
        }
        if (!items.some((thread) => thread.id === restoredWorkspace.threadId)) return
        setActiveThreadId(restoredWorkspace.threadId)
        try {
          await loadThreadSnapshot(restoredWorkspace.threadId, true)
        } catch {
          if (!cancelled) {
            setThreadError(
              restoredWorkspace.threadId,
              translationRef.current('chat.failed_load_app')
            )
          }
        }
      } catch {
        if (!cancelled) onAppErrorRef.current(translationRef.current('chat.failed_load_app'))
      } finally {
        if (!cancelled) setLoadingThreads(false)
      }
    })()
    initialRestoreRef.current = restore
    return () => {
      cancelled = true
    }
  }, [loadThreadSnapshot, reloadThreads, setThreadError])

  useEffect(() => window.gale.agent.onEvent((event: AgentRuntimeEvent) => {
    const threadId = 'run' in event ? event.run.threadId : event.threadId
    if (
      event.type === 'run_started'
      || event.type === 'run_completed'
      || event.type === 'run_interrupted'
      || event.type === 'run_failed'
      || event.type === 'run_cancelled'
    ) {
      threadProjectionRevisionRef.current += 1
    }
    if (event.type === 'run_started') {
      setThreadError(threadId, undefined)
      projectedRunIdsRef.current.set(threadId, event.run.id)
      snapshotReadinessRef.current.markProjected(threadId)
      if (event.newUserTurn) {
        setThreads((current) => current.map((thread) =>
          thread.id === threadId
            ? thread.status === 'running'
              ? thread
              : { ...thread, userTurnCount: thread.userTurnCount + 1 }
            : thread
        ))
      }
      if (event.userMessage) {
        const userMessage = event.userMessage
        setSnapshots((current) => {
          const snapshot = current[threadId]
          return snapshot
            ? {
                ...current,
                [threadId]: {
                  ...updateMessage(snapshot, userMessage),
                  todos: []
                }
              }
            : current
        })
      }
      setRuns((current) => {
        const previous = current[threadId]?.runId === event.run.id
          ? current[threadId]
          : undefined
        return {
          ...current,
          [threadId]: {
            runId: event.run.id,
            operation: event.run.operation,
            status: 'running',
            error: event.run.error,
            backgroundCleanup: event.run.backgroundCleanup,
            createdAt: event.run.createdAt,
            updatedAt: event.run.updatedAt,
            models: previous?.models ?? [],
            tools: previous?.tools ?? [],
            subagents: previous?.subagents ?? [],
            memoryRecalls: previous?.memoryRecalls ?? [],
            summaries: previous?.summaries ?? [],
            activityWindow: previous?.activityWindow,
            interrupts: []
          }
        }
      })
      setThreads((current) => current.map((thread) =>
        thread.id === threadId ? { ...thread, status: 'running' } : thread
      ))
      return
    }
    if (event.type === 'run_cleanup') {
      if (!terminalEventMatchesRun(projectedRunIdsRef.current.get(threadId), event.run.id)) return
      const reply = event.reply
      if (reply) {
        setSnapshots((current) => {
          const snapshot = current[threadId]
          return snapshot ? { ...current, [threadId]: updateMessage(snapshot, reply) } : current
        })
      }
      setRuns((current) => {
        const run = current[threadId]
        if (!run || run.runId !== event.run.id) return current
        return { ...current, [threadId]: { ...run, backgroundCleanup: event.cleanup, updatedAt: event.run.updatedAt } }
      })
      return
    }
    if (event.type === 'run_recovery_failed') {
      if (event.snapshot) {
        const authoritativeSnapshot = recoveryFailedSnapshotProjection(undefined, event.snapshot)
        snapshotReadinessRef.current.markReady(threadId)
        acceptSnapshot(authoritativeSnapshot)
      } else {
        setSnapshots((current) => {
          const snapshot = current[threadId]
          const projected = recoveryFailedSnapshotProjection(snapshot)
          return !projected || projected === snapshot
            ? current
            : { ...current, [threadId]: projected }
        })
      }
      setRuns((current) => reconcileRecoveryFailedAgentRunViews(
        current,
        threadId,
        event.run.id,
        event.error,
        event.snapshot
      ))
      setThreadError(threadId, event.error)
      return
    }
    if (event.type === 'context_status_updated') {
      setProjection((current) => {
        const snapshot = current.snapshots[threadId]
        const run = current.runs[threadId]
        return {
          snapshots: snapshot ? { ...current.snapshots, [threadId]: { ...snapshot, contextStatus: event.status } } : current.snapshots,
          runs: run?.status === 'running' && run.runId === event.runId
            ? { ...current.runs, [threadId]: { ...run, liveContextStatus: event.status } } : current.runs
        }
      })
      return
    }
    if (event.type === 'direction_applied') {
      setSnapshots((current) => {
        const snapshot = current[threadId]
        return snapshot
          ? { ...current, [threadId]: updateMessage(snapshot, event.message) }
          : current
      })
      return
    }
    if (event.type === 'run_settled') {
      const projectedRunId = projectedRunIdsRef.current.get(threadId)
      if (event.status === 'completed' && (!projectedRunId || projectedRunId === event.runId)) {
        // A snapshot requested between the terminal event and executor release
        // can still carry settlingRun. Invalidate that read and refresh any
        // already-restored owner once the executor has actually released it.
        snapshotReadinessRef.current.markProjected(threadId)
        if (projectedRunId) {
          void loadThreadSnapshot(threadId, true)
            .catch(() => setThreadError(threadId, translationRef.current('chat.failed_load_app')))
        }
      }
      return
    }
    if (event.type === 'memory_recalled') {
      setRuns((current) => {
        const run = current[threadId]
        if (!run || run.runId !== event.runId) return current
        const memoryRecalls = run.memoryRecalls ?? []
        const existingIndex = memoryRecalls.findIndex((recall) => recall.id === event.recall.id)
        return {
          ...current,
          [threadId]: {
            ...run,
            memoryRecalls: existingIndex < 0
              ? [...memoryRecalls, event.recall]
              : memoryRecalls.map((recall, index) => index === existingIndex ? event.recall : recall)
          }
        }
      })
      return
    }
    if (event.type === 'model_started' || event.type === 'model_completed') {
      setRuns((current) => {
        const run = current[threadId]
        if (!run || run.runId !== event.runId) return current
        const existingIndex = run.models.findIndex((item) => item.id === event.model.id
          && item.subagentId === event.model.subagentId)
        const models = existingIndex === -1
          ? [...run.models, event.model]
          : run.models.map((item, index) => index === existingIndex
            ? { ...event.model, round: event.model.round ?? item.round, toolCallProgress: item.toolCallProgress }
            : item)
        return {
          ...current,
          [threadId]: {
            ...run,
            models
          }
        }
      })
      return
    }
    if (
      event.type === 'context_compression_started'
      || event.type === 'context_compression_completed'
    ) {
      setRuns((current) => {
        const run = current[threadId]
        if (!run || run.runId !== event.runId) return current
        const summaries = run.summaries ?? []
        const existingIndex = summaries.findIndex((item) => item.id === event.summary.id)
        return {
          ...current,
          [threadId]: {
            ...run,
            summaries: existingIndex < 0
              ? [...summaries, event.summary]
              : summaries.map((item, index) => index === existingIndex ? event.summary : item)
          }
        }
      })
      return
    }
    if (event.type === 'context_compression_discarded') {
      setRuns((current) => {
        const run = current[threadId]
        if (!run || run.runId !== event.runId) return current
        return {
          ...current,
          [threadId]: {
            ...run,
            summaries: run.summaries?.filter(
              (summary) => summary.id !== event.summaryId
            )
          }
        }
      })
      return
    }
    if (event.type === 'model_delta' || event.type === 'model_tool_calls') {
      setRuns((current) => {
        const run = current[threadId]
        if (!run || run.runId !== event.runId) return current
        return {
          ...current,
          [threadId]: {
            ...run,
            models: run.models.map((model) => {
              if (model.id !== event.modelId || model.subagentId !== event.subagentId) return model
              if (event.type === 'model_tool_calls') {
                return { ...model, toolCallProgress: event.progress }
              }
              if (model.status === 'completed') return model
              return event.delta.type === 'reasoning'
                ? { ...model, reasoning: model.reasoning + event.delta.text }
                : { ...model, text: model.text + event.delta.text }
            })
          }
        }
      })
      return
    }
    if (
      event.type === 'tool_started'
      || event.type === 'tool_approval_requested'
      || event.type === 'tool_completed'
    ) {
      setRuns((current) => {
        const run = current[threadId]
        if (!run || run.runId !== event.runId) return current
        const tool = {
          call: event.call,
          sequence: event.sequence,
          status: event.type === 'tool_completed' ? 'completed' as const : 'running' as const,
          subagentId: event.subagentId,
          startedAt: event.startedAt,
          ...(event.type === 'tool_approval_requested' ? { approval: event.approval } : {}),
          ...(event.type === 'tool_completed' ? { output: event.output } : {}),
          ...(event.type === 'tool_completed' ? { completedAt: event.completedAt } : {})
        }
        const existingIndex = run.tools.findIndex((item) =>
          item.call.id === event.call.id && item.subagentId === event.subagentId
        )
        const tools = existingIndex === -1
          ? [...run.tools, tool]
          : run.tools.map((item, index) => index === existingIndex ? tool : item)
        return {
          ...current,
          [threadId]: {
            ...run,
            tools
          }
        }
      })
      return
    }
    if (event.type === 'todos_updated') {
      setSnapshots((current) => {
        const snapshot = current[threadId]
        return snapshot
          ? {
              ...current,
              [threadId]: { ...snapshot, todos: event.todos }
            }
          : current
      })
      return
    }
    if (event.type === 'subagent_updated') {
      setRuns((current) => {
        const run = current[threadId]
        if (!run || run.runId !== event.runId) return current
        return {
          ...current,
          [threadId]: applySubagentActivityUpdate(run, event.subagent)
        }
      })
      return
    }
    if (event.type === 'run_completed') {
      if (!terminalEventMatchesRun(
        projectedRunIdsRef.current.get(threadId),
        event.run.id
      )) return
      projectedRunIdsRef.current.delete(threadId)
      if (event.snapshot) {
        acceptAuthoritativeSnapshot(event.snapshot)
      } else {
        snapshotReadinessRef.current.markNotReady(threadId)
        setThreads((current) => current.map((thread) =>
          thread.id === threadId ? { ...thread, status: 'idle' } : thread
        ))
        void loadThreadSnapshot(threadId, true)
          .catch(() => setThreadError(
            threadId,
            translationRef.current('chat.failed_load_app')
          ))
      }
      finishProjectedRun(event.run)
      setThreadError(threadId, undefined)
      return
    }
    if (event.type === 'run_interrupted') {
      if (!terminalEventMatchesRun(
        projectedRunIdsRef.current.get(threadId),
        event.run.id
      )) return
      if (event.snapshot) {
        acceptAuthoritativeSnapshot(event.snapshot)
      } else {
        snapshotReadinessRef.current.markNotReady(threadId)
        setThreads((current) => current.map((thread) =>
          thread.id === threadId ? { ...thread, status: 'interrupted' } : thread
        ))
        void loadThreadSnapshot(threadId, true)
          .catch(() => setThreadError(
            threadId,
            translationRef.current('chat.failed_load_app')
          ))
      }
      setRuns((current) => {
        const previous = current[threadId]
        return {
          ...current,
          [threadId]: {
            runId: event.run.id,
            operation: event.run.operation,
            status: 'interrupted',
            error: event.run.error,
            backgroundCleanup: event.run.backgroundCleanup,
            createdAt: event.run.createdAt,
            updatedAt: event.run.updatedAt,
            models: previous?.models ?? [],
            tools: previous?.tools ?? [],
            subagents: previous?.subagents ?? [],
            memoryRecalls: previous?.memoryRecalls ?? [],
            summaries: previous?.summaries ?? [],
            activityWindow: previous?.activityWindow,
            interrupts: event.interrupts
          }
        }
      })
      setThreadError(threadId, undefined)
      return
    }
    if (event.type === 'run_failed' || event.type === 'run_cancelled') {
      if (!terminalEventMatchesRun(
        projectedRunIdsRef.current.get(threadId),
        event.run.id
      )) return
      projectedRunIdsRef.current.delete(threadId)
      snapshotReadinessRef.current.markNotReady(threadId)
      setThreads((current) => current.map((thread) =>
        thread.id === threadId
          ? { ...thread, status: event.type === 'run_failed' ? 'failed' : 'idle' }
          : thread
      ))
      finishProjectedRun(event.run)
      void loadThreadSnapshot(threadId, true)
        .catch(() => setThreadError(
          threadId,
          translationRef.current('chat.failed_load_app')
        ))
      setThreadError(threadId, event.type === 'run_failed' ? event.error : undefined)
    }
  }, async () => {
    // Do not let the initial restore finish after this authoritative refresh
    // and overwrite its projection with an older response.
    await initialRestoreRef.current
    const [items, workspace] = await Promise.all([
      reloadThreads(),
      window.gale.agent.workspace.get()
    ])
    if (workspace.mode !== 'thread' || !items.some((thread) => thread.id === workspace.threadId)) return
    await loadThreadSnapshot(workspace.threadId, true)
  }, () => {
    onAppErrorRef.current(translationRef.current('chat.failed_load_app'))
  }), [acceptAuthoritativeSnapshot, acceptSnapshot, finishProjectedRun, loadThreadSnapshot, reloadThreads, setThreadError])

  const openThread = useCallback(async (threadId: string): Promise<void> => {
    setActiveThreadId(threadId)
    saveWorkspaceState({ mode: 'thread', threadId })
    try {
      await loadThreadSnapshot(threadId, true)
    } catch {
      setThreadError(threadId, t('chat.failed_load_app'))
    }
  }, [loadThreadSnapshot, saveWorkspaceState, setThreadError, t])

  const startNewThread = useCallback((
    projectId = DEFAULT_WORKSPACE_PROJECT_ID,
    modelConfigId?: string,
    modelParameterPresetId: string | null = null
  ): void => {
    setActiveThreadId(undefined)
    setDraftProjectId(projectId)
    saveWorkspaceState({
      mode: 'new_thread',
      projectId,
      ...(modelConfigId ? { modelConfigId } : {}),
      modelParameterPresetId
    })
    setThreadError(undefined, undefined)
  }, [saveWorkspaceState, setThreadError])

  const setNewThreadWorkspace = useCallback((
    projectId: string,
    modelConfigId: string | undefined,
    modelParameterPresetId: string | null
  ): void => {
    setDraftProjectId(projectId)
    saveWorkspaceState({
      mode: 'new_thread',
      projectId,
      ...(modelConfigId ? { modelConfigId } : {}),
      modelParameterPresetId
    })
  }, [saveWorkspaceState])

  const send = useCallback(async (
    text: string,
    attachments: SelectedAttachment[],
    displayText = text,
    newThreadAccessMode: AgentAccessMode = 'read_only_allowed',
    newThreadModelConfigId?: string,
    newThreadModelParameterPresetId?: string | null,
    review?: import('@shared/codeReview').CodeReviewRequest
  ): Promise<string> => {
    const thread = activeThreadId
      ? threads.find((item) => item.id === activeThreadId)
      : undefined
    if (thread) await loadThreadSnapshot(thread.id)
    const submission = await window.gale.agent.runs.submit({
      requestId: globalThis.crypto.randomUUID(),
      ...(thread
        ? { threadId: thread.id }
        : {
            newThread: {
              title: threadTitle(displayText || attachments[0]?.name || ''),
              projectId: draftProjectId,
              accessMode: newThreadAccessMode,
              modelConfigId: newThreadModelConfigId,
              modelParameterPresetId: newThreadModelParameterPresetId
            }
          }),
      text,
      displayText: displayText === text ? undefined : displayText,
      ...(review ? { review } : {}),
      attachments: attachments.map(selectedAttachmentInput)
    })
    if (!thread) {
      threadProjectionRevisionRef.current += 1
      setThreads((current) => current.some((item) => item.id === submission.thread.id)
        ? current
        : sortThreads([submission.thread, ...current]))
      setActiveThreadId(submission.thread.id)
      saveWorkspaceState({ mode: 'thread', threadId: submission.thread.id })
      if (submission.userMessage) {
        snapshotReadinessRef.current.markProjectionReady(submission.thread.id)
        setSnapshots((current) => projectInitialAgentSubmission(current, submission))
      } else {
        await loadThreadSnapshot(submission.thread.id, true)
      }
    }
    return submission.thread.id
  }, [activeThreadId, draftProjectId, loadThreadSnapshot, saveWorkspaceState, threads])

  const cancel = useCallback(async (threadId: string): Promise<void> => {
    const run = runs[threadId]
    if (!run) return
    const result = await window.gale.agent.runs.cancel({ threadId, runId: run.runId })
    if (result !== 'cancelled') return
    snapshotReadinessRef.current.markNotReady(threadId)
    await loadThreadSnapshot(threadId, true)
  }, [loadThreadSnapshot, runs])

  const compressContext = useCallback(async (threadId: string): Promise<void> => {
    await window.gale.agent.runs.compress(threadId)
  }, [])

  const resume = useCallback(async (
    threadId: string,
    responses: AgentInterruptResponse[]
  ): Promise<void> => {
    const run = runs[threadId]
    if (!run || run.status !== 'interrupted') throw new Error('This thread is not waiting for approval.')
    try {
      await window.gale.agent.runs.resume({
        runId: run.runId,
        threadId,
        responses
      })
    } catch (error) {
      if (isApprovalGenerationMismatch(error)) {
        setRuns((current) => {
          const stale = current[threadId]
          if (!stale || stale.runId !== run.runId || stale.status !== 'interrupted') return current
          return {
            ...current,
            [threadId]: { ...stale, interrupts: [] }
          }
        })
        try {
          await loadThreadSnapshot(threadId, true)
        } catch {
          setThreadError(threadId, t('chat.failed_load_app'))
        }
      }
      throw error
    }
  }, [loadThreadSnapshot, runs, setThreadError, t])

  const renameThread = useCallback(async (threadId: string, title: string): Promise<void> => {
    mergeThread(await window.gale.agent.threads.update(threadId, { title }))
  }, [mergeThread])

  const togglePinned = useCallback(async (thread: AgentThread): Promise<void> => {
    mergeThread(await window.gale.agent.threads.update(thread.id, { pinned: !thread.pinned }))
  }, [mergeThread])

  const setAccessMode = useCallback(async (
    threadId: string,
    accessMode: AgentAccessMode
  ): Promise<void> => {
    mergeThread(await window.gale.agent.threads.setAccessMode(threadId, accessMode))
  }, [mergeThread])

  const setThreadModel = useCallback(async (
    threadId: string,
    modelConfigId: string,
    modelParameterPresetId: string | null
  ): Promise<void> => {
    mergeThread(await window.gale.agent.threads.update(threadId, { modelConfigId, modelParameterPresetId }))
  }, [mergeThread])

  const setThreadModelParameterPreset = useCallback(async (
    threadId: string,
    modelParameterPresetId: string | null
  ): Promise<void> => {
    mergeThread(await window.gale.agent.threads.update(threadId, { modelParameterPresetId }))
  }, [mergeThread])

  const deleteThread = useCallback(async (threadId: string): Promise<void> => {
    await window.gale.agent.threads.delete(threadId)
    threadProjectionRevisionRef.current += 1
    snapshotReadinessRef.current.forget(threadId)
    setThreads((current) => current.filter((thread) => thread.id !== threadId))
    setSnapshots((current) => {
      const next = { ...current }
      delete next[threadId]
      return next
    })
    setRuns((current) => {
      const next = { ...current }
      delete next[threadId]
      return next
    })
    setErrors((current) => forgetThreadErrors(current, [threadId]))
    queuedMessages.forgetThread(threadId)
    if (activeThreadId === threadId) startNewThread()
  }, [activeThreadId, queuedMessages, startNewThread])

  const cleanupThreads = useCallback(async (): Promise<AgentThreadCleanupResult> => {
    const result = await window.gale.agent.threads.cleanup()
    const deleted = new Set(result.deletedThreadIds)
    if (deleted.size === 0) return result
    threadProjectionRevisionRef.current += 1
    for (const threadId of deleted) snapshotReadinessRef.current.forget(threadId)
    for (const threadId of deleted) queuedMessages.forgetThread(threadId)
    setThreads((current) => current.filter((thread) => !deleted.has(thread.id)))
    setSnapshots((current) => Object.fromEntries(
      Object.entries(current).filter(([threadId]) => !deleted.has(threadId))
    ))
    setRuns((current) => Object.fromEntries(
      Object.entries(current).filter(([threadId]) => !deleted.has(threadId))
    ))
    setErrors((current) => forgetThreadErrors(current, deleted))
    if (activeThreadId && deleted.has(activeThreadId)) startNewThread()
    return result
  }, [activeThreadId, queuedMessages, startNewThread])

  const truncateFromMessage = useCallback(async (
    threadId: string,
    messageId: string
  ): Promise<AgentThreadSnapshot> => {
    const guard = snapshotReadinessRef.current.guard(threadId)
    const snapshot = await window.gale.agent.messages.truncate({ threadId, messageId })
    if (guard.isCurrent()) acceptSnapshot(snapshot)
    return snapshot
  }, [acceptSnapshot])

  const prepareMessageEdit = useCallback(async (
    threadId: string,
    messageId: string
  ): Promise<SelectedAttachment[]> => {
    const guard = snapshotReadinessRef.current.guard(threadId)
    const result = await window.gale.agent.messages.prepareEdit({ threadId, messageId })
    if (guard.isCurrent()) acceptSnapshot(result.snapshot)
    return result.attachments
  }, [acceptSnapshot])

  const loadEarlierMessages = useCallback(async (
    threadId: string,
    signal: AbortSignal
  ): Promise<void> => {
    throwIfAborted(signal)
    const snapshot = snapshots[threadId]
    if (!snapshot || snapshot.messageWindow.remaining <= 0) return
    const guard = snapshotReadinessRef.current.guard(threadId)
    const earlier = await window.gale.agent.messages.loadEarlier({
      threadId,
      beforeIndex: snapshot.messageWindow.startIndex
    })
    throwIfAborted(signal)
    if (guard.isCurrent()) acceptSnapshot(earlier)
  }, [acceptSnapshot, snapshots])

  const loadEarlierActivities = useCallback(async (
    threadId: string,
    runId: string,
    signal: AbortSignal
  ): Promise<void> => {
    throwIfAborted(signal)
    const activity = runs[threadId]?.runId === runId ? runs[threadId]
      : snapshots[threadId]?.activities.find((item) => item.runId === runId)
    const window = activity?.activityWindow
    if (!window?.hasEarlier || window.startSequence === null) return
    const guard = snapshotReadinessRef.current.guard(threadId)
    const earlier = await globalThis.window.gale.agent.activities.loadEarlier({ threadId, runId, beforeSequence: window.startSequence })
    throwIfAborted(signal)
    if (!guard.isCurrent() || earlier.runId !== runId) return
    setSnapshots((current) => {
      const snapshot = current[threadId]
      if (!guard.isCurrent() || !snapshot) return current
      return { ...current, [threadId]: { ...snapshot, activities: snapshot.activities.map((item) => item.runId === runId ? mergeActivityPage(item, earlier, window.startSequence!) : item) } }
    })
    setRuns((current) => {
      const run = current[threadId]
      return guard.isCurrent() && run?.runId === runId ? { ...current, [threadId]: mergeActivityPage(run, earlier, window.startSequence!) } : current
    })
  }, [runs, snapshots])

  const loadSubagentDetails = useCallback(async (threadId: string, runId: string, subagentId: string): Promise<void> => {
    const guard = snapshotReadinessRef.current.guard(threadId)
    const details = await window.gale.agent.activities.subagent({ threadId, runId, subagentId })
    if (!guard.isCurrent()) return
    const merge = <T extends AgentRunView | AgentThreadSnapshot['activities'][number]>(activity: T): T => ({
      ...activity,
      subagents: activity.subagents.map((item) => mergeSubagentDetails(item, details))
    })
    setSnapshots((current) => {
      const snapshot = current[threadId]
      if (!guard.isCurrent() || !snapshot) return current
      return { ...current, [threadId]: { ...snapshot, activities: snapshot.activities.map((item) => item.runId === runId ? merge(item) : item) } }
    })
    setRuns((current) => {
      const run = current[threadId]
      return guard.isCurrent() && run?.runId === runId ? { ...current, [threadId]: merge(run) } : current
    })
  }, [])

  const regenerateMessage = useCallback(async (
    threadId: string,
    userMessageId: string,
    skillPromptText?: string
  ): Promise<void> => {
    const previousSnapshot = snapshots[threadId]
    if (!previousSnapshot) throw new Error('Thread state is not loaded.')
    const messageIndex = previousSnapshot.messages.findIndex((message) => message.id === userMessageId)
    if (messageIndex < 0) throw new Error('Message was not found.')
    const targetRunId = previousSnapshot.messages[messageIndex].runId
    if (!targetRunId) throw new Error('Message is missing its run association.')
    const run = await window.gale.agent.messages.regenerate({
      threadId,
      messageId: userMessageId,
      skillPromptText
    })
    setSnapshots((current) => {
      const snapshot = current[threadId]
      if (!snapshot) return current
      const currentMessageIndex = snapshot.messages.findIndex(
        (message) => message.id === userMessageId
      )
      if (currentMessageIndex < 0 || snapshot.messages[currentMessageIndex].runId === run.id) {
        return current
      }
      const currentActivityIndex = snapshot.activities.findIndex(
        (activity) => activity.runId === targetRunId
      )
      return {
        ...current,
        [threadId]: {
          ...snapshot,
          messages: snapshot.messages.slice(0, currentMessageIndex + 1).map((message, index) =>
            index === currentMessageIndex
              ? {
                  ...message,
                  runId: run.id,
                  createdAt: run.createdAt,
                  ...(skillPromptText && message.skillInvocation
                    ? {
                        skillInvocation: {
                          ...message.skillInvocation,
                          promptText: skillPromptText
                        }
                      }
                    : {})
                }
              : message
          ),
          activities: currentActivityIndex < 0
            ? snapshot.activities
            : snapshot.activities.slice(0, currentActivityIndex),
          todos: []
        }
      }
    })
  }, [snapshots])

  const removeThreads = useCallback((threadIds: string[]): void => {
    const ids = new Set(threadIds)
    if (ids.size > 0) threadProjectionRevisionRef.current += 1
    for (const threadId of ids) snapshotReadinessRef.current.forget(threadId)
    for (const threadId of ids) queuedMessages.forgetThread(threadId)
    setThreads((current) => current.filter((thread) => !ids.has(thread.id)))
    setSnapshots((current) => Object.fromEntries(
      Object.entries(current).filter(([threadId]) => !ids.has(threadId))
    ))
    setRuns((current) => Object.fromEntries(
      Object.entries(current).filter(([threadId]) => !ids.has(threadId))
    ))
    setErrors((current) => forgetThreadErrors(current, ids))
    if (activeThreadId && ids.has(activeThreadId)) startNewThread()
  }, [activeThreadId, queuedMessages, startNewThread])

  const activeSnapshot = activeThreadId ? snapshots[activeThreadId] : undefined
  const activeRun = activeThreadId ? runs[activeThreadId] : undefined
  const activeQueuedMessages = activeThreadId
    ? queuedMessages.messagesByThread[activeThreadId] ?? []
    : []
  const activeThread = activeThreadId
    ? threads.find((thread) => thread.id === activeThreadId)
    : undefined
  const activeError = threadErrorFor(errors, activeThreadId)

  return useMemo(() => ({
    activeRun,
    activeQueuedMessages,
    activeError,
    activeSnapshot,
    activeThread,
    activeThreadId,
    cancel,
    compressContext,
    cleanupThreads,
    deleteThread,
    draftProjectId,
    loadingThreads,
    loadEarlierMessages,
    loadEarlierActivities,
    loadSubagentDetails,
    openThread,
    queueMessage: queuedMessages.enqueue,
    removeQueuedMessage: queuedMessages.remove,
    retryQueuedMessage: queuedMessages.retry,
    reloadThreads,
    removeThreads,
    prepareMessageEdit,
    renameThread,
    regenerateMessage,
    resume,
    runs,
    send,
    setActiveError,
    setAccessMode,
    setThreadError,
    setThreadModel,
    setThreadModelParameterPreset,
    setNewThreadWorkspace,
    startNewThread,
    steerQueuedMessage: queuedMessages.steer,
    threads,
    truncateFromMessage,
    togglePinned,
    workspaceState
  }), [
    activeRun,
    activeQueuedMessages,
    activeError,
    activeSnapshot,
    activeThread,
    activeThreadId,
    cancel,
    compressContext,
    cleanupThreads,
    deleteThread,
    draftProjectId,
    loadingThreads,
    loadEarlierMessages,
    loadEarlierActivities,
    loadSubagentDetails,
    openThread,
    queuedMessages,
    reloadThreads,
    removeThreads,
    prepareMessageEdit,
    renameThread,
    regenerateMessage,
    resume,
    runs,
    send,
    setActiveError,
    setAccessMode,
    setThreadError,
    setThreadModel,
    setThreadModelParameterPreset,
    setNewThreadWorkspace,
    startNewThread,
    threads,
    truncateFromMessage,
    togglePinned,
    workspaceState
  ])
}
