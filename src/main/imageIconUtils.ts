import { nativeImage, type NativeImage } from 'electron'

export function squareNativeImageFromPath(filePath: string): NativeImage | undefined {
  const image = nativeImage.createFromPath(filePath)
  if (image.isEmpty()) return undefined
  const { width, height } = image.getSize()
  const side = Math.min(width, height)
  if (side <= 0) return undefined
  if (width === height) return image
  return image.crop({
    x: Math.floor((width - side) / 2),
    y: Math.floor((height - side) / 2),
    width: side,
    height: side
  })
}
