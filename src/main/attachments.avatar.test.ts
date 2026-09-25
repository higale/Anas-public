import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AvatarCropSaveRequest, AvatarTransform } from '@shared/types'
import { runWithCurrentAgentToolEffect } from './agent/toolEffectScope'

const transform: AvatarTransform = {
  crop: { height: 80, width: 60, x: 20, y: 10 },
  rotation: 90
}

const mocks = vi.hoisted(() => ({
  applyProfileIcon: vi.fn(),
  createFromBuffer: vi.fn(),
  findAvatarSourceImage: vi.fn(),
  readAvatarImage: vi.fn(),
  readAvatarTransform: vi.fn(),
  resetAvatarAssetsToDefault: vi.fn(),
  setAvatarCrop: vi.fn(),
  setAvatarSourceCrop: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getFileIcon: vi.fn() },
  nativeImage: {
    createFromBuffer: mocks.createFromBuffer,
    createThumbnailFromPath: vi.fn()
  }
}))

vi.mock('./avatarAssets', () => ({
  findAvatarSourceImage: mocks.findAvatarSourceImage,
  isAvatarImageExtension: (extension: string) => extension === '.png',
  readAvatarImage: mocks.readAvatarImage,
  readAvatarTransform: mocks.readAvatarTransform,
  resetAvatarAssetsToDefault: mocks.resetAvatarAssetsToDefault,
  setAvatarCrop: mocks.setAvatarCrop,
  setAvatarSourceCrop: mocks.setAvatarSourceCrop
}))

vi.mock('./profileIconService', () => ({
  applyProfileIcon: mocks.applyProfileIcon
}))

import { clearAvatarImage, onAvatarChanged, readAvatarCropSource, readAvatarCropSourceResult, readCurrentAvatarCropSource, saveAvatarCrop, setAvatarImageFromSource } from './attachments'

function avatarCropHeader(width = 1024, height = 1024): Uint8Array {
  const png = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
  png.writeUInt32BE(13, 8)
  png.write('IHDR', 12, 'ascii')
  png.writeUInt32BE(width, 16)
  png.writeUInt32BE(height, 20)
  return png
}

function cropRequest(sourcePath: string, pngBytes: Uint8Array = avatarCropHeader()): AvatarCropSaveRequest {
  return { pngBytes, sourcePath, transform }
}

