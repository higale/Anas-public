import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react'

interface ResizeDragState {
  pointerId: number
  startX: number
  startWidth: number
  width: number
  shell: HTMLElement
  originalWidthStyle: string
}

function applyWidth(shell: HTMLElement, handle: HTMLElement, property: string, width: number): void {
  shell.style.setProperty(property, `${width}px`)
  handle.setAttribute('aria-valuenow', String(width))
}

interface ResizeHandleProps {
  label: string
  width: number
  minWidth: number
  maxWidth: number
  defaultWidth: number
  rootSelector: string
  paneSelector: string
  property: string
  direction?: 1 | -1
  className?: string
  onCommit(width: number): void | Promise<void>
}

export function ResizeHandle({ label, width, minWidth, maxWidth, defaultWidth, rootSelector, paneSelector,
  property, direction = 1, className = '', onCommit }: ResizeHandleProps) {
  const clamp = (value: number) => Math.min(maxWidth, Math.max(minWidth, value))
  const dragRef = useRef<ResizeDragState | undefined>(undefined)
  const persistenceVersionRef = useRef(0)

  useEffect(() => () => {
    const drag = dragRef.current
    if (drag) drag.shell.style.setProperty(property, drag.originalWidthStyle)
    document.documentElement.classList.remove('ui-resizing')
  }, [property])

  function persistWidth(
    shell: HTMLElement,
    handle: HTMLElement,
    nextWidth: number,
    fallbackWidth: number,
    fallbackStyle: string
  ): void {
    const persistenceVersion = ++persistenceVersionRef.current
    const restore = () => {
      if (persistenceVersionRef.current !== persistenceVersion) return
      shell.style.setProperty(property, fallbackStyle)
      handle.setAttribute('aria-valuenow', String(fallbackWidth))
    }
    try {
      const result = onCommit(nextWidth)
      if (result) void result.catch(restore)
    } catch {
      restore()
    }
  }

  function finishDrag(handle: HTMLElement, commit: boolean): void {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = undefined
    document.documentElement.classList.remove('ui-resizing')
    if (handle.hasPointerCapture(drag.pointerId)) handle.releasePointerCapture(drag.pointerId)
    if (!commit) {
      drag.shell.style.setProperty(property, drag.originalWidthStyle)
      handle.setAttribute('aria-valuenow', String(drag.startWidth))
      return
    }
    if (drag.width !== drag.startWidth) {
      persistWidth(
        drag.shell,
        handle,
        drag.width,
        drag.startWidth,
        drag.originalWidthStyle
      )
    }
  }

  function commitWidth(handle: HTMLElement, nextWidth: number): void {
    const shell = handle.closest<HTMLElement>(rootSelector)
    if (!shell) return
    const currentWidth = clamp(Number(handle.getAttribute('aria-valuenow')))
    const currentStyle = shell.style.getPropertyValue(property)
    const normalized = clamp(nextWidth)
    applyWidth(shell, handle, property, normalized)
    if (normalized !== currentWidth) {
      persistWidth(shell, handle, normalized, currentWidth, currentStyle)
    }
  }

  function handlePointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0 || !event.isPrimary) return
    const shell = event.currentTarget.closest<HTMLElement>(rootSelector)
    const sidebar = event.currentTarget.closest<HTMLElement>(paneSelector)
    if (!shell || !sidebar) return
    event.preventDefault()
    const startWidth = Math.round(sidebar.getBoundingClientRect().width)
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth,
      width: startWidth,
      shell,
      originalWidthStyle: shell.style.getPropertyValue(property)
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    document.documentElement.classList.add('ui-resizing')
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    drag.width = clamp(drag.startWidth + direction * (event.clientX - drag.startX))
    applyWidth(drag.shell, event.currentTarget, property, drag.width)
  }

  function handlePointerUp(event: PointerEvent<HTMLDivElement>): void {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    drag.width = clamp(drag.startWidth + direction * (event.clientX - drag.startX))
    applyWidth(drag.shell, event.currentTarget, property, drag.width)
    finishDrag(event.currentTarget, true)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const currentWidth = clamp(Number(event.currentTarget.getAttribute('aria-valuenow')))
    let nextWidth: number | undefined
    if (event.key === 'ArrowLeft') nextWidth = currentWidth - (10 * direction)
    if (event.key === 'ArrowRight') nextWidth = currentWidth + (10 * direction)
    if (event.key === 'Home') nextWidth = minWidth
    if (event.key === 'End') nextWidth = maxWidth
    if (nextWidth === undefined) return
    event.preventDefault()
    commitWidth(event.currentTarget, nextWidth)
  }

  /* A focusable ARIA separator is the standard keyboard-operable splitter pattern. */
  /* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
  return (
    <div
      className={`ui-resize-handle ${className}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuemin={minWidth}
      aria-valuemax={maxWidth}
      aria-valuenow={clamp(width)}
      onDoubleClick={(event) => commitWidth(event.currentTarget, defaultWidth)}
      onKeyDown={handleKeyDown}
      onLostPointerCapture={(event) => finishDrag(event.currentTarget, true)}
      onPointerCancel={(event) => finishDrag(event.currentTarget, false)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
    />
  )
  /* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */
}
