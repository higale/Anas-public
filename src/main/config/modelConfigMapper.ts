import type {
  ModelCapabilities,
  ModelProviderConfig,
  ModelProviderConfigDetail,
  ModelProviderConfigSave,
  ModelParameterPreset,
  ModelProtocol,
  ProviderModelConfig,
  ProviderModelConfigSave,
  ResolvedModelConfig
} from '@shared/types'
import {
  defaultModelProviderConfig,
  modelReservedParameterKeys,
  requireModelParameterPresetMode,
  requireModelListAuth,
  requireModelProtocol,
  resolveModelParameterPresets,
  resolveProviderModelConfig
} from '@shared/modelConfig'
import type { RawModelProviderConfig, RawProviderModelConfig } from './rawAppConfig'

const minMaxContextTokens = 2000
const minMaxOutputTokens = 0
const configIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

function normalizeConfigId(value: unknown, path: string): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!configIdPattern.test(id)) {
    throw new Error(`Config value ${path} must be 1-64 letters, numbers, underscores, or hyphens.`)
  }
  return id
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`Config value ${path} must be a string.`)
  return value
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Config value ${path} must be a boolean.`)
  return value
}

function normalizeParameters(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Config value ${path} must be an object.`)
  }
  const parameters = value as Record<string, unknown>
  const reserved = modelReservedParameterKeys(parameters)
  if (reserved.length > 0) {
    throw new Error(`Config value ${path} contains reserved keys: ${reserved.join(', ')}.`)
  }
  return parameters
}

function normalizeParameterPresets(
  value: RawProviderModelConfig['parameter_presets'],
  path: string
): ModelParameterPreset[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`Config value ${path} must be an array.`)
  const ids = new Set<string>()
  const names = new Set<string>()
  return value.map((raw, index) => {
    const presetPath = `${path}[${index}]`
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Config value ${presetPath} must be an object.`)
    }
    const id = normalizeConfigId(raw.id, `${presetPath}.id`)
    const name = requireString(raw.name, `${presetPath}.name`).trim()
    if (!name) throw new Error(`Config value ${presetPath}.name must not be empty.`)
    if (ids.has(id)) throw new Error(`Config value ${path} contains duplicate ID "${id}".`)
    if (names.has(name)) throw new Error(`Config value ${path} contains duplicate name "${name}".`)
    ids.add(id)
    names.add(name)
    return {
      id,
      name,
      parameters: normalizeParameters(raw.parameters, `${presetPath}.parameters`)
    }
  })
}

function normalizeDefaultParameterPresetId(
  value: unknown,
  presets: ModelParameterPreset[],
  path: string
): string | undefined {
  if (value === undefined || value === '') return undefined
  const id = requireString(value, path)
  if (!presets.some((preset) => preset.id === id)) {
    throw new Error(`Config value ${path} does not reference a configured parameter preset.`)
  }
  return id
}

function normalizeCapabilities(value: RawProviderModelConfig['capabilities'], path: string): ModelCapabilities {
  if (!value || typeof value !== 'object') throw new Error(`Config value ${path} must be an object.`)
  if (typeof value.vision !== 'boolean') throw new Error(`Config value ${path}.vision must be a boolean.`)
  if (typeof value.tool_use !== 'boolean') throw new Error(`Config value ${path}.tool_use must be a boolean.`)
  return { vision: value.vision, toolUse: value.tool_use }
}

function normalizeIntegerAtLeast(value: unknown, path: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Config value ${path} must be a number.`)
  }
  const normalized = Math.floor(value)
  if (normalized < minimum) throw new Error(`Config value ${path} must be at least ${minimum}.`)
  return normalized
}

