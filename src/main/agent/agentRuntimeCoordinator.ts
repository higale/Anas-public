import type {
  AgentRunSubmission,
  AgentRuntimeEvent,
  AgentThreadUpdate,
  AgentThreadCleanupResult
} from '@shared/agentTypes'
import { isAgentThreadLocked } from '@shared/agentTypes'
import { DEFAULT_WORKSPACE_PROJECT_ID, type ProjectDeleteResult } from '@shared/types'
import { getProject, deleteProjectWithThreads } from '../projectStore'
import { runtimeLog } from '../runtimeLogger'
import { AgentThreadLockedError } from './agentErrors'
import { AgentDatabase } from './agentDatabase'
import { AgentRuntime, type AgentRuntimeShutdownResult, type AgentRuntimeSubmission } from './agentRuntime'
import { AgentStorage } from './agentStorage'
import type { AgentRunSubmissionExecutionInput } from './agentRunInput'
import { acquireConversationLease, ownsConversationLease, withConversationLeaseScope } from './agentConversationLease'
import { withApplicationDataMutation } from '../applicationDataSnapshot'

const maximumIdleConversations = 32

/** Product routing only. Each conversation keeps its own framework runtime. */
export class AgentRuntimeCoordinator {
  private readonly runtimes = new Map<AgentDatabase, AgentRuntime>()
  private readonly mutatingProjects = new Set<string>()
  private readonly creatingProjects = new Map<string, object>()
  private closing = false
  private readonly leases = new Map<object, number>()
  private readonly lastUsed = new Map<AgentDatabase, number>()
  private usageSequence = 0
  private pruneTask?: NodeJS.Immediate

  constructor(
    readonly storage: AgentStorage,
    private readonly publishEvent?: (event: AgentRuntimeEvent) => void | Promise<void>,
    private readonly createRuntime = (database: AgentDatabase) => new AgentRuntime(
      database, undefined, undefined, undefined, publishEvent
    )
  ) {}

  databaseForThread(threadId: string): AgentDatabase {
    this.assertOpen()
    const database = this.storage.conversationForThread(threadId)
    const thread = database.getThread(threadId)
    if (!thread) throw new Error(`Thread ${threadId} was not found.`)
    if (this.mutatingProjects.has(thread.projectId)) {
      throw new AgentThreadLockedError(threadId, 'be changed while its project is being deleted')
    }
    this.lease(database)
    return database
  }

  private lease(database: AgentDatabase): void {
    this.lastUsed.set(database, ++this.usageSequence)
    this.leaseResource(database)
    this.schedulePrune()
  }

  private leaseResource(resource: object, onReleased?: () => void): void {
    acquireConversationLease(resource, () => {
      this.leases.set(resource, (this.leases.get(resource) ?? 0) + 1)
      return () => {
        const remaining = (this.leases.get(resource) ?? 1) - 1
        if (remaining === 0) {
          this.leases.delete(resource)
          onReleased?.()
        }
        else this.leases.set(resource, remaining)
        this.schedulePrune()
      }
    })
  }

  storageForOperation(): AgentStorage {
    this.assertOpen()
    this.leaseResource(this.storage)
    return this.storage
  }

  useStorage<T>(operation: (storage: AgentStorage) => T): T {
    return withConversationLeaseScope(() => operation(this.storageForOperation()))
  }

  private schedulePrune(): void {
    if (this.closing || this.pruneTask) return
    this.pruneTask = setImmediate(() => {
      this.pruneTask = undefined
      try { this.trimIdleConversations() } catch (error) {
        runtimeLog('warn', 'agent-storage', 'Failed to close an idle conversation database.', { error })
      }
    })
    this.pruneTask.unref()
  }

  trimIdleConversations(): void {
    if (this.closing) return
    const idle = this.storage.openedConversations().filter(({ ownerId, database }) =>
      !this.leases.has(database)
      && !this.mutatingProjects.has(this.storage.getThread(ownerId)?.projectId ?? '')
      && !isAgentThreadLocked(this.storage.getThread(ownerId)?.status ?? 'idle')
      && !this.runtimes.get(database)?.hasLiveWork()
    ).sort((a, b) => (this.lastUsed.get(a.database) ?? 0) - (this.lastUsed.get(b.database) ?? 0))
    let excess = idle.length - maximumIdleConversations
    for (const { ownerId, database } of idle) {
      if (excess <= 0) break
      const runtime = this.runtimes.get(database)
      if (runtime && !runtime.retireIfIdle()) continue
      this.runtimes.delete(database)
      this.lastUsed.delete(database)
      this.storage.closeConversation(ownerId)
      excess -= 1
    }
  }

  private useRuntime<T>(threadId: string, operation: (runtime: AgentRuntime) => T): T {
    return withConversationLeaseScope(() => operation(this.forThread(threadId)))
  }

