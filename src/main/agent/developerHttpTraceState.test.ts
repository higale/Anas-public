import { afterEach, describe, expect, it } from 'vitest'
import {
  isDeveloperHttpTraceEnabled,
  setDeveloperHttpTraceEnabled
} from './developerHttpTraceState'

afterEach(() => {
  setDeveloperHttpTraceEnabled(false)
})

describe('developer HTTP trace session state', () => {
  it('defaults to disabled', () => {
    expect(isDeveloperHttpTraceEnabled()).toBe(false)
  })

  it('keeps the switch in process memory and validates updates', () => {
    expect(setDeveloperHttpTraceEnabled(true)).toBe(true)
    expect(isDeveloperHttpTraceEnabled()).toBe(true)
    expect(() => setDeveloperHttpTraceEnabled('true')).toThrow('Invalid developer HTTP trace state.')
  })
})
