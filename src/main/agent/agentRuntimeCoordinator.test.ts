import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentRuntime } from './agentRuntime'
import { AgentRuntimeCoordinator } from './agentRuntimeCoordinator'
import { AgentStorage } from './agentStorage'
import { getAgentConversationDatabaseFile } from '../config/dataDir'

vi.mock('../projectStore', () => ({
  getProject: vi.fn(async (id: string) => ({ id, kind: 'workspace', sourceFolders: [] })),
  deleteProjectWithThreads: vi.fn(async (_id: string, _threads: string[], commit: (apply: () => void) => void) => commit(() => {}))
}))
vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))

let directory: string | undefined
let storage: AgentStorage | undefined
let coordinator: AgentRuntimeCoordinator | undefined

async function fixture() {
  directory = await mkdtemp(join(tmpdir(), 'anas-conversation-routing-'))
  storage = AgentStorage.open(directory)
  const createRuntime = vi.fn((database) => new AgentRuntime(
    database,
    async () => { throw new Error('This routing test must not call a model.') },
    directory,
    async () => {}
  ))
  coordinator = new AgentRuntimeCoordinator(storage, undefined, createRuntime)
  return { directory, storage, coordinator, createRuntime }
}

afterEach(async () => {
  await coordinator?.shutdown()
  storage?.close()
  coordinator = undefined
  storage = undefined
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
  vi.restoreAllMocks()
})