  private runtimeForDatabase(database: AgentDatabase): AgentRuntime {
    this.lease(database)
    let runtime = this.runtimes.get(database)
    if (!runtime) {
      runtime = this.createRuntime(database)
      this.runtimes.set(database, runtime)
    }
    return runtime
  }

  forThread(threadId: string): AgentRuntime {
    return this.runtimeForDatabase(this.databaseForThread(threadId))
  }

  updateThread(threadId: string, update: AgentThreadUpdate) {
    this.databaseForThread(threadId)
    if (update.projectId && this.mutatingProjects.has(update.projectId)) {
      throw new AgentThreadLockedError(threadId, 'be moved while its target project is being deleted')
    }
    return this.storage.updateThread(threadId, update)
  }

  private assertOpen(): void {
    if (this.closing) throw new Error('Agent runtime is shutting down.')
  }

  getRunSubmission(submissionId: string): AgentRunSubmission | undefined {
    const ownerId = this.storage.submissionOwner(submissionId)
    return ownerId ? this.forThread(ownerId).getRunSubmission(submissionId) : undefined
  }

  submitRunWithAttachments(input: AgentRunSubmissionExecutionInput): Promise<AgentRuntimeSubmission> {
    return withConversationLeaseScope(() => this.submitRun(input))
  }

  private async submitRun(input: AgentRunSubmissionExecutionInput): Promise<AgentRuntimeSubmission> {
    this.assertOpen()
    const existing = this.getRunSubmission(input.submissionId)
    if (existing) return existing
    if (!input.newThread) return this.useRuntime(input.threadId, (runtime) => runtime.submitRunWithAttachments(input))
    if (this.mutatingProjects.has(input.newThread.projectId)) {
      throw new AgentThreadLockedError(input.threadId, 'be created while its project is being deleted')
    }
    const projectId = input.newThread.projectId
    const creation = this.creatingProjects.get(projectId) ?? {}
    this.creatingProjects.set(projectId, creation)
    this.leaseResource(creation, () => {
      if (this.creatingProjects.get(projectId) === creation) this.creatingProjects.delete(projectId)
    })
    const database = this.storage.openConversation(input.threadId, { create: true })
    const runtime = this.runtimeForDatabase(database)
    try {
      const submission = await runtime.submitRunWithAttachments(input)
      this.storage.refreshConversation(input.threadId)
      return submission
    } catch (error) {
      if (!database.getThread(input.threadId)) {
        await runtime.shutdown()
        this.runtimes.delete(database)
        await this.storage.removeConversation(input.threadId)
      }
      throw error
    }
  }

  listQueuedInputs() {
    return this.storage.queuedConversationIds().flatMap((ownerId) => this.forThread(ownerId).listQueuedInputs())
  }

  enqueueQueuedInput(...args: Parameters<AgentRuntime['enqueueQueuedInput']>) {
    return this.useRuntime(args[0].threadId, (runtime) => runtime.enqueueQueuedInput(...args))
  }

  removeQueuedInput(...args: Parameters<AgentRuntime['removeQueuedInput']>) {
    return this.useRuntime(args[0], (runtime) => runtime.removeQueuedInput(...args))
  }

  markQueuedInputFailed(...args: Parameters<AgentRuntime['markQueuedInputFailed']>) {
    return this.useRuntime(args[0], (runtime) => runtime.markQueuedInputFailed(...args))
  }

  retryQueuedInput(...args: Parameters<AgentRuntime['retryQueuedInput']>) {
    return this.useRuntime(args[0], (runtime) => runtime.retryQueuedInput(...args))
  }

  getSnapshot(...args: Parameters<AgentRuntime['getSnapshot']>) {
    return this.useRuntime(args[0], (runtime) => runtime.getSnapshot(...args))
  }

  startCompression(...args: Parameters<AgentRuntime['startCompression']>) {
    return this.useRuntime(args[0], (runtime) => runtime.startCompression(...args))
  }

  recoverRun(...args: Parameters<AgentRuntime['recoverRun']>) {
    return this.useRuntime(args[0], (runtime) => runtime.recoverRun(...args))
  }

  resumeRun(...args: Parameters<AgentRuntime['resumeRun']>) {
    return this.useRuntime(args[0].threadId, (runtime) => runtime.resumeRun(...args))
  }

  steerRun(...args: Parameters<AgentRuntime['steerRun']>) {
    return this.useRuntime(args[0].threadId, (runtime) => runtime.steerRun(...args))
  }

  removeSteer(...args: Parameters<AgentRuntime['removeSteer']>) {
    return this.useRuntime(args[0].threadId, (runtime) => runtime.removeSteer(...args))
  }

