import { nativeImage, type NativeImage } from 'electron'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { squareNativeImageFromPath } from './imageIconUtils'

const avatarDisplaySize = 512
const windowsIconSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const macIconsetEntries = [
  { fileName: 'icon_16x16.png', size: 16 },
  { fileName: 'icon_16x16@2x.png', size: 32 },
  { fileName: 'icon_32x32.png', size: 32 },
  { fileName: 'icon_32x32@2x.png', size: 64 },
  { fileName: 'icon_128x128.png', size: 128 },
  { fileName: 'icon_128x128@2x.png', size: 256 },
  { fileName: 'icon_256x256.png', size: 256 },
  { fileName: 'icon_256x256@2x.png', size: 512 },
  { fileName: 'icon_512x512.png', size: 512 },
  { fileName: 'icon_512x512@2x.png', size: 1024 }
]
const macAvatarIconPaddingRatio = 0.08
const windowsAvatarIconPaddingRatio = 0
const avatarIconCornerRadiusRatio = 12 / 48
const avatarIconBorderRatio = 1.2 / 48
const avatarIconBorderGray = 128
const avatarIconBorderOpacity = 0.3

interface AvatarIconPngOptions {
  paddingRatio: number
}

function windowsIcoSizeByte(size: number): number {
  return size >= 256 ? 0 : size
}

function createWindowsIco(pngImages: Array<{ size: number; data: Buffer }>): Buffer {
  const headerSize = 6
  const entrySize = 16
  const imageOffsetStart = headerSize + entrySize * pngImages.length
  const imageBytes = pngImages.reduce((total, image) => total + image.data.length, 0)
  const ico = Buffer.alloc(imageOffsetStart + imageBytes)

  ico.writeUInt16LE(0, 0)
  ico.writeUInt16LE(1, 2)
  ico.writeUInt16LE(pngImages.length, 4)

  let imageOffset = imageOffsetStart
  pngImages.forEach((image, index) => {
    const entryOffset = headerSize + index * entrySize
    ico.writeUInt8(windowsIcoSizeByte(image.size), entryOffset)
    ico.writeUInt8(windowsIcoSizeByte(image.size), entryOffset + 1)
    ico.writeUInt8(0, entryOffset + 2)
    ico.writeUInt8(0, entryOffset + 3)
    ico.writeUInt16LE(1, entryOffset + 4)
    ico.writeUInt16LE(32, entryOffset + 6)
    ico.writeUInt32LE(image.data.length, entryOffset + 8)
    ico.writeUInt32LE(imageOffset, entryOffset + 12)
    image.data.copy(ico, imageOffset)
    imageOffset += image.data.length
  })

  return ico
}

function clampUnit(value: number): number {
  return Math.min(Math.max(value, 0), 1)
}

function roundedRectCoverage(size: number, x: number, y: number, inset: number, radius: number): number {
  const min = inset
  const max = size - inset
  const centerX = x + 0.5
  const centerY = y + 0.5
  const cornerMin = min + radius
  const cornerMax = max - radius
  const nearestX = Math.min(Math.max(centerX, cornerMin), cornerMax)
  const nearestY = Math.min(Math.max(centerY, cornerMin), cornerMax)
  const outsideX = Math.max(min - centerX, 0, centerX - max)
  const outsideY = Math.max(min - centerY, 0, centerY - max)

  if (outsideX > 0 || outsideY > 0) return clampUnit(0.5 - Math.hypot(outsideX, outsideY))
  return clampUnit(radius + 0.5 - Math.hypot(centerX - nearestX, centerY - nearestY))
}

function blendBitmapPixel(bitmap: Buffer, offset: number, red: number, green: number, blue: number, alpha: number): void {
  const inverse = 1 - alpha
  bitmap[offset] = Math.round(bitmap[offset] * inverse + blue * alpha)
  bitmap[offset + 1] = Math.round(bitmap[offset + 1] * inverse + green * alpha)
  bitmap[offset + 2] = Math.round(bitmap[offset + 2] * inverse + red * alpha)
}

function resizeSquareImage(source: NativeImage, size: number): NativeImage {
  const current = source.getSize()
  return current.width === size && current.height === size
    ? source
    : source.resize({ width: size, height: size, quality: 'best' })
}

