import { describe, expect, it } from 'vitest'
import {
  createThreadErrorState,
  forgetThreadErrors,
  threadErrorFor,
  updateThreadError
} from './threadErrors'

describe('thread errors', () => {
  it('does not let a background thread failure overwrite the active thread', () => {
    let state = updateThreadError(createThreadErrorState(), 'thread-active', 'Active error')
    state = updateThreadError(state, 'thread-background', 'Background error')

    expect(threadErrorFor(state, 'thread-active')).toBe('Active error')
    expect(threadErrorFor(state, 'thread-background')).toBe('Background error')
  })

  it('keeps a new-thread draft error separate from persisted threads', () => {
    let state = updateThreadError(createThreadErrorState(), undefined, 'Draft error')
    state = updateThreadError(state, 'thread-1', 'Thread error')

    expect(threadErrorFor(state, undefined)).toBe('Draft error')
    expect(threadErrorFor(state, 'thread-1')).toBe('Thread error')
  })

  it('forgets only deleted thread errors', () => {
    let state = updateThreadError(createThreadErrorState(), 'thread-1', 'First')
    state = updateThreadError(state, 'thread-2', 'Second')

    state = forgetThreadErrors(state, ['thread-1'])

    expect(threadErrorFor(state, 'thread-1')).toBeUndefined()
    expect(threadErrorFor(state, 'thread-2')).toBe('Second')
  })
})
