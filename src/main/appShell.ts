import { app, BrowserWindow, Menu, nativeTheme, shell, type BrowserWindowConstructorOptions, type MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import { getAppConfigSnapshot } from './config/appConfig'
import { getLanguageResources } from './languageStore'
import { registerMainRendererWindow, resolveRendererLocation } from './ipcSecurity'
import { runtimeLog } from './runtimeLogger'
import { registerWindowZoomShortcuts, resetAppZoom, stepAppZoom } from './zoomService'
import { buildNativeContextMenuTemplate, type NativeMenuLabel } from './nativeContextMenu'
import { applyProfileWindowIcon } from './profileIconService'
import { applicationName, applicationRepositoryUrl } from '@shared/appMetadata'

const externalUrlProtocols = new Set(['http:', 'https:', 'mailto:'])
let appQuitting = false
const fallbackMenuLabel: NativeMenuLabel = (_key, fallback) => fallback.replaceAll('{{name}}', applicationName)
let currentMenuLabel = fallbackMenuLabel

type ThemeSource = 'system' | 'light' | 'dark'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function normalizeThemeSource(value?: string): ThemeSource {
  return value === 'light' || value === 'dark' ? value : 'system'
}

function titleBarColors(): { backgroundColor: string; symbolColor: string } {
  return nativeTheme.shouldUseDarkColors
    ? { backgroundColor: '#202020', symbolColor: '#e5e5e5' }
    : { backgroundColor: '#f5f5f5', symbolColor: '#252525' }
}

function titleBarOptions(): Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'titleBarOverlay' | 'trafficLightPosition'> {
  if (process.platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 18 }
    }
  }

  const colors = titleBarColors()
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: colors.backgroundColor,
      symbolColor: colors.symbolColor,
      height: 36
    }
  }
}

function requestAboutDialog(): void {
  const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  window?.webContents.send('app:aboutRequested')
}

function openHelpFromMenu(): void {
  activeWindow()?.webContents.send('app:helpRequested')
}

