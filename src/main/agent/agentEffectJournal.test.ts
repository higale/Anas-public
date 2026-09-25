import { mkdtempSync, rmSync } from 'node:fs'
import Database from 'better-sqlite3'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolMessage } from '@langchain/core/messages'
import { Command, isCommand } from '@langchain/langgraph'
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AgentDatabase,
  type AgentToolEffectKey,
  type AgentToolEffectPreparation,
  type AgentToolEffectRecoveryMode
} from './agentDatabase'

const temporaryRoots: string[] = []

function temporaryDatabase(): { file: string; attachments: string } {
  const root = mkdtempSync(join(tmpdir(), 'anas-effect-journal-'))
  temporaryRoots.push(root)
  return {
    file: join(root, 'agent.sqlite'),
    attachments: join(root, 'attachments')
  }
}

function effectKey(effect: AgentToolEffectPreparation): AgentToolEffectKey {
  return {
    runId: effect.runId,
    checkpointId: effect.checkpointId,
    checkpointNs: effect.checkpointNs,
    taskId: effect.taskId,
    callKey: effect.callKey,
    inputHash: effect.inputHash
  }
}

function effectPreparation(
  threadId: string,
  runId: string,
  suffix: string,
  recoveryMode: AgentToolEffectRecoveryMode = 'confirm'
): AgentToolEffectPreparation {
  return {
    runId,
    threadId,
    checkpointId: `checkpoint-${suffix}`,
    checkpointNs: `tools:task-${suffix}`,
    writeCheckpointNs: '',
    taskId: `task-${suffix}`,
    callKey: `call-${suffix}`,
    inputHash: `sha256-${suffix}`,
    callIndex: Number.parseInt(suffix.replace(/\D/g, ''), 10) || 0,
    toolCallId: `tool-call-${suffix}`,
    toolName: 'http_request',
    argsJson: JSON.stringify({ method: 'POST', url: `https://example.test/${suffix}` }),
    recoveryMode
  }
}

const checkpointMetadata: CheckpointMetadata = {
  source: 'loop',
  step: 1,
  parents: {}
}

async function putRootCheckpoint(
  database: AgentDatabase,
  threadId: string,
  checkpointId: string,
  lifecycle?: { runId: string; status: 'running' | 'completed' }
): Promise<void> {
  const checkpoint: Checkpoint = {
    v: 4,
    id: checkpointId,
    ts: new Date().toISOString(),
    channel_values: lifecycle ? { anasRunLifecycle: lifecycle } : {},
    channel_versions: {},
    versions_seen: {}
  }
  await database.checkpointer.put({
    configurable: { thread_id: threadId, checkpoint_ns: '' }
  }, checkpoint, checkpointMetadata)
}

