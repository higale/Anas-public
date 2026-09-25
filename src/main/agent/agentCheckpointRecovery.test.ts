import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Annotation, Command, interrupt, StateGraph } from '@langchain/langgraph'
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentDatabase } from './agentDatabase'
import type { AgentRunLifecycleState } from './runLifecycleMiddleware'

const roots: string[] = []

function temporaryDatabase(): { file: string; attachments: string } {
  const root = mkdtempSync(join(tmpdir(), 'anas-checkpoint-recovery-'))
  roots.push(root)
  return {
    file: join(root, 'agent.sqlite'),
    attachments: join(root, 'attachments')
  }
}

function checkpoint(
  id: string,
  lifecycle?: AgentRunLifecycleState
): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date().toISOString(),
    channel_values: lifecycle ? { anasRunLifecycle: lifecycle } : {},
    channel_versions: {},
    versions_seen: {}
  }
}

const checkpointMetadata: CheckpointMetadata = {
  source: 'loop',
  step: 1,
  parents: {}
}

async function putCheckpoint(
  database: AgentDatabase,
  threadId: string,
  id: string,
  lifecycle?: AgentRunLifecycleState,
  checkpointNamespace = ''
): Promise<void> {
  await database.checkpointer.put({
    configurable: {
      thread_id: threadId,
      checkpoint_ns: checkpointNamespace
    }
  }, checkpoint(id, lifecycle), checkpointMetadata)
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

describe('Agent checkpoint recovery protocol', () => {
  it('accepts a completed marker only from the matching root run lifecycle', async () => {
    const location = temporaryDatabase()
    const database = AgentDatabase.open(location.file, location.attachments)
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'matching-run')

      await putCheckpoint(database, thread.id, 'checkpoint-child', {
        runId: run.id,
        status: 'completed'
      }, 'child:task')
      expect(database.getRunCheckpointState(run.id)).toMatchObject({

        lastCommittedCheckpointId: undefined,
        terminalCheckpointId: undefined
      })

      await putCheckpoint(database, thread.id, 'checkpoint-wrong-run', {
        runId: 'another-run',
        status: 'completed'
      })
      expect(database.getRunCheckpointState(run.id)).toMatchObject({
        lastCommittedCheckpointId: 'checkpoint-wrong-run',
        terminalCheckpointId: undefined
      })

      await putCheckpoint(database, thread.id, 'checkpoint-matching-run', {
        runId: run.id,
        status: 'completed'
      })
      expect(database.getRunCheckpointState(run.id)).toMatchObject({
        lastCommittedCheckpointId: 'checkpoint-matching-run',
        terminalCheckpointId: 'checkpoint-matching-run'
      })

      await putCheckpoint(database, thread.id, 'checkpoint-after-terminal', {
        runId: run.id,
        status: 'running'
      })
      expect(database.getRunCheckpointState(run.id)).toMatchObject({
        lastCommittedCheckpointId: 'checkpoint-after-terminal',
        terminalCheckpointId: 'checkpoint-matching-run'
      })
      expect(() => database.finishRun(run.id, 'completed')).toThrow(
        'no durable completed lifecycle checkpoint'
      )
      expect(database.listRecoverableRuns().map((candidate) => candidate.id)).toEqual([run.id])
    } finally {
      database.close()
    }
  })

  it('treats a durable terminal checkpoint as newer than cancellation', async () => {
    const location = temporaryDatabase()
    let database = AgentDatabase.open(location.file, location.attachments)
    const terminalFirstThread = database.createThread({ title: 'terminal first' })
    const terminalFirstRun = database.createRun(terminalFirstThread.id, 'terminal-first-run')
    await putCheckpoint(database, terminalFirstThread.id, 'terminal-first-checkpoint', {
      runId: terminalFirstRun.id,
      status: 'completed'
    })
    expect(database.requestRunCancellation(terminalFirstRun.id)).toBe(false)
    expect(database.getRunCheckpointState(terminalFirstRun.id).cancellationRequested).toBe(false)
    expect(() => database.finishRun(terminalFirstRun.id, 'cancelled')).toThrow(
      'already has a durable completed lifecycle checkpoint'
    )
    database.finishRun(terminalFirstRun.id, 'completed')

    const cancellationFirstThread = database.createThread({ title: 'cancellation first' })
    const cancellationFirstRun = database.createRun(
      cancellationFirstThread.id,
      'cancellation-first-run'
    )
    expect(database.requestRunCancellation(cancellationFirstRun.id)).toBe(true)
    expect(database.getRunCheckpointState(cancellationFirstRun.id).cancellationRequested).toBe(true)
    await putCheckpoint(database, cancellationFirstThread.id, 'cancellation-first-checkpoint', {
      runId: cancellationFirstRun.id,
      status: 'completed'
    })
    expect(database.getRunCheckpointState(cancellationFirstRun.id)).toMatchObject({
      terminalCheckpointId: 'cancellation-first-checkpoint',
      lastCommittedCheckpointId: 'cancellation-first-checkpoint',
      cancellationRequested: false
    })
    database.close()

    database = AgentDatabase.open(location.file, location.attachments)
    try {
      expect(database.getRun(terminalFirstRun.id)?.status).toBe('completed')
      expect(database.getRun(cancellationFirstRun.id)?.status).toBe('completed')
      expect(database.getThread(cancellationFirstThread.id)?.status).toBe('idle')
    } finally {
      database.close()
    }
  })

  it('classifies durable terminal, interrupt, cancellation, empty, and recoverable runs on restart', async () => {
    const location = temporaryDatabase()
    let database = AgentDatabase.open(location.file, location.attachments)
    const completedThread = database.createThread({ title: 'completed' })
    const completedRun = database.createRun(completedThread.id, 'completed-run')
    database.recordModelActivity(completedRun.id, {
      id: 'completed-model',
      status: 'running',
      text: 'Persisted answer',
      reasoning: '',
      toolCallIds: []
    })
    await putCheckpoint(database, completedThread.id, 'completed-checkpoint', {
      runId: completedRun.id,
      status: 'completed'
    })
    database.recordContextSummaryStarted(completedRun.id, 'completed-staged-summary')
    database.stageContextSummary(completedRun.id, 'completed-staged-summary', {
      summaryText: 'Preserve until the terminal checkpoint is reconciled.'
    })

    const interruptedThread = database.createThread({ title: 'interrupted' })
    const interruptedRun = database.createRun(interruptedThread.id, 'interrupted-run')
    database.recordModelActivity(interruptedRun.id, {
      id: 'interrupted-model',
      status: 'running',
      text: '',
      reasoning: '',
      toolCallIds: []
    })
    await putCheckpoint(database, interruptedThread.id, 'interrupted-root', {
      runId: interruptedRun.id,
      status: 'running'
    })
    await database.checkpointer.putWrites({
      configurable: {
        thread_id: interruptedThread.id,
        checkpoint_ns: '',
        checkpoint_id: 'interrupted-root'
      }
    }, [['__interrupt__', [{ id: 'approval-1', value: { actionRequests: [] } }]]], 'approval-task')
    database.recordContextSummaryStarted(interruptedRun.id, 'interrupted-staged-summary')
    database.stageContextSummary(interruptedRun.id, 'interrupted-staged-summary', {
      summaryText: 'Preserve while approval is pending.'
    })

    const childOnlyThread = database.createThread({ title: 'child-only interrupt' })
    const childOnlyRun = database.createRun(childOnlyThread.id, 'child-only-interrupt-run')
    await putCheckpoint(database, childOnlyThread.id, 'child-only-root', {
      runId: childOnlyRun.id,
      status: 'running'
    })
    await putCheckpoint(
      database,
      childOnlyThread.id,
      'child-only-checkpoint',
      undefined,
      'child:approval'
    )
    await database.checkpointer.putWrites({
      configurable: {
        thread_id: childOnlyThread.id,
        checkpoint_ns: 'child:approval',
        checkpoint_id: 'child-only-checkpoint'
      }
    }, [['__interrupt__', [{ id: 'child-approval', value: {} }]]], 'child-approval-task')

    const cancelledThread = database.createThread({ title: 'cancelled' })
    const cancelledRun = database.createRun(cancelledThread.id, 'cancelled-run')
    database.requestRunCancellation(cancelledRun.id)
    await putCheckpoint(database, cancelledThread.id, 'cancelled-checkpoint', {
      runId: cancelledRun.id,
      status: 'running'
    })
    database.recordContextSummaryStarted(cancelledRun.id, 'cancelled-staged-summary')
    database.stageContextSummary(cancelledRun.id, 'cancelled-staged-summary', {
      summaryText: 'Discard after persisted cancellation.'
    })

    const emptyThread = database.createThread({ title: 'empty' })
    const emptyRun = database.createRun(emptyThread.id, 'empty-run')
    database.recordContextSummaryStarted(emptyRun.id, 'empty-staged-summary')
    database.stageContextSummary(emptyRun.id, 'empty-staged-summary', {
      summaryText: 'Discard when no durable framework progress exists.'
    })

    const recoverableThread = database.createThread({ title: 'recoverable' })
    const recoverableRun = database.createRun(recoverableThread.id, 'recoverable-run')
    database.recordModelActivity(recoverableRun.id, {
      id: 'recoverable-model',
      status: 'running',
      text: 'Partial trace',
      reasoning: '',
      toolCallIds: []
    })
    await putCheckpoint(database, recoverableThread.id, 'recoverable-checkpoint-1-terminal', {
      runId: recoverableRun.id,
      status: 'completed'
    })
    await putCheckpoint(database, recoverableThread.id, 'recoverable-checkpoint-2-running', {
      runId: recoverableRun.id,
      status: 'running'
    })
    database.recordContextSummaryStarted(recoverableRun.id, 'recoverable-staged-summary')
    database.stageContextSummary(recoverableRun.id, 'recoverable-staged-summary', {
      summaryText: 'Preserve until framework recovery reaches a boundary.'
    })

    const writeOnlyThread = database.createThread({ title: 'write-only recovery' })
    await putCheckpoint(database, writeOnlyThread.id, 'write-only-pre')
    const writeOnlyRun = database.createRun(writeOnlyThread.id, 'write-only-run')
    await database.checkpointer.putWrites({
      configurable: {
        thread_id: writeOnlyThread.id,
        checkpoint_ns: '',
        checkpoint_id: 'write-only-pre'
      }
    }, [['messages', { durable: 'input-before-checkpoint' }]], 'write-only-task')
    expect(database.getRunCheckpointState(writeOnlyRun.id)).toMatchObject({
      lastWriteCheckpointId: 'write-only-pre'
    })
    database.close()

    database = AgentDatabase.open(location.file, location.attachments)
    try {
      expect(database.getRun(completedRun.id)?.status).toBe('completed')
      expect(database.getThread(completedThread.id)?.status).toBe('idle')
      expect(database.getActivitiesForThread(completedThread.id)[0].models).toEqual([])
      expect(database.getActivitiesForThread(completedThread.id)[0].summaries ?? []).toEqual([])

      expect(database.getRun(interruptedRun.id)?.status).toBe('running')
      expect(database.getThread(interruptedThread.id)?.status).toBe('running')
      expect(database.getRunCheckpointState(interruptedRun.id)).toMatchObject({
        lastWriteCheckpointNamespace: '',
        lastWriteCheckpointId: 'interrupted-root',
        terminalCheckpointId: undefined
      })
      expect(database.getActivitiesForThread(interruptedThread.id)[0].models[0].status).toBe('running')
      expect(database.getActivitiesForThread(interruptedThread.id)[0].summaries?.[0]).toMatchObject({
        id: 'interrupted-staged-summary',
        status: 'running'
      })

      expect(database.getRun(childOnlyRun.id)?.status).toBe('running')
      expect(database.getThread(childOnlyThread.id)?.status).toBe('running')
      expect(database.getRunCheckpointState(childOnlyRun.id)).toMatchObject({
        lastWriteCheckpointNamespace: 'child:approval',
        lastWriteCheckpointId: 'child-only-checkpoint',
        terminalCheckpointId: undefined
      })
      expect(() => database.finishRun(childOnlyRun.id, 'interrupted')).toThrow(
        'no durable root framework interrupt'
      )

      expect(database.getRun(cancelledRun.id)?.status).toBe('cancelled')
      expect(database.getThread(cancelledThread.id)?.status).toBe('idle')
      expect(database.getRunCheckpointState(cancelledRun.id)).toMatchObject({
        terminalCheckpointId: undefined,
        cancellationRequested: true
      })
      expect(database.getActivitiesForThread(cancelledThread.id)[0].summaries ?? []).toEqual([])

      expect(database.getRun(emptyRun.id)).toMatchObject({
        status: 'cancelled',
        error: 'Application stopped before the run reached a durable checkpoint.'
      })
      expect(database.getThread(emptyThread.id)?.status).toBe('idle')
      expect(database.getActivitiesForThread(emptyThread.id)[0].summaries ?? []).toEqual([])

      expect(database.getRun(recoverableRun.id)?.status).toBe('running')
      expect(database.getThread(recoverableThread.id)?.status).toBe('running')
      expect(database.getRunCheckpointState(recoverableRun.id)).toMatchObject({
        terminalCheckpointId: 'recoverable-checkpoint-1-terminal',
        lastCommittedCheckpointId: 'recoverable-checkpoint-2-running'
      })
      expect(database.getActivitiesForThread(recoverableThread.id)[0].models[0].status).toBe('running')
      expect(database.getActivitiesForThread(recoverableThread.id)[0].summaries?.[0]).toMatchObject({
        id: 'recoverable-staged-summary',
        status: 'running'
      })
      expect(database.getRun(writeOnlyRun.id)?.status).toBe('running')
      expect(database.getRunCheckpointState(writeOnlyRun.id)).toMatchObject({

        lastCommittedCheckpointId: undefined,
        lastWriteCheckpointId: 'write-only-pre'
      })
      expect(database.listRecoverableRuns().map((run) => run.id)).toEqual([
        interruptedRun.id,
        childOnlyRun.id,
        recoverableRun.id,
        writeOnlyRun.id
      ])
      expect(database.listFileEditCleanupRunIds()).toEqual([
        completedRun.id,
        cancelledRun.id,
        emptyRun.id
      ])
      database.acknowledgeFileEditCleanup(cancelledRun.id)
      expect(database.listFileEditCleanupRunIds()).toEqual([
        completedRun.id,
        emptyRun.id
      ])
    } finally {
      database.close()
    }

    // Startup reconciliation is idempotent: terminal runs remain terminal,
    // while provisional root/child interrupts and other durable work remain
    // framework-resumable until a full stream settles.
    database = AgentDatabase.open(location.file, location.attachments)
    try {
      expect(database.getRun(completedRun.id)?.status).toBe('completed')
      expect(database.getRun(interruptedRun.id)?.status).toBe('running')
      expect(database.getRun(cancelledRun.id)?.status).toBe('cancelled')
      expect(database.getRun(emptyRun.id)?.status).toBe('cancelled')
      expect(database.listRecoverableRuns().map((run) => run.id)).toEqual([
        interruptedRun.id,
        childOnlyRun.id,
        recoverableRun.id,
        writeOnlyRun.id
      ])
      expect(database.listFileEditCleanupRunIds()).toEqual([
        completedRun.id,
        emptyRun.id
      ])
    } finally {
      database.close()
    }
  })

  it('keeps an interrupt durable until the framework persists its resume decision', async () => {
    const location = temporaryDatabase()
    let database = AgentDatabase.open(location.file, location.attachments)
    const thread = database.createThread()
    const run = database.createRun(thread.id, 'resume-run')
    await putCheckpoint(database, thread.id, 'resume-checkpoint', {
      runId: run.id,
      status: 'running'
    })
    await database.checkpointer.putWrites({
      configurable: {
        thread_id: thread.id,
        checkpoint_ns: '',
        checkpoint_id: 'resume-checkpoint'
      }
    }, [['__interrupt__', [{ id: 'approval-resume', value: {} }]]], 'resume-task')
    database.finishRun(run.id, 'interrupted')

    const resumeIntent = {
      'approval-resume': { decisions: [{ type: 'approve' }] }
    }
    database.resumeRun(run.id, [{
      interruptId: 'approval-resume',
      response: resumeIntent['approval-resume']
    }])
    expect(database.getRunCheckpointState(run.id)).toMatchObject({
      terminalCheckpointId: undefined,
      lastCommittedCheckpointId: 'resume-checkpoint',
      cancellationRequested: false
    })
    database.close()

    // A process stop before LangGraph writes __resume__ preserves both the
    // interrupt and the user's durable resume command for automatic delivery.
    database = AgentDatabase.open(location.file, location.attachments)
    expect(database.getRun(run.id)?.status).toBe('running')
    expect(database.getRunCheckpointState(run.id)).toMatchObject({
      resumeIntent
    })
    expect(database.listRecoverableRuns().map((candidate) => candidate.id)).toEqual([run.id])

    // Resume acknowledgement must ignore unrelated non-JSON/BLOB writes in
    // the same checkpoint rather than attempting to feed them to json_each.
    await database.checkpointer.putWrites({
      configurable: {
        thread_id: thread.id,
        checkpoint_ns: '',
        checkpoint_id: 'resume-checkpoint'
      }
    }, [['binary-result', new Uint8Array([0xff, 0x00])]], 'binary-sibling-task')

    await database.checkpointer.putWrites({
      configurable: {
        thread_id: thread.id,
        checkpoint_ns: '',
        checkpoint_id: 'resume-checkpoint'
      }
    }, [['__resume__', [{ approve: true }]]], 'resume-task')
    expect(database.getRunCheckpointState(run.id)).toMatchObject({
      lastWriteCheckpointNamespace: '',
      lastWriteCheckpointId: 'resume-checkpoint',
      resumeIntent: undefined
    })
    database.close()

    // A task-level resume write acknowledges only that source task. Other
    // parallel tasks retain their own durable intent rows independently.
    database = AgentDatabase.open(location.file, location.attachments)
    expect(database.getRun(run.id)?.status).toBe('running')
    expect(database.getThread(thread.id)?.status).toBe('running')
    expect(database.listRecoverableRuns().map((candidate) => candidate.id)).toEqual([run.id])

    await putCheckpoint(database, thread.id, 'resume-advanced-checkpoint', {
      runId: run.id,
      status: 'running'
    })
    expect(database.getRunCheckpointState(run.id)).toMatchObject({
      lastCommittedCheckpointId: 'resume-advanced-checkpoint',
      resumeIntent: undefined
    })
    database.close()
  })

  it('classifies root task errors by their task-scoped handler evidence', async () => {
    const location = temporaryDatabase()
    let database = AgentDatabase.open(location.file, location.attachments)
    const createWrittenRun = async (
      id: string,
      writes: Array<{ taskId: string; values: Array<[string, unknown]> }>
    ) => {
      const thread = database.createThread({ title: id })
      const run = database.createRun(thread.id, id)
      const checkpointId = `${id}-checkpoint`
      await putCheckpoint(database, thread.id, checkpointId, {
        runId: run.id,
        status: 'running'
      })
      for (const write of writes) {
        await database.checkpointer.putWrites({
          configurable: {
            thread_id: thread.id,
            checkpoint_ns: '',
            checkpoint_id: checkpointId
          }
        }, write.values, write.taskId)
      }
      return { thread, run }
    }
    const plain = await createWrittenRun('plain-error-run', [{
      taskId: 'plain-task',
      values: [['__error__', { message: 'plain failure' }]]
    }])
    const handled = await createWrittenRun('handled-error-run', [{
      taskId: 'handled-task',
      values: [
        ['__error__', { message: 'handled failure' }],
        ['__error_source_node__', 'source-node']
      ]
    }])
    const mixed = await createWrittenRun('mixed-error-run', [
      {
        taskId: 'plain-sibling',
        values: [['__error__', { message: 'unhandled sibling' }]]
      },
      {
        taskId: 'handled-sibling',
        values: [
          ['__error__', { message: 'handled sibling' }],
          ['__error_source_node__', 'source-node']
        ]
      }
    ])
    const handledWithInterrupt = await createWrittenRun('handled-interrupt-run', [
      {
        taskId: 'handled-task',
        values: [
          ['__error__', { message: 'handled failure' }],
          ['__error_source_node__', 'source-node']
        ]
      },
      {
        taskId: 'approval-task',
        values: [['__interrupt__', [{ id: 'approval', value: { actionRequests: [] } }]]]
      }
    ])
    database.close()

    database = AgentDatabase.open(location.file, location.attachments)
    try {
      expect(database.getRun(plain.run.id)).toMatchObject({ status: 'failed' })
      expect(database.getThread(plain.thread.id)?.status).toBe('failed')
      expect(database.getRun(mixed.run.id)).toMatchObject({ status: 'failed' })
      expect(database.getThread(mixed.thread.id)?.status).toBe('failed')
      expect(database.getRun(handled.run.id)).toMatchObject({ status: 'running' })
      expect(database.getRun(handledWithInterrupt.run.id)).toMatchObject({ status: 'running' })
      expect(database.listRecoverableRuns().map((run) => run.id)).toEqual([
        handled.run.id,
        handledWithInterrupt.run.id
      ])
    } finally {
      database.close()
    }
  })

  it('discards an old resume intent when the graph reaches a new interrupt with the same ID', async () => {
    const location = temporaryDatabase()
    const database = AgentDatabase.open(location.file, location.attachments)
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'sequential-interrupt-run')
      const State = Annotation.Root({
        approvals: Annotation<string[]>({
          reducer: (left, right) => [...left, ...right],
          default: () => []
        })
      })
      const graph = new StateGraph(State)
        .addNode('approve_twice', () => {
          const first = interrupt({ step: 'first' }) as string
          const second = interrupt({ step: 'second' }) as string
          return { approvals: [first, second] }
        })
        .addEdge('__start__', 'approve_twice')
        .compile({ checkpointer: database.checkpointer })
      const config = {
        configurable: { thread_id: thread.id },
        durability: 'sync' as const
      }

      await graph.invoke({ approvals: [] }, config)
      const firstState = await graph.getState(config)
      const firstInterruptId = firstState.tasks[0]?.interrupts[0]?.id
      if (!firstInterruptId) throw new Error('Expected the first framework interrupt.')
      database.finishRun(run.id, 'interrupted')
      const resumeIntent = { [firstInterruptId]: 'approved-first' }
      database.resumeRun(run.id, [{
        interruptId: firstInterruptId,
        response: resumeIntent[firstInterruptId]
      }])

      await graph.invoke(new Command({ resume: resumeIntent }), config)
      const secondState = await graph.getState(config)
      const secondInterruptId = secondState.tasks[0]?.interrupts[0]?.id
      expect(secondInterruptId).toBe(firstInterruptId)
      expect(database.getRunCheckpointState(run.id)).toMatchObject({
        lastWriteCheckpointNamespace: '',
        resumeIntent: undefined
      })
      expect(database.listRecoverableRuns().map((candidate) => candidate.id)).toEqual([run.id])
      expect(database.finishRun(run.id, 'interrupted').status).toBe('interrupted')
    } finally {
      database.close()
    }
  })

  it('proves interruption from the current root writes regardless of child write ordering', async () => {
    const location = temporaryDatabase()
    const database = AgentDatabase.open(location.file, location.attachments)
    const createRun = async (id: string) => {
      const thread = database.createThread({ title: id })
      const run = database.createRun(thread.id, id)
      const checkpointId = `${id}-root`
      await putCheckpoint(database, thread.id, checkpointId, {
        runId: run.id,
        status: 'running'
      })
      return { thread, run, checkpointId }
    }
    const putRootInterrupt = async (
      item: Awaited<ReturnType<typeof createRun>>,
      taskId: string
    ) => {
      await database.checkpointer.putWrites({
        configurable: {
          thread_id: item.thread.id,
          checkpoint_ns: '',
          checkpoint_id: item.checkpointId
        }
      }, [['__interrupt__', [{ id: taskId, value: {} }]]], taskId)
    }
    const putChildInterrupt = async (
      item: Awaited<ReturnType<typeof createRun>>,
      suffix: string
    ) => {
      const childCheckpointId = `${item.run.id}-${suffix}`
      await putCheckpoint(
        database,
        item.thread.id,
        childCheckpointId,
        undefined,
        `child:${suffix}`
      )
      await database.checkpointer.putWrites({
        configurable: {
          thread_id: item.thread.id,
          checkpoint_ns: `child:${suffix}`,
          checkpoint_id: childCheckpointId
        }
      }, [['__interrupt__', [{ id: `child-${suffix}`, value: {} }]]], `child-${suffix}`)
    }
    try {
      const rootThenChild = await createRun('root-then-child')
      await putRootInterrupt(rootThenChild, 'root-first')
      await putChildInterrupt(rootThenChild, 'later')
      expect(database.finishRun(rootThenChild.run.id, 'interrupted').status).toBe('interrupted')

      const childThenRoot = await createRun('child-then-root')
      await putChildInterrupt(childThenRoot, 'first')
      await putRootInterrupt(childThenRoot, 'root-later')
      expect(database.finishRun(childThenRoot.run.id, 'interrupted').status).toBe('interrupted')

      const multipleRoot = await createRun('multiple-root-interrupts')
      await putRootInterrupt(multipleRoot, 'root-a')
      await putRootInterrupt(multipleRoot, 'root-b')
      expect(database.finishRun(multipleRoot.run.id, 'interrupted').status).toBe('interrupted')

      const childOnly = await createRun('ordering-child-only')
      await putChildInterrupt(childOnly, 'only')
      expect(() => database.finishRun(childOnly.run.id, 'interrupted')).toThrow(
        'no durable root framework interrupt'
      )
    } finally {
      database.close()
    }
  })

  it('keeps cleanup work durable after run metadata is deleted', async () => {
    const location = temporaryDatabase()
    let database = AgentDatabase.open(location.file, location.attachments)
    const thread = database.createThread()
    const run = database.createRun(thread.id, 'deleted-terminal-run')
    await putCheckpoint(database, thread.id, 'deleted-terminal-checkpoint', {
      runId: run.id,
      status: 'completed'
    })
    database.finishRun(run.id, 'completed')

    const failedThread = database.createThread()
    const failedRun = database.createRun(failedThread.id, 'failed-run')
    database.finishRun(failedRun.id, 'failed', 'Injected failure')
    const cancelledThread = database.createThread()
    const cancelledRun = database.createRun(cancelledThread.id, 'normally-cancelled-run')
    database.requestRunCancellation(cancelledRun.id)
    database.finishRun(cancelledRun.id, 'cancelled')
    const interruptedThread = database.createThread()
    const interruptedRun = database.createRun(interruptedThread.id, 'durable-interrupt-run')
    const interruptCheckpointId = 'cleanup-interrupt-checkpoint'
    await putCheckpoint(database, interruptedThread.id, interruptCheckpointId, {
      runId: interruptedRun.id,
      status: 'running'
    })
    await database.checkpointer.putWrites({
      configurable: {
        thread_id: interruptedThread.id,
        checkpoint_ns: '',
        checkpoint_id: interruptCheckpointId
      }
    }, [['__interrupt__', [{ id: 'cleanup-interrupt', value: {} }]]], 'cleanup-interrupt-task')
    database.finishRun(interruptedRun.id, 'interrupted')

    const terminalRunIds = [run.id, failedRun.id, cancelledRun.id]
    expect(database.listFileEditCleanupRunIds()).toEqual(terminalRunIds)

    await database.deleteThread(thread.id)
    expect(database.getRun(run.id)).toBeNull()
    expect(database.listFileEditCleanupRunIds()).toEqual(terminalRunIds)
    database.close()

    database = AgentDatabase.open(location.file, location.attachments)
    try {
      expect(database.listFileEditCleanupRunIds()).toEqual(terminalRunIds)
      for (const runId of terminalRunIds) database.acknowledgeFileEditCleanup(runId)
      expect(database.listFileEditCleanupRunIds()).toEqual([])
    } finally {
      database.close()
    }
  })

})
