import { describe, expect, it } from 'vitest'
import { shouldHandleSpeechEvent } from './speechEventRouting'

describe('speech event routing', () => {
  it('rejects every thread event while the new-thread view is active', () => {
    expect(shouldHandleSpeechEvent(undefined, 'thread-background')).toBe(false)
  })

  it('accepts only the active thread', () => {
    expect(shouldHandleSpeechEvent('thread-active', 'thread-active')).toBe(true)
    expect(shouldHandleSpeechEvent('thread-active', 'thread-background')).toBe(false)
  })
})
