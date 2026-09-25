import { defaultCapabilitySettings } from '@shared/agentCapabilities'
import { diffViewSettingsFixture } from '../../test/diffViewSettingsFixture'
import { environmentContextFixture } from '../../test/environmentContextFixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppConfigSnapshot, AppSettings, ModelProviderConfigDetail, ProjectModelSelection } from '@shared/types'
import { resolveProviderModelConfig } from '@shared/modelConfig'
import { AgentDatabase } from './agentDatabase'
import { AgentRuntime } from './agentRuntime'

const previewMocks = vi.hoisted(() => ({
  captureAgentModelRequest: vi.fn(),
  captureAgentSystemPrompt: vi.fn(),
  projectAgentContextStatus: vi.fn(),
  getAppConfigSnapshot: vi.fn(),
  createAgentInstance: vi.fn()
}))

vi.mock('../config/appConfig', async (importOriginal) => ({
  ...await importOriginal<typeof import('../config/appConfig')>(),
  getAppConfigSnapshot: previewMocks.getAppConfigSnapshot
}))

vi.mock('./agentFactory', () => ({
  captureAgentModelRequest: previewMocks.captureAgentModelRequest,
  captureAgentSystemPrompt: previewMocks.captureAgentSystemPrompt,
  projectAgentContextStatus: previewMocks.projectAgentContextStatus,
  createAgentInstance: previewMocks.createAgentInstance
}))

async function noOpFileEditCleanup(): Promise<void> {}

function provider(index: number, name: string): ModelProviderConfigDetail {
  return {
    index,
    id: `provider-${index}`,
    name,
    protocol: 'openai_chat_completions',
    baseUrl: 'https://preview.invalid/v1',
    modelListUrl: '',
    modelListAuth: 'bearer',
    parameters: {},
    models: [{
      index: 0,
      id: `model-${index}`,
      displayName: '',
      model: `model-${index}`,
      parameters: {},
      parameterPresetMode: 'none',
      capabilities: { vision: true, toolUse: true },
      stream: true,
      maxContextTokens: 100_000,
      maxOutputTokens: 4_000,
      contextCompressionThreshold: 0.8,
      contextCompressionEnabled: true
    }]
  }
}

