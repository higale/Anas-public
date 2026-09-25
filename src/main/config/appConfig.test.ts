vi.mock('../toolsStore', () => ({ listToolSnapshot: vi.fn(async () => ({ roots: [], tools: [] })) }))
import capabilityDefaults from '../../../data/config/capabilities.json'
import { diffViewSettingsFixture } from '../../test/diffViewSettingsFixture'
import { defaultCapabilitySettings, defaultCapabilities, serializeDefaultCapabilitySettings, serializeCapabilities } from '@shared/agentCapabilities'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RawAppConfig } from './rawAppConfig'

function rawConfig(): RawAppConfig {
  return {
    capabilities: structuredClone(capabilityDefaults),
    providers: [rawProvider('first', 'First')],
    settings: {
      profile: {
        assistant: {
          name: 'Ananas',
          role: 'AI assistant',
          instructions: 'Be clear.',
          new_avatar_path: ''
        },
        user: {
          preferred_name: '',
          personal_info: ''
        }
      },
      speech_reply: {
        enabled: false,
        voice: '',
        speed: 1
      },
      default_model_id: 'first',
      language: 'system',
      theme: 'system',
      font_size: 14,
      chat_content_width: 'narrow',
      attachment_text_max_chars: 200000,
      attachment_text_overflow: 'truncate',
      log_level: 'info',
      log_retention_days: 14,
      max_model_calls_per_run: 100,
      environment_context: {
        operating_system: true,
        power_shell: true,
        bundled_commands: true,
        current_date: true,
        application_data_directory: true,
        user_home_directory: true,
        custom_information_enabled: true,
        custom_information: ''
      },
      diff_fold_unchanged: diffViewSettingsFixture.diffFoldUnchanged,
      diff_word_wrap: diffViewSettingsFixture.diffWordWrap,
      sidebar_visible: true,
      sidebar_width: 260,
      sidebar_collapsed_sections: {
        projects: false,
        simple_chats: false
      },
      backup_dir: ''
    },
    mcp_servers: [
      { id: 'enabled', name: 'Enabled', enabled: true, type: 'stdio', command: 'enabled-server' },
      { id: 'disabled', name: 'Disabled', enabled: false, type: 'stdio', command: 'disabled-server' }
    ]
  }
}

function rawProvider(id: string, name: string) {
  return {
    id: `${id}-provider`,
    name,
    protocol: 'openai_chat_completions',
    base_url: 'https://example.com/v1',
    model_list_auth: 'bearer',
    api_key: '',
    parameters: {},
    models: [{
      id,
      model: `${id}-model`,
      parameters: {},
      parameter_preset_mode: 'none',
      capabilities: { vision: true, tool_use: true },
      stream: true,
      max_context_tokens: 128_000,
      max_output_tokens: 16_000,
      context_compression_threshold: 0.8,
      context_compression_enabled: true
    }]
  }
}

async function loadAppConfig(raw: RawAppConfig, bundled: RawAppConfig = raw) {
  vi.resetModules()
  const readRawConfig = vi.fn(async () => raw)
  const readBundledRawConfig = vi.fn(async () => bundled)
  const writeRawCapabilitiesConfig = vi.fn()
  const writeRawSettingsConfig = vi.fn()
  const writeRawModelsConfig = vi.fn()
  const writeRawSubagentsConfig = vi.fn()
  const writeRawMcpServersConfig = vi.fn()
  const userSettingsConfigExists = vi.fn(async () => true)
  const runtimeLog = vi.fn()
  const setDataEnvEnabled = vi.fn()
  const resolveDefaultProfile = vi.fn(async () => ({
    assistant: {
      name: 'Ananas',
      role: 'Localized role',
      instructions: 'Localized instructions',
      newAvatarPath: ''
    },
    user: {
      preferredName: '',
      personalInfo: ''
    }
  }))
  vi.doMock('./rawAppConfig', () => ({
    asRecord: (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) ? value : {},
    readBundledRawConfig,
    readRawConfig,
    userSettingsConfigExists,
    writeRawCapabilitiesConfig,
    writeRawSettingsConfig,
    writeRawModelsConfig,
    writeRawSubagentsConfig,
    writeRawMcpServersConfig
  }))
  vi.doMock('../runtimeLogger', () => ({ runtimeLog }))
  vi.doMock('../languageStore', () => ({ resolveDefaultProfile }))
  vi.doMock('./apiKeys', () => ({ setDataEnvEnabled }))
  return {
    appConfig: await import('./appConfig'),
    toolEffectScope: await import('../agent/toolEffectScope'),
    readBundledRawConfig,
    readRawConfig,
    userSettingsConfigExists,
    writeRawCapabilitiesConfig,
    writeRawSettingsConfig,
    writeRawModelsConfig,
    writeRawSubagentsConfig,
    writeRawMcpServersConfig,
    runtimeLog,
    setDataEnvEnabled,
    resolveDefaultProfile
  }
}

afterEach(() => {
  vi.doUnmock('./rawAppConfig')
  vi.doUnmock('../runtimeLogger')
  vi.doUnmock('../languageStore')
  vi.doUnmock('./apiKeys')
  vi.resetModules()
})

