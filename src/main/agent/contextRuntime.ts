import {
  type BaseMessage,
  getBufferString,
  HumanMessage,
  SystemMessage
} from '@langchain/core/messages'
import type { ServerTool, StructuredToolInterface } from '@langchain/core/tools'
import type { AgentContextStatus } from '@shared/agentTypes'
import { contextCompressionTriggerTokens, projectRuleInputBudget } from '@shared/contextWindow'
import { modelContextKey } from '@shared/modelConfig'
import type { ModelProtocol, ResolvedModelConfig } from '@shared/types'
import { createCompressionChatModel } from './modelFactory'
import { ModelSelectionError } from './modelSelection'
import { isModelRequestChangedError, ModelRequestChangedError } from './modelRequestValidation'
import { invokeModelWithRetry } from './modelRetryPolicy'
import type {
  AgentSystemPrompt,
  AgentSystemPromptSectionKind
} from './systemPrompt'
import {
  summaryPromptForLanguage,
  type SummaryOutputLanguage
} from '@shared/summaryPrompt'
import { countMessagesApproximately, modelParameterInputTokens, type LocalTokenCountingOptions } from './localTokenCounting'
import { currentContextWindowTokens, latestServerTokenUsage } from './serverTokenUsage'
import { checkpointProjectRulesText } from './projectRulesMiddleware'
import { pendingToolImageStart, projectToolImages } from './toolImageProjection'

interface SummarizationEvent {
  cutoffIndex: number
  summaryMessage: BaseMessage
}

export interface ManualContextCompression {
  summaryText: string
  modelContent: string
  cutoffIndex: number
  activatedAfterMessageIndex: number
  coveredThroughMessageId?: string
  firstPreservedMessageId?: string
  inputTokensBefore: number
  inputTokensAfter: number
  stateEvent: {
    cutoffIndex: number
    summaryMessage: HumanMessage
    filePath: null
  }
}

export interface AgentContextRuntime {
  status(values: unknown): Promise<AgentContextStatus>
  projectedStatus(values: unknown): Promise<AgentContextStatus>
  statusFromMessages(messages: BaseMessage[], model: ResolvedModelConfig, request?: AgentContextRequest): AgentContextStatus
  compress(values: unknown, signal: AbortSignal): Promise<ManualContextCompression>
}

export interface AgentContextRequest {
  systemMessage: SystemMessage
  tools: unknown[]
}

