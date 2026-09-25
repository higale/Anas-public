import { describe, expect, it } from 'vitest'
import { withApplicationDataMutation, withApplicationDataSnapshot } from './applicationDataSnapshot'

function gate() {
  let release!: () => void
  return { promise: new Promise<void>(resolve => { release = resolve }), release: () => release() }
}

describe('application data snapshot boundary', () => {
  it('waits for accepted mutations and queues new mutations until the snapshot finishes', async () => {
    const first = gate(), copying = gate(), entered = gate()
    const order: string[] = []
    const mutation = withApplicationDataMutation(async () => { order.push('mutation'); await first.promise })
    const snapshot = withApplicationDataSnapshot(async () => { order.push('snapshot'); entered.release(); await copying.promise })
    const next = withApplicationDataMutation(() => { order.push('next') })
    expect(order).toEqual(['mutation'])
    first.release()
    await mutation
    await entered.promise
    expect(order).toEqual(['mutation', 'snapshot'])
    copying.release()
    await Promise.all([snapshot, next])
    expect(order).toEqual(['mutation', 'snapshot', 'next'])
  })

  it('lets nested cleanup finish while a snapshot is waiting for its owner', async () => {
    const pending = gate(), entered = gate()
    const mutation = withApplicationDataMutation(async () => {
      await pending.promise
      await withApplicationDataMutation(() => { entered.release() })
    })
    const snapshot = withApplicationDataSnapshot(() => 'copied')
    pending.release()
    await entered.promise
    await mutation
    await expect(snapshot).resolves.toBe('copied')
  })

  it('tracks detached cleanup independently of the finished owner operation', async () => {
    const pending = gate()
    let cleanup!: Promise<void>
    await withApplicationDataMutation(() => {
      cleanup = withApplicationDataMutation(() => pending.promise)
    })
    let copied = false
    const snapshot = withApplicationDataSnapshot(() => { copied = true })
    await Promise.resolve()
    expect(copied).toBe(false)
    pending.release()
    await Promise.all([cleanup, snapshot])
    expect(copied).toBe(true)
  })

  it('waits for nested cleanup admitted after the snapshot requested its boundary', async () => {
    const admitted = gate(), pending = gate()
    let cleanup!: Promise<void>
    const owner = withApplicationDataMutation(async () => {
      await admitted.promise
      cleanup = withApplicationDataMutation(() => pending.promise)
    })
    let copied = false
    const snapshot = withApplicationDataSnapshot(() => { copied = true })
    admitted.release()
    await owner
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(copied).toBe(false)
    pending.release()
    await Promise.all([cleanup, snapshot])
    expect(copied).toBe(true)
  })

  it('releases queued operations when copying fails and supports nested snapshot helpers', async () => {
    const copied = withApplicationDataSnapshot(async () => {
      expect(await withApplicationDataSnapshot(() => 'nested')).toBe('nested')
      throw new Error('Disk full')
    })
    const next = withApplicationDataMutation(() => 'usable')
    await expect(copied).rejects.toThrow('Disk full')
    await expect(next).resolves.toBe('usable')
  })
})