describe('profile initialization', () => {
  it('materializes localized defaults exactly once when the user settings config does not exist', async () => {
    const raw = rawConfig()
    const {
      appConfig,
      readBundledRawConfig,
      readRawConfig,
      resolveDefaultProfile,
      userSettingsConfigExists,
      writeRawSettingsConfig
    } = await loadAppConfig(raw)
    let exists = false
    userSettingsConfigExists.mockImplementation(async () => exists)
    writeRawSettingsConfig.mockImplementation(async () => {
      exists = true
    })

    await Promise.all([
      appConfig.initializeAppProfile(),
      appConfig.initializeAppProfile()
    ])

    expect(resolveDefaultProfile).toHaveBeenCalledOnce()
    expect(resolveDefaultProfile).toHaveBeenCalledWith('system')
    expect(readBundledRawConfig).toHaveBeenCalledOnce()
    expect(readRawConfig).not.toHaveBeenCalled()
    expect(writeRawSettingsConfig).toHaveBeenCalledOnce()
    expect(writeRawSettingsConfig).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({
        profile: {
          assistant: {
            name: 'Ananas',
            role: 'Localized role',
            instructions: 'Localized instructions',
            new_avatar_path: ''
          },
          user: {
            preferred_name: '',
            personal_info: ''
          }
        }
      })
    }))
  })

  it('does not touch an existing user profile during startup', async () => {
    const raw = rawConfig()
    const {
      appConfig,
      readBundledRawConfig,
      resolveDefaultProfile,
      writeRawSettingsConfig
    } = await loadAppConfig(raw)

    await appConfig.initializeAppProfile()

    expect(readBundledRawConfig).not.toHaveBeenCalled()
    expect(resolveDefaultProfile).not.toHaveBeenCalled()
    expect(writeRawSettingsConfig).not.toHaveBeenCalled()
  })

  it('retries initialization after an atomic settings-config write fails', async () => {
    const raw = rawConfig()
    const {
      appConfig,
      resolveDefaultProfile,
      userSettingsConfigExists,
      writeRawSettingsConfig
    } = await loadAppConfig(raw)
    let exists = false
    userSettingsConfigExists.mockImplementation(async () => exists)
    writeRawSettingsConfig
      .mockRejectedValueOnce(new Error('disk unavailable'))
      .mockImplementation(async () => {
        exists = true
      })

    await expect(appConfig.initializeAppProfile()).rejects.toThrow('disk unavailable')
    expect(exists).toBe(false)

    await expect(appConfig.initializeAppProfile()).resolves.toBeUndefined()
    expect(exists).toBe(true)
    expect(resolveDefaultProfile).toHaveBeenCalledTimes(2)
    expect(writeRawSettingsConfig).toHaveBeenCalledTimes(2)
  })
})

describe('MCP runtime configuration snapshot', () => {
  it('filters disabled servers in one read', async () => {
    const raw = rawConfig()
    const { appConfig, readRawConfig } = await loadAppConfig(raw)

    await expect(appConfig.getMcpRuntimeConfigSnapshot()).resolves.toMatchObject({
      enabled: true,
      servers: [{ index: 0, name: 'Enabled', enabled: true }]
    })
    expect(readRawConfig).toHaveBeenCalledTimes(1)
  })
})

