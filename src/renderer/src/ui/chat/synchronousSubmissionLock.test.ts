import { describe, expect, it, vi } from 'vitest'
import { SynchronousSubmissionLock } from './synchronousSubmissionLock'

describe('synchronous composer submission lock', () => {
  it('admits only one synchronous Enter, click, or form submission race', async () => {
    const lock = new SynchronousSubmissionLock()
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    const submit = vi.fn(() => pending)

    const enter = lock.run(submit)
    const click = lock.run(submit)
    const form = lock.run(submit)

    expect(lock.locked).toBe(true)
    expect(submit).toHaveBeenCalledOnce()
    await expect(Promise.all([click, form])).resolves.toEqual([undefined, undefined])
    release()
    await enter
    expect(lock.locked).toBe(false)
  })

  it('releases immediately after failure so the next submission can retry', async () => {
    const lock = new SynchronousSubmissionLock()
    const submit = vi.fn()
      .mockRejectedValueOnce(new Error('failed'))
      .mockResolvedValueOnce('retried')

    await expect(lock.run(submit)).rejects.toThrow('failed')
    await expect(lock.run(submit)).resolves.toBe('retried')
    expect(submit).toHaveBeenCalledTimes(2)
  })
})
