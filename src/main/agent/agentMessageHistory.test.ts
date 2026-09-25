import { defaultCapabilities, } from '@shared/agentCapabilities'
import { AIMessage, HumanMessage } from '@langchain/core/messages'
import { uuid6 } from '@langchain/langgraph-checkpoint'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentDatabase } from './agentDatabase'
import { AgentRuntime } from './agentRuntime'

const temporaryDirectories: string[] = []
let checkpointSequence = 0

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'anas-history-revision-'))
  temporaryDirectories.push(directory)
  return directory
}

async function putCurrentState(
  database: AgentDatabase,
  threadId: string,
  values: Record<string, unknown>,
  writes: Array<[string, unknown]> = []
): Promise<string> {
  checkpointSequence += 1
  const parent = await database.checkpointer.getTuple({
    configurable: { thread_id: threadId, checkpoint_ns: '' }
  })
  const checkpointId = uuid6(checkpointSequence)
  await database.checkpointer.put({
    configurable: {
      thread_id: threadId,
      checkpoint_ns: '',
      ...(parent ? { checkpoint_id: parent.checkpoint.id } : {})
    }
  }, {
    v: 4,
    id: checkpointId,
    ts: new Date().toISOString(),
    channel_values: values,
    channel_versions: {},
    versions_seen: {}
  }, {
    source: 'update',
    step: checkpointSequence,
    parents: {}
  })
  if (writes.length > 0) {
    await database.checkpointer.putWrites({
      configurable: {
        thread_id: threadId,
        checkpoint_ns: '',
        checkpoint_id: checkpointId
      }
    }, writes, `history-task-${checkpointSequence}`)
  }
  return checkpointId
}

async function completeRun(
  database: AgentDatabase,
  threadId: string,
  runId: string,
  messages: Array<HumanMessage | AIMessage>,
  writes: Array<[string, unknown]> = []
): Promise<void> {
  database.createRun(threadId, runId)
  await putCurrentState(database, threadId, {
    messages,
    todos: [],
    anasRunLifecycle: { runId, status: 'completed' }
  }, writes)
  database.finishRun(runId, 'completed')
}

function historyMessages() {
  return [
    new HumanMessage({
      id: 'revision-user-1',
      content: 'One',
      additional_kwargs: { anas_run_id: 'revision-run-1' }
    }),
    new AIMessage({
      id: 'revision-assistant-1',
      content: 'First answer',
      additional_kwargs: { anas_run_id: 'revision-run-1' }
    }),
    new HumanMessage({
      id: 'revision-user-2',
      content: 'Two',
      additional_kwargs: { anas_run_id: 'revision-run-2' }
    }),
    new AIMessage({
      id: 'revision-assistant-2',
      content: 'Second answer',
      additional_kwargs: { anas_run_id: 'revision-run-2' }
    }),
    new HumanMessage({
      id: 'revision-user-3',
      content: 'Three',
      additional_kwargs: { anas_run_id: 'revision-run-3' }
    }),
    new AIMessage({
      id: 'revision-assistant-3',
      content: 'Third answer',
      additional_kwargs: { anas_run_id: 'revision-run-3' }
    })
  ]
}

