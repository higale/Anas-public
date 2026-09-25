import Database from 'better-sqlite3'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ToolMessage } from '@langchain/core/messages'
import { afterEach, describe, expect, it } from 'vitest'
import { FileEditStore } from '../fileEditStore'
import { resolveFilePatchTargets } from '../filePatch'
import { asPatchInput } from '../filePatchTestFixtures'
import { captureFilePatchPreimages } from '../filePatchState'
import { AgentDatabase } from './agentDatabase'
import { runWithCurrentAgentToolEffect } from './toolEffectScope'
import {
  runToolEffectHardCrashHarness,
  toolEffectHardCrashExitCode,
  type ToolEffectHardCrashFault,
  type ToolEffectHardCrashInvocation,
  type ToolEffectHardCrashScenario
} from './toolEffectHardCrashHarness'

interface CrashLocation {
  root: string
  databaseFile: string
  attachmentsDirectory: string
  viteCacheDirectory: string
  effectLogFile: string
  traceLogFile: string
  fileEditRecordsDirectory: string
  fileWorkspaceDirectory: string
  threadId: string
  runId: string
  restoreOperationId?: string
  restoreRequestId?: string
}

interface JournalRow {
  run_id: string
  checkpoint_id: string
  checkpoint_ns: string
  write_checkpoint_ns: string
  task_id: string
  call_key: string
  input_hash: string
  tool_name: string
  state: 'prepared' | 'intent' | 'result'
  effect_attempt: number
  confirmation_count: number
  automatic_retry_count: number
  recovery_mode: 'confirm' | 'idempotent'
  effect_kind: string | null
  target_json: string | null
}

interface TraceRow {
  event: string
  toolName?: string
  checkpointId?: string
  checkpointNs?: string
  writeCheckpointNs?: string
  taskId?: string
  callKey?: string
  inputHash?: string
  operationId?: string
  effectState?: string
  reused?: boolean
}

interface DurableWriteIdentity {
  checkpoint_id: string
  checkpoint_ns: string
  task_id: string
}

interface RecoveryInterrupt {
  id: string
  value: {
    actionRequests: Array<{
      name: string
      args?: Record<string, unknown>
      description?: string
      anasRecovery: { ordinal: number; state: string }
    }>
  }
}

const temporaryRoots: string[] = []

function createLocation(suffix: string): CrashLocation {
  const root = realpathSync(mkdtempSync(join(tmpdir(), `anas-effect-hard-crash-${suffix}-`)))
  temporaryRoots.push(root)
  const databaseFile = join(root, 'agent.sqlite')
  const attachmentsDirectory = join(root, 'attachments')
  const database = AgentDatabase.open(databaseFile, attachmentsDirectory)
  const thread = database.createThread({ title: `Hard crash ${suffix}` })
  const runId = randomUUID()
  const run = database.createRun(
    thread.id,
    runId,
    'agent',
    [],
    { kind: 'user', text: 'Run the hard-crash fixture.' }
  )
  database.close()
  return {
    root,
    databaseFile,
    attachmentsDirectory,
    viteCacheDirectory: join(root, 'vite-cache'),
    effectLogFile: join(root, 'effects.log'),
    traceLogFile: join(root, 'trace.log'),
    fileEditRecordsDirectory: join(root, 'file-edits'),
    fileWorkspaceDirectory: join(root, 'workspace'),
    threadId: thread.id,
    runId: run.id
  }
}

async function createRestoreLocation(suffix: string, existedBefore: boolean) {
  const location = createLocation(suffix)
  mkdirSync(location.fileWorkspaceDirectory, { recursive: true })
  const target = fileEditTarget(location), before = 'restore before\n', after = 'restore after\n'
  if (existedBefore) writeFileSync(target, before)
  const store = new FileEditStore(location.fileEditRecordsDirectory), sourceRequestId = randomUUID()
  const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [
    existedBefore ? { type: 'update', path: target, patch: '@@\n-restore before\n+restore after\n' }
      : { type: 'create', path: target, content: after },
    { type: 'create', path: 'second.txt', content: 'second\n' }
  ] }), location.fileWorkspaceDirectory)
  const originRecord = await store.executePatch(resolved.input, await captureFilePatchPreimages(resolved.targets), sourceRequestId, { operationId: randomUUID() })
  location.restoreOperationId = originRecord.operationId
  location.restoreRequestId = sourceRequestId
  return { location, originRecord, target, before, after }
}

