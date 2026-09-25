import { useSyncExternalStore } from 'react'

interface WindowControlsOverlay extends EventTarget {
  readonly visible: boolean
  getTitlebarAreaRect(): DOMRect
}

export function windowControlsOverlay(): WindowControlsOverlay | undefined {
  return (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay }).windowControlsOverlay
}

export function nativeTitlebarBottom(): number {
  const overlay = windowControlsOverlay()
  return overlay?.visible ? overlay.getTitlebarAreaRect().bottom : 0
}

function subscribe(onChange: () => void): () => void {
  const overlay = windowControlsOverlay()
  overlay?.addEventListener('geometrychange', onChange)
  window.addEventListener('resize', onChange)
  return () => {
    overlay?.removeEventListener('geometrychange', onChange)
    window.removeEventListener('resize', onChange)
  }
}

type CollisionPadding = number | Partial<Record<'top' | 'right' | 'bottom' | 'left', number>>

export function useFloatingCollisionPadding(padding: CollisionPadding = 0): CollisionPadding {
  const titlebarBottom = useSyncExternalStore(subscribe, nativeTitlebarBottom)
  if (titlebarBottom === 0) return padding
  const sides = typeof padding === 'number'
    ? { top: padding, right: padding, bottom: padding, left: padding }
    : padding
  // Native caption buttons are outside the DOM. Keep Radix's collision viewport
  // below them, using CSS-pixel geometry that follows window zoom and resizing.
  return { ...sides, top: titlebarBottom + (sides.top ?? 0) }
}
