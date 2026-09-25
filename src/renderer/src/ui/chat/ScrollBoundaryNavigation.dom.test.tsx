import { act, fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { pauseFollowOutputForContentToggle, useScrollBoundaryNavigation } from './ScrollBoundaryNavigation'

function scrollHarness() {
  const following = { current: true }
  function Harness() {
    const panelRef = useRef<HTMLDivElement>(null), contentRef = useRef<HTMLDivElement>(null)
    const navigation = useScrollBoundaryNavigation({ panelRef, contentRef, followOutputRef: following })
    return <div ref={panelRef} role="region" aria-label="Messages" data-testid="panel" onScroll={navigation.onScroll}
      onWheel={navigation.onWheel} onPointerDown={navigation.onPointerDown}
      onTouchStart={navigation.onTouchStart} onTouchMove={navigation.onTouchMove}>
      <div ref={contentRef}><textarea aria-label="input" /></div>
    </div>
  }
  const view = render(<Harness />), panel = view.getByTestId('panel')
  Object.defineProperties(panel, {
    clientHeight: { configurable: true, value: 300 },
    scrollHeight: { configurable: true, value: 1000 }
  })
  panel.scrollTop = 700
  fireEvent.scroll(panel)
  return { ...view, panel, following }
}

describe('scroll boundary navigation', () => {
  it('keeps following when a short conversation cannot scroll upward', () => {
    const { panel, following } = scrollHarness()
    Object.defineProperty(panel, 'scrollHeight', { configurable: true, value: 300 })
    panel.scrollTop = 0
    fireEvent.scroll(panel)
    fireEvent.wheel(panel, { deltaY: -100 })
    expect(following.current).toBe(true)
    fireEvent.keyDown(panel, { key: 'Home' })
    expect(following.current).toBe(true)
    fireEvent.touchStart(panel, { touches: [{ clientY: 100 }] })
    fireEvent.touchMove(panel, { touches: [{ clientY: 120 }] })
    expect(following.current).toBe(true)
  })

  it('keeps following when downward input at the bottom is followed by automatic tool layout collapse', () => {
    const { panel, following } = scrollHarness()
    fireEvent.wheel(panel, { deltaY: 100 })
    Object.defineProperty(panel, 'scrollHeight', { configurable: true, value: 340 })
    panel.scrollTop = 40
    fireEvent.scroll(panel)
    expect(following.current).toBe(true)
  })

  it('pauses for a small upward wheel movement and resumes when scrolling down to the bottom', () => {
    const { panel, following } = scrollHarness()
    fireEvent.wheel(panel, { deltaY: -10 })
    panel.scrollTop = 690
    fireEvent.scroll(panel)
    expect(following.current).toBe(false)
    fireEvent.wheel(panel, { deltaY: 10 })
    panel.scrollTop = 700
    fireEvent.scroll(panel)
    expect(following.current).toBe(true)
  })

  it('recognizes keyboard and touch upward intent but ignores text editing keys', () => {
    const { panel, following, getByRole } = scrollHarness()
    fireEvent.keyDown(getByRole('textbox'), { key: 'ArrowUp' })
    expect(following.current).toBe(true)
    fireEvent.keyDown(panel, { key: 'PageUp' })
    expect(following.current).toBe(false)
    following.current = true
    fireEvent.keyDown(panel, { key: 'ArrowUp', metaKey: true })
    expect(following.current).toBe(false)
    following.current = true
    fireEvent.touchStart(panel, { touches: [{ clientY: 100 }] })
    fireEvent.touchMove(panel, { touches: [{ clientY: 80 }] })
    expect(following.current).toBe(true)
    fireEvent.touchMove(panel, { touches: [{ clientY: 120 }] })
    expect(following.current).toBe(false)
  })

  it('tracks scrollbar dragging only until the pointer is released', () => {
    let release!: FrameRequestCallback
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { release = callback; return 1 })
    const { panel, following } = scrollHarness()
    fireEvent.pointerDown(panel, { clientX: 0 })
    panel.scrollTop = 600
    fireEvent.scroll(panel)
    expect(following.current).toBe(false)
    panel.scrollTop = 700
    fireEvent.scroll(panel)
    expect(following.current).toBe(true)
    fireEvent.pointerUp(window)
    act(() => release(0))
    panel.scrollTop = 500
    fireEvent.scroll(panel)
    expect(following.current).toBe(true)
  })

  it('handles a track click scroll queued after pointer release without retaining stale intent', () => {
    let release!: FrameRequestCallback
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { release = callback; return 1 })
    const { panel, following } = scrollHarness()
    fireEvent.pointerDown(panel, { clientX: 0 })
    fireEvent.pointerUp(window)
    panel.scrollTop = 600
    fireEvent.scroll(panel)
    expect(following.current).toBe(false)
    act(() => release(0))
    following.current = true
    panel.scrollTop = 500
    fireEvent.scroll(panel)
    expect(following.current).toBe(true)
  })

  it('does not pause for a disabled tool argument disclosure', () => {
    const summary = document.createElement('summary'), following = { current: true }
    summary.setAttribute('aria-disabled', 'true')
    expect(pauseFollowOutputForContentToggle(summary, following)).toBe(false)
    expect(following.current).toBe(true)
  })

  it('pauses follow mode before a native disclosure expands', () => {
    const summary = document.createElement('summary')
    const label = document.createElement('span')
    const followOutput = { current: true }
    summary.append(label)

    expect(pauseFollowOutputForContentToggle(label, followOutput)).toBe(true)
    expect(followOutput.current).toBe(false)
  })

  it('pauses follow mode before a custom activity range expands', () => {
    const toggle = document.createElement('button')
    const icon = document.createElement('span')
    const followOutput = { current: true }
    toggle.dataset.scrollFollowToggle = ''
    toggle.append(icon)

    expect(pauseFollowOutputForContentToggle(icon, followOutput)).toBe(true)
    expect(followOutput.current).toBe(false)
  })

  it('leaves follow mode unchanged for unrelated message actions', () => {
    const button = document.createElement('button')
    const followOutput = { current: true }

    expect(pauseFollowOutputForContentToggle(button, followOutput)).toBe(false)
    expect(followOutput.current).toBe(true)
  })
})
