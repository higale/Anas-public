import type { AvatarCropArea, AvatarRotation, AvatarTransform } from './types'

export const defaultAvatarTransform: AvatarTransform = {
  crop: { height: 100, width: 100, x: 0, y: 0 },
  rotation: 0
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number.`)
  }
  return value
}

function avatarCropArea(value: unknown, path: string): AvatarCropArea {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`)
  }
  const crop = value as Record<string, unknown>
  const x = finiteNumber(crop.x, `${path}.x`)
  const y = finiteNumber(crop.y, `${path}.y`)
  const width = finiteNumber(crop.width, `${path}.width`)
  const height = finiteNumber(crop.height, `${path}.height`)
  const epsilon = 0.001
  if (
    x < -epsilon
    || y < -epsilon
    || x >= 100
    || y >= 100
    || width <= 0
    || height <= 0
    || x + width > 100 + epsilon
    || y + height > 100 + epsilon
  ) {
    throw new Error(`${path} must stay within the source image percentage bounds.`)
  }
  const boundedX = Math.max(0, Math.min(100, x))
  const boundedY = Math.max(0, Math.min(100, y))
  return {
    height: Math.min(height, 100 - boundedY),
    width: Math.min(width, 100 - boundedX),
    x: boundedX,
    y: boundedY
  }
}

function avatarRotation(value: unknown, path: string): AvatarRotation {
  if (value === 0 || value === 90 || value === 180 || value === 270) return value
  throw new Error(`${path} must be 0, 90, 180, or 270.`)
}

export function requireAvatarTransform(value: unknown, path = 'avatar.transform'): AvatarTransform {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`)
  }
  const transform = value as Record<string, unknown>
  return {
    crop: avatarCropArea(transform.crop, `${path}.crop`),
    rotation: avatarRotation(transform.rotation, `${path}.rotation`)
  }
}

export function avatarTransformsEqual(left: AvatarTransform, right: AvatarTransform): boolean {
  return left.rotation === right.rotation
    && left.crop.x === right.crop.x
    && left.crop.y === right.crop.y
    && left.crop.width === right.crop.width
    && left.crop.height === right.crop.height
}
