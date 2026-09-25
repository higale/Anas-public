import Database from 'better-sqlite3'
import { defaultCapabilities } from '@shared/agentCapabilities'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentDatabase } from './agentDatabase'
import { FileEditStore, pathExists } from '../fileEditStore'
import { resolveFilePatchTargets } from '../filePatch'
import { asPatchInput } from '../filePatchTestFixtures'
import { captureFilePatchPreimages } from '../filePatchState'
import { runWithCurrentAgentToolEffect } from './toolEffectScope'
import { snapshotAgentDatabase } from './agentDatabaseBackup'
import type { FilePatchEditRecord } from '../filePatchRecord'
import { HumanMessage } from '@langchain/core/messages'

const roots: string[] = [], databases = new Set<AgentDatabase>(), rawDatabases = new Set<Database.Database>()
afterEach(async () => {
  for (const raw of rawDatabases) raw.close()
  rawDatabases.clear()
  for (const database of databases) database.close()
  databases.clear()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(onChange?: (runId: string) => void) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'anas-change-ledger-')))
  roots.push(root)
  const databasePath = join(root, 'agent.sqlite')
  let database = AgentDatabase.open(databasePath, join(root, 'attachments'), onChange)
  databases.add(database)
  const store = new FileEditStore(join(root, 'records'))
  const raw = new Database(databasePath)
  rawDatabases.add(raw)
  const newRun = () => {
    const thread = database.createThread()
    return database.createRun(thread.id, randomUUID(), 'agent', [], { kind: 'user', text: 'Edit files' })
  }
  const run = newRun()
  const scope = <T>(operation: () => T, observed = false) => runWithCurrentAgentToolEffect({
    persistFileChange: (record, recovered) => database.fileChanges.persist(record, observed || recovered), arm: () => undefined
  }, operation)
  const execute = async (operations: Parameters<typeof asPatchInput>[0]['operations'], requestId = run.id) => {
    const resolved = await resolveFilePatchTargets(asPatchInput({ operations }), root)
    const images = await captureFilePatchPreimages(resolved.targets)
    return scope(() => store.executePatch(resolved.input, images, requestId, { operationId: randomUUID() }))
  }
  return { root, databasePath, get database() { return database }, raw, store, run, newRun, scope, execute,
    reopen() {
      databases.delete(database); database.close()
      database = AgentDatabase.open(databasePath, join(root, 'attachments')); databases.add(database)
    } }
}