describe('avatar crop persistence and system icon refresh', () => {
  let root = ''
  let sourcePath = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'anas-avatar-refresh-'))
    sourcePath = join(root, 'avatar.png')
    await copyFile(join(process.cwd(), 'data/assets/avatar-source.png'), sourcePath)
    mocks.applyProfileIcon.mockReset()
    mocks.createFromBuffer.mockReset().mockReturnValue({
      getSize: () => ({ width: 1024, height: 1024 }),
      isEmpty: () => false,
      toPNG: () => Buffer.from('normalized-avatar')
    })
    mocks.findAvatarSourceImage.mockReset().mockResolvedValue(sourcePath)
    mocks.readAvatarImage.mockReset().mockResolvedValue(null)
    mocks.readAvatarTransform.mockReset().mockResolvedValue(transform)
    mocks.resetAvatarAssetsToDefault.mockReset().mockResolvedValue(undefined)
    mocks.setAvatarCrop.mockReset().mockResolvedValue(undefined)
    mocks.setAvatarSourceCrop.mockReset().mockResolvedValue(undefined)
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('returns a selected source without a transform and the current source with its transform', async () => {
    const selected = await readAvatarCropSource(sourcePath)
    const current = await readCurrentAvatarCropSource()

    expect(selected.transform).toBeUndefined()
    expect(selected.path).toBe(sourcePath)
    expect(selected.dataUri).toMatch(/^data:image\/png;base64,/)
    expect(current).toMatchObject({ path: sourcePath, transform })
  })

  it('returns stable error codes for dropped avatar source failures', async () => {
    await expect(readAvatarCropSourceResult(join(root, 'avatar.txt'))).resolves.toEqual({
      ok: false,
      errorCode: 'unsupported_type'
    })
    await expect(readAvatarCropSourceResult(undefined)).resolves.toEqual({
      ok: false,
      errorCode: 'load_failed'
    })
  })

  it('stores the original source, normalized crop cache, and transform before refreshing the icon', async () => {
    mocks.createFromBuffer.mockReturnValueOnce({
      getSize: () => ({ width: 320, height: 320 }),
      isEmpty: () => false,
      toPNG: () => Buffer.from('normalized-avatar')
    })

    await saveAvatarCrop(cropRequest(sourcePath, avatarCropHeader(320, 320)))

    expect(mocks.setAvatarCrop).toHaveBeenCalledWith(sourcePath, Buffer.from('normalized-avatar'), transform)
    expect(mocks.applyProfileIcon).toHaveBeenCalledOnce()
    expect(mocks.setAvatarCrop.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.applyProfileIcon.mock.invocationCallOrder[0])
  })

  it('center-crops an agent-selected source and broadcasts the committed avatar', async () => {
    const cropImage = {
      resize: vi.fn(),
      toPNG: () => avatarCropHeader(900, 900)
    }
    const crop = vi.fn(() => cropImage)
    mocks.createFromBuffer
      .mockReset()
      .mockReturnValueOnce({
        crop,
        getSize: () => ({ width: 1200, height: 900 }),
        isEmpty: () => false
      })
      .mockReturnValueOnce({
        getSize: () => ({ width: 900, height: 900 }),
        isEmpty: () => false,
        toPNG: () => Buffer.from('normalized-agent-avatar')
      })
    const nextAvatar = {
      dataUri: 'data:image/png;base64,AQ==',
      mimeType: 'image/png',
      path: '/avatar.png',
      source: 'custom' as const
    }
    mocks.readAvatarImage.mockResolvedValueOnce(nextAvatar)
    const listener = vi.fn()
    const unsubscribe = onAvatarChanged(listener)
    const effects: import('./agent/toolEffectScope').AgentToolEffectArm[] = []

    await expect(runWithCurrentAgentToolEffect({
      arm: (effect) => effects.push(effect)
    }, () => setAvatarImageFromSource(sourcePath))).resolves.toEqual(nextAvatar)

    expect(crop).toHaveBeenCalledWith({ x: 150, y: 0, width: 900, height: 900 })
    expect(cropImage.resize).not.toHaveBeenCalled()
    expect(mocks.setAvatarSourceCrop).toHaveBeenCalledWith(
      sourcePath,
      expect.any(Buffer),
      Buffer.from('normalized-agent-avatar'),
      {
        crop: { height: 100, width: 75, x: 12.5, y: 0 },
        rotation: 0
      }
    )
    expect(effects).toEqual([expect.objectContaining({
      kind: 'avatar_update',
      recoveryMode: 'idempotent',
      idempotencyFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      target: {
        path: sourcePath,
        sourceFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    })])
    expect(listener).toHaveBeenCalledWith(nextAvatar)
    unsubscribe()
  })

  it('rejects invalid transform metadata before replacing avatar assets', async () => {
    await expect(saveAvatarCrop({
      ...cropRequest(sourcePath),
      transform: { crop: { height: 80, width: 80, x: 30, y: 10 }, rotation: 45 }
    })).rejects.toThrow('avatar.transform.crop must stay within the source image percentage bounds.')

    expect(mocks.setAvatarCrop).not.toHaveBeenCalled()
    expect(mocks.applyProfileIcon).not.toHaveBeenCalled()
  })

  it('rejects oversized, non-square, and empty PNG dimensions before decoding', async () => {
    await expect(saveAvatarCrop(cropRequest(sourcePath, avatarCropHeader(4096, 4096)))).rejects.toThrow(
      'Avatar crop must be square and no larger than 1024 by 1024 pixels.'
    )
    await expect(saveAvatarCrop(cropRequest(sourcePath, avatarCropHeader(512, 256)))).rejects.toThrow(
      'Avatar crop must be square and no larger than 1024 by 1024 pixels.'
    )
    await expect(saveAvatarCrop(cropRequest(sourcePath, avatarCropHeader(0, 0)))).rejects.toThrow(
      'Avatar crop must be square and no larger than 1024 by 1024 pixels.'
    )

    expect(mocks.createFromBuffer).not.toHaveBeenCalled()
    expect(mocks.setAvatarCrop).not.toHaveBeenCalled()
  })

  it('rejects malformed requests and crop payloads before decoding', async () => {
    await expect(saveAvatarCrop([1, 2, 3])).rejects.toThrow('Avatar crop request must be an object.')
    await expect(saveAvatarCrop(cropRequest(sourcePath, new Uint8Array(24)))).rejects.toThrow(
      'Avatar crop must be a PNG image.'
    )
    await expect(saveAvatarCrop(cropRequest(sourcePath, new Uint8Array(8 * 1024 * 1024 + 1)))).rejects.toThrow(
      'Avatar crop must be 8 MB or smaller.'
    )

    expect(mocks.createFromBuffer).not.toHaveBeenCalled()
    expect(mocks.setAvatarCrop).not.toHaveBeenCalled()
  })

  it('rejects a PNG that cannot be decoded without replacing the current avatar', async () => {
    mocks.createFromBuffer.mockReturnValueOnce({
      getSize: () => ({ width: 0, height: 0 }),
      isEmpty: () => true,
      toPNG: vi.fn()
    })

    await expect(saveAvatarCrop(cropRequest(sourcePath))).rejects.toThrow('Avatar crop could not be decoded.')

    expect(mocks.setAvatarCrop).not.toHaveBeenCalled()
    expect(mocks.applyProfileIcon).not.toHaveBeenCalled()
  })

  it('refreshes the system icon after restoring default avatar assets', async () => {
    await clearAvatarImage()

    expect(mocks.resetAvatarAssetsToDefault).toHaveBeenCalledOnce()
    expect(mocks.applyProfileIcon).toHaveBeenCalledOnce()
  })
})
