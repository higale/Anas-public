import { defaultCapabilitySettings } from '@shared/agentCapabilities'
import { diffViewSettingsFixture } from '../../../../test/diffViewSettingsFixture'
import { environmentContextFixture } from '../../../../test/environmentContextFixture'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { TFunction } from 'i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppConfigSnapshot } from '@shared/types'
import { notice } from '../notice'
import { useModelSettingsState } from './useModelSettingsState'

vi.mock('../notice', () => ({
  notice: {
    dismiss: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn()
  }
}))

const modelDefaults = {
  displayName: '',
  parameters: {},
  parameterPresetMode: 'none' as const,
  capabilities: { vision: true, toolUse: true },
  stream: true,
  maxContextTokens: 128_000,
  maxOutputTokens: 16_000,
  contextCompressionThreshold: 0.8,
  contextCompressionEnabled: true
}

const config = { customTools: [],
  defaultCapabilities: structuredClone(defaultCapabilitySettings),
  providers: [{
    id: 'provider-1',
    index: 0,
    name: 'Provider',
    protocol: 'openai_chat_completions',
    baseUrl: 'https://example.com/v1',
    modelListUrl: '{base_url}/models',
    modelListAuth: 'bearer',
    parameters: {},
    models: [
      { ...modelDefaults, id: 'model-1', index: 0, model: 'existing-model' },
      { ...modelDefaults, id: 'model-2', index: 1, model: '' }
    ]
  }],
  subagents: [],
  mcpServers: [],
  settings: {
    profile: {
      assistant: { name: 'Ananas', role: '', instructions: '', newAvatarPath: '' },
      user: { preferredName: '', personalInfo: '' }
    },
    speechReply: { enabled: false, voice: '', speed: 1 },
    language: 'en',
    theme: 'dark',
    fontSize: 14,
    chatContentWidth: 'narrow',
    newThreadModelSelection: 'default',
    attachmentTextMaxChars: 200_000,
    attachmentTextOverflow: 'truncate',
    logLevel: 'info',
    logRetentionDays: 14,
    maxModelCallsPerRun: 100,
    environmentContext: environmentContextFixture(),
    sidebarVisible: true,
    sidebarWidth: 260,
      workspacePanelWidth: 480, ...diffViewSettingsFixture,
    sidebarCollapsedSections: { projects: false, simpleChats: false },
    backupDir: ''
  }
} satisfies AppConfigSnapshot

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('model settings state', () => {
  it('creates a provider without creating a placeholder model', async () => {
    let currentConfig: AppConfigSnapshot = { ...config, providers: [] }
    const createdConfig = {
      ...currentConfig,
      providers: [{ ...config.providers[0], models: [] }]
    } satisfies AppConfigSnapshot
    const setConfig = vi.fn((nextConfig: AppConfigSnapshot) => {
      currentConfig = nextConfig
    })
    const saveModelProvider = vi.fn().mockResolvedValue(createdConfig)
    vi.stubGlobal('gale', { config: { saveModelProvider } })
    const { result, rerender } = renderHook(() => useModelSettingsState({
      config: currentConfig,
      openConfirmDialog: vi.fn(),
      setConfig,
      setError: vi.fn(),
      setSettingsTab: vi.fn(),
      settingsOpen: false,
      settingsTab: 'model',
      t: ((key: string) => key) as TFunction
    }))

    await act(async () => result.current.createModelDraft())
    rerender()

    expect(saveModelProvider).toHaveBeenCalledWith(expect.objectContaining({
      id: undefined,
      name: 'settings.new_provider_name'
    }))
    expect(setConfig).toHaveBeenCalledWith(createdConfig)
    await waitFor(() => expect(result.current.modelDraft.providerId).toBe('provider-1'))
    expect(result.current.modelDraft.modelConfigId).toBeUndefined()
    expect(result.current.editingProvider?.models).toEqual([])
    expect(notice.error).not.toHaveBeenCalled()
  })

  it('persists MiniMax OpenAI template parameters on the provider', async () => {
    const emptyConfig: AppConfigSnapshot = { ...config, providers: [] }
    const createdConfig = {
      ...emptyConfig,
      providers: [{
        ...config.providers[0],
        name: 'MiniMax',
        baseUrl: 'https://api.minimaxi.com/v1',
        modelListUrl: 'https://api.minimaxi.com/v1/models',
        parameters: { reasoning_split: true },
        models: []
      }]
    } satisfies AppConfigSnapshot
    const saveModelProvider = vi.fn().mockResolvedValue(createdConfig)
    vi.stubGlobal('gale', { config: { saveModelProvider } })
    const { result } = renderHook(() => useModelSettingsState({
      config: emptyConfig,
      openConfirmDialog: vi.fn(),
      setConfig: vi.fn(),
      setError: vi.fn(),
      setSettingsTab: vi.fn(),
      settingsOpen: false,
      settingsTab: 'model',
      t: ((key: string) => key) as TFunction
    }))

    await act(async () => result.current.createModelDraft('china/minimax/openai'))

    expect(saveModelProvider).toHaveBeenCalledWith(expect.objectContaining({
      protocol: 'openai_chat_completions',
      parameters: { reasoning_split: true }
    }))
  })

  it('edits and saves a provider that has no model configurations', async () => {
    const emptyProviderConfig = {
      ...config,
      providers: [{ ...config.providers[0], models: [] }]
    } satisfies AppConfigSnapshot
    const savedConfig = {
      ...emptyProviderConfig,
      providers: [{ ...emptyProviderConfig.providers[0], name: 'Renamed provider' }]
    } satisfies AppConfigSnapshot
    const saveModelProvider = vi.fn().mockResolvedValue(savedConfig)
    vi.stubGlobal('gale', { config: { saveModelProvider } })
    const { result } = renderHook(() => useModelSettingsState({
      config: emptyProviderConfig,
      openConfirmDialog: vi.fn(),
      setConfig: vi.fn(),
      setError: vi.fn(),
      setSettingsTab: vi.fn(),
      settingsOpen: false,
      settingsTab: 'model',
      t: ((key: string) => key) as TFunction
    }))

    await waitFor(() => expect(result.current.editingProvider?.id).toBe('provider-1'))
    expect(result.current.modelDraft.providerId).toBe('provider-1')
    expect(result.current.modelDraft.modelConfigId).toBeUndefined()

    act(() => result.current.updateModelDraft({ name: 'Renamed provider' }))

    await waitFor(() => expect(saveModelProvider).toHaveBeenCalledWith(expect.objectContaining({
      id: 'provider-1',
      name: 'Renamed provider'
    })))
    await waitFor(() => expect(result.current.modelDraft.name).toBe('Renamed provider'))
    expect(result.current.modelDraft.modelConfigId).toBeUndefined()
  })

  it('saves model list authentication as a provider change', async () => {
    const savedConfig = {
      ...config,
      providers: [{ ...config.providers[0], modelListAuth: 'anthropic' as const }]
    } satisfies AppConfigSnapshot
    const saveModelProvider = vi.fn().mockResolvedValue(savedConfig)
    vi.stubGlobal('gale', { config: { saveModelProvider } })
    const { result } = renderHook(() => useModelSettingsState({
      config,
      openConfirmDialog: vi.fn(),
      setConfig: vi.fn(),
      setError: vi.fn(),
      setSettingsTab: vi.fn(),
      settingsOpen: false,
      settingsTab: 'model',
      t: ((key: string) => key) as TFunction
    }))

    await waitFor(() => expect(result.current.editingProvider?.id).toBe('provider-1'))
    act(() => result.current.updateModelDraft({ modelListAuth: 'anthropic' }))

    await waitFor(() => expect(saveModelProvider).toHaveBeenCalledWith(expect.objectContaining({
      id: 'provider-1',
      modelListAuth: 'anthropic'
    })))
    await waitFor(() => expect(result.current.modelDraft.modelListAuth).toBe('anthropic'))
  })

  it('saves provider parameters independently from the selected model', async () => {
    const savedConfig = {
      ...config,
      providers: [{
        ...config.providers[0],
        parameters: { reasoning_split: true }
      }]
    } satisfies AppConfigSnapshot
    const saveModelProvider = vi.fn().mockResolvedValue(savedConfig)
    const saveProviderModel = vi.fn()
    vi.stubGlobal('gale', { config: { saveModelProvider, saveProviderModel } })
    const { result } = renderHook(() => useModelSettingsState({
      config,
      openConfirmDialog: vi.fn(),
      setConfig: vi.fn(),
      setError: vi.fn(),
      setSettingsTab: vi.fn(),
      settingsOpen: false,
      settingsTab: 'model',
      t: ((key: string) => key) as TFunction
    }))

    await waitFor(() => expect(result.current.editingProvider?.id).toBe('provider-1'))
    act(() => result.current.updateModelDraft({
      providerParametersJson: JSON.stringify({ reasoning_split: true })
    }))

    await waitFor(() => expect(saveModelProvider).toHaveBeenCalledWith(expect.objectContaining({
      id: 'provider-1',
      parameters: { reasoning_split: true }
    })))
    expect(saveProviderModel).not.toHaveBeenCalled()
  })

  it('returns to a provider-only draft after deleting its last model', async () => {
    const singleModelConfig = {
      ...config,
      providers: [{ ...config.providers[0], models: [config.providers[0].models[0]] }]
    } satisfies AppConfigSnapshot
    const emptiedConfig = {
      ...singleModelConfig,
      providers: [{ ...singleModelConfig.providers[0], models: [] }]
    } satisfies AppConfigSnapshot
    const openConfirmDialog = vi.fn()
    let currentConfig: AppConfigSnapshot = singleModelConfig
    const setConfig = vi.fn((nextConfig: AppConfigSnapshot) => {
      currentConfig = nextConfig
    })
    const deleteProviderModel = vi.fn().mockResolvedValue(emptiedConfig)
    vi.stubGlobal('gale', { config: { deleteProviderModel } })
    const { result, rerender } = renderHook(() => useModelSettingsState({
      config: currentConfig,
      openConfirmDialog,
      setConfig,
      setError: vi.fn(),
      setSettingsTab: vi.fn(),
      settingsOpen: false,
      settingsTab: 'model',
      t: ((key: string) => key) as TFunction
    }))

    await waitFor(() => expect(result.current.editingProvider?.id).toBe('provider-1'))
    await act(async () => {
      expect(await result.current.selectProviderModel(0)).toBe(true)
      expect(await result.current.deleteSelectedProviderModel()).toBe(true)
    })
    const request = openConfirmDialog.mock.calls[0]?.[0]
    expect(request).toBeDefined()
    await act(async () => request.onConfirm())
    rerender()

    expect(deleteProviderModel).toHaveBeenCalledWith('provider-1', 'model-1')
    expect(setConfig).toHaveBeenCalledWith(emptiedConfig)
    await waitFor(() => expect(result.current.modelDraft.modelConfigId).toBeUndefined())
    expect(result.current.modelDraft.providerId).toBe('provider-1')
    expect(result.current.editingProviderModelIndex).toBeUndefined()
  })

  it('adds selected model candidates in one request', async () => {
    const addedModels = [
      ...config.providers[0].models,
      { ...modelDefaults, id: 'model-3', index: 2, model: 'batch-a' },
      { ...modelDefaults, id: 'model-4', index: 3, model: 'batch-b' }
    ]
    const addedConfig = {
      ...config,
      providers: [{ ...config.providers[0], models: addedModels }]
    } satisfies AppConfigSnapshot
    const addProviderModels = vi.fn().mockResolvedValue(addedConfig)
    vi.stubGlobal('gale', { config: { addProviderModels } })
    const setConfig = vi.fn()
    const { result } = renderHook(() => useModelSettingsState({
      config,
      openConfirmDialog: vi.fn(),
      setConfig,
      setError: vi.fn(),
      setSettingsTab: vi.fn(),
      settingsOpen: false,
      settingsTab: 'model',
      t: ((key: string) => key) as TFunction
    }))

    await waitFor(() => expect(result.current.editingProvider?.id).toBe('provider-1'))
    await act(async () => {
      expect(await result.current.addProviderModels(['batch-a', 'batch-b', 'batch-a'])).toBe(true)
    })

    expect(addProviderModels).toHaveBeenCalledOnce()
    expect(addProviderModels.mock.calls[0][0].map((model: { model: string }) => model.model))
      .toEqual(['batch-a', 'batch-b'])
    expect(setConfig).toHaveBeenCalledWith(addedConfig)
    expect(notice.success).toHaveBeenCalledWith(
      'settings.models_added',
      { id: 'settings-model-status' }
    )
  })

  it('releases the navigation lock after a validation failure', async () => {
    const setSettingsTab = vi.fn()
    const saveProviderModel = vi.fn()
    vi.stubGlobal('gale', { config: { saveProviderModel } })
    const { result } = renderHook(() => useModelSettingsState({
      config,
      openConfirmDialog: vi.fn(),
      setConfig: vi.fn(),
      setError: vi.fn(),
      setSettingsTab,
      settingsOpen: false,
      settingsTab: 'model',
      t: ((key: string) => key) as TFunction
    }))

    await waitFor(() => expect(result.current.editingProvider?.id).toBe('provider-1'))
    await act(async () => {
      expect(await result.current.selectProviderModel(1)).toBe(true)
    })

    act(() => result.current.updateModelDraft({
      parametersJson: '{bad json}'
    }))
    await waitFor(() => expect(notice.error).toHaveBeenCalledWith(
      'settings.model_parameters_invalid_json',
      { id: 'settings-model-status' }
    ))

    await act(async () => {
      expect(await result.current.selectProviderModel(0)).toBe(true)
    })
    expect(result.current.modelDraft.model).toBe('existing-model')
    expect(saveProviderModel).not.toHaveBeenCalled()
    expect(setSettingsTab).not.toHaveBeenCalled()
  })

  it('releases the navigation lock after the save request fails', async () => {
    const setSettingsTab = vi.fn()
    const saveProviderModel = vi.fn(async () => { throw new Error('save failed') })
    vi.stubGlobal('gale', { config: { saveProviderModel } })
    const { result } = renderHook(() => useModelSettingsState({
      config,
      openConfirmDialog: vi.fn(),
      setConfig: vi.fn(),
      setError: vi.fn(),
      setSettingsTab,
      settingsOpen: false,
      settingsTab: 'model',
      t: ((key: string) => key) as TFunction
    }))

    await waitFor(() => expect(result.current.editingProvider?.id).toBe('provider-1'))
    act(() => result.current.updateModelDraft({ stream: false }))
    await waitFor(() => expect(notice.error).toHaveBeenCalledWith(
      'settings.failed_save_model',
      { id: 'settings-model-status' }
    ))

    await act(async () => {
      expect(await result.current.selectProviderModel(1)).toBe(true)
    })
    expect(saveProviderModel).toHaveBeenCalledOnce()
    expect(setSettingsTab).not.toHaveBeenCalled()
  })
})
