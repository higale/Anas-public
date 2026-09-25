import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileEditStore } from './fileEditStore'
import { resolveFilePatchTargets } from './filePatch'
import { asPatchInput } from './filePatchTestFixtures'
import { captureFilePatchPreimages } from './filePatchState'
import { validatePatchTransaction, validatePatchTransition } from './filePatchRecord'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function fixture(reverse = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'anas-finalize-')))
  roots.push(root)
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  await writeFile(join(workspace, 'old.txt'), 'before\n')
  const store = new FileEditStore(join(root, 'records')), requestId = randomUUID(), inverseRequestId = randomUUID()
  const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [
    { type: 'update', path: 'old.txt', patch: '@@\n-before\n+after\n' },
    { type: 'create', path: 'nested/empty.txt', content: '' }
  ] }), workspace)
  const source = await store.executePatch(resolved.input, await captureFilePatchPreimages(resolved.targets), requestId, { operationId: randomUUID() })
  const inverse = reverse ? await store.restorePatch(source.operationId, requestId, inverseRequestId, async () => {}, { operationId: randomUUID() }) : null
  const finalize = (authorize = async () => {}) => store.finalizePatchRestore(source.operationId, requestId, authorize,
    { inverse: inverse ? { requestId: inverseRequestId, operationId: inverse.operationId } : undefined })
  return { root, workspace, store, requestId, inverseRequestId, source, inverse, finalize }
}

