import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
  type ToolMessageFields
} from '@langchain/core/messages'
import { ContextOverflowError } from '@langchain/core/errors'
import { createSummarizationMiddleware } from 'deepagents'
import type { ModelProtocol } from '@shared/types'
import {
  summaryPromptForLanguage,
  type SummaryOutputLanguage
} from '@shared/summaryPrompt'
import {
  hasGeneratedCompressionSummary,
  withCompressionSummaryContext,
  type CompressionCompletion,
  type GeneratedCompressionSummary
} from './compressionTracking'
import { effectiveContextMessages } from './contextRuntime'
import { agentContextStateSchema } from './contextStateSchema'
import { countMessagesApproximately } from './localTokenCounting'
import { currentContextWindowTokens } from './serverTokenUsage'
import { ModelSelectionError } from './modelSelection'
import { projectRulesRequestBudget } from './projectRules'
import { hasToolImages, pendingToolImageStart, projectToolImages } from './toolImageProjection'

type FrameworkSummaryOptions = Parameters<typeof createSummarizationMiddleware>[0]

interface CausalUnit {
  start: number
  end: number
  tokens: number
}

export interface CompressionRetentionSelection {
  cutoffIndex: number
  retainedTokens: number
  activeUserRequest?: string
}

interface FrameworkSummarizationEvent {
  cutoffIndex: number
  summaryMessage: BaseMessage
}

class PreservedContextOverflowError extends ModelSelectionError {
  constructor() {
    super(
      'The latest complete conversation unit still exceeds the model context window ' +
      'after compacting its tool results. The unit was not removed.'
    )
    this.name = 'PreservedContextOverflowError'
  }
}

function isSummaryMessage(message: BaseMessage): boolean {
  return message.additional_kwargs?.lc_source === 'summarization'
}

function isRealUserMessage(message: BaseMessage): boolean {
  return HumanMessage.isInstance(message) && !isSummaryMessage(message)
}

function rangeTokens(messages: BaseMessage[], start: number, end: number, protocol: ModelProtocol): number {
  return countMessagesApproximately(messages.slice(start, end), null, { protocol })
}

function causalUnits(messages: BaseMessage[], start: number, protocol: ModelProtocol): CausalUnit[] {
  const units: CausalUnit[] = []
  let index = start
  while (index < messages.length) {
    const unitStart = index
    const message = messages[index]
    index += 1
    if (AIMessage.isInstance(message) && message.tool_calls?.length) {
      const toolCallIds = new Set(message.tool_calls.flatMap((call) => call.id ? [call.id] : []))
      while (
        index < messages.length
        && ToolMessage.isInstance(messages[index])
        && (
          toolCallIds.size === 0
          || toolCallIds.has((messages[index] as ToolMessage).tool_call_id)
        )
      ) {
        index += 1
      }
    } else if (ToolMessage.isInstance(message)) {
      while (index < messages.length && ToolMessage.isInstance(messages[index])) index += 1
    }
    units.push({
      start: unitStart,
      end: index,
      tokens: rangeTokens(messages, unitStart, index, protocol)
    })
  }
  return units
}

function newestCausalSuffix(
  messages: BaseMessage[],
  start: number,
  tokenLimit: number,
  protocol: ModelProtocol
): { cutoffIndex: number; retainedTokens: number } {
  const units = causalUnits(messages, start, protocol)
  let cutoffIndex = messages.length
  let retainedTokens = 0
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index]
    if (retainedTokens + unit.tokens > tokenLimit) {
      if (retainedTokens === 0) {
        cutoffIndex = unit.start
        retainedTokens = unit.tokens
      }
      break
    }
    cutoffIndex = unit.start
    retainedTokens += unit.tokens
  }
  return { cutoffIndex, retainedTokens }
}

function isContextOverflow(error: unknown): boolean {
  let current = error
  while (current) {
    if (ContextOverflowError.isInstance(current)) return true
    current = typeof current === 'object' && 'cause' in current
      ? (current as { cause?: unknown }).cause
      : undefined
  }
  return false
}

function compactedToolContent(content: ToolMessage['content'], maxChars: number): string {
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  if (text.length <= maxChars) return text
  const marker = `\n\n[Tool result compacted for model context; ${text.length - maxChars} characters omitted.]\n\n`
  const retainedChars = Math.max(0, maxChars - marker.length)
  const headChars = Math.ceil(retainedChars * 0.75)
  const tailChars = retainedChars - headChars
  return text.slice(0, headChars) + marker + (tailChars > 0 ? text.slice(-tailChars) : '')
}

