import {
  ChatAnthropic,
  type ChatAnthropicCallOptions,
  type ChatAnthropicInput
} from '@langchain/anthropic'
import type {
  BaseLanguageModel,
  BaseLanguageModelInput
} from '@langchain/core/language_models/base'
import type { ModelProfile } from '@langchain/core/language_models/profile'
import type { ChatModelStreamEvent } from '@langchain/core/language_models/event'
import type { CallbackManagerForLLMRun, Callbacks } from '@langchain/core/callbacks/manager'
import type { AIMessageChunk, BaseMessage, MessageContent } from '@langchain/core/messages'
import { modelReservedParameterKeys, requireModelProtocol } from '@shared/modelConfig'
import type { ResolvedModelConfig } from '@shared/types'
import { resolveModelApiKey } from '../config/apiKeys'
import { runtimeLog } from '../runtimeLogger'
import {
  invokeWithCompressionTracking,
  type CompressionTrackingCallbacks
} from './compressionTracking'
import { approximateContentTokens, modelParameterInputTokens } from './localTokenCounting'
import { OpenAICompatibleChatModel } from './openAiCompatibleChatModel'
import { createProviderHttpTraceFetch } from './providerHttpTrace'
import { invokeModelWithRetry, type ModelRetryOptions } from './modelRetryPolicy'
import { ModelSelectionError } from './modelSelection'
import { isModelRequestChangedError } from './modelRequestValidation'

type ModelParameters = Record<string, unknown>

export interface ChatModelOverrides {
  beforeRequest?: () => Promise<void>
  callbacks?: Callbacks
  compressionTracking?: CompressionTrackingCallbacks
  developerHttpTrace?: boolean
  providerFetch?: typeof fetch
  requestId?: string
  requestRole?: string
  signal?: AbortSignal
  streaming?: boolean
  timeoutMs?: number
}

export const contextCompressionTimeoutMs = 120_000
const fallbackApiKey = 'anas-no-auth'

class LocallyCountedChatAnthropic extends ChatAnthropic {
  private readonly anasProfile?: ModelProfile
  private readonly anasCompressionTracking?: CompressionTrackingCallbacks
  private readonly anasRetryOptions?: ModelRetryOptions
  private readonly anasBeforeRequest?: () => Promise<void>

  constructor(fields: ChatAnthropicInput & {
    anasProfile?: ModelProfile
    anasCompressionTracking?: CompressionTrackingCallbacks
    anasRetryOptions?: ModelRetryOptions
    anasBeforeRequest?: () => Promise<void>
  }) {
    const {
      anasProfile,
      anasCompressionTracking,
      anasRetryOptions,
      anasBeforeRequest,
      ...modelFields
    } = fields
    super(modelFields)
    this.anasProfile = anasProfile
    this.anasCompressionTracking = anasCompressionTracking
    this.anasRetryOptions = anasRetryOptions
    this.anasBeforeRequest = anasBeforeRequest
  }

  override get profile(): ModelProfile {
    return {
      ...super.profile,
      ...this.anasProfile
    }
  }

  override async getNumTokens(content: MessageContent): Promise<number> {
    return approximateContentTokens(content)
  }

  override async *_streamChatModelEvents(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun
  ): AsyncGenerator<ChatModelStreamEvent> {
    for await (const event of super._streamChatModelEvents(messages, options, runManager)) {
      // ChatModelStream persists responseMetadata. Anthropic places its provider
      // identity in metadata, which its own replay converter needs for reasoning.
      if (event.event === 'message-finish' && 'metadata' in event && event.metadata && typeof event.metadata === 'object') {
        yield { ...event, responseMetadata: { ...event.metadata, ...event.responseMetadata } }
      } else yield event
    }
  }

