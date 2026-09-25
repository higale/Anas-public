import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createFromBitmap: vi.fn(),
  mkdir: vi.fn(),
  resize: vi.fn(),
  sourcePng: Buffer.from('source-png'),
  squareNativeImageFromPath: vi.fn(),
  writeFile: vi.fn()
}))

vi.mock('electron', () => ({
  nativeImage: { createFromBitmap: mocks.createFromBitmap }
}))

vi.mock('node:fs/promises', () => ({
  mkdir: mocks.mkdir,
  mkdtemp: vi.fn(),
  rm: vi.fn(),
  writeFile: mocks.writeFile
}))

vi.mock('./imageIconUtils', () => ({
  squareNativeImageFromPath: mocks.squareNativeImageFromPath
}))

import { createAvatarWindowsIco, writeAvatarDisplayPng } from './avatarIconGenerator'

describe('avatar icon generation', () => {
  beforeEach(() => {
    mocks.mkdir.mockReset().mockResolvedValue(undefined)
    mocks.resize.mockReset().mockImplementation(({ width, height }: { height: number; width: number }) => ({
      toBitmap: () => Buffer.alloc(width * height * 4),
      toPNG: () => Buffer.from([width & 0xff])
    }))
    mocks.squareNativeImageFromPath.mockReset().mockReturnValue({
      getSize: () => ({ width: 1024, height: 1024 }),
      resize: mocks.resize,
      toPNG: () => mocks.sourcePng
    })
    mocks.createFromBitmap.mockReset().mockImplementation((_bitmap, { width }: { width: number }) => ({
      toPNG: () => Buffer.from([width & 0xff])
    }))
    mocks.writeFile.mockReset().mockResolvedValue(undefined)
  })

  it('includes the Windows taskbar sizes required across DPI scales', () => {
    const ico = createAvatarWindowsIco('avatar.png')

    expect(ico.readUInt16LE(0)).toBe(0)
    expect(ico.readUInt16LE(2)).toBe(1)
    expect(ico.readUInt16LE(4)).toBe(9)
    const sizes = Array.from({ length: 9 }, (_, index) => {
      const value = ico.readUInt8(6 + index * 16)
      return value === 0 ? 256 : value
    })
    expect(sizes).toEqual([16, 20, 24, 32, 40, 48, 64, 128, 256])
  })

  it('keeps a smaller display avatar at its source resolution', async () => {
    mocks.squareNativeImageFromPath.mockReturnValueOnce({
      getSize: () => ({ width: 128, height: 128 }),
      resize: mocks.resize,
      toPNG: () => mocks.sourcePng
    })

    await writeAvatarDisplayPng('avatar.png', '/profile/avatar.png')

    expect(mocks.resize).not.toHaveBeenCalled()
    expect(mocks.writeFile).toHaveBeenCalledWith('/profile/avatar.png', mocks.sourcePng)
  })

  it('limits a larger display avatar to 512px', async () => {
    await writeAvatarDisplayPng('avatar.png', '/profile/avatar.png')

    expect(mocks.resize).toHaveBeenCalledWith({ width: 512, height: 512, quality: 'best' })
    expect(mocks.writeFile).toHaveBeenCalledWith('/profile/avatar.png', Buffer.from([0]))
  })
})