function activeWindow(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

export function markAppQuitting(): void {
  appQuitting = true
}

export function activateMainWindow(): void {
  const win = activeWindow()
  if (!win) {
    if (app.isReady()) createMainWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  if (process.platform === 'darwin') app.focus({ steal: true })
  win.focus()
}

export function normalizeExternalUrl(url: string): string {
  const parsed = new URL(url)
  if (!externalUrlProtocols.has(parsed.protocol)) throw new Error('Unsupported external URL protocol.')
  return parsed.toString()
}

export async function openExternalUrl(url: string): Promise<string> {
  const externalUrl = normalizeExternalUrl(url)
  await shell.openExternal(externalUrl)
  return externalUrl
}

function resetActiveWindowZoom(): void {
  const window = activeWindow()
  if (window) resetAppZoom(window.webContents)
}

function stepActiveWindowZoom(direction: -1 | 1): void {
  const window = activeWindow()
  if (window) stepAppZoom(window.webContents, direction)
}

function readNestedString(resource: Record<string, unknown>, path: string): string | undefined {
  let current: unknown = resource
  for (const key of path.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return typeof current === 'string' ? current : undefined
}

function matchMenuLanguage(preference: string, available: string[]): string {
  const fallback = available.includes('en') ? 'en' : available[0] ?? 'en'
  if (preference && preference !== 'system') {
    const exact = available.find((code) => code.toLowerCase() === preference.toLowerCase())
    if (exact) return exact
    const base = preference.split('-')[0]?.toLowerCase()
    return available.find((code) => code.split('-')[0]?.toLowerCase() === base) ?? fallback
  }

  const systemLanguage = app.getLocale()
  const exact = available.find((code) => code.toLowerCase() === systemLanguage.toLowerCase())
  if (exact) return exact
  const base = systemLanguage.split('-')[0]?.toLowerCase()
  return available.find((code) => code.split('-')[0]?.toLowerCase() === base) ?? fallback
}

async function loadMenuLabels(): Promise<(key: string, fallback: string) => string> {
  try {
    const [config, languageResources] = await Promise.all([
      getAppConfigSnapshot(),
      getLanguageResources()
    ])
    const available = Object.keys(languageResources.resources)
    const language = matchMenuLanguage(config.settings.language, available)
    const resource = asRecord(languageResources.resources[language] ?? languageResources.resources.en)
    return (key, fallback) => {
      const value = readNestedString(resource, `menu.${key}`) ?? fallback
      return value.replaceAll('{{name}}', applicationName)
    }
  } catch (reason) {
    runtimeLog('warn', 'i18n', 'Failed to load localized application menu.', { error: reason })
    return (_key, fallback) => fallback.replaceAll('{{name}}', applicationName)
  }
}

export async function configureApplicationMenu(): Promise<void> {
  const menuLabel = await loadMenuLabels()
  currentMenuLabel = menuLabel
  if (process.platform !== 'darwin') return

  const template: MenuItemConstructorOptions[] = [
    {
      label: applicationName,
      submenu: [
        { label: menuLabel('about', 'About {{name}}'), click: requestAboutDialog },
        { type: 'separator' },
        { role: 'services', label: menuLabel('services', 'Services') },
        { type: 'separator' },
        { role: 'hide', label: menuLabel('hide', 'Hide {{name}}') },
        { role: 'hideOthers', label: menuLabel('hide_others', 'Hide Others') },
        { role: 'unhide', label: menuLabel('unhide', 'Show All') },
        { type: 'separator' },
        { role: 'quit', label: menuLabel('quit', 'Quit {{name}}') }
      ]
    },
    {
      label: menuLabel('edit', 'Edit'),
      submenu: [
        { role: 'undo', label: menuLabel('undo', 'Undo') },
        { role: 'redo', label: menuLabel('redo', 'Redo') },
        { type: 'separator' },
        { role: 'cut', label: menuLabel('cut', 'Cut') },
        { role: 'copy', label: menuLabel('copy', 'Copy') },
        { role: 'paste', label: menuLabel('paste', 'Paste') },
        { role: 'selectAll', label: menuLabel('select_all', 'Select All') }
      ]
    },
    {
      label: menuLabel('view', 'View'),
      submenu: [
        { role: 'reload', label: menuLabel('reload', 'Reload') },
        { role: 'forceReload', label: menuLabel('force_reload', 'Force Reload') },
        { role: 'toggleDevTools', label: menuLabel('toggle_dev_tools', 'Toggle Developer Tools') },
        { type: 'separator' },
        { accelerator: 'CommandOrControl+0', click: resetActiveWindowZoom, label: menuLabel('reset_zoom', 'Actual Size') },
        { accelerator: 'CommandOrControl+=', click: () => stepActiveWindowZoom(1), label: menuLabel('zoom_in', 'Zoom In') },
        { accelerator: 'CommandOrControl+-', click: () => stepActiveWindowZoom(-1), label: menuLabel('zoom_out', 'Zoom Out') },
        { type: 'separator' },
        { role: 'togglefullscreen', label: menuLabel('toggle_full_screen', 'Enter Full Screen') }
      ]
    },
    {
      label: menuLabel('window', 'Window'),
      submenu: [
        { role: 'minimize', label: menuLabel('minimize', 'Minimize') },
        { role: 'zoom', label: menuLabel('zoom', 'Zoom') },
        { type: 'separator' },
        { role: 'front', label: menuLabel('front', 'Bring All to Front') }
      ]
    },
    {
      label: menuLabel('help', 'Help'),
      submenu: [
        { label: menuLabel('user_guide', 'User Guide'), click: openHelpFromMenu },
        { label: 'GitHub', click: () => {
          void openExternalUrl(applicationRepositoryUrl).catch((reason) => {
            runtimeLog('warn', 'navigation', 'Failed to open GitHub repository.', { error: reason })
          })
        } }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

export function applyNativeTheme(theme?: string): void {
  nativeTheme.themeSource = normalizeThemeSource(theme)
  for (const win of BrowserWindow.getAllWindows()) {
    applyWindowTheme(win)
  }
}

export function applyWindowTheme(win: BrowserWindow): void {
  const colors = titleBarColors()
  win.setBackgroundColor(colors.backgroundColor)
  if (process.platform === 'darwin') return
  try {
    win.setTitleBarOverlay({
      color: colors.backgroundColor,
      symbolColor: colors.symbolColor,
      height: 36
    })
  } catch {
    // Some Linux window managers ignore or reject title bar overlay updates.
  }
}

function registerExternalNavigationGuards(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url).catch((reason) => {
      runtimeLog('warn', 'navigation', 'Blocked external window open.', { url, error: reason })
    })
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return
    try {
      const externalUrl = normalizeExternalUrl(url)
      event.preventDefault()
      void openExternalUrl(externalUrl)
    } catch {
      event.preventDefault()
      runtimeLog('warn', 'navigation', 'Blocked renderer navigation.', { url })
    }
  })
}

function registerWindowDiagnostics(win: BrowserWindow): void {
  win.webContents.on('render-process-gone', (_event, details) => {
    runtimeLog('error', 'renderer', 'Renderer process exited.', {
      reason: details.reason,
      exitCode: details.exitCode,
      url: win.webContents.isDestroyed() ? undefined : win.webContents.getURL()
    })
  })
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    runtimeLog('error', 'renderer', 'Renderer main frame failed to load.', {
      errorCode,
      errorDescription,
      url: validatedURL
    })
  })
  win.webContents.on('preload-error', (_event, preloadPath, reason) => {
    runtimeLog('error', 'renderer', 'Renderer preload script failed.', {
      preloadPath,
      error: reason
    })
  })
  win.on('unresponsive', () => {
    runtimeLog('error', 'renderer', 'Renderer window became unresponsive.', {
      url: win.webContents.isDestroyed() ? undefined : win.webContents.getURL()
    })
  })
  win.on('responsive', () => {
    runtimeLog('info', 'renderer', 'Renderer window became responsive again.')
  })
}

function registerNativeContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const menu = Menu.buildFromTemplate(buildNativeContextMenuTemplate(params, currentMenuLabel))
    menu.popup({ window: win })
  })
}

