import { AIMessage, ToolMessage, type BaseMessage, type MessageContent } from '@langchain/core/messages'
import { ChatPromptValue } from '@langchain/core/prompt_values'
import { convertPromptToAnthropic } from '@langchain/anthropic'
import { convertMessagesToCompletionsMessageParams } from '@langchain/openai'
import { countTokensApproximately } from 'langchain'
import type { ModelProtocol } from '@shared/types'
import { convertOpenAICompatibleMessagesToResponsesInput } from './openAiResponsesStream'
import { encodeOpenAiToolImages } from './toolImageTransport'
import { ModelSelectionError } from './modelSelection'

export interface LocalTokenCountingOptions {
  protocol?: ModelProtocol
  /** Include only for complete requests, not individual message slices. */
  parameters?: Record<string, unknown>
}

const imageTokens = 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function isImageBlock(value: unknown): boolean {
  return isRecord(value) && ['image', 'image_url', 'input_image'].includes(String(value.type))
}

/** Traverse only protocol image slots, leaving arbitrary tool JSON untouched. */
function imageContentProjection(value: unknown): { content: unknown; images: number } {
  let images = 0
  const withoutImages = (item: unknown): unknown => {
    if (isImageBlock(item)) {
      images++
      return null
    }
    if (Array.isArray(item)) return item.map(withoutImages)
    if (!isRecord(item) || typeof item.type !== 'string') return item
    // Only protocol content positions contain images. Tool inputs/arguments and
    // arbitrary metadata are JSON text even when they contain an object type=image.
    return {
      ...item,
      ...('content' in item ? { content: withoutImages(item.content) } : {}),
      ...(item.type.endsWith('_call_output') && 'output' in item ? { output: withoutImages(item.output) } : {}),
      ...(item.type === 'code_interpreter_call' && 'outputs' in item ? { outputs: withoutImages(item.outputs) } : {})
    }
  }
  const content = withoutImages(value)
  return { content, images }
}

/** Count opaque protocol content without charging for image URLs or base64 data. */
function structuredTokens(value: unknown): number {
  if (value === undefined) return 0
  const { content, images } = imageContentProjection(value)
  const serialized = JSON.stringify(content)
  // Each placeholder contributes four characters (null), replaced by the image budget.
  return Math.ceil((serialized.length - images * 4) / 4) + images * imageTokens
}

function contentTokens(content: unknown): number {
  if (typeof content === 'string') return Math.ceil(content.length / 4)
  if (!Array.isArray(content)) return content == null ? 0 : structuredTokens(content)
  let text = ''
  let otherTokens = 0
  for (const item of content) {
    if (typeof item === 'string') text += item
    else if (isImageBlock(item)) otherTokens += imageTokens
    else if (isRecord(item) && ['text', 'input_text', 'output_text'].includes(String(item.type)) && typeof item.text === 'string') {
      text += item.text
      const { type: _type, text: _text, ...metadata } = item
      if (Object.keys(metadata).length) otherTokens += structuredTokens(metadata)
    } else otherTokens += structuredTokens(item)
  }
  return Math.ceil(text.length / 4) + otherTokens
}

function isGeneratedImageReplay(message: Record<string, unknown>): boolean {
  return !('role' in message) && message.type === 'image_generation_call'
    && typeof message.result === 'string' && message.result.length > 0
}

function projectedMessageTokens(message: unknown): number {
  if (!isRecord(message)) return contentTokens(message)
  // Responses replays generated images in this provider-owned slot. Handle it
  // only on replay items, never on JSON embedded in tool arguments or results.
  if (isGeneratedImageReplay(message)) {
    const { result: _result, ...metadata } = message
    return structuredTokens(metadata) + imageTokens
  }
  // Messages have a role/content envelope; Responses replay items (reasoning,
  // function calls, provider tools, etc.) are counted in their complete wire form.
  if (!('role' in message)) return structuredTokens(message)
  const { role: _role, type: _type, content, ...fields } = message
  return contentTokens(content) + (Object.keys(fields).length ? structuredTokens(fields) : 0)
}

/** Request-level input outside the message list, counted once per request. */
export function modelParameterInputTokens(protocol: ModelProtocol | undefined, parameters?: Record<string, unknown>): number {
  let tokens = 0
  if (protocol === 'openai_responses' && parameters?.instructions != null) {
    if (typeof parameters.instructions !== 'string') {
      throw new ModelSelectionError('OpenAI Responses model parameter "instructions" must be a string or null. Correct its settings and send again.')
    }
    tokens += contentTokens(parameters.instructions)
  }
  const format = protocol === 'openai_responses' && isRecord(parameters?.text)
    ? parameters.text.format
    : protocol === 'anthropic_messages' && isRecord(parameters?.output_config)
      ? parameters.output_config.format
      : protocol === 'openai_chat_completions' ? parameters?.response_format : undefined
  // Structured-output schemas become part of the provider's input prefix. Their
  // JSON describes output data, so image-shaped fields are ordinary schema text.
  if (isRecord(format) && format.type === 'json_schema') tokens += Math.ceil(JSON.stringify(format).length / 4)
  return tokens
}

/** The message/system projection shared by estimation and request identity. */
export function projectModelInput(
  messages: BaseMessage[],
  options: { protocol: ModelProtocol }
): { system?: unknown; messages: unknown[] } {
  if (options.protocol === 'openai_chat_completions') {
    return { messages: convertMessagesToCompletionsMessageParams({ messages: encodeOpenAiToolImages(messages, false) }) }
  }
  if (options.protocol === 'openai_responses') {
    return { messages: convertOpenAICompatibleMessagesToResponsesInput({
      messages: encodeOpenAiToolImages(messages, true),
      model: '',
      zdrEnabled: false
    }) }
  }
  return convertPromptToAnthropic(new ChatPromptValue(messages))
}

/** Check the same provider input and image slots used by token estimation. */
export function modelInputHasImages(messages: BaseMessage[], protocol: ModelProtocol): boolean {
  const input = projectModelInput(messages, { protocol })
  return imageContentProjection(input.system).images > 0 || input.messages.some(message => {
    if (isRecord(message) && isGeneratedImageReplay(message)) return true
    const content = isRecord(message) && 'role' in message ? message.content : message
    return imageContentProjection(content).images > 0
  })
}

export function countMessagesApproximately(
  messages: BaseMessage[],
  tools?: Array<Record<string, unknown>> | null,
  options: LocalTokenCountingOptions = {}
): number {
  const requestOverheadTokens = countTokensApproximately([], tools) + modelParameterInputTokens(options.protocol, options.parameters)
  if (options.protocol) {
    const input = projectModelInput(messages, { protocol: options.protocol })
    return requestOverheadTokens + contentTokens(input.system)
      + input.messages.reduce<number>((total, message) => total + projectedMessageTokens(message), 0)
  }
  // Without a target protocol only generic message content is known. Provider
  // metadata and historical output usage do not describe the next request.
  return requestOverheadTokens + messages.reduce((total, message) => total
    + contentTokens(AIMessage.isInstance(message) ? message.contentBlocks : message.content)
    + (ToolMessage.isInstance(message) ? Math.ceil(message.tool_call_id.length / 4) : 0), 0)
}

export function approximateContentTokens(content: MessageContent): number {
  return contentTokens(content)
}
