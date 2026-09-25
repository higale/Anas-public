import type { BrowserWindow, WebContents } from 'electron'
import { runtimeLog } from './runtimeLogger'

const minZoomPercent = 25
const maxZoomPercent = 500
const zoomLevelStep = 0.5

export function normalizeZoomPercent(value: number): number {
  if (!Number.isFinite(value)) return 100
  return Math.min(maxZoomPercent, Math.max(minZoomPercent, Math.round(value)))
}

export function getWebContentsZoomPercent(webContents: WebContents): number {
  return normalizeZoomPercent(webContents.getZoomFactor() * 100)
}

export function applyWebContentsZoom(webContents: WebContents, zoom: number): number {
  const normalized = normalizeZoomPercent(zoom)
  webContents.setZoomFactor(normalized / 100)
  notifyZoomChanged(webContents)
  return normalized
}

export function resetAppZoom(webContents: WebContents): number {
  return applyWebContentsZoom(webContents, 100)
}

export function stepAppZoom(webContents: WebContents, direction: -1 | 1): number {
  webContents.setZoomLevel(webContents.getZoomLevel() + direction * zoomLevelStep)
  const current = webContents.getZoomFactor() * 100
  if (current < minZoomPercent) return applyWebContentsZoom(webContents, minZoomPercent)
  if (current > maxZoomPercent) return applyWebContentsZoom(webContents, maxZoomPercent)
  notifyZoomChanged(webContents)
  return getWebContentsZoomPercent(webContents)
}

function logZoomShortcutFailure(reason: unknown): void {
  runtimeLog('warn', 'zoom', 'Failed to apply keyboard zoom shortcut.', { error: reason })
}

function notifyZoomChanged(webContents: WebContents): void {
  webContents.send('app:zoomChanged', getWebContentsZoomPercent(webContents))
}

export function registerWindowZoomShortcuts(win: BrowserWindow): void {
  win.webContents.on('zoom-changed', (event, direction) => {
    event.preventDefault()
    try {
      stepAppZoom(win.webContents, direction === 'in' ? 1 : -1)
    } catch (reason) {
      logZoomShortcutFailure(reason)
    }
  })

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control || input.alt || input.meta) return

    const key = input.key
    const code = input.code
    if (key === '=' || key === '+' || code === 'Equal' || code === 'NumpadAdd') {
      event.preventDefault()
      try {
        stepAppZoom(win.webContents, 1)
      } catch (reason) {
        logZoomShortcutFailure(reason)
      }
      return
    }

    if (key === '-' || code === 'Minus' || code === 'NumpadSubtract') {
      event.preventDefault()
      try {
        stepAppZoom(win.webContents, -1)
      } catch (reason) {
        logZoomShortcutFailure(reason)
      }
      return
    }

    if (key === '0' || code === 'Digit0' || code === 'Numpad0') {
      event.preventDefault()
      try {
        resetAppZoom(win.webContents)
      } catch (reason) {
        logZoomShortcutFailure(reason)
      }
    }
  })
}
