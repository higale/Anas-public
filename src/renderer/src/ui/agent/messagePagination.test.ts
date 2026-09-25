import { describe, expect, it } from 'vitest'
import {
  MessagePaginationCoordinator,
  isAbortError,
  runMessagePagination,
  throwIfAborted
} from './messagePagination'

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('MessagePaginationCoordinator', () => {
  it('invalidates a request when the active thread changes', () => {
    const coordinator = new MessagePaginationCoordinator()
    const panel = {} as HTMLElement
    const request = coordinator.begin('thread-1', panel)

    coordinator.invalidate()

    expect(request.signal.aborted).toBe(true)
    expect(request.isCurrent('thread-2', panel)).toBe(false)
  })

  it('requires the same panel instance before adjusting scroll', () => {
    const coordinator = new MessagePaginationCoordinator()
    const panel = {} as HTMLElement
    const request = coordinator.begin('thread-1', panel)

    expect(request.isCurrent('thread-1', panel)).toBe(true)
    expect(request.isCurrent('thread-1', {} as HTMLElement)).toBe(false)
  })

  it('aborts the previous generation when a newer request starts', () => {
    const coordinator = new MessagePaginationCoordinator()
    const panel = {} as HTMLElement
    const first = coordinator.begin('thread-1', panel)
    const second = coordinator.begin('thread-1', panel)

    expect(first.signal.aborted).toBe(true)
    expect(first.isCurrent('thread-1', panel)).toBe(false)
    expect(second.isCurrent('thread-1', panel)).toBe(true)
  })

  it('uses the platform abort error for cancelled request boundaries', () => {
    const controller = new AbortController()
    controller.abort()

    expect(() => throwIfAborted(controller.signal)).toThrowError(DOMException)
    try {
      throwIfAborted(controller.signal)
    } catch (reason) {
      expect(isAbortError(reason)).toBe(true)
    }
  })

  it('does not adjust a new thread panel after an older page resolves', async () => {
    const coordinator = new MessagePaginationCoordinator()
    const originalPanel = { scrollHeight: 800, scrollTop: 200 } as HTMLElement
    const nextPanel = { scrollHeight: 400, scrollTop: 40 } as HTMLElement
    let activeThreadId = 'thread-1'
    let activePanel = originalPanel
    const page = deferred()
    const request = coordinator.begin('thread-1', originalPanel)
    const loading = runMessagePagination({
      request,
      threadId: 'thread-1',
      panel: originalPanel,
      currentThreadId: () => activeThreadId,
      currentPanel: () => activePanel,
      load: () => page.promise,
      onError: () => undefined,
      fallbackError: 'Failed',
      schedule: (callback) => callback()
    })

    activeThreadId = 'thread-2'
    activePanel = nextPanel
    page.resolve()
    await loading

    expect(nextPanel.scrollTop).toBe(40)
    expect(originalPanel.scrollTop).toBe(200)
  })

  it('routes a page failure back to its originating thread', async () => {
    const coordinator = new MessagePaginationCoordinator()
    const panel = { scrollHeight: 800, scrollTop: 200 } as HTMLElement
    const errors: Array<[string, string]> = []
    const request = coordinator.begin('thread-1', panel)

    await runMessagePagination({
      request,
      threadId: 'thread-1',
      panel,
      currentThreadId: () => 'thread-1',
      currentPanel: () => panel,
      load: async () => { throw new Error('Page unavailable') },
      onError: (threadId, error) => errors.push([threadId, error]),
      fallbackError: 'Failed',
      schedule: (callback) => callback()
    })

    expect(errors).toEqual([['thread-1', 'Failed']])
  })
})
