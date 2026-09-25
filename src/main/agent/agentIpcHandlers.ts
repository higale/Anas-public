import type { IpcMainInvokeEvent, WebContents } from 'electron'
import { z } from 'zod/v3'
import { GitReadError, type GitReadErrorCode, type GitReadResponse } from '@shared/gitChanges'
import { queryGitChanges, readGitContents, queryGitReferences } from '../gitChanges'
import { ChangeReadLane } from '../changeReadLane'
import { captureCodeReview, codeReviewPrompt } from './codeReview'
import { readRoundContents } from './roundChanges'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import type {
  AgentAccessMode,
  AgentResumeInput,
  AgentMessageEditResult,
  AgentMessageRangeInput,
  AgentMessageRegenerateInput,
  AgentMessageWindowInput,
  AgentActivityWindowInput,
  AgentRunActivity,
  AgentSubagentActivity,
  AgentModelRequestPreview,
  AgentModelRequestPreviewInput,
  AgentQueuedInput,
  AgentQueuedInputCreate,
  AgentEventEnvelope,
  AgentEventSubscription,
  AgentEventSubscriptionRequest,
  AgentRun,
  AgentRunCancellationResult,
  AgentRunDirectionInput,
  AgentRunDirectionReferenceInput,
  AgentRunReferenceInput,
  AgentRunSubmission,
  AgentRunSubmissionInput,
  AgentStorageUsageSnapshot,
  AgentRuntimeEvent,
  AgentSystemContextPreview,
  AgentSystemContextPreviewInput,
  AgentThreadCleanupResult,
  AgentThreadSnapshot,
  AgentThreadUpdate,
  AgentWorkspaceState
} from '@shared/agentTypes'
import { appendRunSettledEvent } from './runSettlementEvents'
import { compactToolCallProgress } from '@shared/agentEventReplay'
import { AgentDatabase, type AgentSubagentCallRecord } from './agentDatabase'
import { AgentRuntimeCoordinator } from './agentRuntimeCoordinator'
import { AgentStorage } from './agentStorage'
import { withConversationLeaseScope } from './agentConversationLease'
import { getDataDir } from '../config/dataDir'
import {
  createAgentMessageRegenerateExecutionInput,
  createAgentRunSubmissionExecutionInput,
  normalizeAgentRunSubmissionId
} from './agentRunInput'
import { findResolvedModelConfig, getAppConfigSnapshot } from '../config/appConfig'
import { runtimeLog } from '../runtimeLogger'
import { getProject, recoverProjectDeletion } from '../projectStore'
import type {
  MemoryItem,
  MemorySaveRequest,
  MemorySearchRequest,
  MemorySearchResult,
  ProjectDeleteResult
} from '@shared/types'
import { handleMainIpc } from '../ipcSecurity'
import { dialogParentFromEvent, showModalSaveDialog } from '../modalDialog'
import { userInputService } from './userInputService'

let storage: AgentStorage | undefined
let runtime: AgentRuntimeCoordinator | undefined
type AgentRuntimeLifecycle = 'open' | 'closing' | 'closed'
let agentRuntimeLifecycle: AgentRuntimeLifecycle = 'open'
let agentRuntimeCloseAttempt: Promise<boolean> | undefined
let activeAgentIpcOperations = 0
const agentIpcIdleWaiters = new Set<() => void>()
const agentEventSubscribers = new Set<WebContents>()
const agentEventReplay = new Map<number, AgentEventEnvelope>()
const activeRunEventReplay = new Map<string, Map<number, AgentEventEnvelope>>()
const inactiveReplayRunIds = new Set<string>()
const activeReplaySubagentIds = new Map<string, Set<string>>()
const agentEventReplayCapacity = 4_096
let agentEventRevision = 0
const pendingEventForwarders = new Set<Promise<void>>()
const pendingRunSubmissions = new Map<string, Promise<AgentRunSubmission>>()
let pendingWorkspaceMutations: Promise<void> = Promise.resolve()
const maximumModelRequestPreviewBytes = 32 * 1024 * 1024
const agentRuntimeCloseTimeoutMs = 5_000

async function gitViewRead<T>(read: () => Promise<T>, defaultCode: GitReadErrorCode = 'read_failed'): Promise<GitReadResponse<T>> {
  try { return await read() } catch (error) {
    const code = error instanceof GitReadError ? error.code : defaultCode
    if (code !== 'not_repository') runtimeLog('warn', 'agent', 'Failed to read Git changes for the panel.', { error })
    return { error: code }
  }
}

function currentStorage(): AgentStorage {
  if (runtime) return runtime.storageForOperation()
  if (!storage) storage = AgentStorage.open(getDataDir(), (ownerThreadId, runId) => {
    if (agentRuntimeLifecycle !== 'open') return
    try {
      publishAgentEvent({ type: 'file_changes', runId, threadId: ownerThreadId })
    } catch (error) {
      runtimeLog('warn', 'agent', 'Failed to publish file change invalidation.', { runId, error })
    }
  })
  return storage
}