function normalizeContextCompressionThreshold(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Config value ${path} must be a number.`)
  }
  if (value < 0.1 || value > 0.95) {
    throw new Error(`Config value ${path} must be between 0.1 and 0.95.`)
  }
  return value
}

export function rawModelProviderFromSave(
  provider: ModelProviderConfigSave,
  internalId: string,
  existing?: RawModelProviderConfig
): RawModelProviderConfig {
  const id = normalizeConfigId(internalId, 'provider.id')
  if (existing?.id !== undefined && normalizeConfigId(existing.id, 'provider.id') !== id) {
    throw new Error('Provider IDs cannot be changed after creation.')
  }
  const protocol = requireModelProtocol(provider.protocol, 'provider.protocol')
  const protocolChanged = existing?.protocol !== undefined
    && requireModelProtocol(existing.protocol, 'provider.protocol') !== protocol
  const models = (existing?.models ?? []).map((model) => (
    protocolChanged && model.parameter_preset_mode === 'protocol_default'
      ? { ...model, default_parameter_preset_id: undefined }
      : model
  ))
  return {
    id,
    name: requireString(provider.name, 'provider.name'),
    protocol,
    base_url: requireString(provider.baseUrl, 'provider.baseUrl'),
    model_list_url: provider.modelListUrl === undefined
      ? ''
      : requireString(provider.modelListUrl, 'provider.modelListUrl'),
    model_list_auth: requireModelListAuth(provider.modelListAuth, 'provider.modelListAuth'),
    api_key: requireString(provider.apiKey, 'provider.apiKey'),
    parameters: normalizeParameters(provider.parameters, 'provider.parameters'),
    models
  }
}

export function rawProviderModelFromSave(
  model: ProviderModelConfigSave,
  internalId: string,
  protocol: ModelProtocol,
  existing?: RawProviderModelConfig
): RawProviderModelConfig {
  const id = normalizeConfigId(internalId, 'model.id')
  if (existing?.id !== undefined && normalizeConfigId(existing.id, 'model.id') !== id) {
    throw new Error('Model configuration IDs cannot be changed after creation.')
  }
  const maxContextTokens = normalizeIntegerAtLeast(model.maxContextTokens, 'model.maxContextTokens', minMaxContextTokens)
  const maxOutputTokens = normalizeIntegerAtLeast(model.maxOutputTokens, 'model.maxOutputTokens', minMaxOutputTokens)
  if (maxOutputTokens >= maxContextTokens) {
    throw new Error('Config value model.max_output_tokens must be smaller than model.max_context_tokens.')
  }
  const parameters = normalizeParameters(model.parameters, 'model.parameters')
  const parameterPresets = normalizeParameterPresets(
    model.parameterPresets?.map((preset) => ({
      id: preset.id,
      name: preset.name,
      parameters: preset.parameters
    })),
    'model.parameterPresets'
  )
  const parameterPresetMode = requireModelParameterPresetMode(
    model.parameterPresetMode,
    'model.parameterPresetMode'
  )
  const availableParameterPresets = resolveModelParameterPresets(protocol, {
    parameterPresetMode,
    parameterPresets
  })
  const capabilities = normalizeCapabilities({
    vision: model.capabilities?.vision,
    tool_use: model.capabilities?.toolUse
  }, 'model.capabilities')
  return {
    id,
    display_name: requireString(model.displayName, 'model.displayName'),
    model: requireString(model.model, 'model.model'),
    parameters,
    parameter_presets: parameterPresets.map((preset) => ({
      id: preset.id,
      name: preset.name,
      parameters: preset.parameters
    })),
    parameter_preset_mode: parameterPresetMode,
    default_parameter_preset_id: normalizeDefaultParameterPresetId(
      model.defaultParameterPresetId,
      availableParameterPresets,
      'model.defaultParameterPresetId'
    ),
    capabilities: { vision: capabilities.vision, tool_use: capabilities.toolUse },
    stream: requireBoolean(model.stream, 'model.stream'),
    max_context_tokens: maxContextTokens,
    max_output_tokens: maxOutputTokens,
    context_compression_threshold: normalizeContextCompressionThreshold(
      model.contextCompressionThreshold,
      'model.contextCompressionThreshold'
    ),
    context_compression_enabled: requireBoolean(
      model.contextCompressionEnabled,
      'model.contextCompressionEnabled'
    )
  }
}

export function normalizeProviderModel(
  raw: RawProviderModelConfig,
  providerIndex: number,
  index: number,
  protocol: ModelProtocol
): ProviderModelConfig {
  const path = `providers[${providerIndex}].models[${index}]`
  const maxContextTokens = normalizeIntegerAtLeast(raw.max_context_tokens, `${path}.max_context_tokens`, minMaxContextTokens)
  const maxOutputTokens = normalizeIntegerAtLeast(raw.max_output_tokens, `${path}.max_output_tokens`, minMaxOutputTokens)
  if (maxOutputTokens >= maxContextTokens) {
    throw new Error(`Config value ${path}.max_output_tokens must be smaller than ${path}.max_context_tokens.`)
  }
  const parameterPresets = normalizeParameterPresets(raw.parameter_presets, `${path}.parameter_presets`)
  const parameterPresetMode = requireModelParameterPresetMode(
    raw.parameter_preset_mode,
    `${path}.parameter_preset_mode`
  )
  const availableParameterPresets = resolveModelParameterPresets(protocol, {
    parameterPresetMode,
    parameterPresets
  })
  return {
    id: normalizeConfigId(raw.id, `${path}.id`),
    displayName: raw.display_name === undefined ? '' : requireString(raw.display_name, `${path}.display_name`),
    model: requireString(raw.model, `${path}.model`),
    parameters: normalizeParameters(raw.parameters, `${path}.parameters`),
    parameterPresets,
    parameterPresetMode,
    defaultParameterPresetId: normalizeDefaultParameterPresetId(
      raw.default_parameter_preset_id,
      availableParameterPresets,
      `${path}.default_parameter_preset_id`
    ),
    capabilities: normalizeCapabilities(raw.capabilities, `${path}.capabilities`),
    stream: requireBoolean(raw.stream, `${path}.stream`),
    maxContextTokens,
    maxOutputTokens,
    contextCompressionThreshold: normalizeContextCompressionThreshold(
      raw.context_compression_threshold,
      `${path}.context_compression_threshold`
    ),
    contextCompressionEnabled: requireBoolean(
      raw.context_compression_enabled,
      `${path}.context_compression_enabled`
    )
  }
}

export function normalizeModelProvider(raw: RawModelProviderConfig, index: number): ModelProviderConfig {
  const path = `providers[${index}]`
  const protocol = requireModelProtocol(raw.protocol, `${path}.protocol`)
  const rawModels = raw.models
  if (!Array.isArray(rawModels)) {
    throw new Error(`Config value ${path}.models must be an array.`)
  }
  const models = rawModels.map((model, modelIndex) => ({
    ...normalizeProviderModel(model, index, modelIndex, protocol),
    index: modelIndex
  }))
  const apiKey = raw.api_key === undefined || raw.api_key === ''
    ? undefined
    : requireString(raw.api_key, `${path}.api_key`)
  return {
    id: normalizeConfigId(raw.id, `${path}.id`),
    name: requireString(raw.name, `${path}.name`),
    protocol,
    baseUrl: requireString(raw.base_url, `${path}.base_url`),
    modelListUrl: raw.model_list_url === undefined ? '' : requireString(raw.model_list_url, `${path}.model_list_url`),
    modelListAuth: raw.model_list_auth === undefined
      ? 'bearer'
      : requireModelListAuth(raw.model_list_auth, `${path}.model_list_auth`),
    apiKey,
    parameters: raw.parameters === undefined
      ? defaultModelProviderConfig.parameters
      : normalizeParameters(raw.parameters, `${path}.parameters`),
    models
  }
}

export function modelProviderConfigDetail(
  provider: ModelProviderConfig,
  index: number
): ModelProviderConfigDetail {
  return { ...provider, index }
}

export function resolveModelConfig(
  provider: ModelProviderConfig,
  model: ProviderModelConfig
): ResolvedModelConfig {
  return resolveProviderModelConfig(provider, model)
}
