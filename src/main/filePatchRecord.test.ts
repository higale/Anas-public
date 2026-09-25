import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileEditStore } from './fileEditStore'
import { resolveFilePatchTargets } from './filePatch'
import { asPatchInput } from './filePatchTestFixtures'
import { captureFilePatchPreimages } from './filePatchState'
import { executeFilePatchTransaction, type FilePatchTransaction } from './filePatchTransaction'
import { agentToolEffectArtifactId, runWithCurrentAgentToolEffect } from './agent/toolEffectScope'
import { createFileTools } from './llm/fileTools'
import { AgentDatabase } from './agent/agentDatabase'

const roots: string[] = []
const databases: AgentDatabase[] = []
afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function recordedHistory(value: Awaited<ReturnType<typeof fixture>>) {
  const database = AgentDatabase.open(':memory:'); databases.push(database)
  database.createRun(database.createThread().id, value.requestId, 'agent', [], { kind: 'user', text: 'Inspect batch history' })
  database.fileChanges.persist(await value.store.loadOperationRecord(value.operationId, value.requestId), true)
  return database.fileChanges
}
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'anas-patch-record-')))
  roots.push(root)
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  const store = new FileEditStore(join(root, 'records'))
  const requestId: string = randomUUID()
  const operationId: string = randomUUID()
  await writeFile(join(workspace, 'old.txt'), 'before\n')
  const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [
    { type: 'update', path: 'old.txt', patch: '@@\n-before\n+after\n' },
    { type: 'create', path: 'nested/empty.txt', content: '' }
  ] }), workspace)
  const preimages = await captureFilePatchPreimages(resolved.targets)
  return { root, workspace, store, requestId, operationId, input: resolved.input, preimages }
}

async function preparedRecord(value: Awaited<ReturnType<typeof fixture>>): Promise<FilePatchTransaction> {
  let prepared!: FilePatchTransaction
  await expect(executeFilePatchTransaction(value.operationId, value.input, value.preimages, async (record) => {
    prepared = structuredClone(record)
    throw new Error('stop before effects')
  })).rejects.toThrow('stop before effects')
  return prepared
}

