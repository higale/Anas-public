import type { TFunction } from 'i18next'
import {
  defaultModelConfig,
  defaultModelProviderConfig,
  modelReservedParameterKeys,
  resolveModelParameterPresets
} from '@shared/modelConfig'
import type {
  ModelCapabilities,
  ModelListAuth,
  ModelParameterPreset,
  ModelListRequest,
  ModelParameterPresetMode,
  ModelProtocol,
  ModelProviderConfigDetail,
  ModelProviderConfigSave,
  ProviderModelConfigDetail,
  ProviderModelConfigSave
} from '@shared/types'
import type { ModelProviderTemplate } from '@shared/modelTemplates'

export const minModelMaxContextTokens = 2000
export const maxModelMaxContextTokens = 1000000
export const minModelMaxOutputTokens = 0
export const maxModelMaxOutputTokens = 1000000

export interface ModelDraft {
  providerId?: string
  providerIndex?: number
  modelConfigId?: string
  modelIndex?: number
  name: string
  protocol: ModelProtocol
  baseUrl: string
  modelListUrl: string
  modelListAuth: ModelListAuth
  apiKey: string
  providerParametersJson: string
  displayName: string
  model: string
  parametersJson: string
  parameterPresets: ModelParameterPresetDraft[]
  parameterPresetMode: ModelParameterPresetMode
  defaultParameterPresetId?: string
  capabilities: ModelCapabilities
  stream: boolean
  maxContextTokens: string
  maxOutputTokens: string
  contextCompressionThreshold: number
  contextCompressionEnabled: boolean
}

export interface ModelParameterPresetDraft {
  id: string
  name: string
  parametersJson: string
}

export function emptyModelDraft(): ModelDraft {
  return {
    name: '',
    protocol: 'openai_chat_completions',
    baseUrl: '',
    modelListUrl: '',
    modelListAuth: 'bearer',
    apiKey: '',
    providerParametersJson: Object.keys(defaultModelProviderConfig.parameters).length > 0
      ? JSON.stringify(defaultModelProviderConfig.parameters, null, 2)
      : '',
    displayName: '',
    model: '',
    parametersJson: Object.keys(defaultModelConfig.parameters).length > 0
      ? JSON.stringify(defaultModelConfig.parameters, null, 2)
      : '',
    parameterPresets: [],
    parameterPresetMode: defaultModelConfig.parameterPresetMode,
    capabilities: { ...defaultModelConfig.capabilities },
    stream: defaultModelConfig.stream,
    maxContextTokens: String(defaultModelConfig.maxContextTokens),
    maxOutputTokens: String(defaultModelConfig.maxOutputTokens),
    contextCompressionThreshold: defaultModelConfig.contextCompressionThreshold,
    contextCompressionEnabled: defaultModelConfig.contextCompressionEnabled
  }
}

export function modelConfigToDraft(
  provider: ModelProviderConfigDetail,
  requestedModel?: ProviderModelConfigDetail
): ModelDraft {
  const model = requestedModel ?? provider.models[0]
  if (!model) throw new Error(`Provider "${provider.name}" has no model configuration.`)
  return {
    providerId: provider.id,
    providerIndex: provider.index,
    modelConfigId: model.id,
    modelIndex: model.index,
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    modelListUrl: provider.modelListUrl,
    modelListAuth: provider.modelListAuth,
    apiKey: provider.apiKey ?? '',
    providerParametersJson: Object.keys(provider.parameters).length > 0
      ? JSON.stringify(provider.parameters, null, 2)
      : '',
    displayName: model.displayName,
    model: model.model,
    parametersJson: Object.keys(model.parameters).length > 0 ? JSON.stringify(model.parameters, null, 2) : '',
    parameterPresets: (model.parameterPresets ?? []).map((preset) => ({
      id: preset.id,
      name: preset.name,
      parametersJson: Object.keys(preset.parameters).length > 0 ? JSON.stringify(preset.parameters, null, 2) : ''
    })),
    parameterPresetMode: model.parameterPresetMode,
    defaultParameterPresetId: model.defaultParameterPresetId,
    capabilities: { ...model.capabilities },
    stream: model.stream,
    maxContextTokens: String(model.maxContextTokens),
    maxOutputTokens: String(model.maxOutputTokens),
    contextCompressionThreshold: model.contextCompressionThreshold,
    contextCompressionEnabled: model.contextCompressionEnabled
  }
}

export function providerConfigToDraft(
  provider: ModelProviderConfigDetail,
  requestedModel?: ProviderModelConfigDetail
): ModelDraft {
  if (requestedModel) return modelConfigToDraft(provider, requestedModel)
  return {
    ...emptyModelDraft(),
    providerId: provider.id,
    providerIndex: provider.index,
    name: provider.name,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    modelListUrl: provider.modelListUrl,
    modelListAuth: provider.modelListAuth,
    apiKey: provider.apiKey ?? '',
    providerParametersJson: Object.keys(provider.parameters).length > 0
      ? JSON.stringify(provider.parameters, null, 2)
      : ''
  }
}

export function modelTemplateToDraft(template: ModelProviderTemplate): ModelDraft {
  return {
    ...emptyModelDraft(),
    name: template.name,
    protocol: template.protocol,
    baseUrl: template.baseUrl,
    modelListUrl: template.modelListUrl,
    modelListAuth: template.modelListAuth,
    apiKey: template.apiKey,
    providerParametersJson: Object.keys(template.parameters).length > 0
      ? JSON.stringify(template.parameters, null, 2)
      : ''
  }
}

export function parseModelMaxOutputTokens(value: string): number | undefined {
  const parsed = Number(value.trim())
  if (!value.trim() || !Number.isFinite(parsed)) return undefined
  const next = Math.floor(parsed)
  return next >= minModelMaxOutputTokens && next <= maxModelMaxOutputTokens ? next : undefined
}