function currentDatabase(threadId?: string): AgentDatabase {
  return threadId ? currentRuntime().databaseForThread(threadId) : currentStorage().previewDatabase()
}

function currentRuntime(): AgentRuntimeCoordinator {
  if (!runtime) runtime = new AgentRuntimeCoordinator(currentStorage(), publishAgentEvent)
  return runtime
}

function agentEventRunId(event: AgentRuntimeEvent): string | undefined {
  return 'run' in event ? event.run.id : 'runId' in event ? event.runId : undefined
}

function finalAgentEvent(event: AgentRuntimeEvent): boolean {
  return event.type === 'run_completed'
    || event.type === 'run_failed'
    || event.type === 'run_cancelled'
}

function activeSubagentStatus(status: AgentSubagentCallRecord['status']): boolean {
  return status === 'running' || status === 'interrupted'
}

function hydrateActiveReplaySubagents(runId: string): void {
  const database = storage?.conversationForRun(runId)
  if (!database) return
  const pendingRunIds = [runId]
  const visitedRunIds = new Set<string>()
  const activeIds = activeReplaySubagentIds.get(runId) ?? new Set<string>()
  while (pendingRunIds.length > 0) {
    const parentRunId = pendingRunIds.shift()
    if (!parentRunId || visitedRunIds.has(parentRunId)) continue
    visitedRunIds.add(parentRunId)
    for (const call of database.listSubagentCallsForParentRun(parentRunId)) {
      pendingRunIds.push(call.childRunId)
      if (activeSubagentStatus(call.status)) activeIds.add(call.id)
    }
  }
  if (activeIds.size > 0) activeReplaySubagentIds.set(runId, activeIds)
  else activeReplaySubagentIds.delete(runId)
}

function updateRunReplayState(event: AgentRuntimeEvent, runId: string | undefined): boolean {
  if (!runId) return false
  if (event.type === 'run_started') {
    inactiveReplayRunIds.delete(runId)
    if (!activeRunEventReplay.has(runId)) activeRunEventReplay.set(runId, new Map())
  }
  if (
    event.type === 'subagent_updated'
    && (activeRunEventReplay.has(runId) || inactiveReplayRunIds.has(runId))
  ) {
    const activeIds = activeReplaySubagentIds.get(runId) ?? new Set<string>()
    if (activeSubagentStatus(event.subagent.status)) activeIds.add(event.subagent.id)
    else activeIds.delete(event.subagent.id)
    if (activeIds.size > 0) activeReplaySubagentIds.set(runId, activeIds)
    else activeReplaySubagentIds.delete(runId)
  }
  if (event.type === 'run_interrupted' || event.type === 'run_recovery_failed') {
    inactiveReplayRunIds.add(runId)
    try {
      hydrateActiveReplaySubagents(runId)
    } catch (reason) {
      runtimeLog('warn', 'agent', 'Failed to verify inactive-run subagent replay state.', {
        runId,
        error: reason
      })
    }
  }
  if (finalAgentEvent(event)) {
    inactiveReplayRunIds.delete(runId)
    activeReplaySubagentIds.delete(runId)
    return false
  }
  const hasActiveSubagent = (activeReplaySubagentIds.get(runId)?.size ?? 0) > 0
  const inactive = inactiveReplayRunIds.has(runId)
  const replayActive = inactive
    ? hasActiveSubagent
    : activeRunEventReplay.has(runId)
  if (
    inactive
    && !hasActiveSubagent
    && (event.type === 'subagent_updated' || event.type === 'run_settled')
  ) {
    inactiveReplayRunIds.delete(runId)
  }
  return replayActive
}

function publishAgentEvent(event: AgentRuntimeEvent): void {
  const runId = agentEventRunId(event)
  const replayActive = updateRunReplayState(event, runId)
  const envelope: AgentEventEnvelope = {
    revision: ++agentEventRevision,
    event,
    replayActive
  }
  if (runId && replayActive) {
    const activeReplay = activeRunEventReplay.get(runId) ?? new Map([...agentEventReplay]
      .filter(([, candidate]) => agentEventRunId(candidate.event) === runId))
    activeReplay.set(envelope.revision, envelope)
    if (event.type === 'model_tool_calls') compactToolCallProgress(activeReplay)
    activeRunEventReplay.set(runId, activeReplay)
  }
  agentEventReplay.set(envelope.revision, envelope)
  if (event.type === 'model_tool_calls') compactToolCallProgress(agentEventReplay)
  if (agentEventReplay.size > agentEventReplayCapacity) {
    agentEventReplay.delete(agentEventReplay.keys().next().value!)
  }
  for (const sender of agentEventSubscribers) {
    if (sender.isDestroyed()) {
      agentEventSubscribers.delete(sender)
      continue
    }
    try {
      sender.send('agent:event', envelope)
    } catch (reason) {
      runtimeLog('warn', 'agent', 'Failed to forward an Agent event.', {
        error: reason
      })
    }
  }
  if (runId && !replayActive) activeRunEventReplay.delete(runId)
}

