import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clampSidebarWidthForViewport,
  maxSidebarWidthForViewport,
  sidebarWidthCssValue,
  SidebarResizeHandle
} from './SidebarResizeHandle'

function renderHandle(width = 260, onCommit = vi.fn()) {
  const result = render(
    <div
      className="app-shell"
      style={{ '--sidebar-width': sidebarWidthCssValue(width) } as React.CSSProperties}
    >
      <aside className="app-sidebar" style={{ width }}>
        <SidebarResizeHandle label="Resize sidebar" width={width} onCommit={onCommit} />
      </aside>
    </div>
  )
  const handle = screen.getByRole('separator', { name: 'Resize sidebar' })
  const shell = result.container.querySelector<HTMLElement>('.app-shell')!
  const sidebar = result.container.querySelector<HTMLElement>('.app-sidebar')!
  vi.spyOn(sidebar, 'getBoundingClientRect').mockReturnValue({
    bottom: 600,
    height: 600,
    left: 0,
    right: width,
    top: 0,
    width,
    x: 0,
    y: 0,
    toJSON: () => ({})
  })
  return { handle, onCommit, shell }
}

describe('SidebarResizeHandle', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1000 })
  })

  it('clamps the width against both sidebar and main-content bounds', () => {
    expect(maxSidebarWidthForViewport(1000)).toBe(420)
    expect(maxSidebarWidthForViewport(900)).toBe(380)
    expect(clampSidebarWidthForViewport(500, 900)).toBe(380)
    expect(clampSidebarWidthForViewport(100, 1000)).toBe(220)
  })

  it('updates the CSS width during a drag and commits once on release', () => {
    const { handle, onCommit, shell } = renderHandle()

    fireEvent.pointerDown(handle, { button: 0, clientX: 260, isPrimary: true, pointerId: 7 })
    fireEvent.pointerMove(handle, { clientX: 330, pointerId: 7 })

    expect(shell.style.getPropertyValue('--sidebar-width')).toBe('330px')
    expect(handle).toHaveAttribute('aria-valuenow', '330')
    expect(onCommit).not.toHaveBeenCalled()

    fireEvent.pointerUp(handle, { clientX: 330, pointerId: 7 })
    expect(onCommit).toHaveBeenCalledOnce()
    expect(onCommit).toHaveBeenCalledWith(330)
    expect(document.documentElement).not.toHaveClass('ui-resizing')
  })

  it('commits the release position when no final pointer move is delivered', () => {
    const { handle, onCommit, shell } = renderHandle()

    fireEvent.pointerDown(handle, { button: 0, clientX: 260, isPrimary: true, pointerId: 9 })
    fireEvent.pointerUp(handle, { clientX: 360, pointerId: 9 })

    expect(shell.style.getPropertyValue('--sidebar-width')).toBe('360px')
    expect(handle).toHaveAttribute('aria-valuenow', '360')
    expect(onCommit).toHaveBeenCalledOnce()
    expect(onCommit).toHaveBeenCalledWith(360)
  })

  it('restores the persisted width when a drag is cancelled', () => {
    const { handle, onCommit, shell } = renderHandle()
    const persistedStyle = shell.style.getPropertyValue('--sidebar-width')

    fireEvent.pointerDown(handle, { button: 0, clientX: 260, isPrimary: true, pointerId: 8 })
    fireEvent.pointerMove(handle, { clientX: 350, pointerId: 8 })
    fireEvent.pointerCancel(handle, { pointerId: 8 })

    expect(shell.style.getPropertyValue('--sidebar-width')).toBe(persistedStyle)
    expect(handle).toHaveAttribute('aria-valuenow', '260')
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('commits the visible width when pointer capture is lost', () => {
    const { handle, onCommit, shell } = renderHandle()

    fireEvent.pointerDown(handle, { button: 0, clientX: 260, isPrimary: true, pointerId: 10 })
    fireEvent.pointerMove(handle, { clientX: 345, pointerId: 10 })
    fireEvent.lostPointerCapture(handle, { pointerId: 10 })

    expect(shell.style.getPropertyValue('--sidebar-width')).toBe('345px')
    expect(handle).toHaveAttribute('aria-valuenow', '345')
    expect(onCommit).toHaveBeenCalledOnce()
    expect(onCommit).toHaveBeenCalledWith(345)
  })

  it('supports keyboard adjustment and double-click reset', () => {
    const onCommit = vi.fn()
    const { handle, shell } = renderHandle(300, onCommit)

    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(shell.style.getPropertyValue('--sidebar-width')).toBe('310px')
    expect(onCommit).toHaveBeenLastCalledWith(310)

    fireEvent.doubleClick(handle)
    expect(shell.style.getPropertyValue('--sidebar-width')).toBe('260px')
    expect(onCommit).toHaveBeenLastCalledWith(260)
  })
})
