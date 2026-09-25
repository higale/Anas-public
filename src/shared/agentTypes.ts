import type { AppSettings, ProjectCreateRequest, SelectedAttachment, StorageUsageValue } from './types'
import type { CodeReviewRequest, CodeReviewPresentation } from './codeReview'
import type { AgentBackgroundCleanup } from './backgroundCleanup'

export type AgentThreadStatus = 'idle' | 'running' | 'interrupted' | 'failed'
export type AgentAccessMode = 'strict_approval' | 'read_only_allowed' | 'full_access'

export function isAgentThreadLocked(status: AgentThreadStatus | undefined): boolean {
  return status === 'running' || status === 'interrupted'
}

export interface AgentThread {
  id: string
  title: string
  projectId: string
  modelConfigId?: string
  modelParameterPresetId?: string
  pinned: boolean
  accessMode: AgentAccessMode
  status: AgentThreadStatus
  userTurnCount: number
  createdAt: string
  updatedAt: string
}

export interface AgentThreadCreate {
  title?: string
  projectId?: string
  accessMode?: AgentAccessMode
  modelConfigId?: string
  modelParameterPresetId?: string | null
}

export interface AgentThreadUpdate {
  title?: string
  projectId?: string
  pinned?: boolean
  /** Null restores a subagent's inherited model selection. Root conversations require an explicit model. */
  modelConfigId?: string | null
  modelParameterPresetId?: string | null
}

export type AgentWorkspaceState = {
  mode: 'thread'
  threadId: string
} | {
  mode: 'new_thread'
  projectId: string
  modelConfigId?: string
  modelParameterPresetId: string | null
}

export interface AgentThreadCleanupFailure {
  threadId: string
  error: string
}

export interface AgentThreadCleanupResult {
  deleted: number
  skipped: number
  failed: number
  deletedThreadIds: string[]
  skippedThreadIds: string[]
  failures: AgentThreadCleanupFailure[]
}

export interface AgentSystemContextPreviewInput {
  projectId?: string
  project: ProjectCreateRequest
  settings: AppSettings
}

export interface AgentSystemContextPreview {
  content: string
}

export type AgentModelRequestPreviewInput = AgentSystemContextPreviewInput

export interface AgentModelRequestPreview {
  content: string
}

export type AgentRunStatus = 'running' | 'interrupted' | 'completed' | 'failed' | 'cancelled'

export interface AgentRun {
  id: string
  threadId: string
  operation: 'agent' | 'compression'
  status: AgentRunStatus
  createdAt: string
  updatedAt: string
  error?: string
  backgroundCleanup?: AgentBackgroundCleanup
}

export type AgentContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; summary?: string }
  | { type: 'image'; mimeType?: string; data?: string; url?: string; path?: string }
  | { type: 'file'; name: string; mimeType?: string; path?: string; data?: string; url?: string }
  | { type: 'json'; value: unknown }

export type AgentAttachmentContextPolicy = 'one_turn' | 'conversation'

export interface AgentAttachmentInput {
  path: string
  name: string
  mimeType: string
  size: number
  kind: 'image' | 'text' | 'binary'
  textTruncated?: boolean
  contextPolicy: AgentAttachmentContextPolicy
}

export interface AgentAttachmentArtifact {
  id: string
  threadId: string
  messageId: string
  runId: string
  name: string
  mimeType: string
  size: number
  kind: AgentAttachmentInput['kind']
  path: string
  available: boolean
  textTruncated: boolean
  contextPolicy: AgentAttachmentContextPolicy
  createdAt: string
}

export interface AgentToolCall {
  id: string
  name: string
  args: unknown
}

export interface AgentToolApproval {
  status: 'pending_approval'
  interruptId: string
  actionIndex: number
}

export interface AgentSkillInvocation {
  name: string
  sourceAlias?: string
  args: string
  promptText: string
}

export interface AgentToolActivity {
  call: AgentToolCall
  sequence: number
  status: 'running' | 'completed'
  approval?: AgentToolApproval
  output?: unknown
  subagentId?: string
  startedAt?: string
  completedAt?: string
}

/** Transient reception metadata only. Complete input arrives with the tool call. */
export interface AgentToolCallProgress {
  index: number
  callId?: string
  name: string
  characterCount: number
  complete: boolean
}

export interface AgentModelActivity {
  id: string
  messageId?: string
  sequence: number
  /** One-based model order within this run and subagent; absent only before database registration. */
  round?: number
  status: 'running' | 'completed'
  subagentId?: string
  text: string
  reasoning: string
  reasoningSummary?: string
  toolCallIds: string[]
  toolCallProgress?: AgentToolCallProgress[]
  startedAt?: string
  completedAt?: string
}