describe('configuration domain writes', () => {
  const modelSave = {
    name: 'Generated model',
    protocol: 'openai_chat_completions' as const,
    baseUrl: 'https://example.com/v1',
    modelListUrl: '',
    modelListAuth: 'bearer' as const,
    apiKey: '',
    parameters: {}
  }

  it('publishes saved provider and model parameters and deletions to every config observer', async () => {
    const raw = rawConfig()
    const { appConfig } = await loadAppConfig(raw)
    const listener = vi.fn()
    const unsubscribe = appConfig.onAppConfigChanged(listener)
    const providerSnapshot = await appConfig.saveModelProvider({
      ...modelSave, id: 'first-provider', parameters: { temperature: 0.2 }
    })
    expect(listener).toHaveBeenLastCalledWith({ config: 'models', key: 'providers', snapshot: providerSnapshot })
    const model = providerSnapshot.providers[0].models[0]
    const editedSnapshot = await appConfig.saveProviderModel({
      ...model, providerId: 'first-provider', maxContextTokens: 32000, maxOutputTokens: 4000,
      parameterPresetMode: 'custom', parameterPresets: [{ id: 'reasoning', name: 'Reasoning', parameters: { reasoning_effort: 'high' } }]
    })
    expect(listener).toHaveBeenLastCalledWith({ config: 'models', key: 'providers', snapshot: editedSnapshot })
    expect(editedSnapshot.defaultModel).toMatchObject({ maxContextTokens: 32000, maxOutputTokens: 4000 })
    const deletedSnapshot = await appConfig.deleteProviderModel('first-provider', model.id)
    expect(listener).toHaveBeenLastCalledWith({ config: 'models', key: 'providers', snapshot: deletedSnapshot })
    expect(deletedSnapshot.defaultModel).toBeUndefined()
    unsubscribe()
  })

  it('does not publish model configuration before persistence succeeds', async () => {
    const { appConfig, writeRawModelsConfig } = await loadAppConfig(rawConfig())
    const listener = vi.fn()
    appConfig.onAppConfigChanged(listener)
    let releaseWrite!: () => void
    writeRawModelsConfig.mockImplementationOnce(() => new Promise<void>((resolve) => { releaseWrite = resolve }))
    const saved = appConfig.saveModelProvider({ ...modelSave, id: 'first-provider' })
    await vi.waitFor(() => expect(releaseWrite).toBeDefined())
    expect(listener).not.toHaveBeenCalled()
    releaseWrite()
    await saved
    expect(listener).toHaveBeenCalledOnce()
    listener.mockClear()
    writeRawModelsConfig.mockRejectedValueOnce(new Error('write failed'))
    await expect(appConfig.deleteModelProvider('first-provider')).rejects.toThrow('write failed')
    expect(listener).not.toHaveBeenCalled()
  })

  it('stores the default leaf model ID with settings config', async () => {
    const raw = rawConfig()
    raw.providers = [rawProvider('first', 'First'), rawProvider('second', 'Second')]
    const { appConfig, writeRawSettingsConfig, writeRawModelsConfig } = await loadAppConfig(raw)

    await appConfig.selectDefaultModel('second')

    expect(writeRawSettingsConfig).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({
        default_model_id: 'second'
      })
    }))
    expect(writeRawModelsConfig).not.toHaveBeenCalled()
  })

  it('clears the default model without requiring another model', async () => {
    const raw = rawConfig()
    raw.settings!.default_model_id = 'first'
    const { appConfig, writeRawSettingsConfig } = await loadAppConfig(raw)

    await appConfig.selectDefaultModel(null)

    expect(writeRawSettingsConfig).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({
        default_model_id: null
      })
    }))
  })

  it('rejects an empty default model ID without writing settings config', async () => {
    const raw = rawConfig()
    raw.providers = [rawProvider('first', 'First')]
    const { appConfig, writeRawSettingsConfig } = await loadAppConfig(raw)

    await expect(appConfig.selectDefaultModel('')).rejects.toThrow('Model configuration not found')
    expect(writeRawSettingsConfig).not.toHaveBeenCalled()
  })

  it('persists sidebar section collapse state as one application setting', async () => {
    const raw = rawConfig()
    const { appConfig, writeRawSettingsConfig } = await loadAppConfig(raw)

    const snapshot = await appConfig.updateSettings({
      sidebarCollapsedSections: {
        projects: true,
        simpleChats: false
      }
    })

    expect(raw.settings?.sidebar_collapsed_sections).toEqual({
      projects: true,
      simple_chats: false
    })
    expect(snapshot.settings.sidebarCollapsedSections).toEqual({
      projects: true,
      simpleChats: false
    })
    expect(writeRawSettingsConfig).toHaveBeenCalledOnce()
  })

  it('preserves wide workspace panes while enforcing pane minimums and sidebar bounds', async () => {
    const raw = rawConfig()
    const { appConfig, writeRawSettingsConfig } = await loadAppConfig(raw)

    const snapshot = await appConfig.updateSettings({ sidebarWidth: 999, workspacePanelWidth: 1200, diffViewMode: 'side_by_side' })

    expect(raw.settings?.sidebar_width).toBe(420)
    expect(snapshot.settings.sidebarWidth).toBe(420)
    expect(snapshot.settings.workspacePanelWidth).toBe(1200)
    expect((await appConfig.getAppConfigSnapshot()).settings.diffViewMode).toBe('side_by_side')
    expect(raw.settings?.workspace_panel_width).toBe(1200)
    expect(writeRawSettingsConfig).toHaveBeenCalledOnce()

    raw.settings!.sidebar_width = 100
    raw.settings!.workspace_panel_width = 100
    expect((await appConfig.getAppConfigSnapshot()).settings.workspacePanelWidth).toBe(320)
    expect((await appConfig.getAppConfigSnapshot()).settings.sidebarWidth).toBe(220)
  })

  it('persists global diff preferences and preserves them across partial updates', async () => {
    const raw = rawConfig()
    const { appConfig } = await loadAppConfig(raw)
    await appConfig.updateSettings({ diffViewMode: 'side_by_side', diffFoldUnchanged: false, diffWordWrap: true })
    expect(raw.settings).toMatchObject({ diff_view_mode: 'side_by_side', diff_fold_unchanged: false, diff_word_wrap: true })
    await appConfig.updateSettings({ diffViewMode: 'inline' })
    expect((await appConfig.getAppConfigSnapshot()).settings).toMatchObject({ diffViewMode: 'inline', diffFoldUnchanged: false, diffWordWrap: true })
  })

  it('persists runtime environment details separately from the environment capability', async () => {
    const raw = rawConfig()
    const { appConfig, writeRawSettingsConfig } = await loadAppConfig(raw)

    const snapshot = await appConfig.updateSettings({
      environmentContext: {
        operatingSystem: false,
        powerShell: false,
        bundledCommands: false,
        currentDate: true,
        applicationDataDirectory: false,
        userHomeDirectory: true,
        customInformationEnabled: false,
        customInformation: 'CI worker'
      }
    })

    expect(raw.settings?.environment_context).toEqual({
      operating_system: false,
      power_shell: false,
      bundled_commands: false,
      current_date: true,
      application_data_directory: false,
      user_home_directory: true,
      custom_information_enabled: false,
      custom_information: 'CI worker'
    })
    expect(snapshot.settings.environmentContext).toEqual({
      operatingSystem: false,
      powerShell: false,
      bundledCommands: false,
      currentDate: true,
      applicationDataDirectory: false,
      userHomeDirectory: true,
      customInformationEnabled: false,
      customInformation: 'CI worker'
    })
    expect(writeRawSettingsConfig).toHaveBeenCalledOnce()
  })

  it('fills only enabled empty custom environment content and notifies renderers', async () => {
    const raw = rawConfig()
    const { appConfig, writeRawSettingsConfig } = await loadAppConfig(raw)
    const changed = vi.fn()
    appConfig.onAppConfigChanged(changed)
    expect(await appConfig.fillEmptyCustomEnvironmentInformation('Available common commands:\n- node: 24.0.0')).toBe(true)
    expect(raw.settings!.environment_context!.custom_information_enabled).toBe(true)
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({
      key: 'environment_context.custom_information',
      snapshot: expect.objectContaining({ settings: expect.objectContaining({
        environmentContext: expect.objectContaining({ customInformation: 'Available common commands:\n- node: 24.0.0' })
      }) })
    }))
    expect(await appConfig.fillEmptyCustomEnvironmentInformation('Second result')).toBe(false)
    expect(writeRawSettingsConfig).toHaveBeenCalledOnce()
  })

  it('discards detection results if the user disables custom information before they are saved', async () => {
    const { appConfig, writeRawSettingsConfig } = await loadAppConfig(rawConfig())
    const { settings } = await appConfig.getAppConfigSnapshot()
    const disabling = appConfig.updateSettings({ environmentContext: { ...settings.environmentContext, customInformationEnabled: false } })
    const filling = appConfig.fillEmptyCustomEnvironmentInformation('Detected content')
    await disabling
    expect(await filling).toBe(false)
    expect((await appConfig.getAppConfigSnapshot()).settings.environmentContext.customInformation).toBe('')
    expect(writeRawSettingsConfig).toHaveBeenCalledOnce()
  })

  it('rechecks emptiness inside the mutation queue after a user saves settings', async () => {
    const { appConfig, writeRawSettingsConfig } = await loadAppConfig(rawConfig())
    const { settings } = await appConfig.getAppConfigSnapshot()
    const saving = appConfig.updateSettings({ environmentContext: { ...settings.environmentContext, customInformation: 'User content' } })
    const filling = appConfig.fillEmptyCustomEnvironmentInformation('Detected content')
    await saving
    expect(await filling).toBe(false)
    expect((await appConfig.getAppConfigSnapshot()).settings.environmentContext.customInformation).toBe('User content')
    expect(await appConfig.fillEmptyCustomEnvironmentInformation('  ')).toBe(false)
    expect(writeRawSettingsConfig).toHaveBeenCalledOnce()
  })

  it('persists chat content width and falls back to narrow for unknown values', async () => {
    const raw = rawConfig()
    const { appConfig, writeRawSettingsConfig } = await loadAppConfig(raw)

    const snapshot = await appConfig.updateSettings({ chatContentWidth: 'adaptive' })

    expect(raw.settings?.chat_content_width).toBe('adaptive')
    expect(snapshot.settings.chatContentWidth).toBe('adaptive')
    expect(writeRawSettingsConfig).toHaveBeenCalledOnce()

    raw.settings!.chat_content_width = 'unsupported'
    expect((await appConfig.getAppConfigSnapshot()).settings.chatContentWidth).toBe('narrow')
  })

  it('persists the new-thread model selection and falls back to the default model strategy', async () => {
    const raw = rawConfig()
    const { appConfig, writeRawSettingsConfig } = await loadAppConfig(raw)

    const snapshot = await appConfig.updateSettings({ newThreadModelSelection: 'current' })

    expect(raw.settings?.new_thread_model_selection).toBe('current')
    expect(snapshot.settings.newThreadModelSelection).toBe('current')
    expect(writeRawSettingsConfig).toHaveBeenCalledOnce()

    raw.settings!.new_thread_model_selection = 'unsupported'
    expect((await appConfig.getAppConfigSnapshot()).settings.newThreadModelSelection).toBe('default')
  })

  it('persists font size and clamps it to the supported range', async () => {
    const raw = rawConfig()
    const { appConfig, writeRawSettingsConfig } = await loadAppConfig(raw)

    const snapshot = await appConfig.updateSettings({ fontSize: 99 })

    expect(raw.settings?.font_size).toBe(18)
    expect(snapshot.settings.fontSize).toBe(18)
    expect(writeRawSettingsConfig).toHaveBeenCalledOnce()

    raw.settings!.font_size = 1
    expect((await appConfig.getAppConfigSnapshot()).settings.fontSize).toBe(11)
  })

  it('serializes read-modify-write mutations', async () => {
    const raw = rawConfig()
    raw.providers = [rawProvider('first', 'First'), rawProvider('second', 'Second')]
    const { appConfig, readRawConfig, writeRawSettingsConfig } = await loadAppConfig(raw)
    let releaseFirstWrite: (() => void) | undefined
    writeRawSettingsConfig.mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    }))

    const first = appConfig.selectDefaultModel('first')
    await vi.waitFor(() => expect(writeRawSettingsConfig).toHaveBeenCalledTimes(1))
    const second = appConfig.selectDefaultModel('second')
    await Promise.resolve()

    expect(readRawConfig).toHaveBeenCalledTimes(1)
    releaseFirstWrite?.()
    await Promise.all([first, second])
    expect(raw.settings?.default_model_id).toBe('second')
  })

  it('keeps the default model attached to its stable ID when providers move', async () => {
    const raw = rawConfig()
    raw.providers = [rawProvider('first', 'First'), rawProvider('second', 'Second')]
    raw.settings!.default_model_id = 'second'
    const { appConfig } = await loadAppConfig(raw)

    const snapshot = await appConfig.moveModelProvider('second-provider', -1)

    expect(raw.settings?.default_model_id).toBe('second')
    expect(snapshot.providers.map((provider) => provider.id)).toEqual(['second-provider', 'first-provider'])
    expect(snapshot.defaultModel).toMatchObject({ id: 'second', providerId: 'second-provider' })
  })

  it('clears the default model when its provider is deleted', async () => {
    const raw = rawConfig()
    raw.providers = [
      rawProvider('first', 'First'),
      rawProvider('second', 'Second'),
      rawProvider('third', 'Third')
    ]
    raw.settings!.default_model_id = 'second'
    const { appConfig } = await loadAppConfig(raw)

    await appConfig.deleteModelProvider('first-provider')
    expect(raw.settings?.default_model_id).toBe('second')

    const snapshot = await appConfig.deleteModelProvider('second-provider')
    expect(raw.settings?.default_model_id).toBeNull()
    expect(snapshot.defaultModel).toBeUndefined()
  })

  it('defaults missing provider fields and persists them on the next provider save', async () => {
    const raw = rawConfig()
    const existingProvider = raw.providers?.[0]
    if (!existingProvider) throw new Error('Expected fixture provider.')
    delete existingProvider.model_list_auth
    delete existingProvider.parameters
    const { appConfig, writeRawModelsConfig } = await loadAppConfig(raw)

    const snapshot = await appConfig.getAppConfigSnapshot()
    const provider = snapshot.providers[0]
    if (!provider) throw new Error('Expected normalized provider.')
    expect(provider.modelListAuth).toBe('bearer')
    expect(provider.parameters).toEqual({})

    await appConfig.saveModelProvider({
      id: provider.id,
      name: provider.name,
      protocol: provider.protocol,
      baseUrl: provider.baseUrl,
      modelListUrl: provider.modelListUrl,
      modelListAuth: provider.modelListAuth,
      apiKey: provider.apiKey ?? '',
      parameters: provider.parameters
    })

    expect(writeRawModelsConfig).toHaveBeenCalledWith(expect.objectContaining({
      providers: expect.arrayContaining([
        expect.objectContaining({
          id: provider.id,
          model_list_auth: 'bearer',
          parameters: {}
        })
      ])
    }))
  })

  it('generates an opaque provider ID in the main process and preserves it during edits', async () => {
    const raw = rawConfig()
    const { appConfig, writeRawModelsConfig } = await loadAppConfig(raw)

    const created = await appConfig.saveModelProvider(modelSave)
    const generated = created.providers[1]?.id
    expect(generated).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(created.providers[1]?.models).toEqual([])
    expect(writeRawModelsConfig).toHaveBeenCalledWith(expect.objectContaining({
      providers: expect.arrayContaining([
        expect.objectContaining({
          id: generated,
          model_list_auth: 'bearer'
        })
      ])
    }))

    const edited = await appConfig.saveModelProvider({
      ...modelSave,
      id: generated,
      name: 'Renamed model'
    })
    expect(edited.providers[1]).toMatchObject({
      id: generated,
      name: 'Renamed model'
    })
  })

  it('targets provider saves by stable ID instead of a stale list index', async () => {
    const raw = rawConfig()
    raw.providers = [rawProvider('first', 'First'), rawProvider('second', 'Second')]
    const { appConfig } = await loadAppConfig(raw)

    const snapshot = await appConfig.saveModelProvider({
      ...modelSave,
      id: 'second-provider',
      name: 'Updated second'
    })

    expect(snapshot.providers).toMatchObject([
      { id: 'first-provider', name: 'First' },
      { id: 'second-provider', name: 'Updated second' }
    ])
  })

  it('keeps the default model unset when the first provider is created', async () => {
    const raw = rawConfig()
    raw.settings!.default_model_id = null
    raw.providers = []
    const { appConfig, writeRawSettingsConfig, writeRawModelsConfig } = await loadAppConfig(raw)

    const snapshot = await appConfig.saveModelProvider(modelSave)

    expect(snapshot.defaultModelId).toBeUndefined()
    expect(snapshot.providers[0].models).toEqual([])
    expect(writeRawModelsConfig).toHaveBeenCalledTimes(1)
    expect(writeRawSettingsConfig).not.toHaveBeenCalled()
  })

  it('updates settings config before removing the current default provider', async () => {
    const raw = rawConfig()
    raw.providers = [rawProvider('first', 'First'), rawProvider('second', 'Second')]
    const { appConfig, writeRawSettingsConfig, writeRawModelsConfig } = await loadAppConfig(raw)

    const snapshot = await appConfig.deleteModelProvider('first-provider')

    expect(snapshot.defaultModelId).toBeUndefined()
    expect(raw.settings?.default_model_id).toBeNull()
    expect(writeRawSettingsConfig).toHaveBeenCalledTimes(1)
    expect(writeRawModelsConfig).toHaveBeenCalledTimes(1)
    expect(writeRawSettingsConfig.mock.invocationCallOrder[0])
      .toBeLessThan(writeRawModelsConfig.mock.invocationCallOrder[0])
  })

  it('adds, reorders, and removes provider models by stable leaf ID', async () => {
    const raw = rawConfig()
    const { appConfig } = await loadAppConfig(raw)
    const model = {
      providerId: 'first-provider',
      displayName: 'Second',
      model: 'second-model',
      parameters: { temperature: 0.2 },
      parameterPresetMode: 'none' as const,
      capabilities: { vision: false, toolUse: true },
      stream: false,
      maxContextTokens: 64_000,
      maxOutputTokens: 8_000,
      contextCompressionThreshold: 0.7,
      contextCompressionEnabled: false
    }

    const added = await appConfig.saveProviderModel(model)
    const addedModel = added.providers[0].models[1]
    expect(addedModel).toMatchObject({ displayName: 'Second', model: 'second-model', stream: false })
    expect(addedModel.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)

    const moved = await appConfig.moveProviderModel('first-provider', addedModel.id, -1)
    expect(moved.providers[0].models.map((entry) => entry.id)).toEqual([addedModel.id, 'first'])
    expect(moved.defaultModelId).toBe('first')

    const deleted = await appConfig.deleteProviderModel('first-provider', 'first')
    expect(deleted.providers[0].models.map((entry) => entry.id)).toEqual([addedModel.id])
    expect(deleted.defaultModelId).toBeUndefined()
    const emptied = await appConfig.deleteProviderModel('first-provider', addedModel.id)
    expect(emptied.providers[0].models).toEqual([])
    expect(emptied.defaultModelId).toBeUndefined()
  })

  it('adds multiple provider models atomically with one config write', async () => {
    const raw = rawConfig()
    const { appConfig, writeRawModelsConfig } = await loadAppConfig(raw)
    const baseModel = {
      providerId: 'first-provider',
      displayName: '',
      parameters: {},
      parameterPresetMode: 'none' as const,
      capabilities: { vision: false, toolUse: true },
      stream: true,
      maxContextTokens: 128_000,
      maxOutputTokens: 16_000,
      contextCompressionThreshold: 0.8,
      contextCompressionEnabled: true
    }

    const snapshot = await appConfig.addProviderModels([
      { ...baseModel, model: 'batch-model-a' },
      { ...baseModel, model: 'batch-model-b' }
    ])

    expect(snapshot.providers[0].models.map((model) => model.model))
      .toEqual(['first-model', 'batch-model-a', 'batch-model-b'])
    expect(new Set(snapshot.providers[0].models.map((model) => model.id)).size).toBe(3)
    expect(writeRawModelsConfig).toHaveBeenCalledOnce()
  })
})

