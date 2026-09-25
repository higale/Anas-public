import { describe, expect, it, vi } from 'vitest'
import type { AgentThreadSnapshot } from '@shared/agentTypes'
import {
  loadAgentThreadSnapshotAndRecover,
  recoveryFailedSnapshotProjection,
  reconcileRecoveryFailedAgentRunViews,
  reconcileRecoveredAgentRunViews,
  recoveredAgentRunView,
  terminalEventMatchesRun
} from './agentRecoveryHandshake'
import { AgentSnapshotReadiness } from './agentSnapshotReadiness'

function snapshot(status: AgentThreadSnapshot['thread']['status']): AgentThreadSnapshot {
  return {
    thread: {
      id: 'thread-1',
      title: 'Thread',
      projectId: 'default-workspace',
      pinned: false,
      accessMode: 'read_only_allowed',
      status,
      userTurnCount: 1,
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:00.000Z'
    },
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
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('agent recovery handshake', () => {
  it('rejects a delayed terminal event after a newer run has started', () => {
    expect(terminalEventMatchesRun('run-2', 'run-1')).toBe(false)
    expect(terminalEventMatchesRun('run-2', 'run-2')).toBe(true)
    expect(terminalEventMatchesRun(undefined, 'run-1')).toBe(false)
  })

  it('clears checkpoint-ahead todos and context after recovery fails without a snapshot', () => {
    const live = snapshot('running')
    live.todos = [{ content: 'Live-only task', status: 'in_progress' }]
    live.contextStatus = {
      modelConfigId: 'model-test',
      estimatedInputTokens: 120,
      currentContextTokens: 120,
      maxContextTokens: 1_000,
      maxOutputTokens: 100,
      inputCapacityTokens: 900,
      compressionEnabled: true,
      compressionThreshold: 0.8,
      compressionThresholdTokens: 700,
      compressionApplied: false,
      manualCompressionAvailable: true,
      breakdown: {
        profileTokens: 1,
        systemInstructionTokens: 2,
        runtimeContextTokens: 3,
        workspaceTokens: 4,
        memoryTokens: 5,
        skillTokens: 6,
        toolDefinitionTokens: 7,
        messageTokens: 8,
        attachmentTokens: 9
      }
    }

    const projected = recoveryFailedSnapshotProjection(live)

    expect(projected).toEqual({
      ...live,
      todos: [],
      contextStatus: undefined
    })
    expect(projected?.thread).toBe(live.thread)
    expect(projected?.messages).toBe(live.messages)
  })

  it('uses the exact authoritative snapshot when recovery failure includes one', () => {
    const live = snapshot('running')
    live.todos = [{ content: 'Live-only task', status: 'in_progress' }]
    const authoritative = snapshot('running')
    authoritative.todos = [{ content: 'Durable task', status: 'pending' }]

    expect(recoveryFailedSnapshotProjection(live, authoritative)).toBe(authoritative)
  })

  it('reconstructs a running view from an already-active baseline', () => {
    const running = snapshot('running')
    running.pendingRun = {
      id: 'run-1',
      threadId: 'thread-1',
      operation: 'agent',
      status: 'running',
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:01.000Z'
    }
    running.activities = [{
      runId: 'run-1',
      operation: 'agent',
      status: 'running',
      error: undefined,
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:01.000Z',
      models: [],
      tools: [],
      subagents: []
    }]
    running.interrupts = [{
      id: 'obsolete-interrupt',
      value: {},
      approvalGeneration: 'obsolete-generation'
    }]

    expect(recoveredAgentRunView(running)).toEqual({
      runId: 'run-1',
      operation: 'agent',
      status: 'running',
      error: undefined,
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:01.000Z',
      models: [],
      tools: [],
      subagents: [],
      memoryRecalls: [],
      summaries: [],
      interrupts: []
    })
  })

  it('removes a stale active view when an authoritative snapshot has no pending run', () => {
    const idle = snapshot('idle')
    const current = {
      'thread-1': {
        runId: 'run-1',
        operation: 'agent' as const,
        status: 'running' as const,
        createdAt: '2026-08-09T00:00:00.000Z',
        updatedAt: '2026-08-09T00:00:01.000Z',
        models: [],
        tools: [],
        subagents: [],
        summaries: [],
        interrupts: []
      }
    }

    expect(reconcileRecoveredAgentRunViews(current, idle)).toEqual({})
  })

  it('merges an active baseline without losing newer deltas or durable completions', () => {
    const running = snapshot('running')
    running.pendingRun = {
      id: 'run-1',
      threadId: 'thread-1',
      operation: 'agent',
      status: 'running',
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:02.000Z'
    }
    running.activities = [{
      runId: 'run-1',
      operation: 'agent',
      status: 'running',
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:02.000Z',
      models: [
        {
          id: 'model-live',
          round: 41,
          sequence: 0,
          status: 'running',
          text: 'older',
          reasoning: '',
          toolCallIds: []
        },
        {
          id: 'model-finished',
          sequence: 1,
          status: 'completed',
          text: 'durable final',
          reasoning: '',
          toolCallIds: []
        }
      ],
      tools: [{
        call: { id: 'tool-1', name: 'tool', args: {} },
        sequence: 2,
        status: 'completed',
        output: 'durable output'
      }],
      subagents: [{
        id: 'subagent-failed',
        name: 'failed-agent',
        sequence: 4,
        status: 'failed',
        error: 'Durable failure'
      }, {
        id: 'subagent-interrupted',
        name: 'approval-agent',
        sequence: 5,
        status: 'interrupted'
      }, {
        id: 'subagent-live-ahead',
        name: 'live-agent',
        sequence: 6,
        status: 'running'
      }],
      memoryRecalls: [{
        id: 'recall-durable',
        sequence: 3,
        query: 'durable',
        promptText: 'durable recall',
        memoryCount: 1,
        createdAt: '2026-08-09T00:00:01.000Z'
      }]
    }]
    const recovered = recoveredAgentRunView(running)
    if (!recovered) throw new Error('Expected a recoverable running view.')
    const current = {
      'thread-1': {
        ...recovered,
        models: [
          { ...recovered.models[0], round: undefined, text: 'newer streamed delta' },
          { ...recovered.models[1], round: 42, status: 'running' as const, text: 'partial' },
          {
            id: 'model-event-only',
            sequence: 3,
            status: 'running' as const,
            text: 'event only',
            reasoning: '',
            toolCallIds: []
          }
        ],
        tools: [{ ...recovered.tools[0], status: 'running' as const, output: undefined }],
        subagents: [
          { ...recovered.subagents[0], status: 'running' as const, error: undefined },
          { ...recovered.subagents[1], status: 'running' as const },
          { ...recovered.subagents[2], status: 'cancelled' as const },
          {
            id: 'subagent-event-only',
            name: 'event-agent',
            sequence: 7,
            status: 'cancelled' as const
          }
        ],
        memoryRecalls: [
          ...(recovered.memoryRecalls ?? []),
          {
            id: 'recall-event-only',
            sequence: 4,
            query: 'event',
            promptText: 'event recall',
            memoryCount: 1,
            createdAt: '2026-08-09T00:00:02.000Z'
          }
        ]
      }
    }

    const merged = reconcileRecoveredAgentRunViews(current, running)['thread-1']
    expect(merged.models.map((model) => model.round)).toEqual([41, 42, undefined])
    expect(merged.models.map((model) => [model.id, model.status, model.text])).toEqual([
      ['model-live', 'running', 'newer streamed delta'],
      ['model-finished', 'completed', 'durable final'],
      ['model-event-only', 'running', 'event only']
    ])
    expect(merged.tools[0]).toMatchObject({
      call: { id: 'tool-1' },
      status: 'completed',
      output: 'durable output'
    })
    expect(merged.subagents.map((subagent) => [
      subagent.id,
      subagent.status,
      subagent.error
    ])).toEqual([
      ['subagent-failed', 'failed', 'Durable failure'],
      ['subagent-interrupted', 'interrupted', undefined],
      ['subagent-live-ahead', 'cancelled', undefined],
      ['subagent-event-only', 'cancelled', undefined]
    ])
    expect(merged.memoryRecalls?.map((recall) => recall.id)).toEqual([
      'recall-durable',
      'recall-event-only'
    ])
  })

  it('accepts an authoritative subagent transition from interrupted back to running', () => {
    const running = snapshot('running')
    running.pendingRun = {
      id: 'run-1',
      threadId: 'thread-1',
      operation: 'agent',
      status: 'running',
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:02.000Z'
    }
    running.activities = [{
      runId: 'run-1',
      operation: 'agent',
      status: 'running',
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:02.000Z',
      models: [],
      tools: [],
      subagents: [{
        id: 'subagent-1',
        name: 'general-purpose',
        sequence: 0,
        status: 'running'
      }]
    }]
    const recovered = recoveredAgentRunView(running)
    if (!recovered) throw new Error('Expected a recoverable running view.')
    const current = {
      'thread-1': {
        ...recovered,
        subagents: [{ ...recovered.subagents[0], status: 'interrupted' as const }]
      }
    }

    expect(reconcileRecoveredAgentRunViews(current, running)['thread-1'].subagents[0].status)
      .toBe('running')
  })

  it('refreshes approval metadata across paused and resumed views while retaining loaded activity pages', () => {
    const paused = snapshot('interrupted')
    paused.pendingRun = {
      id: 'run-1', threadId: 'thread-1', operation: 'agent', status: 'interrupted', createdAt: '', updatedAt: ''
    }
    const approval = { status: 'pending_approval' as const, interruptId: 'approval-1', actionIndex: 0 }
    paused.activities = [{
      runId: 'run-1', operation: 'agent', status: 'interrupted', createdAt: '', updatedAt: '', models: [], subagents: [],
      tools: [{ call: { id: 'tool', name: 'write_file', args: {} }, sequence: 110, status: 'running', approval }],
      activityWindow: { startSequence: 100, endSequence: 199, totalCount: 200, hasEarlier: true }
    }]
    const baseline = recoveredAgentRunView(paused)!
    const previous = { ...baseline, status: 'running' as const,
      tools: baseline.tools.map((tool) => ({ ...tool, approval: undefined })),
      activityWindow: { startSequence: 0, endSequence: 199, totalCount: 200, hasEarlier: false } }
    const interrupted = reconcileRecoveredAgentRunViews({ 'thread-1': previous }, paused)
    expect(interrupted['thread-1'].tools[0].approval).toEqual(approval)
    expect(interrupted['thread-1'].activityWindow?.startSequence).toBe(0)

    const resumed: AgentThreadSnapshot = { ...paused, thread: { ...paused.thread, status: 'running' },
      pendingRun: { ...paused.pendingRun, status: 'running' }, interrupts: [],
      activities: paused.activities.map((activity) => ({ ...activity, status: 'running',
        tools: activity.tools.map((tool) => ({ ...tool, approval: undefined })) })) }
    const running = reconcileRecoveredAgentRunViews(interrupted, resumed)['thread-1']
    expect(running.status).toBe('running')
    expect(running.tools[0].approval).toBeUndefined()
    expect(running.activityWindow?.startSequence).toBe(0)
  })

  it('keeps a child approval while its parent is running and clears it when that child resumes', () => {
    const running = snapshot('running')
    running.pendingRun = {
      id: 'run-1', threadId: 'thread-1', operation: 'agent', status: 'running', createdAt: '', updatedAt: ''
    }
    const approval = { status: 'pending_approval' as const, interruptId: 'child-approval', actionIndex: 0 }
    running.activities = [{
      runId: 'run-1', operation: 'agent', status: 'running', createdAt: '', updatedAt: '', models: [],
      subagents: [{ id: 'child', name: 'Child', sequence: 1, status: 'interrupted' }],
      tools: [{ call: { id: 'child-tool', name: 'write_file', args: {} }, subagentId: 'child', sequence: 2, status: 'running', approval }],
      activityWindow: { startSequence: 0, endSequence: 99, totalCount: 100, hasEarlier: false }
    }]
    const baseline = recoveredAgentRunView(running)!
    const previous = { ...baseline, tools: baseline.tools.map((tool) => ({ ...tool, approval: undefined })) }
    const interrupted = reconcileRecoveredAgentRunViews({ 'thread-1': previous }, running)
    expect(interrupted['thread-1'].status).toBe('running')
    expect(interrupted['thread-1'].tools[0].approval).toEqual(approval)

    const laterTail = { ...running, activities: running.activities.map((activity) => ({ ...activity,
      tools: [], activityWindow: { startSequence: 100, endSequence: 199, totalCount: 200, hasEarlier: true } })) }
    expect(reconcileRecoveredAgentRunViews(interrupted, laterTail)['thread-1'].tools[0].approval).toEqual(approval)
    laterTail.activities[0].subagents = [{ ...baseline.subagents[0], status: 'running' }]
    expect(reconcileRecoveredAgentRunViews(interrupted, laterTail)['thread-1'].tools[0].approval).toBeUndefined()
  })

  it('projects a recovery failure from one monotonic authoritative merge', () => {
    const authoritative = snapshot('running')
    authoritative.pendingRun = {
      id: 'run-1',
      threadId: 'thread-1',
      operation: 'agent',
      status: 'running',
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:01.000Z'
    }
    authoritative.activities = [{
      runId: 'run-1',
      operation: 'agent',
      status: 'running',
      createdAt: '2026-08-09T00:00:00.000Z',
      updatedAt: '2026-08-09T00:00:01.000Z',
      models: [{
        id: 'model-1',
        sequence: 0,
        status: 'running',
        text: 'durable prefix',
        reasoning: '',
        toolCallIds: []
      }],
      tools: [],
      subagents: []
    }]
    const recovered = recoveredAgentRunView(authoritative)
    if (!recovered) throw new Error('Expected a recoverable running view.')
    const current = {
      'thread-1': {
        ...recovered,
        models: [{ ...recovered.models[0], text: 'newer streamed text' }]
      }
    }

    const projected = reconcileRecoveryFailedAgentRunViews(
      current,
      'thread-1',
      'run-1',
      'Recovery unavailable',
      authoritative
    )['thread-1']

    expect(projected).toMatchObject({
      runId: 'run-1',
      status: 'running',
      error: 'Recovery unavailable'
    })
    expect(projected.models[0].text).toBe('newer streamed text')
  })

  it('accepts the initial snapshot before recovery events can replace it', async () => {
    const initial = deferred<AgentThreadSnapshot>()
    const recoveryResponse = deferred<boolean>()
    const readiness = new AgentSnapshotReadiness()
    const running = snapshot('running')
    const terminal = snapshot('idle')
    const order: string[] = []
    let accepted: AgentThreadSnapshot | undefined
    let ready = false
    const acceptSnapshot = vi.fn((value: AgentThreadSnapshot) => {
      accepted = value
      ready = true
      order.push(value.thread.status === 'running' ? 'initial' : 'terminal-event')
    })
    const get = vi.fn(() => initial.promise)
    const recover = vi.fn(() => {
      expect(ready).toBe(true)
      order.push('recover')
      readiness.markReady('thread-1')
      acceptSnapshot(terminal)
      return recoveryResponse.promise
    })

    const loading = loadAgentThreadSnapshotAndRecover({
      threads: { get },
      runs: { recover }
    }, readiness, 'thread-1', acceptSnapshot, true)

    expect(recover).not.toHaveBeenCalled()
    initial.resolve(running)
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce())

    expect(order).toEqual(['initial', 'recover', 'terminal-event'])
    expect(accepted).toBe(terminal)

    recoveryResponse.resolve(true)
    await loading
    expect(accepted).toBe(terminal)
  })

  it('does not let an active-run terminal event be replaced by an older snapshot response', async () => {
    const initial = deferred<AgentThreadSnapshot>()
    const readiness = new AgentSnapshotReadiness()
    const running = snapshot('running')
    const terminal = snapshot('idle')
    const accepted: AgentThreadSnapshot[] = []
    const recover = vi.fn().mockResolvedValue(false)

    const loading = loadAgentThreadSnapshotAndRecover({
      threads: { get: vi.fn(() => initial.promise) },
      runs: { recover }
    }, readiness, 'thread-1', (value) => accepted.push(value), true)

    readiness.markReady('thread-1')
    accepted.push(terminal)
    initial.resolve(running)
    await loading

    expect(accepted).toEqual([terminal])
    expect(recover).not.toHaveBeenCalled()
  })

  it.each([
    ['failed', 'failed'],
    ['cancelled', 'idle']
  ] as const)('queues a terminal refresh when %s arrives before recovery responds', async (
    _event,
    terminalStatus
  ) => {
    const readiness = new AgentSnapshotReadiness()
    const recoveryResponse = deferred<boolean>()
    const running = snapshot('running')
    const terminal = snapshot(terminalStatus)
    const get = vi.fn()
      .mockResolvedValueOnce(running)
      .mockResolvedValueOnce(terminal)
    const recover = vi.fn()
      .mockImplementationOnce(() => recoveryResponse.promise)
      .mockResolvedValueOnce(false)
    const accepted: AgentThreadSnapshot[] = []
    const api = {
      threads: { get },
      runs: { recover }
    }
    const acceptSnapshot = (value: AgentThreadSnapshot): void => {
      accepted.push(value)
    }

    const opening = loadAgentThreadSnapshotAndRecover(
      api,
      readiness,
      'thread-1',
      acceptSnapshot,
      true
    )
    await vi.waitFor(() => expect(recover).toHaveBeenCalledOnce())

    readiness.markNotReady('thread-1')
    const refreshing = loadAgentThreadSnapshotAndRecover(
      api,
      readiness,
      'thread-1',
      acceptSnapshot,
      true
    )
    const sendGate = loadAgentThreadSnapshotAndRecover(
      api,
      readiness,
      'thread-1',
      acceptSnapshot
    )

    expect(get).toHaveBeenCalledOnce()
    recoveryResponse.resolve(true)
    await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2))
    await Promise.all([opening, refreshing, sendGate])

    expect(recover).toHaveBeenCalledTimes(2)
    expect(accepted).toEqual([running, terminal])
  })

  it('leaves readiness invalid when recovery fails so the handshake can be retried', async () => {
    const readiness = new AgentSnapshotReadiness()
    const running = snapshot('running')
    const get = vi.fn().mockResolvedValue(running)
    const failure = new Error('Recovery unavailable')
    const recover = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(false)
    const acceptSnapshot = vi.fn()
    const api = {
      threads: { get },
      runs: { recover }
    }

    await expect(loadAgentThreadSnapshotAndRecover(
      api,
      readiness,
      'thread-1',
      acceptSnapshot,
      true
    )).rejects.toThrow(failure)
    await loadAgentThreadSnapshotAndRecover(
      api,
      readiness,
      'thread-1',
      acceptSnapshot
    )

    expect(get).toHaveBeenCalledTimes(2)
    expect(recover).toHaveBeenCalledTimes(2)
  })
})