describe('AgentRuntime system prompt preview', () => {
  let database: AgentDatabase | undefined

  afterEach(() => {
    database?.close()
    database = undefined
    previewMocks.captureAgentModelRequest.mockReset()
    previewMocks.captureAgentSystemPrompt.mockReset()
    previewMocks.projectAgentContextStatus.mockReset()
    previewMocks.getAppConfigSnapshot.mockReset()
    previewMocks.createAgentInstance.mockReset()
  })

  it('does not initialize configured MCP or model dependencies for a history snapshot', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Offline history' })
    const configuredProvider = provider(0, 'Configured')
    const defaultModel = resolveProviderModelConfig(configuredProvider, configuredProvider.models[0])
    previewMocks.getAppConfigSnapshot.mockResolvedValue({ customTools: [],
      defaultCapabilities: structuredClone(defaultCapabilitySettings),
      providers: [configuredProvider],
      subagents: [],
      mcpServers: [{
        index: 0,
        name: 'Offline MCP',
        enabled: true,
        type: 'http',
        url: 'https://offline.invalid/mcp',
        id: 'offline-mcp',
        command: '',
        args: [],
        workingDir: '',
        timeoutMs: 30_000,
        env: {}
      }],
      settings: {
        profile: {
          assistant: { name: 'Anas', role: 'Assistant', instructions: '', newAvatarPath: '' },
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
        sidebarCollapsedSections: {
          projects: false,
          simpleChats: false
        },
        backupDir: ''
      },
      defaultModelId: defaultModel.id,
      defaultModel
    } satisfies AppConfigSnapshot)
    previewMocks.createAgentInstance.mockRejectedValue(
      new Error('Configured MCP is offline.')
    )
    const runtime = new AgentRuntime(database, undefined, undefined, noOpFileEditCleanup)

    await expect(runtime.getSnapshot(thread.id)).resolves.toMatchObject({
      thread: { id: thread.id },
      messages: [],
      interrupts: []
    })
    expect(previewMocks.getAppConfigSnapshot).not.toHaveBeenCalled()
    expect(previewMocks.createAgentInstance).not.toHaveBeenCalled()
    expect(previewMocks.projectAgentContextStatus).not.toHaveBeenCalled()
  })

  it('uses project draft settings without changing the persisted main model', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Preview' })
    const firstProvider = provider(0, 'First')
    const selectedProvider = provider(1, 'Selected')
    const firstModel = resolveProviderModelConfig(firstProvider, firstProvider.models[0])
    const settings: AppSettings = {
      profile: {
        assistant: { name: 'Anas', role: 'Assistant', instructions: '', newAvatarPath: '' },
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
      sidebarCollapsedSections: {
        projects: false,
        simpleChats: false
      },
      backupDir: ''
    }
    previewMocks.getAppConfigSnapshot.mockResolvedValue({ customTools: [],
      defaultCapabilities: structuredClone(defaultCapabilitySettings),
      providers: [firstProvider, selectedProvider],
      subagents: [],
      mcpServers: [],
      settings,
      defaultModelId: firstModel.id,
      defaultModel: firstModel
    } satisfies AppConfigSnapshot)
    previewMocks.captureAgentSystemPrompt.mockResolvedValue('FINAL SYSTEM PROMPT')
    const runtime = new AgentRuntime(database, undefined, undefined, noOpFileEditCleanup)

    const preview = await runtime.previewSystemContext({
      projectId: thread.projectId,
      project: { kind: 'simple_chat', name: 'Draft', prompt: 'Unsaved prompt' },
      settings
    })

    expect(preview).toEqual({ content: 'FINAL SYSTEM PROMPT' })
    expect(previewMocks.captureAgentSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: thread.projectId, userTurnCount: 0 }),
      database,
      expect.objectContaining({
        settings,
        defaultModel: firstModel
      }),
      expect.objectContaining({ prompt: 'Unsaved prompt', name: 'Draft' })
    )
  })

  it('binds a synthetic new-thread preview to the currently selected model', async () => {
    database = AgentDatabase.open(':memory:')
    const defaultProvider = provider(0, 'Default')
    const selectedProvider = provider(1, 'Selected')
    const defaultModel = resolveProviderModelConfig(defaultProvider, defaultProvider.models[0])
    const selectedModel = resolveProviderModelConfig(selectedProvider, selectedProvider.models[0])
    const settings = {
      profile: {
        assistant: { name: 'Anas', role: 'Assistant', instructions: '', newAvatarPath: '' },
        user: { preferredName: '', personalInfo: '' }
      },
      speechReply: { enabled: false, voice: '', speed: 1 },
      language: 'en',
      theme: 'dark',
      fontSize: 14,
      chatContentWidth: 'narrow',
      newThreadModelSelection: 'prompt',
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
    } satisfies AppSettings
    previewMocks.getAppConfigSnapshot.mockResolvedValue({ customTools: [],
      defaultCapabilities: structuredClone(defaultCapabilitySettings),
      providers: [defaultProvider, selectedProvider],
      subagents: [],
      mcpServers: [],
      settings,
      defaultModelId: defaultModel.id,
      defaultModel
    } satisfies AppConfigSnapshot)
    previewMocks.captureAgentSystemPrompt.mockResolvedValue('SELECTED MODEL PROMPT')
    const runtime = new AgentRuntime(database, undefined, undefined, noOpFileEditCleanup)

    await expect(runtime.previewSystemContext({
      projectId: '0',
      project: { kind: 'simple_chat', name: 'Draft', prompt: '', modelConfigId: selectedModel.id },
      settings
    })).resolves.toEqual({ content: 'SELECTED MODEL PROMPT' })
    expect(previewMocks.captureAgentSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'system-context-preview',
        modelConfigId: selectedModel.id,
        projectId: '0'
      }),
      database,
      expect.objectContaining({ defaultModel }),
      expect.objectContaining({ modelConfigId: selectedModel.id })
    )
  })

  const previewSelections: Array<{
    name: string
    project?: ProjectModelSelection
    defaultIndex?: number
    incompleteIndex?: number
    empty?: boolean
    expectedIndex?: number
    expectedPreset?: string
  }> = [
    { name: 'project before default', project: { modelConfigId: 'model-2', modelParameterPresetId: 'custom' }, defaultIndex: 1, expectedIndex: 2, expectedPreset: 'custom' },
    { name: 'explicit empty project preset', project: { modelConfigId: 'model-2', modelParameterPresetId: null }, defaultIndex: 1, expectedIndex: 2 },
    { name: 'inherited project preset', project: { modelConfigId: 'model-2' }, defaultIndex: 1, expectedIndex: 2, expectedPreset: 'preset-2' },
    { name: 'removed project preset', project: { modelConfigId: 'model-2', modelParameterPresetId: 'deleted' }, defaultIndex: 1, expectedIndex: 2, expectedPreset: 'preset-2' },
    { name: 'default before first', defaultIndex: 1, expectedIndex: 1, expectedPreset: 'preset-1' },
    { name: 'first without default', expectedIndex: 0, expectedPreset: 'preset-0' },
    { name: 'skip incomplete default', defaultIndex: 1, incompleteIndex: 1, expectedIndex: 0, expectedPreset: 'preset-0' },
    { name: 'skip incomplete first', incompleteIndex: 0, expectedIndex: 1, expectedPreset: 'preset-1' },
    { name: 'removed project model', project: { modelConfigId: 'deleted', modelParameterPresetId: 'custom' }, defaultIndex: 1, expectedIndex: 1, expectedPreset: 'preset-1' },
    { name: 'incomplete project model', project: { modelConfigId: 'model-2', modelParameterPresetId: 'custom' }, incompleteIndex: 2, defaultIndex: 1, expectedIndex: 1, expectedPreset: 'preset-1' },
    { name: 'no configured models', empty: true }
  ]

  it.each((['default', 'current', 'prompt'] as const).flatMap((strategy) => (
    previewSelections.map((scenario) => ({ ...scenario, strategy }))
  )))('shares preview selection without persisting it: $name, chat strategy $strategy', async (scenario) => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Request preview' })
    const providers = scenario.empty ? [] : ['First', 'Default', 'Project'].map((name, index) => {
      const entry = provider(index, name)
      entry.models[0].parameterPresetMode = 'custom'
      entry.models[0].defaultParameterPresetId = `preset-${index}`
      entry.models[0].parameterPresets = [
        { id: `preset-${index}`, name: 'Model default', parameters: { temperature: 0.5 } },
        { id: 'custom', name: 'Project custom', parameters: { temperature: 0.1 } }
      ]
      if (scenario.incompleteIndex === index) entry.baseUrl = ''
      return entry
    })
    const defaultProvider = scenario.defaultIndex === undefined ? undefined : providers[scenario.defaultIndex]
    const defaultModel = defaultProvider && resolveProviderModelConfig(defaultProvider, defaultProvider.models[0])
    const settings = {
      profile: {
        assistant: { name: 'Anas', role: 'Assistant', instructions: '', newAvatarPath: '' },
        user: { preferredName: '', personalInfo: '' }
      },
      speechReply: { enabled: false, voice: '', speed: 1 },
      language: 'en',
      theme: 'dark',
      fontSize: 14,
      chatContentWidth: 'narrow',
      newThreadModelSelection: scenario.strategy,
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
    } satisfies AppSettings
    const config: AppConfigSnapshot = { customTools: [],
      defaultCapabilities: structuredClone(defaultCapabilitySettings),
      providers,
      subagents: [],
      mcpServers: [],
      settings,
      defaultModelId: defaultModel?.id,
      defaultModel
    }
    const savedConfig = structuredClone(config)
    previewMocks.getAppConfigSnapshot.mockResolvedValue(config)
    previewMocks.captureAgentModelRequest.mockResolvedValue('{"request":{}}')
    previewMocks.captureAgentSystemPrompt.mockResolvedValue('SYSTEM PROMPT')
    const runtime = new AgentRuntime(database, undefined, undefined, noOpFileEditCleanup)
    const input = {
      projectId: thread.projectId,
      project: { kind: 'simple_chat' as const, name: 'Draft', prompt: 'Unsaved prompt', ...scenario.project },
      settings
    }
    const draftBefore = structuredClone(input.project)
    if (scenario.expectedIndex === undefined) {
      await expect(runtime.previewSystemContext(input)).rejects.toThrow('No selectable model')
      await expect(runtime.previewModelRequest(input)).rejects.toThrow('No selectable model')
      expect(previewMocks.captureAgentSystemPrompt).not.toHaveBeenCalled()
      expect(previewMocks.captureAgentModelRequest).not.toHaveBeenCalled()
    } else {
      await expect(runtime.previewSystemContext(input)).resolves.toEqual({ content: 'SYSTEM PROMPT' })
      await expect(runtime.previewModelRequest(input)).resolves.toEqual({ content: '{"request":{}}' })
      const expectedThread = expect.objectContaining({
        projectId: thread.projectId,
        userTurnCount: 0,
        modelConfigId: `model-${scenario.expectedIndex}`,
        modelParameterPresetId: scenario.expectedPreset
      })
      expect(previewMocks.captureAgentSystemPrompt).toHaveBeenCalledWith(
        expectedThread, database, config, expect.objectContaining(draftBefore)
      )
      expect(previewMocks.captureAgentModelRequest).toHaveBeenCalledWith(
        expectedThread, database, config,
        expect.objectContaining({ read: expect.any(Function), wait: expect.any(Function) }),
        expect.objectContaining(draftBefore)
      )
    }
    expect(config).toEqual(savedConfig)
    expect(input.project).toEqual(draftBefore)
    expect(database.getThread(thread.id)).toEqual(thread)
    expect(database.getThread('system-context-preview')).toBeNull()
    expect(database.getThread('model-request-preview')).toBeNull()
  })
})
