import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentQueuedInput,
  AgentQueuedInputCreate,
  AgentRunDirectionInput,
  AgentRunDirectionReferenceInput,
  AgentRunSubmission,
  AgentRunSubmissionInput,
  AgentRuntimeEvent
} from '@shared/agentTypes'
import type { GaleApi, SelectedAttachment } from '@shared/types'
import { useQueuedAgentMessages, type QueuedAgentMessage } from './useQueuedAgentMessages'

function queued(id: string, status: AgentQueuedInput['status'] = 'queued'): AgentQueuedInput {
  return {
    id,
    threadId: 'thread-1',
    text: `Prompt ${id}`,
    displayText: `Message ${id}`,
    attachments: [],
    status,
    ...(status === 'failed' ? { error: 'Provider unavailable' } : {}),
    createdAt: `2026-08-30T00:00:0${id}.000Z`
  }
}

function runningSubmission(input: AgentRunSubmissionInput): AgentRunSubmission {
  return {
    thread: {
      id: input.threadId!,
      title: 'Thread',
      projectId: 'default',
      pinned: false,
      accessMode: 'read_only_allowed',
      status: 'running',
      userTurnCount: 1,
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z'
    },
    run: {
      id: `run-${input.requestId}`,
      threadId: input.threadId!,
      operation: 'agent',
      status: 'running',
      createdAt: '2026-08-30T00:00:00.000Z',
      updatedAt: '2026-08-30T00:00:00.000Z'
    }
  }
}

function installAgentApi(initial: AgentQueuedInput[] = []) {
  let eventListener: ((event: AgentRuntimeEvent) => void) | undefined
  let subscribed: (() => void | Promise<void>) | undefined
  let durable = [...initial]
  const submit = vi.fn(async (input: AgentRunSubmissionInput) => runningSubmission(input))
  const steer = vi.fn(async (_input: AgentRunDirectionInput) => true)
  const removeSteer = vi.fn(async (_input: AgentRunDirectionReferenceInput) => true)
  const list = vi.fn(async () => [...durable])
  const enqueue = vi.fn(async (input: AgentQueuedInputCreate): Promise<AgentQueuedInput> => {
    const item: AgentQueuedInput = {
      id: input.id,
      threadId: input.threadId,
      text: input.text,
      displayText: input.displayText ?? input.text,
      attachments: [],
      status: 'queued',
      createdAt: '2026-08-30T00:00:00.000Z'
    }
    durable = [...durable, item]
    return item
  })
  const remove = vi.fn(async (threadId: string, id: string) => {
    const previousLength = durable.length
    durable = durable.filter((item) => item.threadId !== threadId || item.id !== id)
    return durable.length !== previousLength
  })
  const markFailed = vi.fn(async (threadId: string, id: string, error: string): Promise<AgentQueuedInput> => {
    const failed = {
      ...(durable.find((item) => item.id === id) ?? queued(id)),
      threadId,
      status: 'failed' as const,
      error
    }
    durable = durable.map((item) => item.id === id ? failed : item)
    return failed
  })
  const retry = vi.fn(async (threadId: string, id: string): Promise<AgentQueuedInput> => {
    const retried = {
      ...(durable.find((item) => item.id === id) ?? queued(id)),
      threadId,
      status: 'queued' as const,
      error: undefined
    }
    durable = durable.map((item) => item.id === id ? retried : item)
    return retried
  })
  Object.defineProperty(window, 'gale', {
    configurable: true,
    value: {
      agent: {
        runs: { submit, steer, removeSteer },
        queuedInputs: { list, enqueue, remove, markFailed, retry },
        onEvent: vi.fn((
          listener: (event: AgentRuntimeEvent) => void,
          onSubscribed?: () => void | Promise<void>
        ) => {
          eventListener = listener
          subscribed = onSubscribed
          return () => undefined
        })
      }
    } as unknown as GaleApi
  })
  return {
    acknowledgeSubscription: async () => subscribed?.(),
    emit: (event: AgentRuntimeEvent) => eventListener?.(event),
    enqueue,
    list,
    markFailed,
    remove,
    removeSteer,
    retry,
    steer,
    submit
  }
}

const attachment: SelectedAttachment = {
  path: 'C:\\managed\\queued-direction.txt',
  name: 'queued-direction.txt',
  size: 12,
  kind: 'text',
  mimeType: 'text/plain',
  contextPolicy: 'one_turn'
}