describe('generic settings configuration', () => {
  it('updates mapped scalar and nested values with an idempotent durable target', async () => {
    const raw = rawConfig()
    const { appConfig, toolEffectScope, writeRawSettingsConfig } = await loadAppConfig(raw)
    const listener = vi.fn()
    const unsubscribe = appConfig.onAppConfigChanged(listener)
    const effects: import('../agent/toolEffectScope').AgentToolEffectArm[] = []

    const themeResult = await toolEffectScope.runWithCurrentAgentToolEffect({
      arm: (effect) => effects.push(effect)
    }, () => appConfig.updateConfigValue('settings', 'theme', 'dark'))
    const profileResult = await appConfig.updateConfigValue(
      'settings',
      'profile.user.preferred_name',
      'Gale'
    )
    expect(raw.settings).toMatchObject({
      theme: 'dark',
      profile: { user: { preferred_name: 'Gale' } }
    })
    expect(themeResult).toMatchObject({
      changed: true,
      config: 'settings',
      key: 'theme',
      value: 'dark'
    })
    expect(profileResult.value).toBe('Gale')
    expect(writeRawSettingsConfig).toHaveBeenCalledTimes(2)
    expect(effects).toEqual([expect.objectContaining({
      kind: 'config_update',
      recoveryMode: 'idempotent',
      target: {
        config: 'settings',
        key: 'theme',
        beforeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        desiredFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    })])
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      config: 'settings',
      key: 'theme',
      snapshot: themeResult.snapshot
    }))
    unsubscribe()
  })

  it('rejects unknown documents, unmapped keys, invalid values, and array indices without writing', async () => {
    const raw = rawConfig()
    const { appConfig, writeRawSettingsConfig } = await loadAppConfig(raw)

    await expect(appConfig.updateConfigValue('models', 'theme', 'dark'))
      .rejects.toThrow('is not supported')
    await expect(appConfig.updateConfigValue('settings', 'unknown_key', true))
      .rejects.toThrow('does not exist')
    await expect(appConfig.updateConfigValue('settings', 'font_size', 999))
      .rejects.toThrow('invalid or non-canonical')
    await expect(appConfig.updateConfigValue('settings', 'theme', 'neon'))
      .rejects.toThrow('invalid or non-canonical')
    await expect(appConfig.updateConfigValue('settings', 'max_model_calls_per_run', -1))
      .rejects.toThrow('invalid or non-canonical')
    await expect(appConfig.updateConfigValue('settings', 'speech_reply.enabled', 'yes'))
      .rejects.toThrow('must be a boolean')
    await expect(appConfig.updateConfigValue('settings', 'speech_reply.0', true))
      .rejects.toThrow('dot-separated snake_case')

    expect(writeRawSettingsConfig).not.toHaveBeenCalled()
  })

  it('does not write or arm an effect when the requested value is already applied', async () => {
    const raw = rawConfig()
    const { appConfig, toolEffectScope, writeRawSettingsConfig } = await loadAppConfig(raw)
    const arm = vi.fn()

    const result = await toolEffectScope.runWithCurrentAgentToolEffect({ arm }, () => (
      appConfig.updateConfigValue('settings', 'theme', 'system')
    ))

    expect(result.changed).toBe(false)
    expect(arm).not.toHaveBeenCalled()
    expect(writeRawSettingsConfig).not.toHaveBeenCalled()
  })

  it('persists a mapped one-time avatar path for the refresh consumer', async () => {
    const raw = rawConfig()
    const { appConfig, toolEffectScope } = await loadAppConfig(raw)
    const effects: import('../agent/toolEffectScope').AgentToolEffectArm[] = []

    const result = await toolEffectScope.runWithCurrentAgentToolEffect({
      arm: (effect) => effects.push(effect)
    }, () => appConfig.updateConfigValue(
      'settings',
      'profile.assistant.new_avatar_path',
      '/images/avatar.png'
    ))

    expect(result).toMatchObject({
      changed: true,
      key: 'profile.assistant.new_avatar_path',
      value: '/images/avatar.png'
    })
    expect(raw.settings?.profile?.assistant?.new_avatar_path).toBe('/images/avatar.png')
    expect(effects).toEqual([expect.objectContaining({
      kind: 'config_update',
      recoveryMode: 'idempotent'
    })])
  })

  it('clears only the avatar path consumed by the current refresh', async () => {
    const raw = rawConfig()
    raw.settings!.profile!.assistant!.new_avatar_path = '/images/current.png'
    const { appConfig, writeRawSettingsConfig } = await loadAppConfig(raw)
    const listener = vi.fn()
    const unsubscribe = appConfig.onAppConfigChanged(listener)

    await expect(appConfig.clearNewAvatarPath('/images/older.png')).resolves.toBe(false)
    await expect(appConfig.clearNewAvatarPath('/images/current.png')).resolves.toBe(true)

    expect(raw.settings?.profile?.assistant?.new_avatar_path).toBe('')
    expect(writeRawSettingsConfig).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({
      config: 'settings',
      key: 'profile.assistant.new_avatar_path'
    }))
    unsubscribe()
  })
})

