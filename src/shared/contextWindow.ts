import type { AgentContextStatus } from './agentTypes'
import type { ResolvedModelConfig } from './types'
import { isSelectableModelConfig, modelContextKey } from './modelConfig'

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0
}

export function contextWindowUsageRatio(
  currentContextTokens: number,
  responseReserveTokens: number,
  maxContextTokens: number
): number {
  const capacity = finiteNonNegative(maxContextTokens) - finiteNonNegative(responseReserveTokens)
  if (capacity <= 0) return 0
  return finiteNonNegative(currentContextTokens) / capacity
}

export function contextCompressionTriggerTokens(
  maxContextTokens: number,
  responseReserveTokens: number,
  threshold: number
): number {
  if (!Number.isFinite(maxContextTokens) || maxContextTokens <= 0) return 1
  const normalizedThreshold = Number.isFinite(threshold)
    ? Math.max(0, Math.min(1, threshold))
    : 0
  return Math.max(
    1,
    Math.floor(
      Math.max(0, maxContextTokens - finiteNonNegative(responseReserveTokens)) * normalizedThreshold
    )
  )
}

export function projectRuleInputBudget(inputCapacityTokens: number): number {
  const capacity = finiteNonNegative(inputCapacityTokens)
  return Math.max(0, capacity - Math.max(256, Math.ceil(capacity * 0.05)))
}

export type AgentContextBudget = Pick<AgentContextStatus, 'maxContextTokens' | 'maxOutputTokens' | 'inputCapacityTokens'
  | 'compressionEnabled' | 'compressionThreshold' | 'compressionThresholdTokens'>

export function contextBudgetForModel(
  model: ResolvedModelConfig | undefined,
  includeProjectRules = false
): AgentContextBudget | undefined {
  if (!model || !isSelectableModelConfig(model)) return undefined
  const maxContextTokens = model.maxContextTokens
  const maxOutputTokens = model.maxOutputTokens
  if (
    !Number.isFinite(maxContextTokens)
    || !Number.isFinite(maxOutputTokens)
    || maxOutputTokens < 0
    || maxContextTokens <= maxOutputTokens
  ) {
    return undefined
  }
  const inputCapacityTokens = Math.floor(maxContextTokens - maxOutputTokens)
  return {
    maxContextTokens: Math.floor(maxContextTokens),
    maxOutputTokens: Math.floor(maxOutputTokens),
    inputCapacityTokens,
    compressionEnabled: model.contextCompressionEnabled,
    compressionThreshold: model.contextCompressionThreshold,
    compressionThresholdTokens: Math.min(
      contextCompressionTriggerTokens(maxContextTokens, maxOutputTokens, model.contextCompressionThreshold),
      includeProjectRules ? projectRuleInputBudget(inputCapacityTokens) : inputCapacityTokens
    )
  }
}

export function contextStatusForModel(
  status: AgentContextStatus | undefined,
  model: ResolvedModelConfig | undefined
): AgentContextStatus | undefined {
  const budget = contextBudgetForModel(model, status?.includeProjectRules)
  if (!status || !model || !budget) return undefined
  // A different protocol or parameter set changes the request projection.
  // Only the runtime can recalculate it from the complete checkpoint history.
  if (status.modelContextKey !== modelContextKey(model)) return undefined
  return { ...status, ...budget }
}