function settled(
  runId: string,
  status: Extract<AgentRuntimeEvent, { type: 'run_settled' }>['status'] = 'completed'
): Extract<AgentRuntimeEvent, { type: 'run_settled' }> {
  return {
    type: 'run_settled',
    runId,
    threadId: 'thread-1',
    operation: 'agent',
    status
  }
}

describe('useQueuedAgentMessages', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('loads the durable queue and dispatches exactly one FIFO item per settled run', async () => {
    const api = installAgentApi([queued('1'), queued('2')])
    const readyThreadIds = new Set(['thread-1'])
    const onDispatchError = vi.fn()
    const { result } = renderHook(() => useQueuedAgentMessages({
      readyThreadIds,
      onDispatchError
    }))

    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(1))
    expect(api.submit.mock.calls[0][0]).toMatchObject({
      requestId: '1',
      threadId: 'thread-1',
      text: 'Prompt 1',
      displayText: 'Message 1'
    })
    await waitFor(() => expect(result.current.messagesByThread['thread-1']).toHaveLength(1))
    expect(api.submit).toHaveBeenCalledTimes(1)

    act(() => api.emit(settled('run-1')))
    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(2))
    expect(api.submit.mock.calls[1][0].requestId).toBe('2')
  })

  it('persists dispatch failure and retries only after the user requests it', async () => {
    const api = installAgentApi([queued('1')])
    api.submit.mockRejectedValueOnce(new Error('Provider unavailable'))
    const onDispatchError = vi.fn()
    const readyThreadIds = new Set(['thread-1'])
    const { result } = renderHook(() => useQueuedAgentMessages({
      readyThreadIds,
      onDispatchError
    }))

    await waitFor(() => expect(api.markFailed).toHaveBeenCalled())
    await waitFor(() => expect(result.current.messagesByThread['thread-1'][0].status).toBe('failed'))
    expect(api.submit).toHaveBeenCalledTimes(1)

    await act(async () => {
      await result.current.retry(result.current.messagesByThread['thread-1'][0])
    })
    await waitFor(() => expect(api.submit).toHaveBeenCalledTimes(2))
    expect(onDispatchError).toHaveBeenCalledWith('thread-1')
  })

  it('does not let an older queue refresh overwrite a newer local status', async () => {
    const failed = queued('1', 'failed')
    const api = installAgentApi([failed])
    const readyThreadIds = new Set<string>()
    const onDispatchError = vi.fn()
    const { result } = renderHook(() => useQueuedAgentMessages({
      readyThreadIds,
      onDispatchError
    }))
    await waitFor(() => expect(result.current.messagesByThread['thread-1']?.[0].status).toBe('failed'))
    api.list.mockResolvedValueOnce([queued('1')])

    act(() => api.emit(settled('run-previous')))

    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2))
    expect(result.current.messagesByThread['thread-1'][0].status).toBe('failed')
  })

  it('removes a locally stale item when an authoritative refresh no longer contains it', async () => {
    const api = installAgentApi([queued('1', 'failed')])
    const { result } = renderHook(() => useQueuedAgentMessages({
      readyThreadIds: new Set<string>(),
      onDispatchError: vi.fn()
    }))
    await waitFor(() => expect(result.current.messagesByThread['thread-1']).toHaveLength(1))
    api.list.mockResolvedValueOnce([])

    act(() => api.emit(settled('run-previous', 'interrupted')))

    await waitFor(() => expect(result.current.messagesByThread['thread-1']).toBeUndefined())
  })

  it('retries a stale refresh that overlaps a persisted local enqueue', async () => {
    const existing = queued('1', 'failed')
    const api = installAgentApi([existing])
    const { result } = renderHook(() => useQueuedAgentMessages({
      readyThreadIds: new Set<string>(),
      onDispatchError: vi.fn()
    }))
    await waitFor(() => expect(result.current.messagesByThread['thread-1']).toHaveLength(1))
    let resolveStale!: (items: AgentQueuedInput[]) => void
    const staleResponse = new Promise<AgentQueuedInput[]>((resolve) => {
      resolveStale = resolve
    })
    api.list.mockImplementationOnce(() => staleResponse)

    act(() => api.emit(settled('run-previous', 'interrupted')))
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2))
    await act(() => result.current.enqueue('thread-1', 'New durable input'))
    resolveStale([existing])

    await waitFor(() => {
      expect(api.list).toHaveBeenCalledTimes(3)
      expect(result.current.messagesByThread['thread-1']).toHaveLength(2)
      expect(result.current.messagesByThread['thread-1'].map((item) => item.text)).toEqual(expect.arrayContaining([
        existing.text,
        'New durable input'
      ]))
    })
  })

  it('clears stale run ownership before replaying active runs after synchronization', async () => {
    const api = installAgentApi([queued('1')])
    const onDispatchError = vi.fn()
    const { rerender } = renderHook(
      ({ readyThreadIds }) => useQueuedAgentMessages({ readyThreadIds, onDispatchError }),
      { initialProps: { readyThreadIds: new Set<string>() } }
    )
    await waitFor(() => expect(api.list).toHaveBeenCalledOnce())
    act(() => api.emit({
      type: 'run_started',
      run: runningSubmission({
        requestId: 'active-run',
        threadId: 'thread-1',
        text: 'Active'
      }).run,
      newUserTurn: false
    }))

    await act(() => api.acknowledgeSubscription())
    rerender({ readyThreadIds: new Set(['thread-1']) })

    await waitFor(() => expect(api.submit).toHaveBeenCalledOnce())
  })

  it('persists enqueue and preserves display text and attachments when steering', async () => {
    const api = installAgentApi()
    api.enqueue.mockImplementationOnce(async (input) => ({
      id: input.id,
      threadId: input.threadId,
      text: input.text,
      displayText: input.displayText ?? input.text,
      attachments: [attachment],
      status: 'queued',
      createdAt: '2026-08-30T00:00:00.000Z'
    }))
    const readyThreadIds = new Set<string>()
    const onDispatchError = vi.fn()
    const { result } = renderHook(() => useQueuedAgentMessages({
      readyThreadIds,
      onDispatchError
    }))
    let item: QueuedAgentMessage | undefined
    await act(async () => {
      item = await result.current.enqueue('thread-1', 'Expanded prompt', '/skill args', [attachment])
    })

    await act(async () => {
      await result.current.steer(item!, 'run-1')
    })
    expect(api.steer).toHaveBeenCalledWith(expect.objectContaining({
      runId: 'run-1',
      queuedInputId: item!.id,
      text: 'Expanded prompt',
      displayText: '/skill args',
      attachments: [expect.objectContaining({ name: attachment.name })]
    }))

    act(() => api.emit({
      type: 'direction_applied',
      runId: 'run-1',
      threadId: 'thread-1',
      queuedInputId: item!.id,
      message: {
        id: 'direction-message-1',
        role: 'user',
        content: [{ type: 'text', text: '/skill args' }]
      }
    }))
    expect(result.current.messagesByThread['thread-1']).toBeUndefined()
    expect(api.remove).not.toHaveBeenCalled()
  })

  it('returns an unapplied direction to the queue when the active execution is released', async () => {
    const api = installAgentApi()
    const readyThreadIds = new Set<string>()
    const onDispatchError = vi.fn()
    const { result } = renderHook(() => useQueuedAgentMessages({
      readyThreadIds,
      onDispatchError
    }))
    let item: QueuedAgentMessage | undefined
    await act(async () => {
      item = await result.current.enqueue('thread-1', 'Use this after the tool')
    })
    await act(async () => {
      await result.current.steer(item!, 'run-1')
    })
    expect(result.current.messagesByThread['thread-1'][0].status).toBe('direction_pending')

    act(() => api.emit({
      type: 'run_interrupted',
      run: {
        ...runningSubmission({ requestId: crypto.randomUUID(), threadId: 'thread-1', text: 'Start' }).run,
        id: 'run-1',
        status: 'interrupted'
      },
      interrupts: []
    }))
    act(() => api.emit({
      type: 'run_settled',
      runId: 'run-1',
      threadId: 'thread-1',
      operation: 'agent',
      status: 'interrupted'
    }))

    expect(result.current.messagesByThread['thread-1'][0]).toMatchObject({
      status: 'queued',
      targetRunId: undefined
    })
  })

  it('removes a pending direction from the runtime before deleting the durable input', async () => {
    const api = installAgentApi()
    const readyThreadIds = new Set<string>()
    const onDispatchError = vi.fn()
    const { result } = renderHook(() => useQueuedAgentMessages({
      readyThreadIds,
      onDispatchError
    }))
    let item: QueuedAgentMessage | undefined
    await act(async () => {
      item = await result.current.enqueue('thread-1', 'Discard this')
    })
    await act(async () => {
      await result.current.steer(item!, 'run-1')
    })
    const pending = result.current.messagesByThread['thread-1'][0]

    await act(async () => {
      await result.current.remove(pending)
    })
    expect(api.removeSteer).toHaveBeenCalledWith({
      threadId: 'thread-1',
      runId: 'run-1',
      queuedInputId: item!.id
    })
    expect(api.remove).toHaveBeenCalledWith('thread-1', item!.id)
  })
})