export type AgentSubagentActivityStatus =
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface AgentSubagentActivity {
  id: string
  name: string
  sequence: number
  status: AgentSubagentActivityStatus
  parentSubagentId?: string
  result?: unknown
  error?: string
  startedAt?: string
  completedAt?: string
  detailsDeferred?: boolean
}

export interface AgentContextSummary {
  id: string
  sequence: number
  status: 'running' | 'completed'
  summaryText: string
  activatedAfterMessageIndex?: number
  coveredThroughMessageId?: string
  firstPreservedMessageId?: string
  firstPreservedActivitySequence?: number
  inputTokensBefore?: number
  inputTokensAfter?: number
  createdAt: string
}

export interface AgentMemoryRecall {
  id: string
  sequence: number
  query: string
  promptText: string
  memoryCount: number
  agentName?: string
  createdAt: string
}

export interface AgentRunActivity {
  runId: string
  operation: AgentRun['operation']
  status: AgentRunStatus
  error?: string
  backgroundCleanup?: AgentRun['backgroundCleanup']
  createdAt: string
  updatedAt: string
  models: AgentModelActivity[]
  tools: AgentToolActivity[]
  subagents: AgentSubagentActivity[]
  memoryRecalls?: AgentMemoryRecall[]
  summaries?: AgentContextSummary[]
  activityWindow?: {
    startSequence: number | null
    endSequence: number | null
    totalCount: number
    hasEarlier: boolean
  }
}

export interface AgentTokenModalityDetails {
  textTokens?: number
  imageTokens?: number
  audioTokens?: number
  videoTokens?: number
  documentTokens?: number
}

export interface AgentServerTokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  inputTokenDetails?: AgentTokenModalityDetails & {
    cacheReadTokens?: number
    cacheCreationTokens?: number
  }
  outputTokenDetails?: AgentTokenModalityDetails & {
    reasoningTokens?: number
  }
}

export interface AgentContextStatus {
  runId?: string
  modelConfigId: string
  modelContextKey?: string
  includeProjectRules?: boolean
  estimatedInputTokens: number
  /** Current effective context, including additions after a valid provider snapshot. */
  currentContextTokens: number
  serverUsage?: AgentServerTokenUsage
  maxContextTokens: number
  maxOutputTokens: number
  inputCapacityTokens: number
  compressionEnabled: boolean
  compressionThreshold: number
  compressionThresholdTokens: number
  compressionApplied: boolean
  manualCompressionAvailable: boolean
  breakdown: {
    profileTokens: number
    systemInstructionTokens: number
    runtimeContextTokens: number
    workspaceTokens: number
    memoryTokens: number
    skillTokens: number
    toolDefinitionTokens: number
    messageTokens: number
    attachmentTokens: number
  }
}

export interface AgentMessage {
  codeReview?: CodeReviewPresentation
  id: string
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: AgentContentBlock[]
  attachments?: AgentAttachmentArtifact[]
  name?: string
  toolCallId?: string
  toolCalls?: AgentToolCall[]
  skillInvocation?: AgentSkillInvocation
  directionAfterToolCallIds?: string[]
  runId?: string
  createdAt?: string
}

export interface AgentApprovalPathPreview {
  actionIndex: number
  locator: Array<string | number>
  absolutePath: string
  source: 'relative' | 'default' | 'resolved' | 'canonical'
}

export interface AgentInterrupt {
  id: string
  value: unknown
  approvalGeneration: string
  pathPreviews?: AgentApprovalPathPreview[]
}

export interface AgentTodo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface AgentThreadSnapshot {
  thread: AgentThread
  pendingRun?: AgentRun
  /** A terminal model run whose executor is still disposing or cleaning up. */
  settlingRun?: AgentRun
  messages: AgentMessage[]
  todos: AgentTodo[]
  interrupts: AgentInterrupt[]
  activities: AgentRunActivity[]
  contextStatus?: AgentContextStatus
  messageWindow: {
    startIndex: number
    shown: number
    total: number
    remaining: number
  }
}

export interface AgentRunInput {
  threadId: string
  text: string
  displayText?: string
  content?: AgentContentBlock[]
  attachments?: AgentAttachmentInput[]
  review?: CodeReviewRequest
}

export type AgentRunSubmissionInput = Omit<AgentRunInput, 'threadId'> & {
  requestId: string
} & (
  | { threadId: string; newThread?: never }
  | { threadId?: never; newThread: AgentThreadCreate }
)