describe('profile configuration', () => {
  it('keeps the persisted profile unchanged when the interface language changes', async () => {
    const raw = rawConfig()
    const { appConfig } = await loadAppConfig(raw)

    const before = await appConfig.getAppConfigSnapshot()
    raw.settings!.language = 'zh-CN'
    const after = await appConfig.getAppConfigSnapshot()

    expect(after.settings.profile).toEqual(before.settings.profile)
  })

  it('patches only supplied fields, preserves explicit empty values, and emits the saved profile', async () => {
    const raw = rawConfig()
    const { appConfig, toolEffectScope, writeRawSettingsConfig } = await loadAppConfig(raw)
    const listener = vi.fn()
    const unsubscribe = appConfig.onAppConfigChanged(listener)
    const effects: import('../agent/toolEffectScope').AgentToolEffectArm[] = []

    const snapshot = await toolEffectScope.runWithCurrentAgentToolEffect({
      arm: (effect) => effects.push(effect)
    }, () => appConfig.updateProfile({
      assistant: { name: '  Ananas  ', role: '' },
      user: { personalInfo: 'Birthday: August 1' }
    }))

    expect(raw.settings?.profile).toEqual({
      assistant: {
        name: 'Ananas',
        role: '',
        instructions: 'Be clear.',
        new_avatar_path: ''
      },
      user: {
        preferred_name: '',
        personal_info: 'Birthday: August 1'
      }
    })
    expect(writeRawSettingsConfig).toHaveBeenCalledOnce()
    expect(snapshot.settings.profile).toEqual({
      assistant: {
        name: 'Ananas',
        role: '',
        instructions: 'Be clear.',
        newAvatarPath: ''
      },
      user: {
        preferredName: '',
        personalInfo: 'Birthday: August 1'
      }
    })
    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith({ config: 'settings', key: 'profile', snapshot })
    expect(effects).toEqual([expect.objectContaining({
      kind: 'profile_update',
      recoveryMode: 'idempotent'
    })])
    unsubscribe()
  })

  it('reconstructs an applied profile patch but refuses to overwrite a newer field value', async () => {
    const raw = rawConfig()
    const { appConfig, toolEffectScope, writeRawSettingsConfig } = await loadAppConfig(raw)
    let durableEffect: import('../agent/toolEffectScope').AgentToolEffectArm | undefined
    const update = { user: { preferredName: 'Gale' } }

    await toolEffectScope.runWithCurrentAgentToolEffect({
      arm: (effect) => { durableEffect = effect }
    }, () => appConfig.updateProfile(update))
    expect(durableEffect).toEqual(expect.objectContaining({
      kind: 'profile_update',
      recoveryMode: 'idempotent',
      target: {
        fields: ['user.preferredName'],
        beforeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        desiredFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/)
      }
    }))

    const replayArm = vi.fn()
    await toolEffectScope.runWithCurrentAgentToolEffect({ arm: replayArm }, () => (
      appConfig.updateProfile(update)
    ))
    expect(replayArm).not.toHaveBeenCalled()
    expect(writeRawSettingsConfig).toHaveBeenCalledOnce()

    raw.settings!.profile!.user!.preferred_name = 'Ada'
    await expect(toolEffectScope.runWithCurrentAgentToolEffect({
      arm: (effect) => {
        if (JSON.stringify(effect) !== JSON.stringify(durableEffect)) {
          throw new Error('durable effect target changed')
        }
      }
    }, () => appConfig.updateProfile(update)))
      .rejects.toThrow('durable effect target changed')
    expect(raw.settings?.profile?.user?.preferred_name).toBe('Ada')
    expect(writeRawSettingsConfig).toHaveBeenCalledOnce()
  })

  it('rejects empty and non-string profile patches before reading or writing config', async () => {
    const raw = rawConfig()
    const { appConfig, readRawConfig, writeRawSettingsConfig } = await loadAppConfig(raw)

    await expect(appConfig.updateProfile({})).rejects.toThrow('At least one profile field is required.')
    await expect(appConfig.updateProfile({
      user: { personalInfo: 42 } as never
    })).rejects.toThrow('Profile value user.personal_info must be a string.')
    await expect(appConfig.updateProfile({
      assistant: { name: '   ' }
    })).rejects.toThrow('Profile value assistant.name must not be empty.')

    expect(readRawConfig).not.toHaveBeenCalled()
    expect(writeRawSettingsConfig).not.toHaveBeenCalled()
  })

  it('does not turn a committed profile save into a failure when a listener throws', async () => {
    const raw = rawConfig()
    const { appConfig, runtimeLog, writeRawSettingsConfig } = await loadAppConfig(raw)
    appConfig.onAppConfigChanged(() => {
      throw new Error('renderer unavailable')
    })

    await expect(appConfig.updateProfile({
      user: { preferredName: 'Gale' }
    })).resolves.toMatchObject({
      settings: { profile: { user: { preferredName: 'Gale' } } }
    })
    expect(writeRawSettingsConfig).toHaveBeenCalledOnce()
    expect(runtimeLog).toHaveBeenCalledWith(
      'warn',
      'config',
      'A config change listener failed after the config was saved.',
      expect.objectContaining({ error: expect.any(Error) })
    )
  })
})

