import { describe, expect, it } from 'vitest'
import type { ModelProviderConfigSave, ProviderModelConfigSave } from '@shared/types'
import type { RawModelProviderConfig, RawProviderModelConfig } from './rawAppConfig'
import {
  normalizeModelProvider,
  rawModelProviderFromSave,
  rawProviderModelFromSave,
  resolveModelConfig
} from './modelConfigMapper'

function providerSave(overrides: Partial<ModelProviderConfigSave> = {}): ModelProviderConfigSave {
  return {
    name: 'Provider',
    protocol: 'openai_chat_completions',
    baseUrl: 'https://example.com/v1',
    modelListUrl: '{base_url}/models',
    modelListAuth: 'bearer',
    apiKey: '',
    parameters: {},
    ...overrides
  }
}

function modelSave(overrides: Partial<ProviderModelConfigSave> = {}): ProviderModelConfigSave {
  return {
    providerId: 'provider-id',
    displayName: '',
    model: 'example-model',
    parameters: {},
    parameterPresetMode: 'none',
    capabilities: { vision: true, toolUse: true },
    stream: true,
    maxContextTokens: 128_000,
    maxOutputTokens: 16_000,
    contextCompressionThreshold: 0.8,
    contextCompressionEnabled: true,
    ...overrides
  }
}

function rawModel(id = 'model-id', model = 'example-model'): RawProviderModelConfig {
  return rawProviderModelFromSave(modelSave({ model }), id, 'openai_chat_completions')
}

function rawProvider(overrides: Partial<RawModelProviderConfig> = {}): RawModelProviderConfig {
  return {
    ...rawModelProviderFromSave(providerSave(), 'provider-id'),
    models: [rawModel()],
    ...overrides
  }
}

