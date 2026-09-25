import { describe, expect, it, vi } from 'vitest'
import { AgentSnapshotReadiness } from './agentSnapshotReadiness'

function deferred(): {
  promise: Promise<void>
  resolve(): void
  reject(reason: unknown): void
} {
  let resolve!: () => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('AgentSnapshotReadiness', () => {
  it('holds send readiness behind the in-flight open snapshot load', async () => {
    const readiness = new AgentSnapshotReadiness()
    const snapshot = deferred()
    const loader = vi.fn(() => snapshot.promise)
    const order: string[] = []

    const opening = readiness.load('thread-1', async () => {
      readiness.markProjectionReady('thread-1')
      await loader()
      order.push('snapshot')
    }, true)
    const sending = readiness.load('thread-1', async () => {
      order.push('unexpected-second-load')
    }).then(() => order.push('start'))

    await Promise.resolve()
    expect(loader).toHaveBeenCalledOnce()
    expect(order).toEqual([])

    snapshot.resolve()
    await Promise.all([opening, sending])
    expect(order).toEqual(['snapshot', 'start'])
  })

  it('invalidates an older response on run start while keeping a ready projection ready', async () => {
    const readiness = new AgentSnapshotReadiness()
    readiness.markReady('thread-1')
    const earlierResponse = readiness.guard('thread-1')
    const response = deferred()
    const accepted: string[] = []
    const reload = vi.fn(async () => {})
    const loadingEarlier = (async () => {
      await response.promise
      if (earlierResponse.isCurrent()) accepted.push('stale-load-earlier')
    })()

    readiness.markProjected('thread-1')
    accepted.push('run-started')
    response.resolve()
    await loadingEarlier

    expect(earlierResponse.isCurrent()).toBe(false)
    expect(accepted).toEqual(['run-started'])
    await readiness.load('thread-1', reload)
    expect(reload).not.toHaveBeenCalled()
  })

  it('queues one latest refresh and makes every waiter follow its generation', async () => {
    const readiness = new AgentSnapshotReadiness()
    const initial = deferred()
    const latest = deferred()
    const calls: string[] = []
    const settled: string[] = []

    const opening = readiness.load('thread-1', async () => {
      calls.push('initial')
      await initial.promise
    }, true).then(() => settled.push('opening'))
    const supersededRefresh = readiness.load('thread-1', async () => {
      calls.push('superseded-refresh')
    }, true).then(() => settled.push('superseded-refresh'))
    const latestRefresh = readiness.load('thread-1', async () => {
      calls.push('latest-refresh')
      await latest.promise
    }, true).then(() => settled.push('latest-refresh'))
    const sendGate = readiness.load('thread-1', async () => {
      calls.push('unexpected-send-load')
    }).then(() => settled.push('send'))

    expect(calls).toEqual(['initial'])
    initial.resolve()
    await vi.waitFor(() => expect(calls).toEqual(['initial', 'latest-refresh']))
    expect(settled).toEqual([])

    latest.resolve()
    await Promise.all([opening, supersededRefresh, latestRefresh, sendGate])
    expect(settled).toEqual(expect.arrayContaining([
      'opening',
      'superseded-refresh',
      'latest-refresh',
      'send'
    ]))
    expect(calls).toEqual(['initial', 'latest-refresh'])
  })

  it('prevents an obsolete loader from committing after an authoritative snapshot', async () => {
    const readiness = new AgentSnapshotReadiness()
    const response = deferred()
    const accepted: string[] = []

    const loading = readiness.load('thread-1', async ({ isCurrent }) => {
      await response.promise
      if (isCurrent()) accepted.push('obsolete-baseline')
    }, true)
    readiness.markReady('thread-1')
    accepted.push('terminal-event')

    response.resolve()
    await loading
    await readiness.load('thread-1', async () => {
      accepted.push('unexpected-reload')
    })

    expect(accepted).toEqual(['terminal-event'])
  })

  it('does not reload a ready snapshot unless an explicit refresh is requested', async () => {
    const readiness = new AgentSnapshotReadiness()
    const loader = vi.fn(async () => {})
    readiness.markReady('thread-1')

    await readiness.load('thread-1', loader)
    await readiness.load('thread-1', loader, true)

    expect(loader).toHaveBeenCalledOnce()
  })

  it('requires a new snapshot after the current projection is invalidated', async () => {
    const readiness = new AgentSnapshotReadiness()
    const loader = vi.fn(async () => {})
    readiness.markReady('thread-1')
    readiness.markNotReady('thread-1')

    await readiness.load('thread-1', loader)

    expect(loader).toHaveBeenCalledOnce()
  })

  it('allows a failed current-generation load to be retried', async () => {
    const readiness = new AgentSnapshotReadiness()
    const failure = new Error('Snapshot unavailable')
    await expect(readiness.load('thread-1', async () => {
      throw failure
    })).rejects.toThrow(failure)
    const retry = vi.fn(async () => {})

    await readiness.load('thread-1', retry)

    expect(retry).toHaveBeenCalledOnce()
  })

  it('does not let a forgotten in-flight load recreate readiness', async () => {
    const readiness = new AgentSnapshotReadiness()
    const response = deferred()
    const staleAccept = vi.fn()
    const loading = readiness.load('thread-1', async ({ isCurrent }) => {
      await response.promise
      if (isCurrent()) staleAccept()
    }, true)

    readiness.forget('thread-1')
    response.resolve()
    await loading

    const freshLoad = vi.fn(async () => {})
    await readiness.load('thread-1', freshLoad)
    expect(staleAccept).not.toHaveBeenCalled()
    expect(freshLoad).toHaveBeenCalledOnce()
  })
})
