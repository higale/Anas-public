import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, resolve } from 'node:path'
import { getBundledDataDir, getDataDir } from './config/dataDir'
import { runtimeLog } from './runtimeLogger'
import { assertAvatarImageReadable, createAvatarWindowsIco, writeAvatarDisplayPng, writeAvatarDockPng, writeAvatarMacIcns } from './avatarIconGenerator'
import { avatarTransformsEqual, defaultAvatarTransform, requireAvatarTransform } from '@shared/avatar'
import type { AppAvatarImage, AvatarTransform } from '@shared/types'

export const avatarImageExtensions = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']

const avatarSourceBaseName = 'avatar-source'
const avatarCropFileName = 'avatar-crop.png'
const avatarTransformFileName = 'avatar-transform.json'
const avatarDisplayFileName = 'avatar.png'
const avatarDockIconFileName = 'avatar-dock.png'
const avatarMacIconFileName = 'avatar.icns'
const avatarWindowsIconRevision = 'v1'
const avatarWindowsIconPrefix = `avatar-win-${avatarWindowsIconRevision}-`
const avatarWindowsIconPattern = /^avatar-win-v\d+-[0-9a-f]{16}\.ico$/
const obsoleteAvatarWindowsIconFileName = 'avatar.ico'
const avatarStagingDirPrefix = '.avatar-assets-stage-'
const avatarPreviousDirName = 'previous-assets'

export interface AvatarAssets {
  sourcePath: string
  cropPath: string
  transformPath: string
  displayPath: string
  dockIconPath: string
  macIconPath: string
  windowsIconPath?: string
}

class AvatarAssetRollbackError extends AggregateError {}

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

export function avatarAssetDir(dataDir = getDataDir()): string {
  return join(dataDir, 'assets')
}

export function avatarDisplayImagePath(dataDir = getDataDir()): string {
  return join(avatarAssetDir(dataDir), avatarDisplayFileName)
}

export function avatarCropImagePath(dataDir = getDataDir()): string {
  return join(avatarAssetDir(dataDir), avatarCropFileName)
}

export function avatarTransformPath(dataDir = getDataDir()): string {
  return join(avatarAssetDir(dataDir), avatarTransformFileName)
}

export function avatarMacIconPath(dataDir = getDataDir()): string {
  return join(avatarAssetDir(dataDir), avatarMacIconFileName)
}

export function avatarDockIconPath(dataDir = getDataDir()): string {
  return join(avatarAssetDir(dataDir), avatarDockIconFileName)
}

function isAvatarWindowsIconFileName(name: string): boolean {
  return avatarWindowsIconPattern.test(name.toLowerCase())
}

async function findAvatarWindowsIconPaths(dataDir = getDataDir()): Promise<string[]> {
  try {
    const files = await readdir(avatarAssetDir(dataDir))
    return files
      .filter(isAvatarWindowsIconFileName)
      .sort()
      .map((name) => join(avatarAssetDir(dataDir), name))
  } catch (reason) {
    if (isMissingPath(reason)) return []
    throw reason
  }
}

export async function findAvatarWindowsIconPath(dataDir = getDataDir()): Promise<string | undefined> {
  const cropPath = avatarCropImagePath(dataDir)
  if (!(await pathExists(cropPath))) return undefined
  const expectedPath = await avatarWindowsIconPathForCrop(cropPath, dataDir)
  return await pathExists(expectedPath) ? expectedPath : undefined
}

export function avatarMimeType(path: string): string {
  const ext = extname(path).toLowerCase()
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.bmp') return 'image/bmp'
  return 'image/png'
}

export function isAvatarImageExtension(ext: string): boolean {
  return avatarImageExtensions.includes(ext.toLowerCase())
}

function isAvatarSourceFileName(name: string): boolean {
  const ext = extname(name).toLowerCase()
  return isAvatarImageExtension(ext) && name.toLowerCase() === `${avatarSourceBaseName}${ext}`
}

function avatarSourceSortIndex(path: string): number {
  const index = avatarImageExtensions.indexOf(extname(path).toLowerCase())
  return index >= 0 ? index : avatarImageExtensions.length
}

async function findAvatarSourceImages(dataDir = getDataDir()): Promise<string[]> {
  try {
    const files = await readdir(avatarAssetDir(dataDir))
    return files
      .filter(isAvatarSourceFileName)
      .map((name) => join(avatarAssetDir(dataDir), name))
      .sort((a, b) => avatarSourceSortIndex(a) - avatarSourceSortIndex(b))
  } catch (reason) {
    if (isMissingPath(reason)) return []
    throw reason
  }
}

