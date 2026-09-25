import { describe, expect, it } from 'vitest'
import type { ResolvedModelConfig } from '@shared/types'
import { configuredServerTools } from './serverTools'

const model: ResolvedModelConfig = {
  id: 'model',
  displayName: '',
  providerId: 'provider',
  providerName: 'Provider',
  protocol: 'openai_responses',
  baseUrl: 'https://example.com/v1',
  model: 'test-model',
  parameters: {},
  parameterPresetMode: 'none',
  capabilities: { vision: true, toolUse: true },
  stream: true,
  maxContextTokens: 128_000,
  maxOutputTokens: 16_000,
  contextCompressionThreshold: 0.8,
  contextCompressionEnabled: true
}

describe('configuredServerTools', () => {
  it('returns provider-executed Responses tools without changing their options', () => {
    expect(configuredServerTools({
      ...model,
      parameters: {
        tools: [{ type: 'web_search', search_context_size: 'medium' }]
      }
    })).toEqual([{ type: 'web_search', search_context_size: 'medium' }])
  })

  it('rejects Responses server tools on other protocols', () => {
    expect(() => configuredServerTools({
      ...model,
      protocol: 'openai_chat_completions',
      parameters: { tools: [{ type: 'web_search' }] }
    })).toThrow('only supported by the OpenAI Responses protocol')
  })

  it('rejects client tool declarations because Anas owns their implementations', () => {
    expect(() => configuredServerTools({
      ...model,
      parameters: { tools: [{ type: 'function', name: 'unsafe-shadow' }] }
    })).toThrow('cannot declare a client-executed function tool')
  })
})
