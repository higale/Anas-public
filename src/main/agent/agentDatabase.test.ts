import { defaultCapabilities, } from '@shared/agentCapabilities'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import { describe, expect, it, vi } from 'vitest'
import type { SubagentConfig } from '@shared/types'
import {
  AgentDatabase,
  type StagedContextSummaryDetails
} from './agentDatabase'
import { requiresToolApproval } from './toolAuthorization'

function subagentConfig(name: string): SubagentConfig {
  return {
 capabilities: { ...structuredClone(defaultCapabilities), profile: false, workspace: true, memory: true, toolMode: 'all', tools: [], skills: { enabled: true, mode: 'default', project: false, entries: [] } },
    index: 0,
    name,
    enabled: true,
    builtIn: false,
    description: `Configured ${name} subagent.`,
    systemPrompt: `Act as the ${name} subagent.`,
  }
}

async function putRootCheckpoint(
  database: AgentDatabase,
  threadId: string,
  checkpointId: string,
  values: Record<string, unknown> = {}
): Promise<void> {
  await database.checkpointer.put({
    configurable: { thread_id: threadId, checkpoint_ns: '' }
  }, {
    v: 4,
    id: checkpointId,
    ts: new Date().toISOString(),
    channel_values: values,
    channel_versions: {},
    versions_seen: {}
  }, {
    source: 'update',
    step: 0,
    parents: {}
  })
}

async function markRunCompleted(
  database: AgentDatabase,
  threadId: string,
  runId: string
): Promise<void> {
  await putRootCheckpoint(database, threadId, `${runId}-terminal`, {
    anasRunLifecycle: { runId, status: 'completed' }
  })
}

async function markRunInterrupted(
  database: AgentDatabase,
  threadId: string,
  runId: string,
  interruptId = `${runId}-interrupt`
): Promise<void> {
  const checkpointId = `${runId}-interrupted`
  await putRootCheckpoint(database, threadId, checkpointId, {
    anasRunLifecycle: { runId, status: 'running' }
  })
  await database.checkpointer.putWrites({
    configurable: {
      thread_id: threadId,
      checkpoint_ns: '',
      checkpoint_id: checkpointId
    }
  }, [['__interrupt__', [{ id: interruptId, value: {} }]]], `${runId}-task`)
}

