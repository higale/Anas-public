import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HumanMessage } from '@langchain/core/messages'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentDatabase } from './agentDatabase'
import { AgentRuntime } from './agentRuntime'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => (
    rm(path, { recursive: true, force: true })
  )))
})

describe('durable queued inputs', () => {
  it('survives database reopen with an owned attachment and supports failure retry and removal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-queued-input-'))
    temporaryDirectories.push(root)
    const databaseFile = join(root, 'agent.sqlite')
    const attachmentRoot = join(root, 'attachments')
    const source = join(root, 'notes.txt')
    await writeFile(source, 'durable queued content', 'utf8')

    let database = AgentDatabase.open(databaseFile, attachmentRoot)
    const thread = database.createThread({ title: 'Queued input' })
    let runtime = new AgentRuntime(database, async () => {
      throw new Error('Agent instance creation is not used by this test.')
    })
    const id = randomUUID()
    const created = await runtime.enqueueQueuedInput({
      id,
      threadId: thread.id,
      text: 'Expanded skill prompt',
      displayText: '/review current changes',
      attachments: [{
        path: source,
        name: 'notes.txt',
        mimeType: 'text/plain',
        size: 22,
        kind: 'text',
        contextPolicy: 'conversation'
      }]
    })
    const storedPath = created.attachments[0].path
    await rm(source)
    database.close()

    database = AgentDatabase.open(databaseFile, attachmentRoot)
    runtime = new AgentRuntime(database, async () => {
      throw new Error('Agent instance creation is not used by this test.')
    })
    expect(runtime.listQueuedInputs()).toEqual([
      expect.objectContaining({
        id,
        threadId: thread.id,
        text: 'Expanded skill prompt',
        displayText: '/review current changes',
        status: 'queued',
        attachments: [expect.objectContaining({
          path: storedPath,
          name: 'notes.txt',
          contextPolicy: 'conversation'
        })]
      })
    ])
    await expect(readFile(storedPath, 'utf8')).resolves.toBe('durable queued content')

    expect(runtime.markQueuedInputFailed(thread.id, id, 'Provider unavailable')).toMatchObject({
      status: 'failed',
      error: 'Provider unavailable'
    })
    const retried = runtime.retryQueuedInput(thread.id, id)
    expect(retried).toMatchObject({ status: 'queued' })
    expect(retried).not.toHaveProperty('error')
    await expect(runtime.removeQueuedInput(thread.id, id)).resolves.toBe(true)
    expect(runtime.listQueuedInputs()).toEqual([])
    await expect(stat(storedPath)).rejects.toThrow()
    database.close()
  })

  it('consumes an applied direction only after it appears in committed graph state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-queued-direction-'))
    temporaryDirectories.push(root)
    const database = AgentDatabase.open(join(root, 'agent.sqlite'), join(root, 'attachments'))
    const thread = database.createThread({ title: 'Committed direction' })
    const runtime = new AgentRuntime(database, async () => {
      throw new Error('Agent instance creation is not used by this test.')
    })
    const id = randomUUID()
    await runtime.enqueueQueuedInput({
      id,
      threadId: thread.id,
      text: 'Use the committed direction'
    })
    const consume = (runtime as unknown as {
      consumeCommittedQueuedDirections(
        runId: string,
        active: { threadId: string; appliedDirectionIds: Set<string> },
        values: unknown
      ): Promise<void>
    }).consumeCommittedQueuedDirections.bind(runtime)
    const active = { threadId: thread.id, appliedDirectionIds: new Set([id]) }

    await consume('run-1', active, { messages: [] })
    expect(runtime.listQueuedInputs()).toHaveLength(1)

    await consume('run-1', active, {
      messages: [new HumanMessage({
        id: `run-1:direction:${id}`,
        content: 'Use the committed direction'
      })]
    })
    expect(runtime.listQueuedInputs()).toEqual([])
    database.close()
  })
})
