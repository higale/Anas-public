import { describe, expect, it, vi } from 'vitest'
import type {
  AgentEventEnvelope,
  AgentEventSubscription,
  AgentEventSubscriptionRequest,
  AgentRun,
  AgentRuntimeEvent
} from '@shared/agentTypes'
import { subscribeAgentRuntimeEvents } from './agentEventSubscription'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function run(status: AgentRun['status'] = 'running', id = 'run-1'): AgentRun {
  return {
    id,
    threadId: 'thread-1',
    operation: 'agent',
    status,
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:00.000Z'
  }
}

function startedEvent(): AgentRuntimeEvent {
  return { type: 'run_started', run: run(), newUserTurn: false }
}

function deltaEvent(text: string): AgentRuntimeEvent {
  return {
    type: 'model_delta',
    runId: 'run-1',
    threadId: 'thread-1',
    modelId: 'model-1',
    delta: { type: 'text', text }
  }
}

function envelope(
  revision: number,
  event: AgentRuntimeEvent,
  replayActive = event.type !== 'run_completed'
    && event.type !== 'run_interrupted'
    && event.type !== 'run_recovery_failed'
    && event.type !== 'run_failed'
    && event.type !== 'run_cancelled'
): AgentEventEnvelope {
  return { revision, event, replayActive }
}

class FakeAgentEventIpc {
  readonly invoke = vi.fn<(
    channel: string,
    request: AgentEventSubscriptionRequest
  ) => Promise<unknown>>()
  readonly on = vi.fn((
    _channel: string,
    listener: (event: unknown, envelope: AgentEventEnvelope) => void
  ) => {
    this.listener = listener
  })
  readonly removeListener = vi.fn()
  private listener?: (event: unknown, envelope: AgentEventEnvelope) => void

  emit(value: AgentEventEnvelope): void {
    this.listener?.({}, value)
  }
}

