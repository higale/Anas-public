import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager'
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base'
import type { ChatModelStreamEvent } from '@langchain/core/language_models/event'
import type { ModelProfile } from '@langchain/core/language_models/profile'
import { AIMessage, type AIMessageChunk, type BaseMessage, type MessageContent } from '@langchain/core/messages'
import type { ChatGenerationChunk, ChatResult } from '@langchain/core/outputs'
import type { Runnable } from '@langchain/core/runnables'
import {
  ChatOpenAI,
  type ChatOpenAICallOptions,
  type ChatOpenAIFields
} from '@langchain/openai'
import {
  invokeWithCompressionTracking,
  type CompressionTrackingCallbacks
} from './compressionTracking'
import { encodeOpenAiToolImages } from './toolImageTransport'
import { approximateContentTokens } from './localTokenCounting'
import { invokeModelWithRetry, type ModelRetryOptions } from './modelRetryPolicy'
import { isModelRequestChangedError } from './modelRequestValidation'
import {
  convertOpenAICompatibleMessagesToResponsesInput,
  convertOpenAICompatibleResponsesStream,
  prepareOpenAICompatibleResponsesMessages
} from './openAiResponsesStream'

type ToolCallContent = {
  type: 'tool_call' | 'tool_call_chunk' | 'invalid_tool_call'
  id?: string
  name?: string
}

export interface OpenAICompatibleChatModelFields extends ChatOpenAIFields {
  anasProfile?: ModelProfile
  anasCompressionTracking?: CompressionTrackingCallbacks
  anasRetryOptions?: ModelRetryOptions
  anasBeforeRequest?: () => Promise<void>
  anasUseResponsesApi?: boolean
}

interface ToolCallStreamState {
  ids: Map<number, string>
  names: Map<number, string>
}

function isToolCallContent(value: unknown): value is ToolCallContent {
  if (!value || typeof value !== 'object' || !('type' in value)) return false
  const type = (value as { type?: unknown }).type
  return type === 'tool_call' || type === 'tool_call_chunk' || type === 'invalid_tool_call'
}

function rememberToolCallMetadata(
  content: ToolCallContent,
  index: number,
  state: ToolCallStreamState
): void {
  if (content.id) state.ids.set(index, content.id)
  if (content.name) state.names.set(index, content.name)
}

function removeEmptyToolCallMetadata<T extends ToolCallContent>(content: T): T {
  const normalized = { ...content }
  if (normalized.id === '') delete normalized.id
  if (normalized.name === '') delete normalized.name
  return normalized
}

export function preserveOpenAiToolCallMetadata(
  event: ChatModelStreamEvent,
  state: ToolCallStreamState
): ChatModelStreamEvent {
  if (event.event === 'content-block-start' && isToolCallContent(event.content)) {
    rememberToolCallMetadata(event.content, event.index, state)
    return {
      ...event,
      content: removeEmptyToolCallMetadata(event.content) as typeof event.content
    }
  }

  if (
    event.event === 'content-block-delta'
    && event.delta.type === 'block-delta'
    && isToolCallContent(event.delta.fields)
  ) {
    rememberToolCallMetadata(event.delta.fields, event.index, state)
    return {
      ...event,
      delta: {
        ...event.delta,
        fields: removeEmptyToolCallMetadata(event.delta.fields)
      }
    }
  }

  if (event.event === 'content-block-finish' && isToolCallContent(event.content)) {
    rememberToolCallMetadata(event.content, event.index, state)
    const content = removeEmptyToolCallMetadata(event.content)
    const id = content.id ?? state.ids.get(event.index)
    const name = content.name ?? state.names.get(event.index)
    return {
      ...event,
      content: {
        ...content,
        ...(id ? { id } : {}),
        ...(name ? { name } : {})
      } as typeof event.content
    }
  }

  return event
}

function normalizeOpenAiCompatibleReasoning(message: BaseMessage): BaseMessage {
  if (!AIMessage.isInstance(message)) return message
  const reasoning = message.additional_kwargs.reasoning_content
  if (typeof reasoning !== 'string' || !reasoning.trim()) return message
  const contentBlocks = message.contentBlocks
  if (contentBlocks.some((block) => block.type === 'reasoning')) return message
  return new AIMessage({
    id: message.id,
    name: message.name,
    content: [{ type: 'reasoning', reasoning }, ...contentBlocks],
    additional_kwargs: message.additional_kwargs,
    response_metadata: {
      ...message.response_metadata,
      output_version: 'v1'
    },
    tool_calls: message.tool_calls,
    invalid_tool_calls: message.invalid_tool_calls,
    usage_metadata: message.usage_metadata
  })
}

/**
 * Qwen's OpenAI-compatible stream emits tool-call metadata in the first delta
 * and empty values in later deltas. LangChain's native event converter currently
 * lets those empty values overwrite the original id and name. Preserve both at
 * the model boundary so Deep Agents can execute and correlate tools correctly.
 */