export function createMainWindow(options: { recovery?: boolean } = {}): void {
  const rendererFile = join(__dirname, '../renderer/index.html')
  const rendererLocation = resolveRendererLocation({
    isPackaged: app.isPackaged,
    rendererFile,
    rendererUrl: process.env.ELECTRON_RENDERER_URL
  })
  const win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: applicationName,
    backgroundColor: titleBarColors().backgroundColor,
    ...titleBarOptions(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  win.webContents.session.setSpellCheckerEnabled(false)
  const profileWindowIconReady = options.recovery ? Promise.resolve() : applyProfileWindowIcon(win)

  registerMainRendererWindow(win, rendererLocation)
  win.once('ready-to-show', () => {
    void profileWindowIconReady.finally(() => {
      if (!win.isDestroyed()) win.show()
    })
  })
  win.on('close', (event) => {
    if (process.platform !== 'darwin' || appQuitting) return
    event.preventDefault()
    win.hide()
  })
  applyWindowTheme(win)
  registerExternalNavigationGuards(win)
  registerWindowDiagnostics(win)
  registerNativeContextMenu(win)
  registerWindowZoomShortcuts(win)

  if (rendererLocation.kind === 'development') {
    const url = new URL(rendererLocation.url)
    if (options.recovery) url.hash = 'recovery'
    void win.loadURL(url.toString())
  } else {
    void win.loadFile(rendererFile, options.recovery ? { hash: 'recovery' } : undefined)
  }
}