function compactLatestToolResults(
  messages: BaseMessage[],
  inputCapacityTokens: number,
  systemMessage: unknown,
  tools: unknown,
  protocol: ModelProtocol,
  parameters: Record<string, unknown> | undefined
): BaseMessage[] | undefined {
  const latestUnit = causalUnits(messages, 0, protocol).at(-1)
  if (!latestUnit) return undefined
  const toolIndices: number[] = []
  for (let index = latestUnit.start; index < latestUnit.end; index += 1) {
    // Never stringify/truncate a fresh image during overflow recovery.
    if (ToolMessage.isInstance(messages[index]) && !hasToolImages(messages[index])) toolIndices.push(index)
  }
  if (toolIndices.length === 0) return undefined

  const messagesWithoutLatestResults = messages.map((message, index) =>
    toolIndices.includes(index)
      ? new ToolMessage({
          ...(message as ToolMessage as unknown as ToolMessageFields),
          content: ''
        })
      : message
  )
  const countedMessages = SystemMessage.isInstance(systemMessage)
    ? [systemMessage, ...messagesWithoutLatestResults]
    : messagesWithoutLatestResults
  const overheadTokens = countMessagesApproximately(
    countedMessages,
    Array.isArray(tools) && tools.length > 0
      ? tools as Array<Record<string, unknown>>
      : null,
    { protocol, parameters }
  )
  const resultTokenBudget = Math.max(
    64,
    Math.floor(inputCapacityTokens * 0.7) - overheadTokens
  )
  const maxCharsPerResult = Math.max(
    256,
    Math.floor(resultTokenBudget * 4 / toolIndices.length)
  )
  let modified = false
  const compacted = messages.map((message, index) => {
    if (!toolIndices.includes(index) || !ToolMessage.isInstance(message)) return message
    const content = compactedToolContent(message.content, maxCharsPerResult)
    const original = typeof message.content === 'string'
      ? message.content
      : JSON.stringify(message.content)
    if (content === original) return message
    modified = true
    return new ToolMessage({
      ...(message as unknown as ToolMessageFields),
      content
    })
  })
  return modified ? compacted : undefined
}

function summarizationEventFromPreparedMessages(
  preparedMessages: BaseMessage[],
  originalMessages: BaseMessage[]
): FrameworkSummarizationEvent | undefined {
  const summaryIndex = preparedMessages.findIndex(isSummaryMessage)
  if (summaryIndex < 0) return undefined
  const summaryMessage = preparedMessages[summaryIndex]
  const firstPreserved = preparedMessages[summaryIndex + 1]
  if (!firstPreserved) {
    return {
      cutoffIndex: originalMessages.length,
      summaryMessage
    }
  }
  const cutoffIndex = originalMessages.findIndex((message) =>
    message === firstPreserved
    || Boolean(message.id && firstPreserved.id && message.id === firstPreserved.id)
  )
  return cutoffIndex < 0
    ? undefined
    : { cutoffIndex, summaryMessage }
}

function failGeneratedSummary(summary: GeneratedCompressionSummary): void {
  if (summary.state === 'failed') return
  summary.state = 'failed'
  if (summary.id) summary.callbacks?.onCompressionFailed?.(summary.id)
}

function completeGeneratedSummary(
  event: FrameworkSummarizationEvent | undefined,
  generated: GeneratedCompressionSummary[],
  messages: BaseMessage[],
  protocol: ModelProtocol,
  parameters: Record<string, unknown> | undefined,
  before: { messages: BaseMessage[]; systemMessage: SystemMessage | undefined; tools: unknown[] },
  after: { messages: BaseMessage[]; systemMessage: SystemMessage | undefined; tools: unknown[] }
): void {
  const pending = generated.filter((summary) => summary.state === 'pending')
  if (pending.length === 0) return
  const completed = pending.at(-1)
  if (!event || !completed) {
    for (const item of pending) failGeneratedSummary(item)
    return
  }
  for (const item of pending.slice(0, -1)) failGeneratedSummary(item)
  completed.state = 'completed'
  if (!completed.id) return
  event.summaryMessage.additional_kwargs = {
    ...event.summaryMessage.additional_kwargs,
    anas_summary_id: completed.id
  }
  const cutoffIndex = Math.max(0, Math.min(messages.length, Math.floor(event.cutoffIndex)))
  const completion: CompressionCompletion = {
    modelContent: event.summaryMessage.text,
    cutoffIndex,
    activatedAfterMessageIndex: Math.max(0, cutoffIndex - 1),
    coveredThroughMessageId: messages[cutoffIndex - 1]?.id,
    firstPreservedMessageId: messages[cutoffIndex]?.id,
    inputTokensBefore: countMessagesApproximately([...(before.systemMessage ? [before.systemMessage] : []), ...before.messages], before.tools as Record<string, unknown>[], { protocol, parameters }),
    inputTokensAfter: countMessagesApproximately([...(after.systemMessage ? [after.systemMessage] : []), ...after.messages], after.tools as Record<string, unknown>[], { protocol, parameters }),
    messages
  }
  completed.callbacks?.onCompressionCompleted?.(
    completed.id,
    completed.text,
    completion
  )
}

