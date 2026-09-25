import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  fromWebContents: vi.fn(),
  handle: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: electronMocks.fromWebContents
  },
  ipcMain: {
    handle: electronMocks.handle
  }
}))

import {
  assertTrustedIpcEvent,
  handleMainIpc,
  ipcUsesApplicationData,
  registerMainRendererWindow,
  rendererLocationMatches,
  resolveRendererLocation
} from './ipcSecurity'

function fakeWindow(frameUrl = 'file:///tmp/anas/renderer/index.html') {
  const mainFrame = { url: frameUrl }
  const webContents = { mainFrame }
  let closed: (() => void) | undefined
  const window = {
    webContents,
    once: vi.fn((event: string, listener: () => void) => {
      if (event === 'closed') closed = listener
    })
  }
  electronMocks.fromWebContents.mockImplementation((candidate) =>
    candidate === webContents ? window : undefined
  )
  return {
    closed: () => closed?.(),
    event: { sender: webContents, senderFrame: mainFrame },
    mainFrame,
    webContents,
    window
  }
}

describe('renderer location security', () => {
  beforeEach(() => {
    electronMocks.fromWebContents.mockReset()
    electronMocks.handle.mockReset()
  })

  it('ignores renderer environment URLs in packaged applications', () => {
    const rendererFile = '/tmp/anas/renderer/index.html'
    const location = resolveRendererLocation({
      isPackaged: true,
      rendererFile,
      rendererUrl: 'https://attacker.example/renderer'
    })

    expect(location).toEqual({
      kind: 'local',
      url: pathToFileURL(rendererFile).toString()
    })
  })

  it('only accepts HTTP(S) literal loopback development origins without credentials', () => {
    expect(resolveRendererLocation({
      isPackaged: false,
      rendererFile: '/tmp/index.html',
      rendererUrl: 'http://127.0.0.1:5173/workbench'
    })).toEqual({
      kind: 'development',
      origin: 'http://127.0.0.1:5173',
      url: 'http://127.0.0.1:5173/workbench'
    })
    expect(resolveRendererLocation({
      isPackaged: false,
      rendererFile: '/tmp/index.html',
      rendererUrl: 'https://[::1]:5173/'
    }).kind).toBe('development')

    for (const rendererUrl of [
      'https://example.test/',
      'http://localhost:5173/',
      'file:///tmp/index.html',
      'http://user:secret@127.0.0.1:5173/'
    ]) {
      expect(() => resolveRendererLocation({
        isPackaged: false,
        rendererFile: '/tmp/index.html',
        rendererUrl
      })).toThrow('loopback origin')
    }
  })

  it('matches the exact packaged file and the configured development origin', () => {
    const local = resolveRendererLocation({
      isPackaged: true,
      rendererFile: '/tmp/anas/renderer/index.html'
    })
    expect(rendererLocationMatches(local, `${local.url}?query=1#section`)).toBe(true)
    expect(rendererLocationMatches(local, 'file:///tmp/anas/renderer/other.html')).toBe(false)

    const development = resolveRendererLocation({
      isPackaged: false,
      rendererFile: '/tmp/index.html',
      rendererUrl: 'http://127.0.0.1:5173/'
    })
    expect(rendererLocationMatches(development, 'http://127.0.0.1:5173/nested')).toBe(true)
    expect(rendererLocationMatches(development, 'http://127.0.0.1:5174/')).toBe(false)
  })
})

