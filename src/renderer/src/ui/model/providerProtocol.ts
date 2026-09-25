import type { ModelProtocol } from '@shared/types'

export const providerProtocolLabels: Record<ModelProtocol, string> = {
  openai_responses: 'OpenAI Responses',
  openai_chat_completions: 'OpenAI Chat Completions',
  anthropic_messages: 'Anthropic Messages'
}

export function providerProtocolLabel(provider: ModelProtocol): string {
  return providerProtocolLabels[provider]
}
