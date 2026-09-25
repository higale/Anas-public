import { HumanMessage } from '@langchain/core/messages'
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint'
import type Database from 'better-sqlite3'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as attachmentStore from './agentAttachmentStore'
import { AgentDatabase } from './agentDatabase'
import { AgentRuntime } from './agentRuntime'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function editableConversation(onFileChanges?: (runId: string) => void) {
  const root = await mkdtemp(join(tmpdir(), 'anas-history-cleanup-'))
  roots.push(root)
  const attachmentRoot = join(root, 'attachments')
  const temporaryRoot = join(root, 'temporary')
  const databasePath = join(root, 'conversation.sqlite')
  const database = AgentDatabase.open(databasePath, attachmentRoot, onFileChanges)
  const source = join(root, 'original.txt')
  await writeFile(source, 'original attachment')
  const thread = database.createThread({ title: 'Editable conversation' })
  const runId = 'editable-run'
  const messageId = `${runId}:input`
  const archived = await attachmentStore.archiveAgentAttachments([{
    path: source, name: 'original.txt', size: 19, mimeType: 'text/plain',
    kind: 'text', contextPolicy: 'conversation'
  }], { threadId: thread.id, runId, messageId }, attachmentRoot)
  database.createRun(thread.id, runId, 'agent', archived)
  const checkpoint = emptyCheckpoint()
  checkpoint.channel_values = {
    messages: [new HumanMessage({ id: messageId, content: 'Keep my draft', additional_kwargs: { anas_run_id: runId } })],
    anasRunLifecycle: { runId, status: 'completed' }
  }
  await database.checkpointer.put({ configurable: { thread_id: thread.id } }, checkpoint, { source: 'loop', step: 1, parents: {} })
  database.finishRun(runId, 'completed')
  return { database, databasePath, attachmentRoot, temporaryRoot, thread, runId, messageId, artifact: archived[0].artifact }
}

function runtimeFor(database: AgentDatabase, temporaryRoot: string): AgentRuntime {
  return new AgentRuntime(database, async () => { throw new Error('Editing must not call a model') }, temporaryRoot, async () => {})
}

it('returns an intact edit draft when obsolete attachment cleanup fails, and retries cleanup after reopening', async () => {
  const onFileChanges = vi.fn()
  const fixture = await editableConversation(onFileChanges)
  let database = fixture.database
  let runtime = runtimeFor(database, fixture.temporaryRoot)
  try {
    await runtime.waitForStartupCleanup()
    const cleanup = vi.spyOn(attachmentStore, 'deleteArchivedAgentAttachments')
      .mockRejectedValueOnce(Object.assign(new Error('attachment busy'), { code: 'EPERM' }))
    onFileChanges.mockClear()
    const draft = await runtime.prepareMessageEdit({ threadId: fixture.thread.id, messageId: fixture.messageId })
    expect(draft.snapshot.messages).toEqual([])
    expect(onFileChanges).toHaveBeenCalledWith(fixture.runId)
    expect(database.getRun(fixture.runId)).toBeNull()
    expect(await readFile(draft.attachments[0].path, 'utf8')).toBe('original attachment')
    expect(database.listAttachmentFileCleanup()).toEqual([{ id: fixture.artifact.id, path: fixture.artifact.path }])
    expect(await readFile(fixture.artifact.path, 'utf8')).toBe('original attachment')
    await runtime.shutdown()
    database.close()

    cleanup.mockRestore()
    database = AgentDatabase.open(fixture.databasePath, fixture.attachmentRoot)
    runtime = runtimeFor(database, fixture.temporaryRoot)
    await runtime.waitForStartupCleanup()
    expect(database.listAttachmentFileCleanup()).toEqual([])
    await expect(stat(fixture.artifact.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(draft.attachments[0].path, 'utf8')).toBe('original attachment')
  } finally {
    await runtime.shutdown()
    database.close()
  }
})

it('rolls history and attachment references back if durable cleanup enqueue fails', async () => {
  const onFileChanges = vi.fn()
  const fixture = await editableConversation(onFileChanges)
  const { database } = fixture
  try {
    const raw = (database as unknown as { database: Database.Database }).database
    raw.exec(`CREATE TRIGGER reject_cleanup BEFORE INSERT ON agent_attachment_file_cleanup_outbox
      BEGIN SELECT RAISE(ABORT, 'cleanup unavailable'); END`)
    onFileChanges.mockClear()
    await expect(database.replaceMessageHistory(fixture.thread.id, [], fixture.runId)).rejects.toThrow('cleanup unavailable')
    expect(onFileChanges).not.toHaveBeenCalled()
    expect((await database.readMessageWindow(fixture.thread.id)).messages.map((message) => message.id)).toEqual([fixture.messageId])
    expect(database.getRun(fixture.runId)?.status).toBe('completed')
    expect(database.listAttachmentsForThread(fixture.thread.id).map((attachment) => attachment.id)).toEqual([fixture.artifact.id])
    expect(database.listAttachmentFileCleanup()).toEqual([])
    expect(await readFile(fixture.artifact.path, 'utf8')).toBe('original attachment')
  } finally { database.close() }
})

it('rejects cleanup entries that would remove an attachment still used by the conversation', async () => {
  const fixture = await editableConversation()
  const { database } = fixture
  try {
    const raw = (database as unknown as { database: Database.Database }).database
    raw.prepare(`INSERT INTO agent_attachment_file_cleanup_outbox(attachment_id, thread_id, storage_path)
      SELECT id, thread_id, storage_path FROM agent_attachments WHERE id = ?`).run(fixture.artifact.id)
    expect(() => database.listAttachmentFileCleanup()).toThrow('cannot be scheduled for cleanup')
    expect(await readFile(fixture.artifact.path, 'utf8')).toBe('original attachment')
  } finally { database.close() }
})
