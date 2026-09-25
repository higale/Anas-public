import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HumanMessage } from '@langchain/core/messages'
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentStorage } from './agentStorage'
import { AgentDatabase } from './agentDatabase'
import { AgentRuntime } from './agentRuntime'
import { AgentRuntimeCoordinator } from './agentRuntimeCoordinator'
import { snapshotAgentStorage } from './agentDatabaseBackup'
import { getAgentConversationDatabaseFile } from '../config/dataDir'

const faults = vi.hoisted(() => ({ failRm: '' }))
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, rm: async (...args: Parameters<typeof actual.rm>) => {
    if (String(args[0]) === faults.failRm) throw Object.assign(new Error('File temporarily in use'), { code: 'EPERM' })
    return actual.rm(...args)
  } }
})
vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
vi.mock('../projectStore', () => ({ getProject: vi.fn(async (id: string) => ({ id, kind: 'workspace', sourceFolders: [] })) }))

const roots: string[] = []
let storage: AgentStorage | undefined
let coordinator: AgentRuntimeCoordinator | undefined
function route(current: AgentStorage, root: string) {
  return new AgentRuntimeCoordinator(current, undefined, database => new AgentRuntime(database,
    async () => { throw new Error('No model in deletion test') }, root, async () => {}))
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'anas-conversation-deletion-'))
  roots.push(root)
  storage = AgentStorage.open(root)
  coordinator = route(storage, root)
  return { root, storage, coordinator }
}
afterEach(async () => {
  faults.failRm = ''
  await coordinator?.shutdown()
  storage?.close()
  coordinator = undefined; storage = undefined
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

it.each(['database', 'sidecar'] as const)('retries deletion after a transient %s removal failure, including after reopening storage', async kind => {
  const current = await fixture()
  const thread = current.storage.createThread({ title: 'Delete me' })
  const file = getAgentConversationDatabaseFile(thread.id, current.root)
  faults.failRm = `${file}${kind === 'sidecar' ? '-wal' : ''}`
  await expect(current.coordinator.deleteThread(thread.id)).rejects.toMatchObject({ code: 'EPERM' })
  expect(current.storage.isConversationDeleting(thread.id)).toBe(true)
  expect(current.storage.listThreads().map(thread => thread.title)).toEqual(['Delete me'])
  expect(() => current.coordinator.getSnapshot(thread.id)).toThrow('deletion is pending')
  faults.failRm = ''
  await current.coordinator.shutdown()
  current.storage.close()
  storage = AgentStorage.open(current.root)
  coordinator = route(storage, current.root)
  await coordinator.deleteThread(thread.id)
  expect(storage.listThreads()).toEqual([])
  expect(storage.isConversationDeleting(thread.id)).toBe(false)
  expect(existsSync(file)).toBe(false)
})

it('keeps cleanup failure retryable after the main thread row has been deleted', async () => {
  const { root, storage, coordinator } = await fixture()
  const thread = storage.createThread({ title: 'Attachment cleanup' })
  faults.failRm = join(storage.attachmentRoot, thread.id)
  await expect(coordinator.deleteThread(thread.id)).rejects.toThrow('File temporarily in use')
  expect(storage.conversationForDeletion(thread.id)?.getThread(thread.id)).toBeNull()
  expect(storage.isConversationDeleting(thread.id)).toBe(true)
  faults.failRm = ''
  await coordinator.deleteThread(thread.id)
  expect(storage.listThreads()).toEqual([])
  expect(existsSync(getAgentConversationDatabaseFile(thread.id, root))).toBe(false)
})

it('keeps online backups restorable while deletion waits and ordinary checkpoint appends continue', async () => {
  const { root, storage, coordinator } = await fixture()
  const thread = storage.createThread({ title: 'Delete during backup' })
  const database = storage.conversationForThread(thread.id)
  const destination = await mkdtemp(join(tmpdir(), 'anas-online-backup-'))
  roots.push(destination)
  let releaseCatalog!: () => void
  let copiedCatalog!: () => void
  const catalogGate = new Promise<void>(resolve => { releaseCatalog = resolve })
  const catalogReady = new Promise<void>(resolve => { copiedCatalog = resolve })
  const backup = Database.prototype.backup
  vi.spyOn(Database.prototype, 'backup').mockImplementation(async function (this: Database.Database, ...args) {
    const result = await backup.apply(this, args)
    if (this.name.endsWith('catalog.sqlite')) { copiedCatalog(); await catalogGate }
    return result
  })
  const copying = snapshotAgentStorage(root, destination)
  await catalogReady
  const deleting = coordinator.deleteThread(thread.id)
  try {
    await database.checkpointer.put({ configurable: { thread_id: thread.id } }, {
      ...emptyCheckpoint(), channel_values: { messages: [new HumanMessage({ id: 'message', content: 'Completed while backing up' })] },
      channel_versions: { messages: 1 }
    }, { source: 'input', step: 0, parents: {} }, { messages: 1 })
    expect(database.getThread(thread.id)?.title).toBe('Delete during backup')
    expect(storage.isConversationDeleting(thread.id)).toBe(false)
  } finally { releaseCatalog() }
  await expect(copying).resolves.toHaveLength(2)
  await deleting
  expect(() => AgentDatabase.validateBackup(getAgentConversationDatabaseFile(thread.id, destination),
    join(destination, 'attachments'), new Set([thread.projectId]), thread.id)).not.toThrow()
  expect(storage.listThreads()).toEqual([])
})

it('omits accepted pending deletions from the backup catalog without changing the source', async () => {
  const { root, storage, coordinator } = await fixture()
  const deleted = storage.createThread({ title: 'Deleting' })
  const retained = storage.createThread({ title: 'Keep' })
  faults.failRm = getAgentConversationDatabaseFile(deleted.id, root)
  await expect(coordinator.deleteThread(deleted.id)).rejects.toThrow('File temporarily in use')
  faults.failRm = ''
  const destination = await mkdtemp(join(tmpdir(), 'anas-pending-deletion-backup-'))
  roots.push(destination)
  const files = await snapshotAgentStorage(root, destination)
  expect(files.map(file => file.relPath)).toEqual(['sqlite/catalog.sqlite', `sqlite/conversations/${retained.id}.sqlite`])
  expect(storage.isConversationDeleting(deleted.id)).toBe(true)
  const copied = AgentStorage.open(destination)
  try { expect(copied.listThreads().map(thread => thread.id)).toEqual([retained.id]) } finally { copied.close() }
})