describe('durable batch operation records', () => {
  it('distinguishes same-named files in operation and request diffs outside the process cwd', async () => {
    const value = await fixture()
    const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [
      { type: 'create', path: 'client/index.ts', content: 'client\n' },
      { type: 'create', path: 'server/index.ts', content: 'server\n' }
    ] }), value.workspace)
    await value.store.executePatch(resolved.input, await captureFilePatchPreimages(resolved.targets), value.requestId, { operationId: value.operationId })
    const tool = createFileTools({ maxReadBytes: 1_000_000, primaryFolder: value.workspace, requestId: value.requestId, fileEditStore: value.store, fileChanges: await recordedHistory(value) })
      .find((item) => item.name === 'get_file_edit_diff')!
    for (const scope of ['operation', 'request']) {
      const result = JSON.parse(String(await tool.invoke({ scope, operation_id: value.operationId })))
      expect(result.patch).toContain('b/client/index.ts')
      expect(result.patch).toContain('b/server/index.ts')
      expect(result.patch).not.toContain('b/index.ts')
    }
  })

  it('reports a damaged entry without hiding other retained operations', async () => {
    const value = await fixture()
    await value.store.executePatch(value.input, value.preimages, value.requestId, { operationId: value.operationId })
    await value.store.deleteFileEditRecordsForRequest(value.requestId, [value.operationId])
    const damagedId = randomUUID()
    await mkdir(value.store.editRecordDir(value.requestId, damagedId))
    const retained = await value.store.listRetainedEditRecords()
    expect(retained).toMatchObject([
      { tool: 'apply_patch', operationId: value.operationId },
      { tool: 'unavailable', operationId: damagedId, error: expect.stringContaining('Missing metadata') }
    ])
    const tool = createFileTools({ maxReadBytes: 1_000_000, primaryFolder: value.workspace, requestId: value.requestId, fileEditStore: value.store })
      .find((item) => item.name === 'get_file_edit_diff')!
    const result = JSON.parse(String(await tool.invoke({ scope: 'retained' })))
    expect(result).toMatchObject({ ok: true, retained: [
      { operationId: value.operationId, paths: expect.any(Array) },
      { operationId: damagedId, state: 'unavailable', error: expect.any(String) }
    ] })
  })

  it.each(['prepared', 'staged', 'intent', 'partial', 'applied'] as const)('reopens the real %s checkpoint after a hard process exit without replaying targets', async (phase) => {
    const value = await fixture()
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./agent/toolEffectHardCrashFixture.mjs', import.meta.url)), JSON.stringify({
      scenario: 'file_patch_store', phase, workspace: value.workspace, recordsRoot: value.store.root,
      requestId: value.requestId, operationId: value.operationId, viteCacheDirectory: join(value.root, 'vite-cache')
    })], { cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 20_000 })
    expect(result.error, result.stderr).toBeUndefined()
    expect(result.status, result.stderr).toBe(83)
    const store = new FileEditStore(value.store.root)
    const record = await store.loadOperationRecord(value.operationId, value.requestId)
    expect(record.tool).toBe('apply_patch')
    if (record.tool !== 'apply_patch') throw new Error('Expected a batch')
    expect(record.transaction.entries[0].state).toBe(phase === 'partial' || phase === 'applied' ? 'applied' : phase === 'intent' ? 'intent' : 'pending')
    const content = await readFile(join(value.workspace, 'old.txt'), 'utf8')
    expect(content).toBe(phase === 'partial' || phase === 'applied' ? 'after\n' : 'before\n')
    await store.deleteFileEditRecordsForRequest(value.requestId)
    expect(await store.listEditRecordsForRequest(value.requestId)).toHaveLength(phase === 'prepared' ? 0 : 1)
    expect(await readFile(join(value.workspace, 'old.txt'), 'utf8')).toBe(content)
  })
  it('persists all targets in the common store and writes immutable text only once', async () => {
    const value = await fixture()
    const { store, requestId, operationId } = value
    const writer = store.createPatchPersistence(requestId, operationId)
    let originalInode: number | undefined
    let revision = -1
    const final = await executeFilePatchTransaction(operationId, value.input, value.preimages, async (transaction) => {
      await writer.persist(transaction)
      const reopened = new FileEditStore(store.root)
      const record = await reopened.loadOperationRecord(operationId, requestId)
      expect(record.tool).toBe('apply_patch')
      if (record.tool !== 'apply_patch') throw new Error('Expected a batch')
      expect(record.transaction).toEqual(transaction)
      expect(record.revision).toBe(++revision)
      const inode = (await stat(join(store.editRecordDir(requestId, operationId), '0.before.txt'))).ino
      originalInode ??= inode
      expect(inode).toBe(originalInode)
      const metadata = await readFile(join(store.editRecordDir(requestId, operationId), 'record.json'), 'utf8')
      expect(metadata).not.toContain('before\\n')
      expect(metadata).not.toContain('afterText')
    })
    expect(final.state).toBe('applied')
    expect(final.temporary).toEqual([])
    expect(await store.listEditRecordsForRequest(requestId)).toHaveLength(1)
    expect((await store.loadOperationRecord(operationId, requestId)).transaction).toEqual(final)
    await store.deleteFileEditRecordsForRequest(requestId)
    expect(await readdir(store.root)).toEqual([])
    expect(await readFile(join(value.workspace, 'old.txt'), 'utf8')).toBe('after\n')
  })

  it('uses the effect key for stable identity and arms one effect containing every target', async () => {
    const value = await fixture()
    const key = { runId: value.requestId, checkpointId: 'checkpoint', checkpointNs: '', taskId: 'task', callKey: 'call', inputHash: 'input' }
    const arm = vi.fn()
    const result = await runWithCurrentAgentToolEffect({ effectKey: key, arm }, () =>
      value.store.executePatch(value.input, value.preimages, value.requestId))
    expect(result.operationId).toBe(agentToolEffectArtifactId(key, 'file_edit'))
    expect(arm).toHaveBeenCalledExactlyOnceWith({ kind: 'file_patch', recoveryMode: 'confirm', target: {
      requestId: value.requestId, operationId: result.operationId,
      paths: value.preimages.map((entry) => entry.target.canonicalPath)
    } })
    await expect(runWithCurrentAgentToolEffect({ effectKey: key, arm }, async () => {
      const writer = value.store.createPatchPersistence(value.requestId)
      const initial = await preparedRecord({ ...value, operationId: result.operationId,
        preimages: await captureFilePatchPreimages((await resolveFilePatchTargets(asPatchInput({ operations: [
          { type: 'update', path: 'old.txt', patch: '@@\n-after\n+again\n' }
        ] }), value.workspace)).targets), input: { operations: [{ type: 'update', path: join(value.workspace, 'old.txt'), patch: '@@\n-after\n+again\n' }] } })
      await writer.persist(initial)
    })).rejects.toThrow('already exists')
    expect(arm).toHaveBeenCalledTimes(1)
    expect(() => value.store.createPatchPersistence(value.requestId)).toThrow('operation_id')
  })

  it('rejects duplicate writers and stale revisions across store instances', async () => {
    const value = await fixture()
    const initial = await preparedRecord(value)
    const first = value.store.createPatchPersistence(value.requestId, value.operationId)
    const second = new FileEditStore(value.store.root).createPatchPersistence(value.requestId, value.operationId)
    const results = await Promise.allSettled([first.persist(initial), second.persist(initial)])
    expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
    await value.store.deleteFileEditRecordsForRequest(value.requestId, [value.operationId])
    await expect(first.persist(initial)).rejects.toThrow('revision changed')
  })

  it.each(['cancel', 'save-failure'])('persists compensation after %s without losing original snapshots', async (fault) => {
    const value = await fixture()
    const writer = value.store.createPatchPersistence(value.requestId, value.operationId)
    const controller = new AbortController()
    let injected = false
    await expect(executeFilePatchTransaction(value.operationId, value.input, value.preimages, async (record) => {
      if (!injected && record.entries[0].state === 'applied') {
        injected = true
        if (fault === 'save-failure') throw new Error('injected persistence failure')
        controller.abort(new Error('cancelled'))
      }
      await writer.persist(record)
    }, controller.signal)).rejects.toMatchObject({ record: { state: 'restored' } })
    const reopened = new FileEditStore(value.store.root)
    expect(await reopened.loadOperationRecord(value.operationId, value.requestId)).toMatchObject({ transaction: {
      state: 'restored', entries: [{ before: { text: 'before\n' }, state: 'restored' }, { state: 'pending' }], temporary: [], directories: []
    } })
    expect(await readFile(join(value.workspace, 'old.txt'), 'utf8')).toBe('before\n')
    await reopened.deleteFileEditRecordsForRequest(value.requestId)
    expect(await reopened.listEditRecordsForRequest(value.requestId)).toEqual([])
  })

  it.each(['definition', 'blob', 'missing', 'missing-record', 'state', 'operation-id', 'linked-blob'])('preserves recovery material when %s is corrupt', async (kind) => {
    const value = await fixture()
    const initial = await preparedRecord(value)
    await value.store.createPatchPersistence(value.requestId, value.operationId).persist(initial)
    const directory = value.store.editRecordDir(value.requestId, value.operationId)
    const metadataPath = join(directory, 'record.json')
    if (kind === 'definition') await writeFile(join(directory, 'definition.json'), '{}')
    else if (kind === 'blob') await writeFile(join(directory, '0.before.txt'), 'damage\n')
    else if (kind === 'missing') await rm(join(directory, '0.before.txt'))
    else if (kind === 'missing-record') await rm(metadataPath)
    else if (kind === 'linked-blob') {
      await rm(join(directory, '0.before.txt'))
      await symlink(join(value.workspace, 'old.txt'), join(directory, '0.before.txt'))
    } else {
      const metadata = JSON.parse(await readFile(metadataPath, 'utf8'))
      if (kind === 'state') metadata.transaction.state = 'applied'
      else metadata.operationId = randomUUID()
      await writeFile(metadataPath, JSON.stringify(metadata))
    }
    await expect(value.store.loadOperationRecord(value.operationId, value.requestId)).rejects.toThrow()
    await expect(value.store.deleteFileEditRecordsForRequest(value.requestId)).rejects.toThrow()
    await expect(value.store.createPatchPersistence(value.requestId, value.operationId).persist(initial)).rejects.toThrow()
    expect(await readFile(join(value.workspace, 'old.txt'), 'utf8')).toBe('before\n')
    expect((await stat(directory)).isDirectory()).toBe(true)
  })

  it('rejects definition changes and illegal state transitions before updating durable metadata', async () => {
    const value = await fixture()
    const initial = await preparedRecord(value)
    const writer = value.store.createPatchPersistence(value.requestId, value.operationId)
    await writer.persist(initial)
    const changed = structuredClone(initial)
    changed.entries[0].afterText = 'other'
    await expect(writer.persist(changed)).rejects.toThrow('immutable')
    const skipped = structuredClone(initial)
    skipped.state = 'restored'
    await expect(writer.persist(skipped)).rejects.toThrow('transition')
    const loaded = await value.store.loadOperationRecord(value.operationId, value.requestId)
    expect(loaded).toMatchObject({ revision: 0, transaction: { state: 'prepared' } })
  })

  it('retains unfinished groups and externally retained completed groups through the existing cleanup entry', async () => {
    const value = await fixture()
    await value.store.executePatch(value.input, value.preimages, value.requestId, { operationId: value.operationId })
    await value.store.deleteFileEditRecordsForRequest(value.requestId, [value.operationId])
    const reopened = new FileEditStore(value.store.root)
    expect(await reopened.listRetainedEditRecords()).toMatchObject([{ tool: 'apply_patch', operationId: value.operationId,
      transaction: { state: 'retained', entries: [{ state: 'applied' }, { state: 'applied' }] } }])
    await reopened.deleteFileEditRecordsForRequest(value.requestId)
    expect(await reopened.listEditRecordsForRequest(value.requestId)).toHaveLength(1)
  })

  it('shows batch diffs and all retained paths without accepting a forced restore', async () => {
    const value = await fixture()
    await value.store.executePatch(value.input, value.preimages, value.requestId, { operationId: value.operationId })
    await value.store.deleteFileEditRecordsForRequest(value.requestId, [value.operationId])
    const tools = createFileTools({ maxReadBytes: 1_000_000, primaryFolder: value.workspace, requestId: value.requestId, fileEditStore: value.store, fileChanges: await recordedHistory(value) })
    const invoke = async (name: string, args: Record<string, unknown>) => JSON.parse(String(await tools.find((item) => item.name === name)!.invoke(args)))
    const diff = await invoke('get_file_edit_diff', { operation_id: value.operationId })
    expect(diff.patch).toContain('-before')
    expect(diff.patch).toContain('new file mode')
    const retained = await invoke('get_file_edit_diff', { scope: 'retained' })
    expect(retained.retained[0].paths).toEqual(value.preimages.map((entry) => entry.target.canonicalPath))
    await expect(invoke('restore_file_edit', { operation_id: value.operationId, force: true })).rejects.toThrow()
    expect(await readFile(join(value.workspace, 'old.txt'), 'utf8')).toBe('after\n')
  })
})
