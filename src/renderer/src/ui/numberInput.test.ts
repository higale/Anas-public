import { describe, expect, it } from 'vitest'
import { clampIntegerInput } from './numberInput'

describe('integer input', () => {
  it('maps an empty optional limit to zero', () => {
    expect(clampIntegerInput('', 0, 9999)).toBe(0)
  })
})