describe('conversation runtime routing', () => {
  it('uses one runtime per conversation and reads a catalog without opening runtimes', async () => {
    const { storage, coordinator, createRuntime } = await fixture()
    const first = storage.createThread({ title: 'First', projectId: 'project-a' })
    const second = storage.createThread({ title: 'Second', projectId: 'project-a' })
    expect(storage.listThreads().map((thread) => thread.id).sort()).toEqual([first.id, second.id].sort())
    expect(createRuntime).not.toHaveBeenCalled()
    expect(coordinator.forThread(first.id)).toBe(coordinator.forThread(first.id))
    expect(coordinator.forThread(second.id)).not.toBe(coordinator.forThread(first.id))
    expect(createRuntime).toHaveBeenCalledTimes(2)
    expect((await coordinator.getSnapshot(first.id)).thread.id).toBe(first.id)
    expect((await coordinator.getSnapshot(second.id)).thread.id).toBe(second.id)
  })

  it('rejects a project with a busy conversation before deleting any conversation', async () => {
    const { directory, storage, coordinator } = await fixture()
    const idle = storage.createThread({ title: 'Idle', projectId: 'project-a' })
    const busy = storage.createThread({ title: 'Busy', projectId: 'project-a' })
    storage.conversationForThread(busy.id).createRun(busy.id, randomUUID())

    await expect(coordinator.deleteProjectThreads('project-a')).rejects.toThrow('is busy')
    expect(storage.getThread(idle.id)).not.toBeNull()
    expect(storage.getThread(busy.id)).not.toBeNull()
    expect(existsSync(getAgentConversationDatabaseFile(idle.id, directory))).toBe(true)
    expect(existsSync(getAgentConversationDatabaseFile(busy.id, directory))).toBe(true)
  })

  it('deletes the selected project conversations and leaves another project readable', async () => {
    const { directory, storage, coordinator } = await fixture()
    const first = storage.createThread({ title: 'Selected 1', projectId: 'project-a' })
    const second = storage.createThread({ title: 'Selected 2', projectId: 'project-a' })
    const retained = storage.createThread({ title: 'Retained', projectId: 'project-b' })
    const result = await coordinator.deleteProjectThreads('project-a')
    expect(result.deletedThreadIds.sort()).toEqual([first.id, second.id].sort())
    expect(storage.listThreads().map((thread) => thread.id)).toEqual([retained.id])
    expect(existsSync(getAgentConversationDatabaseFile(first.id, directory))).toBe(false)
    expect(existsSync(getAgentConversationDatabaseFile(second.id, directory))).toBe(false)
    expect((await coordinator.getSnapshot(retained.id)).thread.title).toBe('Retained')
  })

  it('blocks new runs in a project while its conversations are being removed', async () => {
    const { storage, coordinator } = await fixture()
    const thread = storage.createThread({ title: 'Deleting', projectId: 'project-a' })
    const other = storage.createThread({ title: 'Keep', projectId: 'project-b' })
    const runtime = coordinator.forThread(thread.id)
    let release!: () => void
    let entered!: () => void
    const enteredDeletion = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const remove = runtime.deleteThread.bind(runtime)
    vi.spyOn(runtime, 'deleteThread').mockImplementation(async (id) => {
      entered()
      await gate
      await remove(id)
    })
    const deletion = coordinator.deleteProjectThreads('project-a')
    await enteredDeletion
    try {
      await expect(coordinator.submitRunWithAttachments({
        submissionId: randomUUID(), runId: randomUUID(), threadId: randomUUID(),
        newThread: { projectId: 'project-a', title: 'Must not start' }, text: 'New work'
      })).rejects.toThrow('being deleted')
      expect(() => coordinator.updateThread(other.id, { projectId: 'project-a' })).toThrow('target project')
      expect(storage.getThread(other.id)?.projectId).toBe('project-b')
      expect(storage.listThreads()).toHaveLength(2)
    } finally {
      release()
      await deletion
    }
  })

  it('checks all running conversations before clearing shared memory', async () => {
    const { storage, coordinator } = await fixture()
    const thread = storage.createThread({ title: 'Working' })
    const runtime = coordinator.forThread(thread.id)
    vi.spyOn(runtime, 'hasLiveWork').mockReturnValue(true)
    const clear = vi.spyOn(storage.memoryStore, 'clearMemories')
    expect(() => coordinator.clearMemories()).toThrow('Agent runs are active')
    expect(clear).not.toHaveBeenCalled()
  })

  it('rejects project deletion while a new conversation has not reached the catalog', async () => {
    const { storage, coordinator, createRuntime } = await fixture()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const pendingSubmission = new Promise<void>((resolve) => { entered = resolve })
    const factory = createRuntime.getMockImplementation()!
    createRuntime.mockImplementationOnce((database) => {
      const runtime = factory(database)
      vi.spyOn(runtime, 'submitRunWithAttachments').mockImplementation(async () => {
        entered()
        await gate
        throw new Error('Submission stopped after attachment staging.')
      })
      return runtime
    })
    const submission = coordinator.submitRunWithAttachments({
      submissionId: randomUUID(), runId: randomUUID(), threadId: randomUUID(),
      newThread: { projectId: 'project-a', title: 'Creating' }, text: 'New work'
    })
    const rejected = expect(submission).rejects.toThrow('Submission stopped')
    await pendingSubmission
    try {
      expect(storage.listThreads()).toEqual([])
      await expect(coordinator.deleteProject('project-a')).rejects.toThrow('still being created')
    } finally {
      release()
      await rejected
    }
    await expect(coordinator.deleteProject('project-a')).resolves.toMatchObject({ deletedThreadIds: [] })
  })

  it('checks unopened pending conversations before clearing shared memory', async () => {
    const { storage, coordinator, createRuntime } = await fixture()
    const thread = storage.createThread({ title: 'Approval' })
    storage.conversationForThread(thread.id).updateThread(thread.id, { status: 'interrupted' })
    storage.refreshConversation(thread.id)
    const clear = vi.spyOn(storage.memoryStore, 'clearMemories')
    expect(createRuntime).not.toHaveBeenCalled()
    expect(() => coordinator.clearMemories()).toThrow('Agent runs are active')
    expect(clear).not.toHaveBeenCalled()
  })

  it('keeps runtime and storage usable when maintenance cannot drain cleanup', async () => {
    const { storage, coordinator } = await fixture()
    const thread = storage.createThread({ title: 'Cleanup pending' })
    const runtime = coordinator.forThread(thread.id)
    vi.spyOn(runtime, 'shutdown').mockResolvedValue({ drained: false, lingeringRunIds: ['cleanup-run'], lingeringCallIds: [] })
    const resume = vi.spyOn(runtime, 'resumeAfterIncompleteShutdown')
    const compact = vi.spyOn(storage, 'compact')
    await expect(coordinator.compactDatabase()).rejects.toThrow('all Agent work to stop')
    expect(compact).not.toHaveBeenCalled()
    expect(resume).toHaveBeenCalledOnce()
    expect(coordinator.forThread(thread.id)).toBe(runtime)
  })

  it('bounds idle handles while preserving an async reader and an unopened approval', async () => {
    const { storage, coordinator } = await fixture()
    const held = storage.createThread({ title: 'Reading' })
    const approval = storage.createThread({ title: 'Approval' })
    const approvalDatabase = storage.conversationForThread(approval.id)
    approvalDatabase.updateThread(approval.id, { status: 'interrupted' })
    storage.refreshConversation(approval.id)
    const heldRuntime = coordinator.forThread(held.id)
    const getSnapshot = heldRuntime.getSnapshot.bind(heldRuntime)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(heldRuntime, 'getSnapshot').mockImplementation(async (threadId) => {
      await gate
      return getSnapshot(threadId)
    })
    const pendingRead = coordinator.getSnapshot(held.id)
    try {
      for (let index = 0; index < 38; index += 1) {
        const thread = storage.createThread({ title: `Idle ${index}` })
        await coordinator.getSnapshot(thread.id)
      }
      coordinator.trimIdleConversations()
      const opened = storage.openedConversations()
      expect(opened).toHaveLength(34)
      expect(opened.map(({ ownerId }) => ownerId)).toEqual(expect.arrayContaining([held.id, approval.id]))
      await expect(coordinator.compactDatabase()).rejects.toThrow('requires Agent runs to finish')
      await expect(coordinator.deleteThread(held.id)).rejects.toThrow('conversation operation is in progress')
    } finally {
      release()
      expect((await pendingRead).thread.title).toBe('Reading')
    }
    coordinator.trimIdleConversations()
    expect(storage.openedConversations()).toHaveLength(33)
    expect((await coordinator.getSnapshot(held.id)).thread.title).toBe('Reading')
  })

  it('keeps the shared catalog open across a pending memory operation and excludes writes during maintenance', async () => {
    const { storage, coordinator } = await fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const memoryWrite = coordinator.useStorage(async (leased) => {
      await gate
      return leased.memoryStore.saveMemory({
        scope: 'global', kind: 'fact', content: 'Keep this memory across maintenance', keywords: ['maintenance'], importance: 3
      }, { origin: 'user' })
    })
    await expect(coordinator.compactDatabase()).rejects.toThrow('requires Agent runs to finish')
    release()
    const saved = await memoryWrite
    expect(saved.content).toBe('Keep this memory across maintenance')
    const maintenance = coordinator.compactDatabase()
    expect(() => coordinator.useStorage((leased) => leased.memoryStore.searchMemories({}))).toThrow('shutting down')
    await maintenance
    expect((await coordinator.useStorage((leased) => leased.memoryStore.searchMemories({}))).items)
      .toEqual([expect.objectContaining({ id: saved.id })])
    expect(storage.getWorkspaceState()).toBeDefined()
  })
})
