import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentContextStatus,
  AgentRuntimeEvent,
  AgentRunActivity,
  AgentSubagentActivity,
  AgentThread,
  AgentThreadSnapshot,
  AgentWorkspaceState
} from '@shared/agentTypes'
import type { GaleApi } from '@shared/types'
import { useAgentWorkspace } from './useAgentWorkspace'

vi.mock('react-i18next', () => {
  const t = (key: string): string => key
  return { useTranslation: () => ({ t }) }
})

const thread: AgentThread = {
  id: 'thread-1',
  title: 'Restored thread',
  projectId: 'project-1',
  modelConfigId: 'model-2',
  modelParameterPresetId: 'thinking-on',
  pinned: false,
  accessMode: 'read_only_allowed',
  status: 'idle',
  userTurnCount: 1,
  createdAt: '2026-08-21T00:00:00.000Z',
  updatedAt: '2026-08-21T00:01:00.000Z'
}

const snapshot: AgentThreadSnapshot = {
  thread,
  messages: [],
  todos: [],
  interrupts: [],
  activities: [],
  messageWindow: {
    startIndex: 0,
    shown: 0,
    total: 0,
    remaining: 0
  }
}

function runningSnapshot(text: string): AgentThreadSnapshot {
  const run = {
    id: 'run-1',
    threadId: thread.id,
    operation: 'agent' as const,
    status: 'running' as const,
    createdAt: '2026-08-21T00:01:00.000Z',
    updatedAt: '2026-08-21T00:02:00.000Z'
  }
  return {
    ...snapshot,
    thread: { ...thread, status: 'running' },
    pendingRun: run,
    activities: [{
      runId: run.id,
      operation: run.operation,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      models: [{
        id: 'model-1',
        sequence: 0,
        status: 'running',
        text,
        reasoning: '',
        toolCallIds: []
      }],
      tools: [],
      subagents: []
    }]
  }
}

function interruptedSnapshot(approvalGeneration: string): AgentThreadSnapshot {
  const run = {
    id: 'run-1',
    threadId: thread.id,
    operation: 'agent' as const,
    status: 'interrupted' as const,
    createdAt: '2026-08-21T00:01:00.000Z',
    updatedAt: '2026-08-21T00:02:00.000Z'
  }
  return {
    ...snapshot,
    thread: { ...thread, status: 'interrupted' },
    pendingRun: run,
    interrupts: [{
      id: 'approval-1',
      approvalGeneration,
      value: {
        actionRequests: [{ name: 'pwsh', args: { command: 'echo ready' } }]
      }
    }],
    activities: [{
      runId: run.id,
      operation: run.operation,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      models: [],
      tools: [],
      subagents: []
    }]
  }
}

function activitySnapshot(start: number, end: number, status: 'running' | 'completed' = 'running'): AgentThreadSnapshot {
  const initial = runningSnapshot('activity')
  return {
    ...initial,
    thread: { ...thread, status: status === 'completed' ? 'idle' : 'running' },
    pendingRun: status === 'completed' ? undefined : initial.pendingRun,
    activities: [{
      ...initial.activities[0], status,
      models: Array.from({ length: end - start + 1 }, (_, index) => ({
        ...initial.activities[0].models[0], id: `model-${start + index}`, sequence: start + index,
        text: `body-${start + index}`, status: 'completed'
      })),
      activityWindow: { startSequence: start, endSequence: end, totalCount: end + 1, hasEarlier: start > 0 }
    }]
  }
}

function installAgentApi(restoredWorkspace: AgentWorkspaceState) {
  const setWorkspace = vi.fn(async () => undefined)
  const getThread = vi.fn(async () => snapshot)
  const listThreads = vi.fn(async () => [thread])
  const recover = vi.fn(async () => false)
  const resume = vi.fn(async () => undefined)
  const loadEarlierActivities = vi.fn<() => Promise<AgentRunActivity>>()
  const loadSubagentDetails = vi.fn<() => Promise<AgentSubagentActivity>>()
  const eventSubscriptions = new Set<{
    listener: (event: AgentRuntimeEvent) => void
    subscribed?: () => void | Promise<void>
  }>()
  const setAccessMode = vi.fn(async (_threadId: string, accessMode: AgentThread['accessMode']) => ({
    ...thread,
    accessMode
  }))
  Object.defineProperty(window, 'gale', {
    configurable: true,
    value: {
      agent: {
        workspace: {
          get: vi.fn(async () => restoredWorkspace),
          set: setWorkspace
        },
        threads: {
          list: listThreads,
          get: getThread,
          setAccessMode
        },
        queuedInputs: {
          list: vi.fn(async () => []),
          enqueue: vi.fn(),
          remove: vi.fn(),
          markFailed: vi.fn(),
          retry: vi.fn()
        },
        runs: { recover, resume },
        activities: { loadEarlier: loadEarlierActivities, subagent: loadSubagentDetails },
        onEvent: vi.fn((
          listener: (event: AgentRuntimeEvent) => void,
          onSubscribed?: () => void | Promise<void>
        ) => {
          const subscription = { listener, subscribed: onSubscribed }
          eventSubscriptions.add(subscription)
          return () => eventSubscriptions.delete(subscription)
        })
      }
    } as unknown as GaleApi
  })
  return {
    getThread,
    listThreads,
    recover,
    resume,
    loadEarlierActivities,
    loadSubagentDetails,
    setAccessMode,
    setWorkspace,
    async acknowledgeSubscription(): Promise<void> {
      await Promise.all([...eventSubscriptions].map(({ subscribed }) => subscribed?.()))
    },
    emit(event: AgentRuntimeEvent): void {
      for (const subscription of eventSubscriptions) subscription.listener(event)
    }
  }
}