function subscribeAgentEvents(
  sender: WebContents,
  request: AgentEventSubscriptionRequest = {}
): AgentEventSubscription {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Agent event subscription request is invalid.')
  }
  if (
    request.afterRevision !== undefined
    && (!Number.isSafeInteger(request.afterRevision) || request.afterRevision < 0)
  ) {
    throw new Error('Agent event subscription cursor is invalid.')
  }
  if (!agentEventSubscribers.has(sender)) {
    agentEventSubscribers.add(sender)
    sender.once?.('destroyed', () => agentEventSubscribers.delete(sender))
  }
  const afterRevision = request.afterRevision
  const oldestRevision = agentEventReplay.values().next().value?.revision ?? agentEventRevision + 1
  const replayByRevision = new Map<number, AgentEventEnvelope>()
  if (afterRevision !== undefined) {
    for (const envelope of agentEventReplay.values()) {
      if (envelope.revision > afterRevision) replayByRevision.set(envelope.revision, envelope)
    }
  }
  for (const envelope of [...activeRunEventReplay.values()].flatMap((events) => [...events.values()])) {
    if (afterRevision === undefined || envelope.revision > afterRevision) {
      replayByRevision.set(envelope.revision, envelope)
    }
  }
  return {
    revision: agentEventRevision,
    replay: [...replayByRevision.values()].sort((left, right) => left.revision - right.revision),
    replayComplete: afterRevision === undefined
      || afterRevision >= agentEventRevision
      || afterRevision >= oldestRevision - 1
  }
}

async function forwardEvents(
  events: AsyncIterable<AgentRuntimeEvent>
): Promise<void> {
  for await (const event of events) publishAgentEvent(event)
}

function startForwardingEvents(
  sender: WebContents,
  events: AsyncIterable<AgentRuntimeEvent>
): void {
  subscribeAgentEvents(sender)
  const task = forwardEvents(appendRunSettledEvent(events))
  pendingEventForwarders.add(task)
  void task.then(
    () => pendingEventForwarders.delete(task),
    (reason) => {
      pendingEventForwarders.delete(task)
      runtimeLog('error', 'agent', 'Failed to forward runtime events to the renderer.', { error: reason })
    }
  )
}

function finishAgentIpcOperation(): void {
  activeAgentIpcOperations -= 1
  if (activeAgentIpcOperations !== 0) return
  for (const resolve of [...agentIpcIdleWaiters]) resolve()
}

function waitForAgentIpcIdle(): Promise<void> {
  if (activeAgentIpcOperations === 0) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      if (activeAgentIpcOperations !== 0) return
      agentIpcIdleWaiters.delete(done)
      resolve()
    }
    agentIpcIdleWaiters.add(done)
    if (activeAgentIpcOperations === 0) done()
  })
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return Boolean(value && typeof value === 'object' && 'then' in value
    && typeof (value as { then?: unknown }).then === 'function')
}

function handleAgentIpc<Args extends unknown[], Result>(
  channel: string,
  listener: (event: IpcMainInvokeEvent, ...args: Args) => Result
): void {
  handleMainIpc(channel, (event, ...args): Result => {
    if (agentRuntimeLifecycle !== 'open') {
      throw new Error('Agent runtime is unavailable while application data is closing.')
    }
    activeAgentIpcOperations += 1
    try {
      const result = withConversationLeaseScope(() => listener(event, ...args as Args))
      if (isPromiseLike(result)) {
        return Promise.resolve(result).finally(finishAgentIpcOperation) as Result
      }
      finishAgentIpcOperation()
      return result
    } catch (error) {
      finishAgentIpcOperation()
      throw error
    }
  })
}

async function persistWorkspaceState(state: AgentWorkspaceState): Promise<void> {
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    throw new Error('Agent workspace state is invalid.')
  }
  if (state.mode === 'new_thread') {
    await getProject(state.projectId)
    if (state.modelConfigId) {
      const config = await getAppConfigSnapshot()
      const model = findResolvedModelConfig(config, state.modelConfigId)
      if (!model) throw new Error(`Model configuration not found: ${state.modelConfigId}`)
      if (
        state.modelParameterPresetId
        && !model.parameterPresets?.some((preset) => preset.id === state.modelParameterPresetId)
      ) {
        throw new Error(`Model parameter preset not found: ${state.modelParameterPresetId}`)
      }
    } else if (state.modelParameterPresetId !== null) {
      throw new Error('A model parameter preset requires a model configuration.')
    }
  }
  currentStorage().setWorkspaceState(state)
}