  override invoke(
    input: BaseLanguageModelInput,
    options?: Partial<ChatAnthropicCallOptions>
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
}

function observedProviderFetch(config: ResolvedModelConfig, overrides: ChatModelOverrides): typeof fetch {
  let requestNumber = 0
  return async (input, init) => {
    requestNumber += 1
    const startedAt = Date.now()
    runtimeLog('debug', 'agent-model', 'Provider request started.', {
      runId: overrides.requestId,
      role: overrides.requestRole ?? 'model',
      protocol: config.protocol,
      model: config.model,
      requestNumber
    })
    try {
      const response = await globalThis.fetch(input, init)
      runtimeLog('debug', 'agent-model', 'Provider request completed.', {
        runId: overrides.requestId,
        role: overrides.requestRole ?? 'model',
        protocol: config.protocol,
        model: config.model,
        requestNumber,
        status: response.status,
        durationMs: Date.now() - startedAt
      })
      return response
    } catch (error) {
      runtimeLog('warn', 'agent-model', 'Provider request failed.', {
        runId: overrides.requestId,
        role: overrides.requestRole ?? 'model',
        protocol: config.protocol,
        model: config.model,
        requestNumber,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error
          ? {
              name: error.name,
              code: 'code' in error && typeof error.code === 'string' ? error.code : undefined
            }
          : { name: typeof error }
      })
      throw error
    }
  }
}

function takeNumber(parameters: ModelParameters, keys: string[], allowNull?: false): number | undefined
function takeNumber(parameters: ModelParameters, keys: string[], allowNull: true): number | null | undefined
function takeNumber(parameters: ModelParameters, keys: string[], allowNull = false): number | null | undefined {
  let selected: number | null | undefined
  for (const key of keys) {
    if (!Object.hasOwn(parameters, key)) continue
    const value = parameters[key]
    if (!(allowNull && value === null) && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new ModelSelectionError(`Model parameter "${key}" must be a finite number${allowNull ? ' or null' : ''}. Correct its settings and send again.`)
    }
    if (selected === undefined) selected = value as number | null
  }
  return selected
}

function takeStringArray(parameters: ModelParameters, key: string): string[] | undefined {
  if (!Object.hasOwn(parameters, key)) return undefined
  const value = parameters[key]
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ModelSelectionError(`Model parameter "${key}" must be an array of strings. Correct its settings and send again.`)
  }
  return value
}

function takeOpenAiStop(parameters: ModelParameters): string | string[] | null | undefined {
  if (!Object.hasOwn(parameters, 'stop')) return undefined
  const value = parameters.stop
  if (value === null || typeof value === 'string') return value
  return takeStringArray(parameters, 'stop')
}

function omit(parameters: ModelParameters, keys: readonly string[]): ModelParameters {
  const excluded = new Set(keys)
  return Object.fromEntries(Object.entries(parameters).filter(([key]) => !excluded.has(key)))
}

function requireModelName(config: ResolvedModelConfig): string {
  const model = config.model.trim()
  if (!model) throw new Error(`Provider "${config.providerName}" has an incomplete model configuration.`)
  return model
}

function modelApiKey(config: ResolvedModelConfig): string {
  return resolveModelApiKey(config) ?? fallbackApiKey
}

function configuredModelProfile(config: ResolvedModelConfig): ModelProfile {
  return {
    maxInputTokens: Math.max(1, config.maxContextTokens - config.maxOutputTokens),
    ...(config.maxOutputTokens > 0 ? { maxOutputTokens: config.maxOutputTokens } : {})
  }
}

export function createChatModel(
  config: ResolvedModelConfig,
  overrides: ChatModelOverrides = {}
): BaseLanguageModel {
  try {
    return createConfiguredChatModel(config, overrides)
  } catch (cause) {
    if (cause instanceof ModelSelectionError) throw cause
    throw new ModelSelectionError(`The selected model cannot be initialized: ${cause instanceof Error ? cause.message : String(cause)}. Correct its settings and send again.`, { cause })
  }
}