describe('subagent configuration', () => {
  const builtIn = {
 capabilities: serializeCapabilities({ ...structuredClone(defaultCapabilities), profile: false, workspace: true,
      memory: true, toolMode: 'all', tools: [], skills: { enabled: true, mode: 'default', project: false, entries: [] } }),
    preset: 'general-purpose',
    name: 'general-purpose',
    enabled: true,
    description: 'General work.',
    system_prompt: 'Complete the task.',
  }
  const custom = {
 capabilities: serializeCapabilities({ ...structuredClone(defaultCapabilities), profile: false, workspace: true,
      memory: false, toolMode: 'selected', tools: ['read_file'], skills: { enabled: true, mode: 'custom', project: false, entries: [] } }),
    name: 'custom-agent',
    enabled: false,
    description: 'Custom work.',
    system_prompt: 'Complete custom work.',
  }

  it('protects built-ins from deletion while allowing custom entries to be deleted', async () => {
    const raw = rawConfig()
    raw.subagents = [{ ...builtIn }, { ...custom }]
    const { appConfig, writeRawSubagentsConfig } = await loadAppConfig(raw)

    await expect(appConfig.deleteSubagent(0)).rejects.toThrow(/Built-in/)
    expect(writeRawSubagentsConfig).not.toHaveBeenCalled()

    await appConfig.deleteSubagent(1)
    expect(raw.subagents).toEqual([expect.objectContaining({
      preset: 'general-purpose',
      name: 'general-purpose'
    })])
  })

  it('restores a built-in by preset without changing its current list position', async () => {
    const raw = rawConfig()
    raw.subagents = [
      { ...custom },
      { ...builtIn, description: 'Locally changed.' }
    ]
    const bundled = rawConfig()
    bundled.subagents = [{ ...builtIn }]
    const { appConfig, readBundledRawConfig } = await loadAppConfig(raw, bundled)

    const snapshot = await appConfig.restoreSubagent(1)
    expect(readBundledRawConfig).toHaveBeenCalledTimes(1)
    expect(snapshot.subagents).toEqual([
      expect.objectContaining({ name: 'custom-agent' }),
      expect.objectContaining({
        name: 'general-purpose',
        description: 'General work.',
        builtIn: true
      })
    ])
  })

  it('rejects duplicate machine identifiers', async () => {
    const raw = rawConfig()
    raw.subagents = [{ ...custom }]
    const { appConfig, writeRawSubagentsConfig } = await loadAppConfig(raw)

    await expect(appConfig.saveSubagent({
 capabilities: { ...structuredClone(defaultCapabilities), profile: false, workspace: false,
        memory: false, toolMode: 'selected', tools: [], skills: { enabled: true, mode: 'custom', project: false, entries: [] } },
      name: 'custom-agent',
      enabled: false,
      description: '',
      systemPrompt: '',
    })).rejects.toThrow(/already used/)
    expect(writeRawSubagentsConfig).not.toHaveBeenCalled()
  })
})