// Real durable transactions and subprocess checkpoints share disk bandwidth.
describe('patch recovery finalization', { timeout: 20_000 }, () => {
  it.each(['source-first', 'inverse-first'] as const)('publishes completion, cleans only owned empty parents, then permits %s cleanup', async (order) => {
    const value = await fixture()
    const inode = (await stat(join(value.workspace, 'old.txt'))).ino
    const source = await value.finalize()
    expect(source.transaction).toMatchObject({ state: 'resolved', recovery: { state: 'complete', inverse: {
      operationId: value.inverse!.operationId, requestId: value.inverseRequestId, definitionHash: value.inverse!.definitionHash
    } }, directories: [] })
    expect(source.transaction.entries).toEqual(value.source.transaction.entries)
    expect((await stat(join(value.workspace, 'old.txt'))).ino).toBe(inode)
    await expect(stat(join(value.workspace, 'nested'))).rejects.toMatchObject({ code: 'ENOENT' })
    const reopened = new FileEditStore(value.store.root)
    const requests = order === 'source-first' ? [value.requestId, value.inverseRequestId] : [value.inverseRequestId, value.requestId]
    for (const requestId of requests) await reopened.deleteFileEditRecordsForRequest(requestId)
    expect(await reopened.listRetainedEditRecords()).toEqual([])
    expect(await reopened.listEditRecordsForRequest(value.requestId)).toEqual([])
    expect(await reopened.listEditRecordsForRequest(value.inverseRequestId)).toEqual([])
  })

  it('finalizes a verified no-op without inventing an inverse operation', async () => {
    const value = await fixture(false)
    await writeFile(join(value.workspace, 'old.txt'), 'before\n')
    await rm(join(value.workspace, 'nested/empty.txt'))
    const result = await value.finalize()
    expect(result.transaction.recovery).toEqual({ state: 'complete', inverse: null })
    expect(await value.store.listEditRecordsForRequest(value.requestId)).toHaveLength(1)
    expect(await value.store.listEditRecordsForRequest(value.inverseRequestId)).toEqual([])
  })

  it.each(['not-restored', 'user-edit', 'denied', 'cancelled'] as const)('preserves records and directories when %s', async (reason) => {
    const value = await fixture(reason !== 'not-restored')
    const before = await value.store.loadOperationRecord(value.source.operationId, value.requestId)
    if (reason === 'user-edit') await writeFile(join(value.workspace, 'old.txt'), 'user')
    const controller = new AbortController()
    await expect(value.store.finalizePatchRestore(value.source.operationId, value.requestId, async () => {
      if (reason === 'denied') throw new Error('denied')
      if (reason === 'cancelled') controller.abort(new Error('cancelled'))
    }, { signal: controller.signal, inverse: value.inverse ? { requestId: value.inverseRequestId, operationId: value.inverse.operationId } : undefined })).rejects.toThrow()
    expect(await value.store.loadOperationRecord(value.source.operationId, value.requestId)).toEqual(before)
    expect((await stat(join(value.workspace, 'nested'))).isDirectory()).toBe(true)
  })

  it('keeps a nonempty created directory and can retry artifact cleanup after the user empties it', async () => {
    const value = await fixture()
    const userFile = join(value.workspace, 'nested/user.txt')
    await writeFile(userFile, 'user')
    const result = await value.finalize()
    expect(result.transaction.directories).toHaveLength(1)
    expect(result.transaction.errors.length).toBeGreaterThan(0)
    await value.store.deleteFileEditRecordsForRequest(value.requestId)
    expect(await readFile(userFile, 'utf8')).toBe('user')
    await rm(userFile)
    expect((await value.finalize()).transaction.directories).toEqual([])
    await value.store.deleteFileEditRecordsForRequest(value.requestId)
    expect(await value.store.listEditRecordsForRequest(value.requestId)).toEqual([])
  })

  it('does not adopt a replacement directory at the same path', async () => {
    const value = await fixture()
    await rename(join(value.workspace, 'nested'), join(value.workspace, 'original-parent'))
    await mkdir(join(value.workspace, 'nested'))
    const result = await value.finalize()
    expect(result.transaction.directories).toHaveLength(1)
    expect((await stat(join(value.workspace, 'nested'))).isDirectory()).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('refuses a cleanup parent link substituted during authorization', async () => {
    const value = await fixture()
    const outside = join(value.root, 'outside')
    await mkdir(outside)
    await expect(value.finalize(async () => {
      await rm(join(value.workspace, 'nested'), { recursive: true })
      await symlink(outside, join(value.workspace, 'nested'))
    })).rejects.toThrow('changed')
    expect((await stat(outside)).isDirectory()).toBe(true)
  })

  it('rejects another source inverse before authorization and does not remove immutable evidence', async () => {
    const value = await fixture()
    const otherRequest = randomUUID()
    const input = await resolveFilePatchTargets(asPatchInput({ operations: [{ type: 'create', path: 'other.txt', content: 'other' }] }), value.workspace)
    const other = await value.store.executePatch(input.input, await captureFilePatchPreimages(input.targets), otherRequest, { operationId: randomUUID() })
    const otherInverse = (await value.store.restorePatch(other.operationId, otherRequest, otherRequest, async () => {}, { operationId: randomUUID() }))!
    const authorize = vi.fn(async () => {})
    await expect(value.store.finalizePatchRestore(value.source.operationId, value.requestId, authorize,
      { inverse: { requestId: otherRequest, operationId: otherInverse.operationId } })).rejects.toThrow('unrelated')
    expect(authorize).not.toHaveBeenCalled()
    const result = await value.finalize()
    const invalid = structuredClone(result)
    invalid.revision++
    invalid.transaction.recovery!.inverse!.operationId = randomUUID()
    expect(() => validatePatchTransition(result, invalid)).toThrow('reassigned')
    const missing = structuredClone(result.transaction)
    delete missing.recovery
    expect(() => validatePatchTransaction(missing)).toThrow('evidence')
  }, 20_000) // Two independent durable forward/reverse fixtures plus finalization.

  it('owns the inverse reference across the authorization callback', async () => {
    const value = await fixture()
    const inverse = { requestId: value.inverseRequestId, operationId: value.inverse!.operationId }
    const pending = value.store.finalizePatchRestore(value.source.operationId, value.requestId, async () => {
      inverse.operationId = value.source.operationId
      inverse.requestId = value.requestId
    }, { inverse })
    inverse.operationId = randomUUID()
    const result = await pending
    expect(result.transaction.recovery?.inverse?.operationId).toBe(value.inverse!.operationId)
  })

  it.each(['source-verified', 'inverse-acknowledged', 'finalized'] as const)('resumes bookkeeping after a %s hard exit without rewriting later user edits', async (phase) => {
    const value = await fixture()
    const crashed = spawnSync(process.execPath, [fileURLToPath(new URL('./agent/toolEffectHardCrashFixture.mjs', import.meta.url)), JSON.stringify({
      scenario: 'file_patch_store', finalize: true, phase, workspace: value.workspace, recordsRoot: value.store.root,
      sourceRequestId: value.requestId, sourceOperationId: value.source.operationId,
      requestId: value.inverseRequestId, operationId: value.inverse!.operationId, viteCacheDirectory: join(value.root, 'cache')
    })], { cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 20_000 })
    expect(crashed.status, crashed.stderr).toBe(83)
    const reopened = new FileEditStore(value.store.root)
    await writeFile(join(value.workspace, 'old.txt'), 'later user edit')
    if (phase !== 'finalized') {
      await reopened.deleteFileEditRecordsForRequest(value.inverseRequestId)
      expect(await reopened.listRetainedEditRecords()).toHaveLength(2)
    }
    const final = await reopened.finalizePatchRestore(value.source.operationId, value.requestId, async () => {})
    expect(final.transaction.recovery?.state).toBe('complete')
    expect(await readFile(join(value.workspace, 'old.txt'), 'utf8')).toBe('later user edit')
    await reopened.deleteFileEditRecordsForRequest(value.inverseRequestId)
    await reopened.deleteFileEditRecordsForRequest(value.requestId)
    expect(await reopened.listRetainedEditRecords()).toEqual([])
  }, 20_000)
})
