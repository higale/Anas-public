import { isSubagentConfigured } from '@shared/subagentSelection'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { directoryTreePages } from '../directoryTree'
import { basename, isAbsolute, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  AIMessage,
  HumanMessage,
  mapStoredMessageToChatMessage,
  type BaseMessage
} from '@langchain/core/messages'
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons'
import { ToolInputParsingException } from '@langchain/core/tools'
import type { ChatModelStreamEvent } from '@langchain/core/language_models/event'
import { ToolArgumentProgress } from './toolArgumentProgress'
import { Command, type ProtocolEvent } from '@langchain/langgraph'
import type { DeepAgentRunStream } from 'deepagents'
import type {
  AgentActivityWindowInput,
  AgentAttachmentArtifact,
  AgentAttachmentInput,
  AgentApprovalDecision,
  AgentContentBlock,
  AgentContextStatus,
  AgentInterrupt,
  AgentMessage,
  AgentMessageEditResult,
  AgentMessageRangeInput,
  AgentMemoryRecall,
  AgentMessageWindowInput,
  AgentModelRequestPreview,
  AgentModelRequestPreviewInput,
  AgentModelActivity,
  AgentQueuedInput,
  AgentQueuedInputCreate,
  AgentResumeInput,
  AgentRun,
  AgentRunDirectionInput,
  AgentRunDirectionReferenceInput,
  AgentRunSubmission,
  AgentRunCancellationResult,
  AgentRunReferenceInput,
  AgentRunActivity,
  AgentRuntimeEvent,
  AgentSubagentActivity,
  AgentSystemContextPreview,
  AgentSystemContextPreviewInput,
  AgentThreadCleanupResult,
  AgentThreadCreate,
  AgentThread,
  AgentThreadSnapshot,
  AgentToolActivity,
  AgentToolApproval,
  AgentToolCall
} from '@shared/agentTypes'
import type { AppConfigSnapshot, Project } from '@shared/types'
import { newThreadDraftModelSelection, projectDraftModelSelection } from '@shared/draftModelSelection'
import { isAgentThreadLocked } from '@shared/agentTypes'
import {
  earlierAgentMessagePageSize,
  initialAgentMessageWindow
} from '@shared/agentMessageWindow'
import {
  AgentDatabase,
  type AgentRunCheckpointState,
  type AgentRunInputIntent,
  type DurableRootActivityEvidence,
  type DurableRootModelActivity,
  type AgentRunResumeEntry,
  type AgentSubagentCallRecord,
  type StoredContextSummary
} from './agentDatabase'
import {
  archiveAgentAttachments,
  deleteArchivedAgentAttachments,
  deleteArchivedAgentThreadAttachments,
  type ArchivedAgentAttachment
} from './agentAttachmentStore'
import {
  normalizeAgentRunSubmissionId,
  type AgentMessageRegenerateExecutionInput,
  type AgentRunExecutionInput,
  type AgentRunSubmissionExecutionInput
} from './agentRunInput'
import { AgentThreadLockedError } from './agentErrors'
import {
  captureAgentModelRequest,
  captureAgentSystemPrompt,
  createAgentInstance,
  projectAgentContextStatus,
  type AgentInstance,
  type AgentInstanceContext
} from './agentFactory'
import {
  effectiveContextMessages,
  type AgentContextRuntime
} from './contextRuntime'
import { countMessagesApproximately } from './localTokenCounting'
import { latestServerTokenUsage } from './serverTokenUsage'
import { projectToolImages } from './toolImageProjection'
import { toAgentMessage, toHumanMessage } from './messageMapper'
import { deleteFileEditRecordsForRequest } from '../fileEditStore'
import { runWithCurrentAgentToolEffect } from './toolEffectScope'
import { runtimeLog } from '../runtimeLogger'
import { getTempDir } from '../config/dataDir'
import { getAppConfigSnapshot } from '../config/appConfig'
import { getProject, prepareProjectPreview } from '../projectStore'
import { DEFAULT_WORKSPACE_PROJECT_ID } from '@shared/types'
import {
  interruptActionRequests,
  projectInterruptPathPreviews
} from './approvalPathPreview'
import { manualContextCompressionInput } from './manualCompressionMiddleware'
import { isProjectRulesError } from './projectRules'
import { createAgentModelResolver, isModelSelectionError } from './modelSelection'
import { modelContextKey } from '@shared/modelConfig'
import { isModelRequestChangedError } from './modelRequestValidation'
import { ManagedCallService } from './managedCallService'
import { cleanupUnresolvedBackgroundTasks, hasUnresolvedBackgroundTasks } from './backgroundTaskCleanup'
import { backgroundCleanupUnconfirmed, backgroundTasksPendingError } from '@shared/backgroundCleanup'
import type { SubagentProcessSnapshot, SubagentToolRuntime } from './subagentTools'
import { toolProvidedSummary } from '@shared/agentActivity'
import {
  createApprovalGeneration,
  subagentApprovalGenerationFromInterrupt,
  tagSubagentApprovalResponse
} from './approvalGeneration'
import { runWithoutCurrentAgentToolEffect } from './toolEffectScope'

interface RuntimeGraph {
  streamEvents(
    input: unknown,
    config: {
      version: 'v3'
      configurable: { thread_id: string }
      durability: 'sync'
      signal: AbortSignal
      tags: string[]
    }
  ): DeepAgentRunStream | Promise<DeepAgentRunStream>
}

type AgentTerminalRuntimeEvent = Extract<
  AgentRuntimeEvent,
  { type: 'run_completed' | 'run_failed' | 'run_cancelled' }
>

const maximumConcurrentSubagents = 8
const maximumSubagentDepth = 8

export interface AgentRuntimeSubmission extends AgentRunSubmission {
  events?: AsyncIterable<AgentRuntimeEvent>
}

export interface AgentRuntimeShutdownResult {
  drained: boolean
  lingeringRunIds: string[]
  lingeringCallIds: string[]
}

interface RuntimeAgentInstance {
  agent: RuntimeGraph
  context?: AgentContextRuntime
  workspace?: { primaryFolder: string }
  dispose(): Promise<void>
}

interface DurableRunRootCheckpoint {
  id?: string
  values: unknown
  pendingWrites?: ReadonlyArray<readonly [unknown, unknown, unknown]>
}

function conversationMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter((message) =>
    message.role === 'user'
    || (message.role === 'assistant' && !message.toolCalls?.length)
  )
}

