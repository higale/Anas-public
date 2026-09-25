import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { createWindowsVoiceInputBindings, openWindowsVoiceInput, type WindowsVoiceInputBindings } from './windowsVoiceInput'

const koffi = createRequire(import.meta.url)('koffi') as typeof import('koffi').default

function fixture(sent = 4) {
  const handle = Buffer.alloc(8)
  handle.writeBigUInt64LE(123n)
  const native = {
    getForegroundWindow: vi.fn(() => 123n),
    getAsyncKeyState: vi.fn<WindowsVoiceInputBindings['getAsyncKeyState']>().mockReturnValue(0),
    sendKeys: vi.fn<WindowsVoiceInputBindings['sendKeys']>().mockReturnValue(sent)
  }
  const getBindings = vi.fn(() => native)
  return { handle, native, getBindings }
}

describe('Windows voice typing shortcut', () => {
  it('sends one complete Win+H batch to the matching foreground window', () => {
    const f = fixture()
    expect(openWindowsVoiceInput(f.handle, f.getBindings, 'win32')).toBe('requested')
    expect(f.native.sendKeys).toHaveBeenCalledExactlyOnceWith([
      { key: 0x5b, flags: 1 }, { key: 0x48, flags: 0 },
      { key: 0x48, flags: 2 }, { key: 0x5b, flags: 3 }
    ])
  })

  it('does not load Windows libraries on macOS or for a missing target', () => {
    const f = fixture()
    expect(openWindowsVoiceInput(f.handle, f.getBindings, 'darwin')).toBe('unsupported')
    expect(openWindowsVoiceInput(Buffer.alloc(0), f.getBindings, 'win32')).toBe('not_focused')
    expect(f.getBindings).not.toHaveBeenCalled()
  })

  it('rejects a changed foreground window without stealing focus or sending keys', () => {
    const f = fixture()
    f.native.getForegroundWindow.mockReturnValue(456n)
    expect(openWindowsVoiceInput(f.handle, f.getBindings, 'win32')).toBe('not_focused')
    expect(f.native.sendKeys).not.toHaveBeenCalled()
  })

  it.each([0x10, 0x11, 0x12, 0x5b, 0x5c, 0x48])('leaves user-held key %i untouched', (held) => {
    const f = fixture()
    f.native.getAsyncKeyState.mockImplementation((key) => key === held ? -32768 : 0)
    expect(openWindowsVoiceInput(f.handle, f.getBindings, 'win32')).toBe('keys_held')
    expect(f.native.sendKeys).not.toHaveBeenCalled()
  })

  it.each([0, 1, 2, 3])('handles partial delivery of %i keys without retrying the shortcut', (sent) => {
    const f = fixture(sent)
    expect(openWindowsVoiceInput(f.handle, f.getBindings, 'win32')).toBe('failed')
    expect(f.native.sendKeys).toHaveBeenCalledTimes(sent ? 2 : 1)
    if (sent) expect(f.native.sendKeys.mock.calls[1][0]).toEqual([
      ...(sent === 2 ? [{ key: 0x48, flags: 2 }] : []),
      { key: 0x5b, flags: 3 }
    ])
  })

  it('encodes correctly aligned Win32 INPUT records using the existing Koffi dependency', () => {
    const sendInput = vi.fn(() => 2)
    const load = vi.spyOn(koffi, 'load').mockReturnValue({
      func: (_convention: string, name: string) => name === 'SendInput' ? sendInput : vi.fn()
    } as unknown as ReturnType<typeof koffi.load>)
    let native: WindowsVoiceInputBindings
    try {
      native = createWindowsVoiceInputBindings()
    } finally {
      load.mockRestore()
    }
    native.sendKeys([{ key: 0x5b, flags: 1 }, { key: 0x48, flags: 2 }])
    const [count, bytes, size] = sendInput.mock.calls[0] as unknown as [number, Buffer, number]
    const is64Bit = koffi.sizeof('uintptr_t') === 8
    expect(count).toBe(2)
    expect(size).toBe(is64Bit ? 40 : 28)
    expect(bytes.length).toBe(2 * size)
    const unionOffset = is64Bit ? 8 : 4
    expect(bytes.readUInt32LE(0)).toBe(1)
    expect(bytes.readUInt16LE(unionOffset)).toBe(0x5b)
    expect(bytes.readUInt32LE(unionOffset + 4)).toBe(1)
    expect(bytes.readUInt32LE(size)).toBe(1)
    expect(bytes.readUInt16LE(size + unionOffset)).toBe(0x48)
    expect(bytes.readUInt32LE(size + unionOffset + 4)).toBe(2)
  })

  it.runIf(process.platform === 'win32')('loads the real bindings without generating any keyboard input', () => {
    const native = createWindowsVoiceInputBindings()
    expect(BigInt(native.getForegroundWindow())).toBeGreaterThanOrEqual(0n)
    expect(typeof native.getAsyncKeyState(0x48)).toBe('number')
    expect(native.sendKeys([])).toBe(0)
  })
})