export interface AgentRunSubmission {
  thread: AgentThread
  run: AgentRun
  /** Present for a newly started or still-active run; completed replays load the thread snapshot instead. */
  userMessage?: AgentMessage
}

export interface AgentMessageRangeInput {
  threadId: string
  messageId: string
}

export interface AgentMessageWindowInput {
  threadId: string
  beforeIndex: number
}

export interface AgentActivityWindowInput {
  threadId: string
  runId: string
  beforeSequence: number
}

export interface AgentMessageEditResult {
  snapshot: AgentThreadSnapshot
  attachments: SelectedAttachment[]
}

export interface AgentMessageRegenerateInput extends AgentMessageRangeInput {
  skillPromptText?: string
}

export interface AgentStorageUsageSnapshot {
  conversations: StorageUsageValue
  memories: StorageUsageValue
}

export interface AgentRunReferenceInput {
  runId: string
  threadId: string
}

export interface AgentRunDirectionReferenceInput extends AgentRunReferenceInput {
  queuedInputId: string
}

export interface AgentRunDirectionInput extends AgentRunDirectionReferenceInput {
  text: string
  displayText?: string
  attachments?: AgentAttachmentInput[]
}

export type AgentQueuedInputStatus = 'queued' | 'failed'

export interface AgentQueuedInput {
  id: string
  threadId: string
  text: string
  displayText: string
  attachments: SelectedAttachment[]
  status: AgentQueuedInputStatus
  error?: string
  createdAt: string
}

export interface AgentQueuedInputCreate {
  id: string
  threadId: string
  text: string
  displayText?: string
  attachments?: AgentAttachmentInput[]
}

export type AgentRunCancellationResult = 'requested' | 'cancelled' | 'unchanged'

export type AgentApprovalDecision =
  | { type: 'approve' }
  | { type: 'reject'; message?: string }

export interface AgentInterruptResponse {
  interruptId: string
  decisions: AgentApprovalDecision[]
  expectedGeneration: string
}

export interface AgentResumeInput extends AgentRunReferenceInput {
  responses: AgentInterruptResponse[]
}

export interface AgentEventEnvelope {
  revision: number
  event: AgentRuntimeEvent
  replayActive: boolean
}

export interface AgentEventSubscriptionRequest {
  afterRevision?: number
}

export interface AgentEventSubscription {
  revision: number
  replay: AgentEventEnvelope[]
  replayComplete: boolean
}

export interface AgentApi {
  userInput: import('./userInput').UserInputApi
  changes: {
    gitContents(input: import('./gitChanges').GitContentInput, requestId: string): Promise<import('./diffContents').DiffContents>
    gitReferences(input: import('./gitChanges').GitReferenceQuery, requestId: string): Promise<import('./gitChanges').GitReadResponse<import('./gitChanges').GitReferenceResult>>
    rounds(input: import('./fileChanges').FileChangeRoundListInput, requestId: string): Promise<import('./fileChanges').FileChangeRoundListResult>
    roundFiles(input: import('./fileChanges').RoundFileChangesReadInput, requestId: string): Promise<import('./fileChanges').RoundFileChangesResult>
    roundContents(input: import('./fileChanges').RoundFileContentInput, requestId: string): Promise<import('./diffContents').DiffContents>
    cancelRead(requestId: string): Promise<void>
    git(input: import('./gitChanges').GitChangeReadInput, requestId: string): Promise<import('./gitChanges').GitReadResponse<import('./gitChanges').GitChangeResult>>
  }
  workspace: {
    get(): Promise<AgentWorkspaceState>
    set(state: AgentWorkspaceState): Promise<void>
  }
  threads: {
    list(): Promise<AgentThread[]>
    get(threadId: string): Promise<AgentThreadSnapshot>
    update(threadId: string, input: AgentThreadUpdate): Promise<AgentThread>
    setAccessMode(threadId: string, accessMode: AgentAccessMode): Promise<AgentThread>
    delete(threadId: string): Promise<void>
    cleanup(): Promise<AgentThreadCleanupResult>
  }
  queuedInputs: {
    list(): Promise<AgentQueuedInput[]>
    enqueue(input: AgentQueuedInputCreate): Promise<AgentQueuedInput>
    remove(threadId: string, queuedInputId: string): Promise<boolean>
    markFailed(threadId: string, queuedInputId: string, error: string): Promise<AgentQueuedInput>
    retry(threadId: string, queuedInputId: string): Promise<AgentQueuedInput>
  }
  maintenance: {
    compactDatabase(): Promise<void>
    getStorageUsage(): Promise<AgentStorageUsageSnapshot>
  }
  runs: {
    submit(input: AgentRunSubmissionInput): Promise<AgentRunSubmission>
    compress(threadId: string): Promise<AgentRun>
    recover(threadId: string): Promise<boolean>
    resume(input: AgentResumeInput): Promise<AgentRun>
    steer(input: AgentRunDirectionInput): Promise<boolean>
    removeSteer(input: AgentRunDirectionReferenceInput): Promise<boolean>
    cancel(input: AgentRunReferenceInput): Promise<AgentRunCancellationResult>
  }
  messages: {
    truncate(input: AgentMessageRangeInput): Promise<AgentThreadSnapshot>
    prepareEdit(input: AgentMessageRangeInput): Promise<AgentMessageEditResult>
    regenerate(input: AgentMessageRegenerateInput): Promise<AgentRun>
    loadEarlier(input: AgentMessageWindowInput): Promise<AgentThreadSnapshot>
  }
  activities: {
    loadEarlier(input: AgentActivityWindowInput): Promise<AgentRunActivity>
    subagent(input: AgentRunReferenceInput & { subagentId: string }): Promise<AgentSubagentActivity>
  }
  context: {
    status(threadId: string): Promise<AgentContextStatus | undefined>
    preview(input: AgentSystemContextPreviewInput): Promise<AgentSystemContextPreview>
    previewModelRequest(input: AgentModelRequestPreviewInput): Promise<AgentModelRequestPreview>
    saveModelRequest(content: string): Promise<string | null>
  }
  onEvent(
    listener: (event: AgentRuntimeEvent) => void,
    subscribed?: () => void | Promise<void>,
    subscriptionError?: (message: string) => void
  ): () => void
}

