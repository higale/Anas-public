import { describe, expect, it, vi } from 'vitest'
import { ChangeReadLane } from './changeReadLane'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('Git view read lifecycle', () => {
  it('aborts superseded reads, waits for cleanup, and skips obsolete queued views', async () => {
    const reader = new ChangeReadLane(), cleanup = deferred<string>()
    let firstSignal!: AbortSignal
    const first = reader.read('first', async (signal) => { firstSignal = signal; return cleanup.promise })
    await Promise.resolve()
    const obsoleteQuery = vi.fn(async () => 'obsolete')
    const obsolete = reader.read('obsolete', obsoleteQuery).catch((error: unknown) => error)
    const latestQuery = vi.fn(async () => 'latest')
    const latest = reader.read('latest', latestQuery)
    expect(firstSignal.aborted).toBe(true)
    expect(latestQuery).not.toHaveBeenCalled()
    cleanup.resolve('closed')
    await first
    expect(await obsolete).toBeInstanceOf(DOMException)
    expect(obsoleteQuery).not.toHaveBeenCalled()
    expect(await latest).toBe('latest')
  })

  it('only cancels the matching request and cancels pending work on disposal', async () => {
    const reader = new ChangeReadLane(), finish = deferred<string>()
    let signal!: AbortSignal
    const read = reader.read('current', async (value) => { signal = value; return finish.promise })
    await Promise.resolve()
    reader.cancel('old')
    expect(signal.aborted).toBe(false)
    reader.cancel('current')
    expect(signal.aborted).toBe(true)
    finish.resolve('closed')
    await read
    const pending = reader.read('next', async () => 'unexpected').catch((error: unknown) => error)
    reader.dispose()
    expect(await pending).toBeInstanceOf(DOMException)
  })
})
