import { beforeEach, describe, expect, it } from 'vitest'
import {
  beginApplicationDataTransition,
  finishApplicationDataTransition,
  runApplicationDataOperation
} from './applicationDataLifecycle'

beforeEach(() => {
  finishApplicationDataTransition()
})

describe('application data lifecycle', () => {
  it('closes synchronously to new operations and drains every accepted operation', async () => {
    let release: (() => void) | undefined
    const active = runApplicationDataOperation(() => new Promise<void>((resolve) => {
      release = resolve
    }))

    let transitioned = false
    const transition = beginApplicationDataTransition().then(() => {
      transitioned = true
    })

    await expect(runApplicationDataOperation(async () => undefined)).rejects.toThrow(
      'Application data is unavailable'
    )
    expect(transitioned).toBe(false)

    release?.()
    await active
    await transition
    expect(transitioned).toBe(true)
  })

  it('reopens only after the transition finishes', async () => {
    await beginApplicationDataTransition()
    await expect(runApplicationDataOperation(async () => 'blocked')).rejects.toThrow(
      'Application data is unavailable'
    )

    finishApplicationDataTransition()
    await expect(runApplicationDataOperation(async () => 'ready')).resolves.toBe('ready')
  })
})