function enqueueWorkspaceMutation<T>(mutation: () => Promise<T>): Promise<T> {
  if (agentRuntimeLifecycle !== 'open') {
    return Promise.reject(new Error(
      'Agent runtime is unavailable while application data is closing.'
    ))
  }
  const result = pendingWorkspaceMutations.then(mutation)
  pendingWorkspaceMutations = result.then(() => undefined, () => undefined)
  return result
}

async function drainEventForwarders(): Promise<void> {
  while (pendingEventForwarders.size > 0) {
    await Promise.allSettled([...pendingEventForwarders])
  }
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs)
        timer.unref()
      })
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function resumeAfterIncompleteClose(): void {
  runtime?.resumeAfterIncompleteShutdown()
  agentRuntimeLifecycle = 'open'
  agentRuntimeCloseAttempt = undefined
}

function beginAgentRuntimeClose(timeoutMs: number): Promise<boolean> {
  agentRuntimeLifecycle = 'closing'
  const startedAt = Date.now()
  const acceptedWork = (async () => {
    await Promise.all([
      waitForAgentIpcIdle(),
      pendingWorkspaceMutations,
      Promise.allSettled([...pendingRunSubmissions.values()])
    ])
  })()

  return (async () => {
    if (!await settlesWithin(acceptedWork, timeoutMs)) return false
    let remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt))
    const shutdownResult = runtime
      ? await runtime.shutdown({ timeoutMs: remainingMs })
      : { drained: true }
    if (!shutdownResult?.drained) return false
    remainingMs = Math.max(0, timeoutMs - (Date.now() - startedAt))
    if (!await settlesWithin(drainEventForwarders(), remainingMs)) return false
    runtime = undefined
    storage?.close()
    storage = undefined
    agentRuntimeLifecycle = 'closed'
    return true
  })()
}

