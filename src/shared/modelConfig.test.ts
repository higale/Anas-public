import { describe, expect, it } from 'vitest'
import {
  applyModelParameterPreset,
  defaultModelConfig,
  defaultModelProviderConfig,
  isSelectableModelConfig,
  mergeModelParameters,
  modelContextKey,
  modelReservedParameterKeys,
  requireModelListAuth,
  requireModelParameterPresetMode,
  requireModelProtocol,
  resolveProviderModelConfig
} from './modelConfig'
import type { ResolvedModelConfig } from './types'

describe('selectable model configuration', () => {
  it('identifies request context without depending on parameter property order or budget settings', () => {
    const model = { ...defaultModelConfig, id: 'model', index: 0, displayName: 'Model', model: 'model',
      providerId: 'provider', providerName: 'Provider', protocol: 'openai_chat_completions' as const,
      baseUrl: 'https://example.test/v1', parameters: { nested: { first: 1, second: 2 } } }
    const key = modelContextKey(model)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(modelContextKey({ ...model, parameters: { nested: { second: 2, first: 1 } },
      maxContextTokens: 5000, maxOutputTokens: 1000, contextCompressionThreshold: 0.5,
      apiKey: 'changed-credential' })).toBe(key)
    expect(modelContextKey({ ...model, parameters: { nested: { first: 3, second: 2 } } })).not.toBe(key)
    expect(modelContextKey({ ...model, protocol: 'openai_responses' })).not.toBe(key)
    expect(modelContextKey({ ...model, capabilities: { vision: false, toolUse: true } })).not.toBe(key)
  })
  it('requires both a base URL and model ID', () => {
    expect(isSelectableModelConfig({ baseUrl: 'https://example.com/v1', model: 'example-model' })).toBe(true)
    expect(isSelectableModelConfig({ baseUrl: '', model: 'example-model' })).toBe(false)
    expect(isSelectableModelConfig({ baseUrl: 'https://example.com/v1', model: '' })).toBe(false)
    expect(isSelectableModelConfig({ baseUrl: '   ', model: '   ' })).toBe(false)
  })

  it('loads new-model defaults only from the bundled config data', () => {
    expect(defaultModelProviderConfig).toEqual({ parameters: {} })
    expect(defaultModelConfig).toEqual({
      parameters: {},
      parameterPresetMode: 'protocol_default',
      capabilities: { vision: true, toolUse: true },
      stream: true,
      maxContextTokens: 256_000,
      maxOutputTokens: 16_000,
      contextCompressionThreshold: 0.8,
      contextCompressionEnabled: true
    })
  })

  it('identifies every top-level and runtime-owned reserved parameter alias', () => {
    expect(modelReservedParameterKeys({
      temperature: 0.2,
      display_name: 'Shadow name',
      model: 'shadow',
      max_tokens: 99,
      maxRetries: 5,
      model_list_auth: 'anthropic',
      parameterPresetMode: 'custom',
      stream: false
    })).toEqual([
      'display_name',
      'maxRetries',
      'max_tokens',
      'model',
      'model_list_auth',
      'parameterPresetMode',
      'stream'
    ])
  })

  it('reserves runtime messages and remote conversation state while allowing counted Responses instructions', () => {
    expect(modelReservedParameterKeys({ input: 'shadow input', messages: [], system: 'shadow system',
      previous_response_id: 'remote-response', conversation: 'remote-conversation', prompt: { id: 'remote-prompt' },
      instructions: 'Extra instructions' }))
      .toEqual(['conversation', 'input', 'messages', 'previous_response_id', 'prompt', 'system'])
  })

  it('reserves deprecated function declarations and selection in provider/model parameters', () => {
    expect(modelReservedParameterKeys({
      functions: [{ name: 'unregistered_tool', parameters: { type: 'object' } }],
      function_call: { name: 'unregistered_tool' },
      temperature: 0.2
    })).toEqual(['function_call', 'functions'])
  })

  it('strictly validates model-list authentication modes', () => {
    expect(requireModelListAuth('bearer', 'provider.modelListAuth')).toBe('bearer')
    expect(requireModelListAuth('anthropic', 'provider.modelListAuth')).toBe('anthropic')
    expect(() => requireModelListAuth(undefined, 'provider.modelListAuth')).toThrow('provider.modelListAuth')
    expect(() => requireModelListAuth('api-key', 'provider.modelListAuth')).toThrow('"bearer" or "anthropic"')
  })

  it('accepts only the three explicit model protocols', () => {
    expect(requireModelProtocol('openai_responses', 'provider.protocol')).toBe('openai_responses')
    expect(requireModelProtocol('openai_chat_completions', 'provider.protocol'))
      .toBe('openai_chat_completions')
    expect(requireModelProtocol('anthropic_messages', 'provider.protocol')).toBe('anthropic_messages')
    expect(() => requireModelProtocol('openai', 'provider.protocol'))
      .toThrow('openai_responses')
  })

  it('accepts only the three explicit reasoning option modes', () => {
    expect(requireModelParameterPresetMode('protocol_default', 'model.parameterPresetMode'))
      .toBe('protocol_default')
    expect(requireModelParameterPresetMode('custom', 'model.parameterPresetMode')).toBe('custom')
    expect(requireModelParameterPresetMode('none', 'model.parameterPresetMode')).toBe('none')
    expect(() => requireModelParameterPresetMode('enabled', 'model.parameterPresetMode'))
      .toThrow('protocol_default')
  })

  it('deep-merges a selected parameter preset while replacing arrays and scalars', () => {
    expect(mergeModelParameters({
      temperature: 0.7,
      reasoning: { enabled: false, budget: 1024 },
      stop: ['END']
    }, {
      reasoning: { enabled: true },
      stop: ['DONE']
    })).toEqual({
      temperature: 0.7,
      reasoning: { enabled: true, budget: 1024 },
      stop: ['DONE']
    })
  })

  it('applies only the selected preset parameters to a runtime model', () => {
    const model: ResolvedModelConfig = {
      id: 'model-1',
      displayName: '',
      model: 'example-model',
      parameters: { temperature: 0.7 },
      parameterPresets: [
        { id: 'thinking-on', name: 'Thinking on', parameters: { enable_thinking: true } },
        { id: 'thinking-off', name: 'Thinking off', parameters: { enable_thinking: false } }
      ],
      parameterPresetMode: 'custom',
      capabilities: { vision: true, toolUse: true },
      stream: true,
      maxContextTokens: 128_000,
      maxOutputTokens: 16_000,
      contextCompressionThreshold: 0.8,
      contextCompressionEnabled: true,
      providerId: 'provider-1',
      providerName: 'Provider',
      protocol: 'openai_chat_completions',
      baseUrl: 'https://example.com/v1'
    }
    expect(applyModelParameterPreset(model, 'thinking-off').parameters).toEqual({
      temperature: 0.7,
      enable_thinking: false
    })
    expect(applyModelParameterPreset(model, undefined)).toBe(model)
    expect(() => applyModelParameterPreset(model, 'missing')).toThrow('not found')
  })

  it('always merges configured parameters while removing unused reasoning options', () => {
    const resolved = resolveProviderModelConfig({
      id: 'provider-1',
      name: 'Provider',
      protocol: 'openai_chat_completions',
      baseUrl: 'https://example.com/v1',
      modelListUrl: '',
      modelListAuth: 'bearer',
      parameters: { reasoning_split: true },
      models: []
    }, {
      id: 'model-1',
      displayName: '',
      model: 'example-model',
      parameters: { temperature: 0.7 },
      parameterPresets: [{ id: 'thinking', name: 'Thinking', parameters: { enable_thinking: true } }],
      parameterPresetMode: 'none' as const,
      defaultParameterPresetId: 'thinking',
      capabilities: { vision: true, toolUse: true },
      stream: true,
      maxContextTokens: 128_000,
      maxOutputTokens: 16_000,
      contextCompressionThreshold: 0.8,
      contextCompressionEnabled: true
    })

    expect(resolved.parameters).toEqual({ reasoning_split: true, temperature: 0.7 })
    expect(resolved.parameterPresets).toEqual([])
    expect(resolved.defaultParameterPresetId).toBeUndefined()
  })

  it('derives stable reasoning options from the provider protocol', () => {
    const resolved = resolveProviderModelConfig({
      id: 'provider-1',
      name: 'Provider',
      protocol: 'openai_chat_completions',
      baseUrl: 'https://example.com/v1',
      modelListUrl: '',
      modelListAuth: 'bearer',
      parameters: {},
      models: []
    }, {
      id: 'model-1',
      displayName: '',
      model: 'example-model',
      parameters: {},
      parameterPresets: [{ id: 'custom', name: 'Custom', parameters: { reasoning_effort: 'custom' } }],
      parameterPresetMode: 'protocol_default',
      defaultParameterPresetId: 'openai_chat_completions/reasoning-medium',
      capabilities: { vision: true, toolUse: true },
      stream: true,
      maxContextTokens: 128_000,
      maxOutputTokens: 16_000,
      contextCompressionThreshold: 0.8,
      contextCompressionEnabled: true
    })

    expect(resolved.parameterPresets?.map((preset) => preset.id)).toContain(
      'openai_chat_completions/reasoning-medium'
    )
    expect(resolved.parameterPresets).not.toContainEqual(expect.objectContaining({ id: 'custom' }))
    expect(resolved.defaultParameterPresetId).toBe('openai_chat_completions/reasoning-medium')
    expect(applyModelParameterPreset(resolved, resolved.defaultParameterPresetId).parameters)
      .toEqual({ reasoning_effort: 'medium' })
  })

  it('deep-merges provider and model parameters with model values taking precedence', () => {
    const resolved = resolveProviderModelConfig({
      id: 'provider-1',
      name: 'Provider',
      protocol: 'openai_chat_completions',
      baseUrl: 'https://example.com/v1',
      modelListUrl: '',
      modelListAuth: 'bearer',
      parameters: {
        reasoning_split: true,
        thinking: { type: 'adaptive', budget: 2048 },
        stop: ['PROVIDER']
      },
      models: []
    }, {
      id: 'model-1',
      displayName: '',
      model: 'example-model',
      parameters: {
        thinking: { budget: 4096 },
        stop: ['MODEL']
      },
      parameterPresets: [{
        id: 'fast',
        name: 'Fast',
        parameters: { reasoning_split: false, thinking: { budget: 8192 } }
      }],
      parameterPresetMode: 'custom',
      capabilities: { vision: true, toolUse: true },
      stream: true,
      maxContextTokens: 128_000,
      maxOutputTokens: 16_000,
      contextCompressionThreshold: 0.8,
      contextCompressionEnabled: true
    })

    expect(resolved.parameters).toEqual({
      reasoning_split: true,
      thinking: { type: 'adaptive', budget: 4096 },
      stop: ['MODEL']
    })
    expect(applyModelParameterPreset(resolved, 'fast').parameters).toEqual({
      reasoning_split: false,
      thinking: { type: 'adaptive', budget: 8192 },
      stop: ['MODEL']
    })
  })

  it('lets model-level Responses server tools replace provider defaults', () => {
    const provider = {
      id: 'provider-1',
      name: 'Provider',
      protocol: 'openai_responses' as const,
      baseUrl: 'https://example.com/v1',
      modelListUrl: '',
      modelListAuth: 'bearer' as const,
      parameters: { tools: [{ type: 'web_search' }] },
      models: []
    }
    const model = {
      id: 'model-1',
      displayName: '',
      model: 'example-model',
      parameters: { tools: [{ type: 'code_interpreter', container: { type: 'auto' } }] },
      parameterPresetMode: 'none' as const,
      capabilities: { vision: true, toolUse: true },
      stream: true,
      maxContextTokens: 128_000,
      maxOutputTokens: 16_000,
      contextCompressionThreshold: 0.8,
      contextCompressionEnabled: true
    }

    expect(resolveProviderModelConfig(provider, model).parameters.tools).toEqual([
      { type: 'code_interpreter', container: { type: 'auto' } }
    ])
  })
})