describe('IPC sender security', () => {
  beforeEach(() => {
    electronMocks.fromWebContents.mockReset()
    electronMocks.handle.mockReset()
  })

  it('accepts the registered main frame and rejects unregistered, child-frame, and wrong-location calls', () => {
    const location = resolveRendererLocation({
      isPackaged: true,
      rendererFile: '/tmp/anas/renderer/index.html'
    })
    const trusted = fakeWindow(location.url)
    registerMainRendererWindow(trusted.window as never, location)

    expect(() => assertTrustedIpcEvent(trusted.event as never)).not.toThrow()
    expect(() => assertTrustedIpcEvent({
      sender: trusted.webContents,
      senderFrame: { url: location.url }
    } as never)).toThrow('main frame')

    trusted.mainFrame.url = 'file:///tmp/anas/renderer/other.html'
    expect(() => assertTrustedIpcEvent(trusted.event as never)).toThrow('renderer location')

    trusted.mainFrame.url = location.url
    trusted.closed()
    expect(() => assertTrustedIpcEvent(trusted.event as never)).toThrow('registered main window')

    const unregistered = fakeWindow()
    expect(() => assertTrustedIpcEvent(unregistered.event as never)).toThrow('registered main window')
  })

  it('validates the sender before dispatching a registered handler', async () => {
    const listener = vi.fn(() => 'ok')
    handleMainIpc('security:test', listener)
    const registered = electronMocks.handle.mock.calls[0]?.[1]
    expect(registered).toBeTypeOf('function')

    const location = resolveRendererLocation({
      isPackaged: true,
      rendererFile: '/tmp/anas/renderer/index.html'
    })
    const trusted = fakeWindow(location.url)
    registerMainRendererWindow(trusted.window as never, location)
    expect(registered(trusted.event, 'argument')).toBe('ok')
    expect(listener).toHaveBeenCalledWith(trusted.event, 'argument')

    const untrusted = fakeWindow('https://attacker.example/')
    expect(() => registered(untrusted.event)).toThrow('registered main window')
  })

  it('gates every IPC operation that reads or writes managed application data', () => {
    for (const channel of [
      'agent:runs:submit',
      'memory:save',
      'config:updateSettings',
      'config:saveDefaultCapabilities',
      'projects:create',
      'skills:updateAvailability',
      'inputHistory:add',
      'mcp:test',
      'files:saveAvatarCrop',
      'files:openText',
      'files:readAttachmentPreview',
      'files:readAttachments',
      'files:readDroppedAttachments',
      'files:releaseTemporaryAttachments',
      'speech:listVoices',
      'app:backupData',
      'app:getLanguageResources',
      'app:getRuntimeTools',
      'app:openDataDir',
      'app:openDeveloperHttpTraceDir',
      'app:readHelp',
      'app:openLogDir',
      'app:openLogViewer',
      'app:restartInConsole',
      'app:openPath',
      'app:showItemInFolder'
    ]) {
      expect(ipcUsesApplicationData(channel), channel).toBe(true)
    }
    for (const channel of [
      'speech:generate',
      'speech:cancel',
      'app:restoreData',
      'app:selectDataRestoreBackup',
      'app:quit',
      'app:getBuildInfo',
      'app:toggleDevTools',
      'app:getIcon',
      'app:openExternalUrl',
      'app:detectSystemEnvironment',
      'files:chooseAvatarSource',
      'files:readAvatarSourceFromDroppedPaths',
      'files:readFileIcon',
      'files:showItemInFolder',
      'speech:logWarning'
    ]) {
      expect(ipcUsesApplicationData(channel), channel).toBe(false)
    }
  })

  it('keeps the complete ungated IPC handler inventory explicit', () => {
    const sources = [
      './appIpcHandlers.ts',
      './workspaceIpcHandlers.ts',
      './agent/agentIpcHandlers.ts'
    ].map((path) => readFileSync(new URL(path, import.meta.url), 'utf8'))
    const channels = sources.flatMap((source) => [...source.matchAll(
      /handle(?:Main|Agent)Ipc\('([^']+)'/g
    )].map((match) => match[1]!))
    const ungated = [...new Set(channels.filter((channel) => !ipcUsesApplicationData(channel)))]
      .sort()

    expect(ungated).toEqual([
      'app:detectSystemEnvironment',
      'app:getBuildInfo',
      'app:getIcon',
      'app:openExternalUrl',
      'app:quit',
      'app:restoreData',
      'app:selectDataRestoreBackup',
      'app:toggleDevTools',
      'files:chooseAvatarSource',
      'files:readAvatarSourceFromDroppedPaths',
      'files:readFileIcon',
      'files:showItemInFolder',
      'speech:logWarning'
    ])
  })
})

describe('renderer content security policy', () => {
  it('blocks unexpected scripts and forms while permitting configured model and media transports', () => {
    const html = readFileSync(new URL('../renderer/index.html', import.meta.url), 'utf8')
    const policy = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1]

    expect(policy).toContain("default-src 'self'")
    expect(policy).toContain("script-src 'self'")
    expect(policy).not.toContain("script-src 'self' 'unsafe-inline'")
    expect(policy).not.toContain('unsafe-eval')
    expect(policy).toContain("connect-src 'self' http: https: ws: wss:")
    expect(policy).toContain("img-src 'self' http: https: data: blob:")
    expect(policy).toContain("form-action 'none'")
    expect(policy).toContain("object-src 'none'")
    expect(policy).toContain("frame-src 'none'")
  })
})