describe('useAgentWorkspace startup restoration', () => {
  it('keeps restored context separate from reports emitted after the current run starts', async () => {
    const interrupted = interruptedSnapshot('context-approval')
    const stored = { runId: 'run-1', estimatedInputTokens: 100 } as AgentContextStatus
    interrupted.contextStatus = stored
    const api = installAgentApi({ mode: 'thread', threadId: thread.id })
    api.getThread.mockResolvedValue(interrupted)
    const { result } = renderHook(() => useAgentWorkspace({ onAppError: vi.fn() }))
    await waitFor(() => expect(result.current.activeRun?.status).toBe('interrupted'))
    expect(result.current.activeRun?.liveContextStatus).toBeUndefined()
    const resumed = { ...interrupted.pendingRun!, status: 'running' as const }
    act(() => api.emit({ type: 'run_started', run: resumed, newUserTurn: false }))
    expect(result.current.activeSnapshot?.contextStatus).toEqual(stored)
    expect(result.current.activeRun?.liveContextStatus).toBeUndefined()

    // A later snapshot has a new object identity but still contains the report
    // from before resume. Loading it must not promote it to a live report.
    api.getThread.mockResolvedValue({ ...runningSnapshot('Resuming'), contextStatus: { ...stored } })
    await act(async () => result.current.openThread(thread.id))
    expect(result.current.activeRun?.status).toBe('running')
    expect(result.current.activeRun?.liveContextStatus).toBeUndefined()
    const live = { ...stored, estimatedInputTokens: 800 }
    act(() => api.emit({ type: 'context_status_updated', threadId: thread.id, runId: resumed.id, status: live }))
    expect(result.current.activeRun?.liveContextStatus).toEqual(live)
    expect(result.current.activeSnapshot?.contextStatus).toEqual(live)

    act(() => api.emit({ type: 'run_interrupted', run: interrupted.pendingRun!, interrupts: interrupted.interrupts,
      snapshot: { ...interrupted, contextStatus: live } }))
    act(() => api.emit({ type: 'run_started', run: resumed, newUserTurn: false }))
    expect(result.current.activeRun?.liveContextStatus).toBeUndefined()
  })

  it.each(['completed', 'unconfirmed'] as const)('continues cleanup updates after reopening the conversation (%s)', async (status) => {
    const initial = runningSnapshot('Reply')
    const api = installAgentApi({ mode: 'thread', threadId: thread.id })
    api.getThread.mockResolvedValue(initial)
    const { result } = renderHook(() => useAgentWorkspace({ onAppError: vi.fn() }))
    await waitFor(() => expect(result.current.activeRun).toBeDefined())
    const cleanupRun = { ...initial.pendingRun!, status: 'completed' as const,
      backgroundCleanup: { status: 'running' as const, report: 'Cleaning' } }
    act(() => api.emit({ type: 'run_cleanup', run: cleanupRun, cleanup: cleanupRun.backgroundCleanup }))
    const reopened = activitySnapshot(0, 0, 'completed')
    reopened.settlingRun = cleanupRun
    reopened.activities[0].backgroundCleanup = cleanupRun.backgroundCleanup
    api.getThread.mockResolvedValue(reopened)
    await act(async () => { await result.current.openThread(thread.id) })
    expect(result.current.activeSnapshot?.pendingRun).toBeUndefined()
    expect(result.current.activeRun?.backgroundCleanup?.status).toBe('running')
    const completedRun = { ...cleanupRun, backgroundCleanup: { status, report: 'Finished' } }
    act(() => api.emit({ type: 'run_cleanup', run: completedRun, cleanup: completedRun.backgroundCleanup }))
    expect(result.current.activeRun?.backgroundCleanup?.status).toBe(status)
    const completedSnapshot = { ...reopened, settlingRun: undefined,
      activities: [{ ...reopened.activities[0], backgroundCleanup: completedRun.backgroundCleanup }] }
    act(() => api.emit({ type: 'run_completed', run: completedRun, snapshot: completedSnapshot }))
    expect(result.current.activeRun).toBeUndefined()
    expect(result.current.activeSnapshot?.activities[0].backgroundCleanup?.status).toBe(status)
  })

  it('releases a cleanup owner restored between completion and executor settlement', async () => {
    const settling = activitySnapshot(0, 0, 'completed')
    settling.settlingRun = { ...runningSnapshot('').pendingRun!, status: 'completed',
      backgroundCleanup: { status: 'completed', report: 'Finished' } }
    settling.activities[0].backgroundCleanup = settling.settlingRun.backgroundCleanup
    const api = installAgentApi({ mode: 'thread', threadId: thread.id })
    api.getThread.mockResolvedValue(settling)
    const { result } = renderHook(() => useAgentWorkspace({ onAppError: vi.fn() }))
    await waitFor(() => expect(result.current.activeRun).toBeDefined())
    api.getThread.mockResolvedValue({ ...settling, settlingRun: undefined })
    act(() => api.emit({ type: 'run_settled', runId: 'run-1', threadId: thread.id, operation: 'agent', status: 'completed' }))
    await waitFor(() => expect(result.current.activeRun).toBeUndefined())
    expect(result.current.activeSnapshot?.settlingRun).toBeUndefined()
  })

  it('shows automatic cleanup progress without ending the active run or requesting input', async () => {
    const initial = runningSnapshot('cleanup')
    const api = installAgentApi({ mode: 'thread', threadId: thread.id })
    api.getThread.mockResolvedValue(initial)
    const { result } = renderHook(() => useAgentWorkspace({ onAppError: vi.fn() }))
    await waitFor(() => expect(result.current.activeRun).toBeDefined())
    const reply = { id: 'cleanup-reply', runId: initial.pendingRun!.id, role: 'assistant' as const,
      content: [{ type: 'text' as const, text: 'Reply before cleanup' }] }
    const beginCleanup = { type: 'run_cleanup' as const, run: { ...initial.pendingRun!, status: 'completed' as const },
      cleanup: { status: 'running' as const, report: 'Cleanup in progress' }, reply }
    act(() => api.emit(beginCleanup))
    expect(result.current.activeSnapshot?.messages).toEqual([reply])
    expect(result.current.activeSnapshot?.thread.status).toBe('running')
    act(() => api.emit(beginCleanup))
    expect(result.current.activeSnapshot?.messages).toEqual([reply])
    expect(result.current.activeSnapshot?.messageWindow.shown).toBe(1)
    expect(result.current.activeRun).toMatchObject({ status: 'running', backgroundCleanup: { status: 'running', report: 'Cleanup in progress' }, interrupts: [] })
    expect(result.current.activeError).toBeUndefined()
    act(() => api.emit({ type: 'run_cleanup', run: { ...initial.pendingRun!, id: 'stale-run', status: 'failed' },
      cleanup: { status: 'running', report: 'Stale cleanup' }, reply: { ...reply, id: 'stale-reply', runId: 'stale-run' } }))
    expect(result.current.activeSnapshot?.messages).toEqual([reply])
    expect(result.current.activeError).toBeUndefined()
    act(() => api.emit({ type: 'run_cleanup', run: { ...initial.pendingRun!, status: 'completed' }, cleanup: { status: 'completed', report: 'Cleanup complete' } }))
    expect(result.current.activeRun?.backgroundCleanup).toEqual({ status: 'completed', report: 'Cleanup complete' })
  })

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('atomically keeps live activities when the completed snapshot tail has moved past the cached prefix', async () => {
    const initial = activitySnapshot(0, 4)
    const api = installAgentApi({ mode: 'thread', threadId: thread.id })
    api.getThread.mockResolvedValue(initial)
    const { result } = renderHook(() => useAgentWorkspace({ onAppError: vi.fn() }))
    await waitFor(() => expect(result.current.activeRun?.models).toHaveLength(5))
    const completed = activitySnapshot(110, 209, 'completed')
    act(() => {
      for (const model of activitySnapshot(5, 209).activities[0].models) {
        api.emit({ type: 'model_completed', runId: 'run-1', threadId: thread.id, model })
      }
      api.emit({ type: 'run_completed', run: { ...initial.pendingRun!, status: 'completed' }, snapshot: completed })
    })
    expect(result.current.activeRun).toBeUndefined()
    expect(result.current.activeSnapshot?.activities[0].models.map((model) => model.sequence))
      .toEqual(Array.from({ length: 210 }, (_, sequence) => sequence))
  })

  it('keeps an older tool completion when terminal projection arrives in the same React batch', async () => {
    const initial = activitySnapshot(0, 0)
    const call = { id: 'old-tool', name: 'test', args: {} }
    initial.activities[0].tools = [{ call, sequence: 1, status: 'running' }]
    initial.activities[0].activityWindow!.endSequence = 1
    const api = installAgentApi({ mode: 'thread', threadId: thread.id })
    api.getThread.mockResolvedValue(initial)
    const { result } = renderHook(() => useAgentWorkspace({ onAppError: vi.fn() }))
    await waitFor(() => expect(result.current.activeRun?.tools).toHaveLength(1))
    act(() => {
      api.emit({ type: 'tool_completed', runId: 'run-1', threadId: thread.id, call, sequence: 1, output: 'COMPLETE_OUTPUT', completedAt: 'finished' })
      api.emit({ type: 'run_completed', run: { ...initial.pendingRun!, status: 'completed' }, snapshot: activitySnapshot(101, 200, 'completed') })
    })
    expect(result.current.activeSnapshot?.activities[0].tools[0])
      .toMatchObject({ status: 'completed', output: 'COMPLETE_OUTPUT' })
  })

  it('retains the last live completion while loading a missing terminal snapshot', async () => {
    const initial = activitySnapshot(0, 0)
    const api = installAgentApi({ mode: 'thread', threadId: thread.id })
    api.getThread.mockResolvedValue(initial)
    const { result } = renderHook(() => useAgentWorkspace({ onAppError: vi.fn() }))
    await waitFor(() => expect(result.current.activeRun).toBeDefined())
    let resolveSnapshot!: (snapshot: AgentThreadSnapshot) => void
    api.getThread.mockImplementation(() => new Promise((resolve) => { resolveSnapshot = resolve }))
    act(() => {
      api.emit({ type: 'model_completed', runId: 'run-1', threadId: thread.id, model: activitySnapshot(5, 5).activities[0].models[0] })
      api.emit({ type: 'run_completed', run: { ...initial.pendingRun!, status: 'completed' } })
    })
    expect(result.current.activeRun).toBeUndefined()
    expect(result.current.activeSnapshot?.activities[0].models.map((model) => model.sequence)).toEqual([0, 5])
    await act(async () => { resolveSnapshot(activitySnapshot(101, 200, 'completed')) })
    expect(result.current.activeSnapshot?.activities[0].models.some((model) => model.sequence === 5)).toBe(true)
    expect(result.current.activeSnapshot?.activities[0].activityWindow?.hasEarlier).toBe(true)
  })

  it('retains loaded activity pages and their cursor when a running turn pauses for approval', async () => {
    const initial = activitySnapshot(100, 199)
    const api = installAgentApi({ mode: 'thread', threadId: thread.id })
    api.getThread.mockResolvedValue(initial)
    api.loadEarlierActivities.mockResolvedValue(activitySnapshot(50, 99).activities[0])
    const { result } = renderHook(() => useAgentWorkspace({ onAppError: vi.fn() }))
    await waitFor(() => expect(result.current.activeRun?.activityWindow?.startSequence).toBe(100))
    await act(() => result.current.loadEarlierActivities(thread.id, 'run-1', new AbortController().signal))
    const paused = interruptedSnapshot('generation')
    paused.activities = [{ ...initial.activities[0], status: 'interrupted' }]
    act(() => api.emit({ type: 'run_interrupted', run: paused.pendingRun!, interrupts: paused.interrupts, snapshot: paused }))
    expect(result.current.activeRun?.status).toBe('interrupted')
    expect(result.current.activeRun?.models).toHaveLength(150)
    expect(result.current.activeRun?.activityWindow).toMatchObject({ startSequence: 50, endSequence: 199, hasEarlier: true })
    api.loadEarlierActivities.mockResolvedValue(activitySnapshot(0, 49).activities[0])
    await act(() => result.current.loadEarlierActivities(thread.id, 'run-1', new AbortController().signal))
    expect(api.loadEarlierActivities).toHaveBeenLastCalledWith({ threadId: thread.id, runId: 'run-1', beforeSequence: 50 })
    expect(result.current.activeRun?.models).toHaveLength(200)
    expect(result.current.activeRun?.activityWindow?.hasEarlier).toBe(false)
  })

  it('loads a missed event interval after background refresh instead of hiding its pagination', async () => {
    const initial = activitySnapshot(0, 4)
    const api = installAgentApi({ mode: 'thread', threadId: thread.id })
    api.getThread.mockResolvedValue(initial)
    const { result } = renderHook(() => useAgentWorkspace({ onAppError: vi.fn() }))
    await waitFor(() => expect(result.current.activeRun?.models).toHaveLength(5))
    api.getThread.mockResolvedValue(activitySnapshot(110, 209))
    await act(() => api.acknowledgeSubscription())
    expect(result.current.activeRun?.models).toHaveLength(105)
    expect(result.current.activeRun?.activityWindow).toMatchObject({ startSequence: 110, hasEarlier: true })
    api.loadEarlierActivities.mockResolvedValue(activitySnapshot(10, 109).activities[0])
    await act(() => result.current.loadEarlierActivities(thread.id, 'run-1', new AbortController().signal))
    expect(api.loadEarlierActivities).toHaveBeenLastCalledWith({ threadId: thread.id, runId: 'run-1', beforeSequence: 110 })
    expect(result.current.activeRun?.activityWindow).toMatchObject({ startSequence: 10, hasEarlier: true })
    api.loadEarlierActivities.mockResolvedValue(activitySnapshot(0, 9).activities[0])
    await act(() => result.current.loadEarlierActivities(thread.id, 'run-1', new AbortController().signal))
    expect(result.current.activeRun?.models).toHaveLength(210)
    expect(result.current.activeRun?.activityWindow?.hasEarlier).toBe(false)
  })

  it('opens the persisted thread and restores its model metadata', async () => {
    const api = installAgentApi({ mode: 'thread', threadId: thread.id })
    const onAppError = vi.fn()
    const { result } = renderHook(() => useAgentWorkspace({ onAppError }))

    await waitFor(() => expect(result.current.loadingThreads).toBe(false))

    expect(result.current.activeThreadId).toBe(thread.id)
    expect(result.current.activeThread).toMatchObject({
      modelConfigId: 'model-2',
      modelParameterPresetId: 'thinking-on'
    })
    expect(api.getThread).toHaveBeenCalledWith(thread.id)
    expect(api.recover).toHaveBeenCalledWith(thread.id)
    expect(api.setWorkspace).not.toHaveBeenCalled()

    await act(() => result.current.setAccessMode(thread.id, 'strict_approval'))
    expect(api.setAccessMode).toHaveBeenCalledWith(thread.id, 'strict_approval')
    expect(result.current.activeThread?.accessMode).toBe('strict_approval')
  })

  it('prepends older activities without dropping live values and preserves loaded pages on refresh', async () => {
    const initial = runningSnapshot('tail')
    initial.activities[0].models[0].sequence = 100
    initial.activities[0].activityWindow = { startSequence: 100, endSequence: 199, totalCount: 200, hasEarlier: true }
    const api = installAgentApi({ mode: 'thread', threadId: thread.id })
    api.getThread.mockResolvedValue(initial)
    const { result } = renderHook(() => useAgentWorkspace({ onAppError: vi.fn() }))
    await waitFor(() => expect(result.current.activeRun?.activityWindow?.startSequence).toBe(100))
    let resolvePage!: (value: AgentRunActivity) => void
    api.loadEarlierActivities.mockImplementation(() => new Promise((resolve) => { resolvePage = resolve }))
    let loading!: Promise<void>
    act(() => { loading = result.current.loadEarlierActivities(thread.id, 'run-1', new AbortController().signal) })
    act(() => api.emit({ type: 'model_delta', runId: 'run-1', threadId: thread.id, modelId: 'model-1', delta: { type: 'text', text: ' live' } }))
    const earlier: AgentRunActivity = { ...initial.activities[0],
      models: [{ ...initial.activities[0].models[0], id: 'old-model', sequence: 0, text: 'old' }, initial.activities[0].models[0]],
      activityWindow: { startSequence: 0, endSequence: 99, totalCount: 200, hasEarlier: false } }
    await act(async () => { resolvePage(earlier); await loading })
    expect(api.loadEarlierActivities).toHaveBeenCalledWith({ threadId: thread.id, runId: 'run-1', beforeSequence: 100 })
    expect(result.current.activeRun?.models.map((model) => model.text)).toEqual(['old', 'tail live'])
    await act(() => api.acknowledgeSubscription())
    expect(result.current.activeSnapshot?.activities[0].models.map((model) => model.id)).toEqual(['old-model', 'model-1'])
    expect(result.current.activeRun?.models.map((model) => model.text)).toEqual(['old', 'tail live'])
    expect(result.current.activeRun?.activityWindow?.hasEarlier).toBe(false)
  })

  it('discards an aborted earlier activity request', async () => {
    const initial = runningSnapshot('tail')
    initial.activities[0].activityWindow = { startSequence: 100, endSequence: 199, totalCount: 200, hasEarlier: true }
    const api = installAgentApi({ mode: 'thread', threadId: thread.id })
    api.getThread.mockResolvedValue(initial)
    const { result } = renderHook(() => useAgentWorkspace({ onAppError: vi.fn() }))
    await waitFor(() => expect(result.current.activeRun).toBeDefined())
    let resolvePage!: (value: AgentRunActivity) => void
    api.loadEarlierActivities.mockImplementation(() => new Promise((resolve) => { resolvePage = resolve }))
    const controller = new AbortController()
    let loading!: Promise<void>
    act(() => { loading = result.current.loadEarlierActivities(thread.id, 'run-1', controller.signal) })
    controller.abort()
    await act(async () => {
      resolvePage({ ...initial.activities[0], models: [], activityWindow: { startSequence: 0, endSequence: 99, totalCount: 200, hasEarlier: false } })
      await expect(loading).rejects.toMatchObject({ name: 'AbortError' })
    })
    expect(result.current.activeRun?.activityWindow?.startSequence).toBe(100)
  })

  it('does not replace a newly completed child with a late running detail response', async () => {
    const initial = runningSnapshot('tail')
    const child: AgentSubagentActivity = { id: 'child', name: 'Child', sequence: 2, status: 'running', detailsDeferred: true }
    initial.activities[0].subagents = [child]
    const api = installAgentApi({ mode: 'thread', threadId: thread.id })
    api.getThread.mockResolvedValue(initial)
    const { result } = renderHook(() => useAgentWorkspace({ onAppError: vi.fn() }))
    await waitFor(() => expect(result.current.activeRun?.subagents).toHaveLength(1))
    let resolveDetails!: (value: AgentSubagentActivity) => void
    api.loadSubagentDetails.mockImplementation(() => new Promise((resolve) => { resolveDetails = resolve }))
    let loading!: Promise<void>
    act(() => { loading = result.current.loadSubagentDetails(thread.id, 'run-1', 'child') })
    act(() => api.emit({ type: 'subagent_updated', runId: 'run-1', threadId: thread.id,
      subagent: { ...child, status: 'completed', completedAt: 'finished', detailsDeferred: false, result: 'complete result' } }))
    await act(async () => { resolveDetails({ ...child, detailsDeferred: false }); await loading })
    expect(result.current.activeRun?.subagents[0]).toMatchObject({ status: 'completed', completedAt: 'finished', result: 'complete result' })
  })

  it('restores and updates a new thread that has no conversation record yet', async () => {
    const restoredWorkspace: AgentWorkspaceState = {
      mode: 'new_thread',
      projectId: 'project-2',
      modelConfigId: 'model-3',
      modelParameterPresetId: 'thinking-off'
    }
    const api = installAgentApi(restoredWorkspace)
    const onAppError = vi.fn()
    const { result } = renderHook(() => useAgentWorkspace({ onAppError }))

    await waitFor(() => expect(result.current.loadingThreads).toBe(false))

    expect(result.current.activeThreadId).toBeUndefined()
    expect(result.current.draftProjectId).toBe('project-2')
    expect(result.current.workspaceState).toEqual(restoredWorkspace)
    expect(api.getThread).not.toHaveBeenCalled()

    act(() => result.current.setNewThreadWorkspace('project-4', 'model-3', 'thinking-off'))

    await waitFor(() => expect(api.setWorkspace).toHaveBeenCalledWith({
      mode: 'new_thread',
      projectId: 'project-4',
      modelConfigId: 'model-3',
      modelParameterPresetId: 'thinking-off'
    }))
  })

  it('allows the same workspace state to be retried after a save failure', async () => {
    const api = installAgentApi({
      mode: 'new_thread',
      projectId: 'project-2',
      modelConfigId: 'model-3',
      modelParameterPresetId: null
    })
    api.setWorkspace.mockRejectedValueOnce(new Error('database unavailable'))
    const onAppError = vi.fn()
    const { result } = renderHook(() => useAgentWorkspace({ onAppError }))
    await waitFor(() => expect(result.current.loadingThreads).toBe(false))

    act(() => result.current.setNewThreadWorkspace('project-4', 'model-4', null))
    await waitFor(() => expect(onAppError).toHaveBeenCalledWith(
      'chat.failed_save_workspace_state'
    ))

    act(() => result.current.setNewThreadWorkspace('project-4', 'model-4', null))
    await waitFor(() => expect(api.setWorkspace).toHaveBeenCalledTimes(2))
  })

  it('projects argument snapshots without creating executable tools, then clears them', async () => {
    const initial = runningSnapshot('')
    initial.activities[0].models[0].round = 42
    const api = installAgentApi({ mode: 'thread', threadId: thread.id })
    api.getThread.mockResolvedValue(initial)
    const { result } = renderHook(() => useAgentWorkspace({ onAppError: vi.fn() }))
    await waitFor(() => expect(result.current.activeRun?.models).toHaveLength(1))
    const event: Extract<AgentRuntimeEvent, { type: 'model_tool_calls' }> = {
      type: 'model_tool_calls', runId: 'run-1', threadId: thread.id, modelId: 'model-1',
      progress: [{ index: 0, callId: 'call-1', name: 'apply_patch', characterCount: 9, complete: false }]
    }
    act(() => api.emit(event))
    expect(result.current.activeRun?.models[0].toolCallProgress).toEqual(event.progress)
    expect(result.current.activeRun?.tools).toEqual([])
    act(() => api.emit({ ...event, subagentId: 'different-agent', progress: [] }))
    expect(result.current.activeRun?.models[0].toolCallProgress).toEqual(event.progress)
    act(() => api.emit({ type: 'model_completed', runId: 'run-1', threadId: thread.id, model: {
      ...initial.activities[0].models[0], round: undefined, status: 'completed', toolCallIds: ['call-1']
    } }))
    expect(result.current.activeRun?.models[0].toolCallProgress).toEqual(event.progress)
    expect(result.current.activeRun?.models[0].round).toBe(42)
    act(() => api.emit({ ...event, progress: [] }))
    expect(result.current.activeRun?.models[0].toolCallProgress).toEqual([])
  })

  it('keeps newer run activity when recovery failure supplies an older authoritative snapshot', async () => {
    const authoritative = runningSnapshot('durable prefix')
    const api = installAgentApi({ mode: 'thread', threadId: thread.id })
    api.getThread.mockResolvedValue(authoritative)
    const onAppError = vi.fn()
    const { result } = renderHook(() => useAgentWorkspace({ onAppError }))

    await waitFor(() => expect(result.current.activeRun?.models[0]?.text).toBe('durable prefix'))
    act(() => api.emit({
      type: 'model_delta',
      runId: 'run-1',
      threadId: thread.id,
      modelId: 'model-1',
      delta: { type: 'text', text: ' plus live delta' }
    }))
    expect(result.current.activeRun?.models[0]?.text).toBe('durable prefix plus live delta')

    act(() => api.emit({
      type: 'run_recovery_failed',
      run: authoritative.pendingRun!,
      error: 'Recovery unavailable',
      snapshot: authoritative
    }))

    expect(result.current.activeRun).toMatchObject({
      runId: 'run-1',
      status: 'running',
      error: 'Recovery unavailable'
    })
    expect(result.current.activeRun?.models[0]?.text).toBe('durable prefix plus live delta')
  })

  it('settles live child projections when a terminal subagent update arrives', async () => {
    const live = runningSnapshot('Root work')
    const activity = live.activities[0]
    activity.models.push({
      id: 'child-model',
      sequence: 1,
      status: 'running',
      subagentId: 'child-1',
      text: 'Partial child work',
      reasoning: '',
      toolCallIds: ['child-tool']
    }, {
      id: 'sibling-model',
      sequence: 2,
      status: 'running',
      subagentId: 'sibling-1',
      text: 'Sibling work',
      reasoning: '',
      toolCallIds: []
    })
    activity.tools.push({
      call: { id: 'child-tool', name: 'apply_patch', args: {} },
      sequence: 3,
      status: 'running',
      subagentId: 'child-1',
      approval: {
        status: 'pending_approval',
        interruptId: 'child-approval',
        actionIndex: 0
      }
    })
    activity.subagents.push({
      id: 'child-1',
      name: 'reviewer',
      sequence: 4,
      status: 'running'
    }, {
      id: 'sibling-1',
      name: 'researcher',
      sequence: 5,
      status: 'running'
    })
    const api = installAgentApi({ mode: 'thread', threadId: thread.id })
    api.getThread.mockResolvedValue(live)
    const { result } = renderHook(() => useAgentWorkspace({ onAppError: vi.fn() }))
    await waitFor(() => expect(result.current.activeRun?.subagents).toHaveLength(2))
    const completedAt = '2026-09-04T00:02:05.000Z'

    act(() => api.emit({
      type: 'subagent_updated',
      runId: 'run-1',
      threadId: thread.id,
      subagent: {
        id: 'child-1',
        name: 'reviewer',
        sequence: 4,
        status: 'failed',
        error: 'Child failed.',
        completedAt
      }
    }))

    expect(result.current.activeRun?.models.find((model) => model.id === 'child-model'))
      .toMatchObject({ status: 'completed', text: 'Partial child work', completedAt })
    const childTool = result.current.activeRun?.tools.find((tool) => tool.call.id === 'child-tool')
    expect(childTool).toMatchObject({ status: 'completed', completedAt })
    expect(childTool).not.toHaveProperty('approval')
    expect(result.current.activeRun?.models.find((model) => model.id === 'sibling-model')?.status)
      .toBe('running')
    expect(result.current.activeRun?.subagents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'child-1', status: 'failed', error: 'Child failed.' }),
      expect.objectContaining({ id: 'sibling-1', status: 'running' })
    ]))
  })

  it('refreshes the authoritative approval after a stale generation rejection', async () => {
    const stale = interruptedSnapshot('generation-1')
    const current = interruptedSnapshot('generation-2')
    const api = installAgentApi({ mode: 'thread', threadId: thread.id })
    api.getThread
      .mockResolvedValueOnce(stale)
      .mockResolvedValueOnce(current)
    api.resume.mockRejectedValueOnce(new Error(
      'Resume response for interrupt approval-1 does not match its current approval generation.'
    ))
    const onAppError = vi.fn()
    const { result } = renderHook(() => useAgentWorkspace({ onAppError }))

    await waitFor(() => expect(result.current.activeRun).toMatchObject({
      status: 'interrupted',
      interrupts: [{ approvalGeneration: 'generation-1' }]
    }))

    await act(async () => {
      await expect(result.current.resume(thread.id, [{
        interruptId: 'approval-1',
        expectedGeneration: 'generation-1',
        decisions: [{ type: 'approve' }]
      }])).rejects.toThrow('does not match its current approval generation')
    })

    expect(api.getThread).toHaveBeenCalledTimes(2)
    expect(api.recover).toHaveBeenCalledTimes(2)
    expect(result.current.activeRun?.interrupts[0]?.approvalGeneration).toBe('generation-2')
  })

  it('does not keep a stale approval visible when its authoritative refresh fails', async () => {
    const stale = interruptedSnapshot('generation-1')
    const api = installAgentApi({ mode: 'thread', threadId: thread.id })
    api.getThread
      .mockResolvedValueOnce(stale)
      .mockRejectedValueOnce(new Error('snapshot unavailable'))
    api.resume.mockRejectedValueOnce(new Error(
      'Resume response for interrupt approval-1 does not match its current approval generation.'
    ))
    const onAppError = vi.fn()
    const { result } = renderHook(() => useAgentWorkspace({ onAppError }))
    await waitFor(() => expect(result.current.activeRun?.interrupts).toHaveLength(1))

    await act(async () => {
      await expect(result.current.resume(thread.id, [{
        interruptId: 'approval-1',
        expectedGeneration: 'generation-1',
        decisions: [{ type: 'approve' }]
      }])).rejects.toThrow('does not match its current approval generation')
    })

    expect(result.current.activeRun?.interrupts).toEqual([])
    expect(result.current.activeError).toBe('chat.failed_load_app')
  })

  it('refreshes after event subscription acknowledgement to close the initial IPC gap', async () => {
    const api = installAgentApi({ mode: 'thread', threadId: thread.id })
    api.getThread
      .mockResolvedValueOnce(runningSnapshot('before subscription'))
      .mockResolvedValueOnce(snapshot)
    const onAppError = vi.fn()
    const { result } = renderHook(() => useAgentWorkspace({ onAppError }))

    await waitFor(() => expect(result.current.activeRun?.models[0]?.text).toBe('before subscription'))
    await act(() => api.acknowledgeSubscription())

    await waitFor(() => expect(result.current.activeRun).toBeUndefined())
    expect(api.getThread).toHaveBeenCalledTimes(2)
  })

  it('does not let an older thread-list response overwrite a live run projection', async () => {
    const api = installAgentApi({ mode: 'thread', threadId: thread.id })
    const onAppError = vi.fn()
    const { result } = renderHook(() => useAgentWorkspace({ onAppError }))
    await waitFor(() => expect(result.current.loadingThreads).toBe(false))
    let resolveStale!: (items: AgentThread[]) => void
    const staleResponse = new Promise<AgentThread[]>((resolve) => {
      resolveStale = resolve
    })
    api.listThreads
      .mockImplementationOnce(() => staleResponse)
      .mockResolvedValueOnce([{ ...thread, status: 'running' }])

    let reload!: Promise<AgentThread[]>
    act(() => {
      reload = result.current.reloadThreads()
    })
    await waitFor(() => expect(api.listThreads).toHaveBeenCalledTimes(2))
    act(() => api.emit({
      type: 'run_started',
      run: {
        id: 'run-1',
        threadId: thread.id,
        operation: 'agent',
        status: 'running',
        createdAt: '2026-08-21T00:02:00.000Z',
        updatedAt: '2026-08-21T00:02:00.000Z'
      },
      newUserTurn: false
    }))
    resolveStale([thread])
    await act(() => reload)

    expect(api.listThreads).toHaveBeenCalledTimes(3)
    expect(result.current.activeThread?.status).toBe('running')
  })
})
