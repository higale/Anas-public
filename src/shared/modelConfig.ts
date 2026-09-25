import rawModelsConfig from '../../data/config/models.json'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js'
import stableStringify from 'fast-json-stable-stringify'
import type {
  ModelDefaults,
  ModelListAuth,
  ModelParameterPreset,
  ModelParameterPresetMode,
  ModelProtocol,
  ModelProviderDefaults,
  ModelProviderConfig,
  ProviderModelConfig,
  ResolvedModelConfig
} from './types'
import { protocolDefaultModelParameterPresets } from './modelParameterPresetTemplates'
import { modelReservedParameterKeys } from './modelParameterValidation'

export { modelReservedParameterKeys, reservedModelParameterKeys } from './modelParameterValidation'

export function requireModelProtocol(value: unknown, path: string): ModelProtocol {
  if (
    value === 'openai_responses'
    || value === 'openai_chat_completions'
    || value === 'anthropic_messages'
  ) return value
  throw new Error(
    `Config value ${path} must be "openai_responses", `
    + '"openai_chat_completions", or "anthropic_messages".'
  )
}

export function requireModelListAuth(value: unknown, path: string): ModelListAuth {
  if (value === 'bearer' || value === 'anthropic') return value
  throw new Error(`Config value ${path} must be "bearer" or "anthropic".`)
}

export function requireModelParameterPresetMode(value: unknown, path: string): ModelParameterPresetMode {
  if (value === 'protocol_default' || value === 'custom' || value === 'none') return value
  throw new Error(`Config value ${path} must be "protocol_default", "custom", or "none".`)
}

function isMergeableParameterObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function mergeModelParameters(
  base: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key]
    const nextValue = isMergeableParameterObject(existing) && isMergeableParameterObject(value)
      ? mergeModelParameters(existing, value)
      : value
    Object.defineProperty(merged, key, {
      configurable: true,
      enumerable: true,
      value: nextValue,
      writable: true
    })
  }
  return merged
}

export function applyModelParameterPreset(
  model: ResolvedModelConfig,
  parameterPresetId: string | undefined
): ResolvedModelConfig {
  if (!parameterPresetId) return model
  const preset = model.parameterPresets?.find((candidate) => candidate.id === parameterPresetId)
  if (!preset) {
    throw new Error(`Model parameter preset not found: ${parameterPresetId}`)
  }
  return {
    ...model,
    parameters: mergeModelParameters(model.parameters, preset.parameters)
  }
}

function requireDefaultNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Bundled config value ${path} must be a number.`)
  }
  return value
}

function requireDefaultIntegerAtLeast(value: unknown, path: string, minimum: number): number {
  const number = requireDefaultNumber(value, path)
  if (!Number.isInteger(number) || number < minimum) {
    throw new Error(`Bundled config value ${path} must be an integer of at least ${minimum}.`)
  }
  return number
}

function requireDefaultBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Bundled config value ${path} must be a boolean.`)
  return value
}