export async function findAvatarSourceImage(dataDir = getDataDir()): Promise<string | undefined> {
  const [filePath] = await findAvatarSourceImages(dataDir)
  return filePath
}

export async function findBundledDefaultAvatarImage(): Promise<string | undefined> {
  return findAvatarSourceImage(getBundledDataDir())
}

export async function pruneAvatarWindowsIcons(currentPath: string, dataDir = getDataDir()): Promise<void> {
  const otherPaths = (await findAvatarWindowsIconPaths(dataDir)).filter((path) => path !== currentPath)
  await Promise.all(otherPaths.map((path) => rm(path, { force: true })))
  await rm(join(avatarAssetDir(dataDir), obsoleteAvatarWindowsIconFileName), { force: true })
}

async function avatarWindowsIconPathForCrop(cropPath: string, dataDir = getDataDir()): Promise<string> {
  const digest = createHash('sha256')
    .update(avatarWindowsIconRevision)
    .update('\0')
    .update(await readFile(cropPath))
    .digest('hex')
    .slice(0, 16)
  return join(avatarAssetDir(dataDir), `${avatarWindowsIconPrefix}${digest}.ico`)
}

async function writeDerivedAvatarAssets(
  sourcePath: string,
  cropPath: string,
  transformPath: string,
  dataDir = getDataDir()
): Promise<AvatarAssets> {
  const displayPath = avatarDisplayImagePath(dataDir)
  const dockIconPath = avatarDockIconPath(dataDir)
  const macIconPath = avatarMacIconPath(dataDir)
  let windowsIconPath: string | undefined

  await writeAvatarDisplayPng(cropPath, displayPath)
  await writeAvatarDockPng(cropPath, dockIconPath)
  if (process.platform === 'win32') {
    const icon = createAvatarWindowsIco(cropPath)
    windowsIconPath = await avatarWindowsIconPathForCrop(cropPath, dataDir)
    await writeFile(windowsIconPath, icon)
  }
  if (process.platform === 'darwin') {
    try {
      await writeAvatarMacIcns(cropPath, macIconPath)
    } catch (reason) {
      await rm(macIconPath, { force: true })
      runtimeLog('warn', 'profile', 'Failed to generate avatar icns.', { error: reason })
    }
  }

  return {
    sourcePath,
    cropPath,
    transformPath,
    displayPath,
    dockIconPath,
    macIconPath,
    windowsIconPath
  }
}

async function copyExistingWindowsIconsToStage(stagingDataDir: string, dataDir: string): Promise<void> {
  const stagingAssetDir = avatarAssetDir(stagingDataDir)
  for (const sourcePath of await findAvatarWindowsIconPaths(dataDir)) {
    const targetPath = join(stagingAssetDir, basename(sourcePath))
    if (!(await pathExists(targetPath))) await copyFile(sourcePath, targetPath)
  }
}

async function recoverInterruptedAvatarAssetSwap(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  const entries = await readdir(dataDir, { withFileTypes: true })
  const stagingDirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(avatarStagingDirPrefix))
    .map((entry) => join(dataDir, entry.name))

  for (const stagingDir of stagingDirs) {
    const liveDir = avatarAssetDir(dataDir)
    const previousDir = join(stagingDir, avatarPreviousDirName)
    try {
      if (!(await pathExists(liveDir))) {
        if (await pathExists(previousDir)) await rename(previousDir, liveDir)
      }
      await rm(stagingDir, { recursive: true, force: true })
    } catch (reason) {
      runtimeLog('warn', 'profile', 'Failed to recover interrupted avatar asset update.', {
        error: reason,
        stagingDir
      })
      // Do not install defaults over a recoverable custom avatar. Keep the staged
      // previous directory intact so a later startup can retry the rename.
      if (!(await pathExists(liveDir))) throw reason
    }
  }
}