export class OpenAICompatibleChatModel extends ChatOpenAI {
  private readonly anasProfile?: ModelProfile
  private readonly anasCompressionTracking?: CompressionTrackingCallbacks
  private readonly anasRetryOptions?: ModelRetryOptions
  private readonly anasBeforeRequest?: () => Promise<void>
  private readonly anasUseResponsesApi: boolean

  constructor(fields: OpenAICompatibleChatModelFields) {
    const {
      anasProfile,
      anasCompressionTracking,
      anasRetryOptions,
      anasBeforeRequest,
      anasUseResponsesApi,
      ...modelFields
    } = fields
    super(modelFields)
    this.anasProfile = anasProfile
    this.anasCompressionTracking = anasCompressionTracking
    this.anasRetryOptions = anasRetryOptions
    this.anasBeforeRequest = anasBeforeRequest
    this.anasUseResponsesApi = anasUseResponsesApi ?? false
  }

  protected override _useResponsesApi(_options: this['ParsedCallOptions'] | undefined): boolean {
    return this.anasUseResponsesApi
  }

  override get profile(): ModelProfile {
    return {
      ...super.profile,
      ...this.anasProfile
    }
  }

  override async getNumTokens(content: MessageContent): Promise<number> {
    // LangChain otherwise downloads an OpenAI tokenizer on first use. Besides
    // being inaccurate for compatible providers such as Qwen, an unavailable
    // tokenizer CDN can serially stall response finalization for minutes.
    return approximateContentTokens(content)
  }

  override invoke(
    input: BaseLanguageModelInput,
    options?: Partial<ChatOpenAICallOptions>
  ): Promise<AIMessageChunk> {
    return invokeWithCompressionTracking(
      input,
      options,
      this.anasCompressionTracking,
      (trackedOptions) => {
        const invoke = async () => {
          await this.anasBeforeRequest?.()
          return super.invoke(input, trackedOptions)
        }
        return this.anasRetryOptions ? invokeModelWithRetry(invoke, {
          ...this.anasRetryOptions,
          retryWhen: (error) => !isModelRequestChangedError(error)
        }) : invoke()
      },
      this.anasBeforeRequest
    )
  }

  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun
  ): Promise<ChatResult> {
    const prepared = this.anasUseResponsesApi
      ? prepareOpenAICompatibleResponsesMessages(encodeOpenAiToolImages(messages, true), this.responses.zdrEnabled ?? false)
      : encodeOpenAiToolImages(messages, false)
    const result = await super._generate(prepared, options, runManager)
    if (this.anasUseResponsesApi) return result
    return {
      ...result,
      generations: result.generations.map((generation) => ({
        ...generation,
        message: normalizeOpenAiCompatibleReasoning(generation.message)
      }))
    }
  }

  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatGenerationChunk> {
    const prepared = this.anasUseResponsesApi
      ? prepareOpenAICompatibleResponsesMessages(encodeOpenAiToolImages(messages, true), this.responses.zdrEnabled ?? false)
      : encodeOpenAiToolImages(messages, false)
    yield* super._streamResponseChunks(prepared, options, runManager)
  }

  override withConfig(
    config: Partial<ChatOpenAICallOptions>
  ): Runnable<BaseLanguageModelInput, AIMessageChunk, ChatOpenAICallOptions> {
    const model = new OpenAICompatibleChatModel({
      ...this.fields,
      anasProfile: this.anasProfile,
      anasCompressionTracking: this.anasCompressionTracking,
      anasRetryOptions: this.anasRetryOptions,
      anasBeforeRequest: this.anasBeforeRequest,
      anasUseResponsesApi: this.anasUseResponsesApi
    })
    model.defaultOptions = { ...this.defaultOptions, ...config }
    return model
  }

  override async *_streamChatModelEvents(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatModelStreamEvent> {
    messages = encodeOpenAiToolImages(messages, this.anasUseResponsesApi)
    if (this.anasUseResponsesApi) {
      const combinedOptions = this._combineCallOptions(options)
      const streamIterable = await this.responses.completionWithRetry({
        ...this.responses.invocationParams(combinedOptions),
        input: convertOpenAICompatibleMessagesToResponsesInput({
          messages,
          model: this.responses.model,
          zdrEnabled: this.responses.zdrEnabled ?? false
        }),
        stream: true
      }, combinedOptions)
      const abortableStream = async function *() {
        for await (const event of streamIterable) {
          if (combinedOptions.signal?.aborted) return
          yield event
        }
      }
      yield* convertOpenAICompatibleResponsesStream(abortableStream(), {
        streamUsage: this.responses.streamUsage,
        provider: 'openai'
      })
      return
    }
    const toolCallState: ToolCallStreamState = {
      ids: new Map(),
      names: new Map()
    }
    for await (const event of super._streamChatModelEvents(messages, options, runManager)) {
      yield preserveOpenAiToolCallMetadata(event, toolCallState)
    }
  }
}