  cancelRun(...args: Parameters<AgentRuntime['cancelRun']>) {
    return this.useRuntime(args[0].threadId, (runtime) => runtime.cancelRun(...args))
  }

  truncateMessages(...args: Parameters<AgentRuntime['truncateMessages']>) {
    return this.useRuntime(args[0].threadId, (runtime) => runtime.truncateMessages(...args))
  }

  prepareMessageEdit(...args: Parameters<AgentRuntime['prepareMessageEdit']>) {
    return this.useRuntime(args[0].threadId, (runtime) => runtime.prepareMessageEdit(...args))
  }

  regenerateMessage(...args: Parameters<AgentRuntime['regenerateMessage']>) {
    return this.useRuntime(args[0].threadId, (runtime) => runtime.regenerateMessage(...args))
  }

  loadEarlierMessages(...args: Parameters<AgentRuntime['loadEarlierMessages']>) {
    return this.useRuntime(args[0].threadId, (runtime) => runtime.loadEarlierMessages(...args))
  }

  loadEarlierActivities(...args: Parameters<AgentRuntime['loadEarlierActivities']>) {
    return this.useRuntime(args[0].threadId, (runtime) => runtime.loadEarlierActivities(...args))
  }

  previewSystemContext(...args: Parameters<AgentRuntime['previewSystemContext']>) {
    return withConversationLeaseScope(() => {
      const runtime = this.runtimeForDatabase(this.storage.previewDatabase())
      return runtime.previewSystemContext(...args)
    })
  }

  getContextStatus(threadId: string) {
    return this.useRuntime(threadId, (runtime) => runtime.getContextStatus(threadId))
  }

  previewModelRequest(...args: Parameters<AgentRuntime['previewModelRequest']>) {
    return withConversationLeaseScope(() => {
      const runtime = this.runtimeForDatabase(this.storage.previewDatabase())
      return runtime.previewModelRequest(...args)
    })
  }

  deleteThread(threadId: string): Promise<void> {
    return withApplicationDataMutation(() => withConversationLeaseScope(() => this.deleteConversation(threadId)))
  }

  private async deleteConversation(threadId: string): Promise<void> {
    this.assertOpen()
    const thread = this.storage.getThread(threadId)
    if (!thread) throw new Error(`Conversation ${threadId} was not found.`)
    if (this.mutatingProjects.has(thread.projectId)) throw new AgentThreadLockedError(threadId, 'be deleted while its project is being deleted')
    const database = this.storage.conversationForDeletion(threadId)
    if (database) {
      this.assertNoOtherLeases(database, threadId)
      const runtime = this.runtimeForDatabase(database)
      if (database.getThread(threadId)) runtime.assertCanDeleteThread(threadId)
    }
    await this.deletePreparedConversation(threadId, database)
  }

  private async deletePreparedConversation(threadId: string, database?: AgentDatabase): Promise<void> {
    this.storage.beginConversationDeletion(threadId)
    if (!database) {
      await this.storage.removeConversation(threadId)
      return
    }
    const runtime = this.runtimeForDatabase(database)
    if (database.getThread(threadId)) await runtime.deleteThread(threadId)
    await this.removeConversation(threadId, database)
  }

  private async removeConversation(ownerId: string, database: AgentDatabase): Promise<void> {
    const runtime = this.runtimes.get(database)
    if (runtime) {
      const result = await runtime.shutdown()
      if (!result.drained) throw new AgentThreadLockedError(ownerId, 'be removed before its work stops')
      await runtime.finishDeletionCleanup()
    }
    this.runtimes.delete(database)
    this.lastUsed.delete(database)
    await this.storage.removeConversation(ownerId)
  }

  cleanupThreads(): Promise<AgentThreadCleanupResult> {
    return withApplicationDataMutation(() => withConversationLeaseScope(() => this.cleanupConversations()))
  }

