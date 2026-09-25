import { describe, expect, it } from 'vitest'
import type { AvatarTransform } from './types'
import { avatarTransformsEqual, defaultAvatarTransform, requireAvatarTransform } from './avatar'

describe('avatar transform metadata', () => {
  it('accepts bounded percentage crops and right-angle rotations', () => {
    const transform: AvatarTransform = {
      crop: { height: 62.5, width: 50, x: 25, y: 12.5 },
      rotation: 270
    }

    expect(requireAvatarTransform(transform)).toEqual(transform)
    expect(requireAvatarTransform(defaultAvatarTransform)).toEqual(defaultAvatarTransform)
    expect(avatarTransformsEqual(requireAvatarTransform(transform), transform)).toBe(true)
  })

  it('normalizes insignificant floating-point overflow before persistence', () => {
    expect(requireAvatarTransform({
      crop: { height: 100.0000001, width: 100.0000001, x: -0.0000001, y: -0.0000001 },
      rotation: 0
    })).toEqual(defaultAvatarTransform)
  })

  it('rejects crops outside the source and unsupported rotations', () => {
    expect(() => requireAvatarTransform({
      crop: { height: 80, width: 80, x: 30, y: 10 },
      rotation: 0
    })).toThrow('avatar.transform.crop must stay within the source image percentage bounds.')
    expect(() => requireAvatarTransform({
      crop: { height: 80, width: 80, x: 10, y: 10 },
      rotation: 45
    })).toThrow('avatar.transform.rotation must be 0, 90, 180, or 270.')
  })
})