function createConfiguredChatModel(
  config: ResolvedModelConfig,
  overrides: ChatModelOverrides
): BaseLanguageModel {
  const parameters = config.parameters
  const protocol = requireModelProtocol(config.protocol, 'model.protocol')
  if ('tools' in parameters && protocol !== 'openai_responses') {
    throw new Error('The model parameter "tools" is only supported by the OpenAI Responses protocol.')
  }
  const reserved = modelReservedParameterKeys(parameters)
  if (reserved.length > 0) {
    throw new Error(`Config value model.parameters contains reserved keys: ${reserved.join(', ')}.`)
  }
  modelParameterInputTokens(protocol, parameters)
  const model = requireModelName(config)
  const apiKey = modelApiKey(config)
  const streaming = overrides.streaming ?? config.stream
  const observedFetch = observedProviderFetch(config, overrides)
  const providerFetch = overrides.providerFetch ?? (
    overrides.developerHttpTrace
      ? createProviderHttpTraceFetch(observedFetch, {
          model,
          protocol,
          providerName: config.providerName,
          requestId: overrides.requestId,
          requestRole: overrides.requestRole
        })
      : observedFetch
  )
  const compressionRetryOptions: ModelRetryOptions | undefined = overrides.requestRole?.includes('compression')
    ? { runId: overrides.requestId, signal: overrides.signal }
    : undefined

  if (protocol === 'anthropic_messages') {
    const invocationKwargs = omit(parameters, [
      'thinking',
      'output_config',
      'temperature',
      'topP',
      'top_p',
      'topK',
      'top_k',
      'stop_sequences',
      'tools'
    ])
    const chatModel = new LocallyCountedChatAnthropic({
      callbacks: overrides.callbacks,
      anasProfile: configuredModelProfile(config),
      anasCompressionTracking: overrides.compressionTracking,
      anasRetryOptions: compressionRetryOptions,
      anasBeforeRequest: overrides.beforeRequest,
      apiKey,
      maxRetries: 0,
      model,
      anthropicApiUrl: config.baseUrl || undefined,
      temperature: takeNumber(parameters, ['temperature']),
      topP: takeNumber(parameters, ['topP', 'top_p']),
      topK: takeNumber(parameters, ['topK', 'top_k']),
      maxTokens: config.maxOutputTokens > 0 ? config.maxOutputTokens : undefined,
      stopSequences: takeStringArray(parameters, 'stop_sequences'),
      thinking: parameters.thinking as ChatAnthropicInput['thinking'],
      outputConfig: parameters.output_config as ChatAnthropicInput['outputConfig'],
      streaming,
      clientOptions: {
        ...(overrides.timeoutMs ? { timeout: overrides.timeoutMs } : {}),
        fetch: providerFetch
      },
      invocationKwargs
    })
    try {
      // The adapter validates model-specific thinking/sampling combinations
      // while constructing invocation parameters, before any provider call.
      chatModel.invocationParams()
    } catch (cause) {
      throw new ModelSelectionError(`The current Anthropic model parameters cannot be used: ${cause instanceof Error ? cause.message : String(cause)}. Correct its settings and send again.`, { cause })
    }
    return chatModel
  }

  const numbers = {
    temperature: takeNumber(parameters, ['temperature'], true),
    top_p: takeNumber(parameters, ['topP', 'top_p'], true),
    frequency_penalty: takeNumber(parameters, ['frequencyPenalty', 'frequency_penalty'], true),
    presence_penalty: takeNumber(parameters, ['presencePenalty', 'presence_penalty'], true),
    n: takeNumber(parameters, ['n'], true)
  }
  const stop = takeOpenAiStop(parameters)
  const modelKwargs = {
    ...omit(parameters, [
      'temperature',
      'topP',
      'top_p',
      'frequencyPenalty',
      'frequency_penalty',
      'presencePenalty',
      'presence_penalty',
      'n',
      'stop',
      'tools'
    ]),
    // The SDK's constructor uses ?? defaults for sampling fields. Keep the
    // provider's exact nullable values and stop union in its native kwargs.
    ...Object.fromEntries(Object.entries(numbers).filter(([, value]) => value !== undefined)),
    ...(stop !== undefined ? { stop } : {})
  }
  return new OpenAICompatibleChatModel({
    callbacks: overrides.callbacks,
    anasProfile: configuredModelProfile(config),
    anasCompressionTracking: overrides.compressionTracking,
    anasRetryOptions: compressionRetryOptions,
    anasBeforeRequest: overrides.beforeRequest,
    anasUseResponsesApi: protocol === 'openai_responses',
    useResponsesApi: protocol === 'openai_responses',
    apiKey,
    maxRetries: 0,
    model,
    configuration: {
      baseURL: config.baseUrl || undefined,
      fetch: providerFetch
    },
    temperature: numbers.temperature ?? undefined,
    topP: numbers.top_p ?? undefined,
    maxTokens: config.maxOutputTokens > 0 ? config.maxOutputTokens : -1,
    frequencyPenalty: numbers.frequency_penalty ?? undefined,
    presencePenalty: numbers.presence_penalty ?? undefined,
    n: numbers.n ?? undefined,
    stop: Array.isArray(stop) ? stop : undefined,
    streaming,
    timeout: overrides.timeoutMs,
    modelKwargs
  })
}

export function createCompressionChatModel(
  config: ResolvedModelConfig,
  overrides: Pick<ChatModelOverrides, 'beforeRequest' | 'callbacks' | 'compressionTracking' | 'developerHttpTrace' | 'requestId' | 'requestRole' | 'signal'> = {}
): BaseLanguageModel {
  return createChatModel(config, {
    ...overrides,
    requestRole: overrides.requestRole ?? 'compression',
    streaming: false,
    timeoutMs: contextCompressionTimeoutMs
  })
}