async function putRootInterrupt(
  database: AgentDatabase,
  threadId: string,
  runId: string,
  checkpointId: string
): Promise<void> {
  await putRootCheckpoint(database, threadId, checkpointId, {
    runId,
    status: 'running'
  })
  await database.checkpointer.putWrites({
    configurable: {
      thread_id: threadId,
      checkpoint_ns: '',
      checkpoint_id: checkpointId
    }
  }, [['__interrupt__', [{ id: `${runId}-interrupt`, value: {} }]]], `${runId}-task`)
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

describe('Agent durable tool effect journal', () => {
  it('keeps one large message body through managed results, effect replay and Command updates, with atomic conflicts', async () => {
    const location = temporaryDatabase()
    let database = AgentDatabase.open(location.file, location.attachments)
    const thread = database.createThread()
    const run = database.createRun(thread.id, 'canonical-effects')
    const preparation = effectPreparation(thread.id, run.id, 'canonical')
    const key = effectKey(preparation)
    const commandPreparation = effectPreparation(thread.id, run.id, 'command-canonical')
    const commandKey = effectKey(commandPreparation)
    const message = new ToolMessage({ content: '结果'.repeat(300_000), tool_call_id: preparation.toolCallId!,
      artifact: { bytes: new Uint8Array([4, 5, 6]) } })
    try {
      database.checkpointer.retainRun(run.id, thread.id)
      await putRootCheckpoint(database, thread.id, 'canonical-effects-root', { runId: run.id, status: 'running' })
      const recordId = await database.persistManagedToolResult(thread.id, run.id, message)
      database.prepareToolEffect(preparation)
      const row = await database.storeToolEffectResult(key, { result: message })
      expect(row.resultBlob!.byteLength).toBeLessThan(1024)
      database.prepareToolEffect(commandPreparation)
      const command = new Command({ graph: Command.PARENT, update: { messages: [message] }, goto: 'done' })
      expect((await database.storeToolEffectResult(commandKey, { result: command })).resultBlob!.byteLength).toBeLessThan(2048)
      await expect(database.storeToolEffectResult(key, { result: new ToolMessage({
        content: 'conflicting result', tool_call_id: preparation.toolCallId!
      }) })).rejects.toThrow('different durable result')
      const inspect = new Database(location.file, { readonly: true })
      try { expect(inspect.prepare('SELECT count(*) AS count FROM message_bodies').get()).toEqual({ count: 1 }) }
      finally { inspect.close() }
      expect(database.checkpointer.getMessageRecordById(thread.id, recordId)).toBeDefined()
      await database.checkpointer.releaseRun(run.id)
      database.close()
      database = AgentDatabase.open(location.file, location.attachments)
      const restoredMessage = await database.loadToolEffectResult(key)
      expect(restoredMessage).toBeDefined()
      expect((restoredMessage as ToolMessage).content === message.content).toBe(true)
      expect((restoredMessage as ToolMessage).artifact).toEqual(message.artifact)
      const restored = await database.loadToolEffectResult(commandKey)
      expect(restored).toBeInstanceOf(Command)
      expect((restored as Command).graph).toBe(Command.PARENT)
      expect((restored as Command).update).toMatchObject({ messages: [{ content: message.content, artifact: message.artifact }] })
    } finally { database.close() }
  })

  it('prepares one immutable call identity idempotently and rejects input drift', () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'prepare-run')
      const preparation = effectPreparation(thread.id, run.id, '1')

      expect(database.prepareToolEffect(preparation)).toMatchObject({
        ...effectKey(preparation),
        threadId: thread.id,
        writeCheckpointNs: '',
        callIndex: 1,
        toolCallId: 'tool-call-1',
        toolName: 'http_request',
        argsJson: preparation.argsJson,
        recoveryMode: 'confirm',
        state: 'prepared',
        effectAttempt: 0,
        confirmationCount: 0,
        automaticRetryCount: 0
      })

      expect(database.prepareToolEffect({
        ...preparation,
        recoveryMode: 'idempotent'
      })).toMatchObject({
        recoveryMode: 'idempotent',
        state: 'prepared'
      })
      expect(database.prepareToolEffect({
        ...preparation,
        recoveryMode: 'confirm'
      })).toMatchObject({
        recoveryMode: 'confirm',
        state: 'prepared'
      })
      expect(() => database.prepareToolEffect({
        ...preparation,
        argsJson: JSON.stringify({ method: 'DELETE', url: 'https://example.test/1' })
      })).toThrow('changed immutable fields: argsJson')
      expect(() => database.loadToolEffect({
        ...effectKey(preparation),
        inputHash: 'sha256-different'
      })).toThrow('input hash changed')
      expect(() => database.prepareToolEffect({
        ...preparation,
        argsJson: '{"method": "POST"}'
      })).toThrow('normalized JSON')

      expect(database.discardPreparedToolEffect(effectKey(preparation))).toBe(true)
      expect(database.loadToolEffect(effectKey(preparation))).toBeUndefined()
      expect(database.discardPreparedToolEffect(effectKey(preparation))).toBe(false)

      database.prepareToolEffect(preparation)
      database.armToolEffect(effectKey(preparation), {
        effectKind: 'http_request',
        targetJson: JSON.stringify({ method: 'POST', url: 'https://example.test/1' })
      })
      expect(() => database.discardPreparedToolEffect(effectKey(preparation)))
        .toThrow('cannot be discarded after its effect boundary')

      const otherThread = database.createThread()
      expect(() => database.prepareToolEffect({
        ...preparation,
        threadId: otherThread.id
      })).toThrow(`belongs to thread ${thread.id}`)
    } finally {
      database.close()
    }
  })

  it('separates retry decisions from the true arm point and counts each decision once', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'state-machine-run')
      const automaticPreparation = effectPreparation(thread.id, run.id, '10', 'confirm')
      const automaticKey = effectKey(automaticPreparation)
      database.prepareToolEffect(automaticPreparation)

      expect(database.armToolEffect(automaticKey, {
        effectKind: 'http_mutation',
        targetJson: JSON.stringify({ method: 'POST', url: 'https://example.test/10' }),
        recoveryMode: 'idempotent',
        idempotencyFingerprint: 'a'.repeat(64)
      })).toMatchObject({
        state: 'intent',
        recoveryMode: 'idempotent',
        effectAttempt: 1,
        automaticRetryCount: 0,
        effectKind: 'http_mutation',
        idempotencyFingerprint: 'a'.repeat(64)
      })
      expect(() => database.armToolEffect(automaticKey, {
        effectKind: 'http_mutation',
        targetJson: '{}'
      })).toThrow('cannot be armed from intent')

      expect(database.retryToolEffect(automaticKey, {
        kind: 'automatic',
        expectedAutomaticRetryCount: 0
      })).toMatchObject({
        state: 'prepared',
        effectAttempt: 1,
        automaticRetryCount: 1,
        effectKind: 'http_mutation',
        targetJson: JSON.stringify({ method: 'POST', url: 'https://example.test/10' }),
        idempotencyFingerprint: 'a'.repeat(64)
      })
      expect(() => database.armToolEffect(automaticKey, {
        effectKind: 'http_mutation',
        targetJson: JSON.stringify({ method: 'POST', url: 'https://changed.test/10' }),
        idempotencyFingerprint: 'a'.repeat(64)
      })).toThrow('resolved to a different effect boundary')
      const secondIntent = database.armToolEffect(automaticKey, {
        effectKind: 'http_mutation',
        targetJson: JSON.stringify({ method: 'POST', url: 'https://example.test/10' }),
        idempotencyFingerprint: 'a'.repeat(64)
      })
      expect(secondIntent).toMatchObject({ state: 'intent', effectAttempt: 2 })
      expect(() => database.retryToolEffect(automaticKey, {
        kind: 'automatic',
        expectedAutomaticRetryCount: 0
      })).toThrow('automatic retry count changed')

      const completedMessage = new ToolMessage({
        content: 'completed',
        tool_call_id: automaticPreparation.toolCallId!,
        status: 'success'
      })
      const completedResult = { result: completedMessage }
      expect(await database.storeToolEffectResult(automaticKey, completedResult)).toMatchObject({
        state: 'result',
        effectAttempt: 2,
        automaticRetryCount: 1
      })
      expect(await database.storeToolEffectResult(automaticKey, completedResult)).toMatchObject({
        state: 'result',
        automaticRetryCount: 1
      })

      const confirmationPreparation = effectPreparation(thread.id, run.id, '20', 'confirm')
      const confirmationKey = effectKey(confirmationPreparation)
      database.prepareToolEffect(confirmationPreparation)
      database.armToolEffect(confirmationKey, {
        effectKind: 'shell_process',
        targetJson: JSON.stringify({ command: 'deploy' })
      })
      expect(database.retryToolEffect(confirmationKey, {
        kind: 'approved',
        expectedConfirmationCount: 0
      })).toMatchObject({
        state: 'prepared',
        effectAttempt: 1,
        confirmationCount: 1,
        effectKind: 'shell_process',
        targetJson: JSON.stringify({ command: 'deploy' })
      })
      expect(() => database.armToolEffect(confirmationKey, {
        effectKind: 'shell_process',
        targetJson: JSON.stringify({ command: 'deploy --changed' })
      })).toThrow('resolved to a different effect boundary')
      database.armToolEffect(confirmationKey, {
        effectKind: 'shell_process',
        targetJson: JSON.stringify({ command: 'deploy' })
      })
      expect(() => database.retryToolEffect(confirmationKey, {
        kind: 'approved',
        expectedConfirmationCount: 0
      })).toThrow('confirmation count changed')
      expect(database.retryToolEffect(confirmationKey, {
        kind: 'approved',
        expectedConfirmationCount: 1
      })).toMatchObject({
        state: 'prepared',
        effectAttempt: 2,
        confirmationCount: 2
      })

      const rejectedMessage = new ToolMessage({
        content: 'Recovery rejected.',
        tool_call_id: confirmationPreparation.toolCallId!,
        status: 'error',
        metadata: { recovery: 'rejected' }
      })
      const rejectedResult = { result: rejectedMessage }
      expect(await database.storeToolEffectResult(confirmationKey, {
        ...rejectedResult,
        confirmation: { kind: 'rejected', expectedConfirmationCount: 2 }
      })).toMatchObject({
        state: 'result',
        effectAttempt: 2,
        confirmationCount: 3
      })
      expect(await database.storeToolEffectResult(confirmationKey, {
        ...rejectedResult,
        confirmation: { kind: 'rejected', expectedConfirmationCount: 2 }
      })).toMatchObject({ confirmationCount: 3 })
      expect(() => database.armToolEffect(confirmationKey, {
        effectKind: 'shell_process',
        targetJson: '{}'
      })).toThrow('cannot be armed from result')

      const noOpPreparation = effectPreparation(thread.id, run.id, '30')
      const noOpKey = effectKey(noOpPreparation)
      database.prepareToolEffect(noOpPreparation)
      expect(await database.storeToolEffectResult(noOpKey, completedResult)).toMatchObject({
        state: 'result',
        effectAttempt: 0
      })
    } finally {
      database.close()
    }
  })

  it('round-trips exact ToolMessage and Command results across a recoverable reopen', async () => {
    const location = temporaryDatabase()
    let database = AgentDatabase.open(location.file, location.attachments)
    const thread = database.createThread()
    const run = database.createRun(
      thread.id,
      'serde-reopen-run',
      'agent',
      [],
      { kind: 'user', text: 'Persist the tool task.' }
    )
    const messagePreparation = effectPreparation(thread.id, run.id, '41')
    const messageKey = effectKey(messagePreparation)
    const commandPreparation = effectPreparation(thread.id, run.id, '42')
    const commandKey = effectKey(commandPreparation)
    const message = new ToolMessage({
      content: [{ type: 'text', text: 'visible result' }],
      tool_call_id: messagePreparation.toolCallId!,
      name: 'http_request',
      status: 'error',
      artifact: {
        statusCode: 409,
        body: { reason: 'duplicate', retryable: false }
      },
      metadata: { effectAttempt: 2, source: 'journal-test' },
      additional_kwargs: { providerField: { nested: true } },
      response_metadata: { requestId: 'request-41' },
      id: 'tool-message-41'
    })
    const command = new Command({
      graph: Command.PARENT,
      update: {
        recovery: { callKey: commandPreparation.callKey, accepted: true }
      },
      goto: 'continue_after_tool'
    })

    database.prepareToolEffect(messagePreparation)
    database.armToolEffect(messageKey, {
      effectKind: 'http_mutation',
      targetJson: JSON.stringify({ method: 'POST', url: 'https://example.test/41' })
    })
    await database.storeToolEffectResult(
      messageKey,
      { result: message }
    )
    database.prepareToolEffect(commandPreparation)
    await database.storeToolEffectResult(
      commandKey,
      { result: command }
    )
    database.close()

    database = AgentDatabase.open(location.file, location.attachments)
    try {
      expect(database.getRun(run.id)?.status).toBe('running')
      const restoredMessage = await database.loadToolEffectResult(messageKey)
      expect(ToolMessage.isInstance(restoredMessage)).toBe(true)
      expect(restoredMessage).toMatchObject({
        content: [{ type: 'text', text: 'visible result' }],
        tool_call_id: messagePreparation.toolCallId,
        name: 'http_request',
        status: 'error',
        artifact: {
          statusCode: 409,
          body: { reason: 'duplicate', retryable: false }
        },
        metadata: { effectAttempt: 2, source: 'journal-test' },
        additional_kwargs: { providerField: { nested: true } },
        response_metadata: { requestId: 'request-41' },
        id: 'tool-message-41'
      })

      const restoredCommand = await database.loadToolEffectResult(commandKey)
      expect(isCommand(restoredCommand)).toBe(true)
      expect(restoredCommand).toBeInstanceOf(Command)
      expect(isCommand(restoredCommand) ? restoredCommand.graph : undefined)
        .toBe(Command.PARENT)
      expect(isCommand(restoredCommand) ? restoredCommand.toJSON() : undefined)
        .toEqual(command.toJSON())
    } finally {
      database.close()
    }
  })

  it('garbage-collects a result only with its exact durable normal task outcome', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'outcome-gc-run')
      const preparation = {
        ...effectPreparation(thread.id, run.id, '50'),
        checkpointNs: 'child:effect|tools:task-50',
        writeCheckpointNs: 'child:effect'
      }
      const key = effectKey(preparation)
      database.prepareToolEffect(preparation)
      const result = new ToolMessage({
        content: 'durable result',
        tool_call_id: preparation.toolCallId!,
        status: 'success'
      })
      await database.storeToolEffectResult(key, { result })
      const recordId = database.checkpointer.getLatestMessageRecord(thread.id, result.id!)!.recordId

      const putWrite = async (
        checkpointId: string,
        checkpointNs: string,
        taskId: string,
        channel: string
      ): Promise<void> => {
        await database.checkpointer.putWrites({
          configurable: {
            thread_id: thread.id,
            checkpoint_ns: checkpointNs,
            checkpoint_id: checkpointId
          }
        }, [[channel, { durable: true }]], taskId)
      }

      await putWrite(key.checkpointId, preparation.writeCheckpointNs, key.taskId, '__resume__')
      await putWrite(key.checkpointId, preparation.writeCheckpointNs, key.taskId, '__interrupt__')
      await putWrite(key.checkpointId, preparation.writeCheckpointNs, key.taskId, '__error__')
      await putWrite(key.checkpointId, preparation.writeCheckpointNs, key.taskId, '__scheduled__')
      expect(database.loadToolEffect(key)?.state).toBe('result')

      await putWrite('different-checkpoint', preparation.writeCheckpointNs, key.taskId, 'messages')
      await putWrite(key.checkpointId, 'different:namespace', key.taskId, 'messages')
      await putWrite(key.checkpointId, preparation.writeCheckpointNs, 'different-task', 'messages')
      expect(database.loadToolEffect(key)?.state).toBe('result')

      await putWrite(key.checkpointId, preparation.writeCheckpointNs, key.taskId, 'messages')
      expect(database.loadToolEffect(key)).toBeUndefined()
      expect(database.checkpointer.getMessageRecordById(thread.id, recordId)).toBeUndefined()
    } finally {
      database.close()
    }
  })

  it.each(['file_patch'])('retains %s revisions without a durable task result and releases them after restore output is durable', async (effectKind) => {
    const database = AgentDatabase.open(':memory:')
    try {
      const requestId = '00000000-0000-4000-8000-000000000071'
      const operationId = '00000000-0000-4000-8000-000000000072'
      const thread = database.createThread()
      const run = database.createRun(thread.id, requestId)
      const writePreparation = effectPreparation(thread.id, run.id, '71')
      database.prepareToolEffect(writePreparation)
      database.armToolEffect(effectKey(writePreparation), {
        effectKind,
        targetJson: JSON.stringify({
          path: '/project/recoverable.txt',
          requestId,
          operationId
        }),
        recoveryMode: 'idempotent'
      })

      database.finishRun(run.id, 'cancelled')
      expect(database.listRetainedFileEditOperationIds(requestId)).toEqual([operationId])

      const restoreThread = database.createThread()
      const restoreRun = database.createRun(
        restoreThread.id,
        '00000000-0000-4000-8000-000000000073'
      )
      const restorePreparation = effectPreparation(
        restoreThread.id,
        restoreRun.id,
        '72',
        'idempotent'
      )
      restorePreparation.toolName = 'restore_file_edit'
      restorePreparation.argsJson = JSON.stringify({
        operation_id: operationId,
        request_id: requestId
      })
      const restoreKey = effectKey(restorePreparation)
      database.prepareToolEffect(restorePreparation)
      database.armToolEffect(restoreKey, {
        effectKind: 'file_patch',
        targetJson: JSON.stringify({
          path: '/project/recoverable.txt',
          operationId,
          requestId
        }),
        recoveryMode: 'idempotent'
      })
      await database.storeToolEffectResult(
        restoreKey,
        { result: new ToolMessage({
          content: 'restored',
          tool_call_id: restorePreparation.toolCallId!,
          status: 'success'
        }) }
      )
      await database.checkpointer.putWrites({
        configurable: {
          thread_id: restoreThread.id,
          checkpoint_ns: restorePreparation.writeCheckpointNs,
          checkpoint_id: restoreKey.checkpointId
        }
      }, [['messages', { restored: true }]], restoreKey.taskId)

      expect(database.loadToolEffect(restoreKey)).toBeUndefined()
      expect(database.listRetainedFileEditOperationIds(requestId)).toEqual([])
      expect(database.listFileEditCleanupRunIds()).toContain(requestId)
    } finally {
      database.close()
    }
  })

  it('clears normal terminal and explicit recovery-cancel rows but preserves interrupts', async () => {
    const location = temporaryDatabase()
    let database = AgentDatabase.open(location.file, location.attachments)

    const terminalThread = database.createThread()
    const terminalRun = database.createRun(terminalThread.id, 'normal-terminal-run')
    const terminalEffect = effectPreparation(terminalThread.id, terminalRun.id, '51')
    database.prepareToolEffect(terminalEffect)
    database.armToolEffect(effectKey(terminalEffect), {
      effectKind: 'file_patch',
      targetJson: JSON.stringify({ path: '/project/result.txt' })
    })
    database.finishRun(terminalRun.id, 'cancelled')
    expect(database.loadToolEffect(effectKey(terminalEffect))).toBeUndefined()

    const recoverableThread = database.createThread()
    const recoverableRun = database.createRun(
      recoverableThread.id,
      'explicit-recovery-cancel-run',
      'agent',
      [],
      { kind: 'user', text: 'Recover this run.' }
    )
    const recoverableEffect = effectPreparation(
      recoverableThread.id,
      recoverableRun.id,
      '52'
    )
    database.prepareToolEffect(recoverableEffect)
    database.armToolEffect(effectKey(recoverableEffect), {
      effectKind: 'shell_process',
      targetJson: JSON.stringify({ command: 'publish' })
    })
    expect(database.cancelRecoverableRun(recoverableRun.id)).toBe(true)
    expect(database.loadToolEffect(effectKey(recoverableEffect))).toBeUndefined()

    const interruptedThread = database.createThread()
    const interruptedRun = database.createRun(interruptedThread.id, 'interrupted-effect-run')
    const interruptedEffect = effectPreparation(
      interruptedThread.id,
      interruptedRun.id,
      '53'
    )
    database.prepareToolEffect(interruptedEffect)
    database.armToolEffect(effectKey(interruptedEffect), {
      effectKind: 'shell_process',
      targetJson: JSON.stringify({ command: 'release' })
    })
    await putRootInterrupt(
      database,
      interruptedThread.id,
      interruptedRun.id,
      'interrupted-effect-checkpoint'
    )
    database.finishRun(interruptedRun.id, 'interrupted')
    expect(database.loadToolEffect(effectKey(interruptedEffect))).toMatchObject({
      state: 'intent',
      effectAttempt: 1
    })
    database.close()

    database = AgentDatabase.open(location.file, location.attachments)
    try {
      expect(database.getRun(interruptedRun.id)?.status).toBe('interrupted')
      expect(database.loadToolEffect(effectKey(interruptedEffect))).toMatchObject({
        state: 'intent',
        effectAttempt: 1
      })
    } finally {
      database.close()
    }
  })

  it('clears every startup terminal classification and retains recoverable work', async () => {
    const location = temporaryDatabase()
    let database = AgentDatabase.open(location.file, location.attachments)

    const terminalThread = database.createThread()
    const terminalRun = database.createRun(terminalThread.id, 'startup-terminal-run')
    const terminalEffect = effectPreparation(terminalThread.id, terminalRun.id, '61')
    database.prepareToolEffect(terminalEffect)
    await putRootCheckpoint(database, terminalThread.id, 'startup-terminal-checkpoint', {
      runId: terminalRun.id,
      status: 'completed'
    })

    const cancellationThread = database.createThread()
    const cancellationRun = database.createRun(
      cancellationThread.id,
      'startup-cancellation-run'
    )
    const cancellationEffect = effectPreparation(
      cancellationThread.id,
      cancellationRun.id,
      '62'
    )
    database.prepareToolEffect(cancellationEffect)
    expect(database.requestRunCancellation(cancellationRun.id)).toBe(true)

    const errorThread = database.createThread()
    const errorRun = database.createRun(errorThread.id, 'startup-error-run')
    const errorEffect = effectPreparation(errorThread.id, errorRun.id, '63')
    database.prepareToolEffect(errorEffect)
    await putRootCheckpoint(database, errorThread.id, 'startup-error-checkpoint', {
      runId: errorRun.id,
      status: 'running'
    })
    await database.checkpointer.putWrites({
      configurable: {
        thread_id: errorThread.id,
        checkpoint_ns: '',
        checkpoint_id: 'startup-error-checkpoint'
      }
    }, [['__error__', { message: 'Injected durable task error.' }]], 'failed-task')

    const noProgressThread = database.createThread()
    const noProgressRun = database.createRun(noProgressThread.id, 'startup-no-progress-run')
    const noProgressEffect = effectPreparation(
      noProgressThread.id,
      noProgressRun.id,
      '64'
    )
    database.prepareToolEffect(noProgressEffect)

    const recoverableThread = database.createThread()
    const recoverableRun = database.createRun(
      recoverableThread.id,
      'startup-recoverable-run',
      'agent',
      [],
      { kind: 'user', text: 'Keep the durable effect work.' }
    )
    const recoverableEffect = effectPreparation(
      recoverableThread.id,
      recoverableRun.id,
      '65'
    )
    database.prepareToolEffect(recoverableEffect)
    database.close()

    database = AgentDatabase.open(location.file, location.attachments)
    try {
      expect(database.getRun(terminalRun.id)?.status).toBe('completed')
      expect(database.getRun(cancellationRun.id)?.status).toBe('cancelled')
      expect(database.getRun(errorRun.id)?.status).toBe('failed')
      expect(database.getRun(noProgressRun.id)?.status).toBe('cancelled')
      expect(database.getRun(recoverableRun.id)?.status).toBe('running')

      for (const effect of [
        terminalEffect,
        cancellationEffect,
        errorEffect,
        noProgressEffect
      ]) {
        expect(database.loadToolEffect(effectKey(effect))).toBeUndefined()
      }
      expect(database.loadToolEffect(effectKey(recoverableEffect))).toMatchObject({
        state: 'prepared',
        effectAttempt: 0
      })
    } finally {
      database.close()
    }
  })
})
