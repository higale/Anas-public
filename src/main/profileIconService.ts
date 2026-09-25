import { app, BrowserWindow, nativeImage, type BrowserWindow as BrowserWindowInstance, type NativeImage } from 'electron'
import { stat } from 'node:fs/promises'
import { applicationId } from '@shared/appMetadata'
import { avatarDockIconPath, findAvatarWindowsIconPath, pruneAvatarWindowsIcons } from './avatarAssets'
import { getDataDir } from './config/dataDir'
import { runtimeLog } from './runtimeLogger'

function isMissingPath(reason: unknown): boolean {
  return Boolean(reason && typeof reason === 'object' && 'code' in reason && (reason as { code?: unknown }).code === 'ENOENT')
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (reason) {
    if (isMissingPath(reason)) return false
    throw reason
  }
}

async function readWindowsIcon(): Promise<{ image: NativeImage; path: string } | undefined> {
  const path = await findAvatarWindowsIconPath(getDataDir())
  if (!path) return undefined
  const image = nativeImage.createFromPath(path)
  if (!image.isEmpty()) return { image, path }
  runtimeLog('warn', 'profile', 'Avatar Windows icon could not be decoded.', { iconPath: path })
  return undefined
}

function applyWindowsIconToWindow(
  win: BrowserWindowInstance,
  icon: { image: NativeImage; path: string }
): boolean {
  if (win.isDestroyed()) return false
  win.setIcon(icon.image)
  win.setAppDetails({
    appId: applicationId,
    appIconPath: icon.path,
    appIconIndex: 0
  })
  return true
}

async function pruneAppliedWindowsIcons(iconPath: string): Promise<void> {
  try {
    await pruneAvatarWindowsIcons(iconPath)
  } catch (reason) {
    runtimeLog('warn', 'profile', 'Failed to remove stale profile Windows icons.', { error: reason })
  }
}

export async function applyProfileWindowIcon(win: BrowserWindowInstance): Promise<void> {
  if (process.platform !== 'win32') return

  try {
    const icon = await readWindowsIcon()
    if (!icon) return
    if (applyWindowsIconToWindow(win, icon)) await pruneAppliedWindowsIcons(icon.path)
  } catch (reason) {
    runtimeLog('warn', 'profile', 'Failed to apply profile window icon.', { error: reason })
  }
}

async function applyProfileDockIcon(): Promise<void> {
  if (!app.dock) return

  const iconPath = avatarDockIconPath(getDataDir())
  if (!(await pathExists(iconPath))) return

  const image = nativeImage.createFromPath(iconPath)
  if (image.isEmpty()) {
    runtimeLog('warn', 'profile', 'Avatar Dock icon could not be decoded.', { iconPath })
    return
  }
  app.dock.setIcon(image)
}

export async function applyProfileIcon(): Promise<void> {
  try {
    if (process.platform === 'win32') {
      const icon = await readWindowsIcon()
      if (!icon) return
      let applied = false
      for (const win of BrowserWindow.getAllWindows()) {
        try {
          applied = applyWindowsIconToWindow(win, icon) || applied
        } catch (reason) {
          runtimeLog('warn', 'profile', 'Failed to refresh a profile window icon.', { error: reason })
        }
      }
      if (applied) await pruneAppliedWindowsIcons(icon.path)
      return
    }
    if (process.platform === 'darwin') await applyProfileDockIcon()
  } catch (reason) {
    runtimeLog('warn', 'profile', 'Failed to apply profile icon.', { error: reason })
  }
}
