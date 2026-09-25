import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AvatarTransform } from '@shared/types'

const mocks = vi.hoisted(() => ({
  generatedIco: Buffer.from('generated-windows-avatar-ico'),
  writeAvatarDisplayPng: vi.fn(),
  writeAvatarDockPng: vi.fn(),
  writeAvatarMacIcns: vi.fn()
}))

vi.mock('./avatarIconGenerator', () => ({
  assertAvatarImageReadable: vi.fn(),
  createAvatarWindowsIco: vi.fn(() => mocks.generatedIco),
  writeAvatarDisplayPng: mocks.writeAvatarDisplayPng,
  writeAvatarDockPng: mocks.writeAvatarDockPng,
  writeAvatarMacIcns: mocks.writeAvatarMacIcns
}))

import { findAvatarWindowsIconPath, initializeAvatarAssets, pruneAvatarWindowsIcons, readAvatarTransform, setAvatarCrop, setAvatarSourceCrop } from './avatarAssets'

const transform: AvatarTransform = {
  crop: { height: 80, width: 60, x: 20, y: 10 },
  rotation: 90
}

// Decoding/generation is mocked in this transaction suite. A small, distinct
// source tests byte preservation without repeatedly copying the bundled artwork.
const originalSource = Buffer.from('original avatar source bytes')

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

afterEach(() => {
  if (originalPlatformDescriptor) Object.defineProperty(process, 'platform', originalPlatformDescriptor)
})

beforeEach(() => {
  mocks.writeAvatarDisplayPng.mockReset().mockImplementation(async (_sourcePath: string, targetPath: string) => {
    await writeFile(targetPath, 'generated-display-avatar')
  })
  mocks.writeAvatarDockPng.mockReset().mockImplementation(async (_sourcePath: string, targetPath: string) => {
    await writeFile(targetPath, 'generated-dock-avatar')
  })
  mocks.writeAvatarMacIcns.mockReset().mockImplementation(async (_sourcePath: string, targetPath: string) => {
    await writeFile(targetPath, 'generated-mac-avatar')
  })
})