describe('default project capabilities', () => {
  it('saves a validated independent domain and preserves project and subagent definitions', async () => {
    const raw = rawConfig()
    const before = structuredClone(raw)
    const { appConfig, writeRawCapabilitiesConfig, writeRawSettingsConfig, writeRawSubagentsConfig } = await loadAppConfig(raw)
    const value = structuredClone(defaultCapabilitySettings)
    value.capabilities.profile = false
    value.capabilities.toolMode = 'selected'
    value.capabilities.tools = ['read_file']
    value.restrictSubagents = true
    value.subagentSelection = { mode: 'custom', names: ['reviewer'] }
    const saved = await appConfig.saveDefaultCapabilities(value)
    expect(saved.defaultCapabilities).toEqual(value)
    expect(raw.capabilities).toEqual(serializeDefaultCapabilitySettings(value))
    expect(writeRawCapabilitiesConfig).toHaveBeenCalledOnce()
    expect(writeRawSettingsConfig).not.toHaveBeenCalled()
    expect(writeRawSubagentsConfig).not.toHaveBeenCalled()
    expect(raw).toEqual({ ...before, capabilities: serializeDefaultCapabilitySettings(value) })
    await expect(appConfig.saveDefaultCapabilities({ ...value, restrictSubagents: 'yes' } as never)).rejects.toThrow()
    expect(writeRawCapabilitiesConfig).toHaveBeenCalledOnce()
  })
})