function avatarIconPng(source: NativeImage, size: number, options: AvatarIconPngOptions): Buffer {
  const padding = Math.max(0, Math.round(size * options.paddingRatio))
  const imageSize = Math.max(1, size - padding * 2)
  const resized = resizeSquareImage(source, imageSize)
  const sourceBitmap = resized.toBitmap()
  const bitmap = Buffer.alloc(size * size * 4)
  const radius = imageSize * avatarIconCornerRadiusRatio
  const borderWidth = Math.max(1, imageSize * avatarIconBorderRatio)
  const innerInset = borderWidth
  const innerRadius = Math.max(0, radius - innerInset)

  for (let y = 0; y < imageSize; y += 1) {
    for (let x = 0; x < imageSize; x += 1) {
      const sourceOffset = (y * imageSize + x) * 4
      const targetOffset = ((y + padding) * size + x + padding) * 4
      const outerCoverage = roundedRectCoverage(imageSize, x, y, 0, radius)
      const innerCoverage = roundedRectCoverage(imageSize, x, y, innerInset, innerRadius)
      const borderAlpha = Math.max(0, outerCoverage - innerCoverage) * avatarIconBorderOpacity

      bitmap[targetOffset] = sourceBitmap[sourceOffset]
      bitmap[targetOffset + 1] = sourceBitmap[sourceOffset + 1]
      bitmap[targetOffset + 2] = sourceBitmap[sourceOffset + 2]
      bitmap[targetOffset + 3] = Math.round(sourceBitmap[sourceOffset + 3] * outerCoverage)
      if (borderAlpha > 0) {
        blendBitmapPixel(bitmap, targetOffset, avatarIconBorderGray, avatarIconBorderGray, avatarIconBorderGray, borderAlpha)
      }
    }
  }

  return nativeImage.createFromBitmap(bitmap, { width: size, height: size }).toPNG()
}

function sourceImage(filePath: string): NativeImage {
  const image = squareNativeImageFromPath(filePath)
  if (!image) throw new Error('Avatar image could not be decoded.')
  return image
}

export function assertAvatarImageReadable(filePath: string): void {
  sourceImage(filePath)
}

async function runIconutil(iconsetDir: string, icnsPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('iconutil', ['-c', 'icns', '-o', icnsPath, iconsetDir], {
      stdio: 'ignore',
      windowsHide: true
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`iconutil exited with code ${code ?? 'unknown'}.`))
    })
  })
}

export async function writeAvatarDisplayPng(sourcePath: string, targetPath: string): Promise<void> {
  const source = sourceImage(sourcePath)
  const current = source.getSize()
  const image = current.width > avatarDisplaySize
    ? resizeSquareImage(source, avatarDisplaySize)
    : source
  await mkdir(dirname(targetPath), { recursive: true })
  await writeFile(targetPath, image.toPNG())
}

export async function writeAvatarDockPng(sourcePath: string, targetPath: string): Promise<void> {
  await mkdir(dirname(targetPath), { recursive: true })
  await writeFile(targetPath, avatarIconPng(sourceImage(sourcePath), avatarDisplaySize, { paddingRatio: macAvatarIconPaddingRatio }))
}

export async function writeAvatarMacIcns(sourcePath: string, targetPath: string): Promise<void> {
  const image = sourceImage(sourcePath)
  const tempDir = await mkdtemp(join(tmpdir(), 'anas-avatar-icon-'))
  const iconsetDir = join(tempDir, 'avatar.iconset')
  try {
    await mkdir(iconsetDir, { recursive: true })
    await Promise.all(macIconsetEntries.map(({ fileName, size }) => {
      return writeFile(join(iconsetDir, fileName), avatarIconPng(image, size, { paddingRatio: macAvatarIconPaddingRatio }))
    }))
    await runIconutil(iconsetDir, targetPath)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

export function createAvatarWindowsIco(sourcePath: string): Buffer {
  const image = sourceImage(sourcePath)
  const pngImages = windowsIconSizes.map((size) => ({
    size,
    data: avatarIconPng(image, size, { paddingRatio: windowsAvatarIconPaddingRatio })
  }))
  return createWindowsIco(pngImages)
}