function validatedAttachmentInputs(
  value: unknown,
  label: 'Direction' | 'Queued input'
): AgentAttachmentInput[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label} attachments must be an array.`)
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error(`${label} attachment ${index + 1} is invalid.`)
    }
    const attachment = candidate as Partial<AgentAttachmentInput>
    if (typeof attachment.path !== 'string' || !attachment.path.trim() || !isAbsolute(attachment.path)) {
      throw new Error(`${label} attachment ${index + 1} requires an absolute file path.`)
    }
    if (typeof attachment.name !== 'string' || !attachment.name.trim()) {
      throw new Error(`${label} attachment ${index + 1} requires a name.`)
    }
    if (typeof attachment.mimeType !== 'string' || !attachment.mimeType.trim()) {
      throw new Error(`${label} attachment ${index + 1} requires a MIME type.`)
    }
    const size = attachment.size
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) {
      throw new Error(`${label} attachment ${index + 1} has an invalid size.`)
    }
    const kind = attachment.kind
    if (kind !== 'image' && kind !== 'text' && kind !== 'binary') {
      throw new Error(`${label} attachment ${index + 1} has an invalid kind.`)
    }
    const contextPolicy = attachment.contextPolicy
    if (contextPolicy !== 'one_turn' && contextPolicy !== 'conversation') {
      throw new Error(`${label} attachment ${index + 1} has an invalid context policy.`)
    }
    if (
      attachment.textTruncated !== undefined
      && typeof attachment.textTruncated !== 'boolean'
    ) {
      throw new Error(`${label} attachment ${index + 1} has an invalid truncation state.`)
    }
    return {
      path: attachment.path,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size,
      kind,
      ...(attachment.textTruncated === undefined
        ? {}
        : { textTruncated: attachment.textTruncated }),
      contextPolicy
    }
  })
}

function archivedAttachmentInput(archived: ArchivedAgentAttachment): AgentAttachmentInput {
  const artifact = archived.artifact
  return {
    path: artifact.path,
    name: artifact.name,
    mimeType: artifact.mimeType,
    size: artifact.size,
    kind: artifact.kind,
    textTruncated: artifact.textTruncated,
    contextPolicy: artifact.contextPolicy
  }
}

function memoryRecallId(recall: Pick<AgentMemoryRecall,
  'query' | 'promptText' | 'memoryCount' | 'agentName'
>): string {
  return createHash('sha256')
    .update(JSON.stringify([
      recall.agentName ?? '',
      recall.query,
      recall.promptText,
      recall.memoryCount
    ]))
    .digest('hex')
}

function firstPreservedActivitySequence(
  activity: AgentRunActivity,
  summary: NonNullable<AgentRunActivity['summaries']>[number],
  messages: ReturnType<typeof toAgentMessage>[]
): number | undefined {
  if (!summary.firstPreservedMessageId) return undefined
  const messageIndex = messages.findIndex((message) => message.id === summary.firstPreservedMessageId)
  if (messageIndex < 0 || messages[messageIndex].role === 'user') return undefined
  let boundaryRunId: string | undefined
  for (let index = messageIndex; index >= 0; index -= 1) {
    if (messages[index].runId) {
      boundaryRunId = messages[index].runId
      break
    }
  }
  if (boundaryRunId !== activity.runId) return undefined

  const message = messages[messageIndex]
  if (message.role === 'tool' && message.toolCallId) {
    return activity.tools.find((tool) =>
      !tool.subagentId && tool.call.id === message.toolCallId
    )?.sequence
  }
  if (message.role !== 'assistant') return undefined
  return activity.models.find((model) =>
    !model.subagentId && model.messageId === message.id
  )?.sequence
}

type AgentInstanceFactory = (
  thread: NonNullable<ReturnType<AgentDatabase['getThread']>>,
  database: AgentDatabase,
  context?: AgentInstanceContext
) => Promise<RuntimeAgentInstance>

type FileEditCleanup = (
  runId: string,
  retainedOperationIds?: readonly string[]
) => Promise<void>

type ContextStatusProjector = typeof projectAgentContextStatus

interface ActiveRun {
  threadId: string
  controller: AbortController
  cancelled: boolean
  appliedDirectionIds: Set<string>
  directions: Array<{
    id: string
    text: string
    displayText?: string
    stagedAttachments: ArchivedAgentAttachment[]
    createdAt: string
    status: 'staging' | 'queued' | 'applying' | 'removing'
  }>
  stream?: DeepAgentRunStream
  context?: AgentContextRuntime
}

interface AgentRunCancellationOutcome {
  result: AgentRunCancellationResult
  subagentTransition?: {
    call: AgentSubagentCallRecord
    activity: AgentSubagentActivity
  }
}

interface RuntimeToolCallStream {
  readonly callId: string
  readonly name: string
  readonly input: unknown
  readonly output: Promise<unknown>
  readonly status: Promise<'running' | 'finished' | 'error'>
  readonly error: Promise<string | undefined>
}

interface RuntimeMessageStream extends AsyncIterable<ChatModelStreamEvent> {
  readonly text: AsyncIterable<string>
  readonly reasoning: AsyncIterable<string>
  readonly output: PromiseLike<BaseMessage>
  readonly namespace?: readonly string[]
  readonly node?: string
}

class EventQueue implements AsyncIterable<AgentRuntimeEvent> {
  private readonly values: AgentRuntimeEvent[] = []
  private readonly waiters: Array<(result: IteratorResult<AgentRuntimeEvent>) => void> = []
  private closed = false

  push(event: AgentRuntimeEvent): boolean {
    if (this.closed) return false
    // Previews are replaceable snapshots, not history. A slow consumer only
    // needs the latest one for each model, not every 100 ms copy of a patch.
    if (event.type === 'model_tool_calls') {
      const previous = this.values.findIndex((item) => item.type === 'model_tool_calls'
        && item.runId === event.runId && item.modelId === event.modelId
        && item.subagentId === event.subagentId)
      if (previous >= 0) this.values.splice(previous, 1)
    }
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value: event, done: false })
    else this.values.push(event)
    return true
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentRuntimeEvent> {
    return {
      next: async () => {
        const value = this.values.shift()
        if (value) return { value, done: false }
        if (this.closed) return { value: undefined, done: true }
        return new Promise<IteratorResult<AgentRuntimeEvent>>((resolve) => {
          this.waiters.push(resolve)
        })
      }
    }
  }
}

interface ModelTaskState {
  started: boolean
  claimedBeforeStart: boolean
  pending: Array<{ id: string; subagentId?: string }>
}

// The task lifecycle starts before the provider emits a message lifecycle.
// Bind both projections to one activity so the timeline can render that wait
// immediately without creating a duplicate model round when output arrives.
class ModelActivityCoordinator {
  private readonly tasks = new Map<string, ModelTaskState>()

  constructor(
    private readonly startActivity: (subagentId?: string) => string,
    private readonly discardActivity: (id: string) => void
  ) {}

  startTask(key: string, subagentId?: string): void {
    const state = this.taskState(key)
    if (state.started) return
    state.started = true
    if (state.claimedBeforeStart) return
    state.pending.push({ id: this.startActivity(subagentId), subagentId })
  }

  claim(message: RuntimeMessageStream, subagentId?: string): string {
    const key = modelMessageTaskKey(message)
    if (!key) return this.startActivity(subagentId)

    const state = this.taskState(key)
    const pendingIndex = state.pending.findIndex((item) => item.subagentId === subagentId)
    if (pendingIndex >= 0) {
      return state.pending.splice(pendingIndex, 1)[0].id
    }
    if (!state.started) state.claimedBeforeStart = true
    return this.startActivity(subagentId)
  }

  discardUnclaimed(): void {
    for (const state of this.tasks.values()) {
      for (const activity of state.pending.splice(0)) {
        this.discardActivity(activity.id)
      }
    }
    this.tasks.clear()
  }

  private taskState(key: string): ModelTaskState {
    let state = this.tasks.get(key)
    if (!state) {
      state = { started: false, claimedBeforeStart: false, pending: [] }
      this.tasks.set(key, state)
    }
    return state
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function uniqueInterrupts<T extends { id: string; value: unknown }>(interrupts: T[]): T[] {
  // LangGraph v3 emits an interrupted values snapshot once at the child
  // namespace and again when that state bubbles to the root namespace. Its
  // run-level projection currently accumulates both occurrences. The stable
  // interrupt ID is the resume protocol's stable identifier, so expose logical
  // interrupts rather than namespace occurrences to the product.
  const unique = new Map<string, T>()
  for (const interrupt of interrupts) {
    if (!interrupt.id) throw new Error('LangGraph returned an interrupt without an ID.')
    const existing = unique.get(interrupt.id)
    if (existing && !isDeepStrictEqual(existing.value, interrupt.value)) {
      throw new Error(`LangGraph returned conflicting payloads for interrupt ${interrupt.id}.`)
    }
    if (!existing) unique.set(interrupt.id, interrupt)
  }
  return [...unique.values()]
}

function currentDurableTaskInterrupts(
  pendingWrites: ReadonlyArray<readonly [unknown, unknown, unknown]> | undefined
): Array<{ id: string; value: unknown; taskId: string }> {
  const tasks = new Map<string, Array<readonly [unknown, unknown]>>()
  for (const [taskId, channel, value] of pendingWrites ?? []) {
    if (typeof taskId !== 'string' || !taskId) continue
    tasks.set(taskId, [...(tasks.get(taskId) ?? []), [channel, value]])
  }
  return [...tasks].flatMap(([taskId, writes]) => {
    // Pending writes can retain an __interrupt__ row after the same
    // task writes a normal result. It represents a current unresolved
    // outcome only while this task has no normal/error/no-writes result.
    if (writes.some(([channel]) => channel !== '__interrupt__' && channel !== '__resume__')) {
      return []
    }
    return writes.flatMap(([channel, value]) => {
      if (channel !== '__interrupt__') return []
      const candidates = Array.isArray(value) ? value : [value]
      return candidates.flatMap((candidate) => {
      if (!candidate || typeof candidate !== 'object') return []
      const interrupt = candidate as { id?: unknown; value?: unknown }
      return typeof interrupt.id === 'string' && interrupt.id
          ? [{ id: interrupt.id, value: interrupt.value, taskId }]
        : []
      })
    })
  })
}

function durablePendingInterrupts(
  pendingWrites: ReadonlyArray<readonly [unknown, unknown, unknown]> | undefined
): Array<{ id: string; value: unknown }> {
  const interrupts = currentDurableTaskInterrupts(pendingWrites).map(({ id, value }) => ({
    id,
    value
  }))
  return uniqueInterrupts(interrupts)
}

function durableApprovalInterrupts(
  runId: string | undefined,
  checkpointId: string | undefined,
  pendingWrites: ReadonlyArray<readonly [unknown, unknown, unknown]> | undefined
): AgentInterrupt[] {
  const interrupts = durablePendingInterrupts(pendingWrites)
  if (interrupts.length === 0) return []
  // A checkpoint without an owning run cannot provide a generation that the
  // resume path can validate, so never expose it as an actionable approval.
  if (!runId) return []
  if (!checkpointId) {
    throw new Error(`Run ${runId} has durable interrupts without a root checkpoint ID.`)
  }
  const approvalGeneration = createApprovalGeneration({
    runId,
    checkpointId,
    interrupts: interrupts.map((interrupt) => ({
      interruptId: interrupt.id,
      resumeCount: durableInterruptResumeCount(pendingWrites, interrupt.id),
      value: interrupt.value
    }))
  })
  return interrupts.map((interrupt) => ({ ...interrupt, approvalGeneration }))
}

function durableResumeHistoryLength(value: unknown): number {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('LangGraph returned an invalid durable interrupt resume history.')
  }
  const [history, ...current] = value
  if (!Array.isArray(history)) return value.length
  return durableResumeHistoryLength(history) + current.length
}

function durableInterruptResumeCount(
  pendingWrites: ReadonlyArray<readonly [unknown, unknown, unknown]> | undefined,
  interruptId: string
): number {
  // LangGraph writes every Command resume to a synthetic task whose ID is the
  // interrupt ID. That row is present at the root even when the interrupt was
  // raised by a nested subgraph, unlike the carrier task's local __resume__ row.
  const histories = (pendingWrites ?? []).flatMap(([taskId, channel, value]) => (
    taskId === interruptId && channel === '__resume__' ? [value] : []
  ))
  if (histories.length === 0) return 0
  if (histories.length !== 1) {
    throw new Error(`LangGraph returned conflicting resume histories for interrupt ${interruptId}.`)
  }
  return durableResumeHistoryLength(histories[0])
}

function durableResumeEntries(
  runId: string,
  checkpointId: string,
  pendingWrites: ReadonlyArray<readonly [unknown, unknown, unknown]> | undefined,
  requested: ReadonlyArray<{
    interruptId: string
    response: Record<string, unknown>
    expectedGeneration: string
  }>
): AgentRunResumeEntry[] {
  // Nested graph interrupts may also be persisted at the root. Match logical
  // approvals by native interrupt ID; uniqueInterrupts rejects payload conflicts.
  const pending = durableApprovalInterrupts(runId, checkpointId, pendingWrites)
  const pendingById = new Map(pending.map((interrupt) => [interrupt.id, interrupt]))
  const interruptIds = new Set(pendingById.keys())
  const responseIds = requested.map((entry) => entry.interruptId)
  if (
    responseIds.length !== interruptIds.size
    || responseIds.some((interruptId) => !interruptIds.has(interruptId))
  ) {
    throw new Error('Resume responses must match the current durable root interrupts exactly.')
  }
  return requested.map((entry) => {
    const interrupt = pendingById.get(entry.interruptId)
    if (entry.expectedGeneration !== interrupt?.approvalGeneration) {
      throw new Error(
        `Resume response for interrupt ${entry.interruptId} does not match its current approval generation.`
      )
    }
    return {
      interruptId: entry.interruptId,
      response: tagSubagentApprovalResponse(
        entry.response,
        subagentApprovalGenerationFromInterrupt(interrupt?.value)
      )
    }
  })
}

function resumeIntentFromEntries(entries: readonly AgentRunResumeEntry[]): Record<string, unknown> {
  return Object.fromEntries(entries.map((entry) => [entry.interruptId, entry.response]))
}

async function snapshotPrimaryFolder(
  thread: NonNullable<ReturnType<AgentDatabase['getThread']>>
): Promise<string | undefined> {
  try {
    const project = await getProject(thread.projectId)
    if (project.kind === 'workspace') return project.sourceFolders[0]
    const defaultWorkspace = await getProject(DEFAULT_WORKSPACE_PROJECT_ID)
    if (defaultWorkspace.kind !== 'workspace') throw new Error('The default workspace project is invalid.')
    return defaultWorkspace.sourceFolders[0]
  } catch (error) {
    runtimeLog('warn', 'agent', 'Failed to resolve the workspace for approval path previews.', {
      threadId: thread.id,
      projectId: thread.projectId,
      error: errorMessage(error)
    })
    return undefined
  }
}

function stateMessages(values: unknown): BaseMessage[] {
  if (!values || typeof values !== 'object') return []
  const messages = (values as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return []
  return messages.filter((message): message is BaseMessage =>
    Boolean(message)
    && typeof message === 'object'
    && 'type' in message
    && 'content' in message
  )
}

export function snapshotContextStatus(values: unknown): AgentThreadSnapshot['contextStatus'] {
  const rawMessages = stateMessages(values)
  const messages = effectiveContextMessages(rawMessages, values)
  const messageTokens = countMessagesApproximately(messages)
  const compressionApplied = messages !== rawMessages
  return {
    // Snapshot projection deliberately has no model dependency. The renderer
    // replaces these capacity fields from the currently selected model.
    modelConfigId: '',
    estimatedInputTokens: messageTokens,
    currentContextTokens: countMessagesApproximately(projectToolImages(messages)),
    serverUsage: latestServerTokenUsage(messages),
    maxContextTokens: 0,
    maxOutputTokens: 0,
    inputCapacityTokens: 0,
    compressionEnabled: false,
    compressionThreshold: 0,
    compressionThresholdTokens: 0,
    compressionApplied,
    manualCompressionAvailable: messages.some((message) =>
      message.additional_kwargs?.lc_source !== 'summarization'
    ),
    breakdown: {
      profileTokens: 0,
      systemInstructionTokens: 0,
      runtimeContextTokens: 0,
      workspaceTokens: 0,
      memoryTokens: 0,
      skillTokens: 0,
      toolDefinitionTokens: 0,
      messageTokens,
      attachmentTokens: 0
    }
  }
}

function replaceHumanMessageText(message: BaseMessage, text: string): HumanMessage {
  if (!HumanMessage.isInstance(message)) throw new Error('Only user messages can be resent.')
  if (typeof message.content === 'string') {
    return new HumanMessage({
      id: message.id,
      name: message.name,
      content: text,
      additional_kwargs: { ...message.additional_kwargs },
      response_metadata: { ...message.response_metadata }
    })
  }

  let replaced = false
  const content = message.content.map((block) => {
    if (
      replaced
      || !block
      || typeof block !== 'object'
      || !('type' in block)
      || !('text' in block)
      || (block.type !== 'text' && block.type !== 'text-plain')
      || typeof block.text !== 'string'
    ) return block
    replaced = true
    return { ...block, text }
  })
  if (!replaced) content.unshift({ type: 'text', text })
  return new HumanMessage({
    id: message.id,
    name: message.name,
    content,
    additional_kwargs: { ...message.additional_kwargs },
    response_metadata: { ...message.response_metadata }
  })
}

interface InterruptedToolActivity {
  call: AgentToolCall
  approval: AgentToolApproval
}

function modelToolCalls(message: BaseMessage): AgentToolCall[] {
  if (!AIMessage.isInstance(message) || !message.tool_calls?.length) return []
  return message.tool_calls.flatMap((call) => {
    if (typeof call.id !== 'string' || !call.id) {
      runtimeLog('warn', 'agent', 'Interrupted tool call is missing its framework ID.', {
        messageId: message.id,
        toolName: call.name
      })
      return []
    }
    return [{ id: call.id, name: call.name, args: call.args }]
  })
}

function latestModelToolCalls(values: unknown): AgentToolCall[] {
  const message = [...stateMessages(values)].reverse().find((candidate) =>
    AIMessage.isInstance(candidate) && Boolean(candidate.tool_calls?.length)
  )
  return message ? modelToolCalls(message) : []
}

function interruptedToolActivities(
  values: unknown,
  interrupts: Array<Pick<AgentInterrupt, 'id' | 'value'>>
): InterruptedToolActivity[] {
  const calls = latestModelToolCalls(values)
  if (calls.length === 0) return []
  const claimed = new Set<string>()
  return interrupts.flatMap((interrupt) => {
    const actions = interruptActionRequests(interrupt)
    if (actions.length === 0) return []
    const matched: InterruptedToolActivity[] = []
    let callIndex = 0
    for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
      const action = actions[actionIndex]
      let match: AgentToolCall | undefined
      while (callIndex < calls.length) {
        const candidate = calls[callIndex]
        callIndex += 1
        if (
          !claimed.has(candidate.id)
          && candidate.name === action.name
          && isDeepStrictEqual(candidate.args, action.args)
        ) {
          match = candidate
          break
        }
      }
      if (!match) return []
      matched.push({
        call: match,
        approval: {
          status: 'pending_approval',
          interruptId: interrupt.id,
          actionIndex
        }
      })
    }
    for (const item of matched) claimed.add(item.call.id)
    return matched
  })
}

interface ScopedInterruptedToolActivity extends InterruptedToolActivity {
  subagentId?: string
}

const humanReviewTaskName = 'HumanInTheLoopMiddleware.after_model'

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function namespaceKey(namespace: readonly string[]): string {
  return namespace.join('\u0000')
}

function taskKey(namespace: readonly string[], taskId: string): string {
  return `${namespaceKey(namespace)}\u0000${taskId}`
}

const modelRequestTaskName = 'model_request'

function modelMessageTaskKey(message: RuntimeMessageStream): string | undefined {
  const namespace = message.namespace
  if (!namespace?.length || message.node !== modelRequestTaskName) return undefined
  const segment = namespace.at(-1)
  const prefix = `${modelRequestTaskName}:`
  if (!segment?.startsWith(prefix)) return undefined
  const taskId = segment.slice(prefix.length)
  return taskId ? taskKey(namespace.slice(0, -1), taskId) : undefined
}

async function consumeProtocolActivities(
  events: AsyncIterable<ProtocolEvent>,
  callbacks: {
    onInterrupted: (activity: ScopedInterruptedToolActivity) => void
    onModelTaskStarted: (key: string, subagentId?: string) => void
    onRootCheckpoint?: (checkpointId: string, values: unknown) => void | Promise<void>
  }
): Promise<void> {
  const activeToolCallByNamespace = new Map<string, string>()
  const subagentByNamespace = new Map<string, string>()
  const taskInputs = new Map<string, unknown>()
  const seen = new Set<string>()
  let pendingRootCheckpointId: string | undefined

  for await (const event of events) {
    const namespace = [...event.params.namespace]
    const namespaceId = namespaceKey(namespace)
    const data = recordValue(event.params.data)

    if (namespace.length === 0 && event.method === 'checkpoints') {
      pendingRootCheckpointId = typeof data?.id === 'string' ? data.id : undefined
      continue
    }
    if (
      namespace.length === 0
      && event.method === 'values'
      && pendingRootCheckpointId
    ) {
      const checkpointId = pendingRootCheckpointId
      pendingRootCheckpointId = undefined
      await callbacks.onRootCheckpoint?.(checkpointId, event.params.data)
    }
    if (!data) continue

    if (
      event.method === 'tools'
      && data.event === 'tool-started'
      && typeof data.tool_call_id === 'string'
      && data.tool_call_id
    ) {
      activeToolCallByNamespace.set(namespaceId, data.tool_call_id)
      continue
    }
    if (event.method !== 'tasks' || typeof data.id !== 'string') continue

    const key = taskKey(namespace, data.id)
    if ('input' in data) {
      const metadata = recordValue(data.metadata)
      if (
        namespace.length > 0
        && !subagentByNamespace.has(namespaceId)
        && typeof metadata?.lc_agent_name === 'string'
      ) {
        const cause = activeToolCallByNamespace.get(namespaceId)
        if (cause) subagentByNamespace.set(namespaceId, cause)
      }
      if (data.name === modelRequestTaskName) {
        const subagentId = namespace.length > 0
          ? subagentByNamespace.get(namespaceId)
          : undefined
        if (namespace.length === 0 || subagentId) {
          callbacks.onModelTaskStarted(key, subagentId)
        } else {
          runtimeLog('warn', 'agent', 'Could not resolve the model task subagent target.', {
            namespace,
            taskId: data.id
          })
        }
      }
      // Ancestor `tools` tasks bubble the same interrupt with parent messages.
      // Only the HITL source task owns the action-to-call association.
      if (data.name === humanReviewTaskName) taskInputs.set(key, data.input)
      continue
    }
    if (!('result' in data) || data.name !== humanReviewTaskName) continue
    const input = taskInputs.get(key)
    taskInputs.delete(key)
    if (!input || !Array.isArray(data.interrupts) || data.interrupts.length === 0) continue
    const subagentId = namespace.length > 0
      ? subagentByNamespace.get(namespaceId)
      : undefined
    if (namespace.length > 0 && !subagentId) {
      runtimeLog('warn', 'agent', 'Could not resolve the interrupted subagent target.', {
        namespace,
        taskId: data.id
      })
      continue
    }
    const interrupts = data.interrupts.flatMap((interrupt) => {
      const item = recordValue(interrupt)
      return typeof item?.id === 'string'
        ? [{ id: item.id, value: item.value }]
        : []
    })
    for (const interrupted of interruptedToolActivities(input, interrupts)) {
      const actionKey = [
        interrupted.approval.interruptId,
        interrupted.approval.actionIndex
      ].join('\u0000')
      if (seen.has(actionKey)) continue
      seen.add(actionKey)
      callbacks.onInterrupted({ ...interrupted, subagentId })
    }
  }
}

function summarizationEvent(values: unknown): {
  cutoffIndex: number
  summaryMessage: BaseMessage
  summaryId?: string
} | undefined {
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
    summaryMessage: candidate.summaryMessage as BaseMessage,
    summaryId: typeof (candidate.summaryMessage as BaseMessage)
      .additional_kwargs?.anas_summary_id === 'string'
      ? (candidate.summaryMessage as BaseMessage).additional_kwargs.anas_summary_id as string
      : undefined
  }
}

function stateTodos(values: unknown): AgentThreadSnapshot['todos'] {
  if (!values || typeof values !== 'object') return []
  const todos = (values as { todos?: unknown }).todos
  if (!Array.isArray(todos)) return []
  return todos.flatMap((todo) => {
    if (!todo || typeof todo !== 'object') return []
    const item = todo as { content?: unknown; status?: unknown }
    if (typeof item.content !== 'string') return []
    if (item.status !== 'pending' && item.status !== 'in_progress' && item.status !== 'completed') return []
    return [{ content: item.content, status: item.status }]
  })
}

function toolInputTodos(name: string, input: unknown): AgentThreadSnapshot['todos'] | undefined {
  if (name !== 'write_todos' || !input || typeof input !== 'object') return undefined
  const candidate = (input as { todos?: unknown }).todos
  if (!Array.isArray(candidate)) return undefined
  const todos = stateTodos({ todos: candidate })
  return todos.length === candidate.length ? todos : undefined
}

function traceText(content: AgentContentBlock[], type: 'text' | 'reasoning'): string {
  return content.flatMap((block) =>
    block.type === type && 'text' in block ? [block.text] : []
  ).join('')
}

function traceReasoningSummary(content: AgentContentBlock[]): string | undefined {
  const summaries = content.flatMap((block) =>
    block.type === 'reasoning' && block.summary ? [block.summary] : []
  )
  const text = [...new Set(summaries)].join('\n').trim()
  return text || undefined
}

function attachReasoningSummaries(
  activities: AgentRunActivity[],
  messages: AgentMessage[]
): AgentRunActivity[] {
  const summaries = new Map(messages.flatMap((message) => {
    const summary = traceReasoningSummary(message.content)
    return summary ? [[message.id, summary] as const] : []
  }))
  if (summaries.size === 0) return activities
  return activities.map((activity) => ({
    ...activity,
    models: activity.models.map((model) => {
      const summary = model.messageId ? summaries.get(model.messageId) : undefined
      return summary ? { ...model, reasoningSummary: summary } : model
    })
  }))
}

function toolMessageOutput(content: AgentContentBlock[]): unknown {
  if (content.length !== 1) return content
  const [block] = content
  if (block.type === 'text') return block.text
  if (block.type === 'json') return block.value
  return block
}

interface ToolMessageIndex {
  results: Map<string, {
    call: AgentToolCall
    message: AgentMessage
    ownerMessageId: string
    runId?: string
  }>
}

function indexToolMessages(
  messages: AgentMessage[],
  fallbackRunId?: string
): ToolMessageIndex {
  const unresolved = new Map<string, {
    call: AgentToolCall
    ownerMessageId: string
    runId?: string
  }>()
  const results: ToolMessageIndex['results'] = new Map()
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        // Reused IDs start a new ownership interval. A result from an older
        // interval must never be discoverable after this call appears.
        results.delete(call.id)
        unresolved.set(call.id, {
          call,
          ownerMessageId: message.id,
          runId: message.runId ?? fallbackRunId
        })
      }
      continue
    }
    if (message.role !== 'tool' || !message.toolCallId) continue
    const owner = unresolved.get(message.toolCallId)
    if (!owner) continue
    unresolved.delete(message.toolCallId)
    results.set(message.toolCallId, {
      call: owner.call,
      message,
      ownerMessageId: owner.ownerMessageId,
      runId: owner.runId
    })
  }
  return { results }
}

function rootSubagentName(call: AgentToolCall): string | undefined {
  if (call.name !== 'start_subagent' || !call.args || typeof call.args !== 'object') return undefined
  const agent = (call.args as { agent?: unknown }).agent
  return typeof agent === 'string' && agent ? agent : undefined
}

function startedSubagentId(output: unknown): string | undefined {
  let value = output
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      return undefined
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const id = (value as Record<string, unknown>).subagent_id
  return typeof id === 'string' && id ? id : undefined
}

function durableRootActivityEvidence(
  values: unknown,
  runId: string
): DurableRootActivityEvidence {
  const messages = stateMessages(values).map((message, index) =>
    toAgentMessage(message, `${runId}:checkpoint:${index}`)
  )
  const models: DurableRootModelActivity[] = messages.flatMap((message) =>
    message.role === 'assistant' && message.runId === runId
      ? [{
          messageId: message.id,
          text: traceText(message.content, 'text'),
          reasoning: traceText(message.content, 'reasoning'),
          toolCalls: message.toolCalls ?? []
        }]
      : []
  )
  const tools = [...indexToolMessages(messages).results.values()].flatMap((resolved) =>
    resolved.runId === runId
      ? (() => {
          const output = toolMessageOutput(resolved.message.content)
          return [{
            call: resolved.call,
            output,
            subagentName: rootSubagentName(resolved.call),
            subagentId: startedSubagentId(output)
          }]
        })()
      : []
  )
  return { models, tools }
}

function normalizeRootActivityProjection(
  activity: AgentRunActivity,
  evidence: DurableRootActivityEvidence,
  retainUncommitted: boolean,
  canonicalChildren: ReturnType<AgentDatabase['canonicalSubagentActivityEvidence']>
): AgentRunActivity {
  const durableModels = new Map(evidence.models.map((model) => [model.messageId, model]))
  const durableTools = new Map(evidence.tools.map((tool) => [tool.call.id, tool]))
  const durableCalls = new Map(evidence.models.flatMap((model) => model.toolCalls)
    .map((call) => [call.id, call]))
  // Native subgraph projections follow committed root tool results.
  // Managed child calls additionally provide their own relationship and
  // message evidence below, independently of the root superstep.
  const allowedSubagents = new Set(evidence.tools.flatMap((tool) =>
    tool.subagentId ? [tool.subagentId] : []
  ))
  let discoveredSubagent = true
  while (discoveredSubagent) {
    discoveredSubagent = false
    for (const subagent of activity.subagents) {
      if (
        subagent.parentSubagentId
        && allowedSubagents.has(subagent.parentSubagentId)
        && !allowedSubagents.has(subagent.id)
      ) {
        allowedSubagents.add(subagent.id)
        discoveredSubagent = true
      }
    }
  }
  const claimedModels = new Set<string>()
  const models = activity.models.flatMap((model) => {
    if (model.subagentId) {
      if (canonicalChildren.subagentIds.has(model.subagentId)) {
        return canonicalChildren.modelIds.has(model.id) || retainUncommitted ? [model] : []
      }
      return allowedSubagents.has(model.subagentId) ? [model] : []
    }
    const durable = model.messageId ? durableModels.get(model.messageId) : undefined
    if (durable && !claimedModels.has(durable.messageId)) {
      claimedModels.add(durable.messageId)
      return [{
        ...model,
        messageId: durable.messageId,
        status: 'completed' as const,
        text: durable.text,
        reasoning: durable.reasoning,
        toolCallIds: durable.toolCalls.map((call) => call.id)
      }]
    }
    if (!retainUncommitted) return []
    return [{
      ...model,
      messageId: undefined,
      status: 'running' as const,
      toolCallIds: [],
      completedAt: undefined
    }]
  })
  const tools = activity.tools.flatMap((tool) => {
    if (tool.subagentId) {
      if (canonicalChildren.subagentIds.has(tool.subagentId)) {
        const durable = canonicalChildren.tools.get(JSON.stringify([tool.subagentId, tool.call.id]))
        if (durable?.completed || retainUncommitted) return [tool]
        return durable ? [{ ...tool, status: 'running' as const, output: undefined, completedAt: undefined }] : []
      }
      return allowedSubagents.has(tool.subagentId) ? [tool] : []
    }
    const durable = durableTools.get(tool.call.id)
    const durableCall = durableCalls.get(tool.call.id)
    const call = durableCall ?? tool.call
    if (durable) {
      return [{
        ...tool,
        call: durable.call,
        status: 'completed' as const,
        approval: undefined,
        output: durable.output
      }]
    }
    if (!durableCall && !retainUncommitted) return []
    return [{
      ...tool,
      call,
      status: 'running' as const,
      approval: activity.status === 'interrupted' ? tool.approval : undefined,
      output: undefined,
      completedAt: undefined
    }]
  })
  const subagents = activity.subagents.flatMap((subagent) => {
    if (canonicalChildren.subagentIds.has(subagent.id)) {
      return [subagent]
    }
    if (subagent.parentSubagentId) {
      return allowedSubagents.has(subagent.id) ? [subagent] : []
    }
    const durable = evidence.tools.find((tool) => tool.subagentId === subagent.id)
    if (!durable && !retainUncommitted) return []
    return [subagent]
  })

  return { ...activity, models, tools, subagents }
}

function resumeDecision(decision: AgentApprovalDecision): Record<string, unknown> {
  switch (decision.type) {
    case 'approve':
      return { type: 'approve' }
    case 'reject':
      return { type: 'reject', message: decision.message }
  }
}

function requestedResumeEntries(input: AgentResumeInput): Array<{
  interruptId: string
  response: Record<string, unknown>
  expectedGeneration: string
}> {
  const interruptIds = new Set<string>()
  const entries = []
  for (const response of input.responses) {
    if (!response.interruptId) throw new Error('A resume response is missing its interrupt ID.')
    if (interruptIds.has(response.interruptId)) {
      throw new Error(`Interrupt ${response.interruptId} has more than one resume response.`)
    }
    if (!response.expectedGeneration) {
      throw new Error(`Resume response for interrupt ${response.interruptId} is missing its approval generation.`)
    }
    interruptIds.add(response.interruptId)
    entries.push({
      interruptId: response.interruptId,
      response: { decisions: response.decisions.map(resumeDecision) },
      expectedGeneration: response.expectedGeneration
    })
  }
  if (entries.length === 0) {
    throw new Error('At least one interrupt response is required to resume a run.')
  }
  return entries
}

function graphInputForRunIntent(
  run: { id: string; createdAt: string },
  intent: AgentRunInputIntent
): { input: unknown; userMessage?: HumanMessage } {
  if (intent.kind === 'manual_compression') {
    return { input: manualContextCompressionInput(run.id) }
  }
  if (intent.kind === 'regeneration') {
    const userMessage = mapStoredMessageToChatMessage(intent.message)
    if (!HumanMessage.isInstance(userMessage)) {
      throw new Error('A regeneration input must contain a user message.')
    }
    return { input: { messages: [userMessage], todos: [] }, userMessage }
  }
  const userMessage = toHumanMessage(
    intent.text,
    intent.content,
    intent.displayText,
    {
      id: `${run.id}:input`,
      runId: run.id,
      createdAt: run.createdAt
    }
  )
  if (intent.codeReview) userMessage.additional_kwargs.anas_code_review_scope = intent.codeReview
  return {
    input: { messages: [userMessage], todos: [] },
    userMessage
  }
}

function submissionUserMessage(
  run: AgentRun,
  intent: AgentRunInputIntent,
  attachments: AgentAttachmentArtifact[]
): AgentMessage {
  const message = graphInputForRunIntent(run, intent).userMessage
  if (!message) throw new Error(`Run ${run.id} has no durable user input.`)
  const mapped = toAgentMessage(message, `${run.id}:input`)
  return attachments.length > 0 ? { ...mapped, attachments } : mapped
}

function runCheckpointFingerprint(state: AgentRunCheckpointState | undefined): string {
  return JSON.stringify(state ?? null)
}

async function resolveAgentPreviewTarget(
  input: AgentSystemContextPreviewInput,
  synthetic: { id: string; title: string }
): Promise<{ config: AppConfigSnapshot; thread: AgentThread; project: Project }> {
  const persisted = await getAppConfigSnapshot()
  const project = await prepareProjectPreview(input.project, input.projectId)
  const selection = newThreadDraftModelSelection({
    providers: persisted.providers,
    defaultModel: persisted.defaultModel,
    // A preview always needs a model, even when new chats prompt the user.
    settings: { newThreadModelSelection: 'default' }
  }, undefined, null, projectDraftModelSelection(persisted.providers, project))
  if (!selection.modelConfigId) throw new Error('No selectable model is configured for this preview.')
  const now = new Date().toISOString()
  const thread: AgentThread = {
    id: synthetic.id,
    title: synthetic.title,
    projectId: project.id,
    modelConfigId: selection.modelConfigId,
    modelParameterPresetId: selection.modelParameterPresetId ?? undefined,
    pinned: false,
    accessMode: 'read_only_allowed',
    status: 'idle',
    userTurnCount: 0,
    createdAt: now,
    updatedAt: now
  }
  return {
    config: { ...persisted, settings: input.settings },
    thread,
    project
  }
}

export class AgentRuntime {
  private readonly activeRuns = new Map<string, ActiveRun>()
  private readonly publishedContextSummaries = new Map<string, Set<string>>()
  private readonly publishedToolCompletions = new Map<string, Set<string>>()
  private readonly toolCallProgress = new Map<string, Map<string, Extract<AgentRuntimeEvent, { type: 'model_tool_calls' }>>>()
  private readonly runStopWaiters = new Map<string, Set<() => void>>()
  private readonly mutatingThreads = new Set<string>()
  private readonly resumingThreads = new Set<string>()
  private readonly tasks = new Set<Promise<void>>()
  private readonly startupCleanupTask: Promise<void>
  private readonly managedCalls: ManagedCallService
  private readonly subagentWaiters = new Map<string, Set<() => void>>()
  private readonly subagentForwardTasks = new Map<string, Set<Promise<void>>>()
  private readonly runBackgroundSettlementTasks = new Map<string, Promise<void>>()
  private readonly fileEditCleanupTasks = new Map<string, Promise<void>>()
  private shuttingDown = false
  private shutdownDrain?: Promise<void>

  constructor(
    private readonly database: AgentDatabase,
    private readonly instanceFactory: AgentInstanceFactory = async (thread, db, context) => {
      const instance: AgentInstance = await createAgentInstance(thread, db, context)
      return instance as unknown as RuntimeAgentInstance
    },
    private readonly temporaryRoot = getTempDir(),
    private readonly cleanupFileEdits: FileEditCleanup = deleteFileEditRecordsForRequest,
    private readonly publishDetachedEvent?: (
      event: AgentRuntimeEvent
    ) => void | Promise<void>,
    private readonly projectContextStatus: ContextStatusProjector = projectAgentContextStatus
  ) {
    this.managedCalls = new ManagedCallService(database)
    const attachmentCleanupTask = this.drainPendingAttachmentCleanup()
    const subagentResultRepairTask = this.repairCompletedSubagentResults()
    const startupCleanupTasks = [
      this.drainPendingFileEditCleanup(),
      subagentResultRepairTask,
      this.cleanupOrphanedSubagentThreads(),
      attachmentCleanupTask
    ]
    for (const task of startupCleanupTasks) this.track(task)
    this.startupCleanupTask = Promise.allSettled([
      attachmentCleanupTask,
      subagentResultRepairTask
    ]).then(() => undefined)
  }

  startRun(input: AgentRunExecutionInput): AsyncIterable<AgentRuntimeEvent> {
    return this.startPreparedRun(input, []).events
  }

  async startRunWithAttachments(
    input: AgentRunExecutionInput
  ): Promise<AsyncIterable<AgentRuntimeEvent>> {
    const messageId = `${input.runId}:input`
    const archived = await archiveAgentAttachments(
      input.attachments ?? [],
      {
        threadId: input.threadId,
        runId: input.runId,
        messageId
      },
      this.database.attachmentRoot
    )
    try {
      return this.startPreparedRun(input, archived).events
    } catch (reason) {
      await deleteArchivedAgentAttachments(archived.map((item) => item.artifact), this.database.attachmentRoot)
      throw reason
    }
  }

  private startPreparedRun(
    input: AgentRunExecutionInput,
    attachments: ArchivedAgentAttachment[],
    options?: {
      newThread?: AgentThreadCreate
      submissionId?: string
    }
  ): AgentRuntimeSubmission & { events: AsyncIterable<AgentRuntimeEvent> } {
    this.assertAcceptingRuns()
    const inputIntent: AgentRunInputIntent = {
      kind: 'user',
      text: input.text,
      ...(input.codeReview ? { codeReview: input.codeReview } : {}),
      ...(input.displayText === undefined ? {} : { displayText: input.displayText }),
      ...(input.content === undefined ? {} : { content: input.content })
    }
    let thread: AgentThread
    let run: AgentRun
    if (options?.newThread) {
      if (!options.submissionId) throw new Error('A new thread run requires a submission ID.')
      const created = this.database.createThreadAndRun(
        input.threadId,
        options.newThread,
        input.runId,
        attachments,
        inputIntent,
        options.submissionId
      )
      thread = created.thread
      run = created.run
    } else {
      this.assertThreadAvailable(input.threadId, 'start another run')
      run = this.database.createRun(
        input.threadId,
        input.runId,
        'agent',
        attachments,
        inputIntent,
        options?.submissionId
      )
      const existingThread = this.database.getThread(input.threadId)
      if (!existingThread) throw new Error(`Thread ${input.threadId} was not found.`)
      thread = existingThread
    }
    const graphInput = graphInputForRunIntent(run, inputIntent)
    const userMessage = submissionUserMessage(
      run,
      inputIntent,
      attachments.map(({ artifact }) => artifact)
    )
    const queue = new EventQueue()
    const active: ActiveRun = {
      threadId: input.threadId,
      controller: new AbortController(),
      cancelled: false,
      appliedDirectionIds: new Set(),
      directions: []
    }
    this.activeRuns.set(run.id, active)
    queue.push({ type: 'run_started', run, newUserTurn: true, userMessage })
    this.launchExecution(
      run.id,
      graphInput.input,
      queue,
      active
    )
    return { thread, run, userMessage, events: queue }
  }

  getRunSubmission(submissionId: string): AgentRunSubmission | undefined {
    const run = this.database.getRunBySubmissionId(submissionId)
    if (!run) return undefined
    const thread = this.database.getThread(run.threadId)
    if (!thread) throw new Error(`Thread ${run.threadId} was not found.`)
    const inputIntent = this.database.getRunInputIntent(run.id)
    return {
      thread,
      run,
      ...(inputIntent
        ? {
            userMessage: submissionUserMessage(
              run,
              inputIntent,
              this.database.listAttachmentsForMessage(thread.id, `${run.id}:input`)
            )
          }
        : {})
    }
  }

  async submitRunWithAttachments(
    input: AgentRunSubmissionExecutionInput
  ): Promise<AgentRuntimeSubmission> {
    const existing = this.getRunSubmission(input.submissionId)
    if (existing) return existing
    if (input.newThread) await getProject(input.newThread.projectId)
    const messageId = `${input.runId}:input`
    const archived = await archiveAgentAttachments(
      input.attachments ?? [],
      {
        threadId: input.threadId,
        runId: input.runId,
        messageId
      },
      this.database.attachmentRoot
    )
    try {
      return this.startPreparedRun(input, archived, {
        ...(input.newThread ? { newThread: input.newThread } : {}),
        submissionId: input.submissionId
      })
    } catch (reason) {
      await deleteArchivedAgentAttachments(archived.map((item) => item.artifact), this.database.attachmentRoot)
      throw reason
    }
  }

  startCompression(threadId: string, runId: string = randomUUID()): AsyncIterable<AgentRuntimeEvent> {
    this.assertAcceptingRuns()
    this.assertThreadAvailable(threadId, 'compress its context')
    const inputIntent: AgentRunInputIntent = { kind: 'manual_compression' }
    const run = this.database.createRun(threadId, runId, 'compression', [], inputIntent)
    const queue = new EventQueue()
    const active: ActiveRun = {
      threadId,
      controller: new AbortController(),
      cancelled: false,
      appliedDirectionIds: new Set(),
      directions: []
    }
    this.activeRuns.set(run.id, active)
    queue.push({ type: 'run_started', run, newUserTurn: false })
    this.launchExecution(
      run.id,
      graphInputForRunIntent(run, inputIntent).input,
      queue,
      active
    )
    return queue
  }

  async truncateMessages(input: AgentMessageRangeInput): Promise<AgentThreadSnapshot> {
    return this.withThreadMutation(input.threadId, 'change its messages', async () => {
      const tuple = await this.database.checkpointer.getTuple({
        configurable: { thread_id: input.threadId, checkpoint_ns: '' }
      })
      const messages = stateMessages(tuple?.checkpoint.channel_values)
      const messageIndex = messages.findIndex((message) => message.id === input.messageId)
      if (messageIndex < 0) throw new Error(`Message ${input.messageId} was not found.`)
      const targetRunId = toAgentMessage(messages[messageIndex], input.messageId).runId
      if (!targetRunId) throw new Error(`Message ${input.messageId} is missing its run association.`)
      const firstRunMessage = messages.findIndex((message) => message.additional_kwargs?.anas_run_id === targetRunId)
      if (firstRunMessage < 0) throw new Error(`Run ${targetRunId} has no input message.`)
      const affectedRunIds = this.database.listRunIdsFrom(input.threadId, targetRunId)
      await this.cancelManagedCallsForHistoryChange(affectedRunIds)
      await this.cancelSubagentsForHistoryChange(input.threadId, affectedRunIds)
      await this.database.replaceMessageHistory(
        input.threadId, messages.slice(0, firstRunMessage), targetRunId
      )
      await this.drainPendingAttachmentCleanup()
      return this.getSnapshot(input.threadId)
    })
  }

  async prepareMessageEdit(
    input: AgentMessageRangeInput
  ): Promise<AgentMessageEditResult> {
    const artifacts = this.database.listAttachmentsForMessage(
      input.threadId,
      input.messageId
    )
    if (artifacts.length === 0) {
      return {
        snapshot: await this.truncateMessages(input),
        attachments: []
      }
    }

    const draftRoot = join(
      this.temporaryRoot,
      'agent-message-edit',
      randomUUID()
    )
    await mkdir(draftRoot, { recursive: true })
    try {
      const paths: string[] = []
      for (const [index, artifact] of artifacts.entries()) {
        if (!artifact.available) {
          throw new Error(`Attachment "${artifact.name}" is no longer available.`)
        }
        const destinationDirectory = join(
          draftRoot,
          String(index).padStart(4, '0')
        )
        await mkdir(destinationDirectory, { recursive: true })
        const destination = join(destinationDirectory, basename(artifact.name))
        await copyFile(artifact.path, destination)
        paths.push(destination)
      }
      const attachments = await Promise.all(artifacts.map(async (artifact, index) => ({
        path: paths[index],
        name: artifact.name,
        size: artifact.size,
        kind: artifact.kind,
        mimeType: artifact.mimeType,
        contextPolicy: artifact.contextPolicy,
        truncated: artifact.textTruncated,
        temporary: true,
        ...(artifact.kind === 'image'
          ? {
              dataUri: `data:${artifact.mimeType};base64,${
                (await readFile(paths[index])).toString('base64')
              }`
            }
          : {})
      })))
      const snapshot = await this.truncateMessages(input)
      return { snapshot, attachments }
    } catch (reason) {
      await rm(draftRoot, { recursive: true, force: true }).catch(() => undefined)
      throw reason
    }
  }

  async regenerateMessage(input: AgentMessageRegenerateExecutionInput): Promise<{
    run: ReturnType<AgentDatabase['createRun']>
    events: AsyncIterable<AgentRuntimeEvent>
  }> {
    return this.withThreadMutation(input.threadId, 'regenerate a response', async () => {
      const queue = new EventQueue()
      const run = await this.prepareRegeneration(input, queue)
      return { run, events: queue }
    })
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.withThreadMutation(threadId, 'be deleted', async () => {
      await this.cancelSubagentsForOwner(threadId)
      const ownedThreadIds = this.database.listOwnedThreadIds(threadId)
      for (const ownedThreadId of ownedThreadIds) {
        const cancellation = await this.managedCalls.cancelThread(ownedThreadId)
        const executorStillActive = this.managedCalls.hasActiveForThread(ownedThreadId)
        if (
          cancellation.uncertainCallIds.length > 0
          || cancellation.lingeringCallIds.length > 0
          || executorStillActive
        ) {
          throw new AgentThreadLockedError(ownedThreadId, 'be deleted')
        }
      }
      const attachmentsByThread = await this.database.deleteThreadTree(threadId)
      for (const [ownedThreadId, attachments] of attachmentsByThread) {
        await this.completeThreadAttachmentCleanup(ownedThreadId, attachments)
      }
    })
  }

  async finishDeletionCleanup(): Promise<void> {
    await this.startupCleanupTask
    await this.drainPendingAttachmentCleanup()
    await this.drainPendingFileEditCleanup()
    if (this.database.listAttachmentCleanupThreadIds().length > 0
      || this.database.listAttachmentFileCleanup().length > 0
      || this.database.listFileEditCleanupRunIds().length > 0) {
      throw new Error('Conversation deletion still has pending resource cleanup.')
    }
  }

  private async cleanupOrphanedSubagentThreads(): Promise<void> {
    const attempted = new Set<string>()
    while (true) {
      const orphaned = this.database.listOrphanedSubagentThreadIds()
        .filter((threadId) => !attempted.has(threadId))
      if (orphaned.length === 0) return
      for (const threadId of orphaned) {
        attempted.add(threadId)
        try {
          const run = this.database.getLatestRunForThread(threadId)
          if (run && (run.status === 'running' || run.status === 'interrupted')) {
            const cancellation = this.cancelRun({ threadId, runId: run.id })
            if (cancellation === 'requested') {
              await this.waitForRunStop(run.id)
            } else if (cancellation === 'cancelled') {
              await this.runBackgroundSettlementTasks.get(run.id)
            }
          }
          const managedCancellation = await this.managedCalls.cancelThread(threadId)
          if (
            managedCancellation.uncertainCallIds.length > 0
            || managedCancellation.lingeringCallIds.length > 0
            || this.managedCalls.hasActiveForThread(threadId)
          ) {
            throw new AgentThreadLockedError(threadId, 'be removed as orphaned subagent state')
          }
          const attachments = await this.database.deleteThread(threadId)
          await this.completeThreadAttachmentCleanup(threadId, attachments)
        } catch (error) {
          runtimeLog('warn', 'subagent', 'Failed to remove an orphaned subagent thread.', {
            threadId,
            error: errorMessage(error)
          })
        }
      }
    }
  }

  private async repairCompletedSubagentResults(): Promise<void> {
    for (const call of this.database.listCompletedSubagentCallsWithoutResult()) {
      try {
        const childSnapshot = await this.readSnapshot(call.childThreadId)
        const final = childSnapshot.messages.filter((message) => message.role === 'assistant').at(-1)
        this.database.recordCompletedSubagentResult(
          call.id,
          call.ownerThreadId,
          final ? traceText(final.content, 'text') : ''
        )
        this.notifySubagent(call.id)
      } catch (error) {
        runtimeLog('warn', 'subagent', 'Failed to recover a completed subagent result.', {
          subagentId: call.id,
          childRunId: call.childRunId,
          error: errorMessage(error)
        })
      }
    }
  }

  async cleanupThreads(): Promise<AgentThreadCleanupResult> {
    const matches = this.database.listUnpinnedThreadsForCleanup()
    const unresolvedManagedCallThreads = new Set(
      this.database.listThreadIdsWithUnresolvedManagedCalls()
    )
    const candidatesWithDescendants = matches.map((thread) => ({
      thread,
      ownedThreadIds: this.database.listOwnedThreadIds(thread.id)
    }))
    const skippedThreadIds = candidatesWithDescendants.flatMap(({ thread, ownedThreadIds }) => {
      const blocked = ownedThreadIds.some((threadId) => {
        const owned = this.database.getThread(threadId)
        return !owned
          || isAgentThreadLocked(owned.status)
          || this.mutatingThreads.has(threadId)
          || this.hasActiveRunForThread(threadId)
          || this.managedCalls.hasActiveForThread(threadId)
          || this.hasPendingBackgroundSettlementForThread(threadId)
          || unresolvedManagedCallThreads.has(threadId)
      })
      return blocked ? [thread.id] : []
    })
    const skipped = new Set(skippedThreadIds)
    const candidates = candidatesWithDescendants
      .filter(({ thread }) => !skipped.has(thread.id))
    const failures: AgentThreadCleanupResult['failures'] = []
    const deletedThreadIds: string[] = []

    for (const { ownedThreadIds } of candidates) {
      for (const threadId of ownedThreadIds) this.mutatingThreads.add(threadId)
    }
    try {
      for (const { thread } of candidates) {
        try {
          await this.cancelSubagentsForOwner(thread.id)
          const attachments = await this.database.deleteThreadTree(thread.id)
          deletedThreadIds.push(thread.id)
          for (const [ownedThreadId, ownedAttachments] of attachments) {
            try {
              await this.completeThreadAttachmentCleanup(ownedThreadId, ownedAttachments)
            } catch (reason) {
              failures.push({ threadId: ownedThreadId, error: errorMessage(reason) })
            }
          }
        } catch (reason) {
          failures.push({ threadId: thread.id, error: errorMessage(reason) })
        }
      }
      await this.cleanupOrphanedSubagentThreads()

      return {
        deleted: deletedThreadIds.length,
        skipped: skippedThreadIds.length,
        failed: failures.length,
        deletedThreadIds,
        skippedThreadIds,
        failures
      }
    } finally {
      for (const { ownedThreadIds } of candidates) {
        for (const threadId of ownedThreadIds) this.mutatingThreads.delete(threadId)
      }
    }
  }

  hasLiveWork(): boolean {
    return this.activeRuns.size > 0
      || this.resumingThreads.size > 0
      || this.mutatingThreads.size > 0
      || this.runBackgroundSettlementTasks.size > 0
      || this.managedCalls.activeCallIds().length > 0
  }

  retireIfIdle(): boolean {
    if (this.hasLiveWork() || this.tasks.size > 0) return false
    this.shuttingDown = true
    return true
  }

  assertCanDeleteThread(threadId: string): void {
    this.assertThreadAvailable(threadId, 'be deleted')
    if (this.managedCalls.hasActiveForThread(threadId)) {
      throw new AgentThreadLockedError(threadId, 'be deleted')
    }
  }

  async waitForStartupCleanup(): Promise<void> {
    await this.startupCleanupTask
  }

  recoverRun(threadId: string): AsyncIterable<AgentRuntimeEvent> | undefined {
    if (this.shuttingDown) return undefined
    if (this.hasActiveRunForThread(threadId)) return undefined
    const run = this.database.listRecoverableRuns().find((candidate) =>
      candidate.threadId === threadId
    )
    if (!run) return undefined

    const queue = new EventQueue()
    const active: ActiveRun = {
      threadId,
      controller: new AbortController(),
      cancelled: false,
      appliedDirectionIds: new Set(),
      directions: []
    }
    this.activeRuns.set(run.id, active)
    const resumeIntent = this.database.getRunResumeIntent(run.id)
    const inputIntent = this.database.getRunInputIntent(run.id)
    const recoveredInput = inputIntent
      ? graphInputForRunIntent(run, inputIntent)
      : undefined
    if (recoveredInput?.userMessage) {
      const messageId = recoveredInput.userMessage.id ?? `${run.id}:input`
      const attachments = this.database.listAttachmentsForMessage(
        threadId,
        messageId
      )
      const mapped = toAgentMessage(recoveredInput.userMessage, `${run.id}:input`)
      queue.push({
        type: 'run_started',
        run,
        newUserTurn: false,
        userMessage: attachments.length > 0
          ? { ...mapped, attachments }
          : mapped
      })
    } else {
      queue.push({ type: 'run_started', run, newUserTurn: false })
    }
    this.launchExecution(
      run.id,
      resumeIntent
        ? new Command({ resume: resumeIntent })
        : recoveredInput?.input ?? null,
      queue,
      active,
      true
    )
    return queue
  }

  resumeRun(
    input: AgentResumeInput,
    subagent?: {
      id: string
      ownerThreadId: string
      onResumed: (transition: {
        call: AgentSubagentCallRecord
        activity: AgentSubagentActivity
      }) => void
    }
  ): Promise<AsyncIterable<AgentRuntimeEvent>> {
    this.assertAcceptingRuns()
    if (
      this.resumingThreads.has(input.threadId)
      || this.mutatingThreads.has(input.threadId)
      || this.hasActiveRunForThread(input.threadId)
      || this.hasPendingBackgroundSettlementForThread(input.threadId)
    ) {
      return Promise.reject(new AgentThreadLockedError(input.threadId, 'resume its run'))
    }
    this.resumingThreads.add(input.threadId)
    const guarded = this.resumeRunLocked(input, subagent).finally(() => {
      this.resumingThreads.delete(input.threadId)
    })
    this.track(guarded.then(
      () => undefined,
      () => undefined
    ))
    return guarded
  }

  private async resumeRunLocked(
    input: AgentResumeInput,
    subagent?: {
      id: string
      ownerThreadId: string
      onResumed: (transition: {
        call: AgentSubagentCallRecord
        activity: AgentSubagentActivity
      }) => void
    }
  ): Promise<AsyncIterable<AgentRuntimeEvent>> {
    const existing = this.database.getRun(input.runId)
    if (!existing || existing.threadId !== input.threadId) {
      throw new Error(`Run ${input.runId} does not belong to thread ${input.threadId}.`)
    }
    if (existing.status !== 'interrupted') throw new Error(`Run ${input.runId} is not interrupted.`)
    if (this.hasActiveRunForThread(input.threadId)) {
      throw new AgentThreadLockedError(input.threadId, 'resume its run')
    }
    this.assertAcceptingRuns()
    const requestedEntries = requestedResumeEntries(input)
    this.database.checkpointer.retainRun(input.runId, input.threadId)
    const tuple = await this.durableRunRootTuple(input.threadId, input.runId)
    if (!tuple) throw new Error(`Run ${input.runId} has no durable root interrupt checkpoint.`)
    this.assertAcceptingRuns()
    // The saver read above is asynchronous. Recheck before changing the run
    // state so two renderers cannot install overlapping continuations whose
    // finally blocks would delete each other's active handle.
    if (this.hasActiveRunForThread(input.threadId)) {
      throw new AgentThreadLockedError(input.threadId, 'resume its run')
    }
    const entries = durableResumeEntries(
      input.runId,
      tuple.checkpoint.id,
      tuple.pendingWrites,
      requestedEntries
    )
    const resumeIntent = resumeIntentFromEntries(entries)
    const resumedSubagent = subagent
      ? this.database.resumeSubagentRun({
          subagentId: subagent.id,
          ownerThreadId: subagent.ownerThreadId,
          childRunId: input.runId,
          entries
        })
      : undefined
    const run = resumedSubagent?.run ?? this.database.resumeRun(input.runId, entries)
    const queue = new EventQueue()
    const active: ActiveRun = {
      threadId: input.threadId,
      controller: new AbortController(),
      cancelled: false,
      appliedDirectionIds: new Set(),
      directions: []
    }
    this.activeRuns.set(run.id, active)
    queue.push({ type: 'run_started', run, newUserTurn: false })
    if (resumedSubagent && subagent) subagent.onResumed(resumedSubagent)
    this.launchExecution(
      run.id,
      new Command({ resume: resumeIntent }),
      queue,
      active,
      true
    )
    return queue
  }

  listQueuedInputs(): AgentQueuedInput[] {
    return this.database.listQueuedInputs()
  }

  async enqueueQueuedInput(input: AgentQueuedInputCreate): Promise<AgentQueuedInput> {
    const id = normalizeAgentRunSubmissionId(input.id)
    const text = input.text
    const displayText = input.displayText ?? text
    if (!text.trim()) throw new Error('Queued input text is required.')
    if (!displayText.trim()) throw new Error('Queued input display text is required.')
    if (!this.database.getThread(input.threadId)) {
      throw new Error(`Thread ${input.threadId} was not found.`)
    }
    const existing = this.database.getQueuedInput(input.threadId, id)
    if (existing) return existing
    const attachments = validatedAttachmentInputs(input.attachments, 'Queued input')
    const archived = await archiveAgentAttachments(attachments, {
      threadId: input.threadId,
      runId: id,
      messageId: id
    }, this.database.attachmentRoot)
    try {
      return this.database.createQueuedInput({
        id,
        threadId: input.threadId,
        text,
        ...(displayText === text ? {} : { displayText })
      }, archived)
    } catch (reason) {
      await deleteArchivedAgentAttachments(
        archived.map(({ artifact }) => artifact),
        this.database.attachmentRoot
      )
      throw reason
    }
  }

  async removeQueuedInput(threadId: string, queuedInputId: string): Promise<boolean> {
    const attachments = this.database.listQueuedInputAttachmentArtifacts(threadId, queuedInputId)
    const existing = this.database.getQueuedInput(threadId, queuedInputId)
    if (!existing) return false
    const removed = this.database.deleteQueuedInput(threadId, queuedInputId)
    if (!removed) return false
    await deleteArchivedAgentAttachments(attachments, this.database.attachmentRoot).catch((reason) => {
      runtimeLog('warn', 'agent', 'Failed to delete consumed queued-input attachments.', {
        threadId,
        queuedInputId,
        error: errorMessage(reason)
      })
    })
    return true
  }

  markQueuedInputFailed(
    threadId: string,
    queuedInputId: string,
    error: string
  ): AgentQueuedInput {
    return this.database.markQueuedInputFailed(
      threadId,
      queuedInputId,
      error.trim() || 'Queued message could not be sent.'
    )
  }

  retryQueuedInput(threadId: string, queuedInputId: string): AgentQueuedInput {
    return this.database.retryQueuedInput(threadId, queuedInputId)
  }

  async steerRun(input: AgentRunDirectionInput): Promise<boolean> {
    const queuedInputId = input.queuedInputId.trim()
    const text = input.text.trim()
    const displayText = input.displayText?.trim()
    if (!queuedInputId) throw new Error('A queued input ID is required.')
    if (!text) throw new Error('Direction text is required.')
    if (input.displayText !== undefined && !displayText) {
      throw new Error('Direction display text must not be empty.')
    }
    const attachments = validatedAttachmentInputs(input.attachments, 'Direction')
    const run = this.database.getRun(input.runId)
    if (!run || run.threadId !== input.threadId) {
      throw new Error(`Run ${input.runId} does not belong to thread ${input.threadId}.`)
    }
    const active = this.activeRuns.get(input.runId)
    if (
      !active
      || active.threadId !== input.threadId
      || run.operation !== 'agent'
      || run.status !== 'running'
      || active.cancelled
      || active.controller.signal.aborted
    ) return false
    const existingDirection = active.directions.find((direction) => direction.id === queuedInputId)
    if (existingDirection) {
      return existingDirection.status === 'queued' || existingDirection.status === 'applying'
    }
    if (active.appliedDirectionIds.has(queuedInputId)) return true
    const direction: ActiveRun['directions'][number] = {
      id: queuedInputId,
      text,
      ...(displayText && displayText !== text ? { displayText } : {}),
      stagedAttachments: [],
      createdAt: new Date().toISOString(),
      status: 'staging'
    }
    active.directions.push(direction)
    try {
      const archived = await archiveAgentAttachments(attachments, {
        threadId: active.threadId,
        runId: input.runId,
        messageId: `${input.runId}:direction:${queuedInputId}`
      }, this.directionAttachmentStagingRoot())
      if (
        this.activeRuns.get(input.runId) !== active
        || active.cancelled
        || active.controller.signal.aborted
        || !active.directions.includes(direction)
      ) {
        await deleteArchivedAgentAttachments(
          archived.map(({ artifact }) => artifact),
          this.directionAttachmentStagingRoot()
        )
        return false
      }
      direction.stagedAttachments = archived
      direction.status = 'queued'
      return true
    } catch (reason) {
      const index = active.directions.indexOf(direction)
      if (index >= 0) active.directions.splice(index, 1)
      throw reason
    }
  }

  async removeSteer(input: AgentRunDirectionReferenceInput): Promise<boolean> {
    const active = this.activeRuns.get(input.runId)
    if (!active || active.threadId !== input.threadId) return false
    const index = active.directions.findIndex((direction) => direction.id === input.queuedInputId)
    if (index < 0 || active.directions[index].status !== 'queued') return false
    const direction = active.directions[index]
    direction.status = 'removing'
    try {
      await deleteArchivedAgentAttachments(
        direction.stagedAttachments.map(({ artifact }) => artifact),
        this.directionAttachmentStagingRoot()
      )
    } catch (reason) {
      direction.status = 'queued'
      throw reason
    }
    const currentIndex = active.directions.indexOf(direction)
    if (currentIndex >= 0) active.directions.splice(currentIndex, 1)
    return true
  }

  cancelRun(input: AgentRunReferenceInput, armEffect?: () => void): AgentRunCancellationResult {
    return this.cancelRunOutcome(input, armEffect).result
  }

  private cancelRunOutcome(
    input: AgentRunReferenceInput,
    armEffect?: () => void
  ): AgentRunCancellationOutcome {
    const existing = this.database.getRun(input.runId)
    if (!existing || existing.threadId !== input.threadId) {
      throw new Error(`Run ${input.runId} does not belong to thread ${input.threadId}.`)
    }
    const active = this.activeRuns.get(input.runId)
    if (!active) {
      const cancelled = armEffect
        ? this.database.cancelRecoverableRun(input.runId, armEffect)
        : this.database.cancelRecoverableRun(input.runId)
      if (!cancelled) return { result: 'unchanged' }
      this.scheduleCancelledRunBackgroundSettlement(
        input.runId,
        'Agent run was cancelled before its background work was resolved.'
      )
      let subagentTransition: AgentRunCancellationOutcome['subagentTransition']
      const subagent = this.database.getSubagentCallByChildRunId(input.runId)
      if (subagent && (subagent.status === 'running' || subagent.status === 'interrupted')) {
        subagentTransition = this.database.finishSubagentCall({
          subagentId: subagent.id,
          ownerThreadId: subagent.ownerThreadId,
          status: 'cancelled'
        })
        this.notifySubagent(subagent.id)
      }
      this.track(this.drainPendingFileEditCleanup())
      return { result: 'cancelled', ...(subagentTransition ? { subagentTransition } : {}) }
    }
    if (active.threadId !== input.threadId) {
      throw new Error(`Active run ${input.runId} does not belong to thread ${input.threadId}.`)
    }
    if (existing.status === 'interrupted') {
      const cancelled = armEffect
        ? this.database.cancelRecoverableRun(input.runId, armEffect)
        : this.database.cancelRecoverableRun(input.runId)
      if (!cancelled) return { result: 'unchanged' }
      active.cancelled = true
      active.controller.abort(new Error('Run cancelled by user.'))
      active.stream?.abort(new Error('Run cancelled by user.'))
      return { result: 'requested' }
    }
    const requested = armEffect
      ? this.cancelActiveRun(input.runId, active, armEffect)
      : this.cancelActiveRun(input.runId, active)
    return { result: requested ? 'requested' : 'unchanged' }
  }

  private waitForRunStop(runId: string): Promise<void> {
    if (!this.activeRuns.has(runId)) return Promise.resolve()
    return new Promise((resolve) => {
      const waiters = this.runStopWaiters.get(runId) ?? new Set<() => void>()
      const done = (): void => {
        waiters.delete(done)
        if (waiters.size === 0) this.runStopWaiters.delete(runId)
        resolve()
      }
      waiters.add(done)
      this.runStopWaiters.set(runId, waiters)
      if (!this.activeRuns.has(runId)) done()
    })
  }

  private notifyRunStopped(runId: string): void {
    for (const waiter of [...(this.runStopWaiters.get(runId) ?? [])]) waiter()
  }

  private async cancelSubagentCalls(
    listCalls: () => AgentSubagentCallRecord[]
  ): Promise<void> {
    const failures = new Set<unknown>()
    while (true) {
      const calls = listCalls()
      if (calls.length === 0) return
      const unsettledCalls = calls.filter(
        (call) => call.status === 'running' || call.status === 'interrupted'
      )
      const inactiveForwardingCalls = unsettledCalls.filter((call) => (
        !this.activeRuns.has(call.childRunId)
        && (this.subagentForwardTasks.get(call.id)?.size ?? 0) > 0
      ))
      if (inactiveForwardingCalls.length > 0) {
        const forwarding = await Promise.allSettled(
          inactiveForwardingCalls.map((call) => this.waitForSubagentForwarding(call.id))
        )
        for (const result of forwarding) {
          if (result.status === 'rejected') failures.add(result.reason)
        }
        // A detached child executor removes its active marker before its event
        // forwarder necessarily drains. Those queued events still own the
        // canonical call transition and may contain model/tool projections.
        // Re-read both rows after that owner finishes before deciding whether
        // an interrupted child must be cancelled or a terminal child reconciled.
        continue
      }
      const activeCalls = unsettledCalls.filter((call) => {
        const run = this.database.getRun(call.childRunId)
        return this.activeRuns.has(call.childRunId)
          || run?.status === 'running'
          || run?.status === 'interrupted'
      })
      for (const call of [...activeCalls].reverse()) {
        const run = this.database.getRun(call.childRunId)
        if (run?.status === 'running' || run?.status === 'interrupted') {
          const cancellation = this.cancelRunOutcome({
            threadId: call.childThreadId,
            runId: call.childRunId
          })
          if (cancellation.result === 'cancelled' && cancellation.subagentTransition) {
            await this.deliverProjectedSubagentEvent(call, {
              type: 'subagent_updated',
              runId: call.parentRunId,
              threadId: call.parentThreadId,
              subagent: cancellation.subagentTransition.activity
            })
          }
        }
      }
      const forwarding = calls.flatMap((call) => [
        ...(this.subagentForwardTasks.get(call.id) ?? [])
      ])
      const settling = calls.flatMap((call) => {
        const task = this.runBackgroundSettlementTasks.get(call.childRunId)
        return task ? [task] : []
      })
      const settlements = await Promise.allSettled([
        ...activeCalls.map((call) => this.waitForRunStop(call.childRunId)),
        ...forwarding,
        ...settling
      ])
      for (const result of settlements) {
        if (result.status === 'rejected') failures.add(result.reason)
      }
      const reconciliations = await Promise.allSettled(
        calls.map(async (call) => {
          const transition = await this.reconcileStoppedSubagentCall(call)
          if (!transition) return
          await this.deliverProjectedSubagentEvent(call, {
            type: 'subagent_updated',
            runId: call.parentRunId,
            threadId: call.parentThreadId,
            subagent: transition.activity
          })
        })
      )
      for (const result of reconciliations) {
        if (result.status === 'rejected') failures.add(result.reason)
      }
      const currentCalls = listCalls()
      const remaining = currentCalls.filter(
        (call) => call.status === 'running' || call.status === 'interrupted'
      )
      const remainingForwarding = currentCalls.some(
        (call) => (this.subagentForwardTasks.get(call.id)?.size ?? 0) > 0
      )
      const remainingActive = remaining.some((call) => this.activeRuns.has(call.childRunId))
      const remainingSettling = currentCalls.some(
        (call) => this.runBackgroundSettlementTasks.has(call.childRunId)
      )
      const knownCallIds = new Set(calls.map((call) => call.id))
      const discoveredNewCall = remaining.some((call) => !knownCallIds.has(call.id))
      if (remaining.length === 0 && !remainingForwarding && !remainingSettling) {
        if (failures.size > 0) {
          throw new AggregateError([...failures], 'Failed to settle one or more background subagents.')
        }
        return
      }
      if (remainingForwarding || remainingActive || remainingSettling || discoveredNewCall) continue
      throw new AggregateError(
        [...failures, new Error('One or more background subagents could not be stopped safely.')],
        'Failed to settle one or more background subagents.'
      )
    }
  }

  private async reconcileStoppedSubagentCall(
    call: AgentSubagentCallRecord
  ): Promise<ReturnType<AgentDatabase['finishSubagentCall']> | undefined> {
    const current = this.database.getSubagentCall(call.id, call.ownerThreadId)
    if (!current || (current.status !== 'running' && current.status !== 'interrupted')) return
    const childRun = this.database.getRun(current.childRunId)
    if (!childRun || childRun.status === 'running' || childRun.status === 'interrupted') return
    let transition: ReturnType<AgentDatabase['finishSubagentCall']>
    if (childRun.status === 'completed') {
      try {
        const childSnapshot = await this.readSnapshot(current.childThreadId)
        const final = childSnapshot.messages.filter((message) => message.role === 'assistant').at(-1)
        transition = this.database.finishSubagentCall({
          subagentId: current.id,
          ownerThreadId: current.ownerThreadId,
          status: 'completed',
          result: final ? traceText(final.content, 'text') : ''
        })
      } catch (reason) {
        transition = this.database.finishSubagentCall({
          subagentId: current.id,
          ownerThreadId: current.ownerThreadId,
          status: 'completed'
        })
        runtimeLog('warn', 'subagent', 'Completed subagent result could not be read.', {
          subagentId: current.id,
          childRunId: current.childRunId,
          error: errorMessage(reason)
        })
      }
    } else {
      transition = this.database.finishSubagentCall({
        subagentId: current.id,
        ownerThreadId: current.ownerThreadId,
        status: childRun.status,
        ...(childRun.status === 'failed'
          ? { error: childRun.error ?? 'Subagent run failed.' }
          : {})
      })
    }
    this.notifySubagent(current.id)
    return transition
  }

  private scheduleCancelledRunBackgroundSettlement(runId: string, reason: string): Promise<void> {
    const existing = this.runBackgroundSettlementTasks.get(runId)
    if (existing) return existing
    const task = this.settleRunBackgroundWork(runId, reason)
      .then(() => this.releaseSettledRunState(runId))
    this.runBackgroundSettlementTasks.set(runId, task)
    void task.then(
      () => {
        if (this.runBackgroundSettlementTasks.get(runId) === task) {
          this.runBackgroundSettlementTasks.delete(runId)
        }
      },
      () => {
        if (this.runBackgroundSettlementTasks.get(runId) === task) {
          this.runBackgroundSettlementTasks.delete(runId)
        }
      }
    )
    this.track(task)
    return task
  }

  private async settleRunBackgroundWork(
    runId: string,
    reason: string,
    subagentRuntime?: SubagentToolRuntime
  ): Promise<void> {
    const subagentSettlement = subagentRuntime
      ? subagentRuntime.cancelRun(reason)
      : this.cancelSubagentCalls(
          () => this.database.listSubagentCallsForParentRun(runId)
        )
    const managedCallSettlement = this.managedCalls.cancelRun(runId, reason)
    const [subagentResult, managedCallResult] = await Promise.allSettled([
      subagentSettlement,
      managedCallSettlement
    ])
    const failures: unknown[] = []
    if (subagentResult.status === 'rejected') {
      failures.push(subagentResult.reason)
      runtimeLog('warn', 'subagent', 'Failed to settle background subagents after an Agent run.', {
        runId,
        error: errorMessage(subagentResult.reason)
      })
    }
    if (managedCallResult.status === 'fulfilled') {
      const cancelled = managedCallResult.value
      const unsettledCallIds = [...new Set([
        ...cancelled.uncertainCallIds,
        ...cancelled.lingeringCallIds
      ])]
      if (unsettledCallIds.length > 0) {
        runtimeLog('warn', 'managed-call', 'Agent run stopped with uncertain background calls.', {
          runId,
          callIds: unsettledCallIds
        })
      }
    } else {
      failures.push(managedCallResult.reason)
      runtimeLog('warn', 'managed-call', 'Failed to settle background calls after an Agent run.', {
        runId,
        error: errorMessage(managedCallResult.reason)
      })
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Failed to settle Agent run background work.')
    }
  }

  private cancelSubagentsForOwner(ownerThreadId: string): Promise<void> {
    return this.cancelSubagentCalls(() => this.database.listSubagentCalls(ownerThreadId))
  }

  private async releaseSettledRunState(runId: string): Promise<void> {
    const run = this.database.getRun(runId)
    if (run && (run.status === 'running' || run.status === 'interrupted')) return
    if (this.managedCalls.hasActiveForRun(runId)) return
    if (this.database.listSubagentCallsForParentRun(runId).some((call) =>
      call.status === 'running' || call.status === 'interrupted'
      || this.activeRuns.has(call.childRunId)
      || this.runBackgroundSettlementTasks.has(call.childRunId)
    )) return
    await directoryTreePages.closeIdleCursors(runId)
    await this.database.checkpointer.releaseRun(runId)
    this.publishedContextSummaries.delete(runId)
    this.publishedToolCompletions.delete(runId)
  }

  private cancelSubagentsForHistoryChange(
    ownerThreadId: string,
    affectedRunIds: readonly string[]
  ): Promise<void> {
    return this.cancelSubagentCalls(
      () => this.database.listSubagentCallsForRuns(ownerThreadId, affectedRunIds)
    )
  }

  private cancelActiveRun(runId: string, active: ActiveRun, armEffect?: () => void): boolean {
    const run = this.database.getRun(runId)
    if (!run || run.status !== 'running') return false
    const requested = armEffect
      ? this.database.requestRunCancellation(runId, armEffect)
      : this.database.requestRunCancellation(runId)
    if (!requested) return false
    active.cancelled = true
    active.controller.abort(new Error('Run cancelled by user.'))
    active.stream?.abort(new Error('Run cancelled by user.'))
    return true
  }

  async shutdown(options: { timeoutMs?: number } = {}): Promise<AgentRuntimeShutdownResult> {
    const timeoutMs = options.timeoutMs
    if (
      timeoutMs !== undefined
      && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)
    ) {
      throw new Error('Agent runtime shutdown timeout must be a non-negative safe integer.')
    }

    if (!this.shutdownDrain) {
      this.shuttingDown = true
      for (const [runId, active] of [...this.activeRuns]) {
        const run = this.database.getRun(runId)
        if (run) this.cancelRun({ threadId: active.threadId, runId })
      }
      this.shutdownDrain = (async () => {
        await this.managedCalls.shutdown()
        await this.waitForRuntimeIdle()
      })()
    }
    const drained = timeoutMs === undefined
      ? await this.shutdownDrain.then(() => true)
      : await this.waitForShutdownDrain(this.shutdownDrain, timeoutMs)
    return {
      drained,
      lingeringRunIds: [...this.activeRuns.keys()],
      lingeringCallIds: this.managedCalls.activeCallIds()
    }
  }

  resumeAfterIncompleteShutdown(): void {
    if (!this.shuttingDown) return
    this.shuttingDown = false
    this.shutdownDrain = undefined
    this.managedCalls.resumeAfterShutdownTimeout()
  }

  private async waitForRuntimeIdle(): Promise<void> {
    while (true) {
      const tasks = [...this.tasks]
      const runStops = [...this.activeRuns.keys()].map((runId) => this.waitForRunStop(runId))
      const managedIdle = this.managedCalls.waitForIdle()
      if (tasks.length === 0 && runStops.length === 0) {
        await managedIdle
      } else {
        await Promise.allSettled([...tasks, ...runStops, managedIdle])
      }
      if (
        this.tasks.size === 0
        && this.activeRuns.size === 0
        && this.resumingThreads.size === 0
        && this.managedCalls.activeCallIds().length === 0
      ) return
    }
  }

  private async waitForShutdownDrain(
    drain: Promise<void>,
    timeoutMs: number
  ): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        drain.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), timeoutMs)
          timer.unref()
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async getSnapshot(threadId: string): Promise<AgentThreadSnapshot> {
    return this.readSnapshot(threadId)
  }

  async getContextStatus(threadId: string): Promise<AgentContextStatus | undefined> {
    // A preview is a projection of one current checkpoint, never an independent
    // model-history copy. Discard a read overtaken by graph/config changes.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const thread = this.database.getThread(threadId)
      if (!thread) throw new Error(`Thread ${threadId} was not found.`)
      const head = this.database.checkpointer.getCurrentHead(threadId)?.checkpointId
      if (!head) return undefined
      const tuple = await this.database.checkpointer.getTuple({ configurable: {
        thread_id: threadId, checkpoint_ns: '', checkpoint_id: head
      } })
      if (!tuple) continue
      const run = this.database.getLatestRunForThread(threadId)
      const continuation = run?.status === 'running' || run?.status === 'interrupted' ? run : undefined
      // An interrupted instance may still be finishing cleanup. Its prompt is
      // obsolete: resume rebuilds it from current settings and saved capabilities.
      const activeContext = continuation?.status === 'running' ? this.activeRuns.get(continuation.id)?.context : undefined
      const subagentCall = this.database.getSubagentCallByChildThreadId(threadId)
      const status = activeContext
        ? await activeContext.projectedStatus(tuple.checkpoint.channel_values)
        : await this.projectContextStatus(thread, this.database, tuple.checkpoint.channel_values, {
            requestId: continuation?.id,
            configuration: continuation ? this.database.getRunConfiguration(continuation.id) : undefined,
            subagentCall,
            parentConfiguration: subagentCall ? this.database.getRunConfiguration(subagentCall.parentRunId) : undefined
          })
      const currentModel = await createAgentModelResolver(threadId, this.database)()
      const currentRun = this.database.getLatestRunForThread(threadId)
      const currentActiveContext = currentRun?.status === 'running' ? this.activeRuns.get(currentRun.id)?.context : undefined
      if (this.database.checkpointer.getCurrentHead(threadId)?.checkpointId === head
        && currentRun?.id === run?.id && currentRun?.status === run?.status
        && currentActiveContext === activeContext
        && status.modelContextKey === modelContextKey(currentModel)) return status
    }
    return undefined
  }

  async previewSystemContext(
    input: AgentSystemContextPreviewInput
  ): Promise<AgentSystemContextPreview> {
    const { config, thread, project } = await resolveAgentPreviewTarget(input, {
      id: 'system-context-preview',
      title: 'System context preview'
    })
    return {
      content: await captureAgentSystemPrompt(thread, this.database, config, project)
    }
  }

  async previewModelRequest(
    input: AgentModelRequestPreviewInput
  ): Promise<AgentModelRequestPreview> {
    const { config, thread, project } = await resolveAgentPreviewTarget(input, {
      id: 'model-request-preview',
      title: 'Model request preview'
    })
    return {
      content: await captureAgentModelRequest(thread, this.database, config, this.managedCalls, project)
    }
  }

  async loadEarlierMessages(
    input: AgentMessageWindowInput
  ): Promise<AgentThreadSnapshot> {
    if (!Number.isSafeInteger(input.beforeIndex) || input.beforeIndex < 0) {
      throw new Error('The message window cursor is invalid.')
    }
    return this.readSnapshot(
      input.threadId,
      Math.max(0, input.beforeIndex - earlierAgentMessagePageSize)
    )
  }

  loadEarlierActivities(input: AgentActivityWindowInput): AgentRunActivity {
    if (!Number.isSafeInteger(input.beforeSequence) || input.beforeSequence < 0) {
      throw new Error('The activity window cursor is invalid.')
    }
    const run = this.database.getRun(input.runId)
    if (!run || run.threadId !== input.threadId) {
      throw new Error(`Run ${input.runId} was not found in thread ${input.threadId}.`)
    }
    const activity = this.database.getRunActivityWindow(run.id, {
      beforeSequence: input.beforeSequence
    })
    return this.withRuntimeActivityState(this.normalizeActivityWindow(
      activity, Boolean(this.activeRuns.get(run.id)?.stream)
    ))
  }

  private normalizeActivityWindow(
    activity: AgentRunActivity,
    retainUncommitted: boolean
  ): AgentRunActivity {
    if (activity.status !== 'running' && activity.status !== 'interrupted') return activity
    return normalizeRootActivityProjection(
      activity,
      durableRootActivityEvidence({
        messages: this.database.readActivityMessages(activity.runId, activity)
      }, activity.runId),
      retainUncommitted,
      this.database.canonicalSubagentActivityEvidence(activity.runId)
    )
  }

  private async readSnapshot(
    threadId: string,
    startIndex?: number
  ): Promise<AgentThreadSnapshot> {
    const thread = this.database.getThread(threadId)
    if (!thread) throw new Error(`Thread ${threadId} was not found.`)
    const latestRun = this.database.getLatestRunForThread(threadId)
    const headId = this.database.checkpointer.getCurrentHead(threadId)?.checkpointId
    const fingerprint = runCheckpointFingerprint(
      latestRun ? this.database.getRunCheckpointState(latestRun.id) : undefined
    )
    const window = await this.database.readMessageWindow(threadId, startIndex)
    const pendingWrites = latestRun ? await this.currentApprovalWrites(threadId) : []
    let interrupts = durableApprovalInterrupts(latestRun?.id, headId, pendingWrites)
    if (latestRun?.status === 'running' && this.database.getRunCheckpointState(latestRun.id).resumeIntent) {
      interrupts = []
    }
    const primaryFolder = interrupts.length > 0 ? await snapshotPrimaryFolder(thread) : undefined
    const projectedInterrupts = await projectInterruptPathPreviews(interrupts, primaryFolder, window.values)
    const currentThread = this.database.getThread(threadId)
    const currentRun = this.database.getLatestRunForThread(threadId)
    if (
      !currentThread
      || currentThread.updatedAt !== thread.updatedAt
      || currentThread.status !== thread.status
      || currentRun?.id !== latestRun?.id
      || currentRun?.status !== latestRun?.status
      || currentRun?.updatedAt !== latestRun?.updatedAt
      || this.database.checkpointer.getCurrentHead(threadId)?.checkpointId !== headId
      || runCheckpointFingerprint(currentRun ? this.database.getRunCheckpointState(currentRun.id) : undefined) !== fingerprint
    ) return this.readSnapshot(threadId, startIndex)
    return this.snapshot(
      window.values,
      threadId,
      projectedInterrupts,
      window.contextStatus,
      window.startIndex,
      { thread, latestRun },
      Boolean(latestRun && this.activeRuns.get(latestRun.id)?.stream),
      window
    )
  }

  private async currentApprovalWrites(threadId: string) {
    const channels = ['__interrupt__', '__resume__']
    const writes = await this.database.checkpointer.getPendingWrites(threadId, '', channels)
    // A later normal result makes an old interrupt stale. Only its channel
    // identity is needed here; decoding its messages would load the history.
    const otherWrites = this.database.checkpointer.getPendingWriteIdentities(threadId)
      .filter((row) => !channels.includes(row.channel))
      .map((row) => [row.task_id, row.channel, undefined] as const)
    return [...writes, ...otherWrites]
  }

  private assertThreadAvailable(threadId: string, action: string): void {
    if (
      this.mutatingThreads.has(threadId)
      || this.resumingThreads.has(threadId)
      || this.hasActiveRunForThread(threadId)
      || this.hasPendingBackgroundSettlementForThread(threadId)
    ) {
      throw new AgentThreadLockedError(threadId, action)
    }
    this.database.assertThreadMutable(threadId, action)
  }

  private assertAcceptingRuns(): void {
    if (this.shuttingDown) throw new Error('Agent runtime is shutting down.')
  }

  private hasActiveRunForThread(threadId: string): boolean {
    return [...this.activeRuns.values()].some((active) => active.threadId === threadId)
  }

  private hasPendingBackgroundSettlementForThread(threadId: string): boolean {
    const ownedThreadIds = new Set(this.database.listOwnedThreadIds(threadId))
    return [...this.runBackgroundSettlementTasks.keys()].some((runId) => {
      const run = this.database.getRun(runId)
      return Boolean(run && ownedThreadIds.has(run.threadId))
    })
  }

  private async withThreadMutation<T>(
    threadId: string,
    action: string,
    mutate: (
      thread: NonNullable<ReturnType<AgentDatabase['getThread']>>
    ) => Promise<T>
  ): Promise<T> {
    this.assertThreadAvailable(threadId, action)
    const thread = this.database.getThread(threadId)
    if (!thread) throw new Error(`Thread ${threadId} was not found.`)
    this.mutatingThreads.add(threadId)
    try {
      return await mutate(thread)
    } finally {
      this.mutatingThreads.delete(threadId)
    }
  }

  private async cancelManagedCallsForHistoryChange(runIds: readonly string[]): Promise<void> {
    const cancelled = await this.managedCalls.cancelRuns(
      [...runIds],
      'The conversation history containing this background call is being replaced.'
    )
    // An uncertain result is terminal, not proof that its executor is still
    // running. User-confirmed history replacement can discard that result;
    // automatic recovery retains its separate effect-retry approval rules.
    const activeRunIds = runIds.filter((runId) => this.managedCalls.hasActiveForRun(runId))
    if (cancelled.lingeringCallIds.length > 0 || activeRunIds.length > 0) {
      throw new Error(
        'Conversation history was not changed because background work is still executing. Wait for it to stop before trying again.'
      )
    }
  }

  private async applyQueuedDirections(
    runId: string,
    active: ActiveRun,
    queue: EventQueue,
    afterToolCallIds: string[]
  ): Promise<BaseMessage[]> {
    const directions: ActiveRun['directions'] = []
    for (const direction of active.directions) {
      if (direction.status !== 'queued') break
      directions.push(direction)
    }
    if (directions.length === 0) return []
    for (const direction of directions) direction.status = 'applying'
    const archivedByDirection = new Map<string, ArchivedAgentAttachment[]>()
    const archived: ArchivedAgentAttachment[] = []
    try {
      for (const direction of directions) {
        const items = await archiveAgentAttachments(
          direction.stagedAttachments.map(archivedAttachmentInput),
          {
            threadId: active.threadId,
            runId,
            messageId: `${runId}:direction:${direction.id}`
          },
          this.database.attachmentRoot
        )
        archivedByDirection.set(direction.id, items)
        archived.push(...items)
      }
      this.database.appendRunAttachments(runId, archived)
    } catch (reason) {
      await deleteArchivedAgentAttachments(
        archived.map(({ artifact }) => artifact),
        this.database.attachmentRoot
      ).catch(() => undefined)
      for (const direction of directions) direction.status = 'queued'
      throw reason
    }

    const appliedIds = new Set(directions.map((direction) => direction.id))
    for (const id of appliedIds) active.appliedDirectionIds.add(id)
    active.directions = active.directions.filter((direction) => !appliedIds.has(direction.id))
    await this.cleanupDirectionAttachmentStaging(runId, directions)
    return directions.map((direction) => {
      const messageId = `${runId}:direction:${direction.id}`
      const message = toHumanMessage(direction.text, undefined, direction.displayText, {
        id: messageId,
        runId,
        createdAt: direction.createdAt,
        directionAfterToolCallIds: afterToolCallIds
      })
      const attachments = (archivedByDirection.get(direction.id) ?? [])
        .map(({ artifact }) => artifact)
      const mapped = toAgentMessage(message, messageId)
      queue.push({
        type: 'direction_applied',
        runId,
        threadId: active.threadId,
        queuedInputId: direction.id,
        message: attachments.length > 0 ? { ...mapped, attachments } : mapped
      })
      return message
    })
  }

  private async consumeCommittedQueuedDirections(
    runId: string,
    active: ActiveRun,
    values: unknown
  ): Promise<void> {
    if (active.appliedDirectionIds.size === 0) return
    const committedMessageIds = new Set(
      stateMessages(values).flatMap((message) => message.id ? [message.id] : [])
    )
    for (const queuedInputId of active.appliedDirectionIds) {
      if (!committedMessageIds.has(`${runId}:direction:${queuedInputId}`)) continue
      try {
        await this.removeQueuedInput(active.threadId, queuedInputId)
      } catch (reason) {
        runtimeLog('warn', 'agent', 'Failed to consume a committed queued direction.', {
          runId,
          threadId: active.threadId,
          queuedInputId,
          error: errorMessage(reason)
        })
      }
    }
  }

  private subagentRuntimeForRun(
    thread: AgentThread,
    runId: string,
    queue: EventQueue,
    executingSubagent?: AgentSubagentCallRecord
  ): SubagentToolRuntime {
    const ownerThreadId = executingSubagent?.ownerThreadId ?? thread.id
    const parentSubagentId = executingSubagent?.id
    const findOwned = (subagentId: string): AgentSubagentCallRecord | undefined => {
      const call = this.database.getSubagentCall(subagentId, ownerThreadId)
      return call?.parentRunId === runId ? call : undefined
    }
    const resolveToolTarget = (subagentId: string): AgentSubagentCallRecord => {
      const call = findOwned(subagentId)
      if (!call) {
        throw new ToolInputParsingException(`Subagent ${subagentId} was not found in this run. Use read_subagent without an ID to list this run's subagents.`)
      }
      return call
    }
    const requireOwned = (subagentId: string): AgentSubagentCallRecord => {
      const call = findOwned(subagentId)
      if (!call) throw new Error(`Subagent ${subagentId} was not found in this run.`)
      return call
    }
    const observableCallChanged = (
      before: AgentSubagentCallRecord,
      after: AgentSubagentCallRecord
    ): boolean => after.status !== before.status
      || after.result !== before.result
      || after.error !== before.error
    const reconcileStatus = async (call: AgentSubagentCallRecord): Promise<AgentSubagentCallRecord> => {
      const current = requireOwned(call.id)
      if (current.status !== 'running' && current.status !== 'interrupted') return current
      if (
        this.activeRuns.has(current.childRunId)
        || (this.subagentForwardTasks.get(current.id)?.size ?? 0) > 0
      ) {
        // The child executor/forwarder owns the canonical transition while it
        // is live. Reconciling the run row here would publish the same terminal
        // state a second time when the queued terminal event is forwarded.
        return current
      }
      const childRun = this.database.getRun(current.childRunId)
      if (!childRun) return current
      if (childRun.status === 'running') {
        if (current.status === 'interrupted') {
          const transition = this.database.markSubagentCallRunning(
            current.id,
            current.ownerThreadId
          )
          if (!transition) return requireOwned(current.id)
          await this.deliverProjectedSubagentEvent(current, {
            type: 'subagent_updated',
            runId: current.parentRunId,
            threadId: current.parentThreadId,
            subagent: transition.activity
          }, queue)
          this.notifySubagent(current.id)
          return transition.call
        }
        return current
      }
      if (childRun.status === 'interrupted') {
        if (current.status !== 'interrupted') {
          const transition = this.database.markSubagentCallInterrupted(
            current.id,
            current.ownerThreadId
          )
          if (!transition) return requireOwned(current.id)
          await this.deliverProjectedSubagentEvent(current, {
            type: 'subagent_updated',
            runId: current.parentRunId,
            threadId: current.parentThreadId,
            subagent: transition.activity
          }, queue)
          this.notifySubagent(current.id)
          return transition.call
        }
        return current
      }

      let result = ''
      if (childRun.status === 'completed') {
        try {
          const childSnapshot = await this.readSnapshot(current.childThreadId)
          const final = childSnapshot.messages.filter((message) => message.role === 'assistant').at(-1)
          result = final ? traceText(final.content, 'text') : ''
        } catch (reason) {
          const message = `Subagent completed, but its final result could not be read: ${errorMessage(reason)}`
          const transition = this.database.recordSubagentRecoveryFailure(
            current.id,
            current.ownerThreadId,
            message
          )
          if (!transition) return requireOwned(current.id)
          runtimeLog('warn', 'subagent', message, {
            subagentId: current.id,
            childRunId: current.childRunId
          })
          await this.deliverProjectedSubagentEvent(current, {
            type: 'subagent_updated',
            runId: current.parentRunId,
            threadId: current.parentThreadId,
            subagent: transition.activity
          }, queue)
          this.notifySubagent(current.id)
          return transition.call
        }
      }
      const transition = this.database.finishSubagentCall({
        subagentId: current.id,
        ownerThreadId: current.ownerThreadId,
        status: childRun.status,
        ...(childRun.status === 'completed' ? { result } : {}),
        ...(childRun.status === 'failed' ? { error: childRun.error ?? 'Subagent run failed.' } : {})
      })
      if (!transition) return requireOwned(current.id)
      await this.deliverProjectedSubagentEvent(current, {
        type: 'subagent_updated',
        runId: current.parentRunId,
        threadId: current.parentThreadId,
        subagent: transition.activity
      }, queue)
      this.notifySubagent(current.id)
      return transition.call
    }
    const ensureRunning = async (initial: AgentSubagentCallRecord): Promise<void> => {
      let call = requireOwned(initial.id)
      if (call.status !== 'running' || this.activeRuns.has(call.childRunId)) return

      // A child executor removes its active marker before its forwarding task
      // necessarily projects the terminal event. Let that generation settle
      // before deciding whether the durable run still needs recovery.
      await this.waitForRunStop(call.childRunId)
      await this.waitForSubagentForwarding(call.id)
      call = await reconcileStatus(requireOwned(call.id))
      if (call.status !== 'running' || this.activeRuns.has(call.childRunId)) return

      const events = this.recoverRun(call.childThreadId)
      if (!events) return
      const transition = this.database.markSubagentCallRunning(call.id, call.ownerThreadId)
      if (transition) {
        await this.deliverProjectedSubagentEvent(call, {
          type: 'subagent_updated',
          runId: call.parentRunId,
          threadId: call.parentThreadId,
          subagent: transition.activity
        }, queue)
      }
      this.trackSubagentEvents(transition?.call ?? requireOwned(call.id), events, queue)
    }
    const snapshot = async (call: AgentSubagentCallRecord): Promise<SubagentProcessSnapshot> => {
      const current = await reconcileStatus(call)
      const activity = this.database.getRunProcessActivity(current.childRunId)
      let interrupts: AgentInterrupt[] = []
      let approvalGeneration: string | undefined
      if (current.status === 'interrupted') {
        const childSnapshot = await this.readSnapshot(current.childThreadId)
        interrupts = childSnapshot.interrupts
        if (interrupts.length > 0) {
          const tuple = await this.durableRunRootTuple(
            current.childThreadId,
            current.childRunId
          )
          if (!tuple?.checkpoint.id) {
            throw new Error(`Subagent ${current.id} has no durable approval checkpoint.`)
          }
          const durableInterrupts = durableApprovalInterrupts(
            current.childRunId,
            tuple.checkpoint.id,
            tuple.pendingWrites
          )
          const visibleById = new Map(interrupts.map((interrupt) => [interrupt.id, interrupt]))
          if (
            durableInterrupts.length !== visibleById.size
            || durableInterrupts.some((interrupt) => {
              const visible = visibleById.get(interrupt.id)
              return !visible
                || !isDeepStrictEqual(interrupt.value, visible.value)
                || interrupt.approvalGeneration !== visible.approvalGeneration
            })
          ) {
            throw new Error(`Subagent ${current.id} approval checkpoint changed while it was read.`)
          }
          approvalGeneration = durableInterrupts[0]?.approvalGeneration
        }
      }
      const latestModel = activity.latestModel
      return {
        call: current,
        modelRounds: activity.modelRounds,
        toolCalls: activity.toolCalls,
        activeTools: activity.activeTools.map((tool) => ({
          name: tool.call.name,
          ...(toolProvidedSummary(tool.call.args) ? { summary: toolProvidedSummary(tool.call.args) } : {})
        })),
        ...(latestModel?.text ? { latestText: latestModel.text } : {}),
        ...(latestModel?.reasoning ? { latestReasoning: latestModel.reasoning } : {}),
        interrupts,
        ...(approvalGeneration ? { approvalGeneration } : {})
      }
    }
    return {
      start: async (request, description, identity, armEffect) => {
        this.assertAcceptingRuns()
        const { subagentId, childThreadId, childRunId } = identity
        const existing = this.database.getSubagentCall(subagentId, ownerThreadId)
        if (existing) {
          if (existing.parentRunId !== runId) {
            throw new Error(`Subagent ${subagentId} was not found in this run.`)
          }
          if (existing.agentName !== request.agentName) {
            throw new Error(`Subagent ${subagentId} was created as ${existing.agentName}.`)
          }
          if (
            existing.childThreadId !== childThreadId
            || existing.childRunId !== childRunId
            || existing.description !== description
          ) {
            throw new Error(`Subagent ${subagentId} durable start identity changed.`)
          }
          const activity = this.database.recordSubagentActivity(
            runId,
            existing.id,
            existing.agentName,
            existing.status,
            parentSubagentId,
            existing.result,
            existing.error
          )
          queue.push({ type: 'subagent_updated', runId, threadId: thread.id, subagent: activity })
          await ensureRunning(existing)
          return snapshot(existing)
        }
        const subagent = request.config
        if (!subagent || !isSubagentConfigured(subagent) || subagent.name !== request.agentName) {
          throw new ToolInputParsingException(`Configured subagent ${request.agentName} is unavailable. Choose an available agent listed in start_subagent.`)
        }
        const activeCalls = this.database.listSubagentCalls(ownerThreadId)
          .filter((candidate) => candidate.status === 'running' || candidate.status === 'interrupted')
        if (activeCalls.length >= maximumConcurrentSubagents) {
          throw new ToolInputParsingException(`At most ${maximumConcurrentSubagents} subagents may be active in one conversation. Wait for an existing subagent to finish before starting another.`)
        }
        let depth = 1
        let ancestorId = parentSubagentId
        const visited = new Set<string>()
        while (ancestorId) {
          if (visited.has(ancestorId)) throw new Error('Subagent ancestry contains a cycle.')
          visited.add(ancestorId)
          depth += 1
          ancestorId = this.database.getSubagentCall(ancestorId, ownerThreadId)?.parentSubagentId
        }
        if (depth > maximumSubagentDepth) {
          throw new ToolInputParsingException(`Subagent nesting is limited to ${maximumSubagentDepth} levels. Complete this work without further delegation.`)
        }
        const call = this.database.createSubagentCall({
          id: subagentId,
          ownerThreadId,
          parentThreadId: thread.id,
          parentRunId: runId,
          parentSubagentId,
          childThreadId,
          childRunId,
          config: subagent,
          description,
          childThread: {
            title: description.slice(0, 120),
            projectId: thread.projectId,
            accessMode: thread.accessMode
          }
        }, armEffect)
        const activity = this.database.getSubagentActivity(runId, subagentId)
        queue.push({
          type: 'subagent_updated',
          runId,
          threadId: thread.id,
          subagent: activity ?? {
            id: subagentId,
            name: subagent.name,
            sequence: 0,
            status: 'running',
            parentSubagentId
          }
        })
        const childRun = this.database.getRun(childRunId)
        const intent = this.database.getRunInputIntent(childRunId)
        if (!childRun || !intent) throw new Error(`Subagent ${subagentId} has no durable input.`)
        const childQueue = this.startExistingRun(childRun, graphInputForRunIntent(childRun, intent).input)
        this.trackSubagentEvents(call, childQueue, queue)
        return snapshot(call)
      },
      read: async (subagentId) => {
        if (subagentId) {
          const call = resolveToolTarget(subagentId)
          await ensureRunning(call)
          return snapshot(call)
        }
        const calls = this.database.listUnresolvedSubagentCallsForRun(runId)
        await Promise.all(calls.map(async (call) => {
          if (call.status === 'running' || call.status === 'interrupted') {
            await ensureRunning(call)
          }
        }))
        return Promise.all(calls.map(snapshot))
      },
      wait: async (subagentId, timeoutMs, signal) => {
        const initial = resolveToolTarget(subagentId)
        await ensureRunning(initial)
        const before = await snapshot(initial)
        if (
          before.call.status !== 'running'
          || observableCallChanged(initial, before.call)
        ) return before
        await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) {
            reject(signal.reason ?? new Error('Subagent wait was cancelled.'))
            return
          }
          const waiters = this.subagentWaiters.get(subagentId) ?? new Set<() => void>()
          const timeout: { handle?: ReturnType<typeof setTimeout> } = {}
          const done = () => {
            if (timeout.handle) clearTimeout(timeout.handle)
            signal?.removeEventListener('abort', aborted)
            waiters.delete(done)
            if (waiters.size === 0) this.subagentWaiters.delete(subagentId)
            resolve()
          }
          const aborted = () => {
            if (timeout.handle) clearTimeout(timeout.handle)
            waiters.delete(done)
            if (waiters.size === 0) this.subagentWaiters.delete(subagentId)
            reject(signal?.reason ?? new Error('Subagent wait was cancelled.'))
          }
          waiters.add(done)
          this.subagentWaiters.set(subagentId, waiters)
          timeout.handle = setTimeout(done, timeoutMs)
          signal?.addEventListener('abort', aborted, { once: true })
          const latestCall = requireOwned(subagentId)
          const latestRun = this.database.getRun(latestCall.childRunId)
          const childLifecycleStillOwnsTransition = this.activeRuns.has(latestCall.childRunId)
            || (this.subagentForwardTasks.get(latestCall.id)?.size ?? 0) > 0
          const callChangedWhileRegistering = observableCallChanged(before.call, latestCall)
          if (
            callChangedWhileRegistering
            || latestCall.status !== 'running'
            || (
              !childLifecycleStillOwnsTransition
              && latestRun?.status !== 'running'
            )
          ) done()
        })
        return snapshot(requireOwned(subagentId))
      },
      cancel: async (subagentId, armEffect) => {
        let call = resolveToolTarget(subagentId)
        if (
          (call.status === 'running' || call.status === 'interrupted')
          && !this.activeRuns.has(call.childRunId)
        ) {
          await this.waitForRunStop(call.childRunId)
          await this.waitForSubagentForwarding(call.id)
          call = await reconcileStatus(requireOwned(subagentId))
          const childRun = this.database.getRun(call.childRunId)
          if (
            (call.status === 'running' || call.status === 'interrupted')
            && childRun
            && childRun.status !== 'running'
            && childRun.status !== 'interrupted'
          ) {
            const transition = await this.reconcileStoppedSubagentCall(call)
            if (transition) {
              await this.deliverProjectedSubagentEvent(call, {
                type: 'subagent_updated',
                runId: call.parentRunId,
                threadId: call.parentThreadId,
                subagent: transition.activity
              }, queue)
            }
            call = requireOwned(subagentId)
          }
        }
        if (call.status === 'running' || call.status === 'interrupted') {
          const cancellation = this.cancelRunOutcome(
            { threadId: call.childThreadId, runId: call.childRunId },
            armEffect
          )
          if (cancellation.result === 'requested') {
            await this.waitForRunStop(call.childRunId)
            await this.waitForSubagentForwarding(call.id)
          } else if (cancellation.result === 'cancelled') {
            if (!cancellation.subagentTransition) {
              throw new Error(`Subagent ${call.id} cancellation did not produce a durable transition.`)
            }
            await this.deliverProjectedSubagentEvent(call, {
              type: 'subagent_updated',
              runId: call.parentRunId,
              threadId: call.parentThreadId,
              subagent: cancellation.subagentTransition.activity
            }, queue)
            await this.runBackgroundSettlementTasks.get(call.childRunId)
          } else {
            await this.waitForRunStop(call.childRunId)
            await this.waitForSubagentForwarding(call.id)
          }
        }
        return snapshot(requireOwned(subagentId))
      },
      resume: async (subagentId, responses) => {
        const call = requireOwned(subagentId)
        await this.waitForRunStop(call.childRunId)
        await this.waitForSubagentForwarding(call.id)
        const stoppedCall = requireOwned(subagentId)
        const events = await this.resumeRun({
          threadId: stoppedCall.childThreadId,
          runId: stoppedCall.childRunId,
          responses
        }, {
          id: stoppedCall.id,
          ownerThreadId: stoppedCall.ownerThreadId,
          onResumed: (transition) => {
            queue.push({
              type: 'subagent_updated',
              runId: stoppedCall.parentRunId,
              threadId: stoppedCall.parentThreadId,
              subagent: transition.activity
            })
          }
        })
        this.trackSubagentEvents(stoppedCall, events, queue)
      },
      unresolvedForRun: (limit) => this.database.listUnresolvedSubagentCallsForRun(runId, limit),
      resolveObserved: (subagentId) => {
        requireOwned(subagentId)
        this.database.resolveSubagentCall(subagentId, ownerThreadId, runId)
      },
      cancelRun: async (reason) => {
        const calls = this.database.listSubagentCallsForParentRun(runId)
        for (const call of calls.filter(
          (candidate) => candidate.status === 'running' || candidate.status === 'interrupted'
        )) {
          runtimeLog('info', 'subagent', reason, { subagentId: call.id, runId })
        }
        await this.cancelSubagentCalls(
          () => this.database.listSubagentCallsForParentRun(runId)
        )
      }
    }
  }

  private startExistingRun(run: AgentRun, input: unknown, continuation = false): EventQueue {
    this.assertAcceptingRuns()
    const queue = new EventQueue()
    const active: ActiveRun = {
      threadId: run.threadId,
      controller: new AbortController(),
      cancelled: false,
      appliedDirectionIds: new Set(),
      directions: []
    }
    this.activeRuns.set(run.id, active)
    queue.push({ type: 'run_started', run, newUserTurn: false })
    this.launchExecution(run.id, input, queue, active, continuation)
    return queue
  }

  private launchExecution(
    runId: string,
    input: unknown,
    queue: EventQueue,
    active: ActiveRun,
    continuation = false
  ): void {
    // A background run may be launched from inside another graph's tool task.
    // It is an independent LangGraph root and must not inherit the parent's
    // runnable callbacks/namespace or the parent's durable tool-effect scope.
    const execution = runWithoutCurrentAgentToolEffect(() => (
      AsyncLocalStorageProviderSingleton.runWithConfig(
        {},
        () => this.execute(runId, input, queue, active, continuation),
        true
      )
    ))
    this.track(execution)
  }

  private notifySubagent(subagentId: string): void {
    for (const waiter of [...(this.subagentWaiters.get(subagentId) ?? [])]) waiter()
  }

  private async waitForSubagentForwarding(subagentId: string): Promise<void> {
    while (true) {
      const tasks = [...(this.subagentForwardTasks.get(subagentId) ?? [])]
      if (tasks.length === 0) return
      const settled = await Promise.allSettled(tasks)
      const failures = settled.flatMap((result) => (
        result.status === 'rejected' ? [result.reason] : []
      ))
      if (failures.length > 0) {
        throw new AggregateError(
          failures,
          `Subagent ${subagentId} event projection did not finish cleanly.`
        )
      }
    }
  }

  private trackSubagentEvents(
    call: AgentSubagentCallRecord,
    events: AsyncIterable<AgentRuntimeEvent>,
    parentQueue: EventQueue
  ): void {
    const task = this.forwardSubagentEvents(call, events, parentQueue)
    const tasks = this.subagentForwardTasks.get(call.id) ?? new Set<Promise<void>>()
    tasks.add(task)
    this.subagentForwardTasks.set(call.id, tasks)
    void task.finally(() => {
      tasks.delete(task)
      if (tasks.size === 0) this.subagentForwardTasks.delete(call.id)
    }).catch(() => undefined)
    this.track(task)
  }

  private async forwardSubagentEvents(
    call: AgentSubagentCallRecord,
    events: AsyncIterable<AgentRuntimeEvent>,
    parentQueue: EventQueue
  ): Promise<void> {
    try {
      for await (const event of events) {
        await this.deliverSubagentEvent(call, event, parentQueue)
      }
    } finally {
      this.notifySubagent(call.id)
    }
  }

  private async deliverSubagentEvent(
    call: AgentSubagentCallRecord,
    event: AgentRuntimeEvent,
    parentQueue?: EventQueue
  ): Promise<void> {
    const projected = await this.projectSubagentEvent(call, event)
    if (!projected) return
    await this.deliverProjectedSubagentEvent(call, projected, parentQueue)
  }

  private async deliverProjectedSubagentEvent(
    call: AgentSubagentCallRecord,
    projected: AgentRuntimeEvent,
    parentQueue?: EventQueue
  ): Promise<void> {
    if (parentQueue?.push(projected)) return

    const ancestor = this.database.getSubagentCallByChildRunId(call.parentRunId)
    if (ancestor) {
      await this.deliverSubagentEvent(ancestor, projected)
      return
    }
    try {
      await this.publishDetachedEvent?.(projected)
    } catch (error) {
      runtimeLog('warn', 'subagent', 'Failed to publish a detached subagent event.', {
        subagentId: call.id,
        parentRunId: call.parentRunId,
        error: errorMessage(error)
      })
    }
  }

  private async projectSubagentEvent(
    call: AgentSubagentCallRecord,
    event: AgentRuntimeEvent
  ): Promise<AgentRuntimeEvent | undefined> {
    if (event.type === 'model_started' || event.type === 'model_completed') {
      const subagentId = event.model.subagentId ?? call.id
      const model = subagentId === call.id
        ? this.database.recordProjectedModelActivity(call.id, call.ownerThreadId, {
            ...event.model,
            subagentId
          })
        : this.requireProjectedModelActivity(call, event.model.id, subagentId)
      return { ...event, runId: call.parentRunId, threadId: call.parentThreadId, model }
    }
    if (event.type === 'model_delta' || event.type === 'model_tool_calls') {
      const projected = {
        ...event,
        runId: call.parentRunId,
        threadId: call.parentThreadId,
        subagentId: event.subagentId ?? call.id
      }
      if (projected.type === 'model_tool_calls') this.rememberToolCallProgress(projected)
      return projected
    }
    if (event.type === 'tool_started' || event.type === 'tool_completed') {
      const subagentId = event.subagentId ?? call.id
      const tool = subagentId === call.id
        ? this.database.recordProjectedToolActivity(
            call.id,
            call.ownerThreadId,
            event.call,
            event.type === 'tool_completed' ? 'completed' : 'running',
            subagentId,
            event.type === 'tool_completed' ? event.output : undefined
          )
        : this.requireProjectedToolActivity(call, event.call.id, subagentId)
      return {
        ...event,
        runId: call.parentRunId,
        threadId: call.parentThreadId,
        sequence: tool.sequence,
        subagentId
      }
    }
    if (event.type === 'tool_approval_requested') {
      const subagentId = event.subagentId ?? call.id
      const tool = subagentId === call.id
        ? this.database.recordProjectedToolApproval(
            call.id,
            call.ownerThreadId,
            event.call,
            event.approval,
            subagentId
          )
        : this.requireProjectedToolActivity(call, event.call.id, subagentId)
      return {
        ...event,
        runId: call.parentRunId,
        threadId: call.parentThreadId,
        sequence: tool.sequence,
        subagentId,
        startedAt: tool.startedAt
      }
    }
    if (event.type === 'subagent_updated') {
      const nested = event.subagent.id === call.id
        ? this.database.recordProjectedSubagentActivity(
            call.id,
            call.ownerThreadId,
            {
              ...event.subagent,
              parentSubagentId: event.subagent.parentSubagentId ?? call.id
            }
          )
        : this.requireProjectedSubagentActivity(call, event.subagent.id)
      return {
        type: 'subagent_updated',
        runId: call.parentRunId,
        threadId: call.parentThreadId,
        subagent: nested
      }
    }
    if (event.type === 'run_interrupted') {
      const transition = this.database.markSubagentCallInterrupted(call.id, call.ownerThreadId)
      if (!transition) return undefined
      this.notifySubagent(call.id)
      return {
        type: 'subagent_updated',
        runId: call.parentRunId,
        threadId: call.parentThreadId,
        subagent: transition.activity
      }
    }
    if (event.type === 'run_completed') {
      let childSnapshot = event.snapshot
      if (!childSnapshot) {
        try {
          childSnapshot = await this.readSnapshot(call.childThreadId)
        } catch (reason) {
          const message = `Subagent completed, but its final result could not be read: ${errorMessage(reason)}`
          const transition = this.database.recordSubagentRecoveryFailure(
            call.id,
            call.ownerThreadId,
            message
          )
          runtimeLog('warn', 'subagent', message, {
            subagentId: call.id,
            childRunId: call.childRunId
          })
          if (!transition) return undefined
          this.notifySubagent(call.id)
          return {
            type: 'subagent_updated',
            runId: call.parentRunId,
            threadId: call.parentThreadId,
            subagent: transition.activity
          }
        }
      }
      const final = childSnapshot.messages.filter((message) => message.role === 'assistant').at(-1)
      const result = final ? traceText(final.content, 'text') : ''
      const transition = this.database.finishSubagentCall({
        subagentId: call.id,
        ownerThreadId: call.ownerThreadId,
        status: 'completed',
        result
      })
      if (!transition) return undefined
      this.notifySubagent(call.id)
      return {
        type: 'subagent_updated',
        runId: call.parentRunId,
        threadId: call.parentThreadId,
        subagent: transition.activity
      }
    }
    if (event.type === 'run_recovery_failed') {
      const transition = this.database.recordSubagentRecoveryFailure(
        call.id,
        call.ownerThreadId,
        event.error
      )
      if (!transition) return undefined
      this.notifySubagent(call.id)
      return {
        type: 'subagent_updated',
        runId: call.parentRunId,
        threadId: call.parentThreadId,
        subagent: transition.activity
      }
    }
    if (event.type === 'run_failed' || event.type === 'run_cancelled') {
      const transition = this.database.finishSubagentCall({
        subagentId: call.id,
        ownerThreadId: call.ownerThreadId,
        status: event.type === 'run_failed' ? 'failed' : 'cancelled',
        ...(event.type === 'run_failed' ? { error: event.error } : {})
      })
      if (!transition) return undefined
      this.notifySubagent(call.id)
      return {
        type: 'subagent_updated',
        runId: call.parentRunId,
        threadId: call.parentThreadId,
        subagent: transition.activity
      }
    }
    return undefined
  }

  private requireProjectedModelActivity(
    call: AgentSubagentCallRecord,
    modelId: string,
    subagentId: string
  ): AgentModelActivity {
    const model = this.database.getModelActivity(call.parentRunId, modelId)
    if (!model || model.subagentId !== subagentId) {
      throw new Error(`Model activity ${modelId} was not projected for subagent ${subagentId}.`)
    }
    return model
  }

  private requireProjectedToolActivity(
    call: AgentSubagentCallRecord,
    callId: string,
    subagentId: string
  ): AgentToolActivity {
    const tool = this.database.getToolActivity(call.parentRunId, callId, subagentId)
    if (!tool) {
      throw new Error(`Tool activity ${callId} was not projected for subagent ${subagentId}.`)
    }
    return tool
  }

  private requireProjectedSubagentActivity(
    call: AgentSubagentCallRecord,
    subagentId: string
  ): AgentSubagentActivity {
    const subagent = this.database.getSubagentActivity(call.parentRunId, subagentId)
    if (!subagent) {
      throw new Error(`Subagent activity ${subagentId} was not projected for run ${call.parentRunId}.`)
    }
    return subagent
  }

  private async execute(
    runId: string,
    input: unknown,
    queue: EventQueue,
    active: ActiveRun,
    continuation = false
  ): Promise<void> {
    const thread = this.database.getThread(active.threadId)
    let instance: RuntimeAgentInstance | undefined
    let subagentRuntime: SubagentToolRuntime | undefined
    let modelActivities: ModelActivityCoordinator | undefined
    let cleanupFileEdits = false
    let terminalEventPublished = false
    let contextStatusPublished = false
    let contextProjectionCommitted = false
    let pendingTerminalEvent: AgentTerminalRuntimeEvent | undefined
    try {
      if (!thread) throw new Error(`Thread ${active.threadId} was not found.`)
      const executingSubagent = this.database.getSubagentCallByChildRunId(runId)
      subagentRuntime = this.subagentRuntimeForRun(thread, runId, queue, executingSubagent)
      this.database.checkpointer.retainRun(runId, active.threadId)
      instance = await this.instanceFactory(thread, this.database, {
        requestId: runId,
        configuration: this.database.getRunConfiguration(runId),
        parentConfiguration: executingSubagent ? this.database.getRunConfiguration(executingSubagent.parentRunId) : undefined,
        onConfigurationResolved: (value) => this.database.resolveRunConfiguration(runId, value),
        signal: active.controller.signal,
        onCompressionStart: () => {
          const summary = this.database.recordContextSummaryStarted(runId)
          queue.push({
            type: 'context_compression_started',
            runId,
            threadId: active.threadId,
            summary
          })
          return summary.id
        },
        onCompressionCompleted: (summaryId, summaryText, completion) => {
          this.database.stageContextSummary(runId, summaryId, {
            summaryText,
            ...(completion
              ? {
                  modelContent: completion.modelContent,
                  cutoffIndex: completion.cutoffIndex,
                  activatedAfterMessageIndex: completion.activatedAfterMessageIndex,
                  coveredThroughMessageId: completion.coveredThroughMessageId,
                  firstPreservedMessageId: completion.firstPreservedMessageId,
                  inputTokensBefore: completion.inputTokensBefore,
                  inputTokensAfter: completion.inputTokensAfter
                }
              : {})
          })
        },
        onCompressionFailed: (summaryId) => {
          this.database.deleteContextSummary(runId, summaryId)
          queue.push({
            type: 'context_compression_discarded',
            runId,
            threadId: active.threadId,
            summaryId
          })
        },
        onContextStatus: (status) => {
          contextStatusPublished = true
          this.database.recordContextStatus(active.threadId, status)
          queue.push({
            type: 'context_status_updated',
            runId,
            threadId: active.threadId,
            status
          })
        },
        onMemoryRecall: (details) => {
          const recall = this.database.recordMemoryRecall(runId, {
            id: memoryRecallId(details),
            ...details
          })
          queue.push({
            type: 'memory_recalled',
            runId,
            threadId: active.threadId,
            recall
          })
        },
        takeDirectionMessages: (afterToolCallIds) => this.applyQueuedDirections(
          runId,
          active,
          queue,
          afterToolCallIds
        ),
        managedCalls: this.managedCalls,
        subagents: subagentRuntime,
        subagentCall: executingSubagent
      })
      active.context = instance.context
      if (continuation) {
        // A continuation must not start from application activity state that
        // is ahead of the durable root checkpoint. If this projection cannot
        // be reconciled, pause the recoverable run and let the same durable
        // classifier/reporting path expose a retryable recovery failure.
        await this.reconcileRootActivitiesAtRunCheckpoint(active.threadId, runId)
      }
      const stream = await instance.agent.streamEvents(input, {
        version: 'v3',
        configurable: { thread_id: active.threadId },
        durability: 'sync',
        signal: active.controller.signal,
        tags: [`anas:thread:${active.threadId}`, `anas:run:${runId}`]
      })
      active.stream = stream
      if (active.cancelled || active.controller.signal.aborted) {
        stream.abort(active.controller.signal.reason)
      }
      const coordinator = new ModelActivityCoordinator(
        (subagentId) => {
          const id = randomUUID()
          const started = this.database.recordModelActivity(runId, {
            id,
            status: 'running',
            subagentId,
            text: '',
            reasoning: '',
            toolCallIds: []
          })
          queue.push({
            type: 'model_started',
            runId,
            threadId: active.threadId,
            model: started
          })
          return id
        },
        (id) => {
          this.database.discardModelActivity(runId, id)
        }
      )
      modelActivities = coordinator

      const settled = await Promise.allSettled([
        stream.output,
        this.consumeMessages(
          stream.messages,
          runId,
          active.threadId,
          queue,
          coordinator
        ),
        this.consumeToolCalls(stream.toolCalls, runId, active.threadId, queue),
        consumeProtocolActivities(stream, {
          onInterrupted: (interrupted) => {
            this.recordInterruptedToolActivity(
              runId,
              active.threadId,
              interrupted,
              queue
            )
          },
          onModelTaskStarted: (key, subagentId) => {
            coordinator.startTask(key, subagentId)
          },
          onRootCheckpoint: async (_checkpointId, values) => {
            // Schema validation failures and approval rejections become durable
            // ToolMessages without entering the tool execution stream. Project
            // those results as soon as their root checkpoint is committed so
            // the UI observes the completed tool before the next model round.
            this.reconcileRootToolActivities(
              runId,
              active.threadId,
              queue
            )
            this.publishCommittedContextSummary(
              runId,
              active.threadId,
              values,
              queue
            )
            await this.consumeCommittedQueuedDirections(runId, active, values)
          }
        })
      ])
      const outputResult = settled[0]
      if (outputResult.status === 'rejected') throw outputResult.reason
      const rejectedConsumer = settled.slice(1).find(
        (result): result is PromiseRejectedResult => result.status === 'rejected'
      )
      const output = outputResult.value

      // The graph checkpoint is authoritative. Once its terminal lifecycle
      // node is durable, derived activity/summary/status projections must not
      // downgrade the run if they fail; a later snapshot can rebuild them.
      const checkpointState = this.database.getRunCheckpointState(runId)
      const terminalCompleted = Boolean(
        checkpointState.terminalCheckpointId
        && checkpointState.terminalCheckpointId === checkpointState.lastCommittedCheckpointId
      )
      const run = terminalCompleted
        ? this.database.finishRun(runId, 'completed')
        : active.cancelled
          ? this.database.finishRun(runId, 'cancelled')
          : stream.interrupted
            ? this.database.finishRun(runId, 'interrupted')
            : this.database.finishRun(runId, 'completed')
      cleanupFileEdits = run.status !== 'interrupted'

      const projectionFailure = (reason: unknown): void => {
        runtimeLog('warn', 'agent', 'A terminal run projection failed.', {
          runId,
          error: errorMessage(reason)
        })
      }
      if (rejectedConsumer) projectionFailure(rejectedConsumer.reason)
      try {
        coordinator.discardUnclaimed()
      } catch (error) {
        projectionFailure(error)
      }

      let durableCheckpoint: DurableRunRootCheckpoint | undefined
      try {
        durableCheckpoint = await this.durableRunRootCheckpoint(active.threadId, runId)
      } catch (error) {
        projectionFailure(error)
      }
      if (run.status !== 'interrupted') {
        try {
          durableCheckpoint = await this.reconcileRootActivitiesAtRunCheckpoint(
            active.threadId,
            runId
          )
        } catch (error) {
          projectionFailure(error)
        }
      }
      const values = durableCheckpoint?.values ?? output
      try {
        // Publish completion after the canonical state has restored activities
        // that had no corresponding tool execution stream (for example a rejection).
        this.reconcileRootToolActivities(runId, active.threadId, queue)
      } catch (error) {
        projectionFailure(error)
      }
      try {
        this.publishCommittedContextSummary(runId, active.threadId, values, queue)
      } catch (error) {
        projectionFailure(error)
      }
      let contextStatus: Awaited<ReturnType<AgentContextRuntime['status']>> | undefined
      if (instance.context) {
        try {
          contextStatus = await instance.context.projectedStatus(values)
          this.database.recordContextStatus(active.threadId, contextStatus)
          contextProjectionCommitted = true
        } catch (error) {
          projectionFailure(error)
        }
      }
      if (run.operation === 'compression' && contextStatus) {
        queue.push({
          type: 'context_status_updated',
          runId,
          threadId: active.threadId,
          status: contextStatus
        })
      }

      if (run.status === 'cancelled') {
        pendingTerminalEvent = { type: 'run_cancelled', run }
        terminalEventPublished = true
      } else if (run.status === 'interrupted') {
        let interrupts: AgentInterrupt[] | undefined
        try {
          interrupts = await projectInterruptPathPreviews(
            durableApprovalInterrupts(
              runId,
              durableCheckpoint?.id,
              durableCheckpoint?.pendingWrites
            ),
            instance.workspace?.primaryFolder,
            durableCheckpoint?.values
          )
        } catch (error) {
          projectionFailure(error)
        }
        const projectedInterrupts = interrupts ?? []
        const snapshot = durableCheckpoint?.id && interrupts
          ? this.tryBuildSnapshot(
              values,
              active.threadId,
              projectedInterrupts,
              contextStatus,
              runId
            )
          : undefined
        queue.push({
          type: 'run_interrupted',
          run,
          interrupts: projectedInterrupts,
          ...(snapshot ? { snapshot } : {})
        })
        terminalEventPublished = true
      } else {
        const snapshot = durableCheckpoint?.id
          ? this.tryBuildSnapshot(
              values,
              active.threadId,
              [],
              contextStatus,
              runId
            )
          : undefined
        pendingTerminalEvent = {
          type: 'run_completed',
          run,
          ...(snapshot ? { snapshot } : {})
        }
        terminalEventPublished = true
      }
    } catch (error) {
      try {
        modelActivities?.discardUnclaimed()
      } catch (discardError) {
        runtimeLog('warn', 'agent', 'Failed to discard an unclaimed model activity.', {
          runId,
          error: errorMessage(discardError)
        })
      }
      const existing = this.database.getRun(runId)
      if (existing && existing.status !== 'running') {
        runtimeLog('warn', 'agent', 'A finished run projection failed.', {
          runId,
          status: existing.status,
          error: errorMessage(error)
        })
        cleanupFileEdits = existing.status !== 'interrupted'
        if (!terminalEventPublished) {
          let checkpoint: DurableRunRootCheckpoint | undefined
          try {
            checkpoint = existing.status === 'interrupted'
              ? await this.durableRunRootCheckpoint(active.threadId, runId)
              : await this.reconcileRootActivitiesAtRunCheckpoint(active.threadId, runId)
          } catch (stateError) {
            runtimeLog('warn', 'agent', 'Failed to read a finished run projection.', {
              runId,
              error: errorMessage(stateError)
            })
          }
          if (existing.status === 'completed') {
            const snapshot = !checkpoint?.id
              ? undefined
              : this.tryBuildSnapshot(
                  checkpoint.values,
                  active.threadId,
                  [],
                  undefined,
                  runId
                )
            pendingTerminalEvent = {
              type: 'run_completed',
              run: existing,
              ...(snapshot ? { snapshot } : {})
            }
          } else if (existing.status === 'interrupted') {
            let interrupts: AgentInterrupt[] | undefined
            try {
              interrupts = await projectInterruptPathPreviews(
                durableApprovalInterrupts(
                  runId,
                  checkpoint?.id,
                  checkpoint?.pendingWrites
                ),
                instance?.workspace?.primaryFolder,
                checkpoint?.values
              )
            } catch (interruptError) {
              runtimeLog('warn', 'agent', 'Failed to rebuild an interrupt projection.', {
                runId,
                error: errorMessage(interruptError)
              })
            }
            const projectedInterrupts = interrupts ?? []
            const snapshot = !checkpoint?.id || interrupts === undefined
              ? undefined
              : this.tryBuildSnapshot(
                  checkpoint.values,
                  active.threadId,
                  projectedInterrupts,
                  undefined,
                  runId
                )
            queue.push({
              type: 'run_interrupted',
              run: existing,
              interrupts: projectedInterrupts,
              ...(snapshot ? { snapshot } : {})
            })
          } else if (existing.status === 'cancelled') {
            pendingTerminalEvent = { type: 'run_cancelled', run: existing }
          } else {
            pendingTerminalEvent = {
              type: 'run_failed',
              run: existing,
              error: existing.error ?? errorMessage(error)
            }
          }
        }
        return
      }
      if (!existing) throw new Error(`Run ${runId} was not found.`)
      const durability = this.database.classifyRunningRun(runId)
      const checkpointState = this.database.getRunCheckpointState(runId)
      const unstartedFreshInputFailure = Boolean(
        !continuation
        && this.database.getRunInputIntent(runId)
        && checkpointState.lastWriteCheckpointId === undefined
        && checkpointState.lastCommittedCheckpointId === undefined
      )
      if (durability === 'recoverable' && !unstartedFreshInputFailure && !isProjectRulesError(error)
        && !isModelSelectionError(error) && !isModelRequestChangedError(error)) {
        // LangGraph may have synchronously persisted a task result, resume
        // command, child interrupt, or root checkpoint before its API surfaced
        // a persistence/assembly error. The exact root tuple remains the
        // framework continuation source; consuming the run would repeat or
        // forget durable work.
        let snapshot: AgentThreadSnapshot | undefined
        let interrupts: AgentInterrupt[] = []
        try {
          const tuple = await this.durableRunRootTuple(active.threadId, runId)
          const values = tuple?.checkpoint.channel_values ?? {}
          const checkpointState = this.database.getRunCheckpointState(runId)
          if (!checkpointState.resumeIntent) {
            interrupts = await projectInterruptPathPreviews(
              durableApprovalInterrupts(
                runId,
                tuple?.checkpoint.id,
                tuple?.pendingWrites
              ),
              instance?.workspace?.primaryFolder,
              values
            )
          }
          this.database.reconcileRootActivities(
            runId,
            durableRootActivityEvidence(values, runId)
          )
          snapshot = this.tryBuildSnapshot(
            values,
            active.threadId,
            interrupts,
            undefined,
            runId
          )
        } catch (projectionError) {
          runtimeLog('warn', 'agent', 'Failed to read a recoverable run checkpoint.', {
            runId,
            error: errorMessage(projectionError)
          })
        }
        queue.push({
          type: 'run_recovery_failed',
          run: existing,
          error: errorMessage(error),
          ...(snapshot ? { snapshot } : {})
        })
        return
      }
      if (durability === 'terminal') {
        const run = this.database.finishRun(runId, 'completed')
        cleanupFileEdits = true
        let values: unknown
        try {
          values = (await this.reconcileRootActivitiesAtRunCheckpoint(
            active.threadId,
            runId
          ))?.values ?? {}
        } catch (stateError) {
          runtimeLog('warn', 'agent', 'Failed to read a terminal run checkpoint projection.', {
            runId,
            error: errorMessage(stateError)
          })
        }
        const snapshot = values === undefined
          ? undefined
          : this.tryBuildSnapshot(
              values,
              active.threadId,
              [],
              undefined,
              runId
            )
        pendingTerminalEvent = {
          type: 'run_completed',
          run,
          ...(snapshot ? { snapshot } : {})
        }
      } else if (durability === 'cancellation') {
        const run = this.database.finishRun(runId, 'cancelled')
        cleanupFileEdits = true
        try {
          await this.reconcileRootActivitiesAtRunCheckpoint(active.threadId, runId)
        } catch (activityError) {
          runtimeLog('warn', 'agent', 'Failed to reconcile cancelled run activities.', {
            runId,
            error: errorMessage(activityError)
          })
        }
        pendingTerminalEvent = { type: 'run_cancelled', run }
      } else {
        const message = errorMessage(error)
        const run = this.database.finishRun(runId, 'failed', message)
        cleanupFileEdits = true
        try {
          await this.reconcileRootActivitiesAtRunCheckpoint(active.threadId, runId)
        } catch (activityError) {
          runtimeLog('warn', 'agent', 'Failed to reconcile failed run activities.', {
            runId,
            error: errorMessage(activityError)
          })
        }
        pendingTerminalEvent = { type: 'run_failed', run, error: message }
      }
    } finally {
      let cleanupRun: AgentRun | undefined
      const publishCleanup = (cleanup: NonNullable<AgentRun['backgroundCleanup']>, reply?: AgentMessage): void => {
        if (!cleanupRun) return
        try {
          cleanupRun = this.database.updateRunBackgroundCleanup(runId, cleanup)
        } catch (error) {
          runtimeLog('warn', 'agent', 'Failed to persist background cleanup progress.', { runId, error: errorMessage(error) })
          cleanup = { status: cleanup.status === 'running' ? 'running' : 'unconfirmed',
            report: `${cleanup.report}\nCould not persist cleanup progress: ${errorMessage(error)}` }
          cleanupRun = { ...cleanupRun, backgroundCleanup: cleanup }
        }
        queue.push({ type: 'run_cleanup', run: cleanupRun, cleanup, reply })
        if (pendingTerminalEvent?.type === 'run_completed') pendingTerminalEvent = { ...pendingTerminalEvent, run: cleanupRun }
      }
      try {
        try {
          if (contextStatusPublished && !contextProjectionCommitted) {
            // Request preparation can publish a smaller, summarized projection
            // before the graph commits it. Once the request stops, derive the
            // display from the checkpoint that actually survived the failure.
            let status: AgentContextStatus | undefined
            try {
              const tuple = await this.database.checkpointer.getTuple({
                configurable: { thread_id: active.threadId, checkpoint_ns: '' }
              })
              if (tuple && instance?.context) {
                status = await instance.context.projectedStatus(tuple.checkpoint.channel_values)
              }
            } catch (error) {
              runtimeLog('warn', 'agent', 'Failed to restore the durable context status.', {
                runId, error: errorMessage(error)
              })
            }
            if (status) this.database.recordContextStatus(active.threadId, status)
            else this.database.clearContextStatus(active.threadId)
            queue.push({ type: 'context_status_updated', runId, threadId: active.threadId, status })
            if (pendingTerminalEvent?.type === 'run_completed' && pendingTerminalEvent.snapshot) {
              pendingTerminalEvent.snapshot.contextStatus = status
            }
          }
        } catch (error) {
          runtimeLog('warn', 'agent', 'Failed to publish the restored context status.', {
            runId, error: errorMessage(error)
          })
        }
        // Reporting must never prevent disposal, cancellation, or run release.
        // A checkpointed final reply still completes the model run.
        try {
          const run = this.database.getRun(runId)
          if (run?.status === 'completed' && hasUnresolvedBackgroundTasks(this.database, active.threadId)) {
            cleanupRun = run
            let reply: AgentMessage | undefined
            try {
              const snapshot = pendingTerminalEvent?.type === 'run_completed' && pendingTerminalEvent.snapshot
                ? pendingTerminalEvent.snapshot : await this.readSnapshot(active.threadId)
              reply = [...snapshot.messages].reverse().find((item) => item.runId === runId && item.role === 'assistant')
            } catch (error) {
              runtimeLog('warn', 'agent', 'Failed to publish the checkpoint reply before background cleanup.', {
                runId, error: errorMessage(error)
              })
            }
            publishCleanup({ status: 'running', report: backgroundTasksPendingError }, reply)
          }
        } catch (error) {
          runtimeLog('warn', 'agent', 'Failed to inspect unresolved background work.', { runId, error: errorMessage(error) })
        }
        try {
          await instance?.dispose()
        } catch (error) {
          runtimeLog('warn', 'agent', 'Failed to dispose an agent runtime instance.', {
            runId, error: errorMessage(error)
          })
        }
        if (cleanupFileEdits) {
          await this.drainPendingFileEditCleanup()
        }
        await this.reconcileCommittedQueuedDirections(runId, active)
        await this.cleanupUnappliedDirectionAttachments(runId, active)

        // This call either terminalizes the run synchronously before returning a
        // projection promise, or returns without yielding. Once it reports no
        // late cancellation, remove the active marker without another await so
        // cancellation cannot land in an unowned gap.
        const lateCancellation = this.settleLateActiveCancellation(runId, active)
        if (lateCancellation) {
          cleanupFileEdits = true
          pendingTerminalEvent = await lateCancellation
        }
        const settledStatus = this.database.getRun(runId)?.status
        const shouldSettleBackgroundWork = settledStatus === 'completed'
          || settledStatus === 'failed'
          || settledStatus === 'cancelled'
        if (shouldSettleBackgroundWork) {
          // The run may have become cancelled while an already-interrupted
          // executor was disposing. Base cleanup on the final durable status,
          // not the earlier projection snapshot.
          await this.drainPendingFileEditCleanup()
          try {
            if (cleanupRun) {
              await cleanupUnresolvedBackgroundTasks({
                database: this.database,
                managedCalls: this.managedCalls,
                threadId: active.threadId,
                runId,
                cancelSubagents: (list) => {
                  const cancellation = this.cancelSubagentCalls(list)
                  this.track(cancellation)
                  return cancellation
                },
                subagentIsActive: (call) => this.activeRuns.has(call.childRunId)
                  || (this.subagentForwardTasks.get(call.id)?.size ?? 0) > 0
                  || this.runBackgroundSettlementTasks.has(call.childRunId),
                report: publishCleanup
              })
            } else {
              await this.settleRunBackgroundWork(
                runId,
                'Agent run stopped before its background work was resolved.',
                subagentRuntime
              )
            }
          } catch (error) {
            runtimeLog('warn', 'agent', 'Agent run background settlement did not finish cleanly.', {
              runId,
              error: errorMessage(error)
            })
            if (cleanupRun) {
              publishCleanup({ status: 'unconfirmed',
                report: `${cleanupRun.backgroundCleanup?.report ?? backgroundTasksPendingError}\n${backgroundCleanupUnconfirmed}\n${errorMessage(error)}` })
            }
          }
          const settledRun = this.database.getRun(runId)
          if (settledRun && !pendingTerminalEvent) {
            pendingTerminalEvent = settledRun.status === 'completed'
              ? { type: 'run_completed', run: settledRun }
              : settledRun.status === 'cancelled'
                ? { type: 'run_cancelled', run: settledRun }
                : settledRun.status === 'failed'
                  ? {
                      type: 'run_failed',
                      run: settledRun,
                      error: settledRun.error ?? 'Agent run failed.'
                    }
                  : undefined
          }
          if (
            pendingTerminalEvent?.type === 'run_completed'
            && pendingTerminalEvent.snapshot
            && (pendingTerminalEvent.run.backgroundCleanup || this.database.listSubagentCallsForParentRun(runId).length > 0)
          ) {
            try {
              pendingTerminalEvent = {
                ...pendingTerminalEvent,
                snapshot: await this.readSnapshot(active.threadId)
              }
            } catch (error) {
              runtimeLog('warn', 'agent', 'Failed to refresh the settled run snapshot.', {
                runId,
                error: errorMessage(error)
              })
            }
          }
          if (pendingTerminalEvent?.type === 'run_completed' && pendingTerminalEvent.snapshot) {
            // Snapshots fetched during disposal carry its owner. The terminal
            // event instead hands the renderer the settled projection, even
            // when storing the cleanup report itself failed.
            const snapshot = pendingTerminalEvent.snapshot
            // Selection and other thread metadata remain editable while the
            // executor disposes. Bind them at publication, after the last await.
            const currentThread = this.database.getThread(active.threadId)
            pendingTerminalEvent = { ...pendingTerminalEvent, snapshot: currentThread ? {
              ...snapshot, thread: currentThread, settlingRun: undefined,
              activities: snapshot.activities.map((activity) => activity.runId === runId && cleanupRun
                ? { ...activity, backgroundCleanup: cleanupRun.backgroundCleanup } : activity)
            } : undefined }
          }
          if (pendingTerminalEvent) queue.push(pendingTerminalEvent)
        }
      } finally {
        try {
          await this.releaseSettledRunState(runId)
        } catch (error) {
          runtimeLog('warn', 'agent', 'Failed to release settled run state.', {
            runId,
            error: errorMessage(error)
          })
        }
        if (this.activeRuns.get(runId) === active) {
          this.activeRuns.delete(runId)
          this.notifyRunStopped(runId)
        }
        queue.close()
      }
    }
  }

  private async cleanupUnappliedDirectionAttachments(
    runId: string,
    active: ActiveRun
  ): Promise<void> {
    const directions = active.directions
    active.directions = []
    await this.cleanupDirectionAttachmentStaging(runId, directions)
  }

  private async reconcileCommittedQueuedDirections(
    runId: string,
    active: ActiveRun
  ): Promise<void> {
    if (active.appliedDirectionIds.size === 0) return
    try {
      const checkpoint = await this.durableRunRootCheckpoint(active.threadId, runId)
      if (checkpoint) {
        await this.consumeCommittedQueuedDirections(runId, active, checkpoint.values)
      }
    } catch (reason) {
      runtimeLog('warn', 'agent', 'Failed to reconcile committed queued directions.', {
        runId,
        threadId: active.threadId,
        error: errorMessage(reason)
      })
    }
  }

  private directionAttachmentStagingRoot(): string {
    return join(this.temporaryRoot, 'agent-direction')
  }

  private async cleanupDirectionAttachmentStaging(
    runId: string,
    directions: ActiveRun['directions']
  ): Promise<void> {
    const attachments = directions.flatMap((direction) => direction.stagedAttachments)
    if (attachments.length === 0) return
    try {
      await deleteArchivedAgentAttachments(
        attachments.map(({ artifact }) => artifact),
        this.directionAttachmentStagingRoot()
      )
    } catch (reason) {
      runtimeLog('warn', 'agent', 'Failed to clean unapplied direction attachments.', {
        runId,
        error: errorMessage(reason)
      })
    }
  }

  private settleLateActiveCancellation(
    runId: string,
    active: ActiveRun
  ): Promise<AgentTerminalRuntimeEvent> | undefined {
    if (!active.cancelled) return undefined
    const current = this.database.getRun(runId)
    if (!current || current.status !== 'running') return undefined
    const durability = this.database.classifyRunningRun(runId)
    if (durability === 'terminal') {
      const run = this.database.finishRun(runId, 'completed')
      return (async () => {
        let checkpoint: DurableRunRootCheckpoint | undefined
        try {
          checkpoint = await this.reconcileRootActivitiesAtRunCheckpoint(
            active.threadId,
            runId
          )
        } catch (error) {
          runtimeLog('warn', 'agent', 'Failed to reconcile a late terminal run projection.', {
            runId,
            error: errorMessage(error)
          })
        }
        const snapshot = checkpoint?.id
          ? this.tryBuildSnapshot(
              checkpoint.values,
              active.threadId,
              [],
              undefined,
              runId
            )
          : undefined
        return {
          type: 'run_completed',
          run,
          ...(snapshot ? { snapshot } : {})
        }
      })()
    }
    if (durability !== 'cancellation') return undefined
    const run = this.database.finishRun(runId, 'cancelled')
    return (async () => {
      try {
        await this.reconcileRootActivitiesAtRunCheckpoint(active.threadId, runId)
      } catch (error) {
        runtimeLog('warn', 'agent', 'Failed to reconcile a late cancelled run projection.', {
          runId,
          error: errorMessage(error)
        })
      }
      return { type: 'run_cancelled', run }
    })()
  }

  private async prepareRegeneration(
    input: AgentMessageRegenerateExecutionInput,
    queue: EventQueue
  ): Promise<ReturnType<AgentDatabase['createRun']>> {
    const thread = this.database.getThread(input.threadId)
    if (!thread) throw new Error(`Thread ${input.threadId} was not found.`)
    const tuple = await this.database.checkpointer.getTuple({
      configurable: { thread_id: input.threadId, checkpoint_ns: '' }
    })
    const messages = stateMessages(tuple?.checkpoint.channel_values)
    const messageIndex = messages.findIndex((message) => message.id === input.messageId)
    if (messageIndex < 0) throw new Error(`Message ${input.messageId} was not found.`)
    let target = messages[messageIndex]
    const mapped = toAgentMessage(target, input.messageId)
    if (mapped.role !== 'user' || !HumanMessage.isInstance(target)) {
      throw new Error('Only user messages can be resent.')
    }
    if (!mapped.runId) throw new Error(`Message ${input.messageId} is missing its run association.`)
    if (mapped.skillInvocation) {
      if (!input.skillPromptText) {
        throw new Error('Skill instructions must be refreshed before regenerating this message.')
      }
      target = replaceHumanMessageText(target, input.skillPromptText)
    } else if (input.skillPromptText !== undefined) {
      throw new Error('Skill instructions were provided for a non-skill message.')
    }
    target = new HumanMessage({
      id: target.id,
      name: target.name,
      content: target.content,
      additional_kwargs: {
        ...target.additional_kwargs,
        anas_run_id: input.runId,
        anas_created_at: new Date().toISOString()
      },
      response_metadata: { ...target.response_metadata }
    })
    const inputIntent: AgentRunInputIntent = {
      kind: 'regeneration',
      message: target.toDict()
    }
    const affectedRunIds = this.database.listRunIdsFrom(input.threadId, mapped.runId)
    await this.cancelManagedCallsForHistoryChange(affectedRunIds)
    await this.cancelSubagentsForHistoryChange(input.threadId, affectedRunIds)
    const changed = await this.database.replaceMessageHistory(
      input.threadId,
      messages.slice(0, messageIndex),
      mapped.runId,
      { runId: input.runId, inputIntent }
    )
    await this.drainPendingAttachmentCleanup()
    const run = changed.run
    if (!run) throw new Error(`Failed to create regeneration run ${input.runId}.`)
    const active: ActiveRun = {
      threadId: input.threadId,
      controller: new AbortController(),
      cancelled: false,
      appliedDirectionIds: new Set(),
      directions: []
    }
    this.activeRuns.set(run.id, active)
    queue.push({ type: 'run_started', run, newUserTurn: false })
    const durableInputIntent = this.database.getRunInputIntent(run.id)
    if (!durableInputIntent) throw new Error(`Regeneration run ${run.id} has no durable input.`)
    this.launchExecution(
      run.id,
      graphInputForRunIntent(run, durableInputIntent).input,
      queue,
      active
    )
    return run
  }

  private async reconcileRootActivitiesAtRunCheckpoint(
    threadId: string,
    runId: string
  ): Promise<DurableRunRootCheckpoint | undefined> {
    const checkpoint = await this.durableRunRootCheckpoint(threadId, runId)
    if (!checkpoint) return undefined
    this.database.reconcileRootActivities(
      runId,
      durableRootActivityEvidence(checkpoint.values, runId)
    )
    return checkpoint
  }

  private async durableRunRootCheckpoint(
    threadId: string,
    runId: string
  ): Promise<DurableRunRootCheckpoint | undefined> {
    const tuple = await this.durableRunRootTuple(threadId, runId)
    return tuple
      ? {
          id: tuple.checkpoint.id,
          values: tuple.checkpoint.channel_values,
          pendingWrites: tuple.pendingWrites
        }
      : undefined
  }

  private async durableRunRootTuple(
    threadId: string,
    runId: string
  ) {
    const run = this.database.getRun(runId)
    if (!run || run.threadId !== threadId) {
      throw new Error(`Run ${runId} does not belong to thread ${threadId}.`)
    }
    const checkpointId = this.database.getRunCheckpointState(runId).lastCommittedCheckpointId
    const head = this.database.checkpointer.getCurrentHead(threadId)
    if (!checkpointId || head?.checkpointId !== checkpointId) return undefined
    const tuple = await this.database.checkpointer.getTuple({
      configurable: {
        thread_id: threadId,
        checkpoint_ns: '',
        checkpoint_id: checkpointId
      }
    })
    return tuple
  }

  private publishCommittedContextSummary(
    runId: string,
    threadId: string,
    values: unknown,
    queue: EventQueue
  ): void {
    const event = summarizationEvent(values)
    const id = event?.summaryId
    if (!id) return
    const published = this.publishedContextSummaries.get(runId) ?? new Set<string>()
    if (published.has(id)) return
    const committed = this.database.getCommittedContextSummary(runId, id)
    if (!committed || committed.modelContent !== event.summaryMessage.text || committed.cutoffIndex !== event.cutoffIndex) return
    this.publishContextSummaryProjection(runId, threadId, committed, queue)
    published.add(id)
    this.publishedContextSummaries.set(runId, published)
  }

  private publishContextSummaryProjection(
    runId: string,
    threadId: string,
    committed: StoredContextSummary,
    queue: EventQueue
  ): void {
    const sequence = committed.firstPreservedMessageId
      ? this.database.getMessageActivitySequence(committed.runId, committed.firstPreservedMessageId)
      : undefined
    queue.push({
      type: 'context_compression_completed',
      runId,
      threadId,
      summary: sequence === undefined
        ? committed
        : { ...committed, firstPreservedActivitySequence: sequence }
    })
  }

  private async consumeMessages(
    messages: AsyncIterable<RuntimeMessageStream>,
    runId: string,
    threadId: string,
    queue: EventQueue,
    modelActivities: ModelActivityCoordinator,
    subagentId?: string
  ): Promise<void> {
    let index = 0
    for await (const message of messages) {
      if (message.node && message.node !== modelRequestTaskName) {
        await Promise.all([
          message.output,
          (async () => { for await (const _delta of message.text) { /* drain */ } })(),
          (async () => { for await (const _delta of message.reasoning) { /* drain */ } })()
        ])
        continue
      }
      let streamedText = ''
      let streamedReasoning = ''
      const id = modelActivities.claim(message, subagentId)
      let publishedProgress = false
      const publishProgress = (progress: AgentModelActivity['toolCallProgress']) => {
        if (!progress?.length && !publishedProgress) return
        publishedProgress = true
        const event: Extract<AgentRuntimeEvent, { type: 'model_tool_calls' }> = {
          type: 'model_tool_calls', runId, threadId, modelId: id, subagentId,
          progress: progress ?? []
        }
        this.rememberToolCallProgress(event)
        queue.push(event)
      }
      const argumentProgress = new ToolArgumentProgress(publishProgress)
      const emitToolArguments = async () => {
        for await (const event of message) argumentProgress.accept(event)
        argumentProgress.flush()
      }
      const emitText = async () => {
        for await (const delta of message.text) {
          streamedText += delta
          queue.push({
            type: 'model_delta',
            runId,
            threadId,
            modelId: id,
            subagentId,
            delta: { type: 'text', text: delta }
          })
        }
      }
      const emitReasoning = async () => {
        for await (const delta of message.reasoning) {
          streamedReasoning += delta
          queue.push({
            type: 'model_delta',
            runId,
            threadId,
            modelId: id,
            subagentId,
            delta: { type: 'reasoning', text: delta }
          })
        }
      }
      try {
        const [completed] = await Promise.all([
          message.output,
          emitText(),
          emitReasoning(),
          emitToolArguments()
        ]).catch((error) => {
          this.database.recordModelActivity(runId, {
            id,
            status: 'running',
            subagentId,
            text: '',
            reasoning: '',
            toolCallIds: []
          })
          throw error
        })
        if (!subagentId && !completed.id) {
          throw new Error('LangGraph completed a root model response without a stable message id.')
        }
        const mapped = toAgentMessage(completed, `${runId}:assistant:${index}`)
        const aiMessage = completed as BaseMessage & {
          usage_metadata?: unknown
          response_metadata?: unknown
        }
        runtimeLog('debug', 'agent', 'Model response metadata.', {
          runId,
          threadId,
          modelId: id,
          subagentId,
          usage: aiMessage.usage_metadata,
          responseMetadata: aiMessage.response_metadata
        })
        const calls = modelToolCalls(completed)
        const model: Omit<
          AgentModelActivity,
          'sequence' | 'startedAt' | 'completedAt'
        > = {
          id,
          messageId: completed.id ?? mapped.id,
          status: 'completed',
          subagentId,
          text: traceText(mapped.content, 'text') || streamedText,
          reasoning: traceText(mapped.content, 'reasoning') || streamedReasoning,
          reasoningSummary: traceReasoningSummary(mapped.content),
          toolCallIds: calls.map((call) => call.id)
        }
        const saved = this.database.recordModelActivity(runId, model)
        queue.push({ type: 'model_completed', runId, threadId, model: saved })
        for (const call of calls) {
          this.ensureToolActivity(runId, threadId, call, queue, subagentId)
        }
        index += 1
      } finally {
        argumentProgress.dispose()
        publishProgress([])
      }
    }
  }

  private rememberToolCallProgress(event: Extract<AgentRuntimeEvent, { type: 'model_tool_calls' }>): void {
    const key = JSON.stringify([event.subagentId, event.modelId])
    const progress = this.toolCallProgress.get(event.runId) ?? new Map()
    if (event.progress.length) progress.set(key, event)
    else progress.delete(key)
    if (progress.size) this.toolCallProgress.set(event.runId, progress)
    else this.toolCallProgress.delete(event.runId)
  }

  private withRuntimeActivityState(activity: AgentRunActivity): AgentRunActivity {
    // A failed final report write can leave durable progress behind after the
    // executor has released the run. It must not imply an active cleanup.
    if (activity.backgroundCleanup?.status === 'running' && !this.activeRuns.has(activity.runId)) {
      activity = { ...activity, backgroundCleanup: { status: 'unconfirmed',
        report: `${activity.backgroundCleanup.report}\n${backgroundCleanupUnconfirmed}` } }
    }
    const progress = this.toolCallProgress.get(activity.runId)
    if (!progress) return activity
    return {
      ...activity,
      models: activity.models.map((model) => ({
        ...model,
        toolCallProgress: progress.get(JSON.stringify([model.subagentId, model.id]))?.progress
      }))
    }
  }

  private ensureToolActivity(
    runId: string,
    threadId: string,
    call: AgentToolCall,
    queue: EventQueue,
    subagentId?: string
  ): AgentRunActivity['tools'][number] {
    const exact = this.database.getToolActivity(runId, call.id, subagentId)
    if (exact) return exact
    const started = this.database.recordToolActivity(runId, call, 'running', subagentId)
    queue.push({
      type: 'tool_started',
      runId,
      threadId,
      call,
      sequence: started.sequence,
      subagentId,
      startedAt: started.startedAt
    })
    return started
  }

  private recordInterruptedToolActivity(
    runId: string,
    threadId: string,
    interrupted: ScopedInterruptedToolActivity,
    queue: EventQueue
  ): void {
    const activity = this.ensureToolActivity(
      runId,
      threadId,
      interrupted.call,
      queue,
      interrupted.subagentId
    )
    this.database.recordToolApproval(
      runId,
      interrupted.call.id,
      interrupted.approval,
      interrupted.subagentId
    )
    queue.push({
      type: 'tool_approval_requested',
      runId,
      threadId,
      call: interrupted.call,
      approval: interrupted.approval,
      sequence: activity.sequence,
      subagentId: interrupted.subagentId,
      startedAt: activity.startedAt
    })
  }

  private reconcileRootToolActivities(runId: string, threadId: string, queue: EventQueue): void {
    const published = this.publishedToolCompletions.get(runId)
    for (const callId of this.database.listRootToolActivityIds(runId, 'completed')) {
      if (published?.has(JSON.stringify([null, callId]))) continue
      const completed = this.database.getToolActivity(runId, callId)
      if (!completed) continue
      this.publishToolCompletion(queue, {
        type: 'tool_completed', runId, threadId, call: completed.call,
        sequence: completed.sequence, output: completed.output,
        startedAt: completed.startedAt, completedAt: completed.completedAt
      })
    }
  }

  private async consumeToolCalls(
    tools: AsyncIterable<RuntimeToolCallStream>,
    runId: string,
    threadId: string,
    queue: EventQueue,
    subagentId?: string
  ): Promise<void> {
    const pending: Promise<void>[] = []
    for await (const tool of tools) {
      const call: AgentToolCall = {
        id: tool.callId,
        name: tool.name,
        args: tool.input
      }
      const activity = this.ensureToolActivity(
        runId,
        threadId,
        call,
        queue,
        subagentId
      )
      if (activity.approval) {
        this.database.clearToolApproval(runId, call.id, subagentId)
        queue.push({
          type: 'tool_started',
          runId,
          threadId,
          call,
          sequence: activity.sequence,
          subagentId,
          startedAt: activity.startedAt
        })
      }
      pending.push((async () => {
        const [status, error] = await Promise.all([tool.status, tool.error])
        let output: unknown
        try {
          output = await tool.output
        } catch (reason) {
          output = { status, error: error ?? errorMessage(reason) }
        }
        const current = this.database.getToolActivity(runId, call.id, subagentId)
        {
          const completed = current?.status === 'completed' ? current : this.database.recordToolActivity(
            runId,
            call,
            'completed',
            subagentId,
            output
          )
          this.publishToolCompletion(queue, {
            type: 'tool_completed',
            runId,
            threadId,
            call,
            sequence: completed.sequence,
            output,
            subagentId,
            startedAt: completed.startedAt,
            completedAt: completed.completedAt
          })
        }
        if (!subagentId && status === 'finished') {
          const todos = toolInputTodos(tool.name, tool.input)
          if (todos) {
            queue.push({
              type: 'todos_updated',
              runId,
              threadId,
              todos
            })
          }
        }
      })())
    }
    await Promise.all(pending)
  }

  private publishToolCompletion(
    queue: EventQueue,
    event: Extract<AgentRuntimeEvent, { type: 'tool_completed' }>
  ): void {
    const published = this.publishedToolCompletions.get(event.runId) ?? new Set<string>()
    const key = JSON.stringify([event.subagentId ?? null, event.call.id])
    if (published.has(key)) return
    published.add(key)
    this.publishedToolCompletions.set(event.runId, published)
    queue.push(event)
  }

  private snapshot(
    values: unknown,
    threadId: string,
    interrupts: AgentInterrupt[],
    contextStatus?: AgentThreadSnapshot['contextStatus'],
    requestedStartIndex?: number,
    pinned?: {
      thread: NonNullable<ReturnType<AgentDatabase['getThread']>>
      latestRun: ReturnType<AgentDatabase['getLatestRunForThread']>
    },
    retainUncommitted = false,
    window?: {
      messages: BaseMessage[]
      startIndex: number
      totalCount: number
    }
  ): AgentThreadSnapshot {
    const thread = pinned?.thread ?? this.database.getThread(threadId)
    if (!thread) throw new Error(`Thread ${threadId} was not found.`)
    const latestRun = pinned?.latestRun ?? this.database.getLatestRunForThread(threadId)
    const checkpointMessages = (window?.messages ?? stateMessages(values)).map((message, index) =>
      toAgentMessage(message, `${threadId}:message:${index}`)
    )
    const normalizeLatest = latestRun?.status === 'running' || latestRun?.status === 'interrupted'
    const allMessages = conversationMessages(checkpointMessages)
    const total = window?.totalCount ?? allMessages.length
    const startIndex = window?.startIndex ?? Math.max(
      0,
      Math.min(total, requestedStartIndex ?? Math.max(0, total - initialAgentMessageWindow))
    )
    const messages = window ? allMessages : allMessages.slice(startIndex)
    const windowRunIds = new Set(messages.flatMap((message) => message.runId ? [message.runId] : []))
    if (latestRun) windowRunIds.add(latestRun.id)
    const activitiesForWindow = this.database.getActivitiesForRuns(
      threadId, [...windowRunIds], { includeUnanchored: initialAgentMessageWindow }
    )
    const allActivities = attachReasoningSummaries(
      activitiesForWindow
        .map((activity) =>
          normalizeLatest && activity.runId === latestRun?.id
            ? this.normalizeActivityWindow(activity, retainUncommitted)
            : activity
        ),
      checkpointMessages
    ).map((activity) => this.withRuntimeActivityState(activity))
    const attachmentsByMessage = new Map<string, AgentAttachmentArtifact[]>()
    for (const attachment of this.database.listAttachmentsForMessages(threadId, messages.map((message) => message.id))) {
      attachmentsByMessage.set(attachment.messageId, [
        ...(attachmentsByMessage.get(attachment.messageId) ?? []), attachment
      ])
    }
    const allMessageRunIds = new Set(allMessages.flatMap((message) =>
      message.runId ? [message.runId] : []
    ))
    const windowMessageIds = new Set(messages.map((message) => message.id))
    const trailingUnanchoredIds = new Set(
      allActivities
        .filter((activity) => !allMessageRunIds.has(activity.runId))
        .slice(-initialAgentMessageWindow)
        .map((activity) => activity.runId)
    )
    const activities = allActivities.flatMap((activity) => {
      const summariesWithBoundaries = (activity.summaries ?? [])
        .map((summary) => ({
          ...summary,
          firstPreservedActivitySequence: firstPreservedActivitySequence(
            activity,
            summary,
            checkpointMessages
          )
        }))
      const summaries = summariesWithBoundaries
        .filter((summary) =>
          (
            summary.firstPreservedActivitySequence !== undefined
            && windowRunIds.has(activity.runId)
          )
          || Boolean(
            summary.coveredThroughMessageId
            && windowMessageIds.has(summary.coveredThroughMessageId)
          )
          || Boolean(
            summary.firstPreservedMessageId
            && windowMessageIds.has(summary.firstPreservedMessageId)
          )
          || (
            summary.status === 'running'
            && windowRunIds.has(activity.runId)
          )
        )
      const include = windowRunIds.has(activity.runId)
        || summaries.length > 0
        || trailingUnanchoredIds.has(activity.runId)
      if (!include) return []
      return [{
        ...activity,
        summaries: summaries.length > 0 ? summaries : undefined
      }]
    })
    return {
      thread,
      pendingRun: latestRun?.status === 'running' || latestRun?.status === 'interrupted'
        ? latestRun
        : undefined,
      settlingRun: latestRun?.status === 'completed' && this.activeRuns.has(latestRun.id) ? latestRun : undefined,
      messages: messages.map((mapped) => {
        const attachments = attachmentsByMessage.get(mapped.id)
        return attachments?.length ? { ...mapped, attachments } : mapped
      }),
      todos: stateTodos(values),
      interrupts,
      activities,
      contextStatus,
      messageWindow: {
        startIndex,
        shown: total - startIndex,
        total,
        remaining: startIndex
      }
    }
  }

  private tryBuildSnapshot(
    values: unknown,
    threadId: string,
    interrupts: AgentInterrupt[],
    contextStatus: AgentThreadSnapshot['contextStatus'] | undefined,
    runId: string
  ): AgentThreadSnapshot | undefined {
    try {
      return this.snapshot(values, threadId, interrupts, contextStatus)
    } catch (error) {
      runtimeLog('warn', 'agent', 'Failed to build a terminal run snapshot projection.', {
        runId,
        error: errorMessage(error)
      })
      return undefined
    }
  }

  private async drainPendingAttachmentCleanup(): Promise<void> {
    let threadIds: string[]
    let attachments: Array<Pick<AgentAttachmentArtifact, 'id' | 'path'>>
    try {
      threadIds = this.database.listAttachmentCleanupThreadIds()
      attachments = this.database.listAttachmentFileCleanup()
    } catch (error) {
      runtimeLog('warn', 'agent', 'Failed to list pending attachment cleanup.', {
        error: errorMessage(error)
      })
      return
    }
    for (const attachment of attachments) {
      try {
        await deleteArchivedAgentAttachments([attachment], this.database.attachmentRoot)
        this.database.acknowledgeAttachmentFileCleanup(attachment.id)
      } catch (error) {
        runtimeLog('warn', 'agent', 'Failed to clean a discarded attachment.', {
          attachmentId: attachment.id,
          error: errorMessage(error)
        })
      }
    }
    for (const threadId of threadIds) {
      try {
        await this.completeThreadAttachmentCleanup(threadId)
      } catch (error) {
        runtimeLog('warn', 'agent', 'Failed to clean archived thread attachments.', {
          threadId,
          error: errorMessage(error)
        })
      }
    }
  }

  private async completeThreadAttachmentCleanup(
    threadId: string,
    attachments: Array<Pick<AgentAttachmentArtifact, 'id' | 'path'>> = []
  ): Promise<void> {
    await deleteArchivedAgentAttachments(attachments, this.database.attachmentRoot)
    await deleteArchivedAgentThreadAttachments(threadId, this.database.attachmentRoot)
    this.database.acknowledgeAttachmentCleanup(threadId)
  }

  private async drainPendingFileEditCleanup(): Promise<void> {
    let runIds: string[]
    try {
      runIds = this.database.listFileEditCleanupRunIds()
    } catch (error) {
      runtimeLog('warn', 'agent', 'Failed to list pending file edit cleanup.', {
        error: errorMessage(error)
      })
      return
    }
    await Promise.all(runIds.map((runId) => this.completeFileEditCleanup(runId)))
  }

  private async completeFileEditCleanup(runId: string): Promise<void> {
    let cleanup = this.fileEditCleanupTasks.get(runId)
    if (!cleanup) {
      cleanup = Promise.resolve().then(async () => {
        try {
          // Run cancellation may finish before an already-dispatched local
          // commit. Keep its file-edit recovery records until the actual executor
          // releases ownership, including result/patch persistence.
          while (this.managedCalls.hasActiveForRun(runId)) {
            await this.managedCalls.waitForRunIdle(runId)
          }
          const retainedOperationIds = this.database.listRetainedFileEditOperationIds(runId)
          await runWithCurrentAgentToolEffect({
            arm: () => undefined,
            persistFileChange: (record) => this.database.fileChanges.persist(record, true)
          }, async () => {
            if (retainedOperationIds.length > 0) {
              await this.cleanupFileEdits(runId, retainedOperationIds)
            } else {
              await this.cleanupFileEdits(runId)
            }
          })
          this.database.acknowledgeFileEditCleanup(runId)
        } catch (error) {
          runtimeLog('warn', 'agent', 'Failed to clean file edit records.', {
            runId,
            error: errorMessage(error)
          })
        } finally {
          this.fileEditCleanupTasks.delete(runId)
        }
      })
      this.fileEditCleanupTasks.set(runId, cleanup)
      this.track(cleanup)
    }
    // Deferred cleanup must not delay the run's cancellation response. It is
    // still tracked by runtime shutdown and retried from the durable outbox.
    if (!this.managedCalls.hasActiveForRun(runId)) await cleanup
  }

  private track(task: Promise<void>): void {
    this.tasks.add(task)
    void task.then(
      () => this.tasks.delete(task),
      (error) => {
        this.tasks.delete(task)
        runtimeLog('error', 'agent', 'An agent runtime task failed unexpectedly.', {
          error: errorMessage(error)
        })
      }
    )
  }
}