function replaceManagedCallTableWithPrototype(databasePath: string): void {
  const raw = new Database(databasePath)
  try {
    raw.pragma('foreign_keys = OFF')
    raw.exec(`
      DROP TABLE agent_managed_call_observations;
      DROP TABLE agent_managed_call_output;
      DROP TABLE agent_managed_calls;

      CREATE TABLE agent_managed_calls (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('shell', 'http')),
        summary TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('preparing', 'running', 'completed', 'failed', 'cancelled', 'uncertain')),
        result_text TEXT,
        error TEXT,
        output_truncated INTEGER NOT NULL DEFAULT 0 CHECK (output_truncated IN (0, 1)),
        output_chars INTEGER NOT NULL DEFAULT 0 CHECK (output_chars >= 0),
        next_output_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_output_sequence >= 1),
        dispatched_at TEXT,
        detached_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
  } finally {
    raw.close()
  }
}

function replaceSubagentTablesWithoutForeignKeys(databasePath: string): void {
  const raw = new Database(databasePath)
  try {
    raw.pragma('foreign_keys = OFF')
    raw.exec(`
      DROP TABLE agent_subagent_observations;
      DROP TABLE agent_subagent_calls;

      CREATE TABLE agent_subagent_calls (
        id TEXT PRIMARY KEY,
        owner_thread_id TEXT NOT NULL,
        parent_thread_id TEXT NOT NULL,
        parent_run_id TEXT NOT NULL,
        parent_subagent_id TEXT,
        child_thread_id TEXT NOT NULL UNIQUE,
        child_run_id TEXT NOT NULL UNIQUE,
        agent_name TEXT NOT NULL CHECK (length(agent_name) > 0),
        config_json TEXT NOT NULL,
        description TEXT NOT NULL CHECK (length(description) > 0),
        status TEXT NOT NULL
          CHECK (status IN ('running', 'interrupted', 'completed', 'failed', 'cancelled')),
        result_text TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE agent_subagent_observations (
        subagent_id TEXT NOT NULL,
        observing_run_id TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        PRIMARY KEY (subagent_id, observing_run_id)
      );
    `)
  } finally {
    raw.close()
  }
}

function replaceSubagentObservationTableWithoutCascade(databasePath: string): void {
  const raw = new Database(databasePath)
  try {
    raw.pragma('foreign_keys = OFF')
    raw.exec(`
      DROP TABLE agent_subagent_observations;
      CREATE TABLE agent_subagent_observations (
        subagent_id TEXT NOT NULL REFERENCES agent_subagent_calls(id),
        observing_run_id TEXT NOT NULL REFERENCES agent_runs(id),
        observed_at TEXT NOT NULL,
        PRIMARY KEY (subagent_id, observing_run_id)
      );
    `)
  } finally {
    raw.close()
  }
}

function replaceHiddenThreadTableWithoutCascade(databasePath: string): void {
  const raw = new Database(databasePath)
  try {
    raw.pragma('foreign_keys = OFF')
    raw.exec(`
      DROP TABLE agent_hidden_threads;
      CREATE TABLE agent_hidden_threads (
        thread_id TEXT PRIMARY KEY REFERENCES agent_threads(id),
        kind TEXT NOT NULL CHECK (kind = 'subagent')
      );
    `)
  } finally {
    raw.close()
  }
}

function createStoredAttachment(
  attachmentRoot: string,
  threadId: string,
  runId: string,
  attachmentId: string,
  storageDirectoryId = attachmentId
) {
  const contents = 'live attachment'
  const storagePath = `${threadId}/${storageDirectoryId}/content.txt`
  const path = join(attachmentRoot, threadId, storageDirectoryId, 'content.txt')
  mkdirSync(join(attachmentRoot, threadId, storageDirectoryId), { recursive: true })
  writeFileSync(path, contents)
  return {
    artifact: {
      id: attachmentId,
      threadId,
      messageId: `${runId}:input`,
      runId,
      name: 'live.txt',
      mimeType: 'text/plain',
      size: Buffer.byteLength(contents),
      kind: 'text' as const,
      path,
      available: true,
      textTruncated: false,
      contextPolicy: 'one_turn' as const,
      createdAt: new Date().toISOString()
    },
    storagePath
  }
}

async function stageAndCommitSummary(
  database: AgentDatabase,
  threadId: string,
  runId: string,
  summaryId: string,
  details: StagedContextSummaryDetails
): Promise<void> {
  database.stageContextSummary(runId, summaryId, details)
  const checkpointId = `${summaryId}-checkpoint`
  await putRootCheckpoint(database, threadId, checkpointId)
  database.commitContextSummary(runId, summaryId, checkpointId)
}

describe('AgentDatabase', () => {
  it('stores thread metadata without duplicating conversation messages', () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const created = database.createThread({ title: '  Framework native   runtime ', projectId: 'project-1' })
      expect(created.title).toBe('Framework native runtime')
      expect(created.status).toBe('idle')
      expect(created.accessMode).toBe('read_only_allowed')
      expect(database.listThreads()).toEqual([created])

      const updated = database.updateThread(created.id, {
        pinned: true,
        title: 'Agent V2',
        modelConfigId: 'model-config-2',
        modelParameterPresetId: 'thinking-on'
      })
      expect(updated.pinned).toBe(true)
      expect(updated.title).toBe('Agent V2')
      expect(updated.modelConfigId).toBe('model-config-2')
      expect(database.getThread(created.id)).toMatchObject({
        modelConfigId: 'model-config-2',
        modelParameterPresetId: 'thinking-on'
      })
      expect(database.updateThread(created.id, { modelParameterPresetId: null }).modelParameterPresetId)
        .toBeUndefined()
    } finally {
      database.close()
    }
  })

  it('creates a new thread and its submitted run atomically with a durable idempotency key', () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const first = database.createThreadAndRun(
        'atomic-thread-1',
        { title: 'Atomic thread', modelConfigId: 'model-config-1' },
        'atomic-run-1',
        [],
        { kind: 'user', text: 'Send once' },
        'submission-1'
      )
      expect(first.thread).toMatchObject({
        id: 'atomic-thread-1',
        modelConfigId: 'model-config-1',
        status: 'running',
        userTurnCount: 1
      })
      expect(database.getRunBySubmissionId('submission-1')).toEqual(first.run)

      expect(() => database.createThreadAndRun(
        'atomic-thread-rollback',
        { title: 'Must roll back' },
        'atomic-run-2',
        [],
        { kind: 'user', text: 'Duplicate key' },
        'submission-1'
      )).toThrow(/UNIQUE/)
      expect(database.getThread('atomic-thread-rollback')).toBeNull()
      expect(database.listThreads()).toHaveLength(1)
    } finally {
      database.close()
    }
  })

  it('enforces one active run per thread and records terminal status', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'run-1')
      expect(database.getThread(thread.id)?.status).toBe('running')
      expect(() => database.createRun(thread.id, 'run-2')).toThrow('is busy')

      await markRunCompleted(database, thread.id, run.id)
      const completed = database.finishRun(run.id, 'completed')
      expect(completed.status).toBe('completed')
      expect(database.getThread(thread.id)?.status).toBe('idle')
    } finally {
      database.close()
    }
  })

  it('persists every selected access mode at creation and when changed', () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread({ accessMode: 'strict_approval' })
      expect(thread.accessMode).toBe('strict_approval')
      expect(database.getThread(thread.id)?.accessMode).toBe('strict_approval')
      expect(database.setAccessMode(thread.id, 'full_access').accessMode).toBe('full_access')
      expect(database.setAccessMode(thread.id, 'read_only_allowed').accessMode)
        .toBe('read_only_allowed')
    } finally {
      database.close()
    }
  })

  it('supports interrupt and resume as first-class run states', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id)
      await markRunInterrupted(database, thread.id, run.id, 'approval-1')
      database.finishRun(run.id, 'interrupted')
      expect(database.getThread(thread.id)?.status).toBe('interrupted')
      expect(database.getLatestRunForThread(thread.id)).toMatchObject({
        id: run.id,
        status: 'interrupted'
      })
      expect(() => database.createRun(thread.id, 'run-after-interrupt')).toThrow('is busy')
      expect(() => database.finishRun(run.id, 'cancelled')).toThrow('already interrupted')

      const resumed = database.resumeRun(run.id, [{
        interruptId: 'approval-1',
        response: { decisions: [{ type: 'approve' }] }
      }])
      expect(resumed.status).toBe('running')
      expect(database.getThread(thread.id)?.accessMode).toBe('read_only_allowed')
      expect(database.getRun(run.id)?.status).toBe('running')
      const projectFolder = process.platform === 'win32' ? 'C:\\project' : '/project'
      const projectFile = process.platform === 'win32'
        ? 'C:\\project\\notes.txt'
        : '/project/notes.txt'
      await expect(requiresToolApproval({
        toolName: 'pwsh',
        args: { command: 'pwd' },
        primaryFolder: projectFolder,
        trustedFolders: [projectFolder],
        accessMode: 'read_only_allowed',
        commandShellToolName: 'pwsh'
      })).resolves.toBe(true)
      await expect(requiresToolApproval({
        toolName: 'read_file',
        args: { path: projectFile },
        primaryFolder: projectFolder,
        trustedFolders: [projectFolder],
        accessMode: 'read_only_allowed'
      })).resolves.toBe(false)
      database.finishRun(run.id, 'cancelled')
      expect(database.getThread(thread.id)?.status).toBe('idle')
    } finally {
      database.close()
    }
  })

  it('keeps a fresh input retryable ahead of errors retained on the previous run head', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const failed = database.createRun(thread.id, 'previous-failed-run')
      const failedHead = 'previous-failed-head'
      await putRootCheckpoint(database, thread.id, failedHead, {
        anasRunLifecycle: { runId: failed.id, status: 'running' }
      })
      await database.checkpointer.putWrites({
        configurable: {
          thread_id: thread.id,
          checkpoint_ns: '',
          checkpoint_id: failedHead
        }
      }, [['__error__', { message: 'previous failure' }]], 'previous-failed-task')
      database.finishRun(failed.id, 'failed', 'previous failure')

      const fresh = database.createRun(
        thread.id,
        'fresh-input-run',
        'agent',
        [],
        { kind: 'user', text: 'Retry with a fresh turn' }
      )
      await database.checkpointer.putWrites({
        configurable: {
          thread_id: thread.id,
          checkpoint_ns: '',
          checkpoint_id: failedHead
        }
      }, [['__start__', { messages: ['fresh input'] }]], '00000000-0000-0000-0000-000000000000')

      expect(database.classifyRunningRun(fresh.id)).toBe('recoverable')
      expect(database.getRunInputIntent(fresh.id)).toEqual({
        kind: 'user',
        text: 'Retry with a fresh turn'
      })

      await putRootCheckpoint(database, thread.id, 'fresh-input-checkpoint', {
        anasRunLifecycle: { runId: fresh.id, status: 'running' }
      })
      expect(database.getRunInputIntent(fresh.id)).toBeUndefined()
    } finally {
      database.close()
    }
  })

  it('does not invent completion for unfinished activities when a run is cancelled', () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'cancelled-activities-run')
      database.recordModelActivity(run.id, {
        id: 'model-1',
        status: 'running',
        text: '',
        reasoning: '',
        toolCallIds: []
      })
      database.recordToolActivity(run.id, {
        id: 'tool-1',
        name: 'execute',
        args: { command: 'npm test' }
      }, 'running')
      database.recordSubagentActivity(run.id, 'subagent-1', 'general-purpose', 'running')
      database.recordContextSummaryStarted(run.id, 'cancelled-summary')
      database.stageContextSummary(run.id, 'cancelled-summary', {
        summaryText: 'Must survive until exact terminal projection reconciliation.'
      })

      database.finishRun(run.id, 'cancelled')

      expect(database.getActivitiesForThread(thread.id)).toEqual([
        expect.objectContaining({
          runId: run.id,
          status: 'cancelled',
          models: [],
          tools: [],
          subagents: []
        })
      ])
      expect(database.getRunActivity(run.id)?.summaries?.some(summary => summary.status === 'running') ?? false).toBe(false)
      expect(database.getActivitiesForThread(thread.id)[0]).toMatchObject({
        models: [],
        tools: [],
        subagents: []
      })
    } finally {
      database.close()
    }
  })

  it('cancels a paused run without preserving partial activity or transient bodies', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'cancel-paused-body')
      await markRunInterrupted(database, thread.id, run.id)
      database.finishRun(run.id, 'interrupted')
      database.recordModelActivity(run.id, { id: 'partial-model', status: 'completed', text: 'Partial prefix', reasoning: '', toolCallIds: [] })
      database.recordToolActivity(run.id, { id: 'partial-tool', name: 'execute', args: { command: 'partial' } }, 'completed', undefined, 'Partial result')
      database.recordContextSummaryStarted(run.id, 'partial-summary')
      expect(database.cancelRecoverableRun(run.id)).toBe(true)
      expect(database.getRunActivity(run.id)).toMatchObject({ status: 'cancelled', models: [], tools: [], subagents: [] })
      expect(database.getRunActivity(run.id)?.summaries ?? []).toEqual([])
      const buffers = database as unknown as { transientModels: Map<string, unknown>; transientTools: Map<string, unknown> }
      expect(buffers.transientModels.size + buffers.transientTools.size).toBe(0)
    } finally { database.close() }
  })

  it('reads only selected activity bodies and the latest model when polling run progress', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'precise-activity-read')
      const oldCall = { id: 'old-tool', name: 'read_file', args: { path: 'old.txt' } }
      const activeCall = { id: 'active-tool', name: 'read_file', args: { path: 'active.txt' } }
      await putRootCheckpoint(database, thread.id, 'precise-activity-state', {
        messages: [
          new AIMessage({ id: 'old-model', content: 'x'.repeat(1024 * 1024), tool_calls: [oldCall], additional_kwargs: { anas_run_id: run.id } }),
          new ToolMessage({ id: 'old-result', content: 'x'.repeat(1024 * 1024), tool_call_id: oldCall.id, additional_kwargs: { anas_run_id: run.id } }),
          new AIMessage({ id: 'latest-model', content: 'Current progress', tool_calls: [activeCall], additional_kwargs: { anas_run_id: run.id } })
        ], anasRunLifecycle: { runId: run.id, status: 'running' }
      })
      const read = vi.spyOn(database.checkpointer, 'getMessageRecordById')
      const progress = database.getRunProcessActivity(run.id)
      expect(progress).toMatchObject({ modelRounds: 2, toolCalls: 2, latestModel: { text: 'Current progress' }, activeTools: [{ call: activeCall }] })
      expect(read.mock.results.every((result) => result.type === 'return' && result.value?.messageId === 'latest-model')).toBe(true)
      expect(database.getMessageActivitySequence(run.id, 'latest-model')).toBe(progress.latestModel?.sequence)
    } finally { database.close() }
  })

  it('persists the exact memory recall prompt as run activity', () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'memory-recall-run')
      const first = database.recordMemoryRecall(run.id, {
        id: 'recall-1',
        query: 'How should this project build?',
        promptText: '<relevant_memories>\nnpm run build\n</relevant_memories>',
        memoryCount: 1,
        agentName: 'general-purpose'
      })
      const duplicate = database.recordMemoryRecall(run.id, {
        id: 'recall-1',
        query: 'How should this project build?',
        promptText: '<relevant_memories>\nnpm run build\n</relevant_memories>',
        memoryCount: 1,
        agentName: 'general-purpose'
      })

      expect(duplicate).toEqual(first)
      expect(database.getActivitiesForThread(thread.id)).toEqual([
        expect.objectContaining({
          memoryRecalls: [{
            ...first,
            query: 'How should this project build?',
            promptText: '<relevant_memories>\nnpm run build\n</relevant_memories>',
            memoryCount: 1,
            agentName: 'general-purpose'
          }]
        })
      ])
    } finally {
      database.close()
    }
  })

  it('does not invent completion for unfinished activities when a run fails', () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'failed-activities-run')
      database.recordModelActivity(run.id, {
        id: 'failed-model',
        status: 'running',
        text: 'Partial response',
        reasoning: '',
        toolCallIds: []
      })
      database.recordToolActivity(run.id, {
        id: 'failed-tool',
        name: 'execute',
        args: { command: 'npm test' }
      }, 'running')

      database.finishRun(run.id, 'failed', 'Provider failed.')

      expect(database.getActivitiesForThread(thread.id)[0]).toMatchObject({
        status: 'failed',
        models: [],
        tools: []
      })
    } finally {
      database.close()
    }
  })

  it('commits native message references and a completed summary in the same current-state transaction', async () => {
    const database=AgentDatabase.open(':memory:')
    try {
      const thread=database.createThread()
      const run=database.createRun(thread.id,'canonical-run')
      const call={id:'canonical-call',name:'lookup',args:{query:'current'}}
      database.recordModelActivity(run.id,{id:'model',messageId:'answer',status:'completed',text:'uncommitted preview',reasoning:'',toolCallIds:[call.id]})
      database.recordToolActivity(run.id,call,'completed',undefined,'uncommitted preview')
      database.recordContextSummaryStarted(run.id,'summary')
      database.stageContextSummary(run.id,'summary',{summaryText:'Summary',modelContent:'Summary',cutoffIndex:1,activatedAfterMessageIndex:0})
      await putRootCheckpoint(database,thread.id,'current',{
        messages:[new AIMessage({id:'answer',content:'Durable answer',tool_calls:[call],additional_kwargs:{anas_run_id:run.id}}),
          new ToolMessage({id:'result',tool_call_id:call.id,content:'durable output',additional_kwargs:{anas_run_id:run.id}})],
        _summarizationEvent:{cutoffIndex:1,summaryMessage:new HumanMessage({content:'Summary',additional_kwargs:{anas_summary_id:'summary'}})},
        anasRunLifecycle:{runId:run.id,status:'completed'}
      })
      database.finishRun(run.id,'completed')
      expect(database.getCommittedContextSummary(run.id,'summary')).toMatchObject({committedCheckpointId:'current'})
      expect(database.getRunActivity(run.id)).toMatchObject({
        models:[expect.objectContaining({text:'Durable answer'})],
        tools:[expect.objectContaining({call,output:'durable output'})]
      })
      const raw=(database as unknown as {database:Database.Database}).database
      expect(raw.prepare('SELECT COUNT(*) AS count FROM message_bodies').get()).toEqual({count:3})
      expect(raw.prepare("SELECT output_json FROM agent_activities WHERE kind='tool'").get()).toEqual({output_json:null})
    } finally {database.close()}
  })

  it('keeps unfinished activities running while a run is interrupted', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'interrupted-activities-run')
      database.recordModelActivity(run.id, {
        id: 'model-1',
        status: 'running',
        text: '',
        reasoning: '',
        toolCallIds: []
      })

      await markRunInterrupted(database, thread.id, run.id)
      database.finishRun(run.id, 'interrupted')

      expect(database.getActivitiesForThread(thread.id)[0]?.models).toEqual([
        expect.objectContaining({
          id: 'model-1',
          status: 'running',
          completedAt: undefined
        })
      ])
    } finally {
      database.close()
    }
  })

  it('discards an unclaimed model activity without leaving timing metadata', () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'discarded-model-run')
      database.recordModelActivity(run.id, {
        id: 'unclaimed-model',
        status: 'running',
        text: '',
        reasoning: '',
        toolCallIds: []
      })

      expect(database.discardModelActivity(run.id, 'unclaimed-model')).toBe(true)
      expect(database.discardModelActivity(run.id, 'unclaimed-model')).toBe(false)
      expect(database.getActivitiesForThread(thread.id)[0]?.models).toEqual([])
    } finally {
      database.close()
    }
  })

  it('reconciles only root activities proven by a durable checkpoint', () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'checkpoint-activity-run')
      database.recordModelActivity(run.id, {
        id: 'ahead-model',
        messageId: 'ahead-message',
        status: 'completed',
        text: 'Not durable',
        reasoning: '',
        toolCallIds: ['ahead-tool']
      })
      database.recordToolActivity(run.id, {
        id: 'ahead-tool',
        name: 'execute',
        args: { command: 'ahead' }
      }, 'completed', undefined, 'not durable')
      database.recordToolApproval(run.id, 'ahead-tool', {
        status: 'pending_approval',
        interruptId: 'ahead-approval',
        actionIndex: 0
      })
      database.recordSubagentActivity(run.id, 'ahead-subagent', 'general-purpose', 'completed')
      database.recordModelActivity(run.id, {
        id: 'ahead-nested-model',
        status: 'completed',
        subagentId: 'ahead-subagent',
        text: 'Nested DB-ahead response',
        reasoning: '',
        toolCallIds: ['ahead-nested-tool']
      })
      database.recordToolActivity(run.id, {
        id: 'ahead-nested-tool',
        name: 'read_file',
        args: { path: 'ahead.txt' }
      }, 'completed', 'ahead-subagent', 'nested DB-ahead output')
      database.recordSubagentActivity(
        run.id,
        'ahead-nested-child',
        'general-purpose',
        'completed',
        'ahead-subagent',
        'nested DB-ahead child result'
      )

      database.recordModelActivity(run.id, {
        id: 'durable-model',
        messageId: 'durable-message',
        status: 'running',
        text: 'partial',
        reasoning: '',
        toolCallIds: []
      })
      database.recordToolActivity(run.id, {
        id: 'durable-tool',
        name: 'start_subagent',
        args: { description: 'Inspect durable state', agent: 'general-purpose' }
      }, 'completed', undefined, JSON.stringify({ subagent_id: 'durable-subagent' }))
      database.recordSubagentActivity(run.id, 'durable-subagent', 'general-purpose', 'running')

      database.recordModelActivity(run.id, {
        id: 'proven-nested-model',
        status: 'running',
        subagentId: 'durable-subagent',
        text: 'Durably rooted nested state',
        reasoning: '',
        toolCallIds: ['proven-nested-tool']
      })
      database.recordToolActivity(run.id, {
        id: 'proven-nested-tool',
        name: 'read_file',
        args: { path: 'proven.txt' }
      }, 'completed', 'durable-subagent', 'proven nested output')
      database.recordSubagentActivity(
        run.id,
        'proven-nested-child',
        'general-purpose',
        'running',
        'durable-subagent'
      )

      database.recordModelActivity(run.id, {
        id: 'nested-model',
        status: 'running',
        subagentId: 'parent-task',
        text: 'Nested state is not root-provable',
        reasoning: '',
        toolCallIds: ['nested-tool']
      })
      database.recordToolActivity(run.id, {
        id: 'nested-tool',
        name: 'read_file',
        args: { path: 'nested.txt' }
      }, 'completed', 'parent-task', 'nested output')
      database.recordSubagentActivity(
        run.id,
        'nested-child',
        'general-purpose',
        'running',
        'parent-task'
      )

      database.reconcileRootActivities(run.id, {
        models: [{
          messageId: 'durable-message',
          text: 'Durable model response',
          reasoning: 'Durable reasoning',
          toolCalls: [{
            id: 'durable-tool',
            name: 'start_subagent',
            args: { description: 'Inspect durable state', agent: 'general-purpose' }
          }]
        }],
        tools: [{
          call: {
            id: 'durable-tool',
            name: 'start_subagent',
            args: { description: 'Inspect durable state', agent: 'general-purpose' }
          },
          output: JSON.stringify({ subagent_id: 'durable-subagent' }),
          subagentName: 'general-purpose',
          subagentId: 'durable-subagent'
        }]
      })

      const activity = database.getActivitiesForThread(thread.id)[0]
      expect(activity.models).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'durable-model',
          messageId: 'durable-message',
          status: 'completed',
          text: 'Durable model response',
          reasoning: 'Durable reasoning',
          toolCallIds: ['durable-tool']
        }),
        expect.objectContaining({ id: 'proven-nested-model', status: 'running' })
      ]))
      expect(activity.models.some((model) => model.id === 'ahead-model')).toBe(false)
      expect(activity.models.some((model) => model.id === 'ahead-nested-model')).toBe(false)
      expect(activity.models.some((model) => model.id === 'nested-model')).toBe(false)
      expect(activity.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({
          call: {
            id: 'durable-tool',
            name: 'start_subagent',
            args: { description: 'Inspect durable state', agent: 'general-purpose' }
          },
          status: 'completed',
          output: JSON.stringify({ subagent_id: 'durable-subagent' })
        }),
        expect.objectContaining({
          call: expect.objectContaining({ id: 'proven-nested-tool' }),
          subagentId: 'durable-subagent',
          status: 'completed',
          output: 'proven nested output'
        })
      ]))
      expect(activity.tools.some((tool) => tool.call.id === 'ahead-tool')).toBe(false)
      expect(activity.tools.some((tool) => tool.call.id === 'ahead-nested-tool')).toBe(false)
      expect(activity.tools.some((tool) => tool.call.id === 'nested-tool')).toBe(false)
      expect(activity.subagents).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: 'durable-subagent',
          status: 'running'
        }),
        expect.objectContaining({
          id: 'proven-nested-child',
          parentSubagentId: 'durable-subagent',
          status: 'running'
        })
      ]))
      expect(activity.subagents.some((subagent) => subagent.id === 'ahead-subagent')).toBe(false)
      expect(activity.subagents.some(
        (subagent) => subagent.id === 'ahead-nested-child'
      )).toBe(false)
      expect(activity.subagents.some((subagent) => subagent.id === 'nested-child')).toBe(false)

      const replayed = database.recordToolActivity(run.id, {
        id: 'ahead-tool',
        name: 'execute',
        args: { command: 'replayed' }
      }, 'running')
      expect(replayed).toMatchObject({
        status: 'running',
        output: undefined,
        completedAt: undefined
      })
    } finally {
      database.close()
    }
  })

  it('persists pending tool approvals and clears them on completion', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'approval-activities-run')
      const first = { id: 'tool-1', name: 'execute', args: { command: 'echo one' } }
      const second = { id: 'tool-2', name: 'execute', args: { command: 'echo two' } }
      database.recordToolActivity(run.id, first, 'running', 'subagent-1')
      database.recordToolActivity(run.id, second, 'running', 'subagent-1')
      database.recordToolApproval(run.id, first.id, {
        status: 'pending_approval',
        interruptId: 'approval-1',
        actionIndex: 0
      }, 'subagent-1')
      database.recordToolApproval(run.id, second.id, {
        status: 'pending_approval',
        interruptId: 'approval-1',
        actionIndex: 1
      }, 'subagent-1')

      await markRunInterrupted(database, thread.id, run.id, 'approval-1')
      database.finishRun(run.id, 'interrupted')
      expect(database.getActivitiesForThread(thread.id)[0].tools).toEqual([
        expect.objectContaining({
          call: first,
          approval: {
            status: 'pending_approval',
            interruptId: 'approval-1',
            actionIndex: 0
          }
        }),
        expect.objectContaining({
          call: second,
          approval: {
            status: 'pending_approval',
            interruptId: 'approval-1',
            actionIndex: 1
          }
        })
      ])

      database.resumeRun(run.id, [{
        interruptId: 'approval-1',
        response: { decisions: [{ type: 'approve' }] }
      }])
      database.recordToolActivity(run.id, first, 'completed', 'subagent-1', 'done')
      expect(database.getActivitiesForThread(thread.id)[0].tools).toEqual([
        expect.not.objectContaining({ approval: expect.anything() }),
        expect.objectContaining({ approval: expect.objectContaining({ actionIndex: 1 }) })
      ])

      await markRunCompleted(database, thread.id, run.id)
      database.finishRun(run.id, 'completed')
      expect(database.getActivitiesForThread(thread.id)[0].tools).toEqual([])
    } finally {
      database.close()
    }
  })

  it('projects child activity using its own canonical messages without copying bodies into parent rows', async () => {
    const database=AgentDatabase.open(':memory:')
    try {
      const owner=database.createThread()
      const run=database.createRun(owner.id,'parent-run')
      const child=database.createSubagentCall({
        id:'70000000-0000-8000-8000-000000000001',ownerThreadId:owner.id,parentThreadId:owner.id,parentRunId:run.id,
        childThreadId:'71000000-0000-8000-0000-000000000001',childRunId:'72000000-0000-8000-0000-000000000001',
        config:subagentConfig('researcher'),description:'Inspect files',childThread:{title:'Child'}
      })
      const call={id:'inspect',name:'read_file',args:{path:'example.txt'}}
      await putRootCheckpoint(database,child.childThreadId,'child-current',{
        messages:[new AIMessage({id:'child-message',content:[{type:'text',text:'Inspecting'},{type:'reasoning',reasoning:'Need both files'}],tool_calls:[call],additional_kwargs:{anas_run_id:child.childRunId}}),
          new ToolMessage({id:'child-result',tool_call_id:call.id,content:'files'})],
        anasRunLifecycle:{runId:child.childRunId,status:'completed'}
      })
      database.recordProjectedModelActivity(child.id,owner.id,{id:'child-model',messageId:'child-message',subagentId:child.id,status:'completed',text:'Ignored notification copy',reasoning:'',toolCallIds:[call.id]})
      database.recordProjectedToolActivity(child.id,owner.id,call,'completed',child.id,'Ignored notification copy')
      database.finishRun(child.childRunId,'completed')
      expect(database.getRunActivity(run.id)).toMatchObject({
        models:[expect.objectContaining({subagentId:child.id,text:'Inspecting',reasoning:'Need both files'})],
        tools:[expect.objectContaining({subagentId:child.id,call,output:'files'})]
      })
      const raw=(database as unknown as {database:Database.Database}).database
      expect(raw.prepare('SELECT COUNT(*) AS count FROM message_bodies').get()).toEqual({count:2})
      expect(raw.prepare("SELECT output_json FROM agent_activities WHERE kind='tool'").all()).toEqual([{output_json:null},{output_json:null}])
    } finally {database.close()}
  })

  it('derives the sidebar user-turn count from agent runs only', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      expect(thread.userTurnCount).toBe(0)
      const agentRun = database.createRun(thread.id, 'agent-turn')
      await markRunCompleted(database, thread.id, agentRun.id)
      database.finishRun(agentRun.id, 'completed')
      const compressionRun = database.createRun(thread.id, 'compression', 'compression')
      await markRunCompleted(database, thread.id, compressionRun.id)
      database.finishRun(compressionRun.id, 'completed')
      expect(database.getThread(thread.id)?.userTurnCount).toBe(1)
      expect(database.listThreads()[0].userTurnCount).toBe(1)
    } finally {
      database.close()
    }
  })

  it('projects failed runs even when they produced no model or tool activity', () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'immediate-failure')
      database.finishRun(run.id, 'failed', 'Provider rejected the request.')

      expect(database.getActivitiesForThread(thread.id)).toEqual([
        expect.objectContaining({
          runId: run.id,
          status: 'failed',
          error: 'Provider rejected the request.',
          createdAt: expect.any(String),
          updatedAt: expect.any(String),
          models: [],
          tools: [],
          subagents: []
        })
      ])
    } finally {
      database.close()
    }
  })

  it('stores ordered context summaries through a target run', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const firstRun = database.createRun(thread.id, 'summary-run-1')
      const first = database.recordContextSummaryStarted(firstRun.id, 'summary-1')
      await stageAndCommitSummary(database, thread.id, firstRun.id, first.id, {
        summaryText: 'Visible first summary',
        modelContent: 'Model first summary',
        cutoffIndex: 2,
        activatedAfterMessageIndex: 3,
        coveredThroughMessageId: 'message-2',
        firstPreservedMessageId: 'message-3',
        inputTokensBefore: 100,
        inputTokensAfter: 30
      })
      await markRunCompleted(database, thread.id, firstRun.id)
      database.finishRun(firstRun.id, 'completed')

      const secondRun = database.createRun(thread.id, 'summary-run-2')
      const second = database.recordContextSummaryStarted(secondRun.id, 'summary-2')
      await stageAndCommitSummary(database, thread.id, secondRun.id, second.id, {
        summaryText: 'Visible second summary',
        modelContent: 'Model second summary',
        cutoffIndex: 4,
        activatedAfterMessageIndex: 5
      })
      await markRunCompleted(database, thread.id, secondRun.id)
      database.finishRun(secondRun.id, 'completed')

      expect(database.contextSummariesThroughRun(thread.id, secondRun.id)).toEqual([
        expect.objectContaining({
          id: 'summary-1',
          runId: firstRun.id,
          modelContent: 'Model first summary',
          cutoffIndex: 2
        }),
        expect.objectContaining({
          id: 'summary-2',
          runId: secondRun.id,
          modelContent: 'Model second summary',
          cutoffIndex: 4
        })
      ])
      expect(database.getActivitiesForThread(thread.id)).toEqual([
        expect.objectContaining({
          runId: firstRun.id,
          summaries: [expect.objectContaining({
            id: 'summary-1',
            summaryText: 'Visible first summary'
          })]
        }),
        expect.objectContaining({
          runId: secondRun.id,
          summaries: [expect.objectContaining({
            id: 'summary-2',
            summaryText: 'Visible second summary'
          })]
        })
      ])
    } finally {
      database.close()
    }
  })

  it('removes only incomplete summaries and keeps repeated committed compressions', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'repeated-summary-run')
      for (const [index, id] of ['summary-1', 'summary-2'].entries()) {
        database.recordContextSummaryStarted(run.id, id)
        await stageAndCommitSummary(database, thread.id, run.id, id, {
          summaryText: `Visible ${id}`,
          modelContent: `Model ${id}`,
          cutoffIndex: index + 1,
          activatedAfterMessageIndex: index
        })
      }
      database.recordContextSummaryStarted(run.id, 'summary-incomplete')

      await putRootCheckpoint(database, thread.id, 'repeated-summary-terminal')
      database.reconcileContextSummariesForCheckpoint(
        thread.id,
        'repeated-summary-terminal',
        undefined,
        { type: 'run', runId: run.id }
      )
      await markRunCompleted(database, thread.id, run.id)
      database.finishRun(run.id, 'completed')

      expect(database.contextSummariesThroughRun(thread.id, run.id)).toEqual([
        expect.objectContaining({ id: 'summary-1', cutoffIndex: 1 }),
        expect.objectContaining({ id: 'summary-2', cutoffIndex: 2 })
      ])
      expect(database.getActivitiesForThread(thread.id)[0].summaries).toEqual([
        expect.objectContaining({ id: 'summary-1' }),
        expect.objectContaining({ id: 'summary-2' })
      ])
    } finally {
      database.close()
    }
  })

  it('commits only the staged summary whose durable event carries the same summary id', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'summary-collision-run')
      for (const id of ['summary-old', 'summary-current']) {
        database.recordContextSummaryStarted(run.id, id)
        database.stageContextSummary(run.id, id, {
          summaryText: 'Same visible summary',
          modelContent: 'Same model summary',
          cutoffIndex: 2,
          activatedAfterMessageIndex: 1
        })
      }
      expect(database.contextSummariesThroughRun(thread.id, run.id)).toEqual([])

      await putRootCheckpoint(database, thread.id, 'summary-collision-checkpoint')
      const committed = database.reconcileContextSummariesForCheckpoint(
        thread.id,
        'summary-collision-checkpoint',
        {
          summaryId: 'summary-current',
          modelContent: 'Same model summary',
          cutoffIndex: 2,
          runId: run.id
        },
        { type: 'run', runId: run.id }
      )

      expect(committed).toMatchObject({
        id: 'summary-current',
        committedCheckpointId: 'summary-collision-checkpoint',
        status: 'completed'
      })
      expect(database.contextSummariesThroughRun(thread.id, run.id)).toEqual([
        expect.objectContaining({ id: 'summary-current' })
      ])
      expect(database.getActivitiesForThread(thread.id)[0].summaries).toEqual([
        expect.objectContaining({ id: 'summary-current', status: 'completed' })
      ])
    } finally {
      database.close()
    }
  })

  it('preserves staged summaries at an intermediate checkpoint without their event', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'interleaved-summary-run')
      database.recordContextSummaryStarted(run.id, 'interleaved-summary')
      database.stageContextSummary(run.id, 'interleaved-summary', {
        summaryText: 'Waiting for its checkpoint',
        modelContent: 'Waiting for its checkpoint',
        cutoffIndex: 1,
        activatedAfterMessageIndex: 0
      })
      await putRootCheckpoint(database, thread.id, 'earlier-checkpoint')

      expect(database.reconcileContextSummariesForCheckpoint(
        thread.id,
        'earlier-checkpoint',
        undefined,
        { type: 'preserve_staged' }
      )).toBeUndefined()
      expect(database.getActivitiesForThread(thread.id)[0].summaries).toEqual([
        expect.objectContaining({ id: 'interleaved-summary', status: 'running' })
      ])
    } finally {
      database.close()
    }
  })

  it('never commits a staged summary from an untagged final checkpoint event', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'untagged-summary-run')
      database.recordContextSummaryStarted(run.id, 'untagged-summary')
      database.stageContextSummary(run.id, 'untagged-summary', {
        summaryText: 'Coincidentally identical',
        modelContent: 'Coincidentally identical',
        cutoffIndex: 1,
        activatedAfterMessageIndex: 0
      })
      await putRootCheckpoint(database, thread.id, 'untagged-checkpoint')

      expect(database.reconcileContextSummariesForCheckpoint(
        thread.id,
        'untagged-checkpoint',
        undefined,
        { type: 'run', runId: run.id }
      )).toBeUndefined()
      expect(database.contextSummariesThroughRun(thread.id, run.id)).toEqual([])
      expect(database.getActivitiesForThread(thread.id)[0].summaries).toBeUndefined()
    } finally {
      database.close()
    }
  })

  it('retains complete managed call output and reads arbitrary ranges', () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'managed-output-run')
      database.createManagedCall({
        id: 'managed-output-call',
        threadId: thread.id,
        runId: run.id,
        kind: 'shell',
        summary: 'stream output'
      })
      database.markManagedCallRunning('managed-output-call', thread.id)

      expect(database.appendManagedCallOutputBatch({
        callId: 'managed-output-call',
        threadId: thread.id,
        chunks: [
          { stream: 'stdout', text: 'ab' },
          { stream: 'stderr', text: 'cd' },
          { stream: 'stdout', text: '😀😀😀' },
          { stream: 'progress', text: 'stored' }
        ]
      })).toEqual([
        { sequence: 1, stream: 'stdout', startOffset: 0, endOffset: 2, text: 'ab' },
        { sequence: 2, stream: 'stderr', startOffset: 2, endOffset: 4, text: 'cd' },
        { sequence: 3, stream: 'stdout', startOffset: 4, endOffset: 10, text: '😀😀😀' },
        { sequence: 4, stream: 'progress', startOffset: 10, endOffset: 16, text: 'stored' }
      ])
      expect(database.appendManagedCallOutput({
        callId: 'managed-output-call',
        threadId: thread.id,
        stream: 'stderr',
        text: 'tail'
      })).toEqual({
        sequence: 5,
        stream: 'stderr',
        startOffset: 16,
        endOffset: 20,
        text: 'tail'
      })

      expect(database.getManagedCall('managed-output-call', thread.id)).toMatchObject({
        outputChars: 20
      })
      expect(database.readManagedCallOutputRange(
        'managed-output-call',
        thread.id,
        -8,
        8
      )).toEqual({
        chunks: [
          { sequence: 4, stream: 'progress', startOffset: 12, endOffset: 16, text: 'ored' },
          { sequence: 5, stream: 'stderr', startOffset: 16, endOffset: 20, text: 'tail' }
        ],
        startOffset: 12,
        endOffset: 20,
        totalChars: 20,
        hasBefore: true,
        hasAfter: false
      })
      expect(database.readManagedCallOutputRange(
        'managed-output-call',
        thread.id,
        -100,
        100
      )).toMatchObject({
        startOffset: 0,
        endOffset: 20,
        totalChars: 20,
        hasBefore: false,
        hasAfter: false
      })
    } finally {
      database.close()
    }
  })

  it('retains managed call results for as long as their conversation exists', () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'managed-retention-run')
      for (let index = 0; index < 102; index += 1) {
        const callId = `managed-retention-call-${index}`
        database.createManagedCall({
          id: callId,
          threadId: thread.id,
          runId: run.id,
          kind: 'http',
          summary: `request ${index}`
        })
        database.finishManagedCall({
          callId,
          threadId: thread.id,
          status: 'completed',
          result: `result ${index}`
        })
      }

      expect(database.getManagedCall('managed-retention-call-0', thread.id)).toMatchObject({
        status: 'completed',
        result: 'result 0'
      })
      expect(database.getManagedCall('managed-retention-call-101', thread.id)).toMatchObject({
        status: 'completed',
        result: 'result 101'
      })
    } finally {
      database.close()
    }
  })

  it('tracks detached managed calls until their terminal state is observed', () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'managed-resolution-run')
      for (const callId of ['managed-active-call', 'managed-terminal-call']) {
        database.createManagedCall({
          id: callId,
          threadId: thread.id,
          runId: run.id,
          kind: 'http',
          summary: callId
        })
        database.markManagedCallDetached(callId, thread.id)
      }
      database.createManagedCall({
        id: 'managed-inline-call',
        threadId: thread.id,
        runId: run.id,
        kind: 'http',
        summary: 'completed without returning a handle'
      })
      database.finishManagedCall({
        callId: 'managed-inline-call',
        threadId: thread.id,
        status: 'completed',
        result: 'inline result'
      })
      database.markManagedCallRunning('managed-active-call', thread.id)
      database.finishManagedCall({
        callId: 'managed-terminal-call',
        threadId: thread.id,
        status: 'completed',
        result: 'done'
      })
      const otherThread = database.createThread()
      const otherRun = database.createRun(otherThread.id, 'managed-resolution-other-run')
      database.createManagedCall({
        id: 'managed-other-thread-call',
        threadId: otherThread.id,
        runId: otherRun.id,
        kind: 'shell',
        summary: 'other conversation'
      })
      database.markManagedCallDetached('managed-other-thread-call', otherThread.id)

      expect(() => database.resolveManagedCall('managed-active-call', thread.id, run.id)).toThrow(
        'Managed call managed-active-call is still running.'
      )
      expect(() => database.resolveManagedCall('managed-inline-call', thread.id, run.id)).toThrow(
        'Managed call managed-inline-call has not returned a background handle.'
      )
      expect(database.listUnresolvedManagedCalls(run.id).map((call) => call.id)).toEqual([
        'managed-active-call',
        'managed-terminal-call'
      ])
      expect(database.listUnresolvedManagedCallsForThread(thread.id).map((call) => call.id)).toEqual([
        'managed-active-call',
        'managed-terminal-call'
      ])
      expect(database.listUnresolvedManagedCallsForThread(thread.id, 1).map((call) => call.id)).toEqual([
        'managed-active-call'
      ])
      expect(database.hasUnresolvedManagedCallsForThread(thread.id)).toBe(true)

      expect(() => database.resolveManagedCall(
        'managed-terminal-call',
        thread.id,
        otherRun.id
      )).toThrow(`Run ${otherRun.id} does not belong to thread ${thread.id}.`)
      const resolved = database.resolveManagedCall('managed-terminal-call', thread.id, run.id)
      expect(resolved).toMatchObject({
        id: 'managed-terminal-call',
        status: 'completed',
        detachedAt: expect.any(String)
      })
      expect(database.listUnresolvedManagedCalls(run.id).map((call) => call.id)).toEqual([
        'managed-active-call'
      ])
      expect(database.listUnresolvedManagedCallsForThread(thread.id).map((call) => call.id)).toEqual([
        'managed-active-call'
      ])
      database.finishManagedCall({
        callId: 'managed-active-call',
        threadId: thread.id,
        status: 'cancelled'
      })
      database.resolveManagedCall('managed-active-call', thread.id, run.id)
      expect(database.hasUnresolvedManagedCallsForThread(thread.id)).toBe(false)
    } finally {
      database.close()
    }
  })

  it('enforces managed call and observation conversation ownership in SQLite', () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const firstThread = database.createThread({ title: 'First managed-call owner' })
      const firstRun = database.createRun(firstThread.id, 'managed-owner-first-run')
      const secondThread = database.createThread({ title: 'Second managed-call owner' })
      const secondRun = database.createRun(secondThread.id, 'managed-owner-second-run')
      const raw = (database as unknown as { database: Database.Database }).database
      const insertCall = raw.prepare(`
        INSERT INTO agent_managed_calls (
          id, thread_id, run_id, kind, summary, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'http', 'cross-conversation call', 'preparing', ?, ?)
      `)
      const now = new Date().toISOString()

      expect(() => insertCall.run(
        'managed-cross-conversation-call',
        firstThread.id,
        secondRun.id,
        now,
        now
      )).toThrow(/FOREIGN KEY constraint failed/)

      database.createManagedCall({
        id: 'managed-owned-call',
        threadId: firstThread.id,
        runId: firstRun.id,
        kind: 'http',
        summary: 'valid call ownership'
      })
      database.markManagedCallDetached('managed-owned-call', firstThread.id)
      database.finishManagedCall({
        callId: 'managed-owned-call',
        threadId: firstThread.id,
        status: 'completed',
        result: 'done'
      })
      const insertObservation = raw.prepare(`
        INSERT INTO agent_managed_call_observations (
          call_id, thread_id, run_id, observed_at
        ) VALUES (?, ?, ?, ?)
      `)
      expect(() => insertObservation.run(
        'managed-owned-call',
        firstThread.id,
        secondRun.id,
        now
      )).toThrow(/FOREIGN KEY constraint failed/)
      expect(() => insertObservation.run(
        'managed-owned-call',
        secondThread.id,
        secondRun.id,
        now
      )).toThrow(/FOREIGN KEY constraint failed/)
    } finally {
      database.close()
    }
  })

  it('rejects a prototype managed call table without the owner-run foreign key', () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-managed-call-schema-'))
    const databasePath = join(root, 'agent.sqlite')
    try {
      const database = AgentDatabase.open(databasePath)
      const thread = database.createThread({ title: 'Prototype managed call schema' })
      const run = database.createRun(thread.id, 'prototype-managed-call-run')
      database.close()

      replaceManagedCallTableWithPrototype(databasePath)

      const raw = new Database(databasePath)
      try {
        const now = new Date().toISOString()
        raw.prepare(`
          INSERT INTO agent_managed_calls (
            id, thread_id, run_id, kind, summary, status, created_at, updated_at
          ) VALUES (?, ?, ?, 'shell', 'prototype running call', 'running', ?, ?)
        `).run('prototype-running-call', thread.id, run.id, now, now)
      } finally {
        raw.close()
      }

      expect(() => AgentDatabase.open(databasePath)).toThrow(
        'Unsupported agent database schema: agent_managed_calls must reference agent_runs with (run_id, thread_id) ON DELETE CASCADE.'
      )

      const unchanged = new Database(databasePath, { readonly: true })
      try {
        expect(unchanged.prepare(`
          SELECT status
          FROM agent_managed_calls
          WHERE id = ?
        `).get('prototype-running-call')).toEqual({ status: 'running' })
      } finally {
        unchanged.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a managed call whose owner run is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-managed-call-orphan-'))
    const databasePath = join(root, 'agent.sqlite')
    try {
      const database = AgentDatabase.open(databasePath)
      const thread = database.createThread({ title: 'Orphan managed call' })
      database.close()

      const raw = new Database(databasePath)
      try {
        raw.pragma('foreign_keys = OFF')
        const now = new Date().toISOString()
        raw.prepare(`
          INSERT INTO agent_managed_calls (
            id, thread_id, run_id, kind, summary, status, created_at, updated_at
          ) VALUES (?, ?, ?, 'shell', 'orphan call', 'completed', ?, ?)
        `).run('managed-orphan-call', thread.id, 'missing-owner-run', now, now)
      } finally {
        raw.close()
      }

      expect(() => AgentDatabase.open(databasePath)).toThrow(
        'Managed call managed-orphan-call does not belong to its recorded conversation.'
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a backup with a prototype managed call table even without orphan rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-managed-call-schema-backup-'))
    const databasePath = join(root, 'agent.sqlite')
    const attachmentRoot = join(root, 'attachments')
    try {
      AgentDatabase.open(databasePath, attachmentRoot).close()
      replaceManagedCallTableWithPrototype(databasePath)

      expect(() => AgentDatabase.validateBackup(
        databasePath,
        attachmentRoot,
        new Set()
      )).toThrow(
        'Unsupported agent database schema: missing column agent_managed_calls.outcome_json.'
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a backup whose managed call points at a run from another conversation', () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-managed-call-backup-owner-'))
    const databasePath = join(root, 'agent.sqlite')
    const attachmentRoot = join(root, 'attachments')
    let database: AgentDatabase | undefined = AgentDatabase.open(databasePath, attachmentRoot)
    try {
      const firstThread = database.createThread({ title: 'Backup call owner' })
      const secondThread = database.createThread({ title: 'Backup call wrong owner' })
      const secondRun = database.createRun(secondThread.id, 'managed-backup-other-run')
      const projectIds = new Set([firstThread.projectId, secondThread.projectId])
      database.close()
      database = undefined

      const raw = new Database(databasePath)
      try {
        raw.pragma('foreign_keys = OFF')
        const now = new Date().toISOString()
        raw.prepare(`
          INSERT INTO agent_managed_calls (
            id, thread_id, run_id, kind, summary, status, created_at, updated_at
          ) VALUES (?, ?, ?, 'shell', 'invalid backup call', 'preparing', ?, ?)
        `).run(
          'managed-invalid-backup-call',
          firstThread.id,
          secondRun.id,
          now,
          now
        )
      } finally {
        raw.close()
      }

      expect(() => AgentDatabase.validateBackup(
        databasePath,
        attachmentRoot,
        projectIds
      )).toThrow(
        'Managed call managed-invalid-backup-call does not belong to its recorded conversation.'
      )
    } finally {
      database?.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a backup whose managed call observation crosses conversations', () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-managed-observation-backup-owner-'))
    const databasePath = join(root, 'agent.sqlite')
    const attachmentRoot = join(root, 'attachments')
    let database: AgentDatabase | undefined = AgentDatabase.open(databasePath, attachmentRoot)
    try {
      const firstThread = database.createThread({ title: 'Backup observation owner' })
      const firstRun = database.createRun(firstThread.id, 'managed-backup-first-run')
      const secondThread = database.createThread({ title: 'Backup observation wrong owner' })
      const secondRun = database.createRun(secondThread.id, 'managed-backup-second-run')
      const projectIds = new Set([firstThread.projectId, secondThread.projectId])
      database.createManagedCall({
        id: 'managed-backup-observed-call',
        threadId: firstThread.id,
        runId: firstRun.id,
        kind: 'http',
        summary: 'call observed by the wrong conversation'
      })
      database.close()
      database = undefined

      const raw = new Database(databasePath)
      try {
        raw.pragma('foreign_keys = OFF')
        raw.prepare(`
          INSERT INTO agent_managed_call_observations (
            call_id, thread_id, run_id, observed_at
          ) VALUES (?, ?, ?, ?)
        `).run(
          'managed-backup-observed-call',
          firstThread.id,
          secondRun.id,
          new Date().toISOString()
        )
      } finally {
        raw.close()
      }

      expect(() => AgentDatabase.validateBackup(
        databasePath,
        attachmentRoot,
        projectIds
      )).toThrow(
        `Managed call observation managed-backup-observed-call/${secondRun.id} crosses conversations.`
      )
    } finally {
      database?.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('keeps cleanup handoffs across restart and regeneration without fabricating terminal observations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-background-cleanup-'))
    const databasePath = join(root, 'agent.sqlite')
    const attachmentRoot = join(root, 'attachments')
    let database: AgentDatabase | undefined = AgentDatabase.open(databasePath, attachmentRoot)
    try {
      const thread = database.createThread()
      const original = database.createRun(thread.id, 'original-background-run')
      const child = database.createSubagentCall({
        id: '48000000-0000-8000-8000-000000000002', ownerThreadId: thread.id, parentThreadId: thread.id,
        parentRunId: original.id, childThreadId: '58000000-0000-8000-8000-000000000002',
        childRunId: '68000000-0000-8000-8000-000000000002', config: subagentConfig('worker'),
        description: 'Unconfirmed child', childThread: { title: 'Child' }
      })
      for (const [id, threadId, runId] of [
        ['parent-call', thread.id, original.id], ['child-call', child.childThreadId, child.childRunId]
      ]) {
        database.createManagedCall({ id, threadId, runId, kind: 'mcp', summary: 'Unconfirmed remote call' })
        database.markManagedCallRunning(id, threadId)
        database.markManagedCallDetached(id, threadId)
      }
      database.finishRun(original.id, 'failed', 'Original failure')
      const cleanup = database.createRun(thread.id, 'cleanup-report-run')
      const handedOff = database.handoffBackgroundTasksToCleanup(cleanup.id)
      expect(handedOff.calls.map((call) => call.id).sort()).toEqual(['child-call', 'parent-call'])
      expect(handedOff.subagents.map((call) => call.id)).toEqual([child.id])
      expect(database.handoffBackgroundTasksToCleanup(cleanup.id)).toEqual({ calls: [], subagents: [] })
      expect(() => database!.resolveManagedCall('parent-call', thread.id, cleanup.id)).toThrow('still running')
      expect(() => database!.resolveSubagentCall(child.id, thread.id, original.id)).toThrow('still running')
      database.finishRun(cleanup.id, 'failed', 'Cancellation unconfirmed')
      await database.replaceMessageHistory(thread.id, [], cleanup.id)
      expect(database.getRun(cleanup.id)).toBeNull()
      database.close()
      database = undefined
      database = AgentDatabase.open(databasePath, attachmentRoot)
      expect(database.listUnresolvedManagedCalls(original.id)).toEqual([])
      expect(database.listUnresolvedManagedCallsForThread(thread.id)).toEqual([])
      expect(database.hasUnresolvedManagedCallsForThread(thread.id)).toBe(false)
      expect(database.listUnresolvedManagedCallsForThread(child.childThreadId)).toEqual([])
      expect(database.listThreadIdsWithUnresolvedManagedCalls()).toEqual([])
      expect(database.listUnresolvedSubagentCallsForRun(original.id)).toEqual([])
      expect(database.getManagedCall('parent-call', thread.id)?.status).toBe('uncertain')
      expect(database.getSubagentCall(child.id, thread.id)).toBeDefined()
    } finally {
      database?.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('persists managed call observation state across database restarts', () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-managed-observation-'))
    const databasePath = join(root, 'agent.sqlite')
    let database: AgentDatabase | undefined = AgentDatabase.open(databasePath, join(root, 'attachments'))
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'managed-observation-run')
      database.createManagedCall({
        id: 'managed-observation-call',
        threadId: thread.id,
        runId: run.id,
        kind: 'shell',
        summary: 'persist observation state'
      })
      database.markManagedCallDetached('managed-observation-call', thread.id)
      database.finishManagedCall({
        callId: 'managed-observation-call',
        threadId: thread.id,
        status: 'completed',
        result: 'persisted result'
      })
      database.close()
      database = undefined

      database = AgentDatabase.open(databasePath, join(root, 'attachments'))
      const unresolved = database.listUnresolvedManagedCalls(run.id)
      expect(unresolved).toEqual([
        expect.objectContaining({
          id: 'managed-observation-call',
          detachedAt: expect.any(String),
          result: 'persisted result'
        })
      ])
      database.resolveManagedCall('managed-observation-call', thread.id, run.id)
      database.close()
      database = undefined

      database = AgentDatabase.open(databasePath, join(root, 'attachments'))
      expect(database.listUnresolvedManagedCalls(run.id)).toEqual([])
      expect(database.getManagedCall('managed-observation-call', thread.id)).toMatchObject({
        id: 'managed-observation-call',
        status: 'completed'
      })
    } finally {
      database?.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects live thread attachment cleanup before opening can remove its files', () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-live-thread-cleanup-'))
    const databasePath = join(root, 'agent.sqlite')
    const attachmentRoot = join(root, 'attachments')
    let database: AgentDatabase | undefined = AgentDatabase.open(databasePath, attachmentRoot)
    try {
      const thread = database.createThread({ title: 'Live attachment owner' })
      const run = database.createRun(thread.id, 'live-attachment-run')
      const attachment = createStoredAttachment(
        attachmentRoot,
        thread.id,
        run.id,
        'live-thread-attachment'
      )
      database.appendRunAttachments(run.id, [attachment])
      const raw = (database as unknown as { database: Database.Database }).database
      raw.prepare(`
        INSERT INTO agent_attachment_cleanup_outbox (thread_id)
        VALUES (?)
      `).run(thread.id)
      database.close()
      database = undefined

      expect(() => AgentDatabase.validateBackup(
        databasePath,
        attachmentRoot,
        new Set([thread.projectId])
      )).toThrow(`Live conversation ${thread.id} cannot be scheduled for attachment cleanup.`)
      expect(() => AgentDatabase.open(databasePath, attachmentRoot)).toThrow(
        `Live conversation ${thread.id} cannot be scheduled for attachment cleanup.`
      )
      expect(existsSync(attachment.artifact.path)).toBe(true)

      const unchanged = new Database(databasePath, { readonly: true })
      try {
        expect(unchanged.prepare(`
          SELECT id
          FROM agent_attachments
          WHERE id = ?
        `).get(attachment.artifact.id)).toEqual({ id: attachment.artifact.id })
      } finally {
        unchanged.close()
      }
    } finally {
      database?.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects hidden thread storage without cascading conversation ownership', () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-hidden-thread-schema-'))
    const databasePath = join(root, 'agent.sqlite')
    const attachmentRoot = join(root, 'attachments')
    try {
      AgentDatabase.open(databasePath, attachmentRoot).close()
      replaceHiddenThreadTableWithoutCascade(databasePath)

      const error = 'Unsupported agent database schema: agent_hidden_threads.thread_id must reference agent_threads.id ON DELETE CASCADE.'
      expect(() => AgentDatabase.validateBackup(
        databasePath,
        attachmentRoot,
        new Set()
      )).toThrow(error)
      expect(() => AgentDatabase.open(databasePath, attachmentRoot)).toThrow(error)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects subagent call tables without the required cascading foreign keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-subagent-call-schema-'))
    const databasePath = join(root, 'agent.sqlite')
    const attachmentRoot = join(root, 'attachments')
    try {
      AgentDatabase.open(databasePath, attachmentRoot).close()
      replaceSubagentTablesWithoutForeignKeys(databasePath)

      const error = 'Unsupported agent database schema: agent_subagent_calls.owner_thread_id must reference agent_threads.id ON DELETE CASCADE.'
      expect(() => AgentDatabase.validateBackup(
        databasePath,
        attachmentRoot,
        new Set()
      )).toThrow(error)
      expect(() => AgentDatabase.open(databasePath, attachmentRoot)).toThrow(error)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects subagent observation tables without cascading foreign keys', () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-subagent-observation-schema-'))
    const databasePath = join(root, 'agent.sqlite')
    const attachmentRoot = join(root, 'attachments')
    try {
      AgentDatabase.open(databasePath, attachmentRoot).close()
      replaceSubagentObservationTableWithoutCascade(databasePath)

      const error = 'Unsupported agent database schema: agent_subagent_observations.subagent_id must reference agent_subagent_calls.id ON DELETE CASCADE.'
      expect(() => AgentDatabase.validateBackup(
        databasePath,
        attachmentRoot,
        new Set()
      )).toThrow(error)
      expect(() => AgentDatabase.open(databasePath, attachmentRoot)).toThrow(error)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('rejects a subagent observation recorded by a run other than its parent', () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-subagent-observation-owner-'))
    const databasePath = join(root, 'agent.sqlite')
    const attachmentRoot = join(root, 'attachments')
    let database: AgentDatabase | undefined = AgentDatabase.open(databasePath, attachmentRoot)
    try {
      const owner = database.createThread({ title: 'Observation owner' })
      const parentRun = database.createRun(owner.id, 'observation-parent-run')
      const call = database.createSubagentCall({
        id: '48000000-0000-8000-8000-000000000001',
        ownerThreadId: owner.id,
        parentThreadId: owner.id,
        parentRunId: parentRun.id,
        childThreadId: '58000000-0000-8000-8000-000000000001',
        childRunId: '68000000-0000-8000-8000-000000000001',
        config: subagentConfig('reviewer'),
        description: 'Must only be observed by its parent run.',
        childThread: { title: 'Observed hidden child', projectId: owner.projectId }
      })
      const raw = (database as unknown as { database: Database.Database }).database
      raw.prepare(`
        INSERT INTO agent_subagent_observations (
          subagent_id, observing_run_id, observed_at
        ) VALUES (?, ?, ?)
      `).run(call.id, call.childRunId, new Date().toISOString())
      database.close()
      database = undefined

      const error = `Subagent observation ${call.id}/${call.childRunId} does not belong to its parent run.`
      expect(() => AgentDatabase.validateBackup(
        databasePath,
        attachmentRoot,
        new Set([owner.projectId])
      )).toThrow(error)
      expect(() => AgentDatabase.open(databasePath, attachmentRoot)).toThrow(error)
    } finally {
      database?.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('persists and reopens a selected non-default subagent with its delegation policy', () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-selected-subagent-'))
    const path = join(root, 'agent.sqlite')
    let database = AgentDatabase.open(path)
    try {
      const owner = database.createThread({ title: 'Owner' })
      const parentRun = database.createRun(owner.id, 'selected-agent-parent')
      const config = { ...subagentConfig('reviewer'), enabled: false,
        subagentSelection: { mode: 'custom' as const, names: ['researcher'] } }
      const input = {
        id: '11111111-1111-8111-8111-111111111111', ownerThreadId: owner.id, parentThreadId: owner.id, parentRunId: parentRun.id,
        childThreadId: '22222222-2222-8222-8222-222222222222', childRunId: '33333333-3333-8333-8333-333333333333',
        config, description: 'Explicit project selection.', childThread: { title: 'Selected child' }
      }
      expect(() => database.createSubagentCall({ ...input, config: { ...config, systemPrompt: '' } })).toThrow('must not be empty')
      database.createSubagentCall(input)
      database.close()
      database = AgentDatabase.open(path)
      expect(database.getSubagentCall(input.id, owner.id)?.config).toEqual(config)
    } finally { database.close(); rmSync(root, { recursive: true, force: true }) }
  })

  it('keeps durable subagent threads hidden and removes them with their owner', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const owner = database.createThread({ title: 'Owner' })
      const parentRun = database.createRun(owner.id, 'parent-run')
      const call = database.createSubagentCall({
        id: '11111111-1111-8111-8111-111111111111',
        ownerThreadId: owner.id,
        parentThreadId: owner.id,
        parentRunId: parentRun.id,
        childThreadId: '22222222-2222-8222-8222-222222222222',
        childRunId: '33333333-3333-8333-8333-333333333333',
        config: subagentConfig('reviewer'),
        description: 'Review the implementation.',
        childThread: { title: 'Hidden reviewer' }
      })

      expect(database.listThreads().map((thread) => thread.id)).toEqual([owner.id])
      expect(database.listSubagentCalls(owner.id)).toEqual([
        expect.objectContaining({ id: call.id, childThreadId: call.childThreadId })
      ])

      expect(database.cancelRecoverableRun(call.childRunId)).toBe(true)
      database.finishSubagentCall({
        subagentId: call.id,
        ownerThreadId: owner.id,
        status: 'completed',
        result: 'Reviewed.'
      })
      await database.deleteSubagentThreads(owner.id)

      expect(database.getThread(call.childThreadId)).toBeNull()
      expect(database.listSubagentCalls(owner.id)).toEqual([])
    } finally {
      database.close()
    }
  })

  it('rolls back every child checkpoint when atomic subagent deletion fails', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const owner = database.createThread({ title: 'Owner' })
      const parentRun = database.createRun(owner.id, 'atomic-parent-run')
      const calls = [1, 2].map((index) => database.createSubagentCall({
        id: `10000000-0000-8000-8000-00000000000${index}`,
        ownerThreadId: owner.id,
        parentThreadId: owner.id,
        parentRunId: parentRun.id,
        childThreadId: `20000000-0000-8000-8000-00000000000${index}`,
        childRunId: `30000000-0000-8000-8000-00000000000${index}`,
        config: subagentConfig('reviewer'),
        description: `Review part ${index}.`,
        childThread: { title: `Hidden reviewer ${index}` }
      }))
      for (const call of calls) {
        await putRootCheckpoint(database, call.childThreadId, `${call.id}-checkpoint`)
        expect(database.cancelRecoverableRun(call.childRunId)).toBe(true)
      }
      const raw = (database as unknown as { database: Database.Database }).database
      raw.exec(`
        CREATE TRIGGER reject_second_child_delete
        BEFORE DELETE ON agent_threads
        WHEN OLD.id = '${calls[1].childThreadId}'
        BEGIN
          SELECT RAISE(ABORT, 'injected child deletion failure');
        END;
      `)

      await expect(database.deleteSubagentThreads(owner.id))
        .rejects.toThrow('injected child deletion failure')

      for (const call of calls) {
        expect(database.getThread(call.childThreadId)).not.toBeNull()
        await expect(database.checkpointer.getTuple({
          configurable: { thread_id: call.childThreadId, checkpoint_ns: '' }
        })).resolves.toBeDefined()
      }
      expect(database.listSubagentCalls(owner.id)).toHaveLength(2)
    } finally {
      database.close()
    }
  })

  it('cancels recoverable hidden descendants when their parent is terminal at startup', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-subagent-recovery-'))
    const databasePath = join(root, 'agent.sqlite')
    let database: AgentDatabase | undefined = AgentDatabase.open(
      databasePath,
      join(root, 'attachments')
    )
    try {
      const owner = database.createThread({ title: 'Owner' })
      const parentRun = database.createRun(owner.id, 'recovered-parent-run')
      const call = database.createSubagentCall({
        id: '40000000-0000-8000-8000-000000000001',
        ownerThreadId: owner.id,
        parentThreadId: owner.id,
        parentRunId: parentRun.id,
        childThreadId: '50000000-0000-8000-8000-000000000001',
        childRunId: '60000000-0000-8000-8000-000000000001',
        config: subagentConfig('reviewer'),
        description: 'Continue after the parent stopped.',
        childThread: { title: 'Hidden reviewer' }
      })
      database.recordProjectedModelActivity(call.id, owner.id, {
        id: 'abandoned-child-model',
        subagentId: call.id,
        status: 'running',
        text: '',
        reasoning: '',
        toolCallIds: ['abandoned-child-tool']
      })
      database.recordProjectedToolApproval(call.id, owner.id, {
        id: 'abandoned-child-tool',
        name: 'apply_patch',
        args: { path: 'abandoned.txt', content: 'partial' }
      }, {
        status: 'pending_approval',
        interruptId: 'abandoned-child-approval',
        actionIndex: 0
      }, call.id)
      const completeCall = { id: 'completed-child-tool', name: 'read_file', args: { path: 'complete.txt' } }
      database.recordProjectedModelActivity(call.id, owner.id, {
        id: 'completed-child-model', messageId: 'complete-child-message', subagentId: call.id,
        status: 'completed', text: 'Complete child response', reasoning: '', toolCallIds: [completeCall.id]
      })
      database.recordProjectedToolActivity(call.id, owner.id, completeCall, 'completed', call.id, 'Complete tool result')
      await putRootCheckpoint(database, call.childThreadId, 'recoverable-child-checkpoint', {
        messages: [
          new AIMessage({ id: 'complete-child-message', content: 'Complete child response', tool_calls: [completeCall],
            additional_kwargs: { anas_run_id: call.childRunId } }),
          new ToolMessage({ id: 'complete-child-result', content: 'Complete tool result', tool_call_id: completeCall.id,
            additional_kwargs: { anas_run_id: call.childRunId } })
        ],
        anasRunLifecycle: { runId: call.childRunId, status: 'running' }
      })
      await markRunCompleted(database, owner.id, parentRun.id)
      database.finishRun(parentRun.id, 'completed')
      database.close()
      database = undefined

      database = AgentDatabase.open(databasePath, join(root, 'attachments'))
      expect(database.getRun(call.childRunId)?.status).toBe('cancelled')
      expect(database.getThread(call.childThreadId)?.status).toBe('idle')
      expect(database.getSubagentCall(call.id, owner.id)).toMatchObject({
        status: 'cancelled'
      })
      expect(database.getActivitiesForThread(owner.id)[0]?.subagents).toEqual([
        expect.objectContaining({ id: call.id, status: 'cancelled' })
      ])
      expect(database.getActivitiesForThread(owner.id)[0]?.models).toEqual([
        expect.objectContaining({
          id: 'completed-child-model',
          subagentId: call.id,
          status: 'completed',
          text: 'Complete child response',
          completedAt: expect.any(String)
        })
      ])
      expect(database.getActivitiesForThread(owner.id)[0]?.tools).toEqual([
        expect.objectContaining({ call: completeCall, subagentId: call.id, status: 'completed', output: 'Complete tool result' })
      ])
    } finally {
      database?.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    ['completed', 'completed'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled']
  ] as const)(
    'reconciles a %s child independently while its parent remains interrupted',
    async (childStatus, expectedCallStatus) => {
      const root = mkdtempSync(join(tmpdir(), `anas-terminal-child-${childStatus}-`))
      const databasePath = join(root, 'agent.sqlite')
      const attachmentsPath = join(root, 'attachments')
      let database: AgentDatabase | undefined = AgentDatabase.open(databasePath, attachmentsPath)
      try {
        const owner = database.createThread({ title: 'Interrupted owner' })
        const parentRun = database.createRun(owner.id, 'interrupted-parent-run')
        const call = database.createSubagentCall({
          id: '44000000-0000-8000-8000-000000000001',
          ownerThreadId: owner.id,
          parentThreadId: owner.id,
          parentRunId: parentRun.id,
          childThreadId: '54000000-0000-8000-8000-000000000001',
          childRunId: '64000000-0000-8000-8000-000000000001',
          config: subagentConfig('reviewer'),
          description: 'Finish while the parent remains resumable.',
          childThread: { title: 'Terminal hidden reviewer' }
        })
        const modelId = `terminal-child-model-${childStatus}`
        const toolId = `terminal-child-tool-${childStatus}`
        database.recordProjectedModelActivity(call.id, owner.id, {
          id: modelId,
          subagentId: call.id,
          status: 'running',
          text: 'Terminal child output',
          reasoning: '',
          toolCallIds: [toolId]
        })
        database.recordProjectedToolApproval(call.id, owner.id, {
          id: toolId,
          name: 'apply_patch',
          args: { path: 'terminal-child.txt', content: childStatus }
        }, {
          status: 'pending_approval',
          interruptId: `terminal-child-approval-${childStatus}`,
          actionIndex: 0
        }, call.id)

        await markRunInterrupted(database, owner.id, parentRun.id)
        database.finishRun(parentRun.id, 'interrupted')
        if (childStatus === 'completed') {
          await markRunCompleted(database, call.childThreadId, call.childRunId)
        }
        database.finishRun(
          call.childRunId,
          childStatus,
          childStatus === 'failed' ? 'Terminal child failed.' : undefined
        )
        expect(database.getSubagentCall(call.id, owner.id)?.status).toBe('running')
        database.close()
        database = undefined

        database = AgentDatabase.open(databasePath, attachmentsPath)
        expect(database.getRun(parentRun.id)?.status).toBe('interrupted')
        expect(database.getRun(call.childRunId)?.status).toBe(childStatus)
        const recoveredCall = database.getSubagentCall(call.id, owner.id)
        expect(recoveredCall).toMatchObject({ status: expectedCallStatus })
        if (childStatus === 'failed') {
          expect(recoveredCall).toMatchObject({ error: 'Terminal child failed.' })
        } else {
          expect(recoveredCall).not.toHaveProperty('error')
        }

        const activities = database.getActivitiesForThread(owner.id)
        expect(activities[0]?.subagents).toEqual([
          expect.objectContaining({ id: call.id, status: expectedCallStatus })
        ])
        expect(activities[0]?.models).toContainEqual(expect.objectContaining({
          id: modelId,
          subagentId: call.id,
          status: 'completed',
          completedAt: expect.any(String)
        }))
        const tool = activities[0]?.tools.find((activity) => activity.call.id === toolId)
        expect(tool).toMatchObject({
          subagentId: call.id,
          status: 'completed',
          completedAt: expect.any(String)
        })
        expect(tool).not.toHaveProperty('approval')

        const recoveredState = {
          call: recoveredCall,
          activities,
          parentRun: database.getRun(parentRun.id),
          childRun: database.getRun(call.childRunId)
        }
        database.close()
        database = undefined

        database = AgentDatabase.open(databasePath, attachmentsPath)
        expect({
          call: database.getSubagentCall(call.id, owner.id),
          activities: database.getActivitiesForThread(owner.id),
          parentRun: database.getRun(parentRun.id),
          childRun: database.getRun(call.childRunId)
        }).toEqual(recoveredState)
      } finally {
        database?.close()
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it('hydrates nested ancestor projections from the canonical subagent call', () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const owner = database.createThread({ title: 'Canonical nested projection owner' })
      const rootRun = database.createRun(owner.id, 'canonical-nested-root-run')
      const first = database.createSubagentCall({
        id: '41000000-0000-8000-8000-000000000001',
        ownerThreadId: owner.id,
        parentThreadId: owner.id,
        parentRunId: rootRun.id,
        childThreadId: '51000000-0000-8000-8000-000000000001',
        childRunId: '61000000-0000-8000-8000-000000000001',
        config: subagentConfig('first'),
        description: 'Create a nested child.',
        childThread: { title: 'First hidden child', projectId: owner.projectId }
      })
      const second = database.createSubagentCall({
        id: '42000000-0000-8000-8000-000000000001',
        ownerThreadId: owner.id,
        parentThreadId: first.childThreadId,
        parentRunId: first.childRunId,
        parentSubagentId: first.id,
        childThreadId: '52000000-0000-8000-8000-000000000001',
        childRunId: '62000000-0000-8000-8000-000000000001',
        config: subagentConfig('second'),
        description: 'Create a grandchild.',
        childThread: { title: 'Second hidden child', projectId: owner.projectId }
      })
      const third = database.createSubagentCall({
        id: '43000000-0000-8000-8000-000000000001',
        ownerThreadId: owner.id,
        parentThreadId: second.childThreadId,
        parentRunId: second.childRunId,
        parentSubagentId: second.id,
        childThreadId: '53000000-0000-8000-8000-000000000001',
        childRunId: '63000000-0000-8000-8000-000000000001',
        config: subagentConfig('third'),
        description: 'Remain visible in every ancestor.',
        childThread: { title: 'Third hidden child', projectId: owner.projectId }
      })
      database.recordSubagentActivity(
        rootRun.id,
        second.id,
        second.agentName,
        'running',
        first.id
      )
      database.recordSubagentActivity(
        rootRun.id,
        third.id,
        third.agentName,
        'running',
        second.id
      )
      database.finishSubagentCall({
        subagentId: third.id,
        ownerThreadId: owner.id,
        status: 'cancelled'
      })

      expect(database.getActivitiesForThread(owner.id)[0]?.subagents).toContainEqual(
        expect.objectContaining({
          id: third.id,
          parentSubagentId: second.id,
          status: 'cancelled',
          completedAt: expect.any(String)
        })
      )
    } finally {
      database.close()
    }
  })

  it('reconciles missing nested projections after reopening without rewriting existing order or timing', () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-subagent-projection-recovery-'))
    const databasePath = join(root, 'agent.sqlite')
    const attachmentRoot = join(root, 'attachments')
    let database: AgentDatabase | undefined = AgentDatabase.open(databasePath, attachmentRoot)
    try {
      const owner = database.createThread({ title: 'Nested projection recovery owner' })
      const rootRun = database.createRun(owner.id, 'nested-projection-root-run')
      const first = database.createSubagentCall({
        id: '41100000-0000-8000-8000-000000000001',
        ownerThreadId: owner.id,
        parentThreadId: owner.id,
        parentRunId: rootRun.id,
        childThreadId: '51100000-0000-8000-8000-000000000001',
        childRunId: '61100000-0000-8000-8000-000000000001',
        config: subagentConfig('first'),
        description: 'Create a nested child before the application stops.',
        childThread: { title: 'First hidden child', projectId: owner.projectId }
      })
      const second = database.createSubagentCall({
        id: '42100000-0000-8000-8000-000000000001',
        ownerThreadId: owner.id,
        parentThreadId: first.childThreadId,
        parentRunId: first.childRunId,
        parentSubagentId: first.id,
        childThreadId: '52100000-0000-8000-8000-000000000001',
        childRunId: '62100000-0000-8000-8000-000000000001',
        config: subagentConfig('second'),
        description: 'Reach the root projection before the application stops.',
        childThread: { title: 'Second hidden child', projectId: owner.projectId }
      })
      const third = database.createSubagentCall({
        id: '43100000-0000-8000-8000-000000000001',
        ownerThreadId: owner.id,
        parentThreadId: second.childThreadId,
        parentRunId: second.childRunId,
        parentSubagentId: second.id,
        childThreadId: '53100000-0000-8000-8000-000000000001',
        childRunId: '63100000-0000-8000-8000-000000000001',
        config: subagentConfig('third'),
        description: 'Stop before this activity reaches either ancestor.',
        childThread: { title: 'Third hidden child', projectId: owner.projectId }
      })
      const existingSecond = database.recordSubagentActivity(
        rootRun.id,
        second.id,
        second.agentName,
        'running',
        first.id
      )
      const raw = (database as unknown as { database: Database.Database }).database
      for (const projectedRunId of [rootRun.id, first.childRunId]) {
        raw.prepare(`
          DELETE FROM agent_activity_timing
          WHERE run_id = ? AND activity_key = ?
        `).run(projectedRunId, `subagent:${third.id}`)
        raw.prepare(`
          DELETE FROM agent_activities
          WHERE run_id = ? AND activity_key = ?
        `).run(projectedRunId, `subagent:${third.id}`)
      }
      const existingFirst = database.getActivitiesForThread(owner.id)[0]?.subagents
        .find((activity) => activity.id === first.id)
      const canonicalThirdBeforeRecovery = database
        .getActivitiesForThread(second.childThreadId)[0]?.subagents
        .find((activity) => activity.id === third.id)
      expect(existingFirst).toBeDefined()
      expect(canonicalThirdBeforeRecovery).toBeDefined()
      expect(database.getActivitiesForThread(owner.id)[0]?.subagents)
        .not.toContainEqual(expect.objectContaining({ id: third.id }))
      expect(database.getActivitiesForThread(first.childThreadId)[0]?.subagents)
        .not.toContainEqual(expect.objectContaining({ id: third.id }))
      database.close()
      database = undefined

      database = AgentDatabase.open(databasePath, attachmentRoot)
      const rootActivity = database.getActivitiesForThread(owner.id)[0]
      const firstChildActivity = database.getActivitiesForThread(first.childThreadId)[0]
      const secondChildActivity = database.getActivitiesForThread(second.childThreadId)[0]
      const preservedFirst = rootActivity?.subagents.find((activity) => activity.id === first.id)
      const preservedSecond = rootActivity?.subagents.find((activity) => activity.id === second.id)
      const projectedThirdAtRoot = rootActivity?.subagents.find(
        (activity) => activity.id === third.id
      )
      const projectedThirdAtFirst = firstChildActivity?.subagents.find(
        (activity) => activity.id === third.id
      )
      const canonicalThird = secondChildActivity?.subagents.find(
        (activity) => activity.id === third.id
      )

      expect(canonicalThird).toMatchObject({
        status: 'cancelled',
        completedAt: expect.any(String)
      })
      expect(preservedFirst).toMatchObject({
        sequence: existingFirst?.sequence,
        startedAt: existingFirst?.startedAt
      })
      expect(preservedSecond).toMatchObject({
        sequence: existingSecond.sequence,
        startedAt: existingSecond.startedAt
      })
      expect(projectedThirdAtRoot).toMatchObject({
        parentSubagentId: second.id,
        sequence: existingSecond.sequence + 1,
        status: 'cancelled',
        startedAt: canonicalThirdBeforeRecovery?.startedAt,
        completedAt: canonicalThird?.completedAt
      })
      expect(projectedThirdAtFirst).toMatchObject({
        parentSubagentId: second.id,
        status: 'cancelled',
        startedAt: canonicalThirdBeforeRecovery?.startedAt,
        completedAt: canonicalThird?.completedAt
      })

      const recoveredRootProjection = projectedThirdAtRoot
      const recoveredFirstProjection = projectedThirdAtFirst
      database.close()
      database = undefined
      database = AgentDatabase.open(databasePath, attachmentRoot)
      expect(database.getActivitiesForThread(owner.id)[0]?.subagents
        .find((activity) => activity.id === third.id)).toEqual(recoveredRootProjection)
      expect(database.getActivitiesForThread(first.childThreadId)[0]?.subagents
        .find((activity) => activity.id === third.id)).toEqual(recoveredFirstProjection)

      database.reconcileRootActivities(rootRun.id, { models: [], tools: [] })
      expect(database.getActivitiesForThread(owner.id)[0]?.subagents.map((activity) => activity.id))
        .toEqual([first.id, second.id, third.id])
      expect(database.getActivitiesForThread(owner.id)[0]?.subagents.find((activity) => activity.id === first.id))
        .toMatchObject({ sequence: existingFirst?.sequence, startedAt: existingFirst?.startedAt })

      database.reconcileRootActivities(rootRun.id, {
        models: [],
        tools: [{
          call: {
            id: 'replayed-first-start',
            name: 'start_subagent',
            args: { description: first.description, agent: first.agentName }
          },
          output: JSON.stringify({ subagent_id: first.id }),
          subagentId: first.id,
          subagentName: first.agentName
        }]
      })
      expect(database.getActivitiesForThread(owner.id)[0]?.subagents.map((activity) => activity.id))
        .toEqual([first.id, second.id, third.id])
    } finally {
      database?.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('atomically persists descendant model and tool activities through every ancestor', () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const owner = database.createThread({ title: 'Atomic descendant projection owner' })
      const rootRun = database.createRun(owner.id, 'atomic-descendant-root-run')
      const first = database.createSubagentCall({
        id: '44100000-0000-8000-8000-000000000001',
        ownerThreadId: owner.id,
        parentThreadId: owner.id,
        parentRunId: rootRun.id,
        childThreadId: '54100000-0000-8000-8000-000000000001',
        childRunId: '64100000-0000-8000-8000-000000000001',
        config: subagentConfig('first'),
        description: 'Own the descendant projection.',
        childThread: { title: 'First projection child', projectId: owner.projectId }
      })
      const second = database.createSubagentCall({
        id: '45100000-0000-8000-8000-000000000001',
        ownerThreadId: owner.id,
        parentThreadId: first.childThreadId,
        parentRunId: first.childRunId,
        parentSubagentId: first.id,
        childThreadId: '55100000-0000-8000-8000-000000000001',
        childRunId: '65100000-0000-8000-8000-000000000001',
        config: subagentConfig('second'),
        description: 'Emit an activity before its in-memory event reaches the root.',
        childThread: { title: 'Second projection child', projectId: owner.projectId }
      })
      const toolCall = {
        id: 'atomic-descendant-tool',
        name: 'read_file',
        args: { path: 'README.md' }
      }
      const raw = (database as unknown as { database: Database.Database }).database
      raw.exec(`
        CREATE TRIGGER reject_atomic_descendant_root_tool
        BEFORE INSERT ON agent_activities
        WHEN NEW.run_id = '${rootRun.id}'
          AND NEW.activity_key = 'tool:${second.id}:${toolCall.id}'
        BEGIN
          SELECT RAISE(ABORT, 'injected ancestor projection failure');
        END;
      `)

      expect(() => database.recordProjectedToolActivity(
        second.id,
        owner.id,
        toolCall,
        'completed',
        second.id,
        'tool output'
      )).toThrow('injected ancestor projection failure')
      expect(database.getActivitiesForThread(first.childThreadId)[0]?.tools)
        .not.toContainEqual(expect.objectContaining({ call: expect.objectContaining({ id: toolCall.id }) }))
      expect(database.getActivitiesForThread(owner.id)[0]?.tools)
        .not.toContainEqual(expect.objectContaining({ call: expect.objectContaining({ id: toolCall.id }) }))

      raw.exec('DROP TRIGGER reject_atomic_descendant_root_tool')
      database.recordProjectedModelActivity(second.id, owner.id, {
        id: 'atomic-descendant-model',
        subagentId: second.id,
        status: 'completed',
        text: 'Nested model output',
        reasoning: '',
        toolCallIds: [toolCall.id]
      })
      database.recordProjectedToolActivity(
        second.id,
        owner.id,
        toolCall,
        'completed',
        second.id,
        'tool output'
      )

      for (const activity of [
        database.getActivitiesForThread(first.childThreadId)[0],
        database.getActivitiesForThread(owner.id)[0]
      ]) {
        expect(activity?.models).toContainEqual(expect.objectContaining({
          id: 'atomic-descendant-model',
          subagentId: second.id,
          status: 'completed'
        }))
        expect(activity?.tools).toContainEqual(expect.objectContaining({
          call: expect.objectContaining({ id: toolCall.id }),
          subagentId: second.id,
          status: 'completed',
          output: 'tool output'
        }))
      }
    } finally {
      database.close()
    }
  })

  it('persists a descendant tool approval through every ancestor across reopening', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-subagent-approval-projection-'))
    const databasePath = join(root, 'agent.sqlite')
    const attachmentRoot = join(root, 'attachments')
    let database: AgentDatabase | undefined = AgentDatabase.open(databasePath, attachmentRoot)
    try {
      const owner = database.createThread({ title: 'Projected descendant approval owner' })
      const rootRun = database.createRun(owner.id, 'projected-approval-root-run')
      const first = database.createSubagentCall({
        id: '46100000-0000-8000-8000-000000000001',
        ownerThreadId: owner.id,
        parentThreadId: owner.id,
        parentRunId: rootRun.id,
        childThreadId: '56100000-0000-8000-8000-000000000001',
        childRunId: '66100000-0000-8000-8000-000000000001',
        config: subagentConfig('first'),
        description: 'Own a child that requests approval.',
        childThread: { title: 'First approval child', projectId: owner.projectId }
      })
      const second = database.createSubagentCall({
        id: '47100000-0000-8000-8000-000000000001',
        ownerThreadId: owner.id,
        parentThreadId: first.childThreadId,
        parentRunId: first.childRunId,
        parentSubagentId: first.id,
        childThreadId: '57100000-0000-8000-8000-000000000001',
        childRunId: '67100000-0000-8000-8000-000000000001',
        config: subagentConfig('second'),
        description: 'Request approval below the root conversation.',
        childThread: { title: 'Second approval child', projectId: owner.projectId }
      })
      const call = {
        id: 'projected-descendant-approval-tool',
        name: 'pwsh',
        args: { command: 'Remove-Item example.txt' }
      }
      const approval = {
        status: 'pending_approval' as const,
        interruptId: 'projected-descendant-approval',
        actionIndex: 0
      }
      const raw = (database as unknown as { database: Database.Database }).database
      raw.exec(`
        CREATE TRIGGER reject_projected_descendant_root_approval
        BEFORE INSERT ON agent_tool_approvals
        WHEN NEW.run_id = '${rootRun.id}'
          AND NEW.activity_key = 'tool:${second.id}:${call.id}'
        BEGIN
          SELECT RAISE(ABORT, 'injected ancestor approval failure');
        END;
      `)
      expect(() => database?.recordProjectedToolApproval(
        second.id,
        owner.id,
        call,
        approval,
        second.id
      )).toThrow('injected ancestor approval failure')
      for (const activity of [
        database.getActivitiesForThread(first.childThreadId)[0],
        database.getActivitiesForThread(owner.id)[0]
      ]) {
        expect(activity?.tools).not.toContainEqual(expect.objectContaining({ call }))
      }
      raw.exec('DROP TRIGGER reject_projected_descendant_root_approval')
      database.recordProjectedToolApproval(second.id, owner.id, call, approval, second.id)

      await putRootCheckpoint(database, owner.id, 'projected-approval-root-checkpoint', {
        anasRunLifecycle: { runId: rootRun.id, status: 'running' }
      })
      await putRootCheckpoint(database, first.childThreadId, 'projected-approval-parent-checkpoint', {
        anasRunLifecycle: { runId: first.childRunId, status: 'running' }
      })
      await putRootCheckpoint(database, second.childThreadId, 'projected-approval-child-checkpoint', {
        messages:[new AIMessage({id:'approval-model',content:'',tool_calls:[call]})],
        anasRunLifecycle: { runId: second.childRunId, status: 'running' }
      })

      for (const activity of [
        database.getActivitiesForThread(first.childThreadId)[0],
        database.getActivitiesForThread(owner.id)[0]
      ]) {
        expect(activity?.tools).toContainEqual(expect.objectContaining({
          call,
          subagentId: second.id,
          status: 'running',
          approval
        }))
      }

      database.close()
      database = undefined
      database = AgentDatabase.open(databasePath, attachmentRoot)

      for (const activity of [
        database.getActivitiesForThread(first.childThreadId)[0],
        database.getActivitiesForThread(owner.id)[0]
      ]) {
        expect(activity?.tools).toContainEqual(expect.objectContaining({
          call,
          subagentId: second.id,
          status: 'running',
          approval
        }))
      }
    } finally {
      database?.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('atomically settles only one terminal subagent projections through every ancestor', () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const owner = database.createThread({ title: 'Terminal projection settlement owner' })
      const rootRun = database.createRun(owner.id, 'terminal-projection-settlement-root')
      const parent = database.createSubagentCall({
        id: '48100000-0000-8000-8000-000000000001',
        ownerThreadId: owner.id,
        parentThreadId: owner.id,
        parentRunId: rootRun.id,
        childThreadId: '58100000-0000-8000-8000-000000000001',
        childRunId: '68100000-0000-8000-8000-000000000001',
        config: subagentConfig('parent'),
        description: 'Own a terminal descendant and a live sibling.',
        childThread: { title: 'Projection parent', projectId: owner.projectId }
      })
      const child = database.createSubagentCall({
        id: '48200000-0000-8000-8000-000000000001',
        ownerThreadId: owner.id,
        parentThreadId: parent.childThreadId,
        parentRunId: parent.childRunId,
        parentSubagentId: parent.id,
        childThreadId: '58200000-0000-8000-8000-000000000001',
        childRunId: '68200000-0000-8000-8000-000000000001',
        config: subagentConfig('child'),
        description: 'Stop with partial projected work.',
        childThread: { title: 'Projection child', projectId: owner.projectId }
      })
      const sibling = database.createSubagentCall({
        id: '48300000-0000-8000-8000-000000000001',
        ownerThreadId: owner.id,
        parentThreadId: owner.id,
        parentRunId: rootRun.id,
        childThreadId: '58300000-0000-8000-8000-000000000001',
        childRunId: '68300000-0000-8000-8000-000000000001',
        config: subagentConfig('sibling'),
        description: 'Remain active beside the terminal descendant.',
        childThread: { title: 'Projection sibling', projectId: owner.projectId }
      })
      database.recordProjectedModelActivity(child.id, owner.id, {
        id: 'terminal-child-model',
        subagentId: child.id,
        status: 'running',
        text: '',
        reasoning: 'Partial child reasoning',
        toolCallIds: ['terminal-child-tool']
      })
      database.recordProjectedToolApproval(child.id, owner.id, {
        id: 'terminal-child-tool',
        name: 'apply_patch',
        args: { path: 'child.txt', content: 'partial' }
      }, {
        status: 'pending_approval',
        interruptId: 'terminal-child-approval',
        actionIndex: 0
      }, child.id)
      database.recordProjectedModelActivity(sibling.id, owner.id, {
        id: 'live-sibling-model',
        subagentId: sibling.id,
        status: 'running',
        text: 'Sibling still working',
        reasoning: '',
        toolCallIds: ['live-sibling-tool']
      })
      database.recordProjectedToolApproval(sibling.id, owner.id, {
        id: 'live-sibling-tool',
        name: 'pwsh',
        args: { command: 'Start-Sleep 30' }
      }, {
        status: 'pending_approval',
        interruptId: 'live-sibling-approval',
        actionIndex: 0
      }, sibling.id)

      const raw = (database as unknown as { database: Database.Database }).database
      raw.exec(`
        CREATE TRIGGER reject_terminal_projection_settlement
        BEFORE UPDATE OF status ON agent_activities
        WHEN OLD.parent_subagent_id = '${child.id}'
          AND NEW.status = 'completed'
        BEGIN
          SELECT RAISE(ABORT, 'injected terminal projection settlement failure');
        END;
      `)
      expect(() => database.finishSubagentCall({
        subagentId: child.id,
        ownerThreadId: owner.id,
        status: 'failed',
        error: 'Child failed.'
      })).toThrow('injected terminal projection settlement failure')
      expect(database.getSubagentCall(child.id, owner.id)?.status).toBe('running')
      for (const activity of [
        database.getActivitiesForThread(parent.childThreadId)[0],
        database.getActivitiesForThread(owner.id)[0]
      ]) {
        expect(activity?.models.find((model) => model.id === 'terminal-child-model')?.status)
          .toBe('running')
        expect(activity?.tools.find((tool) => tool.call.id === 'terminal-child-tool'))
          .toMatchObject({ status: 'running', approval: { interruptId: 'terminal-child-approval' } })
      }
      raw.exec('DROP TRIGGER reject_terminal_projection_settlement')

      const transition = database.finishSubagentCall({
        subagentId: child.id,
        ownerThreadId: owner.id,
        status: 'failed',
        error: 'Child failed.'
      })
      expect(transition?.call).toMatchObject({ status: 'failed', error: 'Child failed.' })
      const settledAt = transition?.activity.completedAt
      expect(settledAt).toEqual(expect.any(String))
      for (const activity of [
        database.getActivitiesForThread(parent.childThreadId)[0],
        database.getActivitiesForThread(owner.id)[0]
      ]) {
        expect(activity?.models.find((model) => model.id === 'terminal-child-model'))
          .toMatchObject({
            status: 'completed',
            text: '',
            completedAt: settledAt
          })
        const childTool = activity?.tools.find((tool) => tool.call.id === 'terminal-child-tool')
        expect(childTool).toMatchObject({ status: 'completed', completedAt: settledAt })
        expect(childTool).not.toHaveProperty('approval')
      }
      const rootActivity = database.getActivitiesForThread(owner.id)[0]
      expect(rootActivity?.models.find((model) => model.id === 'live-sibling-model')?.status)
        .toBe('running')
      expect(rootActivity?.tools.find((tool) => tool.call.id === 'live-sibling-tool'))
        .toMatchObject({ status: 'running', approval: { interruptId: 'live-sibling-approval' } })

      const settledRoot = database.getActivitiesForThread(owner.id)[0]
      expect(database.finishSubagentCall({
        subagentId: child.id,
        ownerThreadId: owner.id,
        status: 'cancelled'
      })).toBeUndefined()
      expect(database.getActivitiesForThread(owner.id)[0]).toEqual(settledRoot)
    } finally {
      database.close()
    }
  })

  it('rejects a foreign-key-valid backup whose subagent owns a visible conversation', () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-subagent-integrity-'))
    const databasePath = join(root, 'agent.sqlite')
    const attachmentRoot = join(root, 'attachments')
    let database: AgentDatabase | undefined = AgentDatabase.open(databasePath, attachmentRoot)
    try {
      const owner = database.createThread({ title: 'Integrity owner' })
      const parentRun = database.createRun(owner.id, 'integrity-parent-run')
      const call = database.createSubagentCall({
        id: '44000000-0000-8000-8000-000000000001',
        ownerThreadId: owner.id,
        parentThreadId: owner.id,
        parentRunId: parentRun.id,
        childThreadId: '54000000-0000-8000-8000-000000000001',
        childRunId: '64000000-0000-8000-8000-000000000001',
        config: subagentConfig('reviewer'),
        description: 'Must remain attached to a hidden conversation.',
        childThread: { title: 'Expected hidden child', projectId: owner.projectId }
      })
      const unrelated = database.createThread({ title: 'Unrelated visible conversation' })
      const unrelatedRun = database.createRun(unrelated.id, 'unrelated-visible-run')
      const raw = (database as unknown as { database: Database.Database }).database
      raw.prepare(`
        UPDATE agent_subagent_calls
        SET child_thread_id = ?, child_run_id = ?
        WHERE id = ?
      `).run(unrelated.id, unrelatedRun.id, call.id)
      database.close()
      database = undefined

      expect(() => AgentDatabase.validateBackup(
        databasePath,
        attachmentRoot,
        new Set([owner.projectId])
      )).toThrow('invalid conversation relationship')
      expect(() => AgentDatabase.open(databasePath, attachmentRoot)).toThrow(
        'invalid conversation relationship'
      )
    } finally {
      database?.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('updates a subagent call and its parent activity in one transition', () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const owner = database.createThread({ title: 'Owner' })
      const parentRun = database.createRun(owner.id, 'transition-parent-run')
      const call = database.createSubagentCall({
        id: '70000000-0000-8000-8000-000000000001',
        ownerThreadId: owner.id,
        parentThreadId: owner.id,
        parentRunId: parentRun.id,
        childThreadId: '80000000-0000-8000-8000-000000000001',
        childRunId: '90000000-0000-8000-8000-000000000001',
        config: subagentConfig('reviewer'),
        description: 'Fail atomically.',
        childThread: { title: 'Hidden reviewer' }
      })

      const recovery = database.recordSubagentRecoveryFailure(
        call.id,
        owner.id,
        'Temporary recovery failure.'
      )
      expect(recovery).toBeDefined()
      expect(recovery?.call).toMatchObject({
        status: 'running',
        error: 'Temporary recovery failure.'
      })
      expect(recovery?.activity).toMatchObject({
        status: 'running',
        error: 'Temporary recovery failure.'
      })
      expect(database.recordSubagentRecoveryFailure(
        call.id,
        owner.id,
        'Temporary recovery failure.'
      )).toBeUndefined()

      const recovered = database.markSubagentCallRunning(call.id, owner.id)
      expect(recovered?.call.status).toBe('running')
      expect(recovered?.call.error).toBeUndefined()
      expect(database.markSubagentCallRunning(call.id, owner.id)).toBeUndefined()
      expect(database.markSubagentCallInterrupted(call.id, owner.id)?.call.status).toBe('interrupted')
      expect(database.markSubagentCallInterrupted(call.id, owner.id)).toBeUndefined()
      expect(database.markSubagentCallRunning(call.id, owner.id)?.call.status).toBe('running')

      const transition = database.finishSubagentCall({
        subagentId: call.id,
        ownerThreadId: owner.id,
        status: 'failed',
        error: 'Permanent failure.'
      })
      expect(transition).toBeDefined()
      expect(transition?.call).toMatchObject({ status: 'failed', error: 'Permanent failure.' })
      expect(transition?.activity).toMatchObject({ status: 'failed', error: 'Permanent failure.' })
      expect(database.finishSubagentCall({
        subagentId: call.id,
        ownerThreadId: owner.id,
        status: 'failed',
        error: 'Permanent failure.'
      })).toBeUndefined()
      expect(database.recordSubagentRecoveryFailure(
        call.id,
        owner.id,
        'Late recovery failure.'
      )).toBeUndefined()
      expect(database.getActivitiesForThread(owner.id)[0]?.subagents).toEqual([
        expect.objectContaining({
          id: call.id,
          status: 'failed',
          error: 'Permanent failure.'
        })
      ])
    } finally {
      database.close()
    }
  })

  it('rolls back run resume when the matching subagent activity cannot transition', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const owner = database.createThread({ title: 'Owner' })
      const parentRun = database.createRun(owner.id, 'resume-parent-run')
      const call = database.createSubagentCall({
        id: '71000000-0000-8000-8000-000000000001',
        ownerThreadId: owner.id,
        parentThreadId: owner.id,
        parentRunId: parentRun.id,
        childThreadId: '81000000-0000-8000-8000-000000000001',
        childRunId: '91000000-0000-8000-8000-000000000001',
        config: subagentConfig('reviewer'),
        description: 'Resume atomically.',
        childThread: { title: 'Hidden reviewer' }
      })
      const interruptId = `${call.childRunId}-interrupt`
      await markRunInterrupted(database, call.childThreadId, call.childRunId, interruptId)
      database.finishRun(call.childRunId, 'interrupted')
      database.markSubagentCallInterrupted(call.id, owner.id)
      const raw = (database as unknown as { database: Database.Database }).database
      raw.exec(`
        CREATE TRIGGER reject_subagent_activity_resume
        BEFORE UPDATE ON agent_activities
        WHEN OLD.activity_id = '${call.id}'
          AND json_extract(NEW.output_json, '$.status') = 'running'
        BEGIN
          SELECT RAISE(ABORT, 'injected subagent activity resume failure');
        END;
      `)

      expect(() => database.resumeSubagentRun({
        subagentId: call.id,
        ownerThreadId: owner.id,
        childRunId: call.childRunId,
        entries: [{
          interruptId,
          response: { decisions: [{ type: 'approve' }] }
        }]
      })).toThrow('injected subagent activity resume failure')

      expect(database.getRun(call.childRunId)?.status).toBe('interrupted')
      expect(database.getRunResumeIntent(call.childRunId)).toBeUndefined()
      expect(database.getSubagentCall(call.id, owner.id)?.status).toBe('interrupted')
      expect(database.getActivitiesForThread(owner.id)[0]?.subagents).toEqual([
        expect.objectContaining({ id: call.id, status: 'interrupted' })
      ])
    } finally {
      database.close()
    }
  })

  it('arms subagent creation only after deterministic database validation succeeds', () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const owner = database.createThread({ title: 'Owner' })
      const parentRun = database.createRun(owner.id, 'effect-parent-run')
      const childThreadId = 'a0000000-0000-8000-8000-000000000001'
      database.createThread({}, childThreadId)
      const armEffect = vi.fn()

      expect(() => database.createSubagentCall({
        id: 'b0000000-0000-8000-8000-000000000001',
        ownerThreadId: owner.id,
        parentThreadId: owner.id,
        parentRunId: parentRun.id,
        childThreadId,
        childRunId: 'c0000000-0000-8000-8000-000000000001',
        config: subagentConfig('reviewer'),
        description: 'Must fail before arming.',
        childThread: { title: 'Duplicate hidden thread' }
      }, armEffect)).toThrow(`Thread ${childThreadId} already exists.`)
      expect(armEffect).not.toHaveBeenCalled()

      database.createSubagentCall({
        id: 'd0000000-0000-8000-8000-000000000001',
        ownerThreadId: owner.id,
        parentThreadId: owner.id,
        parentRunId: parentRun.id,
        childThreadId: 'e0000000-0000-8000-8000-000000000001',
        childRunId: 'f0000000-0000-8000-8000-000000000001',
        config: subagentConfig('reviewer'),
        description: 'Arm exactly once.',
        childThread: { title: 'Valid hidden thread' }
      }, armEffect)
      expect(armEffect).toHaveBeenCalledOnce()
    } finally {
      database.close()
    }
  })

  it('arms run cancellation only when the requested transition can commit', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread({ title: 'Cancellation effect boundary' })
      const fresh = database.createRun(thread.id, 'fresh-cancel-run')
      const armFresh = vi.fn()
      expect(database.cancelRecoverableRun(fresh.id, armFresh)).toBe(false)
      expect(armFresh).not.toHaveBeenCalled()

      await putRootCheckpoint(database, thread.id, 'recoverable-cancel-checkpoint', {
        anasRunLifecycle: { runId: fresh.id, status: 'running' }
      })
      const armRecoverable = vi.fn()
      expect(database.cancelRecoverableRun(fresh.id, armRecoverable)).toBe(true)
      expect(armRecoverable).toHaveBeenCalledOnce()

      const completed = database.createRun(thread.id, 'terminal-cancel-run')
      await markRunCompleted(database, thread.id, completed.id)
      const armTerminal = vi.fn()
      expect(database.requestRunCancellation(completed.id, armTerminal)).toBe(false)
      expect(armTerminal).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })
})
