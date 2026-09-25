import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HumanMessage } from '@langchain/core/messages'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuntimeEvent } from '@shared/agentTypes'
import { AgentDatabase } from './agentDatabase'
import { AgentRuntime } from './agentRuntime'
import {
  archiveAgentAttachments,
  deleteArchivedAgentAttachments
} from './agentAttachmentStore'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'anas-attachment-test-'))
  temporaryDirectories.push(directory)
  return directory
}

async function collect(events: AsyncIterable<AgentRuntimeEvent>): Promise<AgentRuntimeEvent[]> {
  const result: AgentRuntimeEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

async function *empty<T>(): AsyncGenerator<T> {}

async function noOpFileEditCleanup(): Promise<void> {}

async function markRunCompleted(
  database: AgentDatabase,
  threadId: string,
  runId: string,
  values: Record<string, unknown> = {}
): Promise<void> {
  await database.checkpointer.put({
    configurable: { thread_id: threadId, checkpoint_ns: '' }
  }, {
    v: 4,
    id: `${runId}-terminal`,
    ts: new Date().toISOString(),
    channel_values: {
      ...values,
      anasRunLifecycle: { runId, status: 'completed' }
    },
    channel_versions: {},
    versions_seen: {}
  }, {
    source: 'loop',
    step: 1,
    parents: {}
  })
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

describe('agent attachment store', () => {
  it('archives a durable local copy and restores its metadata from SQLite', async () => {
    const root = await temporaryDirectory()
    const sourcePath = join(root, 'source.txt')
    const attachmentRoot = join(root, 'attachments')
    const databasePath = join(root, 'agent.sqlite')
    await writeFile(sourcePath, 'durable attachment', 'utf8')
    const database = AgentDatabase.open(databasePath, attachmentRoot)
    const matchingThread = database.createThread({ title: 'Archived attachment' })
    database.close()
    const matchingRunId = randomUUID()
    const matchingMessageId = `${matchingRunId}:input`

    const matchingArchived = await archiveAgentAttachments([{
      path: sourcePath,
      name: 'source.txt',
      mimeType: 'text/plain',
      size: 18,
      kind: 'text',
      textTruncated: true,
      contextPolicy: 'one_turn'
    }], {
      threadId: matchingThread.id,
      runId: matchingRunId,
      messageId: matchingMessageId
    }, attachmentRoot)
    const writeDatabase = AgentDatabase.open(databasePath, attachmentRoot)
    writeDatabase.createRun(matchingThread.id, matchingRunId, 'agent', matchingArchived)
    await markRunCompleted(writeDatabase, matchingThread.id, matchingRunId)
    writeDatabase.finishRun(matchingRunId, 'completed')
    writeDatabase.close()
    await rm(sourcePath)

    const restoredDatabase = AgentDatabase.open(databasePath, attachmentRoot)
    const [artifact] = restoredDatabase.listAttachmentsForThread(matchingThread.id)
    expect(artifact).toMatchObject({
      threadId: matchingThread.id,
      runId: matchingRunId,
      messageId: matchingMessageId,
      name: 'source.txt',
      mimeType: 'text/plain',
      kind: 'text',
      available: true,
      textTruncated: true,
      contextPolicy: 'one_turn'
    })
    expect(await readFile(artifact.path, 'utf8')).toBe('durable attachment')
    await rm(artifact.path)
    expect(restoredDatabase.listAttachmentsForThread(matchingThread.id)[0].available).toBe(false)
    restoredDatabase.close()
  })

  it('rolls back earlier copies when a later attachment cannot be archived', async () => {
    const root = await temporaryDirectory()
    const sourcePath = join(root, 'source.txt')
    const attachmentRoot = join(root, 'attachments')
    await writeFile(sourcePath, 'first attachment', 'utf8')
    const threadId = randomUUID()
    const runId = randomUUID()

    await expect(archiveAgentAttachments([
      {
        path: sourcePath,
        name: 'source.txt',
        mimeType: 'text/plain',
        size: 16,
        kind: 'text',
        contextPolicy: 'one_turn'
      },
      {
        path: join(root, 'missing.txt'),
        name: 'missing.txt',
        mimeType: 'text/plain',
        size: 0,
        kind: 'text',
        contextPolicy: 'one_turn'
      }
    ], {
      threadId,
      runId,
      messageId: `${runId}:input`
    }, attachmentRoot)).rejects.toThrow()

    const threadEntries = await readdir(join(attachmentRoot, threadId))
    expect(threadEntries).toEqual([])
  })

  it('removes archived copies when run creation fails', async () => {
    const root = await temporaryDirectory()
    const sourcePath = join(root, 'source.txt')
    const attachmentRoot = join(root, 'attachments')
    await writeFile(sourcePath, 'rollback attachment', 'utf8')
    const database = AgentDatabase.open(':memory:', attachmentRoot)
    const runtime = new AgentRuntime(database, undefined, undefined, noOpFileEditCleanup)
    const missingThreadId = randomUUID()
    const runId = randomUUID()

    await expect(runtime.startRunWithAttachments({
      runId,
      threadId: missingThreadId,
      text: 'Read the attachment',
      attachments: [{
        path: sourcePath,
        name: 'source.txt',
        mimeType: 'text/plain',
        size: 19,
        kind: 'text',
        contextPolicy: 'one_turn'
      }]
    })).rejects.toThrow('was not found')

    expect(await readdir(join(attachmentRoot, missingThreadId))).toEqual([])
    expect(database.getRun(runId)).toBeNull()
    database.close()
  })

  it('waits for persisted attachment cleanup during runtime startup', async () => {
    const root = await temporaryDirectory()
    const attachmentRoot = join(root, 'attachments')
    const database = AgentDatabase.open(':memory:', attachmentRoot)
    const thread = database.createThread({ title: 'Startup attachment cleanup' })
    const threadRoot = join(attachmentRoot, thread.id)
    await mkdir(threadRoot, { recursive: true })
    await writeFile(join(threadRoot, 'orphan.txt'), 'remove on startup', 'utf8')
    database.deleteThreadMetadata([thread.id])
    expect(database.listAttachmentCleanupThreadIds()).toEqual([thread.id])

    const runtime = new AgentRuntime(database, undefined, undefined, noOpFileEditCleanup)
    await runtime.waitForStartupCleanup()

    await expect(stat(threadRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(database.listAttachmentCleanupThreadIds()).toEqual([])
    await runtime.shutdown()
    database.close()
  })

  it('publishes the authoritative user message with archived attachment metadata', async () => {
    const root = await temporaryDirectory()
    const sourcePath = join(root, 'source.txt')
    const attachmentRoot = join(root, 'attachments')
    await writeFile(sourcePath, 'event attachment', 'utf8')
    const database = AgentDatabase.open(':memory:', attachmentRoot)
    const thread = database.createThread({ title: 'Attachment event' })
    const cleanupFileEdits = vi.fn(async () => {})
    let graphInput: unknown
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: (input) => {
          graphInput = input
          return Object.assign({
            interrupted: false,
            interrupts: [],
            messages: empty(),
            toolCalls: empty(),
            subagents: empty(),
            output: Promise.resolve(input),
            abort() {}
          }, { [Symbol.asyncIterator]: empty }) as never
        },
        getState: async () => ({}) as never
      },
      dispose: async () => {}
    }), undefined, cleanupFileEdits)

    const events = await collect(await runtime.startRunWithAttachments({
      runId: 'attachment-event-run',
      threadId: thread.id,
      text: 'Review the attachment',
      attachments: [{
        path: sourcePath,
        name: 'source.txt',
        mimeType: 'text/plain',
        size: 16,
        kind: 'text',
        contextPolicy: 'one_turn'
      }]
    }))

    expect(events[0]).toMatchObject({
      type: 'run_started',
      newUserTurn: true,
      userMessage: {
        id: 'attachment-event-run:input',
        role: 'user',
        runId: 'attachment-event-run',
        content: [{ type: 'text', text: 'Review the attachment' }],
        attachments: [{
          threadId: thread.id,
          runId: 'attachment-event-run',
          messageId: 'attachment-event-run:input',
          name: 'source.txt',
          path: expect.stringContaining(attachmentRoot)
        }]
      }
    })
    if (events[0]?.type !== 'run_started' || !events[0].newUserTurn) {
      throw new Error('Expected a new-user-turn run event.')
    }
    expect(events[0].userMessage.attachments?.[0]?.path).not.toBe(sourcePath)
    expect(graphInput).toMatchObject({
      messages: [{
        id: 'attachment-event-run:input',
        additional_kwargs: { anas_run_id: 'attachment-event-run' }
      }]
    })
    expect(cleanupFileEdits).toHaveBeenCalledWith('attachment-event-run')
    database.close()
  })

  it('deletes archived files durably queued by run-range cleanup', async () => {
    const root = await temporaryDirectory()
    const sourcePath = join(root, 'source.txt')
    const attachmentRoot = join(root, 'attachments')
    await writeFile(sourcePath, 'cleanup attachment', 'utf8')
    const database = AgentDatabase.open(':memory:', attachmentRoot)
    const thread = database.createThread({ title: 'Cleanup' })
    const runId = randomUUID()
    const archived = await archiveAgentAttachments([{
      path: sourcePath,
      name: 'source.txt',
      mimeType: 'text/plain',
      size: 18,
      kind: 'text',
      contextPolicy: 'one_turn'
    }], {
      threadId: thread.id,
      runId,
      messageId: `${runId}:input`
    }, attachmentRoot)
    database.createRun(thread.id, runId, 'agent', archived)
    await markRunCompleted(database, thread.id, runId)
    database.finishRun(runId, 'completed')
    await database.replaceMessageHistory(thread.id, [], runId)
    const [artifact] = database.listAttachmentFileCleanup()

    await deleteArchivedAgentAttachments([artifact], attachmentRoot)
    database.acknowledgeAttachmentFileCleanup(artifact.id)
    await expect(stat(artifact.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(database.listAttachmentsForThread(thread.id)).toEqual([])
    expect(database.listAttachmentFileCleanup()).toEqual([])
    database.close()
  })

  it('rebinds target-run attachments and only discards later-run files during regeneration', async () => {
    const root = await temporaryDirectory()
    const attachmentRoot = join(root, 'attachments')
    const targetSource = join(root, 'target.txt')
    const laterSource = join(root, 'later.txt')
    await writeFile(targetSource, 'target attachment', 'utf8')
    await writeFile(laterSource, 'later attachment', 'utf8')
    const database = AgentDatabase.open(':memory:', attachmentRoot)
    const thread = database.createThread({ title: 'Regeneration attachments' })
    const targetRunId = 'target-run'
    const laterRunId = 'later-run'
    const targetMessageId = `${targetRunId}:input`
    const targetArchived = await archiveAgentAttachments([{
      path: targetSource,
      name: 'target.txt',
      mimeType: 'text/plain',
      size: 17,
      kind: 'text',
      contextPolicy: 'one_turn'
    }], {
      threadId: thread.id,
      runId: targetRunId,
      messageId: targetMessageId
    }, attachmentRoot)
    database.createRun(thread.id, targetRunId, 'agent', targetArchived)
    await markRunCompleted(database, thread.id, targetRunId)
    database.finishRun(targetRunId, 'completed')
    const laterArchived = await archiveAgentAttachments([{
      path: laterSource,
      name: 'later.txt',
      mimeType: 'text/plain',
      size: 16,
      kind: 'text',
      contextPolicy: 'conversation'
    }], {
      threadId: thread.id,
      runId: laterRunId,
      messageId: `${laterRunId}:input`
    }, attachmentRoot)
    database.createRun(thread.id, laterRunId, 'agent', laterArchived)
    await markRunCompleted(database, thread.id, laterRunId)
    database.finishRun(laterRunId, 'completed')

    const replacement = await database.replaceMessageHistory(thread.id, [], targetRunId, {
      runId: 'replacement-run',
      inputIntent: {
        kind: 'regeneration',
        message: new HumanMessage({
          id: targetMessageId,
          content: 'Regenerate target',
          additional_kwargs: { anas_run_id: 'replacement-run' }
        }).toDict()
      }
    })

    expect(replacement.run).toMatchObject({ id: 'replacement-run', status: 'running' })
    const discarded = database.listAttachmentFileCleanup()
    expect(discarded).toEqual([expect.objectContaining({ id: laterArchived[0].artifact.id })])
    await deleteArchivedAgentAttachments(discarded, attachmentRoot)
    for (const attachment of discarded) database.acknowledgeAttachmentFileCleanup(attachment.id)
    await expect(stat(laterArchived[0].artifact.path)).rejects.toMatchObject({ code: 'ENOENT' })
    const [preserved] = database.listAttachmentsForThread(thread.id)
    expect(preserved).toMatchObject({
      id: targetArchived[0].artifact.id,
      runId: 'replacement-run',
      messageId: targetMessageId
    })
    expect(await readFile(preserved.path, 'utf8')).toBe('target attachment')
    expect(database.getRun(targetRunId)).toBeNull()
    expect(database.getRun(laterRunId)).toBeNull()
    database.close()
  })

  it('copies message attachments into editable temporary files before truncating history', async () => {
    const root = await temporaryDirectory()
    const attachmentRoot = join(root, 'attachments')
    const temporaryRoot = join(root, 'tmp')
    const sourcePath = join(root, 'editable.txt')
    const imageSourcePath = join(root, 'editable.png')
    await Promise.all([
      writeFile(sourcePath, 'editable attachment', 'utf8'),
      writeFile(imageSourcePath, 'editable image', 'utf8')
    ])
    const database = AgentDatabase.open(':memory:', attachmentRoot)
    const thread = database.createThread({ title: 'Edit attachments' })
    const runId = 'editable-run'
    const messageId = `${runId}:input`
    const archived = await archiveAgentAttachments([
      {
        path: sourcePath,
        name: 'editable.txt',
        mimeType: 'text/plain',
        size: 19,
        kind: 'text',
        textTruncated: true,
        contextPolicy: 'conversation'
      },
      {
        path: imageSourcePath,
        name: 'editable.png',
        mimeType: 'image/png',
        size: 14,
        kind: 'image',
        contextPolicy: 'one_turn'
      }
    ], {
      threadId: thread.id,
      runId,
      messageId
    }, attachmentRoot)
    const values: Record<string, unknown> = {
      messages: [new HumanMessage({
        id: messageId,
        content: 'Review it',
        additional_kwargs: { anas_run_id: runId }
      })],
      todos: []
    }
    database.createRun(thread.id, runId, 'agent', archived)
    await markRunCompleted(database, thread.id, runId, values)
    database.finishRun(runId, 'completed')
    const runtime = new AgentRuntime(database, async () => {
      throw new Error('Editing must not initialize an agent runtime.')
    }, temporaryRoot, noOpFileEditCleanup)

    const result = await runtime.prepareMessageEdit({
      threadId: thread.id,
      messageId
    })

    expect(result.snapshot.messages).toEqual([])
    expect(result.attachments).toEqual([
      expect.objectContaining({
        name: 'editable.txt',
        contextPolicy: 'conversation',
        truncated: true,
        temporary: true
      }),
      expect.objectContaining({
        name: 'editable.png',
        contextPolicy: 'one_turn',
        temporary: true,
        dataUri: `data:image/png;base64,${Buffer.from('editable image').toString('base64')}`
      })
    ])
    expect(await readFile(result.attachments[0].path, 'utf8')).toBe('editable attachment')
    expect(await readFile(result.attachments[1].path, 'utf8')).toBe('editable image')
    await Promise.all(archived.map(({ artifact }) =>
      expect(stat(artifact.path)).rejects.toMatchObject({ code: 'ENOENT' })
    ))

    const missingSource = join(root, 'missing-after-archive.txt')
    await writeFile(missingSource, 'will disappear', 'utf8')
    const missingThread = database.createThread({ title: 'Missing edit attachment' })
    const missingRunId = 'missing-edit-run'
    const missingMessageId = `${missingRunId}:input`
    const missingArchived = await archiveAgentAttachments([{
      path: missingSource,
      name: 'missing-after-archive.txt',
      mimeType: 'text/plain',
      size: 14,
      kind: 'text',
      contextPolicy: 'one_turn'
    }], {
      threadId: missingThread.id,
      runId: missingRunId,
      messageId: missingMessageId
    }, attachmentRoot)
    database.createRun(missingThread.id, missingRunId, 'agent', missingArchived)
    const missingValues = {
      messages: [new HumanMessage({
        id: missingMessageId,
        content: 'Missing attachment',
        additional_kwargs: { anas_run_id: missingRunId }
      })],
      todos: []
    }
    await markRunCompleted(database, missingThread.id, missingRunId, missingValues)
    database.finishRun(missingRunId, 'completed')
    await rm(missingArchived[0].artifact.path)

    await expect(runtime.prepareMessageEdit({
      threadId: missingThread.id,
      messageId: missingMessageId
    })).rejects.toThrow('missing-after-archive.txt')
    expect(database.getRun(missingRunId)).toMatchObject({ status: 'completed' })
    expect(missingValues.messages[0].id).toBe(missingMessageId)
    database.close()
  })
})
