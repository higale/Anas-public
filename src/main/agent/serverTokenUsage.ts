import { countMessagesApproximately, projectModelInput } from './localTokenCounting'
import { createHash } from 'node:crypto'
import stableStringify from 'fast-json-stable-stringify'
import { convertToOpenAITool } from '@langchain/core/utils/function_calling'
import { projectToolImages } from './toolImageProjection'
import { projectSkillMessages } from './messageMapper'
import type { ModelProtocol } from '@shared/types'
import {
  AIMessage,
  SystemMessage,
  type BaseMessage,
  type InputTokenDetails,
  type OutputTokenDetails,
  type UsageMetadata
} from '@langchain/core/messages'
import type {
  AgentServerTokenUsage,
  AgentTokenModalityDetails
} from '@shared/agentTypes'

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

function modalityDetails(
  details: InputTokenDetails | OutputTokenDetails | undefined
): AgentTokenModalityDetails {
  return {
    ...(tokenCount(details?.text) !== undefined
      ? { textTokens: tokenCount(details?.text) }
      : {}),
    ...(tokenCount(details?.image) !== undefined
      ? { imageTokens: tokenCount(details?.image) }
      : {}),
    ...(tokenCount(details?.audio) !== undefined
      ? { audioTokens: tokenCount(details?.audio) }
      : {}),
    ...(tokenCount(details?.video) !== undefined
      ? { videoTokens: tokenCount(details?.video) }
      : {}),
    ...(tokenCount(details?.document) !== undefined
      ? { documentTokens: tokenCount(details?.document) }
      : {})
  }
}

function hasDetails(details: AgentTokenModalityDetails): boolean {
  return Object.keys(details).length > 0
}

function normalizedUsage(usage: UsageMetadata | undefined): AgentServerTokenUsage | undefined {
  const inputTokens = tokenCount(usage?.input_tokens)
  const outputTokens = tokenCount(usage?.output_tokens)
  const totalTokens = tokenCount(usage?.total_tokens)
  if (
    inputTokens === undefined
    || outputTokens === undefined
    || totalTokens === undefined
    || totalTokens <= 0
  ) return undefined

  const inputTokenDetails = {
    ...modalityDetails(usage?.input_token_details),
    ...(tokenCount(usage?.input_token_details?.cache_read) !== undefined
      ? { cacheReadTokens: tokenCount(usage?.input_token_details?.cache_read) }
      : {}),
    ...(tokenCount(usage?.input_token_details?.cache_creation) !== undefined
      ? { cacheCreationTokens: tokenCount(usage?.input_token_details?.cache_creation) }
      : {})
  }
  const outputTokenDetails = {
    ...modalityDetails(usage?.output_token_details),
    ...(tokenCount(usage?.output_token_details?.reasoning) !== undefined
      ? { reasoningTokens: tokenCount(usage?.output_token_details?.reasoning) }
      : {})
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(hasDetails(inputTokenDetails) ? { inputTokenDetails } : {}),
    ...(hasDetails(outputTokenDetails) ? { outputTokenDetails } : {})
  }
}

/**
 * Returns the latest model response's standard usage snapshot. Older usage is
 * intentionally ignored when the newest response did not report usage.
 */
export function latestServerTokenUsage(
  messages: BaseMessage[],
  modelContextKey?: string
): AgentServerTokenUsage | undefined {
  return latestServerTokenUsageSnapshot(messages, modelContextKey)?.usage
}

export function latestServerTokenUsageSnapshot(
  messages: BaseMessage[],
  modelContextKey?: string
): { messageIndex: number; usage: AgentServerTokenUsage } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!AIMessage.isInstance(message)) continue
    // Structured reviews append an application-rendered report after the real
    // provider response. Keep that response's index so calibration includes the
    // report and tool result in the replayed suffix, without treating them as usage.
    if (message.additional_kwargs.anas_code_review !== undefined) continue
    if (modelContextKey !== undefined && message.additional_kwargs.anas_model_context_key !== modelContextKey) return undefined
    const usage = normalizedUsage(message.usage_metadata)
    return usage ? { messageIndex: index, usage } : undefined
  }
  return undefined
}

/** Cache placement is a transport hint; string and block text carry the same input. */
function canonicalContent(content: unknown): unknown {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return content
  return content.map((block) => {
    if (!block || typeof block !== 'object' || !('type' in block)) return block
    const { cache_control: _cacheControl, ...input } = block
    return input
  })
}

/** Identifies the complete provider input represented by an input-token snapshot. */
export function contextRequestKey(options: {
  messages: BaseMessage[]
  systemMessage: unknown
  tools: unknown
  protocol: ModelProtocol
}): string {
  // Skill expansion is request-only, so checkpoint previews reconstruct it.
  const messages = projectSkillMessages(options.messages)
  const input = projectModelInput(SystemMessage.isInstance(options.systemMessage)
    ? [options.systemMessage, ...messages] : messages, options)
  const normalized = {
    ...(input.system !== undefined ? { system: canonicalContent(input.system) } : {}),
    messages: input.messages.map((message) => {
      if (!message || typeof message !== 'object' || !('role' in message) || !('content' in message)) return message
      return { ...message, content: canonicalContent(message.content) }
    })
  }
  // The SDK converts executable tools to their public schema and leaves native
  // server-tool definitions intact. Tool order is not a content change.
  const tools = Array.isArray(options.tools)
    ? options.tools.map((tool) => stableStringify(convertToOpenAITool(tool))).sort()
    : []
  return createHash('sha256').update(stableStringify({ input: normalized, tools })).digest('hex')
}

export function currentContextWindowTokens(options: {
  messages: BaseMessage[]
  systemMessage: unknown
  tools: unknown
  modelContextKey?: string
  protocol: ModelProtocol
  parameters?: Record<string, unknown>
}): number {
  // Project images before selecting the earlier input prefix: consumed images
  // invalidate the snapshot whose request still included them.
  const messages = projectSkillMessages(projectToolImages(options.messages))
  let snapshot = latestServerTokenUsageSnapshot(messages, options.modelContextKey)
  if (snapshot && messages[snapshot.messageIndex].additional_kwargs.anas_context_request_key !== contextRequestKey({
    ...options, messages: messages.slice(0, snapshot.messageIndex)
  })) {
    snapshot = undefined
  }
  const countedMessages = SystemMessage.isInstance(options.systemMessage)
    ? [options.systemMessage, ...messages]
    : messages
  const currentEstimate = countMessagesApproximately(
    countedMessages,
    Array.isArray(options.tools) && options.tools.length > 0
      ? options.tools as Array<Record<string, unknown>>
      : null,
    { protocol: options.protocol, parameters: options.parameters }
  )
  // Calibrate against the provider's earlier input, then add only the response
  // content that this protocol actually replays. Billed output can include hidden
  // reasoning that never enters the next request. New instructions and schemas
  // still remain represented by the complete current estimate.
  return snapshot ? Math.max(currentEstimate, snapshot.usage.inputTokens + countMessagesApproximately(
    messages.slice(snapshot.messageIndex), null, { protocol: options.protocol }
  )) : currentEstimate
}
