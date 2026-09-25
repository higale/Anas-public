import { createRequire } from 'node:module'
import type { SpeechInputOpenResult } from '@shared/speechInput'

const requireNative = createRequire(import.meta.url)
const keyUp = 0x0002
const extendedKey = 0x0001
const leftWindowsKey = 0x5b
const hKey = 0x48

interface KeyInput { key: number; flags: number }
export interface WindowsVoiceInputBindings {
  getForegroundWindow(): number | bigint
  getAsyncKeyState(key: number): number
  sendKeys(keys: KeyInput[]): number
}

let cachedBindings: WindowsVoiceInputBindings | undefined

export function createWindowsVoiceInputBindings(): WindowsVoiceInputBindings {
  const koffi = requireNative('koffi') as typeof import('koffi').default
  // Include every INPUT union member so Koffi computes the Windows ABI's size
  // and alignment correctly on both 32-bit and 64-bit architectures.
  const keyboard = koffi.struct({
    wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t'
  })
  const input = koffi.struct({
    type: 'uint32',
    data: koffi.union({
      ki: keyboard,
      mi: koffi.struct({
        dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t'
      }),
      hi: koffi.struct({ uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' })
    })
  })
  const user32 = koffi.load('user32.dll')
  const sendInput = user32.func('__stdcall', 'SendInput', 'uint32', ['uint32', 'void *', 'int'])
  const keyboardOffset = input.members!.data.offset
  return {
    getForegroundWindow: user32.func('__stdcall', 'GetForegroundWindow', 'uintptr_t', []),
    getAsyncKeyState: user32.func('__stdcall', 'GetAsyncKeyState', 'int16', ['int']),
    sendKeys(keys) {
      const buffer = Buffer.alloc(input.size * keys.length)
      keys.forEach(({ key, flags }, index) => {
        const offset = index * input.size
        buffer.writeUInt32LE(1, offset + input.members!.type.offset) // INPUT_KEYBOARD
        buffer.writeUInt16LE(key, offset + keyboardOffset + keyboard.members!.wVk.offset)
        buffer.writeUInt32LE(flags, offset + keyboardOffset + keyboard.members!.dwFlags.offset)
      })
      return sendInput(keys.length, buffer, input.size)
    }
  }
}

export function openWindowsVoiceInput(
  windowHandle: Buffer,
  getBindings = (): WindowsVoiceInputBindings => (cachedBindings ??= createWindowsVoiceInputBindings()),
  platform = process.platform
): SpeechInputOpenResult {
  if (platform !== 'win32') return 'unsupported'
  const target = windowHandle.length === 8 ? windowHandle.readBigUInt64LE()
    : windowHandle.length === 4 ? BigInt(windowHandle.readUInt32LE()) : 0n
  if (!target) return 'not_focused'
  const native = getBindings()
  // Never release keys the user is holding or combine their modifiers with Win+H.
  if ([0x10, 0x11, 0x12, leftWindowsKey, 0x5c, hKey].some((key) => native.getAsyncKeyState(key) & 0x8000)) {
    return 'keys_held'
  }
  // No focus stealing, delayed key injection, or automatic retry. Recheck the
  // actual foreground HWND immediately before the single native input batch.
  if (BigInt(native.getForegroundWindow()) !== target) return 'not_focused'
  const sent = native.sendKeys([
    { key: leftWindowsKey, flags: extendedKey },
    { key: hKey, flags: 0 },
    { key: hKey, flags: keyUp },
    { key: leftWindowsKey, flags: extendedKey | keyUp }
  ])
  if (sent === 4) return 'requested'
  // A partial batch must not leave our synthetic modifiers pressed. Only send
  // key-up events for the keys whose key-down was accepted by Windows.
  if (sent > 0) native.sendKeys([
    ...(sent === 2 ? [{ key: hKey, flags: keyUp }] : []),
    { key: leftWindowsKey, flags: extendedKey | keyUp }
  ])
  return 'failed'
}