function latestRealUserIndex(messages: BaseMessage[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isRealUserMessage(messages[index])) return index
  }
  return undefined
}

function preservedContainsMessage(
  preserved: BaseMessage[],
  target: BaseMessage
): boolean {
  if (preserved.includes(target)) return true
  return Boolean(target.id && preserved.some((message) => message.id === target.id))
}

export function selectCompressionRetention(
  effectiveMessages: BaseMessage[],
  rawMessages: BaseMessage[],
  thresholdTokens: number,
  protocol: ModelProtocol
): CompressionRetentionSelection {
  const currentTurnLimit = Math.max(1, Math.floor(thresholdTokens / 4))
  const olderTurnsLimit = Math.max(1, Math.floor(thresholdTokens / 8))
  const currentUserIndex = latestRealUserIndex(effectiveMessages)
  const currentTurnStart = currentUserIndex
    ?? (effectiveMessages[0] && isSummaryMessage(effectiveMessages[0]) ? 1 : 0)
  const currentTurnTokens = rangeTokens(
    effectiveMessages,
    currentTurnStart,
    effectiveMessages.length,
    protocol
  )
  let cutoffIndex = currentTurnStart
  let retainedTokens = currentTurnTokens

  if (currentTurnTokens > currentTurnLimit) {
    const selected = newestCausalSuffix(
      effectiveMessages,
      currentTurnStart,
      currentTurnLimit,
      protocol
    )
    cutoffIndex = selected.cutoffIndex
    retainedTokens = selected.retainedTokens
  } else if (currentUserIndex !== undefined) {
    let olderBudget = Math.min(
      olderTurnsLimit,
      Math.max(0, currentTurnLimit - currentTurnTokens)
    )
    const userIndices = effectiveMessages.flatMap((message, index) =>
      isRealUserMessage(message) && index < currentUserIndex ? [index] : []
    )
    let nextTurnStart = currentUserIndex
    for (let index = userIndices.length - 1; index >= 0; index -= 1) {
      const turnStart = userIndices[index]
      const turnTokens = rangeTokens(effectiveMessages, turnStart, nextTurnStart, protocol)
      if (turnTokens > olderBudget) break
      cutoffIndex = turnStart
      retainedTokens += turnTokens
      olderBudget -= turnTokens
      nextTurnStart = turnStart
    }
  }

  const pendingImagesStart = pendingToolImageStart(effectiveMessages)
  if (pendingImagesStart !== undefined && cutoffIndex > pendingImagesStart) {
    cutoffIndex = pendingImagesStart
    retainedTokens = rangeTokens(effectiveMessages, cutoffIndex, effectiveMessages.length, protocol)
  }
  const summarizedPrefix = effectiveMessages.slice(0, cutoffIndex)
  if (
    summarizedPrefix.length > 0
    && summarizedPrefix.every(isSummaryMessage)
  ) {
    cutoffIndex = 0
    retainedTokens = rangeTokens(effectiveMessages, 0, effectiveMessages.length, protocol)
  }

  const latestRawUserIndex = latestRealUserIndex(rawMessages)
  const latestRawUser = latestRawUserIndex === undefined
    ? undefined
    : rawMessages[latestRawUserIndex]
  const preserved = effectiveMessages.slice(cutoffIndex)
  const activeUserRequest = latestRawUser
    && !preservedContainsMessage(preserved, latestRawUser)
    ? latestRawUser.text.trim() || undefined
    : undefined

  return {
    cutoffIndex,
    retainedTokens: Math.max(1, retainedTokens),
    activeUserRequest
  }
}