describe('durable file change ledger', () => {
  it('reads archived original text on demand, never replacing missing history with current files', async () => {
    const value = await fixture(), path = join(value.root, 'one')
    await writeFile(path, 'before\n')
    await value.execute([{ type: 'update', path: 'one', patch: '@@\n-before\n+after\n' }])
    await writeFile(path, 'unrelated current text')
    const page = value.database.fileChanges.queryRoundFiles({ runId: value.run.id })
    const input = { runId: value.run.id, version: page.version, filePath: path }
    expect(value.database.fileChanges.readRoundContent(input)).toMatchObject({ status: 'ready', before: 'before\n', after: 'after\n' })
    value.raw.prepare('UPDATE agent_file_change_contents SET content = ? WHERE hash = ?').run('damaged', page.files[0].beforeHash)
    expect(value.database.fileChanges.readRoundContent(input)).toMatchObject({ status: 'unavailable', reason: 'history_missing' })
    expect(() => value.database.fileChanges.readRoundContent({ ...input, filePath: join(value.root, 'missing') })).toThrow('selected round')
  })

  it('lists only changed root rounds in the selected conversation and pages newest first', async () => {
    const value = await fixture()
    await value.execute([{ type: 'create', path: 'first', content: 'first' }])
    value.database.finishRun(value.run.id, 'cancelled')
    const empty = value.database.createRun(value.run.threadId, randomUUID(), 'agent', [], { kind: 'user', text: 'No files' })
    value.database.finishRun(empty.id, 'cancelled')
    const latest = value.database.createRun(value.run.threadId, randomUUID(), 'agent', [], { kind: 'user', text: 'Latest edits' })
    const config = { index: 0, name: 'coder', enabled: true, builtIn: false, description: 'Coding', systemPrompt: 'Code.', capabilities: structuredClone(defaultCapabilities) }
    const child = value.database.createSubagentCall({ id: randomUUID(), ownerThreadId: value.run.threadId,
      parentThreadId: value.run.threadId, parentRunId: latest.id, childThreadId: randomUUID(), childRunId: randomUUID(),
      config, description: 'Child', childThread: {} })
    const nested = value.database.createSubagentCall({ id: randomUUID(), ownerThreadId: value.run.threadId,
      parentThreadId: child.childThreadId, parentRunId: child.childRunId, parentSubagentId: child.id,
      childThreadId: randomUUID(), childRunId: randomUUID(), config, description: 'Nested', childThread: {} })
    await value.execute([{ type: 'create', path: 'nested', content: 'nested' }], nested.childRunId)
    const unrelated = value.newRun()
    await value.execute([{ type: 'create', path: 'unrelated', content: 'unrelated' }], unrelated.id)
    const page = value.database.fileChanges.listRounds({ threadId: value.run.threadId, limit: 1 })
    expect(page).toMatchObject({ rounds: [{ runId: latest.id, summary: 'Latest edits' }], hasMore: true })
    expect(value.database.fileChanges.listRounds({ threadId: value.run.threadId, limit: 1, after: page.nextAfter }))
      .toMatchObject({ rounds: [{ runId: value.run.id }], hasMore: false })
    const round = value.database.fileChanges.queryRoundFiles({ runId: latest.id })
    expect(round.files.map((file) => file.path)).toEqual([join(value.root, 'nested')])
    expect(round.files[0].origins.map((origin) => origin.runId)).toEqual([nested.childRunId])
    expect(round.pendingRunIds).toEqual(expect.arrayContaining([latest.id, child.childRunId, nested.childRunId]))
  })

  it('uses a bounded user-facing round summary after the input intent has been consumed', async () => {
    const value = await fixture()
    await value.execute([{ type: 'create', path: 'one', content: 'one' }])
    await value.database.checkpointer.put({ configurable: { thread_id: value.run.threadId, checkpoint_ns: '' } }, {
      v: 4, id: randomUUID(), ts: new Date().toISOString(), channel_versions: {}, versions_seen: {}, channel_values: {
        messages: [new HumanMessage({ id: randomUUID(), content: 'Internal expanded prompt',
          additional_kwargs: { anas_run_id: value.run.id, anas_display_text: `Visible  request\n${'a'.repeat(200)}` } })]
      }
    }, { source: 'loop', step: 0, parents: {} })
    expect(value.database.getRunInputIntent(value.run.id)).toBeUndefined()
    const round = value.database.fileChanges.listRounds({ threadId: value.run.threadId }).rounds[0]
    expect(round.summary).toContain('Visible request ')
    expect(round.summary).not.toContain('Internal')
    expect(round.summary.length).toBeLessThanOrEqual(160)
  })

  it('distinguishes selected rounds outside the page or without edits from deleted and foreign rounds', async () => {
    const value = await fixture()
    await value.execute([{ type: 'create', path: 'first', content: 'first' }])
    value.database.finishRun(value.run.id, 'cancelled')
    const empty = value.database.createRun(value.run.threadId, randomUUID(), 'agent', [], { kind: 'user', text: 'No edits' })
    value.database.finishRun(empty.id, 'cancelled')
    const latest = value.database.createRun(value.run.threadId, randomUUID(), 'agent', [], { kind: 'user', text: 'Latest' })
    await value.execute([{ type: 'create', path: 'latest', content: 'latest' }], latest.id)
    const input = { threadId: value.run.threadId, limit: 1 }
    const offPage = value.database.fileChanges.listRounds({ ...input, selectedRunId: value.run.id })
    expect(offPage).toMatchObject({ rounds: [{ runId: latest.id }], hasMore: true,
      selectedRound: { runId: value.run.id, status: 'cancelled' } })
    expect(value.database.fileChanges.listRounds({ ...input, selectedRunId: empty.id }).selectedRound)
      .toMatchObject({ runId: empty.id, status: 'cancelled' })
    const onPage = value.database.fileChanges.listRounds({ ...input, selectedRunId: latest.id })
    expect(onPage.selectedRound).toEqual(onPage.rounds[0])
    expect(value.database.fileChanges.listRounds(input)).not.toHaveProperty('selectedRound')
    const unrelated = value.newRun()
    expect(value.database.fileChanges.listRounds({ ...input, selectedRunId: unrelated.id }).selectedRound).toBeNull()
    expect(value.database.fileChanges.listRounds({ ...input, selectedRunId: randomUUID() }).selectedRound).toBeNull()
    value.raw.prepare('DELETE FROM agent_runs WHERE id = ?').run(value.run.id)
    expect(value.database.fileChanges.listRounds({ ...input, selectedRunId: value.run.id }).selectedRound).toBeNull()
  })

  it('does not identify a subagent run or compression as a selectable main round', async () => {
    const value = await fixture()
    const config = { index: 0, name: 'coder', enabled: true, builtIn: false, description: 'Coding', systemPrompt: 'Code.', capabilities: structuredClone(defaultCapabilities) }
    const child = value.database.createSubagentCall({ id: randomUUID(), ownerThreadId: value.run.threadId,
      parentThreadId: value.run.threadId, parentRunId: value.run.id, childThreadId: randomUUID(), childRunId: randomUUID(),
      config, description: 'Child', childThread: {} })
    const childSelection = value.database.fileChanges.listRounds({ threadId: child.childThreadId, selectedRunId: child.childRunId })
    expect(childSelection.selectedRound).toBeNull()
    value.database.finishRun(value.run.id, 'cancelled')
    const compression = value.database.createRun(value.run.threadId, randomUUID(), 'compression', [], { kind: 'manual_compression' })
    expect(value.database.fileChanges.listRounds({ threadId: value.run.threadId, selectedRunId: compression.id }).selectedRound).toBeNull()
  })

  it('paginates whole files while retaining all writes across operation-page boundaries', async () => {
    const value = await fixture(), path = join(value.root, 'a')
    await value.execute([{ type: 'create', path: 'a', content: 'v0\n' }])
    for (let index = 0; index < 22; index++) {
      await value.execute([{ type: 'update', path: 'a', patch: `@@\n-v${index}\n+v${index + 1}\n` }])
    }
    await value.execute([{ type: 'create', path: 'z', content: 'other' }])
    const first = value.database.fileChanges.queryRoundFiles({ runId: value.run.id, limit: 1 })
    expect(first).toMatchObject({ hasMore: true, files: [{ path, beforeExists: false, afterExists: true, continuity: 'recorded' }] })
    expect(first.files[0].origins).toHaveLength(23)
    expect(value.database.fileChanges.readRoundContent({ runId: value.run.id, filePath: path, version: first.version }))
      .toMatchObject({ status: 'ready', before: '', after: 'v22\n' })
    const next = value.database.fileChanges.queryRoundFiles({ runId: value.run.id, limit: 1, after: first.nextAfter, version: first.version })
    expect(next).toMatchObject({ hasMore: false, files: [{ path: join(value.root, 'z'), continuity: 'recorded' }] })
    await value.execute([{ type: 'update', path: 'a', patch: '@@\n-v22\n+changed\n' }])
    expect(() => value.database.fileChanges.queryRoundFiles({ runId: value.run.id, version: first.version })).toThrow('restart pagination')
  })

  it('keeps an external gap visible while comparing the first and final recorded images once per file', async () => {
    const value = await fixture(), path = join(value.root, 'one')
    await writeFile(path, 'original\n')
    await value.execute([{ type: 'update', path: 'one', patch: '@@\n-original\n+first\n' }])
    await writeFile(path, 'external\n')
    await value.execute([{ type: 'update', path: 'one', patch: '@@\n-external\n+last\n' }])
    const page = value.database.fileChanges.queryRoundFiles({ runId: value.run.id })
    expect(page.files).toHaveLength(1)
    expect(page.files[0]).toMatchObject({ continuity: 'external_change', cancelledOut: false })
    expect(value.database.fileChanges.readRoundContent({ runId: value.run.id, filePath: path, version: page.version }))
      .toMatchObject({ status: 'ready', before: 'original\n', after: 'last\n' })
  })

  it('does not choose arbitrary round endpoints when event order is uncertain', async () => {
    const value = await fixture(), path = join(value.root, 'one')
    const first = await value.execute([{ type: 'create', path: 'one', content: 'first\n' }])
    await value.execute([{ type: 'update', path: 'one', patch: '@@\n-first\n+last\n' }])
    value.raw.prepare("UPDATE agent_file_change_events SET sequence = sequence + 1000 WHERE operation_id = ? AND phase = 'applied'").run(first.operationId)
    const page = value.database.fileChanges.queryRoundFiles({ runId: value.run.id })
    expect(page.files).toHaveLength(1)
    expect(page.files[0]).toMatchObject({ continuity: 'uncertain', cancelledOut: false })
    expect(page.files[0].beforeHash).toBeUndefined()
    expect(value.database.fileChanges.readRoundContent({ runId: value.run.id, filePath: path, version: page.version }))
      .toMatchObject({ status: 'unavailable', reason: 'history_missing' })
  })

  it('reads only the requested historical endpoint and keeps a missing after independent of before', async () => {
    const value = await fixture(), path = join(value.root, 'one')
    await writeFile(path, 'before\n')
    await value.execute([{ type: 'update', path: 'one', patch: '@@\n-before\n+after\n' }])
    const page = value.database.fileChanges.queryRoundFiles({ runId: value.run.id })
    value.raw.prepare('UPDATE agent_file_change_contents SET content = ? WHERE hash = ?').run('damaged after', page.files[0].afterHash)
    const input = { runId: value.run.id, filePath: path, version: page.version }
    expect(value.database.fileChanges.queryRoundFiles({ runId: value.run.id }).files).toHaveLength(1)
    expect(value.database.fileChanges.readRoundContent(input)).toMatchObject({ status: 'unavailable', reason: 'history_missing' })
    expect(value.database.fileChanges.readRoundContent(input, 'before')).toMatchObject({ status: 'ready', before: 'before\n' })
  })

  it('notifies after committed changes and cleanup, but not no-op persistence or failed transactions', async () => {
    const changed = vi.fn()
    const value = await fixture(changed)
    changed.mockImplementation((runId: string) => {
      expect(runId).toBe(value.run.id)
      expect(value.raw.inTransaction).toBe(false)
      expect(value.database.fileChanges.query({ runId }, value.root).operationCount).toBe(1)
    })
    const edit = await value.execute([{ type: 'create', path: 'one', content: 'one' }])
    expect(changed).toHaveBeenCalled()
    const record = await value.database.fileChanges.load(value.run.id, edit.operationId)
    if (!record) throw new Error('Missing record')
    changed.mockClear()
    value.database.fileChanges.persist(record)
    expect(changed).not.toHaveBeenCalled()
    expect(() => value.database.fileChanges.persist({ ...record, revision: record.revision - 1 })).toThrow()
    expect(changed).not.toHaveBeenCalled()
    value.database.finishRun(value.run.id, 'cancelled')
    value.database.acknowledgeFileEditCleanup(value.run.id)
    expect(changed).toHaveBeenCalledExactlyOnceWith(value.run.id)
    value.database.acknowledgeFileEditCleanup(value.run.id)
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('queries persistent history after recovery cleanup and combines only proven consecutive edits', async () => {
    const value = await fixture()
    await writeFile(join(value.root, 'one'), 'before\n')
    await value.execute([{ type: 'update', path: 'one', patch: '@@\n-before\n+middle\n' }])
    await value.execute([{ type: 'update', path: 'one', patch: '@@\n-middle\n+after\n' }])
    value.database.finishRun(value.run.id, 'cancelled')
    await value.scope(() => value.store.deleteFileEditRecordsForRequest(value.run.id), true)
    value.database.acknowledgeFileEditCleanup(value.run.id)
    value.reopen()
    const result = value.database.fileChanges.query({ runId: value.run.id }, value.root)
    expect(result).toMatchObject({ complete: true, netDiffAvailable: true, operationCount: 2, hasMore: false })
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0].origins).toHaveLength(2)
    expect(result.patch).toContain('-before'); expect(result.patch).toContain('+after')
    expect(result.patch).not.toContain('middle')
  })

  it('keeps external edits out of net changes and does not use current disk text as history', async () => {
    const value = await fixture()
    await writeFile(join(value.root, 'one'), 'before\n')
    await value.execute([{ type: 'update', path: 'one', patch: '@@\n-before\n+first\n' }])
    await writeFile(join(value.root, 'one'), 'user\n')
    await value.execute([{ type: 'update', path: 'one', patch: '@@\n-user\n+second\n' }])
    await writeFile(join(value.root, 'one'), 'unrelated latest disk edit')
    value.database.finishRun(value.run.id, 'cancelled')
    value.database.acknowledgeFileEditCleanup(value.run.id)
    const result = value.database.fileChanges.query({ runId: value.run.id }, value.root)
    expect(result.segments.map((segment) => segment.continuity)).toEqual(['recorded', 'external_change'])
    expect(result.netDiffAvailable).toBe(false)
    expect(result.patch).toContain('-user'); expect(result.patch).not.toContain('latest disk')
  })

  it('marks overlapping commit intervals uncertain instead of choosing an order by timestamp', async () => {
    const value = await fixture()
    const first = await value.execute([{ type: 'create', path: 'one', content: 'first\n' }])
    await value.execute([{ type: 'update', path: 'one', patch: '@@\n-first\n+second\n' }])
    value.raw.prepare("UPDATE agent_file_change_events SET sequence = sequence + 1000 WHERE operation_id = ? AND phase = 'applied'").run(first.operationId)
    value.database.finishRun(value.run.id, 'cancelled')
    value.database.acknowledgeFileEditCleanup(value.run.id)
    const result = value.database.fileChanges.query({ runId: value.run.id }, value.root)
    expect(result.segments).toHaveLength(2)
    expect(result.segments[1].continuity).toBe('uncertain')
    expect(result.complete).toBe(false); expect(result.netDiffAvailable).toBe(false)
  })

  it('paginates with a version, rejects stale cursors, and preserves existence-only changes', async () => {
    const value = await fixture()
    const first = await value.execute([{ type: 'create', path: 'empty', content: '' }])
    await value.execute([{ type: 'create', path: 'two', content: 'two' }])
    const one = value.database.fileChanges.query({ runId: value.run.id, limit: 1 }, value.root)
    expect(one).toMatchObject({ hasMore: true, complete: false, netDiffAvailable: false, operationCount: 1 })
    expect(one.patch).toContain('new file mode')
    const two = value.database.fileChanges.query({ runId: value.run.id, limit: 1, after: one.nextAfter, version: one.version }, value.root)
    expect(two.segments[0].path).toBe(join(value.root, 'two'))
    expect(two.hasMore).toBe(false); expect(two.complete).toBe(false)
    const tiny = value.database.fileChanges.query({ runId: value.run.id, operationId: first.operationId, maxChars: 1 }, value.root)
    expect(tiny.patch.length).toBeLessThanOrEqual(1); expect(tiny.patchTruncated).toBe(true)
    await value.execute([{ type: 'create', path: 'three', content: 'three' }])
    expect(() => value.database.fileChanges.query({ runId: value.run.id, after: one.nextAfter, version: one.version }, value.root)).toThrow('restart pagination')
    expect(() => value.database.fileChanges.query({ runId: value.run.id, limit: 101 }, value.root)).toThrow('bounds')
    expect(() => value.database.fileChanges.query({ runId: randomUUID() }, value.root)).toThrow('not found')
  })

  it('includes only actual nested descendants, retains actors, and de-duplicates parent activity projections', async () => {
    const value = await fixture()
    const config = { index: 0, name: 'coder', enabled: true, builtIn: false, description: 'Coding', systemPrompt: 'Implement the assigned task.', capabilities: structuredClone(defaultCapabilities) }
    const child = value.database.createSubagentCall({ id: randomUUID(), ownerThreadId: value.run.threadId,
      parentThreadId: value.run.threadId, parentRunId: value.run.id, childThreadId: randomUUID(), childRunId: randomUUID(), config, description: 'Child', childThread: {} })
    const nested = value.database.createSubagentCall({ id: randomUUID(), ownerThreadId: value.run.threadId,
      parentThreadId: child.childThreadId, parentRunId: child.childRunId, parentSubagentId: child.id,
      childThreadId: randomUUID(), childRunId: randomUUID(), config: { ...config, name: 'nested' }, description: 'Nested', childThread: {} })
    await value.execute([{ type: 'create', path: 'one', content: 'first\n' }], child.childRunId)
    await value.execute([{ type: 'update', path: 'one', patch: '@@\n-first\n+second\n' }], nested.childRunId)
    const childOnly = value.database.fileChanges.query({ runId: value.run.id }, value.root)
    expect(childOnly.operationCount).toBe(2)
    expect(childOnly.segments[0].origins.map((origin) => origin.actor)).toEqual(['coder', 'nested'])
    await value.execute([{ type: 'update', path: 'one', patch: '@@\n-second\n+last\n' }])
    const unrelated = value.newRun()
    await value.execute([{ type: 'create', path: 'unrelated', content: 'outside this run' }], unrelated.id)
    const active = value.database.fileChanges.query({ runId: value.run.id }, value.root)
    expect(active.operationCount).toBe(3); expect(active.pendingRunIds).toHaveLength(3)
    expect(active.segments).toHaveLength(1)
    expect(active.segments[0].origins.map((origin) => origin.actor)).toEqual(['coder', 'nested', 'root'])
    expect(active.complete).toBe(false)
    for (const id of [nested.childRunId, child.childRunId, value.run.id]) {
      value.database.finishRun(id, 'cancelled'); value.database.acknowledgeFileEditCleanup(id)
    }
    await value.scope(() => value.store.deleteFileEditRecordsForRequest(child.childRunId), true)
    value.reopen()
    const final = value.database.fileChanges.query({ runId: value.run.id }, value.root)
    expect(final).toMatchObject({ complete: true, netDiffAvailable: true, operationCount: 3 })
    expect(final.patch).not.toContain('unrelated')
    expect(final.segments[0].origins.map((origin) => origin.runId)).toEqual([child.childRunId, nested.childRunId, value.run.id])
  })

  it('counts a same-run inverse as a separate change that cancels the forward diff', async () => {
    const value = await fixture()
    const source = await value.execute([{ type: 'create', path: 'one', content: 'one' }])
    const inverse = await value.scope(() => value.store.restorePatch(source.operationId, source.requestId, value.run.id, async () => {}, { operationId: randomUUID() }))
    await value.scope(() => value.store.finalizePatchRestore(source.operationId, source.requestId, async () => {}, { inverse: { operationId: inverse!.operationId, requestId: value.run.id } }))
    value.database.finishRun(value.run.id, 'cancelled')
    value.database.acknowledgeFileEditCleanup(value.run.id)
    const result = value.database.fileChanges.query({ runId: value.run.id }, value.root)
    expect(result).toMatchObject({ netDiffAvailable: true, patch: '' })
    expect(result.segments).toHaveLength(1)
    expect(result.segments[0].cancelledOut).toBe(true)
    expect(result.segments[0].origins.map((origin) => origin.direction)).toEqual(['forward', 'inverse'])
    const round = value.database.fileChanges.queryRoundFiles({ runId: value.run.id })
    expect(round.files).toHaveLength(1)
    expect(round.files[0]).toMatchObject({ beforeExists: false, afterExists: false, cancelledOut: true })
  })

  it('reports missing snapshots and missing sequence proof instead of hiding gaps', async () => {
    const value = await fixture()
    const record = await value.execute([{ type: 'create', path: 'one', content: 'one' }])
    value.database.finishRun(value.run.id, 'cancelled')
    value.raw.prepare("DELETE FROM agent_file_change_events WHERE operation_id = ? AND phase = 'intent'").run(record.operationId)
    const uncertain = value.database.fileChanges.query({ runId: value.run.id }, value.root)
    expect(uncertain.segments[0].continuity).toBe('uncertain'); expect(uncertain.netDiffAvailable).toBe(false)
    value.raw.exec("UPDATE agent_file_change_contents SET content = 'bad'")
    const damaged = value.database.fileChanges.query({ runId: value.run.id }, value.root)
    expect(damaged.segments[0].unavailableReason).toContain('damaged'); expect(damaged.complete).toBe(false)
  })

  it('keeps retained file changes when replacing the message prefix discards only the later run', async () => {
    const value = await fixture()
    const retained = await value.execute([{ type: 'create', path: 'retained', content: 'same' }])
    const checkpointId = randomUUID()
    await value.database.checkpointer.put({ configurable: { thread_id: value.run.threadId, checkpoint_ns: '' } }, {
      v: 4, id: checkpointId, ts: new Date().toISOString(), channel_versions: {}, versions_seen: {},
      channel_values: { anasRunLifecycle: { runId: value.run.id, status: 'completed' } }
    }, { source: 'loop', step: 0, parents: {} })
    value.database.finishRun(value.run.id, 'completed')
    const removedRun = value.database.createRun(value.run.threadId, randomUUID(), 'agent', [], { kind: 'user', text: 'Later' })
    const removed = await value.execute([{ type: 'create', path: 'removed', content: 'same' }], removedRun.id)
    value.database.finishRun(removedRun.id, 'cancelled')
    await value.database.replaceMessageHistory(value.run.threadId, [], removedRun.id)
    value.database.acknowledgeFileEditCleanup(value.run.id)
    expect(value.database.getRun(value.run.id)).toMatchObject({ id: value.run.id, status: 'completed' })
    expect(value.database.getRun(removedRun.id)).toBeNull()
    expect(await value.database.fileChanges.load(value.run.id, retained.operationId)).toEqual(retained)
    expect(await value.database.fileChanges.load(removedRun.id, removed.operationId)).toBeUndefined()
    expect(value.raw.prepare('SELECT count(*) AS n FROM agent_file_change_contents').get()).toEqual({ n: 1 })
    const query = value.database.fileChanges.query({ runId: value.run.id }, value.root)
    expect(query).toMatchObject({ complete: true, operationCount: 1 })
    expect(query.patch).toContain('retained'); expect(query.patch).not.toContain('removed')
  })

  it('bounds descendant traversal and always includes the selected root', async () => {
    const value = await fixture()
    const config = { index: 0, name: 'coder', enabled: true, builtIn: false, description: 'Coding', systemPrompt: 'Implement the assigned task.', capabilities: structuredClone(defaultCapabilities) }
    for (let index = 0; index < 257; index++) value.database.createSubagentCall({ id: randomUUID(), ownerThreadId: value.run.threadId,
      parentThreadId: value.run.threadId, parentRunId: value.run.id, childThreadId: randomUUID(), childRunId: randomUUID(), config, description: 'Child', childThread: {} })
    const result = value.database.fileChanges.query({ runId: value.run.id }, value.root)
    expect(result.pendingRunIds).toHaveLength(256)
    expect(result.pendingRunIds).toContain(value.run.id)
    expect(result.complete).toBe(false)
    expect(result.issues[0].reason).toContain('256 runs')
    const round = value.database.fileChanges.queryRoundFiles({ runId: value.run.id })
    expect(round.pendingRunIds).toHaveLength(258)
    expect(round.issues).toEqual([])
  }, 20_000)

  it('does not claim completeness while cancelled-run cleanup is outstanding', async () => {
    const value = await fixture()
    await value.execute([{ type: 'create', path: 'one', content: 'one' }])
    value.database.finishRun(value.run.id, 'cancelled')
    const pending = value.database.fileChanges.query({ runId: value.run.id }, value.root)
    expect(pending).toMatchObject({ complete: false, pendingRunIds: [value.run.id] })
    await value.scope(() => value.store.deleteFileEditRecordsForRequest(value.run.id), true)
    value.database.acknowledgeFileEditCleanup(value.run.id)
    expect(value.database.fileChanges.query({ runId: value.run.id }, value.root).complete).toBe(true)
  })
  it('archives preparation before arming, and retains complete diffs after run cleanup and reopening', async () => {
    const value = await fixture()
    const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [{ type: 'create', path: '中文 空格.txt', content: '\ufeff内容\r\n' }] }), value.root)
    const preimages = await captureFilePatchPreimages(resolved.targets)
    let armed = false
    const record = await runWithCurrentAgentToolEffect({
      persistFileChange: (record, observed) => value.database.fileChanges.persist(record, observed),
      arm: () => {
        armed = true
        expect(value.raw.prepare('SELECT count(*) AS n FROM agent_file_changes').get()).toEqual({ n: 1 })
        expect(value.raw.prepare('SELECT count(*) AS n FROM agent_file_change_contents').get()).toEqual({ n: 1 })
      }
    }, () => value.store.executePatch(resolved.input, preimages, value.run.id, { operationId: randomUUID() }))
    expect(armed).toBe(true)
    value.database.finishRun(value.run.id, 'cancelled')
    await value.scope(() => value.store.deleteFileEditRecordsForRequest(value.run.id), true)
    expect(await pathExists(value.store.editRecordsDir(value.run.id))).toBe(false)
    await writeFile(join(value.root, '中文 空格.txt'), 'later user edit')
    value.reopen()
    const archived = await value.database.fileChanges.load(value.run.id, record.operationId)
    expect(archived?.transaction.entries[0].after?.text).toBe('\ufeff内容\r\n')
    expect(archived?.transaction.entries[0].before.text).toBeNull()
    const events = value.database.fileChanges.events(value.run.id, record.operationId)
    expect(events.map((item) => [item.phase, item.observed])).toEqual([['intent', 0], ['applied', 0]])
    expect(events[0].sequence).toBeLessThan(events[1].sequence)
  })

  it('aborts before target writes when the first history transaction fails', async () => {
    const value = await fixture()
    value.raw.exec(`CREATE TRIGGER fail_archive BEFORE INSERT ON agent_file_changes BEGIN SELECT RAISE(ABORT, 'archive unavailable'); END`)
    await expect(value.execute([{ type: 'create', path: 'never.txt', content: 'never' }])).rejects.toThrow('archive unavailable')
    expect(await pathExists(join(value.root, 'never.txt'))).toBe(false)
    expect(value.raw.prepare('SELECT count(*) AS n FROM agent_file_change_contents').get()).toEqual({ n: 0 })
    expect(await pathExists(value.store.editRecordsDir(value.run.id))).toBe(true)
  })

  it('does not remove recovery evidence or acknowledge cleanup if archival fails', async () => {
    const value = await fixture()
    const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [{ type: 'create', path: 'created.txt', content: 'created' }] }), value.root)
    const record = await value.store.executePatch(resolved.input, await captureFilePatchPreimages(resolved.targets), value.run.id, { operationId: randomUUID() })
    value.database.finishRun(value.run.id, 'cancelled')
    value.raw.exec(`CREATE TRIGGER fail_archive BEFORE INSERT ON agent_file_changes BEGIN SELECT RAISE(ABORT, 'archive unavailable'); END`)
    await expect(value.scope(() => value.store.deleteFileEditRecordsForRequest(value.run.id), true)).rejects.toThrow('archive unavailable')
    expect(await pathExists(value.store.editRecordDir(value.run.id, record.operationId))).toBe(true)
    expect(value.database.listFileEditCleanupRunIds()).toContain(value.run.id)
    value.raw.exec('DROP TRIGGER fail_archive')
    await value.scope(() => value.store.deleteFileEditRecordsForRequest(value.run.id), true)
    value.database.acknowledgeFileEditCleanup(value.run.id)
    expect(await value.database.fileChanges.load(value.run.id, record.operationId)).toEqual(record)
    expect(value.database.fileChanges.events(value.run.id, record.operationId).map((item) => [item.phase, item.observed])).toEqual([['applied', 1]])
  })

  it('deduplicates shared content and only collects snapshots when the last history reference is deleted', async () => {
    const value = await fixture(), secondRun = value.newRun()
    const first = await value.execute([{ type: 'create', path: 'one', content: 'same' }])
    const second = await value.execute([{ type: 'create', path: 'two', content: 'same' }], secondRun.id)
    expect(value.raw.prepare('SELECT count(*) AS n FROM agent_file_change_contents').get()).toEqual({ n: 1 })
    value.database.finishRun(value.run.id, 'cancelled'); value.database.finishRun(secondRun.id, 'cancelled')
    await value.database.deleteThread(value.run.threadId)
    expect(await value.database.fileChanges.load(value.run.id, first.operationId)).toBeUndefined()
    expect(await value.database.fileChanges.load(secondRun.id, second.operationId)).toEqual(second)
    expect(value.raw.prepare('SELECT count(*) AS n FROM agent_file_change_contents').get()).toEqual({ n: 1 })
    await value.database.deleteThread(secondRun.threadId)
    expect(value.raw.prepare('SELECT count(*) AS n FROM agent_file_change_contents').get()).toEqual({ n: 0 })
    expect(value.raw.prepare('SELECT count(*) AS n FROM agent_file_change_events').get()).toEqual({ n: 0 })
    value.scope(() => value.database.fileChanges.persist(first, true))
    expect(await value.database.fileChanges.load(value.run.id, first.operationId)).toBeUndefined()
  })

  it('backs up metadata and all required content together without recovery files', async () => {
    const value = await fixture()
    await writeFile(join(value.root, 'old'), 'old\n')
    const record = await value.execute([{ type: 'move', path: 'old', destination: 'new' }])
    await value.scope(() => value.store.deleteFileEditRecordsForRequest(value.run.id), true)
    const backupPath = join(value.root, 'backup.sqlite')
    await snapshotAgentDatabase(value.databasePath, backupPath)
    const backup = AgentDatabase.open(backupPath); databases.add(backup)
    expect(await backup.fileChanges.load(value.run.id, record.operationId)).toEqual(record)
    expect(backup.fileChanges.events(value.run.id, record.operationId)).toEqual(value.database.fileChanges.events(value.run.id, record.operationId))
  })

  it('rejects changed content, definition, confirmed images and revision rollback', async () => {
    const value = await fixture()
    const record = await value.execute([{ type: 'create', path: 'one', content: 'one' }])
    const changed = structuredClone(record); changed.transaction.entries[0].afterText = 'different'
    expect(() => value.database.fileChanges.persist(changed)).toThrow()
    const changedImage = structuredClone(record); changedImage.revision++
    changedImage.transaction.entries[0].after!.identity!.inode = '999'
    expect(() => value.database.fileChanges.persist(changedImage)).toThrow('immutable')
    expect(() => value.database.fileChanges.persist({ ...record, revision: record.revision - 1 })).toThrow('newer')
    value.raw.prepare('UPDATE agent_file_change_contents SET content = ?').run('damage')
    await expect(value.database.fileChanges.load(value.run.id, record.operationId)).rejects.toThrow('snapshot')
    expect(() => value.database.fileChanges.validateIntegrity()).toThrow('snapshot')
  })

  it('rejects a backup with missing snapshot references even when SQLite foreign keys remain valid', async () => {
    const value = await fixture()
    await value.execute([{ type: 'create', path: 'one', content: 'one' }])
    const projects = new Set([value.database.getThread(value.run.threadId)!.projectId])
    expect(() => AgentDatabase.validateBackup(value.databasePath, join(value.root, 'attachments'), projects)).not.toThrow()
    value.raw.exec('DELETE FROM agent_file_change_content_refs')
    expect(value.raw.pragma('foreign_key_check')).toEqual([])
    expect(() => AgentDatabase.validateBackup(value.databasePath, join(value.root, 'attachments'), projects)).toThrow('snapshot references')
  })

  it('keeps explicit inverse changes under their actual run and does not duplicate finalized recovery', async () => {
    const value = await fixture(), inverseRun = value.newRun()
    const source = await value.execute([{ type: 'create', path: 'one', content: 'one' }])
    const inverse = await value.scope(() => value.store.restorePatch(source.operationId, source.requestId, inverseRun.id, async () => {}, { operationId: randomUUID() }))
    expect(inverse).not.toBeNull()
    await value.scope(() => value.store.finalizePatchRestore(source.operationId, source.requestId, async () => {}, { inverse: { operationId: inverse!.operationId, requestId: inverse!.requestId } }))
    const before = value.database.fileChanges.events(inverseRun.id, inverse!.operationId)
    await value.scope(() => value.store.finalizePatchRestore(source.operationId, source.requestId, async () => {}))
    expect(value.database.fileChanges.events(inverseRun.id, inverse!.operationId)).toEqual(before)
    expect((await value.database.fileChanges.load(source.requestId, source.operationId))?.transaction.entries[0].afterText).toBe('one')
    expect((await value.database.fileChanges.load(inverseRun.id, inverse!.operationId))?.transaction.restores?.operationId).toBe(source.operationId)
  })

  it('archives actual compensation separately from the original write', async () => {
    const value = await fixture()
    const controller = new AbortController()
    const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [{ type: 'create', path: 'one', content: 'one' }, { type: 'create', path: 'two', content: 'two' }] }), value.root)
    const operationId = randomUUID()
    const preimages = await captureFilePatchPreimages(resolved.targets)
    const persist = (record: FilePatchEditRecord, observed: boolean) => {
      value.database.fileChanges.persist(record, observed)
      if (record.transaction.entries[0].state === 'applied') controller.abort()
    }
    await expect(runWithCurrentAgentToolEffect({ arm: () => undefined, persistFileChange: persist }, () => value.store.executePatch(resolved.input,
      preimages, value.run.id, { operationId, signal: controller.signal }))).rejects.toThrow('restored')
    const record = await value.store.loadOperationRecord(operationId, value.run.id)
    expect(record.transaction.state).toBe('restored')
    expect(await pathExists(join(value.root, 'one'))).toBe(false)
    expect(value.database.fileChanges.events(value.run.id, operationId).map((item) => item.phase)).toEqual(['intent', 'applied', 'restore_intent', 'restored'])
    expect(await readFile(join(value.root, 'one')).catch(() => null)).toBeNull()
  })
})
