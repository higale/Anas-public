import type { TFunction } from 'i18next'
import { describe, expect, it, vi } from 'vitest'
import {
  buildModelListRequest,
  buildProviderModelPayload,
  buildProviderPayload,
  emptyModelDraft,
  modelConfigToDraft,
  modelTemplateToDraft,
  providerConfigToDraft,
  validateModelProviderDraft,
  validateProviderModelDraft
} from './modelDraft'
import { defaultModelConfig } from '@shared/modelConfig'
import { getModelTemplate, modelTemplates } from '@shared/modelTemplates'

const t = vi.fn((key: string, options?: Record<string, unknown>) => (
  options?.keys ? `${key}:${String(options.keys)}` : key
)) as unknown as TFunction

describe('model draft configuration', () => {
  it('uses the bundled data defaults for a new model', () => {
    expect(emptyModelDraft()).toMatchObject({
      protocol: 'openai_chat_completions',
      modelListAuth: 'bearer',
      displayName: '',
      parametersJson: '',
      parameterPresetMode: 'protocol_default',
      capabilities: { vision: true, toolUse: true },
      stream: true,
      maxContextTokens: '256000',
      maxOutputTokens: '16000',
      contextCompressionThreshold: 0.8,
      contextCompressionEnabled: true
    })
  })

  it('reports reserved extra parameters before sending a save request', () => {
    const draft = {
      ...emptyModelDraft(),
      name: 'Strict model',
      parametersJson: JSON.stringify({ stream: false, model: 'shadow', temperature: 0.2 })
    }
    expect(validateProviderModelDraft({ ...draft, providerId: 'provider' }, t))
      .toBe('settings.model_parameters_reserved:model, stream')
  })

  it('accepts zero maximum output tokens as provider-default mode', () => {
    const draft = {
      ...emptyModelDraft(),
      name: 'Provider default',
      model: 'example-model',
      maxOutputTokens: '0'
    }

    expect(buildProviderModelPayload({ ...draft, providerId: 'provider' }))
      .toMatchObject({ maxOutputTokens: 0 })
  })

  it('round-trips the optional model display name independently from the model ID', () => {
    const draft = {
      ...emptyModelDraft(),
      providerId: 'provider',
      displayName: 'Friendly model',
      model: 'remote-model'
    }

    expect(buildProviderModelPayload(draft)).toMatchObject({
      displayName: 'Friendly model',
      model: 'remote-model'
    })
    expect(modelConfigToDraft({
      id: 'provider',
      index: 0,
      name: 'Provider',
      protocol: 'openai_chat_completions',
      baseUrl: 'https://example.com/v1',
      modelListUrl: '{base_url}/models',
      modelListAuth: 'bearer',
      parameters: {},
      models: [{
        ...defaultModelConfig,
        id: 'model-config',
        index: 0,
        displayName: 'Friendly model',
        model: 'remote-model'
      }]
    })).toMatchObject({
      displayName: 'Friendly model',
      model: 'remote-model'
    })
  })

  it('creates a provider-only draft when no models are configured', () => {
    const draft = providerConfigToDraft({
      id: 'provider',
      index: 0,
      name: 'Empty provider',
      protocol: 'anthropic_messages',
      baseUrl: 'https://example.com',
      modelListUrl: '{base_url}/models',
      modelListAuth: 'anthropic',
      apiKey: 'secret',
      parameters: {},
      models: []
    })
    expect(draft).toMatchObject({
      providerId: 'provider',
      providerIndex: 0,
      name: 'Empty provider',
      protocol: 'anthropic_messages',
      baseUrl: 'https://example.com',
      modelListUrl: '{base_url}/models',
      modelListAuth: 'anthropic',
      apiKey: 'secret',
      model: ''
    })
    expect(draft.modelConfigId).toBeUndefined()
  })

  it('builds model parameter presets and rejects invalid preset parameters', () => {
    const draft = {
      ...emptyModelDraft(),
      providerId: 'provider',
      model: 'example-model',
      parameterPresetMode: 'custom' as const,
      parameterPresets: [{
        id: 'thinking-on',
        name: '思考开启',
        parametersJson: '{"enable_thinking":true}'
      }],
      defaultParameterPresetId: 'thinking-on'
    }
    expect(buildProviderModelPayload(draft)).toMatchObject({
      parameterPresets: [{
        id: 'thinking-on',
        name: '思考开启',
        parameters: { enable_thinking: true }
      }],
      parameterPresetMode: 'custom',
      defaultParameterPresetId: 'thinking-on'
    })
    expect(validateProviderModelDraft({
      ...draft,
      parameterPresets: [{ ...draft.parameterPresets[0], parametersJson: '{bad json}' }]
    }, t)).toBe('settings.model_parameter_preset_invalid_json')
  })

  it('accepts a default reasoning option from the active protocol', () => {
    const draft = {
      ...emptyModelDraft(),
      providerId: 'provider',
      model: 'example-model',
      parameterPresetMode: 'protocol_default' as const,
      defaultParameterPresetId: 'openai_chat_completions/reasoning-medium'
    }

    expect(buildProviderModelPayload(draft)).toMatchObject({
      parameterPresetMode: 'protocol_default',
      defaultParameterPresetId: 'openai_chat_completions/reasoning-medium'
    })
    expect(buildProviderModelPayload({
      ...draft,
      defaultParameterPresetId: 'openai_responses/reasoning-medium'
    })).toBeUndefined()
  })

  it('validates stored custom reasoning options independently from their active mode', () => {
    const draft = {
      ...emptyModelDraft(),
      providerId: 'provider',
      model: 'example-model',
      parameterPresets: [{ id: 'thinking', name: 'Thinking', parametersJson: '{bad json}' }],
      defaultParameterPresetId: 'thinking'
    }

    expect(validateProviderModelDraft(draft, t)).toBe('settings.model_parameter_preset_invalid_json')
    expect(buildProviderModelPayload(draft)).toBeUndefined()
    expect(validateProviderModelDraft({ ...draft, parametersJson: '{bad json}' }, t))
      .toBe('settings.model_parameters_invalid_json')
  })

  it('copies every connection field from a model template', () => {
    const template = modelTemplates[0]
    expect(modelTemplateToDraft(template)).toMatchObject({
      name: template.name,
      protocol: template.protocol,
      baseUrl: template.baseUrl,
      modelListUrl: template.modelListUrl,
      modelListAuth: template.modelListAuth,
      providerParametersJson: '',
      model: '',
      displayName: '',
      parametersJson: '',
      parameterPresetMode: 'protocol_default',
      capabilities: defaultModelConfig.capabilities,
      stream: defaultModelConfig.stream,
      maxContextTokens: String(defaultModelConfig.maxContextTokens),
      maxOutputTokens: String(defaultModelConfig.maxOutputTokens),
      contextCompressionThreshold: defaultModelConfig.contextCompressionThreshold,
      contextCompressionEnabled: defaultModelConfig.contextCompressionEnabled
    })
  })

  it('copies MiniMax OpenAI provider parameters without applying them to Anthropic', () => {
    const openAiTemplate = getModelTemplate('china/minimax/openai')
    const anthropicTemplate = getModelTemplate('china/minimax/anthropic')
    if (!openAiTemplate || !anthropicTemplate) throw new Error('Expected MiniMax provider templates.')

    expect(modelTemplateToDraft(openAiTemplate)).toMatchObject({
      providerParametersJson: JSON.stringify({ reasoning_split: true }, null, 2)
    })
    expect(modelTemplateToDraft(anthropicTemplate)).toMatchObject({
      providerParametersJson: ''
    })
  })

  it('validates and serializes provider-level parameters independently from model parameters', () => {
    const draft = {
      ...emptyModelDraft(),
      providerParametersJson: JSON.stringify({ reasoning_split: true })
    }

    expect(validateModelProviderDraft(draft, t)).toBeUndefined()
    expect(buildProviderPayload(draft)).toMatchObject({
      parameters: { reasoning_split: true }
    })
    expect(validateModelProviderDraft({
      ...draft,
      providerParametersJson: JSON.stringify({ model: 'shadow' })
    }, t)).toBe('settings.model_parameters_reserved:model')
  })

  it('keeps an empty model list URL so the main process can infer it', () => {
    expect(buildModelListRequest({
      ...emptyModelDraft(),
      baseUrl: 'https://example.com/v1',
      modelListUrl: ''
    })).toMatchObject({
      baseUrl: 'https://example.com/v1',
      modelListUrl: '',
      modelListAuth: 'bearer'
    })
  })

  it('persists model list authentication and includes it in list requests', () => {
    const draft = {
      ...emptyModelDraft(),
      baseUrl: 'https://api.anthropic.com',
      modelListUrl: 'https://api.anthropic.com/v1/models',
      modelListAuth: 'anthropic' as const
    }

    expect(buildProviderPayload(draft)).toMatchObject({ modelListAuth: 'anthropic' })
    expect(buildModelListRequest(draft)).toMatchObject({ modelListAuth: 'anthropic' })
  })
})
