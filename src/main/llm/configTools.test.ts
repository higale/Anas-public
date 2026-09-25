import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'

const configMocks = vi.hoisted(() => ({
  consumePendingAvatarUpdate: vi.fn(),
  updateConfigValue: vi.fn()
}))

vi.mock('../config/appConfig', () => ({
  assistantNewAvatarPathKey: 'profile.assistant.new_avatar_path',
  updateConfigValue: configMocks.updateConfigValue
}))

vi.mock('../avatarConfigService', () => ({
  consumePendingAvatarUpdate: configMocks.consumePendingAvatarUpdate
}))

import { createConfigTools } from './configTools'

beforeEach(() => {
  configMocks.updateConfigValue.mockReset()
  configMocks.consumePendingAvatarUpdate.mockReset().mockResolvedValue({ applied: false })
  configMocks.updateConfigValue.mockResolvedValue({
    changed: true,
    config: 'settings',
    key: 'speech_reply.enabled',
    snapshot: { secret: 'must-not-leak' },
    value: true
  })
})

describe('update_config tool', () => {
  it('passes native JSON values to the settings config service without exposing the snapshot', async () => {
    const updateConfig = createConfigTools('/workspace')[0]

    const result = await updateConfig.invoke({
      summary: 'Enable speech replies',
      config: 'settings',
      key: 'speech_reply.enabled',
      value: true
    })

    expect(configMocks.updateConfigValue).toHaveBeenCalledWith(
      'settings',
      'speech_reply.enabled',
      true
    )
    expect(JSON.parse(result)).toEqual({
      ok: true,
      changed: true,
      config: 'settings',
      key: 'speech_reply.enabled',
      value: true
    })
    expect(result).not.toContain('must-not-leak')
  })

  it('retries a JSON-encoded value after strict native-value validation rejects it', async () => {
    configMocks.updateConfigValue
      .mockRejectedValueOnce(new Error('Config value for settings.theme is invalid or non-canonical.'))
      .mockResolvedValueOnce({
        changed: true,
        config: 'settings',
        key: 'theme',
        snapshot: {},
        value: 'dark'
      })
    const updateConfig = createConfigTools('/workspace')[0]

    const result = await updateConfig.invoke({
      summary: 'Change the application theme',
      config: 'settings',
      key: 'theme',
      value: '"dark"'
    })

    expect(configMocks.updateConfigValue).toHaveBeenNthCalledWith(
      1,
      'settings',
      'theme',
      '"dark"'
    )
    expect(configMocks.updateConfigValue).toHaveBeenNthCalledWith(2, 'settings', 'theme', 'dark')
    expect(JSON.parse(result)).toEqual({
      ok: true,
      changed: true,
      config: 'settings',
      key: 'theme',
      value: 'dark'
    })
  })

  it('returns configuration errors as tool output instead of failing the agent run', async () => {
    configMocks.updateConfigValue.mockRejectedValue(new Error('Config key settings.unknown does not exist.'))
    const updateConfig = createConfigTools('/workspace')[0]

    const result = await updateConfig.invoke({
      summary: 'Update an application setting',
      config: 'settings',
      key: 'unknown',
      value: true
    })

    expect(JSON.parse(result)).toEqual({
      ok: false,
      error: 'Config key settings.unknown does not exist.'
    })
  })

  it('does not retry JSON text after a persistence failure', async () => {
    configMocks.updateConfigValue.mockRejectedValue(new Error('Failed to write config.'))
    const updateConfig = createConfigTools('/workspace')[0]

    const result = await updateConfig.invoke({
      summary: 'Change the application theme',
      config: 'settings',
      key: 'theme',
      value: '"dark"'
    })

    expect(configMocks.updateConfigValue).toHaveBeenCalledOnce()
    expect(JSON.parse(result)).toEqual({ ok: false, error: 'Failed to write config.' })
  })

  it('rejects unsupported config documents and non-JSON values at the schema boundary', async () => {
    const updateConfig = createConfigTools('/workspace')[0]

    await expect(updateConfig.invoke({ summary: 'Change the application theme', config: 'models', key: 'theme', value: 'dark' }))
      .rejects.toThrow()
    await expect(updateConfig.invoke({ summary: 'Change the application theme', config: 'settings', key: 'theme' }))
      .rejects.toThrow()
    expect(configMocks.updateConfigValue).not.toHaveBeenCalled()
  })

  it('resolves and consumes a one-time avatar path before reporting success', async () => {
    configMocks.updateConfigValue.mockResolvedValue({
      changed: true,
      config: 'settings',
      key: 'profile.assistant.new_avatar_path',
      snapshot: {},
      value: '/workspace/images/avatar.png'
    })
    configMocks.consumePendingAvatarUpdate.mockResolvedValue({ applied: true })
    const updateConfig = createConfigTools('/workspace')[0]
    const avatarPath = resolve('/workspace/images/avatar.png')

    const result = await updateConfig.invoke({
      summary: 'Replace the assistant avatar',
      config: 'settings',
      key: 'profile.assistant.new_avatar_path',
      value: 'images/avatar.png'
    })

    expect(configMocks.updateConfigValue).toHaveBeenCalledWith(
      'settings',
      'profile.assistant.new_avatar_path',
      avatarPath
    )
    expect(configMocks.consumePendingAvatarUpdate).toHaveBeenCalledWith('/workspace/images/avatar.png')
    expect(JSON.parse(result)).toEqual({
      ok: true,
      changed: true,
      config: 'settings',
      key: 'profile.assistant.new_avatar_path',
      value: '',
      avatar_updated: true
    })
  })

  it('reports an avatar import failure after the one-time request is consumed', async () => {
    configMocks.updateConfigValue.mockResolvedValue({
      changed: true,
      config: 'settings',
      key: 'profile.assistant.new_avatar_path',
      snapshot: {},
      value: '/workspace/missing.png'
    })
    configMocks.consumePendingAvatarUpdate.mockRejectedValue(new Error('Avatar image could not be loaded.'))
    const updateConfig = createConfigTools('/workspace')[0]

    const result = await updateConfig.invoke({
      summary: 'Replace the assistant avatar',
      config: 'settings',
      key: 'profile.assistant.new_avatar_path',
      value: '/workspace/missing.png'
    })

    expect(JSON.parse(result)).toEqual({ ok: false, error: 'Avatar image could not be loaded.' })
  })

  it('preserves the default avatar sentinel instead of resolving it as a path', async () => {
    configMocks.updateConfigValue.mockResolvedValue({
      changed: true,
      config: 'settings',
      key: 'profile.assistant.new_avatar_path',
      snapshot: {},
      value: 'default'
    })
    configMocks.consumePendingAvatarUpdate.mockResolvedValue({ applied: true })
    const updateConfig = createConfigTools('/workspace')[0]

    const result = await updateConfig.invoke({
      summary: 'Restore the default assistant avatar',
      config: 'settings',
      key: 'profile.assistant.new_avatar_path',
      value: 'default'
    })

    expect(configMocks.updateConfigValue).toHaveBeenCalledWith(
      'settings',
      'profile.assistant.new_avatar_path',
      'default'
    )
    expect(configMocks.consumePendingAvatarUpdate).toHaveBeenCalledWith('default')
    expect(JSON.parse(result)).toMatchObject({ ok: true, avatar_updated: true, value: '' })
  })
})