  private async cleanupConversations(): Promise<AgentThreadCleanupResult> {
    const result: AgentThreadCleanupResult = {
      deleted: 0, skipped: 0, failed: 0,
      deletedThreadIds: [], skippedThreadIds: [], failures: []
    }
    for (const thread of this.storage.listThreads().filter((item) => !item.pinned)) {
      if (isAgentThreadLocked(thread.status) || this.mutatingProjects.has(thread.projectId)) {
        result.skippedThreadIds.push(thread.id)
        continue
      }
      try {
        const database = this.storage.conversationForDeletion(thread.id)
        if (database && (this.runtimeForDatabase(database).hasLiveWork()
          || database.listThreadIdsWithUnresolvedManagedCalls().length > 0)) {
          result.skippedThreadIds.push(thread.id)
          continue
        }
        await this.deleteConversation(thread.id)
        result.deletedThreadIds.push(thread.id)
      } catch (error) {
        result.failures.push({ threadId: thread.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    result.deleted = result.deletedThreadIds.length
    result.skipped = result.skippedThreadIds.length
    result.failed = result.failures.length
    return result
  }

  deleteProjectThreads(projectId: string): Promise<ProjectDeleteResult> {
    return withApplicationDataMutation(() => withConversationLeaseScope(() => this.deleteProjectConversations(projectId, false)))
  }

  deleteProject(projectId: string): Promise<ProjectDeleteResult> {
    if (projectId === DEFAULT_WORKSPACE_PROJECT_ID) {
      return Promise.reject(new Error('The default workspace project cannot be deleted.'))
    }
    return withApplicationDataMutation(() => withConversationLeaseScope(() => this.deleteProjectConversations(projectId, true)))
  }

  private async deleteProjectConversations(projectId: string, removeProject: boolean): Promise<ProjectDeleteResult> {
    this.assertOpen()
    if (this.mutatingProjects.has(projectId)) throw new Error('Project conversation deletion is already running.')
    if (this.creatingProjects.has(projectId)) throw new Error('Project conversations are still being created.')
    this.mutatingProjects.add(projectId)
    try {
      await getProject(projectId)
      const threads = this.storage.listThreads().filter((thread) => thread.projectId === projectId)
      const targets = threads.map((thread) => {
        if (isAgentThreadLocked(thread.status)) throw new AgentThreadLockedError(thread.id, 'be deleted with its project')
        const database = this.storage.conversationForDeletion(thread.id)
        if (database) {
          this.assertNoOtherLeases(database, thread.id)
          const runtime = this.runtimeForDatabase(database)
          if (database.getThread(thread.id)) runtime.assertCanDeleteThread(thread.id)
          if (runtime.hasLiveWork()) throw new AgentThreadLockedError(thread.id, 'be deleted with its project')
        }
        return { thread, database }
      })
      const deletedThreadIds: string[] = []
      for (const { thread, database } of targets) {
        await this.deletePreparedConversation(thread.id, database)
        deletedThreadIds.push(thread.id)
      }
      if (removeProject) {
        await deleteProjectWithThreads(projectId, deletedThreadIds, (commitProjectStore) => {
          this.storage.completeProjectDeletion(projectId)
          commitProjectStore()
        })
      }
      return { projectId, deletedThreadIds }
    } finally {
      this.mutatingProjects.delete(projectId)
    }
  }

  clearMemories(): number {
    this.assertOpen()
    if ([...this.runtimes.values()].some((runtime) => runtime.hasLiveWork())
      || this.storage.listThreads().some((thread) => isAgentThreadLocked(thread.status))) {
      throw new Error('Memories cannot be cleared while Agent runs are active.')
    }
    return this.storage.memoryStore.clearMemories()
  }

  getStorageUsage() { return this.storage.getStorageUsage() }

  private assertNoOtherLeases(database: AgentDatabase, threadId: string): void {
    if ((this.leases.get(database) ?? 0) > (ownsConversationLease(database) ? 1 : 0)) {
      throw new AgentThreadLockedError(threadId, 'be removed while a conversation operation is in progress')
    }
  }

  async compactDatabase(): Promise<void> {
    if ([...this.leases].some(([resource, count]) => count > (ownsConversationLease(resource) ? 1 : 0))
      || [...this.runtimes.values()].some((runtime) => runtime.hasLiveWork())
      || this.storage.listThreads().some((thread) => isAgentThreadLocked(thread.status))) {
      throw new Error('Database maintenance requires Agent runs to finish.')
    }
    const stopped = await this.shutdown()
    if (!stopped.drained) {
      this.resumeAfterIncompleteShutdown()
      throw new Error('Database maintenance requires all Agent work to stop.')
    }
    this.runtimes.clear()
    this.lastUsed.clear()
    try {
      await this.storage.compact()
    } finally {
      this.closing = false
    }
  }

  async waitForStartupCleanup(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.waitForStartupCleanup()))
  }

  async shutdown(options: { timeoutMs?: number } = {}): Promise<AgentRuntimeShutdownResult> {
    this.closing = true
    if (this.pruneTask) clearImmediate(this.pruneTask)
    this.pruneTask = undefined
    const results = await Promise.all([...this.runtimes.values()].map((runtime) => runtime.shutdown(options)))
    return {
      drained: results.every((result) => result.drained),
      lingeringRunIds: results.flatMap((result) => result.lingeringRunIds),
      lingeringCallIds: results.flatMap((result) => result.lingeringCallIds)
    }
  }

  resumeAfterIncompleteShutdown(): void {
    this.closing = false
    for (const runtime of this.runtimes.values()) runtime.resumeAfterIncompleteShutdown()
  }
}
