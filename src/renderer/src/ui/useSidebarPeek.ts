import { useCallback, useEffect, useRef, useState } from 'react'

const SIDEBAR_PEEK_SURFACE_SELECTOR = '.app-sidebar, .sidebar-peek-trigger, [data-sidebar-floating]'
const SIDEBAR_PEEK_FOCUS_LOCK_SELECTOR = '[data-sidebar-floating], input, textarea, select, [contenteditable="true"]'
const SIDEBAR_PEEK_HIDE_DELAY_MS = 180

export function shouldScheduleSidebarPeekHide(pointerOutside: boolean, focusLocked: boolean): boolean {
  return pointerOutside && !focusLocked
}

export function isPointerPastSidebarRightEdge(pointerX: number, sidebarRight: number): boolean {
  return pointerX >= sidebarRight
}

function isSidebarPeekSurface(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(SIDEBAR_PEEK_SURFACE_SELECTOR))
}

function isSidebarPeekFocusLocked(target: EventTarget | null): boolean {
  if (!(target instanceof Element) || !isSidebarPeekSurface(target)) return false
  return Boolean(target.closest(SIDEBAR_PEEK_FOCUS_LOCK_SELECTOR))
}

export function useSidebarPeek(enabled: boolean, onHide?: () => void) {
  const [open, setOpen] = useState(false)
  const openRef = useRef(false)
  const pointerOutsideRef = useRef(false)
  const onHideRef = useRef(onHide)
  const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    onHideRef.current = onHide
  }, [onHide])

  const clearHideTimeout = useCallback(() => {
    if (!hideTimeoutRef.current) return
    clearTimeout(hideTimeoutRef.current)
    hideTimeoutRef.current = undefined
  }, [])

  const updateOpen = useCallback((nextOpen: boolean) => {
    if (openRef.current === nextOpen) return
    openRef.current = nextOpen
    setOpen(nextOpen)
    if (!nextOpen) onHideRef.current?.()
  }, [])

  const show = useCallback(() => {
    if (!enabled) return
    pointerOutsideRef.current = false
    clearHideTimeout()
    updateOpen(true)
  }, [clearHideTimeout, enabled, updateOpen])

  useEffect(() => {
    if (!enabled) {
      clearHideTimeout()
      updateOpen(false)
      return
    }

    const scheduleHide = () => {
      if (!openRef.current || hideTimeoutRef.current) return
      hideTimeoutRef.current = setTimeout(() => {
        hideTimeoutRef.current = undefined
        const focusLocked = isSidebarPeekFocusLocked(document.activeElement)
        if (!shouldScheduleSidebarPeekHide(pointerOutsideRef.current, focusLocked)) return
        updateOpen(false)
      }, SIDEBAR_PEEK_HIDE_DELAY_MS)
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (!openRef.current || event.pointerType === 'touch') return
      if (isSidebarPeekSurface(event.target)) {
        pointerOutsideRef.current = false
        clearHideTimeout()
        return
      }
      const sidebar = document.querySelector<HTMLElement>('.app-sidebar')
      const sidebarBounds = sidebar?.getBoundingClientRect()
      const sidebarRight = sidebarBounds ? Math.max(sidebarBounds.right, sidebarBounds.width) : undefined
      if (sidebarRight !== undefined && !isPointerPastSidebarRightEdge(event.clientX, sidebarRight)) {
        pointerOutsideRef.current = false
        clearHideTimeout()
        return
      }
      pointerOutsideRef.current = true
      if (isSidebarPeekFocusLocked(document.activeElement)) {
        clearHideTimeout()
        return
      }
      scheduleHide()
    }

    const handleFocusIn = (event: FocusEvent) => {
      if (!isSidebarPeekSurface(event.target)) return
      clearHideTimeout()
      updateOpen(true)
    }

    const handleFocusOut = (event: FocusEvent) => {
      const nextFocusLocked = isSidebarPeekFocusLocked(event.relatedTarget)
      if (shouldScheduleSidebarPeekHide(pointerOutsideRef.current, nextFocusLocked)) {
        scheduleHide()
      }
    }

    document.addEventListener('pointermove', handlePointerMove)
    document.addEventListener('focusin', handleFocusIn)
    document.addEventListener('focusout', handleFocusOut)

    return () => {
      document.removeEventListener('pointermove', handlePointerMove)
      document.removeEventListener('focusin', handleFocusIn)
      document.removeEventListener('focusout', handleFocusOut)
      pointerOutsideRef.current = false
      clearHideTimeout()
    }
  }, [clearHideTimeout, enabled, updateOpen])

  return { open, show }
}