async function commitStagedAvatarAssets(stagingDataDir: string, dataDir: string): Promise<void> {
  const liveDir = avatarAssetDir(dataDir)
  const stagedDir = avatarAssetDir(stagingDataDir)
  const previousDir = join(stagingDataDir, avatarPreviousDirName)
  const hadLiveAssets = await pathExists(liveDir)

  if (hadLiveAssets) await rename(liveDir, previousDir)
  try {
    await rename(stagedDir, liveDir)
  } catch (reason) {
    if (hadLiveAssets) {
      try {
        await rename(previousDir, liveDir)
      } catch (rollbackReason) {
        throw new AvatarAssetRollbackError([reason, rollbackReason], 'Avatar asset update and rollback both failed.')
      }
    }
    throw reason
  }

  try {
    await rm(stagingDataDir, { recursive: true, force: true })
  } catch (reason) {
    runtimeLog('warn', 'profile', 'Failed to remove previous avatar assets after a successful update.', {
      error: reason,
      stagingDir: stagingDataDir
    })
  }
}

async function replaceAvatarAssets(
  extension: string,
  writeSource: (targetPath: string) => Promise<void>,
  writeCrop: (targetPath: string) => Promise<void>,
  transform: AvatarTransform,
  dataDir: string
): Promise<AvatarAssets> {
  const normalizedTransform = requireAvatarTransform(transform)
  await mkdir(dataDir, { recursive: true })
  const stagingDataDir = await mkdtemp(join(dataDir, avatarStagingDirPrefix))
  const stagingAssetDir = avatarAssetDir(stagingDataDir)
  const stagingSourcePath = join(stagingAssetDir, `${avatarSourceBaseName}${extension}`)
  const stagingCropPath = avatarCropImagePath(stagingDataDir)
  const stagingTransformPath = avatarTransformPath(stagingDataDir)

  try {
    await mkdir(stagingAssetDir, { recursive: true })
    await writeSource(stagingSourcePath)
    await writeCrop(stagingCropPath)
    await writeFile(stagingTransformPath, `${JSON.stringify(normalizedTransform, null, 2)}\n`)
    assertAvatarImageReadable(stagingSourcePath)
    assertAvatarImageReadable(stagingCropPath)
    await writeDerivedAvatarAssets(stagingSourcePath, stagingCropPath, stagingTransformPath, stagingDataDir)
    await copyExistingWindowsIconsToStage(stagingDataDir, dataDir)
    await commitStagedAvatarAssets(stagingDataDir, dataDir)
  } catch (reason) {
    if (!(reason instanceof AvatarAssetRollbackError)) {
      await rm(stagingDataDir, { recursive: true, force: true }).catch(() => undefined)
    }
    throw reason
  }

  const sourcePath = join(avatarAssetDir(dataDir), `${avatarSourceBaseName}${extension}`)
  return {
    sourcePath,
    cropPath: avatarCropImagePath(dataDir),
    transformPath: avatarTransformPath(dataDir),
    displayPath: avatarDisplayImagePath(dataDir),
    dockIconPath: avatarDockIconPath(dataDir),
    macIconPath: avatarMacIconPath(dataDir),
    windowsIconPath: await findAvatarWindowsIconPath(dataDir)
  }
}

async function avatarAssetsAreComplete(dataDir = getDataDir()): Promise<boolean> {
  const requiredPaths = [
    avatarCropImagePath(dataDir),
    avatarTransformPath(dataDir),
    avatarDisplayImagePath(dataDir),
    avatarDockIconPath(dataDir)
  ]
  const existing = await Promise.all(requiredPaths.map(pathExists))
  if (!existing.every(Boolean)) return false
  try {
    await readAvatarTransform(dataDir)
  } catch {
    return false
  }
  if (process.platform === 'win32') {
    const windowsIconPath = await avatarWindowsIconPathForCrop(avatarCropImagePath(dataDir), dataDir)
    if (!(await pathExists(windowsIconPath))) return false
  }
  if (process.platform === 'darwin' && !(await pathExists(avatarMacIconPath(dataDir)))) return false
  return true
}

export async function initializeAvatarAssets(dataDir = getDataDir()): Promise<AvatarAssets | undefined> {
  await recoverInterruptedAvatarAssetSwap(dataDir)
  const currentSourcePath = await findAvatarSourceImage(dataDir)
  if (currentSourcePath && await avatarAssetsAreComplete(dataDir)) {
    return {
      sourcePath: currentSourcePath,
      cropPath: avatarCropImagePath(dataDir),
      transformPath: avatarTransformPath(dataDir),
      displayPath: avatarDisplayImagePath(dataDir),
      dockIconPath: avatarDockIconPath(dataDir),
      macIconPath: avatarMacIconPath(dataDir),
      windowsIconPath: await findAvatarWindowsIconPath(dataDir)
    }
  }

  const sourcePath = currentSourcePath ?? await findBundledDefaultAvatarImage()
  if (!sourcePath) return undefined
  const extension = extname(sourcePath).toLowerCase()
  return replaceAvatarAssets(
    extension,
    (targetPath) => copyFile(sourcePath, targetPath),
    (targetPath) => copyFile(sourcePath, targetPath),
    defaultAvatarTransform,
    dataDir
  )
}