describe('preload Agent event subscription', () => {
  it('compacts argument progress after receipt continuity is checked, including live subscription races', async () => {
    const ipc = new FakeAgentEventIpc()
    const response = deferred<AgentEventSubscription>()
    ipc.invoke.mockReturnValue(response.promise)
    const received: AgentRuntimeEvent[] = []
    const unsubscribe = subscribeAgentRuntimeEvents(ipc, (event) => received.push(event))
    await vi.waitFor(() => expect(ipc.invoke).toHaveBeenCalledTimes(1))
    const preview = (text: string): AgentRuntimeEvent => ({
      type: 'model_tool_calls', runId: 'run-1', threadId: 'thread-1', modelId: 'model-1',
      progress: [{ index: 0, name: 'apply_patch', characterCount: text.length, complete: false }]
    })
    ipc.emit(envelope(2, preview('a')))
    ipc.emit(envelope(3, preview('ab')))
    response.resolve({ revision: 1, replay: [envelope(1, startedEvent())], replayComplete: true })
    await vi.waitFor(() => expect(received).toContainEqual(preview('ab')))
    ipc.emit(envelope(4, preview('abc')))
    const late: AgentRuntimeEvent[] = []
    const unsubscribeLate = subscribeAgentRuntimeEvents(ipc, (event) => late.push(event))
    await vi.waitFor(() => expect(late).toContainEqual(preview('abc')))
    expect(late.filter((event) => event.type === 'model_tool_calls')).toHaveLength(1)
    expect(ipc.invoke).toHaveBeenCalledTimes(1)
    unsubscribeLate()
    unsubscribe()
  })

  it('replays pre-subscription and synchronization events to every local listener', async () => {
    const ipc = new FakeAgentEventIpc()
    const subscription = deferred<AgentEventSubscription>()
    ipc.invoke.mockReturnValue(subscription.promise)
    const firstSync = deferred<void>()
    const secondSync = deferred<void>()
    const firstReceived: string[] = []
    const secondReceived: string[] = []
    const beforeSubscription = envelope(1, startedEvent())

    subscribeAgentRuntimeEvents(
      ipc,
      (event) => firstReceived.push(event.type),
      {
        synchronize: async () => {
          firstReceived.push('synchronized')
          await firstSync.promise
        }
      }
    )

    await vi.waitFor(() => expect(ipc.invoke).toHaveBeenCalledOnce())
    ipc.emit(envelope(2, deltaEvent('before acknowledgement')))
    subscription.resolve({
      revision: 1,
      replay: [beforeSubscription],
      replayComplete: true
    })
    await vi.waitFor(() => expect(firstReceived).toEqual(['synchronized']))

    subscribeAgentRuntimeEvents(
      ipc,
      (event) => secondReceived.push(event.type),
      {
        synchronize: async () => {
          secondReceived.push('synchronized')
          await secondSync.promise
        }
      }
    )
    await vi.waitFor(() => expect(secondReceived).toEqual(['synchronized']))
    ipc.emit(envelope(3, deltaEvent('during synchronization')))

    firstSync.resolve()
    secondSync.resolve()
    await vi.waitFor(() => {
      expect(firstReceived).toEqual([
        'synchronized',
        'run_started',
        'model_delta',
        'model_delta'
      ])
      expect(secondReceived).toEqual(firstReceived)
    })
    expect(ipc.on).toHaveBeenCalledOnce()
    expect(ipc.invoke).toHaveBeenCalledOnce()

    const lateReceived: string[] = []
    subscribeAgentRuntimeEvents(
      ipc,
      (event) => lateReceived.push(event.type),
      { synchronize: () => { lateReceived.push('synchronized') } }
    )
    await vi.waitFor(() => expect(lateReceived).toEqual([
      'synchronized',
      'run_started',
      'model_delta',
      'model_delta'
    ]))

    ipc.emit(envelope(4, {
      type: 'run_completed',
      run: run('completed')
    }))
    const afterTerminal: string[] = []
    subscribeAgentRuntimeEvents(
      ipc,
      (event) => afterTerminal.push(event.type),
      { synchronize: () => { afterTerminal.push('synchronized') } }
    )
    await vi.waitFor(() => expect(afterTerminal).toEqual(['synchronized']))
  })

  it('repairs a live revision gap before delivering later events', async () => {
    const ipc = new FakeAgentEventIpc()
    const missing = envelope(2, deltaEvent('missing'))
    const later = envelope(3, deltaEvent('later'))
    ipc.invoke
      .mockResolvedValueOnce({ revision: 0, replay: [], replayComplete: true })
      .mockResolvedValueOnce({
        revision: 3,
        replay: [missing, later],
        replayComplete: true
      })
    const synchronize = vi.fn(async () => undefined)
    const received: string[] = []
    subscribeAgentRuntimeEvents(
      ipc,
      (event) => received.push(event.type === 'model_delta' ? event.delta.text : event.type),
      { synchronize }
    )
    await vi.waitFor(() => expect(synchronize).toHaveBeenCalledOnce())

    ipc.emit(envelope(1, startedEvent()))
    ipc.emit(later)

    await vi.waitFor(() => {
      expect(ipc.invoke).toHaveBeenCalledTimes(2)
      expect(synchronize).toHaveBeenCalledTimes(2)
      expect(received).toEqual(['run_started', 'missing', 'later'])
    })
    expect(ipc.invoke).toHaveBeenNthCalledWith(2, 'agent:events:subscribe', {
      afterRevision: 1
    })
  })

  it('does not let older active replay overwrite a live terminal state during subscription', async () => {
    const ipc = new FakeAgentEventIpc()
    const subscription = deferred<AgentEventSubscription>()
    ipc.invoke.mockReturnValue(subscription.promise)
    const received: string[] = []
    subscribeAgentRuntimeEvents(
      ipc,
      (event) => received.push(event.type),
      { synchronize: () => { received.push('synchronized') } }
    )
    await vi.waitFor(() => expect(ipc.invoke).toHaveBeenCalledOnce())

    ipc.emit(envelope(2, {
      type: 'run_completed',
      run: run('completed')
    }))
    subscription.resolve({
      revision: 1,
      replay: [envelope(1, startedEvent())],
      replayComplete: true
    })
    await vi.waitFor(() => expect(received).toEqual([
      'synchronized',
      'run_started',
      'run_completed'
    ]))

    const lateReceived: string[] = []
    subscribeAgentRuntimeEvents(
      ipc,
      (event) => lateReceived.push(event.type),
      { synchronize: () => { lateReceived.push('synchronized') } }
    )
    await vi.waitFor(() => expect(lateReceived).toEqual(['synchronized']))
  })

  it('does not let older terminal replay overwrite a live active state during subscription', async () => {
    const ipc = new FakeAgentEventIpc()
    const subscription = deferred<AgentEventSubscription>()
    ipc.invoke.mockReturnValue(subscription.promise)
    const received: string[] = []
    subscribeAgentRuntimeEvents(
      ipc,
      (event) => received.push(event.type),
      { synchronize: () => { received.push('synchronized') } }
    )
    await vi.waitFor(() => expect(ipc.invoke).toHaveBeenCalledOnce())

    ipc.emit(envelope(2, startedEvent()))
    subscription.resolve({
      revision: 1,
      replay: [envelope(1, {
        type: 'run_interrupted',
        run: run('interrupted'),
        interrupts: []
      })],
      replayComplete: true
    })
    await vi.waitFor(() => expect(received).toEqual([
      'synchronized',
      'run_interrupted',
      'run_started'
    ]))

    const lateReceived: string[] = []
    subscribeAgentRuntimeEvents(
      ipc,
      (event) => lateReceived.push(event.type),
      { synchronize: () => { lateReceived.push('synchronized') } }
    )
    await vi.waitFor(() => expect(lateReceived).toEqual([
      'synchronized',
      'run_interrupted',
      'run_started'
    ]))
  })

  it('reports a failed subscription and retries it', async () => {
    const ipc = new FakeAgentEventIpc()
    ipc.invoke
      .mockRejectedValueOnce(new Error('main process unavailable'))
      .mockResolvedValueOnce({ revision: 0, replay: [], replayComplete: true })
    const synchronize = vi.fn(async () => undefined)
    const errors: string[] = []

    subscribeAgentRuntimeEvents(ipc, vi.fn(), {
      synchronize,
      onError: (message) => errors.push(message)
    })

    await vi.waitFor(() => expect(errors).toEqual(['main process unavailable']))
    await vi.waitFor(() => {
      expect(ipc.invoke).toHaveBeenCalledTimes(2)
      expect(synchronize).toHaveBeenCalledOnce()
    }, { timeout: 1_000 })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(ipc.invoke).toHaveBeenCalledTimes(2)
    expect(ipc.on).toHaveBeenCalledOnce()
  })

  it('retains an interrupted parent replay until its last nested subagent settles', async () => {
    const ipc = new FakeAgentEventIpc()
    const parent = {
      id: 'subagent-parent',
      name: 'parent',
      sequence: 1,
      status: 'running' as const
    }
    const nested = {
      id: 'subagent-nested',
      name: 'nested',
      sequence: 2,
      status: 'running' as const,
      parentSubagentId: parent.id
    }
    const replay = [
      envelope(1, startedEvent()),
      envelope(2, {
        type: 'subagent_updated',
        runId: 'run-1',
        threadId: 'thread-1',
        subagent: parent
      }),
      envelope(3, {
        type: 'run_interrupted',
        run: run('interrupted'),
        interrupts: []
      }, true),
      envelope(4, {
        type: 'subagent_updated',
        runId: 'run-1',
        threadId: 'thread-1',
        subagent: nested
      })
    ]
    ipc.invoke.mockResolvedValue({ revision: 4, replay, replayComplete: true })

    const firstReceived: string[] = []
    subscribeAgentRuntimeEvents(
      ipc,
      (event) => firstReceived.push(event.type),
      { synchronize: () => { firstReceived.push('synchronized') } }
    )
    await vi.waitFor(() => expect(firstReceived).toEqual([
      'synchronized',
      'run_started',
      'subagent_updated',
      'run_interrupted',
      'subagent_updated'
    ]))

    const whileInterrupted: string[] = []
    subscribeAgentRuntimeEvents(
      ipc,
      (event) => whileInterrupted.push(event.type),
      { synchronize: () => { whileInterrupted.push('synchronized') } }
    )
    await vi.waitFor(() => expect(whileInterrupted).toEqual(firstReceived))

    ipc.emit(envelope(5, {
      type: 'subagent_updated',
      runId: 'run-1',
      threadId: 'thread-1',
      subagent: { ...parent, status: 'completed' }
    }, true))
    const whileNestedRuns: string[] = []
    subscribeAgentRuntimeEvents(
      ipc,
      (event) => whileNestedRuns.push(event.type),
      { synchronize: () => { whileNestedRuns.push('synchronized') } }
    )
    await vi.waitFor(() => expect(whileNestedRuns).toContain('run_started'))

    ipc.emit(envelope(6, {
      type: 'subagent_updated',
      runId: 'run-1',
      threadId: 'thread-1',
      subagent: { ...nested, status: 'completed' }
    }, false))
    const afterNestedSettles: string[] = []
    subscribeAgentRuntimeEvents(
      ipc,
      (event) => afterNestedSettles.push(event.type),
      { synchronize: () => { afterNestedSettles.push('synchronized') } }
    )
    await vi.waitFor(() => expect(afterNestedSettles).toEqual(['synchronized']))
  })

  it('does not let a failed consumer retain terminal history needed by healthy consumers', async () => {
    const ipc = new FakeAgentEventIpc()
    ipc.invoke.mockResolvedValue({ revision: 0, replay: [], replayComplete: true })
    const healthyReceived: string[] = []
    const disposeHealthy = subscribeAgentRuntimeEvents(
      ipc,
      (event) => healthyReceived.push(event.type),
      { synchronize: () => { healthyReceived.push('synchronized') } }
    )
    await vi.waitFor(() => expect(healthyReceived).toEqual(['synchronized']))

    const errors: string[] = []
    const disposeFailed = subscribeAgentRuntimeEvents(ipc, vi.fn(), {
      synchronize: async () => { throw new Error('snapshot unavailable') },
      onError: (message) => errors.push(message)
    })
    await vi.waitFor(() => expect(errors).toEqual(['snapshot unavailable']))

    ipc.emit(envelope(1, {
      type: 'run_started',
      run: run('running', 'run-2'),
      newUserTurn: false
    }))
    ipc.emit(envelope(2, {
      type: 'run_completed',
      run: run('completed', 'run-2')
    }))
    ipc.emit(envelope(3, {
      type: 'run_started',
      run: run('running', 'run-3'),
      newUserTurn: false
    }))
    ipc.emit(envelope(4, {
      type: 'run_failed',
      run: run('failed', 'run-3'),
      error: 'failed'
    }))
    expect(healthyReceived).toEqual([
      'synchronized',
      'run_started',
      'run_completed',
      'run_started',
      'run_failed'
    ])

    const lateReceived: string[] = []
    const disposeLate = subscribeAgentRuntimeEvents(
      ipc,
      (event) => lateReceived.push(event.type),
      { synchronize: () => { lateReceived.push('synchronized') } }
    )
    await vi.waitFor(() => expect(lateReceived).toEqual(['synchronized']))

    disposeLate()
    disposeFailed()
    disposeHealthy()
  })
})