describe('Windows avatar icon assets', () => {
  it('preserves original, crop cache, and transform metadata in one transactional asset set', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const dataDir = await mkdtemp(join(tmpdir(), 'anas-original-avatar-'))
    const sourcePath = join(dataDir, 'selected-avatar.png')
    const source = originalSource

    try {
      await writeFile(sourcePath, source)
      const crop = Buffer.from('rendered crop')
      const assets = await setAvatarCrop(sourcePath, crop, transform, dataDir)

      expect(basename(assets.sourcePath)).toBe('avatar-source.png')
      expect(await readFile(assets.sourcePath)).toEqual(source)
      expect(await readFile(assets.cropPath)).toEqual(crop)
      expect(await readAvatarTransform(dataDir)).toEqual(transform)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('commits validated source bytes without rereading a mutable external file', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const dataDir = await mkdtemp(join(tmpdir(), 'anas-agent-avatar-'))
    const source = Buffer.from('validated original image')
    const crop = Buffer.from('centered crop')

    try {
      const assets = await setAvatarSourceCrop(
        join(dataDir, 'external-avatar.png'),
        source,
        crop,
        transform,
        dataDir
      )

      expect(await readFile(assets.sourcePath)).toEqual(source)
      expect(await readFile(assets.cropPath)).toEqual(crop)
      expect(await readAvatarTransform(dataDir)).toEqual(transform)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('writes and resolves the current ICO through its content-addressed path', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const dataDir = await mkdtemp(join(tmpdir(), 'anas-windows-avatar-'))
    const sourcePath = join(dataDir, 'selected-avatar.png')

    try {
      await writeFile(sourcePath, originalSource)
      const assets = await setAvatarCrop(sourcePath, Buffer.from('first crop'), transform, dataDir)

      expect(assets.windowsIconPath).toBeDefined()
      expect(basename(assets.windowsIconPath as string)).toMatch(/^avatar-win-v1-[0-9a-f]{16}\.ico$/)
      expect(await findAvatarWindowsIconPath(dataDir)).toBe(assets.windowsIconPath)

      const changedAssets = await setAvatarCrop(sourcePath, Buffer.from('different crop'), transform, dataDir)
      expect(changedAssets.windowsIconPath).not.toBe(assets.windowsIconPath)
      expect(await findAvatarWindowsIconPath(dataDir)).toBe(changedAssets.windowsIconPath)
      expect(existsSync(assets.windowsIconPath as string)).toBe(true)
      expect(existsSync(changedAssets.windowsIconPath as string)).toBe(true)

      await pruneAvatarWindowsIcons(changedAssets.windowsIconPath as string, dataDir)
      expect(existsSync(assets.windowsIconPath as string)).toBe(false)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('preserves the complete previous asset set when new asset generation fails', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const dataDir = await mkdtemp(join(tmpdir(), 'anas-transactional-avatar-'))

    try {
      const sourcePath = join(dataDir, 'selected-avatar.png')
      await writeFile(sourcePath, originalSource)
      await setAvatarCrop(sourcePath, Buffer.from('first crop'), transform, dataDir)
      const previousSource = await readFile(join(dataDir, 'assets', 'avatar-source.png'))
      const previousCrop = await readFile(join(dataDir, 'assets', 'avatar-crop.png'))
      const previousDisplay = await readFile(join(dataDir, 'assets', 'avatar.png'))
      mocks.writeAvatarDockPng.mockRejectedValueOnce(new Error('dock generation failed'))

      await expect(setAvatarCrop(sourcePath, Buffer.from('second crop'), transform, dataDir))
        .rejects.toThrow('dock generation failed')

      expect(await readFile(join(dataDir, 'assets', 'avatar-source.png'))).toEqual(previousSource)
      expect(await readFile(join(dataDir, 'assets', 'avatar-crop.png'))).toEqual(previousCrop)
      expect(await readFile(join(dataDir, 'assets', 'avatar.png'))).toEqual(previousDisplay)
      expect(await findAvatarWindowsIconPath(dataDir)).toBeDefined()
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})

describe('avatar asset transaction recovery', () => {
  it('restores the previous complete asset directory after an interrupted rollback', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const dataDir = await mkdtemp(join(tmpdir(), 'anas-avatar-recovery-'))
    const stagingDir = join(dataDir, '.avatar-assets-stage-interrupted')
    const previousDir = join(stagingDir, 'previous-assets')

    try {
      await mkdir(previousDir, { recursive: true })
      await writeFile(join(previousDir, 'avatar-source.png'), 'previous source')
      await writeFile(join(previousDir, 'avatar-crop.png'), 'previous crop')
      await writeFile(join(previousDir, 'avatar-transform.json'), `${JSON.stringify(transform)}\n`)
      await writeFile(join(previousDir, 'avatar.png'), 'previous display')
      await writeFile(join(previousDir, 'avatar-dock.png'), 'previous dock')

      const assets = await initializeAvatarAssets(dataDir)

      expect(await readFile(join(dataDir, 'assets', 'avatar-source.png'), 'utf8')).toBe('previous source')
      expect(await readFile(join(dataDir, 'assets', 'avatar.png'), 'utf8')).toBe('previous display')
      expect(assets?.sourcePath).toBe(join(dataDir, 'assets', 'avatar-source.png'))
      expect(existsSync(stagingDir)).toBe(false)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })

  it('discards an uncommitted first-install stage instead of installing partial assets', async () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const dataDir = await mkdtemp(join(tmpdir(), 'anas-avatar-partial-stage-'))
    const stagingDir = join(dataDir, '.avatar-assets-stage-partial')
    const stagedAssetDir = join(stagingDir, 'assets')

    try {
      await mkdir(stagedAssetDir, { recursive: true })
      await writeFile(join(stagedAssetDir, 'avatar-source.png'), 'partial source')

      await initializeAvatarAssets(dataDir)

      expect(await readFile(join(dataDir, 'assets', 'avatar-source.png'), 'utf8')).not.toBe('partial source')
      expect(existsSync(stagingDir)).toBe(false)
    } finally {
      await rm(dataDir, { recursive: true, force: true })
    }
  })
})