export async function setAvatarCrop(
  sourcePath: string,
  png: Uint8Array,
  transform: AvatarTransform,
  dataDir = getDataDir()
): Promise<AvatarAssets> {
  const normalizedPath = resolve(sourcePath)
  const extension = extname(normalizedPath).toLowerCase()
  if (!isAvatarImageExtension(extension)) {
    throw new Error('Avatar must be a PNG, JPG, WebP, GIF, or BMP image.')
  }
  const crop = Buffer.from(png)
  return replaceAvatarAssets(
    extension,
    (targetPath) => copyFile(normalizedPath, targetPath),
    (targetPath) => writeFile(targetPath, crop),
    transform,
    dataDir
  )
}

export async function setAvatarSourceCrop(
  sourcePath: string,
  sourceBytes: Uint8Array,
  png: Uint8Array,
  transform: AvatarTransform,
  dataDir = getDataDir()
): Promise<AvatarAssets> {
  const normalizedPath = resolve(sourcePath)
  const extension = extname(normalizedPath).toLowerCase()
  if (!isAvatarImageExtension(extension)) {
    throw new Error('Avatar must be a PNG, JPG, WebP, GIF, or BMP image.')
  }
  const source = Buffer.from(sourceBytes)
  if (source.length === 0) throw new Error('Avatar source image must not be empty.')
  const crop = Buffer.from(png)
  return replaceAvatarAssets(
    extension,
    (targetPath) => writeFile(targetPath, source),
    (targetPath) => writeFile(targetPath, crop),
    transform,
    dataDir
  )
}

export async function resetAvatarAssetsToDefault(dataDir = getDataDir()): Promise<AvatarAssets | undefined> {
  const sourcePath = await findBundledDefaultAvatarImage()
  if (!sourcePath) return undefined
  const extension = extname(sourcePath).toLowerCase()
  return replaceAvatarAssets(
    extension,
    (targetPath) => copyFile(sourcePath, targetPath),
    (targetPath) => copyFile(sourcePath, targetPath),
    defaultAvatarTransform,
    dataDir
  )
}

export async function readAvatarTransform(dataDir = getDataDir()): Promise<AvatarTransform> {
  const value = JSON.parse(await readFile(avatarTransformPath(dataDir), 'utf8')) as unknown
  return requireAvatarTransform(value)
}

export async function readAvatarDataUri(path: string): Promise<string> {
  const buffer = await readFile(path)
  return `data:${avatarMimeType(path)};base64,${buffer.toString('base64')}`
}

export async function readAvatarImageFromPath(path: string, source: AppAvatarImage['source']): Promise<AppAvatarImage> {
  return {
    path,
    mimeType: avatarMimeType(path),
    dataUri: await readAvatarDataUri(path),
    source
  }
}

export async function avatarImageSource(dataDir = getDataDir()): Promise<AppAvatarImage['source']> {
  const sourcePath = await findAvatarSourceImage(dataDir)
  const defaultAvatar = await findBundledDefaultAvatarImage()
  if (!sourcePath || !defaultAvatar) return 'custom'

  const [avatarInfo, defaultInfo] = await Promise.all([stat(sourcePath), stat(defaultAvatar)])
  if (avatarInfo.size !== defaultInfo.size) return 'custom'

  const [avatarBuffer, defaultBuffer] = await Promise.all([readFile(sourcePath), readFile(defaultAvatar)])
  if (!avatarBuffer.equals(defaultBuffer)) return 'custom'
  const transform = await readAvatarTransform(dataDir)
  return avatarTransformsEqual(transform, defaultAvatarTransform) ? 'default' : 'custom'
}

export async function readAvatarImage(dataDir = getDataDir()): Promise<AppAvatarImage | null> {
  const filePath = avatarDisplayImagePath(dataDir)
  if (!(await pathExists(filePath))) return null
  return readAvatarImageFromPath(filePath, await avatarImageSource(dataDir))
}