async function seedTwoRuns(database: AgentDatabase) {
  const thread = database.createThread({ title: 'Revision fault injection' })
  const messages = historyMessages()
  await completeRun(
    database,
    thread.id,
    'revision-run-1',
    messages.slice(0, 2),
    [['durable-result', { ok: true }]]
  )
  await completeRun(database, thread.id, 'revision-run-2', messages.slice(0, 4))
  return { thread, messages }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

describe('current conversation message history', () => {
  it('rolls back the current messages with run metadata when truncation cannot commit', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const { thread, messages } = await seedTwoRuns(database)
      const raw = (database as unknown as { database: { exec(sql: string): void } }).database
      raw.exec(`
        CREATE TRIGGER fail_history_truncation
        BEFORE DELETE ON agent_runs
        BEGIN
          SELECT RAISE(ABORT, 'injected history truncation failure');
        END;
      `)
      const runtime = new AgentRuntime(database, undefined, undefined, async () => {})
      await expect(runtime.truncateMessages({ threadId: thread.id, messageId: 'revision-user-2' }))
        .rejects.toThrow('injected history truncation failure')
      raw.exec('DROP TRIGGER fail_history_truncation')
      expect((await runtime.getSnapshot(thread.id)).messages.map((message) => message.id))
        .toEqual(messages.slice(0, 4).map((message) => message.id))
      expect(database.getRun('revision-run-2')).toMatchObject({ status: 'completed' })
      await runtime.truncateMessages({ threadId: thread.id, messageId: 'revision-user-2' })
      expect(database.getRun('revision-run-2')).toBeNull()
      await runtime.shutdown()
    } finally {
      database.close()
    }
  })

  it('reopens the edited current message prefix without an older checkpoint', async () => {
    const directory = await temporaryDirectory()
    const databasePath = join(directory, 'conversation.sqlite')
    let database = AgentDatabase.open(databasePath)
    const { thread } = await seedTwoRuns(database)
    const runtime = new AgentRuntime(database, undefined, undefined, async () => {})
    await runtime.truncateMessages({ threadId: thread.id, messageId: 'revision-user-2' })
    await runtime.shutdown()
    database.close()
    database = AgentDatabase.open(databasePath)
    try {
      const reopened = new AgentRuntime(database, undefined, undefined, async () => {})
      expect((await reopened.getSnapshot(thread.id)).messages.map((message) => message.id))
        .toEqual(['revision-user-1', 'revision-assistant-1'])
      const states = []
      for await (const state of database.checkpointer.list({ configurable: { thread_id: thread.id } })) states.push(state)
      expect(states).toHaveLength(1)
      await reopened.shutdown()
    } finally {
      database.close()
    }
  })

  it('truncates current messages repeatedly without requiring discarded execution states', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread({ title: 'Repeated revision rewrite' })
      const messages = historyMessages()
      await completeRun(database, thread.id, 'revision-run-1', messages.slice(0, 2))
      await completeRun(database, thread.id, 'revision-run-2', messages.slice(0, 4))
      await completeRun(database, thread.id, 'revision-run-3', messages)
      const runtime = new AgentRuntime(database, undefined, undefined, async () => {})

      const first = await runtime.truncateMessages({
        threadId: thread.id,
        messageId: 'revision-user-3'
      })
      expect(first.messages.map((message) => message.id)).toEqual([
        'revision-user-1',
        'revision-assistant-1',
        'revision-user-2',
        'revision-assistant-2'
      ])

      const second = await runtime.truncateMessages({
        threadId: thread.id,
        messageId: 'revision-user-2'
      })
      expect(second.messages.map((message) => message.id)).toEqual([
        'revision-user-1',
        'revision-assistant-1'
      ])
      expect(database.getRun('revision-run-1')).toMatchObject({ status: 'completed' })
      expect(database.getRun('revision-run-2')).toBeNull()
      expect(database.getRun('revision-run-3')).toBeNull()
      await runtime.shutdown()
    } finally {
      database.close()
    }
  })

  it('atomically removes hidden subagent state owned by discarded history', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread({ title: 'Subagent history cleanup' })
      const messages = historyMessages()
      await completeRun(database, thread.id, 'revision-run-1', messages.slice(0, 2))
      const parentRun = database.createRun(thread.id, 'revision-run-2')
      const call = database.createSubagentCall({
        id: '11000000-0000-8000-8000-000000000001',
        ownerThreadId: thread.id,
        parentThreadId: thread.id,
        parentRunId: parentRun.id,
        childThreadId: '12000000-0000-8000-8000-000000000001',
        childRunId: '13000000-0000-8000-8000-000000000001',
        config: {
 capabilities: { ...structuredClone(defaultCapabilities), profile: false, workspace: true, memory: true, toolMode: 'all', tools: [], skills: { enabled: true, mode: 'default', project: false, entries: [] } },
          index: 0,
          name: 'reviewer',
          enabled: true,
          builtIn: false,
          description: 'Review code.',
          systemPrompt: 'Review the delegated code.',
        },
        description: 'Review the second turn.',
        childThread: {
          title: 'Hidden reviewer',
          projectId: thread.projectId
        }
      })
      await putCurrentState(database, call.childThreadId, {
        anasRunLifecycle: { runId: call.childRunId, status: 'running' }
      })
      expect(database.cancelRecoverableRun(call.childRunId)).toBe(true)
      database.finishSubagentCall({
        subagentId: call.id,
        ownerThreadId: thread.id,
        status: 'completed',
        result: 'Reviewed.'
      })
      await putCurrentState(database, thread.id, {
        messages: messages.slice(0, 4),
        todos: [],
        anasRunLifecycle: { runId: parentRun.id, status: 'completed' }
      })
      database.finishRun(parentRun.id, 'completed')
      const runtime = new AgentRuntime(database, undefined, undefined, async () => {})

      await runtime.truncateMessages({
        threadId: thread.id,
        messageId: 'revision-user-2'
      })

      expect(database.getThread(call.childThreadId)).toBeNull()
      expect(database.getSubagentCall(call.id, thread.id)).toBeUndefined()
      await expect(database.checkpointer.getTuple({
        configurable: { thread_id: call.childThreadId, checkpoint_ns: '' }
      })).resolves.toBeUndefined()
      await vi.waitFor(() => {
        expect(database.listAttachmentCleanupThreadIds()).not.toContain(call.childThreadId)
      })
      await runtime.shutdown()
    } finally {
      database.close()
    }
  })
})
