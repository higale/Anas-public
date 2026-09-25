import type { AgentThread } from '@shared/agentTypes'
import type { AppConfigSnapshot, ResolvedModelConfig } from '@shared/types'
import { applyModelParameterPreset } from '@shared/modelConfig'
import { findResolvedModelConfig, getAppConfigSnapshot } from '../config/appConfig'
import type { AgentDatabase } from './agentDatabase'
import { errorCauses } from './errorCauses'

export class ModelSelectionError extends Error {
  readonly code = 'MODEL_SELECTION_INVALID'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ModelSelectionError'
  }
}

export function isModelSelectionError(error: unknown): boolean {
  return errorCauses(error).some((cause) => cause instanceof ModelSelectionError)
}

type ModelSelection = Pick<AgentThread, 'modelConfigId' | 'modelParameterPresetId'>
type ModelConfiguration = Pick<AppConfigSnapshot, 'providers' | 'defaultModel'>
type ModelSelectionDatabase = Pick<AgentDatabase, 'getThread' | 'getSubagentCallByChildThreadId'>

/** A child without its own selection follows its nearest explicitly bound ancestor. */
export function resolveThreadModelSelection(threadId: string, database: ModelSelectionDatabase): ModelSelection {
  const visited = new Set<string>()
  let currentId = threadId
  while (!visited.has(currentId)) {
    visited.add(currentId)
    const thread = database.getThread(currentId)
    if (!thread) throw new ModelSelectionError(`The conversation holding the model selection no longer exists: ${currentId}. Select a model and send again.`)
    if (thread.modelConfigId) return {
      modelConfigId: thread.modelConfigId,
      modelParameterPresetId: thread.modelParameterPresetId
    }
    const parent = database.getSubagentCallByChildThreadId(currentId)
    if (!parent) throw new ModelSelectionError('No model is selected for this conversation. Select a model and send again.')
    currentId = parent.parentThreadId
  }
  throw new ModelSelectionError('The conversation model inheritance contains a cycle. The run cannot continue.')
}

export function resolveModelSelection(
  selection: ModelSelection,
  config: ModelConfiguration,
  options: { allowDefault?: boolean } = {}
): ResolvedModelConfig {
  const configuredModel = selection.modelConfigId
    ? findResolvedModelConfig(config, selection.modelConfigId)
    : options.allowDefault ? config.defaultModel : undefined
  if (!configuredModel) {
    throw new ModelSelectionError(selection.modelConfigId
      ? `The selected model or its provider no longer exists: ${selection.modelConfigId}. Select another model and send again.`
      : 'No model is selected for this conversation. Select a model and send again.')
  }
  const label = configuredModel.displayName || configuredModel.model || configuredModel.id
  if (!configuredModel.model.trim()) {
    throw new ModelSelectionError(`Model "${label}" has no provider model name. Correct its settings and send again.`)
  }
  let endpoint: URL
  try {
    endpoint = new URL(configuredModel.baseUrl)
  } catch (cause) {
    throw new ModelSelectionError(`Model "${label}" has an invalid provider URL. Correct its settings and send again.`, { cause })
  }
  if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
    throw new ModelSelectionError(`Model "${label}" requires an HTTP or HTTPS provider URL. Correct its settings and send again.`)
  }
  if (selection.modelParameterPresetId && !configuredModel.parameterPresets?.some(
    (preset) => preset.id === selection.modelParameterPresetId
  )) {
    throw new ModelSelectionError(`The selected model parameter preset no longer exists: ${selection.modelParameterPresetId}. Select a valid preset and send again.`)
  }
  return applyModelParameterPreset(configuredModel, selection.modelParameterPresetId)
}

export function createAgentModelResolver(
  threadId: string,
  database: ModelSelectionDatabase,
  options: { loadConfig?: () => Promise<ModelConfiguration> } = {}
): () => Promise<ResolvedModelConfig> {
  const loadConfig = options.loadConfig ?? getAppConfigSnapshot
  return async () => {
    try {
      const config = await loadConfig()
      return resolveModelSelection(resolveThreadModelSelection(threadId, database), config)
    } catch (cause) {
      if (cause instanceof ModelSelectionError) throw cause
      throw new ModelSelectionError(`The current model configuration could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}. Correct its settings and send again.`, { cause })
    }
  }
}
