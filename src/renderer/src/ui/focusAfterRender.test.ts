import { afterEach, describe, expect, it, vi } from 'vitest'
import { focusAfterRender } from './focusAfterRender'

describe('focusAfterRender', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('focuses the latest ref target after the next rendered frame', () => {
    let renderFrame: FrameRequestCallback | undefined
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      renderFrame = callback
      return 1
    })
    vi.stubGlobal('window', { requestAnimationFrame })
    const first = { focus: vi.fn() }
    const latest = { focus: vi.fn() }
    const targetRef = { current: first }

    focusAfterRender(targetRef)
    targetRef.current = latest

    expect(first.focus).not.toHaveBeenCalled()
    expect(latest.focus).not.toHaveBeenCalled()
    renderFrame?.(0)
    expect(latest.focus).toHaveBeenCalledWith({ preventScroll: true })
  })
})