function stateMessages(values: unknown): BaseMessage[] {
  if (!values || typeof values !== 'object') return []
  const messages = (values as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return []
  return messages.filter((message): message is BaseMessage =>
    Boolean(message)
    && typeof message === 'object'
    && 'content' in message
  )
}

function summarizationEvent(values: unknown): SummarizationEvent | undefined {
  if (!values || typeof values !== 'object') return undefined
  const event = (values as { _summarizationEvent?: unknown })._summarizationEvent
  if (!event || typeof event !== 'object') return undefined
  const candidate = event as { cutoffIndex?: unknown; summaryMessage?: unknown }
  if (
    typeof candidate.cutoffIndex !== 'number'
    || !candidate.summaryMessage
    || typeof candidate.summaryMessage !== 'object'
    || !('content' in candidate.summaryMessage)
  ) return undefined
  return {
    cutoffIndex: candidate.cutoffIndex,
    summaryMessage: candidate.summaryMessage as BaseMessage
  }
}

export function effectiveContextMessages(
  messages: BaseMessage[],
  values: unknown
): BaseMessage[] {
  const event = summarizationEvent(values)
  if (!event) return messages
  return [
    event.summaryMessage,
    ...messages.slice(event.cutoffIndex)
  ]
}

function effectiveMessages(values: unknown): BaseMessage[] {
  return effectiveContextMessages(projectToolImages(stateMessages(values)), values)
}

/** Recall runs before summarization; retain its raw query with current attachment projections. */
function requestSourceMessages(rawMessages: BaseMessage[], projectedMessages: BaseMessage[]): BaseMessage[] {
  const projectedById = new Map(projectedMessages.flatMap((message) => message.id ? [[message.id, message] as const] : []))
  return rawMessages.map((message) => message.id ? projectedById.get(message.id) ?? message : message)
}

function approximateTokens(
  messages: BaseMessage[],
  tools?: unknown[],
  protocol?: ModelProtocol
): number {
  return countMessagesApproximately(
    messages,
    tools?.length ? tools as unknown as Array<Record<string, unknown>> : null,
    { protocol }
  )
}

function hasRawSummarySource(messages: BaseMessage[]): boolean {
  return messages.some((message) =>
    message.additional_kwargs?.lc_source !== 'summarization'
  )
}

function summaryInputPrompt(
  messages: BaseMessage[],
  outputLanguage: SummaryOutputLanguage,
  codingMode: boolean
): string {
  return summaryPromptForLanguage(outputLanguage, codingMode)
    .replace('{conversation}', getBufferString(messages))
}

async function messagesForSummary(
  messages: BaseMessage[],
  inputTokenLimit: number,
  outputLanguage: SummaryOutputLanguage,
  codingMode: boolean,
  tokenCountingOptions: LocalTokenCountingOptions
): Promise<BaseMessage[]> {
  const promptTokens = (items: BaseMessage[]): number => countMessagesApproximately([
    new HumanMessage(summaryInputPrompt(items, outputLanguage, codingMode))
  ], null, tokenCountingOptions)
  if (promptTokens(messages) <= inputTokenLimit) return messages
  throw new ModelSelectionError('The complete history cannot be summarized within this model’s input capacity without dropping source context. Choose a larger-context model; the current history has not been replaced.')
}

function summaryText(response: unknown): string {
  if (
    response
    && typeof response === 'object'
    && 'text' in response
    && typeof response.text === 'string'
  ) {
    return response.text.trim()
  }
  if (
    response
    && typeof response === 'object'
    && 'content' in response
    && typeof response.content === 'string'
  ) {
    return response.content.trim()
  }
  return String(response).trim()
}

export function createAgentContextRuntime(options: {
  codingMode?: boolean
  developerHttpTrace?: boolean
  resolveModel: () => Promise<ResolvedModelConfig>
  outputLanguage: SummaryOutputLanguage
  requestId?: string
  systemPrompt: (model: ResolvedModelConfig) => string | AgentSystemPrompt
  includeProjectRules?: boolean
  tools: (model: ResolvedModelConfig) => Array<StructuredToolInterface | ServerTool>
  projectHistory?: (messages: BaseMessage[]) => BaseMessage[]
  projectMessages?: (messages: BaseMessage[], model: ResolvedModelConfig) => Promise<BaseMessage[]>
  projectSystemMessage?: (systemMessage: SystemMessage, messages: BaseMessage[]) => Promise<SystemMessage>
}): AgentContextRuntime {
  const { outputLanguage, projectMessages } = options
  const projectHistory = options.projectHistory ?? ((messages: BaseMessage[]) => messages)

  function calculateStatus(
    messages: BaseMessage[],
    model: ResolvedModelConfig,
    compressionApplied = messages.some((message) =>
      message.additional_kwargs?.lc_source === 'summarization'
    ),
    request?: AgentContextRequest
  ): AgentContextStatus {
    messages = projectToolImages(messages)
    const tools = request?.tools ?? options.tools(model)
    const systemPrompt = systemPromptValue(options.systemPrompt(model))
    const baseSystemMessage = new SystemMessage(systemPrompt.text)
    const systemMessage = request?.systemMessage ?? baseSystemMessage
    const systemTokenTotal = approximateTokens([systemMessage]) + modelParameterInputTokens(model.protocol, model.parameters)
    const baseSystemTokenTotal = Math.min(systemTokenTotal, approximateTokens([baseSystemMessage]))
    const systemTokens = allocatedSystemTokens(systemPrompt, baseSystemTokenTotal)
    // Request middleware can add rules, recalled memory, or model instructions.
    // Count their real projection instead of losing it from the local estimate.
    systemTokens.system_instruction += systemTokenTotal - baseSystemTokenTotal
    const inputCapacityTokens = model.maxContextTokens - model.maxOutputTokens
    const requestedCompressionThresholdTokens = contextCompressionTriggerTokens(
      model.maxContextTokens,
      model.maxOutputTokens,
      model.contextCompressionThreshold
    )
    const compressionThresholdTokens = options.includeProjectRules
      ? Math.min(requestedCompressionThresholdTokens, projectRuleInputBudget(inputCapacityTokens))
      : requestedCompressionThresholdTokens
    const key = modelContextKey(model)
    const toolDefinitionTokens = approximateTokens([], tools)
    const messageTokens = approximateTokens(messages, undefined, model.protocol)
    return {
      runId: options.requestId,
      modelConfigId: model.id,
      modelContextKey: key,
      includeProjectRules: options.includeProjectRules === true,
      estimatedInputTokens: systemTokenTotal + toolDefinitionTokens + messageTokens,
      currentContextTokens: currentContextWindowTokens({ messages, systemMessage, tools, modelContextKey: key, protocol: model.protocol, parameters: model.parameters }),
      serverUsage: latestServerTokenUsage(messages, key),
      maxContextTokens: model.maxContextTokens,
      maxOutputTokens: model.maxOutputTokens,
      inputCapacityTokens,
      compressionEnabled: model.contextCompressionEnabled,
      compressionThreshold: model.contextCompressionThreshold,
      compressionThresholdTokens,
      compressionApplied,
      manualCompressionAvailable: hasRawSummarySource(messages),
      breakdown: {
        profileTokens: systemTokens.profile,
        systemInstructionTokens: systemTokens.system_instruction + systemTokens.project_instruction + systemTokens.coding_instruction,
        runtimeContextTokens: systemTokens.runtime_context,
        workspaceTokens: systemTokens.workspace,
        memoryTokens: systemTokens.memory,
        skillTokens: systemTokens.skills,
        toolDefinitionTokens,
        messageTokens,
        attachmentTokens: 0
      }
    }
  }

  function statusFromMessages(messages: BaseMessage[], model: ResolvedModelConfig, request?: AgentContextRequest): AgentContextStatus {
    return calculateStatus(messages, model, undefined, request)
  }

  function statusWithModel(values: unknown, model: ResolvedModelConfig): AgentContextStatus {
    return calculateStatus(
      projectHistory(effectiveMessages(values)),
      model,
      Boolean(summarizationEvent(values)),
      requestWithRules(values, model)
    )
  }

  async function status(values: unknown): Promise<AgentContextStatus> {
    return statusWithModel(values, await options.resolveModel())
  }

  function requestWithRules(values: unknown, model: ResolvedModelConfig,
    systemMessage = new SystemMessage(systemPromptValue(options.systemPrompt(model)).text)): AgentContextRequest {
    const rules = options.includeProjectRules ? checkpointProjectRulesText(values) : ''
    return { systemMessage: rules ? systemMessage.concat(`\n\n${rules}`) : systemMessage, tools: options.tools(model) }
  }

  async function projectedRequest(values: unknown, messages: BaseMessage[], model: ResolvedModelConfig): Promise<AgentContextRequest> {
    let systemMessage = new SystemMessage(systemPromptValue(options.systemPrompt(model)).text)
    if (options.projectSystemMessage) systemMessage = await options.projectSystemMessage(systemMessage, messages)
    return requestWithRules(values, model, systemMessage)
  }

  async function projectedStatusWithModel(values: unknown, model: ResolvedModelConfig): Promise<AgentContextStatus> {
    const messages = projectHistory(effectiveMessages(values))
    if (!projectMessages && !options.projectSystemMessage) return statusWithModel(values, model)
    const projectedMessages = projectMessages ? await projectMessages(messages, model) : messages
    const request = await projectedRequest(values, requestSourceMessages(stateMessages(values), projectedMessages), model)
    const projected = calculateStatus(
      projectedMessages,
      model,
      Boolean(summarizationEvent(values)),
      request
    )
    const raw = calculateStatus(
      messages,
      model,
      Boolean(summarizationEvent(values)),
      request
    )
    projected.breakdown.attachmentTokens = Math.max(
      0,
      projected.breakdown.messageTokens - raw.breakdown.messageTokens
    )
    projected.breakdown.messageTokens = raw.breakdown.messageTokens
    return projected
  }

  async function projectedStatus(values: unknown): Promise<AgentContextStatus> {
    return projectedStatusWithModel(values, await options.resolveModel())
  }

  async function compressAttempt(
    values: unknown,
    signal: AbortSignal
  ): Promise<ManualContextCompression> {
    const model = await options.resolveModel()
    const validateRequestModel = async (): Promise<void> => {
      if (JSON.stringify(model) !== JSON.stringify(await options.resolveModel())) {
        throw new ModelRequestChangedError()
      }
    }
    const summaryInputTokenLimit = Math.max(1, model.maxContextTokens - model.maxOutputTokens - 256)
    const rawMessages = stateMessages(values)
    const previousEvent = summarizationEvent(values)
    const messages = effectiveMessages(values)
    if (messages.length === 0) {
      throw new Error('There is no conversation history to compress.')
    }

    if (!hasRawSummarySource(messages)) {
      throw new Error('There is no new conversation history to compress.')
    }
    const effectiveCutoffIndex = pendingToolImageStart(messages) ?? messages.length
    if (!hasRawSummarySource(messages.slice(0, effectiveCutoffIndex))) {
      throw new Error('There is no history to compress before the pending tool images. Let the model process them first.')
    }

    // Cutoffs always address raw checkpoint messages; request-only filtering
    // must happen after selecting the source range, including for plain chats.
    const history = projectHistory(messages.slice(0, effectiveCutoffIndex))
    const projectedMessages = projectMessages
      ? await projectMessages(history, model)
      : history
    await validateRequestModel()
    const sourceMessages = await messagesForSummary(
      projectedMessages,
      summaryInputTokenLimit,
      outputLanguage,
      options.codingMode === true,
      { protocol: model.protocol, parameters: model.parameters }
    )
    if (sourceMessages.length === 0) {
      throw new Error('There is no conversation history eligible for compression.')
    }

    const prompt = summaryInputPrompt(sourceMessages, outputLanguage, options.codingMode === true)
    const response = await createCompressionChatModel(model, {
      beforeRequest: validateRequestModel,
      developerHttpTrace: options.developerHttpTrace,
      requestId: options.requestId,
      requestRole: 'manual-compression',
      signal
    }).invoke(
      [new HumanMessage(prompt)],
      {
        signal,
        tags: ['langsmith:hidden', 'langsmith:nostream', 'anas:context-summary']
      }
    )
    const visibleText = summaryText(response)
    if (!visibleText) throw new Error('Context compression returned an empty summary.')

    const modelContent = `Here is a summary of the conversation to date:\n\n${visibleText}`
    const summaryMessage = new HumanMessage({
      content: modelContent,
      additional_kwargs: { lc_source: 'summarization' }
    })
    const cutoffIndex = previousEvent
      ? previousEvent.cutoffIndex + effectiveCutoffIndex - 1
      : effectiveCutoffIndex
    const afterMessages = projectHistory(projectToolImages([summaryMessage, ...rawMessages.slice(cutoffIndex)]))
    const projectedAfterMessages = projectMessages
      ? await projectMessages(afterMessages, model)
      : afterMessages
    const afterStatus = statusFromMessages(projectedAfterMessages, model,
      await projectedRequest(values, requestSourceMessages(rawMessages, [...projectedMessages, ...projectedAfterMessages]), model))
    const inputLimit = options.includeProjectRules
      ? projectRuleInputBudget(afterStatus.inputCapacityTokens)
      : afterStatus.inputCapacityTokens
    if (afterStatus.estimatedInputTokens > inputLimit) {
      throw new ModelSelectionError('The compressed conversation and required instructions still exceed the selected model’s input capacity. Choose a larger-context model; the current history has not been replaced.')
    }

    return {
      summaryText: visibleText,
      modelContent,
      cutoffIndex,
      activatedAfterMessageIndex: rawMessages.length - 1,
      coveredThroughMessageId: rawMessages[cutoffIndex - 1]?.id,
      firstPreservedMessageId: rawMessages[cutoffIndex]?.id,
      inputTokensBefore: (await projectedStatusWithModel(values, model)).estimatedInputTokens,
      inputTokensAfter: afterStatus.estimatedInputTokens,
      stateEvent: {
        cutoffIndex,
        summaryMessage,
        filePath: null
      }
    }
  }

  function compress(values: unknown, signal: AbortSignal): Promise<ManualContextCompression> {
    return invokeModelWithRetry(() => compressAttempt(values, signal), {
      signal,
      runId: options.requestId,
      initialDelayMs: 0,
      retryWhen: isModelRequestChangedError
    })
  }

  return { status, projectedStatus, statusFromMessages, compress }
}

function systemPromptValue(
  prompt: string | AgentSystemPrompt
): AgentSystemPrompt {
  return typeof prompt === 'string'
    ? {
        text: prompt,
        sections: prompt.trim()
          ? [{ kind: 'system_instruction', content: prompt.trim() }]
          : []
      }
    : prompt
}

function allocatedSystemTokens(
  prompt: AgentSystemPrompt,
  total: number
): Record<AgentSystemPromptSectionKind, number> {
  const kinds: AgentSystemPromptSectionKind[] = [
    'profile',
    'system_instruction',
    'project_instruction',
    'coding_instruction',
    'runtime_context',
    'workspace',
    'memory',
    'skills'
  ]
  const weights = Object.fromEntries(kinds.map((kind) => [kind, 0])) as
    Record<AgentSystemPromptSectionKind, number>
  for (const section of prompt.sections) {
    weights[section.kind] += Math.max(
      1,
      approximateTokens([new SystemMessage(section.content)])
    )
  }
  const weightTotal = Object.values(weights).reduce((sum, value) => sum + value, 0)
  if (weightTotal === 0 || total === 0) return { ...weights, system_instruction: total }
  const allocations = Object.fromEntries(kinds.map((kind) => [
    kind,
    Math.floor(total * weights[kind] / weightTotal)
  ])) as Record<AgentSystemPromptSectionKind, number>
  let remainder = total - Object.values(allocations).reduce((sum, value) => sum + value, 0)
  for (const kind of [...kinds].sort((left, right) => weights[right] - weights[left])) {
    if (remainder <= 0) break
    if (weights[kind] <= 0) continue
    allocations[kind] += 1
    remainder -= 1
  }
  return allocations
}