export type AgentRuntimeEvent =
  | { type: 'file_changes'; runId: string; threadId: string }
  | { type: 'run_started'; run: AgentRun; newUserTurn: true; userMessage: AgentMessage }
  | { type: 'run_started'; run: AgentRun; newUserTurn: false; userMessage?: AgentMessage }
  | { type: 'run_interrupted'; run: AgentRun; interrupts: AgentInterrupt[]; snapshot?: AgentThreadSnapshot }
  | { type: 'run_completed'; run: AgentRun; snapshot?: AgentThreadSnapshot }
  | { type: 'run_failed'; run: AgentRun; error: string }
  | { type: 'run_cleanup'; run: AgentRun; cleanup: NonNullable<AgentRun['backgroundCleanup']>; reply?: AgentMessage }
  | { type: 'run_recovery_failed'; run: AgentRun; error: string; snapshot?: AgentThreadSnapshot }
  | { type: 'run_cancelled'; run: AgentRun }
  | { type: 'run_settled'; runId: string; threadId: string; operation: AgentRun['operation']; status: AgentRunStatus }
  | { type: 'direction_applied'; runId: string; threadId: string; queuedInputId: string; message: AgentMessage }
  | { type: 'model_started'; runId: string; threadId: string; model: AgentModelActivity }
  | { type: 'model_delta'; runId: string; threadId: string; modelId: string; subagentId?: string; delta: Extract<AgentContentBlock, { type: 'text' | 'reasoning' }> }
  | { type: 'model_tool_calls'; runId: string; threadId: string; modelId: string; subagentId?: string; progress: AgentToolCallProgress[] }
  | { type: 'model_completed'; runId: string; threadId: string; model: AgentModelActivity }
  | { type: 'tool_started'; runId: string; threadId: string; call: AgentToolCall; sequence: number; subagentId?: string; startedAt?: string }
  | { type: 'tool_approval_requested'; runId: string; threadId: string; call: AgentToolCall; approval: AgentToolApproval; sequence: number; subagentId?: string; startedAt?: string }
  | { type: 'tool_completed'; runId: string; threadId: string; call: AgentToolCall; sequence: number; output: unknown; subagentId?: string; startedAt?: string; completedAt?: string }
  | { type: 'todos_updated'; runId: string; threadId: string; todos: AgentTodo[] }
  | { type: 'subagent_updated'; runId: string; threadId: string; subagent: AgentSubagentActivity }
  | { type: 'memory_recalled'; runId: string; threadId: string; recall: AgentMemoryRecall }
  | { type: 'context_compression_started'; runId: string; threadId: string; summary: AgentContextSummary }
  | { type: 'context_compression_completed'; runId: string; threadId: string; summary: AgentContextSummary }
  | { type: 'context_compression_discarded'; runId: string; threadId: string; summaryId: string }
  | { type: 'context_status_updated'; runId: string; threadId: string; status?: AgentContextStatus }
