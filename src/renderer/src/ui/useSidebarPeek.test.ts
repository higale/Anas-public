import { describe, expect, it } from 'vitest'
import { isPointerPastSidebarRightEdge, shouldScheduleSidebarPeekHide } from './useSidebarPeek'

describe('sidebar peek behavior', () => {
  it('hides after the pointer entered main content and the focus lock was released', () => {
    expect(shouldScheduleSidebarPeekHide(true, true)).toBe(false)
    expect(shouldScheduleSidebarPeekHide(true, false)).toBe(true)
  })

  it('stays open when the pointer did not leave through the sidebar right edge', () => {
    expect(shouldScheduleSidebarPeekHide(false, false)).toBe(false)
    expect(shouldScheduleSidebarPeekHide(false, true)).toBe(false)
  })

  it('distinguishes leaving the window left edge from entering content past the sidebar', () => {
    expect(isPointerPastSidebarRightEdge(-1, 260)).toBe(false)
    expect(isPointerPastSidebarRightEdge(0, 260)).toBe(false)
    expect(isPointerPastSidebarRightEdge(259, 260)).toBe(false)
    expect(isPointerPastSidebarRightEdge(260, 260)).toBe(true)
    expect(isPointerPastSidebarRightEdge(480, 260)).toBe(true)
  })
})
