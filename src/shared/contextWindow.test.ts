import { describe, expect, it } from 'vitest'
import type { AgentContextStatus } from './agentTypes'
import { contextBudgetForModel, contextCompressionTriggerTokens, contextStatusForModel, contextWindowUsageRatio } from './contextWindow'
import { defaultModelConfig, modelContextKey } from './modelConfig'
import type { ResolvedModelConfig } from './types'

const model: ResolvedModelConfig = { ...defaultModelConfig, id: 'model',
  providerId: 'provider', providerName: 'Provider', protocol: 'openai_chat_completions',
  baseUrl: 'https://example.test/v1', displayName: 'Model', model: 'model',
  maxContextTokens: 4096, maxOutputTokens: 1024,
  contextCompressionEnabled: true, contextCompressionThreshold: 0.95 }
const status: AgentContextStatus = {
  modelContextKey: modelContextKey(model), includeProjectRules: true,
  modelConfigId: 'model', maxContextTokens: 4096, maxOutputTokens: 1024, inputCapacityTokens: 3072,
  compressionEnabled: true, compressionThreshold: 0.95, compressionThresholdTokens: 2816,
  estimatedInputTokens: 50, currentContextTokens: 100,
  serverUsage: { inputTokens: 80, outputTokens: 20, totalTokens: 100 },
  compressionApplied: false, manualCompressionAvailable: true,
  breakdown: { profileTokens: 0, systemInstructionTokens: 0, runtimeContextTokens: 0, workspaceTokens: 0,
    memoryTokens: 0, skillTokens: 0, toolDefinitionTokens: 0, messageTokens: 50, attachmentTokens: 0 }
}

describe('context window limits', () => {
  it('provides current model limits while its context measurement is pending', () => {
    const edited = { ...model, model: 'changed', maxContextTokens: 80_000,
      maxOutputTokens: 4_000, contextCompressionThreshold: 0.5 }
    expect(contextBudgetForModel(edited)).toEqual({
      maxContextTokens: 80_000, maxOutputTokens: 4_000, inputCapacityTokens: 76_000,
      compressionEnabled: true, compressionThreshold: 0.5, compressionThresholdTokens: 38_000
    })
    expect(contextBudgetForModel(model, true)?.compressionThresholdTokens).toBe(2816)
    expect(contextBudgetForModel(undefined)).toBeUndefined()
    expect(contextBudgetForModel({ ...model, maxOutputTokens: model.maxContextTokens })).toBeUndefined()
  })
  it('measures actual context against usable input capacity without consuming the reserve', () => {
    expect(contextWindowUsageRatio(0, 32_000, 128_000)).toBe(0)
    expect(contextWindowUsageRatio(4_000, 32_000, 128_000)).toBeCloseTo(1 / 24)
    expect(contextWindowUsageRatio(96_000, 32_000, 128_000)).toBe(1)
  })
  it('triggers at the configured fraction of usable capacity even with a large reserve', () => {
    expect(contextCompressionTriggerTokens(128_000, 32_000, 0.8)).toBe(76_800)
    expect(contextWindowUsageRatio(76_800, 32_000, 128_000)).toBe(0.8)
    expect(contextCompressionTriggerTokens(10_000, 6_000, 0.5)).toBe(2_000)
  })
  it('keeps invalid capacities finite and prevents negative trigger budgets', () => {
    for (const capacity of [0, NaN, Infinity]) {
      expect(contextWindowUsageRatio(50, 100, capacity)).toBe(0)
      expect(contextCompressionTriggerTokens(capacity, 100, 0.8)).toBe(1)
    }
    expect(contextWindowUsageRatio(50, 100, 50)).toBe(0)
    expect(contextCompressionTriggerTokens(50, 100, 0.8)).toBe(1)
  })
  it('preserves the runtime compression point capped by project-rule headroom', () => {
    const projected = contextStatusForModel(status, model)!
    expect(projected.compressionThresholdTokens).toBe(2816)
    expect(contextCompressionTriggerTokens(4096, 1024, 0.95)).toBe(2918)
  })
  it('requires a fresh projection for a different model and updates budget-only edits immediately', () => {
    expect(contextStatusForModel(status, { ...model, id: 'new', maxContextTokens: 10_000 })).toBeUndefined()
    expect(contextStatusForModel(status, { ...model, maxContextTokens: 3000 })?.compressionThresholdTokens).toBe(1720)
    expect(contextStatusForModel({ ...status, includeProjectRules: false }, { ...model, maxOutputTokens: 2048 })?.compressionThresholdTokens).toBe(1945)
  })
  it('retains provider usage for budget edits but waits for reestimation after identity edits', () => {
    expect(contextStatusForModel(status, { ...model, maxContextTokens: 10_000 })?.serverUsage).toEqual(status.serverUsage)
    for (const editedModel of [
      { ...model, model: 'new-remote-model' },
      { ...model, baseUrl: 'https://other-provider.test/v1' },
      { ...model, parameters: { reasoning_effort: 'high' } }
    ]) {
      expect(contextStatusForModel(status, editedModel)).toBeUndefined()
    }
  })
  it('removes the budget when the selected configuration is missing or invalid', () => {
    expect(contextStatusForModel(status, undefined)).toBeUndefined()
    expect(contextStatusForModel(status, { ...model, model: '' })).toBeUndefined()
    expect(contextStatusForModel(status, { ...model, maxOutputTokens: 4096 })).toBeUndefined()
    expect(contextStatusForModel(status, { ...model, maxContextTokens: NaN })).toBeUndefined()
  })
})
