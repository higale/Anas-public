import { describe, expect, it } from 'vitest'
import {
  followOutputPosition,
  isNearScrollBottom,
  observeFollowOutputGrowth,
  scrollToFollowOutput,
  updateFollowOutputAfterScroll
} from './followOutput'
import {
  scrollBoundaryState,
  shouldShowScrollBoundaryControls
} from './ScrollBoundaryNavigation'

function scrollPanel(values?: Partial<HTMLElement>): HTMLElement {
  return {
    clientHeight: 300,
    scrollHeight: 600,
    scrollTop: 300,
    ...values
  } as HTMLElement
}

function setScrollHeight(panel: HTMLElement, value: number): void {
  Object.defineProperty(panel, 'scrollHeight', {
    configurable: true,
    value
  })
}

describe('follow output', () => {
  it('reports the exact navigation boundaries independently from the follow threshold', () => {
    expect(scrollBoundaryState(scrollPanel({ scrollTop: 0 }))).toEqual({
      atBottom: false,
      atTop: true,
      hasOverflow: true
    })
    expect(scrollBoundaryState(scrollPanel({ scrollTop: 150 }))).toEqual({
      atBottom: false,
      atTop: false,
      hasOverflow: true
    })
    expect(scrollBoundaryState(scrollPanel())).toEqual({
      atBottom: true,
      atTop: false,
      hasOverflow: true
    })
    expect(scrollBoundaryState(scrollPanel({ scrollHeight: 300, scrollTop: 0 }))).toEqual({
      atBottom: true,
      atTop: true,
      hasOverflow: false
    })
  })

  it('hides all navigation controls after returning to the bottom', () => {
    expect(shouldShowScrollBoundaryControls(true, {
      atBottom: true,
      atTop: false,
      hasOverflow: true
    })).toBe(false)
    expect(shouldShowScrollBoundaryControls(true, {
      atBottom: false,
      atTop: false,
      hasOverflow: true
    })).toBe(true)
  })

  it('tracks whether the viewport remains near the bottom', () => {
    expect(isNearScrollBottom(scrollPanel({ scrollTop: 205 }))).toBe(true)
    expect(isNearScrollBottom(scrollPanel({ scrollTop: 204 }))).toBe(false)
  })

  it('applies data-driven output updates only while following', () => {
    const panel = scrollPanel({ scrollHeight: 900, scrollTop: 250 })
    const followOutput = { current: true }

    expect(scrollToFollowOutput(panel, followOutput)).toBe(true)
    expect(panel.scrollTop).toBe(900)

    followOutput.current = false
    panel.scrollTop = 250
    expect(scrollToFollowOutput(panel, followOutput)).toBe(false)
    expect(panel.scrollTop).toBe(250)
  })

  it('does not mistake content growth for the user leaving the bottom', () => {
    const followOutput = { current: true }
    const panel = scrollPanel({ scrollHeight: 900, scrollTop: 300 })

    expect(updateFollowOutputAfterScroll(
      panel,
      followOutput,
      { scrollTop: 300 },
      false,
      48
    )).toEqual(followOutputPosition(panel))
    expect(followOutput.current).toBe(true)
  })

  it('keeps following after layout shrinkage moves the viewport upward', () => {
    const followOutput = { current: true }
    const panel = scrollPanel({ scrollHeight: 900, scrollTop: 200 })

    updateFollowOutputAfterScroll(
      panel,
      followOutput,
      { scrollTop: 300 },
      false,
      48
    )

    expect(followOutput.current).toBe(true)
  })

  it('stops after an upward scroll and resumes only near the bottom', () => {
    const followOutput = { current: true }
    const panel = scrollPanel({ scrollHeight: 900, scrollTop: 250 })

    let previousPosition = updateFollowOutputAfterScroll(
      panel,
      followOutput,
      { scrollTop: 300 },
      true,
      48
    )
    expect(followOutput.current).toBe(false)

    panel.scrollTop = 500
    previousPosition = updateFollowOutputAfterScroll(
      panel,
      followOutput,
      previousPosition,
      true,
      48
    )
    expect(followOutput.current).toBe(false)

    panel.scrollTop = 600
    updateFollowOutputAfterScroll(panel, followOutput, previousPosition, true, 48)
    expect(followOutput.current).toBe(true)
  })

  it('stops immediately after a small user scroll inside the near-bottom threshold', () => {
    const followOutput = { current: true }
    const panel = scrollPanel({ scrollHeight: 900, scrollTop: 590 })

    updateFollowOutputAfterScroll(
      panel,
      followOutput,
      { scrollTop: 600 },
      true,
      96
    )

    expect(isNearScrollBottom(panel, 96)).toBe(true)
    expect(followOutput.current).toBe(false)
  })

  it('keeps following when a layout adjustment scrolls upward without user input', () => {
    const followOutput = { current: true }
    const panel = scrollPanel({ scrollHeight: 1200, scrollTop: 300 })

    updateFollowOutputAfterScroll(
      panel,
      followOutput,
      { scrollTop: 600 },
      false,
      96
    )

    expect(followOutput.current).toBe(true)
  })

  it('follows content growth while the user remains at the bottom', () => {
    const panel = scrollPanel()
    const content = {} as HTMLElement
    const observed: Element[] = []
    const frames: FrameRequestCallback[] = []
    let resize: ResizeObserverCallback = () => undefined
    let disconnected = false

    const cleanup = observeFollowOutputGrowth(panel, content, { current: true }, {
      createObserver(callback) {
        resize = callback
        return {
          observe(target) {
            observed.push(target)
          },
          disconnect() {
            disconnected = true
          }
        }
      },
      requestFrame(callback) {
        frames.push(callback)
        return frames.length
      },
      cancelFrame() {}
    })

    setScrollHeight(panel, 900)
    resize([], {} as ResizeObserver)
    resize([], {} as ResizeObserver)

    expect(observed).toEqual([content, panel])
    expect(frames).toHaveLength(1)
    frames[0](0)
    expect(panel.scrollTop).toBe(900)

    cleanup()
    expect(disconnected).toBe(true)
  })

  it.each([true, false])('keeps the follow decision when content collapses (following: %s)', (following) => {
    const panel = scrollPanel({ scrollHeight: 900, scrollTop: 250 })
    const frames: FrameRequestCallback[] = []
    let resize: ResizeObserverCallback = () => undefined
    let resized = 0

    observeFollowOutputGrowth(panel, {} as HTMLElement, { current: following }, {
      createObserver(callback) {
        resize = callback
        return {
          observe() {},
          disconnect() {}
        }
      },
      requestFrame(callback) {
        frames.push(callback)
        return frames.length
      },
      cancelFrame() {},
      onResize() {
        resized += 1
      }
    })

    setScrollHeight(panel, 600)
    resize([], {} as ResizeObserver)
    frames[0](0)

    expect(panel.scrollTop).toBe(following ? 600 : 250)
    expect(resized).toBe(1)
  })

  it('does not take the viewport back after the user scrolls away', () => {
    const panel = scrollPanel()
    const followOutput = { current: true }
    const frames: FrameRequestCallback[] = []
    let resize: ResizeObserverCallback = () => undefined

    observeFollowOutputGrowth(panel, {} as HTMLElement, followOutput, {
      createObserver(callback) {
        resize = callback
        return {
          observe() {},
          disconnect() {}
        }
      },
      requestFrame(callback) {
        frames.push(callback)
        return frames.length
      },
      cancelFrame() {}
    })

    resize([], {} as ResizeObserver)
    followOutput.current = false
    setScrollHeight(panel, 900)
    frames[0](0)
    resize([], {} as ResizeObserver)

    expect(panel.scrollTop).toBe(300)
    expect(frames).toHaveLength(1)
  })

  it('updates navigation boundaries after growth while follow mode is off', () => {
    const panel = scrollPanel()
    const frames: FrameRequestCallback[] = []
    let resize: ResizeObserverCallback = () => undefined
    let resized = 0

    observeFollowOutputGrowth(panel, {} as HTMLElement, { current: false }, {
      createObserver(callback) {
        resize = callback
        return {
          observe() {},
          disconnect() {}
        }
      },
      requestFrame(callback) {
        frames.push(callback)
        return frames.length
      },
      cancelFrame() {},
      onResize() {
        resized += 1
      }
    })

    resize([], {} as ResizeObserver)
    expect(frames).toHaveLength(1)
    frames[0](0)

    expect(panel.scrollTop).toBe(300)
    expect(resized).toBe(1)
  })
})
