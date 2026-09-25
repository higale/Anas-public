import { BrowserWindow, Menu, type IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleMainIpc } from '../ipcSecurity'
import { runtimeLog } from '../runtimeLogger'
import { registerSpeechInputIpc } from './speechInputIpc'
import { openWindowsVoiceInput } from './windowsVoiceInput'

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  Menu: { sendActionToFirstResponder: vi.fn() }
}))
vi.mock('../ipcSecurity', () => ({ handleMainIpc: vi.fn() }))
vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
vi.mock('./windowsVoiceInput', () => ({ openWindowsVoiceInput: vi.fn(() => 'requested') }))

beforeEach(() => registerSpeechInputIpc())
afterEach(() => vi.unstubAllGlobals())

describe.each(['win32', 'darwin'])('system voice input IPC on %s', (platform) => {
  beforeEach(() => vi.stubGlobal('process', { ...process, platform }))

  function fixture() {
    const handle = Buffer.alloc(8)
    const owner = { isDestroyed: () => false, isFocused: vi.fn(() => true), getNativeWindowHandle: () => handle }
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValue(owner as unknown as BrowserWindow)
    const event = { sender: { isFocused: vi.fn(() => true) } }
    const invoke = () => vi.mocked(handleMainIpc).mock.calls[0][1](event as unknown as IpcMainInvokeEvent)
    return { owner, event, invoke, handle }
  }

  it('registers only the stateless request and resolves the target from the sender', () => {
    const f = fixture()
    expect(vi.mocked(handleMainIpc).mock.calls.map(([channel]) => channel)).toEqual(['speech:openInput'])
    expect(f.invoke()).toBe('requested')
    if (platform === 'win32') {
      expect(openWindowsVoiceInput).toHaveBeenCalledExactlyOnceWith(f.handle)
      expect(Menu.sendActionToFirstResponder).not.toHaveBeenCalled()
    } else {
      expect(Menu.sendActionToFirstResponder).toHaveBeenCalledExactlyOnceWith('startDictation:')
      expect(openWindowsVoiceInput).not.toHaveBeenCalled()
    }
  })

  it('does not request dictation from an unfocused window or renderer', () => {
    const f = fixture()
    f.owner.isFocused.mockReturnValue(false)
    expect(f.invoke()).toBe('not_focused')
    f.owner.isFocused.mockReturnValue(true)
    f.event.sender.isFocused.mockReturnValue(false)
    expect(f.invoke()).toBe('not_focused')
    expect(openWindowsVoiceInput).not.toHaveBeenCalled()
    expect(Menu.sendActionToFirstResponder).not.toHaveBeenCalled()
  })

  it('does not request dictation for a missing or destroyed window', () => {
    const f = fixture()
    vi.mocked(BrowserWindow.fromWebContents).mockReturnValueOnce(null)
    expect(f.invoke()).toBe('not_focused')
    vi.spyOn(f.owner, 'isDestroyed').mockReturnValue(true)
    expect(f.invoke()).toBe('not_focused')
    expect(openWindowsVoiceInput).not.toHaveBeenCalled()
    expect(Menu.sendActionToFirstResponder).not.toHaveBeenCalled()
  })

  it('keeps native failures out of the renderer response', () => {
    const f = fixture()
    const nativeCall = platform === 'win32' ? openWindowsVoiceInput : Menu.sendActionToFirstResponder
    vi.mocked(nativeCall).mockImplementationOnce(() => { throw new Error('native request failed') })
    expect(f.invoke()).toBe('failed')
    expect(runtimeLog).toHaveBeenCalledOnce()
  })
})

it('rejects unsupported platforms before resolving a window', () => {
  vi.stubGlobal('process', { ...process, platform: 'linux' })
  expect(vi.mocked(handleMainIpc).mock.calls[0][1]({} as IpcMainInvokeEvent)).toBe('unsupported')
  expect(BrowserWindow.fromWebContents).not.toHaveBeenCalled()
  expect(Menu.sendActionToFirstResponder).not.toHaveBeenCalled()
  expect(openWindowsVoiceInput).not.toHaveBeenCalled()
})