export function registerAgentIpcHandlers(): void {
  const userInputClients = new WeakSet<WebContents>()
  handleAgentIpc('agent:userInput:list', (event) => {
    const sender = event.sender
    if (!userInputClients.has(sender)) {
      userInputClients.add(sender)
      const unsubscribe = userInputService.subscribe(snapshot => {
        try {
          if (!sender.isDestroyed()) sender.send('agent:userInput:changed', snapshot)
        } catch (error) {
          runtimeLog('warn', 'agent', 'Failed to deliver a user input dialog update.', { error })
        }
      })
      sender.once('destroyed', unsubscribe)
    }
    return userInputService.snapshot()
  })
  handleAgentIpc('agent:userInput:shown', (_event, id: unknown) => userInputService.shown(z.string().uuid().parse(id)))
  handleAgentIpc('agent:userInput:interact', (_event, id: unknown) => userInputService.interact(z.string().uuid().parse(id)))
  handleAgentIpc('agent:userInput:respond', (_event, id: unknown, response: unknown) =>
    userInputService.respond(z.string().uuid().parse(id), response))
  const readersByOwner = new WeakMap<WebContents, Map<string, ChangeReadLane>>()
  handleAgentIpc('agent:events:subscribe', (
    event,
    request: AgentEventSubscriptionRequest = {}
  ): AgentEventSubscription => subscribeAgentEvents(event.sender, request))
  handleAgentIpc('memory:search', (
    _event,
    request: MemorySearchRequest = {}
  ): Promise<MemorySearchResult> => currentRuntime().useStorage((storage) => storage.memoryStore.searchMemories(request)))
  handleAgentIpc('memory:save', async (
    _event,
    request: MemorySaveRequest
  ): Promise<MemoryItem> => enqueueWorkspaceMutation(async () => {
    if (request.scope === 'project') {
      if (!request.projectId) throw new Error('Project memories require a project ID.')
      await getProject(request.projectId)
    }
    return currentRuntime().useStorage((storage) => storage.memoryStore.saveMemory(request, { origin: 'user' }))
  }))
  handleAgentIpc('memory:delete', (
    _event,
    id: string
  ): Promise<void> => currentRuntime().useStorage((storage) => storage.memoryStore.deleteMemory(id)))
  handleAgentIpc('memory:clear', (): Promise<number> => (
    enqueueWorkspaceMutation(async () => currentRuntime().clearMemories())
  ))
  handleAgentIpc('agent:workspace:get', (): AgentWorkspaceState => (
    currentStorage().getWorkspaceState()
  ))
  handleAgentIpc('agent:workspace:set', (
    _event,
    state: AgentWorkspaceState
  ): Promise<void> => enqueueWorkspaceMutation(() => persistWorkspaceState(state)))
  handleAgentIpc('agent:threads:list', () => currentStorage().listThreads())
  const digest = z.string().regex(/^[a-f0-9]{64}$/)
  const threadId = z.string().min(1).max(256)
  const filePath = z.string().min(1).max(32768)
  const roundsQuery = z.object({ threadId, selectedRunId: threadId.optional(),
    after: z.number().int().positive().safe().optional(), limit: z.number().int().min(1).max(100).optional()
  }).strict()
  const roundFilesQuery = z.object({ threadId, runId: threadId, filePath: filePath.optional(),
    after: filePath.optional(), limit: z.number().int().min(1).max(100).optional(), version: digest.optional()
  }).strict()
  const roundContentQuery = roundFilesQuery.pick({ threadId: true, runId: true }).extend({
    filePath, version: digest, target: z.enum(['recorded', 'current'])
  }).strict()
  const gitQuery = z.object({ projectId: z.string().min(1).max(256), sourceFolder: z.string().min(1).max(32768),
    scope: z.enum(['workspace', 'baseline', 'staged', 'unstaged']), baseline: z.string().min(1).max(1024).optional(),
    head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional(), includePatch: z.boolean().optional(),
    filePath: z.string().min(1).max(32768).optional(), after: z.number().int().nonnegative().safe().optional(),
    limit: z.number().int().min(1).max(20).optional(), version: digest.optional()
  }).strict()
  const lane = (event: IpcMainInvokeEvent, name: string): ChangeReadLane => {
    let readers = readersByOwner.get(event.sender)
    if (!readers) {
      readers = new Map()
      readersByOwner.set(event.sender, readers)
      const owner = readers
      event.sender.once('destroyed', () => { for (const reader of owner.values()) reader.dispose() })
    }
    if (!readers.has(name)) readers.set(name, new ChangeReadLane())
    return readers.get(name)!
  }
  const validateFolder = async (query: { projectId: string; sourceFolder: string }, signal: AbortSignal) => {
    const project = await getProject(query.projectId)
    signal.throwIfAborted()
    if (project.kind !== 'workspace' || !project.sourceFolders.includes(query.sourceFolder)) throw new Error('Git source folder does not belong to the selected project.')
  }
  handleAgentIpc('agent:changes:rounds', (event, input: unknown, requestId: unknown) => {
    const query = roundsQuery.parse(input)
    return lane(event, 'rounds').read(z.string().uuid().parse(requestId), async (signal) => {
      await new Promise<void>((resolve) => setImmediate(resolve))
      signal.throwIfAborted()
      return currentDatabase(query.threadId).fileChanges.listRounds(query)
    })
  })
  handleAgentIpc('agent:changes:roundFiles', (event, input: unknown, requestId: unknown) => {
    const query = roundFilesQuery.parse(input)
    return lane(event, 'list').read(z.string().uuid().parse(requestId), async (signal) => {
      await new Promise<void>((resolve) => setImmediate(resolve))
      signal.throwIfAborted()
      const db = currentDatabase(query.threadId)
      if (db.getRun(query.runId)?.threadId !== query.threadId) throw new Error('File change run does not belong to this conversation.')
      return db.fileChanges.queryRoundFiles(query)
    })
  })
  handleAgentIpc('agent:changes:roundContents', (event, input: unknown, requestId: unknown) => {
    const query = roundContentQuery.parse(input)
    return lane(event, 'contents').read(z.string().uuid().parse(requestId), async (signal) => {
      await new Promise<void>((resolve) => setImmediate(resolve))
      signal.throwIfAborted()
      const db = currentDatabase(query.threadId)
      if (db.getRun(query.runId)?.threadId !== query.threadId) throw new Error('File change run does not belong to this conversation.')
      return readRoundContents(db.fileChanges, query, signal)
    })
  })
  handleAgentIpc('agent:changes:git', async (event, input: unknown, requestId: unknown) => {
    const query = gitQuery.parse(input)
    return lane(event, 'list').read(z.string().uuid().parse(requestId), async (signal) => {
      await validateFolder(query, signal)
      return gitViewRead(() => queryGitChanges(query, signal))
    })
  })
  handleAgentIpc('agent:changes:gitContents', (event, input: unknown, requestId: unknown) => {
    const query = gitQuery.pick({ projectId: true, sourceFolder: true, scope: true, head: true }).extend({
      filePath: z.string().min(1).max(32768), baseline: z.string().min(1).max(1024).nullable().optional()
    }).parse(input)
    return lane(event, 'contents').read(z.string().uuid().parse(requestId), async (signal) => {
      await validateFolder(query, signal)
      return readGitContents(query, signal)
    })
  })
  handleAgentIpc('agent:changes:gitReferences', (event, input: unknown, requestId: unknown) => {
    const query = z.object({ projectId: z.string().min(1).max(256), sourceFolder: z.string().min(1).max(32768),
      kind: z.enum(['refs', 'history', 'resolve']), ref: z.string().min(1).max(1024).optional(),
      after: z.number().int().min(0).max(10000).optional() }).strict().parse(input)
    return lane(event, 'references').read(z.string().uuid().parse(requestId), async (signal) => {
      await validateFolder(query, signal)
      return gitViewRead(() => queryGitReferences(query, signal), query.kind === 'resolve' ? 'invalid_commit' : 'read_failed')
    })
  })
  handleAgentIpc('agent:changes:cancelRead', (event, requestId: unknown) => {
    const id = z.string().uuid().parse(requestId)
    for (const reader of readersByOwner.get(event.sender)?.values() ?? []) reader.cancel(id)
  })
  handleAgentIpc('agent:queuedInputs:list', (): AgentQueuedInput[] => (
    currentRuntime().listQueuedInputs()
  ))
  handleAgentIpc('agent:queuedInputs:enqueue', (
    _event,
    input: AgentQueuedInputCreate
  ): Promise<AgentQueuedInput> => currentRuntime().enqueueQueuedInput(input))
  handleAgentIpc('agent:queuedInputs:remove', (
    _event,
    threadId: string,
    queuedInputId: string
  ): Promise<boolean> => currentRuntime().removeQueuedInput(threadId, queuedInputId))
  handleAgentIpc('agent:queuedInputs:markFailed', (
    _event,
    threadId: string,
    queuedInputId: string,
    error: string
  ): AgentQueuedInput => currentRuntime().markQueuedInputFailed(threadId, queuedInputId, error))
  handleAgentIpc('agent:queuedInputs:retry', (
    _event,
    threadId: string,
    queuedInputId: string
  ): AgentQueuedInput => currentRuntime().retryQueuedInput(threadId, queuedInputId))
  handleAgentIpc('agent:threads:get', (
    _event,
    threadId: string
  ): Promise<AgentThreadSnapshot> => currentRuntime().getSnapshot(threadId))
  handleAgentIpc('agent:threads:update', async (
    _event,
    threadId: string,
    input: AgentThreadUpdate
  ) => {
    if (input.projectId !== undefined) await getProject(input.projectId)
    if (input.modelConfigId === null) {
      // Clearing a child binding restores inheritance; the database checks ownership.
      return currentRuntime().updateThread(threadId, input)
    }
    if (input.modelConfigId !== undefined || input.modelParameterPresetId !== undefined) {
      const config = await getAppConfigSnapshot()
      const thread = currentDatabase(threadId).getThread(threadId)
      if (!thread) throw new Error(`Thread ${threadId} was not found.`)
      const modelConfigId = input.modelConfigId ?? thread.modelConfigId
      const model = findResolvedModelConfig(config, modelConfigId)
      if (!model) {
        throw new Error(`Model configuration not found: ${modelConfigId ?? ''}`)
      }
      const requestedPresetId = input.modelParameterPresetId === undefined && input.modelConfigId !== undefined
        ? model.defaultParameterPresetId
        : input.modelParameterPresetId
      if (requestedPresetId && !model.parameterPresets?.some((preset) => preset.id === requestedPresetId)) {
        throw new Error(`Model parameter preset not found: ${requestedPresetId}`)
      }
      input = {
        ...input,
        ...(input.modelConfigId !== undefined || input.modelParameterPresetId !== undefined
          ? { modelParameterPresetId: requestedPresetId ?? null }
          : {})
      }
    }
    return currentRuntime().updateThread(threadId, input)
  })
  handleAgentIpc('agent:threads:setAccessMode', (
    _event,
    threadId: string,
    accessMode: AgentAccessMode
  ) => {
    currentRuntime().databaseForThread(threadId)
    return currentStorage().setAccessMode(threadId, accessMode)
  })
  handleAgentIpc('agent:threads:delete', async (_event, threadId: string): Promise<void> => {
    await currentRuntime().deleteThread(threadId)
  })
  handleAgentIpc('agent:threads:cleanup', (): Promise<AgentThreadCleanupResult> => (
    enqueueWorkspaceMutation(() => currentRuntime().cleanupThreads())
  ))
  handleAgentIpc('agent:database:compact', (): Promise<void> => (
    enqueueWorkspaceMutation(async () => currentRuntime().compactDatabase())
  ))
  handleAgentIpc('agent:storage:getUsage', (): Promise<AgentStorageUsageSnapshot> => (
    currentRuntime().getStorageUsage()
  ))
  handleAgentIpc('agent:activities:loadEarlier', (_event, input: AgentActivityWindowInput): AgentRunActivity => {
    const parsed = z.object({ threadId: z.string().min(1), runId: z.string().min(1), beforeSequence: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).parse(input)
    return currentRuntime().loadEarlierActivities(parsed)
  })
  handleAgentIpc('agent:activities:subagent', (_event, input: AgentRunReferenceInput & { subagentId: string }): AgentSubagentActivity => {
    const parsed = z.object({ threadId: z.string().min(1), runId: z.string().min(1), subagentId: z.string().min(1) }).parse(input)
    const database = currentDatabase(parsed.threadId)
    if (database.getRun(parsed.runId)?.threadId !== parsed.threadId) throw new Error('Activity run belongs to another conversation.')
    const activity = database.getSubagentActivity(parsed.runId, parsed.subagentId)
    if (!activity) throw new Error('Subagent activity was not found.')
    return activity
  })
  handleAgentIpc('agent:context:status', (_event, threadId: unknown) => (
    currentRuntime().getContextStatus(z.string().min(1).parse(threadId))
  ))
  handleAgentIpc('agent:context:preview', (
    _event,
    input: AgentSystemContextPreviewInput
  ): Promise<AgentSystemContextPreview> => currentRuntime().previewSystemContext(input))
  handleAgentIpc('agent:context:previewModelRequest', (
    _event,
    input: AgentModelRequestPreviewInput
  ): Promise<AgentModelRequestPreview> => currentRuntime().previewModelRequest(input))
  handleAgentIpc('agent:context:saveModelRequest', async (
    event,
    content: unknown
  ): Promise<string | null> => {
    if (typeof content !== 'string' || !content) {
      throw new Error('The model request preview is empty.')
    }
    if (Buffer.byteLength(content, 'utf8') > maximumModelRequestPreviewBytes) {
      throw new Error('The model request preview is too large to save.')
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const result = await showModalSaveDialog(dialogParentFromEvent(event), {
      title: 'Save model request',
      defaultPath: `anas-model-request-${timestamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, `${content}\n`, 'utf8')
    return result.filePath
  })
  handleAgentIpc('agent:runs:submit', async (
    event,
    input: AgentRunSubmissionInput
  ): Promise<AgentRunSubmission> => {
    const submissionId = normalizeAgentRunSubmissionId(input.requestId)
    const pending = pendingRunSubmissions.get(submissionId)
    if (pending) return pending
    const submit = async (): Promise<AgentRunSubmission> => {
      const existing = currentRuntime().getRunSubmission(submissionId)
      if (existing) return existing
      const config = await getAppConfigSnapshot()
      const thread = input.threadId ? currentDatabase(input.threadId).getThread(input.threadId) : undefined
      if (input.threadId && !thread) throw new Error(`Thread ${input.threadId} was not found.`)
      const modelConfigId = thread ? thread.modelConfigId : input.newThread?.modelConfigId ?? config.defaultModelId
      const selectedModel = findResolvedModelConfig(config, modelConfigId)
      if (!selectedModel) throw new Error(modelConfigId
        ? `The selected model or its provider no longer exists: ${modelConfigId}. Select another model and send again.`
        : 'No model is selected for this conversation. Select a model and send again.')
      const hasRequestedPreset = Boolean(input.newThread && Object.hasOwn(input.newThread, 'modelParameterPresetId'))
      const modelParameterPresetId = thread
        ? thread.modelParameterPresetId
        : hasRequestedPreset
          ? input.newThread?.modelParameterPresetId ?? undefined
          : selectedModel.defaultParameterPresetId
      if (modelParameterPresetId && !selectedModel.parameterPresets?.some((preset) => preset.id === modelParameterPresetId)) {
        throw new Error(`Model parameter preset not found: ${modelParameterPresetId}`)
      }
      if (!selectedModel.capabilities.vision && input.attachments?.some((attachment) => attachment.kind === 'image')) {
        throw new Error('The current model does not support image attachments.')
      }
      const executionInput = createAgentRunSubmissionExecutionInput(input.newThread
        ? {
            ...input,
            newThread: {
              ...input.newThread,
              modelConfigId: selectedModel.id,
              modelParameterPresetId: modelParameterPresetId ?? null
            }
          }
        : input)
      if (input.review !== undefined) {
        if (!selectedModel.capabilities.toolUse) throw new Error('Code review requires a model with tool use enabled.')
        if (input.attachments?.length || input.content?.length) throw new Error('A code review must use only its selected changes; submit attachments separately.')
        executionInput.codeReview = await captureCodeReview(currentDatabase(input.review.kind === 'recorded' ? input.review.threadId : input.threadId), input.review, thread?.projectId ?? executionInput.newThread!.projectId)
        executionInput.text = codeReviewPrompt(executionInput.codeReview)
        delete executionInput.displayText
      }
      const result = await currentRuntime().submitRunWithAttachments(executionInput)
      if (result.events) startForwardingEvents(event.sender, result.events)
      return {
        thread: result.thread,
        run: result.run,
        ...(result.userMessage ? { userMessage: result.userMessage } : {})
      }
    }
    const submission = input.newThread
      ? enqueueWorkspaceMutation(submit)
      : submit()
    pendingRunSubmissions.set(submissionId, submission)
    try {
      return await submission
    } finally {
      if (pendingRunSubmissions.get(submissionId) === submission) {
        pendingRunSubmissions.delete(submissionId)
      }
    }
  })
  handleAgentIpc('agent:runs:compress', async (
    event,
    threadId: string
  ): Promise<AgentRun> => {
    const thread = currentDatabase(threadId).getThread(threadId)
    if (!thread) throw new Error(`Thread ${threadId} was not found.`)
    const project = await getProject(thread.projectId)
    if (project.kind === 'simple_chat') {
      throw new Error('Context compression is unavailable in simple chat mode.')
    }
    const runId = randomUUID()
    const events = currentRuntime().startCompression(threadId, runId)
    const run = currentDatabase(threadId).getRun(runId)
    if (!run) throw new Error(`Compression run ${runId} was not created.`)
    startForwardingEvents(event.sender, events)
    return run
  })
  handleAgentIpc('agent:runs:recover', (
    event,
    threadId: string
  ): boolean => {
    const events = currentRuntime().recoverRun(threadId)
    if (!events) return false
    startForwardingEvents(event.sender, events)
    return true
  })
  handleAgentIpc('agent:runs:resume', async (
    event,
    input: AgentResumeInput
  ): Promise<AgentRun> => {
    const events = await currentRuntime().resumeRun(input)
    const run = currentDatabase(input.threadId).getRun(input.runId)
    if (!run) throw new Error(`Run ${input.runId} was not found.`)
    startForwardingEvents(event.sender, events)
    return run
  })
  handleAgentIpc('agent:runs:steer', (
    _event,
    input: AgentRunDirectionInput
  ): Promise<boolean> => currentRuntime().steerRun(input))
  handleAgentIpc('agent:runs:steer:remove', (
    _event,
    input: AgentRunDirectionReferenceInput
  ): Promise<boolean> => currentRuntime().removeSteer(input))
  handleAgentIpc('agent:runs:cancel', (
    _event,
    input: AgentRunReferenceInput
  ): AgentRunCancellationResult => currentRuntime().cancelRun(input))
  handleAgentIpc('agent:messages:truncate', async (
    _event,
    input: AgentMessageRangeInput
  ): Promise<AgentThreadSnapshot> => currentRuntime().truncateMessages(input))
  handleAgentIpc('agent:messages:prepareEdit', async (
    _event,
    input: AgentMessageRangeInput
  ): Promise<AgentMessageEditResult> => currentRuntime().prepareMessageEdit(input))
  handleAgentIpc('agent:messages:regenerate', async (
    event,
    input: AgentMessageRegenerateInput
  ): Promise<AgentRun> => {
    const { run, events } = await currentRuntime().regenerateMessage(
      createAgentMessageRegenerateExecutionInput(input)
    )
    startForwardingEvents(event.sender, events)
    return run
  })
  handleAgentIpc('agent:messages:loadEarlier', async (
    _event,
    input: AgentMessageWindowInput
  ): Promise<AgentThreadSnapshot> => currentRuntime().loadEarlierMessages(input))
}

export async function closeAgentRuntime(options: {
  allowIncomplete?: boolean
  timeoutMs?: number
} = {}): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? agentRuntimeCloseTimeoutMs
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
    throw new Error('Agent runtime close timeout must be a non-negative safe integer.')
  }
  if (agentRuntimeLifecycle === 'closed') return true
  const attempt = agentRuntimeCloseAttempt ?? beginAgentRuntimeClose(timeoutMs)
  agentRuntimeCloseAttempt = attempt
  try {
    const closed = await attempt
    if (closed) return true
    runtimeLog('warn', 'agent', 'Agent runtime did not stop before the close deadline.')
    if (options.allowIncomplete) return false
    throw new Error(
      'Agent runtime is still stopping background work. Try the data operation again after it finishes.'
    )
  } catch (error) {
    if (options.allowIncomplete) {
      runtimeLog('warn', 'agent', 'Agent runtime close failed during application shutdown.', {
        error
      })
      return false
    }
    resumeAfterIncompleteClose()
    throw error
  }
}

export async function initializeAgentRuntime(): Promise<void> {
  if (agentRuntimeLifecycle === 'closing') {
    throw new Error('Agent runtime is still closing.')
  }
  if (agentRuntimeLifecycle === 'closed') {
    agentRuntimeLifecycle = 'open'
    agentRuntimeCloseAttempt = undefined
  }
  await currentRuntime().waitForStartupCleanup()
}

export async function recoverPendingProjectDeletion(): Promise<boolean> {
  const current = currentStorage()
  return recoverProjectDeletion(
    (threadId) => current.getThread(threadId) !== null,
    (projectId) => current.completeProjectDeletion(projectId)
  )
}

export async function deleteProjectLifecycle(projectId: string): Promise<ProjectDeleteResult> {
  return enqueueWorkspaceMutation(async () => {
    await recoverPendingProjectDeletion()
    return currentRuntime().deleteProject(projectId)
  })
}

export async function deleteProjectThreadsLifecycle(projectId: string): Promise<ProjectDeleteResult> {
  return enqueueWorkspaceMutation(async () => {
    await recoverPendingProjectDeletion()
    return currentRuntime().deleteProjectThreads(projectId)
  })
}