function crashProcess(
  location: CrashLocation,
  scenario: ToolEffectHardCrashScenario,
  invocation: ToolEffectHardCrashInvocation,
  fault: Exclude<ToolEffectHardCrashFault, 'none'>,
  faultToolName?: string,
  resumeInterruptId?: string
): void {
  const fixture = fileURLToPath(new URL('./toolEffectHardCrashFixture.mjs', import.meta.url))
  const crashed = spawnSync(process.execPath, [fixture, JSON.stringify({
    ...location,
    scenario,
    invocation,
    fault,
    ...(faultToolName ? { faultToolName } : {}),
    ...(resumeInterruptId ? { resumeInterruptId } : {})
  })], {
    cwd: process.cwd(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    timeout: 20_000
  })
  expect(crashed.error, crashed.stderr || crashed.stdout).toBeUndefined()
  expect(crashed.status, crashed.stderr || crashed.stdout).toBe(toolEffectHardCrashExitCode)
}

async function invokeRecovery(
  location: CrashLocation,
  scenario: ToolEffectHardCrashScenario,
  invocation: ToolEffectHardCrashInvocation,
  resumeInterruptId?: string
): Promise<unknown> {
  const database = AgentDatabase.open(
    location.databaseFile,
    location.attachmentsDirectory
  )
  try {
    return await runToolEffectHardCrashHarness({
      database,
      threadId: location.threadId,
      runId: location.runId,
      scenario,
      invocation,
      fault: 'none',
      effectLogFile: location.effectLogFile,
      traceLogFile: location.traceLogFile,
      fileEditRecordsDirectory: location.fileEditRecordsDirectory,
      fileWorkspaceDirectory: location.fileWorkspaceDirectory,
      ...(location.restoreOperationId
        ? { restoreOperationId: location.restoreOperationId }
        : {}),
      ...(location.restoreRequestId
        ? { restoreRequestId: location.restoreRequestId }
        : {}),
      ...(resumeInterruptId ? { resumeInterruptId } : {})
    })
  } finally {
    database.close()
  }
}

function journalRows(location: CrashLocation): JournalRow[] {
  const database = new Database(location.databaseFile, { readonly: true })
  try {
    return database.prepare(`
      SELECT
        run_id,
        checkpoint_id,
        checkpoint_ns,
        write_checkpoint_ns,
        task_id,
        call_key,
        input_hash,
        tool_name,
        state,
        effect_attempt,
        confirmation_count,
        automatic_retry_count,
        recovery_mode,
        effect_kind,
        target_json
      FROM agent_effect_journal
      ORDER BY call_index
    `).all() as JournalRow[]
  } finally {
    database.close()
  }
}

function durableInterruptWriteIdentities(location: CrashLocation): DurableWriteIdentity[] {
  const database = new Database(location.databaseFile, { readonly: true })
  try {
    return database.prepare(`
      SELECT DISTINCT checkpoint_id, checkpoint_ns, task_id
      FROM pending_writes
      WHERE thread_id = (
        SELECT thread_id FROM agent_runs WHERE id = ?
      )
        AND channel = '__interrupt__'
      ORDER BY checkpoint_id, checkpoint_ns, task_id
    `).all(location.runId) as DurableWriteIdentity[]
  } finally {
    database.close()
  }
}

function durableWriteChannelsAt(
  location: CrashLocation,
  identity: DurableWriteIdentity
): string[] {
  const database = new Database(location.databaseFile, { readonly: true })
  try {
    return database.prepare(`
      SELECT channel
      FROM pending_writes
      WHERE thread_id = (
        SELECT thread_id FROM agent_runs WHERE id = ?
      )
        AND checkpoint_ns = ?
        AND checkpoint_id = ?
        AND task_id = ?
      ORDER BY idx
    `).all(
      location.runId,
      identity.checkpoint_ns,
      identity.checkpoint_id,
      identity.task_id
    ).map((value) => (value as { channel: string }).channel)
  } finally {
    database.close()
  }
}

function durableWriteChannels(location: CrashLocation, row: JournalRow): string[] {
  return durableWriteChannelsAt(location, {
    checkpoint_id: row.checkpoint_id,
    checkpoint_ns: row.write_checkpoint_ns,
    task_id: row.task_id
  })
}

function fileEditCleanupRunIds(location: CrashLocation): string[] {
  const database = AgentDatabase.open(
    location.databaseFile,
    location.attachmentsDirectory
  )
  try {
    return database.listFileEditCleanupRunIds()
  } finally {
    database.close()
  }
}

function retainedFileEditOperationIds(
  location: CrashLocation,
  requestId: string
): string[] {
  const database = AgentDatabase.open(
    location.databaseFile,
    location.attachmentsDirectory
  )
  try {
    return database.listRetainedFileEditOperationIds(requestId)
  } finally {
    database.close()
  }
}

async function drainFileEditCleanup(location: CrashLocation): Promise<void> {
  const database = AgentDatabase.open(
    location.databaseFile,
    location.attachmentsDirectory
  )
  const store = new FileEditStore(location.fileEditRecordsDirectory)
  try {
    for (const runId of database.listFileEditCleanupRunIds()) {
      const retainedOperationIds = database.listRetainedFileEditOperationIds(runId)
      await runWithCurrentAgentToolEffect({ arm: () => undefined,
        persistFileChange: (record) => database.fileChanges.persist(record, true)
      }, () => store.deleteFileEditRecordsForRequest(runId, retainedOperationIds))
      database.acknowledgeFileEditCleanup(runId)
    }
  } finally {
    database.close()
  }
}

function lines(file: string): string[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split(/\r?\n/u).filter(Boolean)
}

function effects(location: CrashLocation): string[] {
  return lines(location.effectLogFile)
}

function traces(location: CrashLocation): TraceRow[] {
  return lines(location.traceLogFile).map((line) => JSON.parse(line) as TraceRow)
}

function fileEditTarget(location: CrashLocation): string {
  return join(location.fileWorkspaceDirectory, 'target.txt')
}

function toolResult(output: unknown, toolName: string): Record<string, unknown> {
  const messages = (output as { messages?: unknown[] }).messages ?? []
  const result = [...messages].reverse().find((message) => (
    ToolMessage.isInstance(message) && message.name === toolName
  ))
  if (!ToolMessage.isInstance(result) || typeof result.content !== 'string') {
    throw new Error(`Expected a ${toolName} ToolMessage result.`)
  }
  return JSON.parse(result.content) as Record<string, unknown>
}

function interrupts(output: unknown): RecoveryInterrupt[] {
  return (output as { __interrupt__?: RecoveryInterrupt[] }).__interrupt__ ?? []
}

function productVisibleInterrupts(output: unknown): RecoveryInterrupt[] {
  const unique = new Map<string, RecoveryInterrupt>()
  for (const interrupt of interrupts(output)) {
    const existing = unique.get(interrupt.id)
    if (existing) expect(interrupt.value).toEqual(existing.value)
    else unique.set(interrupt.id, interrupt)
  }
  return [...unique.values()]
}

function expectStablePreparedIdentity(location: CrashLocation): void {
  const prepared = traces(location).filter((row) => row.event === 'prepare:before')
  expect(prepared.length).toBeGreaterThanOrEqual(2)
  const identity = (row: TraceRow) => ({
    checkpointId: row.checkpointId,
    checkpointNs: row.checkpointNs,
    taskId: row.taskId,
    callKey: row.callKey,
    inputHash: row.inputHash
  })
  for (const row of prepared.slice(1)) expect(identity(row)).toEqual(identity(prepared[0]))
}

function onlyInterrupt(output: unknown): RecoveryInterrupt {
  // AgentRuntime deduplicates nested/root copies by the native interrupt ID.
  const pending = productVisibleInterrupts(output)
  expect(pending).toHaveLength(1)
  return pending[0]
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50
    })
  }
})

