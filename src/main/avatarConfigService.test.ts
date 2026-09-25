import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  clearAvatarImage: vi.fn(),
  clearNewAvatarPath: vi.fn(),
  getAppConfigSnapshot: vi.fn(),
  setAvatarImageFromSource: vi.fn()
}))

vi.mock('./config/appConfig', () => ({
  assistantNewAvatarPathKey: 'profile.assistant.new_avatar_path',
  clearNewAvatarPath: mocks.clearNewAvatarPath,
  getAppConfigSnapshot: mocks.getAppConfigSnapshot
}))

vi.mock('./attachments', () => ({
  clearAvatarImage: mocks.clearAvatarImage,
  setAvatarImageFromSource: mocks.setAvatarImageFromSource
}))

import { consumePendingAvatarUpdate } from './avatarConfigService'

function configWithAvatarPath(path: string) {
  return {
    settings: {
      profile: {
        assistant: { newAvatarPath: path }
      }
    }
  }
}

beforeEach(() => {
  mocks.clearAvatarImage.mockReset().mockResolvedValue(null)
  mocks.clearNewAvatarPath.mockReset().mockResolvedValue(true)
  mocks.getAppConfigSnapshot.mockReset().mockResolvedValue(configWithAvatarPath(''))
  mocks.setAvatarImageFromSource.mockReset().mockResolvedValue(null)
})

describe('pending avatar configuration', () => {
  it('imports the requested avatar and clears the exact consumed path', async () => {
    mocks.getAppConfigSnapshot.mockResolvedValue(configWithAvatarPath('/images/avatar.png'))

    await expect(consumePendingAvatarUpdate('/images/avatar.png')).resolves.toEqual({
      applied: true,
      key: 'profile.assistant.new_avatar_path',
      path: '/images/avatar.png'
    })

    expect(mocks.setAvatarImageFromSource).toHaveBeenCalledWith('/images/avatar.png')
    expect(mocks.clearNewAvatarPath).toHaveBeenCalledWith('/images/avatar.png')
  })

  it('clears a handled failure before returning the avatar error', async () => {
    const failure = new Error('Avatar image could not be decoded.')
    mocks.getAppConfigSnapshot.mockResolvedValue(configWithAvatarPath('/images/broken.png'))
    mocks.setAvatarImageFromSource.mockRejectedValue(failure)

    await expect(consumePendingAvatarUpdate('/images/broken.png')).rejects.toBe(failure)

    expect(mocks.clearNewAvatarPath).toHaveBeenCalledWith('/images/broken.png')
  })

  it('restores the default avatar when the one-time value is default', async () => {
    mocks.getAppConfigSnapshot.mockResolvedValue(configWithAvatarPath('default'))

    await expect(consumePendingAvatarUpdate('default')).resolves.toMatchObject({
      applied: true,
      path: 'default'
    })

    expect(mocks.clearAvatarImage).toHaveBeenCalledOnce()
    expect(mocks.setAvatarImageFromSource).not.toHaveBeenCalled()
    expect(mocks.clearNewAvatarPath).toHaveBeenCalledWith('default')
  })

  it('does nothing when no avatar request is pending', async () => {
    await expect(consumePendingAvatarUpdate()).resolves.toEqual({
      applied: false,
      key: 'profile.assistant.new_avatar_path'
    })

    expect(mocks.setAvatarImageFromSource).not.toHaveBeenCalled()
    expect(mocks.clearNewAvatarPath).not.toHaveBeenCalled()
  })

  it('does not consume a newer request on behalf of an older tool call', async () => {
    mocks.getAppConfigSnapshot.mockResolvedValue(configWithAvatarPath('/images/newer.png'))

    await expect(consumePendingAvatarUpdate('/images/older.png'))
      .rejects.toThrow('superseded by a newer avatar path')

    expect(mocks.setAvatarImageFromSource).not.toHaveBeenCalled()
    expect(mocks.clearNewAvatarPath).not.toHaveBeenCalled()
  })

  it('returns the completed result when a config refresh consumed the same request first', async () => {
    mocks.getAppConfigSnapshot
      .mockResolvedValueOnce(configWithAvatarPath('/images/raced.png'))
      .mockResolvedValueOnce(configWithAvatarPath(''))

    await expect(consumePendingAvatarUpdate()).resolves.toMatchObject({ applied: true })
    await expect(consumePendingAvatarUpdate('/images/raced.png')).resolves.toMatchObject({
      applied: true,
      path: '/images/raced.png'
    })

    expect(mocks.setAvatarImageFromSource).toHaveBeenCalledOnce()
  })

  it('returns the completed error when a config refresh rejected the same request first', async () => {
    const failure = new Error('Raced avatar image is invalid.')
    mocks.getAppConfigSnapshot
      .mockResolvedValueOnce(configWithAvatarPath('/images/raced-broken.png'))
      .mockResolvedValueOnce(configWithAvatarPath(''))
    mocks.setAvatarImageFromSource.mockRejectedValue(failure)

    await expect(consumePendingAvatarUpdate()).rejects.toBe(failure)
    await expect(consumePendingAvatarUpdate('/images/raced-broken.png')).rejects.toBe(failure)

    expect(mocks.setAvatarImageFromSource).toHaveBeenCalledOnce()
  })
})
