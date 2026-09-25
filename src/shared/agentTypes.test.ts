import { describe, expect, it } from 'vitest'
import { isAgentThreadLocked } from './agentTypes'

describe('agent thread lock state', () => {
  it.each([
    ['idle', false],
    ['failed', false],
    ['running', true],
    ['interrupted', true]
  ] as const)('maps %s to locked=%s', (status, locked) => {
    expect(isAgentThreadLocked(status)).toBe(locked)
  })
})