export function parseModelMaxContextTokens(value: string): number | undefined {
  const parsed = Number(value.trim())
  if (!value.trim() || !Number.isFinite(parsed)) return undefined
  const next = Math.floor(parsed)
  return next >= minModelMaxContextTokens && next <= maxModelMaxContextTokens ? next : undefined
}

export function parseModelParametersJson(value: string): Record<string, unknown> | undefined {
  if (!value.trim()) return {}
  try {
    const parsed: unknown = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function buildParameterPresets(draft: ModelDraft): ModelParameterPreset[] | undefined {
  const presets: ModelParameterPreset[] = []
  const ids = new Set<string>()
  const names = new Set<string>()
  for (const preset of draft.parameterPresets) {
    const id = preset.id.trim()
    const name = preset.name.trim()
    const parameters = parseModelParametersJson(preset.parametersJson)
    if (!id || !name || !parameters || modelReservedParameterKeys(parameters).length > 0
      || ids.has(id) || names.has(name)) return undefined
    ids.add(id)
    names.add(name)
    presets.push({ id, name, parameters })
  }
  return presets
}

export function buildProviderPayload(draft: ModelDraft): ModelProviderConfigSave | undefined {
  const parsedParameters = parseModelParametersJson(draft.providerParametersJson)
  const parameters = parsedParameters && modelReservedParameterKeys(parsedParameters).length === 0
    ? parsedParameters
    : undefined
  if (!parameters) return undefined
  return {
    id: draft.providerId,
    name: draft.name,
    protocol: draft.protocol,
    baseUrl: draft.baseUrl,
    modelListUrl: draft.modelListUrl,
    modelListAuth: draft.modelListAuth,
    apiKey: draft.apiKey,
    parameters
  }
}

export function validateModelProviderDraft(draft: ModelDraft, t: TFunction): string | undefined {
  const parameters = parseModelParametersJson(draft.providerParametersJson)
  if (!parameters) return t('settings.model_parameters_invalid_json')
  const reserved = parameters ? modelReservedParameterKeys(parameters) : []
  if (reserved.length > 0) {
    return t('settings.model_parameters_reserved', { keys: reserved.join(', ') })
  }
  return undefined
}

export function buildProviderModelPayload(draft: ModelDraft): ProviderModelConfigSave | undefined {
  if (!draft.providerId) return undefined
  const maxContextTokens = parseModelMaxContextTokens(draft.maxContextTokens)
  const maxOutputTokens = parseModelMaxOutputTokens(draft.maxOutputTokens)
  const parsedParameters = parseModelParametersJson(draft.parametersJson)
  const parameters = parsedParameters && modelReservedParameterKeys(parsedParameters).length === 0
    ? parsedParameters
    : undefined
  const parameterPresets = buildParameterPresets(draft)
  const availableParameterPresets = parameterPresets
    ? resolveModelParameterPresets(draft.protocol, {
        parameterPresetMode: draft.parameterPresetMode,
        parameterPresets
      })
    : []
  if (maxContextTokens === undefined || maxOutputTokens === undefined || maxOutputTokens >= maxContextTokens
    || !parameters
    || !parameterPresets
    || (draft.defaultParameterPresetId
      && !availableParameterPresets.some((preset) => preset.id === draft.defaultParameterPresetId))) {
    return undefined
  }
  return {
    id: draft.modelConfigId,
    providerId: draft.providerId,
    displayName: draft.displayName,
    model: draft.model,
    parameters,
    parameterPresets,
    parameterPresetMode: draft.parameterPresetMode,
    defaultParameterPresetId: draft.defaultParameterPresetId,
    capabilities: draft.capabilities,
    stream: draft.stream,
    maxContextTokens,
    maxOutputTokens,
    contextCompressionThreshold: draft.contextCompressionThreshold,
    contextCompressionEnabled: draft.contextCompressionEnabled
  }
}

export function validateProviderModelDraft(draft: ModelDraft, t: TFunction): string | undefined {
  const parameters = parseModelParametersJson(draft.parametersJson)
  if (!parameters) return t('settings.model_parameters_invalid_json')
  const reserved = parameters ? modelReservedParameterKeys(parameters) : []
  if (reserved.length > 0) {
    return t('settings.model_parameters_reserved', { keys: reserved.join(', ') })
  }
  const presetNames = new Set<string>()
  for (const preset of draft.parameterPresets) {
    if (!preset.name.trim()) return t('settings.model_parameter_preset_name_required')
    if (presetNames.has(preset.name.trim())) return t('settings.model_parameter_preset_name_duplicate')
    presetNames.add(preset.name.trim())
    const presetParameters = parseModelParametersJson(preset.parametersJson)
    if (!presetParameters) return t('settings.model_parameter_preset_invalid_json', { name: preset.name })
    const presetReserved = modelReservedParameterKeys(presetParameters)
    if (presetReserved.length > 0) {
      return t('settings.model_parameter_preset_reserved', { name: preset.name, keys: presetReserved.join(', ') })
    }
  }
  if (parseModelMaxContextTokens(draft.maxContextTokens) === undefined) return t('settings.max_context_tokens_invalid')
  if (!buildProviderModelPayload(draft)) return t('settings.max_output_tokens_invalid_for_context')
  return undefined
}

export function buildModelListRequest(draft: ModelDraft): ModelListRequest | undefined {
  if (!draft.baseUrl.trim()) return undefined
  return {
    providerId: draft.providerId,
    name: draft.name,
    protocol: draft.protocol,
    baseUrl: draft.baseUrl,
    modelListUrl: draft.modelListUrl,
    modelListAuth: draft.modelListAuth,
    apiKey: draft.apiKey.trim() || undefined
  }
}