describe('model provider configuration mapper', () => {
  it('maps provider connection fields independently from concrete models', () => {
    expect(rawModelProviderFromSave(providerSave(), 'provider-id')).toMatchObject({
      id: 'provider-id',
      name: 'Provider',
      protocol: 'openai_chat_completions',
      base_url: 'https://example.com/v1',
      model_list_url: '{base_url}/models',
      model_list_auth: 'bearer',
      api_key: '',
      parameters: {},
      models: []
    })
  })

  it('persists and restores the explicit model-list authentication mode', () => {
    expect(rawModelProviderFromSave(providerSave({ modelListAuth: 'anthropic' }), 'provider-id'))
      .toMatchObject({ model_list_auth: 'anthropic' })
    expect(normalizeModelProvider(rawProvider({ model_list_auth: 'anthropic' }), 0))
      .toMatchObject({ modelListAuth: 'anthropic' })
  })

  it('persists and restores provider-level parameters', () => {
    const saved = rawModelProviderFromSave(providerSave({
      parameters: { reasoning_split: true }
    }), 'provider-id')
    expect(saved).toMatchObject({
      parameters: { reasoning_split: true }
    })
    expect(normalizeModelProvider({ ...saved, models: [] }, 0)).toMatchObject({
      parameters: { reasoning_split: true }
    })
  })

  it('uses the explicit provider defaults when new parameter fields are absent', () => {
    const missing = rawProvider()
    delete missing.parameters

    expect(normalizeModelProvider(missing, 0)).toMatchObject({
      parameters: {}
    })
  })

  it('defaults a missing model-list authentication mode to Bearer', () => {
    const missing = rawProvider()
    delete missing.model_list_auth

    expect(normalizeModelProvider(missing, 0)).toMatchObject({ modelListAuth: 'bearer' })
  })

  it('rejects invalid model-list authentication modes on read and save', () => {
    expect(() => normalizeModelProvider(rawProvider({ model_list_auth: 'api-key' }), 0))
      .toThrow('"bearer" or "anthropic"')
    expect(() => rawModelProviderFromSave(
      providerSave({ modelListAuth: 'api-key' as never }),
      'provider-id'
    )).toThrow('provider.modelListAuth')
  })

  it('maps model-specific fields into a provider child', () => {
    expect(rawProviderModelFromSave(modelSave({
      parameterPresetMode: 'custom',
      parameterPresets: [{ id: 'thinking-on', name: 'Thinking on', parameters: { enable_thinking: true } }],
      defaultParameterPresetId: 'thinking-on'
    }), 'model-id', 'openai_chat_completions')).toMatchObject({
      id: 'model-id',
      display_name: '',
      model: 'example-model',
      parameter_presets: [{ id: 'thinking-on', name: 'Thinking on', parameters: { enable_thinking: true } }],
      parameter_preset_mode: 'custom',
      default_parameter_preset_id: 'thinking-on',
      max_context_tokens: 128_000,
      max_output_tokens: 16_000,
      capabilities: { vision: true, tool_use: true }
    })
  })

  it('normalizes a provider hierarchy and resolves a runtime model', () => {
    const provider = normalizeModelProvider(rawProvider(), 0)
    expect(provider.models[0]).toMatchObject({ id: 'model-id', index: 0 })
    expect(provider.modelListAuth).toBe('bearer')
    expect(resolveModelConfig(provider, provider.models[0])).toMatchObject({
      id: 'model-id',
      providerId: 'provider-id',
      providerName: 'Provider',
      protocol: 'openai_chat_completions',
      model: 'example-model'
    })
  })

  it('requires an explicit parameter preset mode', () => {
    const model = rawModel()
    delete model.parameter_preset_mode

    expect(() => normalizeModelProvider(rawProvider({ models: [model] }), 0))
      .toThrow('parameter_preset_mode')
  })

  it('uses an empty display name when none is configured', () => {
    const model = rawModel()
    delete model.display_name

    expect(normalizeModelProvider(rawProvider({ models: [model] }), 0).models[0].displayName).toBe('')
  })

  it('allows a provider to contain no models', () => {
    expect(normalizeModelProvider(rawProvider({ models: [] }), 0).models).toEqual([])
  })

  it('requires the provider models field to be an array', () => {
    const provider = rawProvider()
    delete provider.models
    expect(() => normalizeModelProvider(provider, 0)).toThrow('must be an array')
  })

  it('allows duplicate remote model IDs within one provider', () => {
    const provider = normalizeModelProvider(rawProvider({
      models: [rawModel('first'), rawModel('second')]
    }), 0)

    expect(provider.models.map((model) => model.id)).toEqual(['first', 'second'])
    expect(provider.models.map((model) => model.model)).toEqual(['example-model', 'example-model'])
  })

  it('rejects reserved extra parameters', () => {
    expect(() => rawModelProviderFromSave(providerSave({ parameters: { max_tokens: 99 } }), 'provider-id'))
      .toThrow('reserved keys')
    expect(() => rawProviderModelFromSave(
      modelSave({ parameters: { max_tokens: 99 } }),
      'model-id',
      'openai_chat_completions'
    ))
      .toThrow('reserved keys')
  })

  it.each(['functions', 'function_call'])('rejects %s when saving and loading provider/model/preset parameters', (field) => {
    const parameters = { [field]: field === 'functions'
      ? [{ name: 'unregistered', description: 'x'.repeat(20_000), parameters: { type: 'object' } }]
      : { name: 'unregistered' } }
    const expected = `reserved keys: ${field}`
    expect(() => rawModelProviderFromSave(providerSave({ parameters }), 'provider-id')).toThrow(expected)
    expect(() => rawProviderModelFromSave(modelSave({ parameters }), 'model-id', 'openai_chat_completions')).toThrow(expected)
    expect(() => rawProviderModelFromSave(modelSave({ parameterPresetMode: 'custom',
      parameterPresets: [{ id: 'invalid', name: 'Invalid', parameters }]
    }), 'model-id', 'openai_chat_completions')).toThrow(expected)
    expect(() => normalizeModelProvider(rawProvider({ parameters }), 0)).toThrow(expected)
    expect(() => normalizeModelProvider(rawProvider({ models: [{ ...rawModel(), parameters }] }), 0)).toThrow(expected)
  })

  it('validates parameter preset names, parameters, and the default reference', () => {
    expect(() => rawProviderModelFromSave(modelSave({
      parameterPresets: [{ id: 'thinking', name: 'Thinking', parameters: { model: 'shadow' } }]
    }), 'model-id', 'openai_chat_completions')).toThrow('reserved keys')
    expect(() => rawProviderModelFromSave(modelSave({
      parameterPresetMode: 'custom',
      parameterPresets: [{ id: 'thinking', name: 'Thinking', parameters: {} }],
      defaultParameterPresetId: 'missing'
    }), 'model-id', 'openai_chat_completions')).toThrow('does not reference')
  })

  it('persists and restores a protocol default reasoning option', () => {
    const model = rawProviderModelFromSave(modelSave({
      parameterPresetMode: 'protocol_default',
      defaultParameterPresetId: 'openai_chat_completions/reasoning-medium'
    }), 'model-id', 'openai_chat_completions')

    expect(model.default_parameter_preset_id)
      .toBe('openai_chat_completions/reasoning-medium')
    expect(normalizeModelProvider(rawProvider({ models: [model] }), 0).models[0].defaultParameterPresetId)
      .toBe('openai_chat_completions/reasoning-medium')
  })

  it('rejects a protocol default reasoning option outside the active protocol', () => {
    expect(() => rawProviderModelFromSave(modelSave({
      parameterPresetMode: 'protocol_default',
      defaultParameterPresetId: 'openai_responses/reasoning-medium'
    }), 'model-id', 'openai_chat_completions')).toThrow('does not reference')
  })

  it('clears protocol defaults when the provider protocol changes', () => {
    const protocolModel = rawProviderModelFromSave(modelSave({
      parameterPresetMode: 'protocol_default',
      defaultParameterPresetId: 'openai_chat_completions/reasoning-medium'
    }), 'protocol-model', 'openai_chat_completions')
    const customModel = rawProviderModelFromSave(modelSave({
      parameterPresetMode: 'custom',
      parameterPresets: [{ id: 'custom', name: 'Custom', parameters: {} }],
      defaultParameterPresetId: 'custom'
    }), 'custom-model', 'openai_chat_completions')
    const existing = rawProvider({ models: [protocolModel, customModel] })

    const saved = rawModelProviderFromSave(
      providerSave({ protocol: 'openai_responses' }),
      'provider-id',
      existing
    )

    expect(saved.models?.[0].default_parameter_preset_id).toBeUndefined()
    expect(saved.models?.[1].default_parameter_preset_id).toBe('custom')
  })

  it('allows zero output tokens but rejects output limits at least as large as context', () => {
    expect(rawProviderModelFromSave(
      modelSave({ maxOutputTokens: 0 }),
      'model-id',
      'openai_chat_completions'
    ).max_output_tokens).toBe(0)
    expect(() => rawProviderModelFromSave(
      modelSave({ maxContextTokens: 4_000, maxOutputTokens: 4_000 }),
      'model-id',
      'openai_chat_completions'
    ))
      .toThrow('smaller')
  })

  it('keeps provider and model configuration IDs immutable', () => {
    expect(() => rawModelProviderFromSave(providerSave(), 'renamed', rawProvider())).toThrow('cannot be changed')
    expect(() => rawProviderModelFromSave(
      modelSave(),
      'renamed',
      'openai_chat_completions',
      rawModel()
    )).toThrow('cannot be changed')
  })
})
