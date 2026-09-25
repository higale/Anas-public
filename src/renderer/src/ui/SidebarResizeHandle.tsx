import { useEffect, useState } from 'react'
import {
  normalizeSidebarWidth, SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MAX, SIDEBAR_WIDTH_MIN
} from '@shared/uiPreferences'
import { ResizeHandle } from './ResizeHandle'

export const SIDEBAR_MAIN_MIN_WIDTH = 520

export function maxSidebarWidthForViewport(viewportWidth: number): number {
  if (!Number.isFinite(viewportWidth)) return SIDEBAR_WIDTH_MAX
  return Math.max(SIDEBAR_WIDTH_MIN, Math.min(SIDEBAR_WIDTH_MAX, Math.floor(viewportWidth - SIDEBAR_MAIN_MIN_WIDTH)))
}

export function clampSidebarWidthForViewport(width: number, viewportWidth: number): number {
  return Math.min(normalizeSidebarWidth(width), maxSidebarWidthForViewport(viewportWidth))
}

export function sidebarWidthCssValue(width: number): string {
  return `clamp(${SIDEBAR_WIDTH_MIN}px, ${normalizeSidebarWidth(width)}px, min(${SIDEBAR_WIDTH_MAX}px, calc(100vw - ${SIDEBAR_MAIN_MIN_WIDTH}px)))`
}

export function SidebarResizeHandle({ label, width, onCommit }: {
  label: string; width: number; onCommit(width: number): void | Promise<void>
}) {
  const [viewportWidth, setViewportWidth] = useState(window.innerWidth)
  useEffect(() => {
    const measure = () => setViewportWidth(window.innerWidth)
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])
  return <ResizeHandle label={label} width={width} onCommit={onCommit}
    minWidth={SIDEBAR_WIDTH_MIN} maxWidth={maxSidebarWidthForViewport(viewportWidth)}
    defaultWidth={SIDEBAR_WIDTH_DEFAULT} rootSelector=".app-shell" paneSelector=".app-sidebar"
    property="--sidebar-width" className="sidebar-resize-handle" />
}