describe('tool effect hard-crash recovery', () => {
  it.each(['patch_before_metadata', 'patch_after_applied', 'after_result'] as const)('recovers write_file after %s without replacing an already applied file', async (fault) => {
    const location = createLocation(`write-content-${fault}`)
    mkdirSync(location.fileWorkspaceDirectory, { recursive: true })
    const target = fileEditTarget(location)
    writeFileSync(target, 'write before\n')
    crashProcess(location, 'file_write_content', 'initial', fault)
    const inode = statSync(target).ino
    const store = new FileEditStore(location.fileEditRecordsDirectory)
    const record = fault === 'patch_before_metadata' ? undefined : (await store.listEditRecordsForRequest(location.runId))[0]
    let result = await invokeRecovery(location, 'file_write_content', 'continue')
    if (fault === 'patch_after_applied') {
      const pending = onlyInterrupt(result)
      expect(pending.value.actionRequests[0].anasRecovery).toMatchObject({ ordinal: 1, state: 'uncertain' })
      result = await invokeRecovery(location, 'file_write_content', 'approve', pending.id)
    }
    expect(interrupts(result)).toEqual([])
    expect(toolResult(result, 'write_file')).toMatchObject({ ok: true, ...(record ? { operationId: record.operationId } : {}) })
    expect(readFileSync(target, 'utf8')).toBe('write after\n')
    if (fault !== 'patch_before_metadata') expect(statSync(target).ino).toBe(inode)
    expect(await store.listEditRecordsForRequest(location.runId)).toHaveLength(1)
  }, 45_000)

  it('restarts unpublished batch preparation only with durable unarmed proof', async () => {
    const location = createLocation('patch-unpublished')
    mkdirSync(location.fileWorkspaceDirectory, { recursive: true })
    const target = fileEditTarget(location)
    writeFileSync(target, 'write before\n')
    crashProcess(location, 'file_write', 'initial', 'patch_before_metadata')
    expect(readFileSync(target, 'utf8')).toBe('write before\n')
    expect(journalRows(location)).toMatchObject([{ state: 'prepared', effect_attempt: 0 }])
    const store = new FileEditStore(location.fileEditRecordsDirectory)
    expect(await store.listRetainedEditRecords()).toMatchObject([{ tool: 'unavailable', requestId: location.runId }])
    const recovered = await invokeRecovery(location, 'file_write', 'continue')
    expect(interrupts(recovered)).toEqual([])
    expect(toolResult(recovered, 'apply_patch')).toMatchObject({ ok: true })
    expect(readFileSync(target, 'utf8')).toBe('write after\n')
    expect(readFileSync(join(location.fileWorkspaceDirectory, 'second.txt'), 'utf8')).toBe('second\n')
    expect(await store.listEditRecordsForRequest(location.runId)).toHaveLength(1)
  }, 45_000)

  it.each(['patch_before_postimage', 'patch_after_partial', 'patch_after_applied', 'patch_before_history', 'patch_after_history', 'after_result', 'after_pending_write'] as const)(
    'recovers a real batch after %s with stable identity and no blind repeat', async (fault) => {
      const location = createLocation(fault)
      mkdirSync(location.fileWorkspaceDirectory, { recursive: true })
      const target = fileEditTarget(location)
      writeFileSync(target, 'write before\n')
      crashProcess(location, 'file_write', 'initial', fault)
      const store = new FileEditStore(location.fileEditRecordsDirectory)
      const [record] = await store.listEditRecordsForRequest(location.runId)
      const immutable = readFileSync(join(store.editRecordDir(location.runId, record.operationId), '0.before.txt'), 'utf8')
      expect(immutable).toBe('write before\n')
      const inode = statSync(target).ino
      let recovered = await invokeRecovery(location, 'file_write', 'continue')
      if (fault !== 'after_result' && fault !== 'after_pending_write') {
        const pending = onlyInterrupt(recovered)
        expect(pending.value.actionRequests[0].anasRecovery).toMatchObject({ ordinal: 1, state: 'uncertain' })
        recovered = await invokeRecovery(location, 'file_write', 'approve', pending.id)
      }
      expect(interrupts(recovered)).toEqual([])
      const result = toolResult(recovered, 'apply_patch')
      expect(result, JSON.stringify(result)).toMatchObject({ operationId: record.operationId, ok: fault !== 'patch_before_postimage' })
      // An unconfirmed rename is deliberately a conflict. A confirmed postimage
      // may resume later entries without replacing the first file a second time.
      expect(readFileSync(target, 'utf8')).toBe('write after\n')
      expect(statSync(target).ino).toBe(inode)
      if (fault !== 'patch_before_postimage') expect(readFileSync(join(location.fileWorkspaceDirectory, 'second.txt'), 'utf8')).toBe('second\n')
      expect(readFileSync(join(store.editRecordDir(location.runId, record.operationId), '0.before.txt'), 'utf8')).toBe(immutable)
      expect(await store.listEditRecordsForRequest(location.runId)).toHaveLength(1)
      if (fault === 'patch_before_history' || fault === 'patch_after_history') {
        await drainFileEditCleanup(location)
        const database = AgentDatabase.open(location.databaseFile, location.attachmentsDirectory)
        try {
          const archived = await database.fileChanges.load(location.runId, record.operationId)
          expect(archived?.transaction.entries.map((entry) => entry.after?.text)).toEqual(['write after\n', 'second\n'])
          const confirmed = database.fileChanges.events(location.runId, record.operationId).filter((event) => event.phase === 'applied')
          expect(confirmed).toHaveLength(2)
          expect(confirmed[0].observed).toBe(fault === 'patch_before_history' ? 1 : 0)
        } finally { database.close() }
      }
    }, 45_000)

  it('does not recreate missing metadata after the batch effect was armed', async () => {
    const location = createLocation('patch-missing-metadata')
    mkdirSync(location.fileWorkspaceDirectory, { recursive: true })
    const target = fileEditTarget(location)
    writeFileSync(target, 'write before\n')
    crashProcess(location, 'file_write', 'initial', 'patch_after_partial')
    const store = new FileEditStore(location.fileEditRecordsDirectory)
    const [record] = await store.listEditRecordsForRequest(location.runId)
    const directory = store.editRecordDir(record.requestId, record.operationId)
    rmSync(join(directory, 'record.json'))
    const pending = onlyInterrupt(await invokeRecovery(location, 'file_write', 'continue'))
    const result = await invokeRecovery(location, 'file_write', 'approve', pending.id)
    expect(toolResult(result, 'apply_patch')).toMatchObject({ ok: false })
    expect(readFileSync(target, 'utf8')).toBe('write after\n')
    expect(readFileSync(join(directory, '0.before.txt'), 'utf8')).toBe('write before\n')
    expect(existsSync(join(directory, 'record.json'))).toBe(false)
  }, 45_000)

  it.each([true, false])('resumes a partially completed inverse for an existing=%s source as one operation', async (existing) => {
    const { location, originRecord, target, before } = await createRestoreLocation(`patch-inverse-${existing}`, existing)
    const store = new FileEditStore(location.fileEditRecordsDirectory)
    crashProcess(location, existing ? 'file_restore_existing' : 'file_restore_created', 'initial', 'patch_after_partial')
    const [inverse] = await store.listEditRecordsForRequest(location.runId)
    expect(inverse.transaction.restores?.operationId).toBe(originRecord.operationId)
    const source = await store.loadOperationRecord(originRecord.operationId, originRecord.requestId)
    expect(source.transaction.reverseAttempt?.operationId).toBe(inverse.operationId)
    const scenario = existing ? 'file_restore_existing' : 'file_restore_created'
    const pending = onlyInterrupt(await invokeRecovery(location, scenario, 'continue'))
    const recovered = await invokeRecovery(location, scenario, 'approve', pending.id)
    expect(toolResult(recovered, 'restore_file_edit')).toMatchObject({ ok: true, operationId: inverse.operationId })
    if (existing) expect(readFileSync(target, 'utf8')).toBe(before)
    else expect(existsSync(target)).toBe(false)
    expect(existsSync(join(location.fileWorkspaceDirectory, 'second.txt'))).toBe(false)
    expect((await store.loadOperationRecord(originRecord.operationId, originRecord.requestId)).transaction.recovery?.state).toBe('complete')
    expect(await store.listEditRecordsForRequest(location.runId)).toHaveLength(1)
  }, 45_000)

  it('replays finalized restore history without overwriting later changes', async () => {
    const { location, originRecord, target } = await createRestoreLocation('patch-finalized', true)
    crashProcess(location, 'file_restore_existing', 'initial', 'patch_after_finalized')
    writeFileSync(target, 'later user change')
    const pending = onlyInterrupt(await invokeRecovery(location, 'file_restore_existing', 'continue'))
    const recovered = await invokeRecovery(location, 'file_restore_existing', 'approve', pending.id)
    expect(toolResult(recovered, 'restore_file_edit')).toMatchObject({ ok: true })
    expect(readFileSync(target, 'utf8')).toBe('later user change')
    const store = new FileEditStore(location.fileEditRecordsDirectory)
    expect((await store.loadOperationRecord(originRecord.operationId, originRecord.requestId)).transaction.recovery?.state).toBe('complete')
  }, 45_000)

  it('cleans both sides of a finalized restore after cancelling its interrupted run', async () => {
    const { location, originRecord, target, before } = await createRestoreLocation('patch-finalized-cancel', true)
    crashProcess(location, 'file_restore_existing', 'initial', 'patch_after_finalized')
    const database = AgentDatabase.open(location.databaseFile, location.attachmentsDirectory)
    try { expect(database.cancelRecoverableRun(location.runId)).toBe(true) } finally { database.close() }
    expect(new Set(fileEditCleanupRunIds(location))).toEqual(new Set([location.runId, originRecord.requestId]))
    expect(retainedFileEditOperationIds(location, originRecord.requestId)).toEqual([])
    await drainFileEditCleanup(location)
    expect(fileEditCleanupRunIds(location)).toEqual([])
    const store = new FileEditStore(location.fileEditRecordsDirectory)
    expect(await store.listEditRecordsForRequest(location.runId)).toEqual([])
    expect(await store.listEditRecordsForRequest(originRecord.requestId)).toEqual([])
    expect(readFileSync(target, 'utf8')).toBe(before)
  }, 45_000)

  const boundaries: Array<{
    fault: Exclude<ToolEffectHardCrashFault, 'none'>
    state?: JournalRow['state']
    attempts?: number
    effectsAfterCrash: number
    uncertain: boolean
  }> = [
    {
      fault: 'before_prepare',
      effectsAfterCrash: 0,
      uncertain: false
    },
    {
      fault: 'after_prepare',
      state: 'prepared',
      attempts: 0,
      effectsAfterCrash: 0,
      uncertain: false
    },
    {
      fault: 'after_arm',
      state: 'intent',
      attempts: 1,
      effectsAfterCrash: 0,
      uncertain: true
    },
    {
      fault: 'after_effect',
      state: 'intent',
      attempts: 1,
      effectsAfterCrash: 1,
      uncertain: true
    },
    {
      fault: 'after_result',
      state: 'result',
      attempts: 1,
      effectsAfterCrash: 1,
      uncertain: false
    },
    {
      fault: 'after_pending_write',
      effectsAfterCrash: 1,
      uncertain: false
    }
  ]

  it.each(boundaries)(
    'recovers the $fault boundary without an unapproved duplicate effect',
    async ({ fault, state, attempts, effectsAfterCrash, uncertain }) => {
      const location = createLocation(fault)
      crashProcess(location, 'single', 'initial', fault)

      expect(effects(location)).toHaveLength(effectsAfterCrash)
      const crashedRows = journalRows(location)
      if (state) {
        expect(crashedRows).toHaveLength(1)
        expect(crashedRows[0]).toMatchObject({
          state,
          effect_attempt: attempts,
          confirmation_count: 0,
          tool_name: 'pwsh'
        })
      } else {
        expect(crashedRows).toEqual([])
      }

      const recovered = await invokeRecovery(location, 'single', 'continue')
      if (uncertain) {
        const pending = onlyInterrupt(recovered)
        expect(pending.value.actionRequests[0]).toMatchObject({
          name: 'pwsh',
          anasRecovery: { ordinal: 1, state: 'uncertain' }
        })
        expect(effects(location)).toHaveLength(effectsAfterCrash)
        const rejected = await invokeRecovery(
          location,
          'single',
          'reject',
          pending.id
        )
        expect(interrupts(rejected)).toEqual([])
      } else {
        expect(interrupts(recovered)).toEqual([])
        expect(effects(location)).toHaveLength(1)
      }

      expect(journalRows(location)).toEqual([])
      if (fault === 'after_pending_write') {
        expect(traces(location).filter((row) => row.event === 'prepare:before')).toHaveLength(1)
        expect(traces(location).some((row) => row.event === 'pending_write:after')).toBe(true)
      } else {
        expectStablePreparedIdentity(location)
      }
    },
    30_000
  )

  it('does not reuse an old approval after the approved attempt also hard-crashes', async () => {
    const location = createLocation('approved-second-crash')
    crashProcess(location, 'single', 'initial', 'after_effect')
    expect(effects(location)).toEqual(['single'])

    const firstPending = onlyInterrupt(
      await invokeRecovery(location, 'single', 'continue')
    )
    expect(firstPending.value.actionRequests[0].anasRecovery.ordinal).toBe(1)

    crashProcess(
      location,
      'single',
      'approve',
      'after_effect',
      undefined,
      firstPending.id
    )
    expect(effects(location)).toEqual(['single', 'single'])
    expect(journalRows(location)[0]).toMatchObject({
      state: 'intent',
      effect_attempt: 2,
      confirmation_count: 1
    })

    const secondPending = onlyInterrupt(
      await invokeRecovery(location, 'single', 'approve', firstPending.id)
    )
    expect(secondPending.id).toBe(firstPending.id)
    expect(secondPending.value.actionRequests[0].anasRecovery.ordinal).toBe(2)
    expect(effects(location)).toEqual(['single', 'single'])
    expect(journalRows(location)[0].confirmation_count).toBe(1)

    const rejected = await invokeRecovery(
      location,
      'single',
      'reject',
      secondPending.id
    )
    expect(interrupts(rejected)).toEqual([])
    expect(effects(location)).toEqual(['single', 'single'])
    expect(journalRows(location)).toEqual([])
    expectStablePreparedIdentity(location)
  }, 45_000)

  it('keeps an ordinary host-file approval separate from a later effect recovery', async () => {
    const location = createLocation('host-file-hitl-separation')
    const ordinaryPending = onlyInterrupt(
      await invokeRecovery(location, 'host_file_hitl', 'initial')
    )
    expect(ordinaryPending.value.actionRequests[0]).toMatchObject({
      name: 'delete_file',
      args: { path: '/host/outside-workspace/fixture.txt' },
      description: 'Access a host file path outside the project folders.'
    })
    expect(ordinaryPending.value.actionRequests[0]).not.toHaveProperty('anasRecovery')
    expect(effects(location)).toEqual([])
    expect(journalRows(location)).toEqual([])

    const ordinaryWrites = durableInterruptWriteIdentities(location)
    expect(ordinaryWrites).toHaveLength(1)
    const ordinaryIdentity = ordinaryWrites[0]
    expect(ordinaryIdentity.checkpoint_ns).toBe('')

    crashProcess(
      location,
      'host_file_hitl',
      'approve',
      'after_effect',
      undefined,
      ordinaryPending.id
    )
    expect(effects(location)).toEqual([
      'host-file:/host/outside-workspace/fixture.txt'
    ])
    expect(durableWriteChannelsAt(location, ordinaryIdentity)).toEqual([])

    const [uncertainRow] = journalRows(location)
    expect(uncertainRow).toMatchObject({
      tool_name: 'delete_file',
      state: 'intent',
      effect_attempt: 1,
      confirmation_count: 0,
      checkpoint_ns: `tools:${uncertainRow.task_id}`,
      write_checkpoint_ns: ''
    })
    expect(uncertainRow.checkpoint_id).not.toBe(ordinaryIdentity.checkpoint_id)
    expect(uncertainRow.task_id).not.toBe(ordinaryIdentity.task_id)

    const recoveryPending = onlyInterrupt(
      await invokeRecovery(location, 'host_file_hitl', 'continue')
    )
    expect(recoveryPending.id).not.toBe(ordinaryPending.id)
    expect(recoveryPending.value.actionRequests[0]).toMatchObject({
      name: 'delete_file',
      anasRecovery: { ordinal: 1, state: 'uncertain' }
    })
    expect(effects(location)).toEqual([
      'host-file:/host/outside-workspace/fixture.txt'
    ])
    expect(journalRows(location)[0]).toMatchObject({
      state: 'intent',
      effect_attempt: 1,
      confirmation_count: 0
    })

    const rejected = await invokeRecovery(
      location,
      'host_file_hitl',
      'reject',
      recoveryPending.id
    )
    expect(interrupts(rejected)).toEqual([])
    expect(effects(location)).toEqual([
      'host-file:/host/outside-workspace/fixture.txt'
    ])
    expect(journalRows(location)).toEqual([])
  }, 45_000)

  it('replays a durable rejection after a crash without asking or executing again', async () => {
    const location = createLocation('rejected-result-crash')
    crashProcess(location, 'single', 'initial', 'after_effect')
    const pending = onlyInterrupt(await invokeRecovery(location, 'single', 'continue'))

    crashProcess(
      location,
      'single',
      'reject',
      'after_result',
      undefined,
      pending.id
    )
    expect(effects(location)).toEqual(['single'])
    expect(journalRows(location)[0]).toMatchObject({
      state: 'result',
      effect_attempt: 1,
      confirmation_count: 1
    })

    const recovered = await invokeRecovery(location, 'single', 'reject', pending.id)
    expect(interrupts(recovered)).toEqual([])
    expect(effects(location)).toEqual(['single'])
    expect(journalRows(location)).toEqual([])
  }, 45_000)

  it('completes an independent sibling while another task awaits recovery after a hard restart', async () => {
    const location = createLocation('parallel-siblings')
    crashProcess(location, 'parallel', 'initial', 'after_effect', 'pwsh')
    expect(effects(location)).toEqual(['left'])
    expect(journalRows(location)).toMatchObject([
      {
        tool_name: 'pwsh',
        state: 'intent',
        effect_attempt: 1
      },
      {
        tool_name: 'save_to_memory',
        state: 'prepared',
        effect_attempt: 0
      }
    ])

    const pending = onlyInterrupt(
      await invokeRecovery(location, 'parallel', 'continue')
    )
    expect(pending.value.actionRequests[0]).toMatchObject({
      name: 'pwsh',
      anasRecovery: { ordinal: 1 }
    })
    expect(effects(location)).toEqual(['left', 'right'])
    expect(journalRows(location)).toMatchObject([
      { tool_name: 'pwsh', state: 'intent' }
    ])

    const completed = await invokeRecovery(
      location,
      'parallel',
      'approve',
      pending.id
    )
    expect(interrupts(completed)).toEqual([])
    expect(effects(location)).toEqual(['left', 'right', 'left'])
    expect(journalRows(location)).toEqual([])
  }, 30_000)

  it('replays a durable sibling result while recovering another task after a hard restart', async () => {
    const location = createLocation('parallel-mixed-result-intent')
    crashProcess(
      location,
      'parallel',
      'initial',
      'parallel_result_pending_sibling_intent'
    )
    expect(effects(location)).toEqual(['left'])
    const mixed = journalRows(location)
    expect(mixed).toMatchObject([
      {
        tool_name: 'pwsh',
        state: 'result',
        effect_attempt: 1,
        confirmation_count: 0
      },
      {
        tool_name: 'save_to_memory',
        state: 'intent',
        effect_attempt: 1,
        confirmation_count: 0
      }
    ])
    expect(durableWriteChannels(location, mixed[0])).not.toContain('messages')

    const siblingOutput = await invokeRecovery(
      location,
      'parallel',
      'continue'
    )
    const siblingInterrupts = productVisibleInterrupts(siblingOutput)
    expect(siblingInterrupts, JSON.stringify({
      rawInterrupts: interrupts(siblingOutput),
      effects: effects(location),
      journal: journalRows(location)
    })).toHaveLength(1)
    const siblingPending = siblingInterrupts[0]
    expect(siblingPending.value.actionRequests[0]).toMatchObject({
      name: 'save_to_memory',
      anasRecovery: { ordinal: 1, state: 'uncertain' }
    })
    expect(effects(location)).toEqual(['left'])
    expect(journalRows(location)).toMatchObject([{
      tool_name: 'save_to_memory',
      state: 'intent',
      confirmation_count: 0
    }])

    const rejected = await invokeRecovery(
      location,
      'parallel',
      'reject',
      siblingPending.id
    )
    expect(interrupts(rejected)).toEqual([])
    expect(effects(location)).toEqual(['left'])
    expect(journalRows(location)).toEqual([])
  }, 45_000)

  it('recovers a nested child tool with its parent SqliteSaver namespace', async () => {
    const location = createLocation('nested-child')
    crashProcess(location, 'nested', 'initial', 'after_effect')
    expect(effects(location)).toEqual(['child'])
    const [row] = journalRows(location)
    expect(row.state).toBe('intent')
    expect(row.checkpoint_ns).toMatch(/^child_agent:[^|]+\|tools:/u)
    expect(row.write_checkpoint_ns).toBe(
      row.checkpoint_ns.slice(0, row.checkpoint_ns.lastIndexOf('|tools:'))
    )

    const pending = onlyInterrupt(
      await invokeRecovery(location, 'nested', 'continue')
    )
    expect(pending.value.actionRequests[0].anasRecovery.ordinal).toBe(1)
    expect(effects(location)).toEqual(['child'])

    const rejected = await invokeRecovery(
      location,
      'nested',
      'reject',
      pending.id
    )
    expect(interrupts(rejected)).toEqual([])
    expect(effects(location)).toEqual(['child'])
    expect(journalRows(location)).toEqual([])
    expectStablePreparedIdentity(location)
  }, 30_000)
})
