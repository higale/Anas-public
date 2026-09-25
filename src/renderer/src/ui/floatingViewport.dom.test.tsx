import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useFloatingCollisionPadding } from './floatingViewport'

afterEach(() => Reflect.deleteProperty(navigator, 'windowControlsOverlay'))

function overlayFixture() {
  const overlay = Object.assign(new EventTarget(), { visible: true, getTitlebarAreaRect: () => new DOMRect(0, 0, 800, 36) })
  Object.defineProperty(navigator, 'windowControlsOverlay', { configurable: true, value: overlay })
  return overlay
}

describe('floating content viewport', () => {
  it('reserves native caption height while preserving the other edge paddings', () => {
    const overlay = overlayFixture()
    const { result } = renderHook(() => useFloatingCollisionPadding({ top: 8, right: 12, bottom: 16, left: 20 }))
    expect(result.current).toEqual({ top: 44, right: 12, bottom: 16, left: 20 })
    act(() => {
      overlay.getTitlebarAreaRect = () => new DOMRect(0, 5, 800, 60)
      overlay.dispatchEvent(new Event('geometrychange'))
    })
    expect(result.current).toEqual({ top: 73, right: 12, bottom: 16, left: 20 })
  })

  it('recalculates on resize and releases the space when native controls disappear', () => {
    const overlay = overlayFixture()
    const { result } = renderHook(() => useFloatingCollisionPadding(10))
    expect(result.current).toEqual({ top: 46, right: 10, bottom: 10, left: 10 })
    act(() => {
      overlay.getTitlebarAreaRect = () => new DOMRect(0, 0, 800, 24)
      window.dispatchEvent(new Event('resize'))
    })
    expect(result.current).toEqual({ top: 34, right: 10, bottom: 10, left: 10 })
    act(() => {
      overlay.visible = false
      overlay.dispatchEvent(new Event('geometrychange'))
    })
    expect(result.current).toBe(10)
  })

  it('preserves the requested bounds without native overlay controls', () => {
    const { result } = renderHook(() => useFloatingCollisionPadding({ left: 12, bottom: 10 }))
    expect(result.current).toEqual({ left: 12, bottom: 10 })
  })
})
