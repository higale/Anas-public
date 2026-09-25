import { describe, expect, it, vi } from 'vitest'
import { QueuedAutosave } from './useQueuedAutosave'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('QueuedAutosave', () => {
  it('makes an in-flight valid save stale when a later edit is invalid or empty', async () => {
    const autosave = new QueuedAutosave()
    const pending = deferred<void>()
    const valid = autosave.revise('model:stable-id')
    const applied = vi.fn()
    const save = autosave.enqueue(valid, async (request) => {
      await pending.promise
      if (request.isCurrent()) applied()
    })

    const invalid = autosave.revise('model:stable-id')
    expect(invalid.revision).toBe(valid.revision + 1)
    pending.resolve()
    await save

    expect(applied).not.toHaveBeenCalled()
    expect(autosave.isCurrent(invalid)).toBe(true)
  })

  it('isolates an old response after switching to another stable entity', async () => {
    const autosave = new QueuedAutosave()
    const pending = deferred<void>()
    const modelA = autosave.revise('model:a')
    const save = autosave.enqueue(modelA, async (request) => {
      await pending.promise
      expect(request.entityId).toBe('model:a')
      expect(request.isCurrent()).toBe(false)
    })

    const modelB = autosave.revise('model:b')
    pending.resolve()
    await save

    expect(autosave.isCurrent(modelA)).toBe(false)
    expect(autosave.isCurrent(modelB)).toBe(true)
  })

  it('serializes writes while exposing the revision and entity on every request', async () => {
    const autosave = new QueuedAutosave()
    const firstPending = deferred<void>()
    const order: string[] = []
    const first = autosave.revise('skill:old-name')
    const firstSave = autosave.enqueue(first, async (request) => {
      order.push(`${request.entityId}:${request.revision}:start`)
      await firstPending.promise
      order.push(`${request.entityId}:${request.revision}:end`)
    })
    const second = autosave.revise('skill:old-name')
    const secondSave = autosave.enqueue(second, async (request) => {
      order.push(`${request.entityId}:${request.revision}:start`)
    })

    await vi.waitFor(() => {
      expect(order).toEqual([`skill:old-name:${first.revision}:start`])
    })
    firstPending.resolve()
    await Promise.all([firstSave, secondSave])
    expect(order).toEqual([
      `skill:old-name:${first.revision}:start`,
      `skill:old-name:${first.revision}:end`,
      `skill:old-name:${second.revision}:start`
    ])
  })
})