export function createAnasSummarizationMiddleware(options: {
  codingMode?: boolean
  responseTools?: Record<string, unknown>[]
  backend: FrameworkSummaryOptions['backend']
  outputLanguage: SummaryOutputLanguage
  resolveRequest(): {
    inputCapacityTokens: number
    model: FrameworkSummaryOptions['model']
    protocol: ModelProtocol
    parameters?: Record<string, unknown>
    modelContextKey: string
    threshold: number
    enabled: boolean
  }
}): ReturnType<typeof createSummarizationMiddleware> {
  // The framework owns the checkpoint schema. Each request gets its current
  // model and budget without keeping a second copy in the running agent.
  const middleware = createSummarizationMiddleware({ backend: options.backend })
  return {
    ...middleware,
    stateSchema: agentContextStateSchema,
    wrapModelCall: async (request, handler) => {
      const configuration = options.resolveRequest()
      request = { ...request, messages: projectToolImages(request.messages) }
      if (!configuration.enabled) {
        return handler({ ...request, messages: effectiveContextMessages(request.messages, request.state) })
      }
      const trigger = { type: 'messages' as const, value: Number.MAX_SAFE_INTEGER }
      const keep = { type: 'messages' as const, value: 1 }
      const requestMiddleware = createSummarizationMiddleware({
        model: configuration.model,
        summaryPrompt: summaryPromptForLanguage(options.outputLanguage, options.codingMode === true),
        backend: options.backend,
        trigger,
        keep
      })
      const frameworkWrapModelCall = requestMiddleware.wrapModelCall
      if (!frameworkWrapModelCall) throw new Error('Deep Agents summarization middleware has no model-call wrapper.')
      const effectiveMessages = effectiveContextMessages(request.messages, request.state)
      const selection = selectCompressionRetention(
        effectiveMessages,
        request.messages,
        configuration.threshold,
        configuration.protocol
      )
      const currentWindowTokens = currentContextWindowTokens({
        messages: effectiveMessages,
        modelContextKey: configuration.modelContextKey,
        protocol: configuration.protocol,
        parameters: configuration.parameters,
        systemMessage: request.systemMessage,
        tools: [...request.tools, ...(options.responseTools ?? [])]
      })
      trigger.value = currentWindowTokens >= configuration.threshold
        ? 1
        : Number.MAX_SAFE_INTEGER
      // Native summarization only has a text token counter. Preserve the exact
      // causal suffix selected by our image/protocol-aware budget via its
      // message-count policy, while the framework still owns summary state.
      keep.value = Math.max(1, effectiveMessages.length - selection.cutoffIndex)
      return withCompressionSummaryContext(
        { activeUserRequest: selection.activeUserRequest,
          inputCapacityTokens: Math.max(1, configuration.inputCapacityTokens - 256),
          tokenCountingOptions: { protocol: configuration.protocol, parameters: configuration.parameters } },
        async (generated) => frameworkWrapModelCall(request, async (nextRequest) => {
          const event = summarizationEventFromPreparedMessages(
            nextRequest.messages,
            request.messages
          )
          if (generated.some((summary) => summary.state === 'pending') && !event) {
            throw new Error(
              'Summarization middleware did not expose its prepared summary boundary.'
            )
          }
          const pending = generated.filter((summary) => summary.state === 'pending').at(-1)
          if (event && pending?.id) event.summaryMessage.additional_kwargs = {
            ...event.summaryMessage.additional_kwargs,
            anas_summary_id: pending.id
          }
          let finalRequest = nextRequest
          let response: Awaited<ReturnType<typeof handler>>
          try {
            response = await handler(finalRequest)
          } catch (error) {
            const ruleBudget = projectRulesRequestBudget(error)
            if (ruleBudget === undefined && (!isContextOverflow(error) || !hasGeneratedCompressionSummary())) {
              throw error
            }
            const compactedMessages = compactLatestToolResults(
              nextRequest.messages,
              ruleBudget ?? configuration.inputCapacityTokens,
              nextRequest.systemMessage,
              [...nextRequest.tools, ...(options.responseTools ?? [])],
              configuration.protocol,
              configuration.parameters
            )
            if (!compactedMessages) throw ruleBudget === undefined ? new PreservedContextOverflowError() : error
            try {
              finalRequest = {
                ...nextRequest,
                messages: compactedMessages
              }
              response = await handler(finalRequest)
            } catch (retryError) {
              if (isContextOverflow(retryError)) {
                throw new PreservedContextOverflowError()
              }
              throw retryError
            }
          }
          completeGeneratedSummary(event, generated, request.messages, configuration.protocol, configuration.parameters,
            { messages: effectiveMessages, systemMessage: request.systemMessage, tools: [...request.tools, ...(options.responseTools ?? [])] },
            { messages: finalRequest.messages, systemMessage: finalRequest.systemMessage, tools: [...finalRequest.tools, ...(options.responseTools ?? [])] })
          return response
        })
      )
    }
  }
}