function requireDefaultParameters(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Bundled config value ${path} must be an object.`)
  }
  const parameters = value as Record<string, unknown>
  const reserved = modelReservedParameterKeys(parameters)
  if (reserved.length > 0) {
    throw new Error(`Bundled config value ${path} contains reserved keys: ${reserved.join(', ')}.`)
  }
  return parameters
}

function bundledProviderDefaults(): ModelProviderDefaults {
  const raw: unknown = rawModelsConfig.provider_defaults
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Bundled config value provider_defaults must be an object.')
  }
  const defaults = raw as Record<string, unknown>
  return {
    parameters: requireDefaultParameters(defaults.parameters, 'provider_defaults.parameters')
  }
}

function bundledDefaults(): ModelDefaults {
  const raw: unknown = rawModelsConfig.model_defaults
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Bundled config value model_defaults must be an object.')
  }
  const defaults = raw as Record<string, unknown>
  const capabilities = defaults.capabilities
  if (!capabilities || typeof capabilities !== 'object' || Array.isArray(capabilities)) {
    throw new Error('Bundled config value model_defaults.capabilities must be an object.')
  }
  const capabilityRecord = capabilities as Record<string, unknown>
  const parameters = requireDefaultParameters(defaults.parameters, 'model_defaults.parameters')
  const maxContextTokens = requireDefaultIntegerAtLeast(
    defaults.max_context_tokens,
    'model_defaults.max_context_tokens',
    2000
  )
  const maxOutputTokens = requireDefaultIntegerAtLeast(
    defaults.max_output_tokens,
    'model_defaults.max_output_tokens',
    0
  )
  if (maxOutputTokens >= maxContextTokens) {
    throw new Error(
      'Bundled config value model_defaults.max_output_tokens must be smaller than model_defaults.max_context_tokens.'
    )
  }
  const contextCompressionThreshold = requireDefaultNumber(
    defaults.context_compression_threshold,
    'model_defaults.context_compression_threshold'
  )
  if (contextCompressionThreshold < 0.1 || contextCompressionThreshold > 0.95) {
    throw new Error('Bundled config value model_defaults.context_compression_threshold must be between 0.1 and 0.95.')
  }
  return {
    parameters,
    parameterPresetMode: requireModelParameterPresetMode(
      defaults.parameter_preset_mode,
      'model_defaults.parameter_preset_mode'
    ),
    capabilities: {
      vision: requireDefaultBoolean(capabilityRecord.vision, 'model_defaults.capabilities.vision'),
      toolUse: requireDefaultBoolean(capabilityRecord.tool_use, 'model_defaults.capabilities.tool_use')
    },
    stream: requireDefaultBoolean(defaults.stream, 'model_defaults.stream'),
    maxContextTokens,
    maxOutputTokens,
    contextCompressionThreshold,
    contextCompressionEnabled: requireDefaultBoolean(
      defaults.context_compression_enabled,
      'model_defaults.context_compression_enabled'
    )
  }
}

export const defaultModelConfig = bundledDefaults()
export const defaultModelProviderConfig = bundledProviderDefaults()

export type SelectableModelConfig = Pick<ResolvedModelConfig, 'baseUrl' | 'model'>

export function isSelectableModelConfig(model: SelectableModelConfig): boolean {
  return model.baseUrl.trim().length > 0 && model.model.trim().length > 0
}

/** Identity for reusing provider token counts; budgets are evaluated separately. */
export function modelContextKey(model: ResolvedModelConfig): string {
  return bytesToHex(sha256(utf8ToBytes(stableStringify({
    id: model.id,
    providerId: model.providerId,
    protocol: model.protocol,
    baseUrl: model.baseUrl,
    model: model.model,
    capabilities: model.capabilities,
    parameters: model.parameters
  }))))
}

export function resolveModelParameterPresets(
  protocol: ModelProtocol,
  model: Pick<ProviderModelConfig, 'parameterPresetMode' | 'parameterPresets'>
): ModelParameterPreset[] {
  return model.parameterPresetMode === 'protocol_default'
    ? protocolDefaultModelParameterPresets(protocol)
    : model.parameterPresetMode === 'custom'
      ? model.parameterPresets ?? []
      : []
}

export function resolveProviderModelConfig(
  provider: ModelProviderConfig,
  model: ProviderModelConfig
): ResolvedModelConfig {
  const parameterPresets = resolveModelParameterPresets(provider.protocol, model)
  const defaultParameterPresetId = model.defaultParameterPresetId
  return {
    ...model,
    parameters: mergeModelParameters(provider.parameters, model.parameters),
    parameterPresets,
    defaultParameterPresetId: defaultParameterPresetId
      && parameterPresets.some((preset) => preset.id === defaultParameterPresetId)
      ? defaultParameterPresetId
      : undefined,
    providerId: provider.id,
    providerName: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey
  }
}

export function findProviderModelConfig(
  providers: ModelProviderConfig[],
  modelConfigId: string | undefined
): ResolvedModelConfig | undefined {
  if (!modelConfigId) return undefined
  for (const provider of providers) {
    const model = provider.models.find((candidate) => candidate.id === modelConfigId)
    if (model) return resolveProviderModelConfig(provider, model)
  }
  return undefined
}

export function flattenProviderModels(providers: ModelProviderConfig[]): ResolvedModelConfig[] {
  return providers.flatMap((provider) => provider.models.map((model) => resolveProviderModelConfig(provider, model)))
}
