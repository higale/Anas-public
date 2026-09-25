import { AsyncLocalStorage } from 'node:async_hooks'
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base'
import { HumanMessage, type BaseMessage } from '@langchain/core/messages'
import { mergeConfigs, type RunnableConfig } from '@langchain/core/runnables'
import { summaryPrompt } from '@shared/summaryPrompt'
import { countMessagesApproximately, type LocalTokenCountingOptions } from './localTokenCounting'
import { ModelSelectionError } from './modelSelection'

export interface CompressionCompletion {
  modelContent: string
  cutoffIndex: number
  activatedAfterMessageIndex: number
  coveredThroughMessageId?: string
  firstPreservedMessageId?: string
  inputTokensBefore: number
  inputTokensAfter: number
  messages: BaseMessage[]
}

export interface CompressionTrackingCallbacks {
  onCompressionStart?(): string
  onCompressionCompleted?(
    summaryId: string,
    summaryText: string,
    completion?: CompressionCompletion
  ): void
  onCompressionFailed?(summaryId: string): void
}

export interface GeneratedCompressionSummary {
  callbacks?: CompressionTrackingCallbacks
  id?: string
  state: 'pending' | 'completed' | 'failed'
  text: string
}

interface CompressionSummaryContext {
  activeUserRequest?: string
  inputCapacityTokens?: number
  tokenCountingOptions?: LocalTokenCountingOptions
  generated: GeneratedCompressionSummary[]
}

const activeUserRequestStart = '<active_user_request>'
const activeUserRequestEnd = '</active_user_request>'
const activeUserRequestPattern = new RegExp(
  `\\n*${activeUserRequestStart}[\\s\\S]*?${activeUserRequestEnd}\\n*`,
  'g'
)
const compressionSummaryContext = new AsyncLocalStorage<CompressionSummaryContext>()

function responseText(response: unknown): string {
  if (!response || typeof response !== 'object') return ''
  if ('text' in response && typeof response.text === 'string') return response.text.trim()
  if ('content' in response && typeof response.content === 'string') return response.content.trim()
  return ''
}

function finalizedSummaryText(text: string): string {
  const summary = text.replace(activeUserRequestPattern, '\n').trim()
  if (!summary) throw new ModelSelectionError('Context compression returned an empty summary. The run was stopped without replacing its history. Try again or select another model.')
  const activeUserRequest = compressionSummaryContext.getStore()?.activeUserRequest?.trim()
  if (!activeUserRequest) return summary
  return [
    summary,
    activeUserRequestStart,
    activeUserRequest,
    activeUserRequestEnd
  ].filter(Boolean).join('\n\n')
}

function replaceResponseText<Result>(response: Result, text: string): Result {
  if (response && typeof response === 'object' && 'content' in response) {
    const mutableResponse = response as { content: unknown }
    mutableResponse.content = [{ type: 'text', text }]
  }
  return response
}

const summaryPromptPrefix = summaryPrompt.slice(
  0,
  summaryPrompt.indexOf('{output_language}')
)

export function withCompressionSummaryContext<Result>(
  context: Pick<CompressionSummaryContext, 'activeUserRequest' | 'inputCapacityTokens' | 'tokenCountingOptions'>,
  action: (generated: GeneratedCompressionSummary[]) => Promise<Result>,
  complete?: (
    result: Result,
    generated: GeneratedCompressionSummary[]
  ) => void
): Promise<Result> {
  const scope: CompressionSummaryContext = {
    ...context,
    generated: []
  }
  return compressionSummaryContext.run(scope, async () => {
    try {
      const result = await action(scope.generated)
      complete?.(result, scope.generated)
      return result
    } catch (error) {
      for (const generated of scope.generated) {
        if (generated.state === 'failed') continue
        generated.state = 'failed'
        if (generated.id) generated.callbacks?.onCompressionFailed?.(generated.id)
      }
      throw error
    }
  })
}

export function hasGeneratedCompressionSummary(): boolean {
  return Boolean(
    compressionSummaryContext.getStore()?.generated.some(
      (generated) => generated.state !== 'failed'
    )
  )
}

export function isCompressionModelInput(input: BaseLanguageModelInput): boolean {
  return Array.isArray(input)
    && input.length === 1
    && HumanMessage.isInstance(input[0])
    && input[0].text.startsWith(summaryPromptPrefix)
}

export async function invokeWithCompressionTracking<
  Result,
  Config extends RunnableConfig
>(
  input: BaseLanguageModelInput,
  config: Config | undefined,
  callbacks: CompressionTrackingCallbacks | undefined,
  invoke: (config: Config | undefined) => Promise<Result>,
  beforePrepare?: () => Promise<void>
): Promise<Result> {
  if (!isCompressionModelInput(input)) return invoke(config)

  const summaryId = callbacks?.onCompressionStart?.()
  try {
    // Preparation may have awaited attachment or backend work. Refresh before
    // judging the summary against a budget captured by the outer model call.
    await beforePrepare?.()
    const scope = compressionSummaryContext.getStore()
    const capacity = scope?.inputCapacityTokens
    if (capacity !== undefined && countMessagesApproximately(input as BaseMessage[], null, scope?.tokenCountingOptions) > capacity) {
      throw new ModelSelectionError('The complete summary input exceeds the model capacity. The run was stopped without replacing its history. Choose a larger-context model and send again.')
    }
    const trackedConfig = mergeConfigs(config, {
      tags: ['langsmith:hidden', 'langsmith:nostream', 'anas:context-summary']
    }) as Config
    const response = await invoke(trackedConfig)
    const summaryText = finalizedSummaryText(responseText(response))
    if (scope) {
      scope.generated.push({
        callbacks,
        id: summaryId,
        state: 'pending',
        text: summaryText
      })
    } else if (summaryId) {
      callbacks?.onCompressionCompleted?.(summaryId, summaryText)
    }
    return replaceResponseText(response, summaryText)
  } catch (error) {
    if (summaryId) callbacks?.onCompressionFailed?.(summaryId)
    throw error
  }
}
