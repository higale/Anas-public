import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileEditStore } from './fileEditStore'
import { resolveFilePatchTargets } from './filePatch'
import { asPatchInput } from './filePatchTestFixtures'
import { captureFilePatchPreimages } from './filePatchState'
import { validatePatchTransition } from './filePatchRecord'
import { validatePatchRestoreEvidence } from './filePatchRestore'
import { resumeFilePatchTransaction } from './filePatchTransaction'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture(reverse = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'anas-patch-resume-')))
  roots.push(root)
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  await writeFile(join(workspace, 'old.txt'), 'before\n')
  const store = new FileEditStore(join(root, 'records')), sourceRequestId = randomUUID(), sourceOperationId = randomUUID()
  if (reverse) {
    const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [
      { type: 'update', path: 'old.txt', patch: '@@\n-before\n+after\n' },
      { type: 'create', path: 'nested/empty.txt', content: '' }
    ] }), workspace)
    await store.executePatch(resolved.input, await captureFilePatchPreimages(resolved.targets), sourceRequestId, { operationId: sourceOperationId })
  }
  const operationId = reverse ? randomUUID() : sourceOperationId, requestId = reverse ? randomUUID() : sourceRequestId
  const crash = (phase: string, resume = false, attempt?: { requestId: string; operationId: string }) => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./agent/toolEffectHardCrashFixture.mjs', import.meta.url)), JSON.stringify({
      scenario: 'file_patch_store', phase, resume, workspace, recordsRoot: store.root, requestId, operationId,
      ...attempt,
      ...(reverse ? { sourceRequestId, sourceOperationId } : {}), viteCacheDirectory: join(root, 'cache')
    })], { cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 20_000 })
    expect(result.status, result.stderr).toBe(83)
  }
  return { root, workspace, store, requestId, operationId, sourceRequestId, sourceOperationId, crash }
}

describe('durable patch resumption', { timeout: 20_000 }, () => {
  it('preserves prior compensation through a crash before the next inverse association is published', async () => {
    const value = await fixture(true)
    value.crash('rollback-partial')
    await value.store.resumePatch(value.operationId, value.requestId, async () => {})
    const source = await value.store.loadOperationRecord(value.sourceOperationId, value.sourceRequestId)
    if (source.tool !== 'apply_patch') throw new Error('Expected patch')
    const attempt = { requestId: randomUUID(), operationId: randomUUID() }
    value.crash('prepared', false, attempt)
    expect(await value.store.loadOperationRecord(value.sourceOperationId, value.sourceRequestId)).toEqual(source)
    expect((await value.store.previewPatchRestore(value.sourceOperationId, value.sourceRequestId, async () => {})).evidence?.operationId).toBe(value.operationId)
    const reopened = new FileEditStore(value.store.root)
    expect((await reopened.resumePatch(attempt.operationId, attempt.requestId, async () => {})).transaction.state).toBe('applied')
    expect(await reopened.loadOperationRecord(value.sourceOperationId, value.sourceRequestId)).toMatchObject({
      definitionHash: source.definitionHash, transaction: { entries: source.transaction.entries, reverseAttempt: attempt }
    })
    expect(await readFile(join(value.workspace, 'old.txt'), 'utf8')).toBe('before\n')
  })
  it('uses confirmed compensation evidence for a later restore without rewriting the original history', async () => {
    const value = await fixture(true)
    const original = await value.store.loadOperationRecord(value.sourceOperationId, value.sourceRequestId)
    if (original.tool !== 'apply_patch') throw new Error('Expected patch')
    value.crash('rollback-partial')
    const reopened = new FileEditStore(value.store.root)
    const compensated = await reopened.resumePatch(value.operationId, value.requestId, async () => {})
    expect(compensated.transaction.state).toBe('restored')
    expect(compensated.transaction.entries.every((entry) => entry.compensated)).toBe(true)
    const preview = await reopened.previewPatchRestore(value.sourceOperationId, value.sourceRequestId, async () => {})
    expect(preview.status).toBe('ready')
    expect(preview.evidence?.operationId).toBe(value.operationId)
    await reopened.deleteFileEditRecordsForRequest(value.requestId)
    expect((await reopened.loadOperationRecord(value.operationId, value.requestId)).tool).toBe('apply_patch')
    // A second failed restore must carry forward the latest compensation facts,
    // not revive the identity from either the original edit or first inverse.
    const failedRequestId = randomUUID(), failedOperationId = randomUUID(), abort = new AbortController()
    const createWriter = reopened.createPatchPersistence.bind(reopened)
    const hook = vi.spyOn(reopened, 'createPatchPersistence').mockImplementation((...args) => {
      const writer = createWriter(...args)
      return { ...writer, persist: async (record) => {
        await writer.persist(record)
        if (record.state === 'committing' && record.entries.every((entry) => entry.state === 'applied')) abort.abort()
      } }
    })
    try {
      await expect(reopened.restorePatch(value.sourceOperationId, value.sourceRequestId, failedRequestId,
        async () => {}, { operationId: failedOperationId, signal: abort.signal })).rejects.toThrow('restored')
    } finally { hook.mockRestore() }
    const repeatedPreview = await reopened.previewPatchRestore(value.sourceOperationId, value.sourceRequestId, async () => {})
    expect(repeatedPreview.status).toBe('ready')
    expect(repeatedPreview.evidence?.operationId).toBe(failedOperationId)
    const nextRequestId = randomUUID(), nextOperationId = randomUUID()
    const next = await reopened.restorePatch(value.sourceOperationId, value.sourceRequestId, nextRequestId, async () => {}, { operationId: nextOperationId })
    expect(next?.transaction.state).toBe('applied')
    const source = await reopened.loadOperationRecord(value.sourceOperationId, value.sourceRequestId)
    if (source.tool !== 'apply_patch') throw new Error('Expected patch')
    expect(source.definitionHash).toBe(original.definitionHash)
    expect(source.transaction.entries).toEqual(original.transaction.entries)
    expect(source.transaction.reverseAttempt?.operationId).toBe(nextOperationId)
    expect(() => validatePatchRestoreEvidence(source, compensated)).toThrow('unrelated or stale')
    const cleared = structuredClone(source)
    delete cleared.transaction.reverseAttempt
    cleared.revision++
    expect(() => validatePatchTransition(source, cleared)).toThrow('reverse attempt')
    expect(await readFile(join(value.workspace, 'old.txt'), 'utf8')).toBe('before\n')
    await expect(stat(join(value.workspace, 'nested/empty.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await reopened.finalizePatchRestore(value.sourceOperationId, value.sourceRequestId, async () => {}, {
      inverse: { requestId: nextRequestId, operationId: nextOperationId }
    })
    for (const requestId of [value.requestId, value.sourceRequestId, failedRequestId, nextRequestId]) await reopened.deleteFileEditRecordsForRequest(requestId)
    expect(await reopened.listRetainedEditRecords()).toEqual([])
  })

  it.each(['replacement', 'unconfirmed-compensation'] as const)('refuses a new restore after %s without inferring ownership from matching text', async (kind) => {
    const value = await fixture(true)
    value.crash(kind === 'replacement' ? 'rollback-partial' : 'rollback-effect')
    await value.store.resumePatch(value.operationId, value.requestId, async () => {})
    if (kind === 'replacement') {
      const file = join(value.workspace, 'old.txt')
      await writeFile(join(value.workspace, 'replacement'), await readFile(file))
      await rename(join(value.workspace, 'replacement'), file)
    }
    const preview = await value.store.previewPatchRestore(value.sourceOperationId, value.sourceRequestId, async () => {})
    expect(preview.status).toBe('conflict')
    const nextRequestId = randomUUID(), nextOperationId = randomUUID()
    await expect(value.store.restorePatch(value.sourceOperationId, value.sourceRequestId, nextRequestId,
      async () => {}, { operationId: nextOperationId })).rejects.toThrow('conflicted')
    await expect(stat(join(value.store.root, nextRequestId, nextOperationId))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(value.workspace, 'old.txt'), 'utf8')).toBe('after\n')
  })

  it('keeps an unfinished inverse authoritative when a new restore or original replay arrives', async () => {
    const value = await fixture(true)
    value.crash('partial')
    const source = await value.store.loadOperationRecord(value.sourceOperationId, value.sourceRequestId)
    if (source.tool !== 'apply_patch') throw new Error('Expected patch')
    const persist = vi.fn(async () => {})
    expect(await resumeFilePatchTransaction(source.transaction, [], persist)).toEqual(source.transaction)
    expect(persist).not.toHaveBeenCalled()
    expect(await value.store.resumePatch(value.sourceOperationId, value.sourceRequestId, async () => {})).toEqual(source)
    await expect(value.store.restorePatch(value.sourceOperationId, value.sourceRequestId, randomUUID(),
      async () => {}, { operationId: randomUUID() })).rejects.toThrow('Previous reverse attempt is unfinished')
    expect(await readFile(join(value.workspace, 'old.txt'), 'utf8')).toBe('before\n')
    expect((await value.store.resumePatch(value.operationId, value.requestId, async () => {})).transaction.state).toBe('applied')
  })

  it('preserves a source with missing reverse evidence instead of guessing another restore', async () => {
    const value = await fixture(true)
    value.crash('rollback-partial')
    await value.store.resumePatch(value.operationId, value.requestId, async () => {})
    const metadata = join(value.store.root, value.requestId, value.operationId, 'record.json')
    await rename(metadata, `${metadata}.test-hidden`)
    await expect(value.store.previewPatchRestore(value.sourceOperationId, value.sourceRequestId, async () => {})).rejects.toThrow()
    await expect(value.store.restorePatch(value.sourceOperationId, value.sourceRequestId, randomUUID(),
      async () => {}, { operationId: randomUUID() })).rejects.toThrow()
    await value.store.deleteFileEditRecordsForRequest(value.sourceRequestId)
    expect((await value.store.loadOperationRecord(value.sourceOperationId, value.sourceRequestId)).tool).toBe('apply_patch')
    expect(await readFile(join(value.workspace, 'old.txt'), 'utf8')).toBe('after\n')
  })

  it('owns newly authorized inputs before waiting for the execution lock', async () => {
    const value = await fixture()
    const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [{ type: 'create', path: 'new.txt', content: 'authorized' }] }), value.workspace)
    const preimages = await captureFilePatchPreimages(resolved.targets)
    const pending = value.store.executePatch(resolved.input, preimages, value.requestId, { operationId: value.operationId })
    resolved.input.operations[0].path = join(value.root, 'outside.txt')
    preimages[0].target.canonicalPath = join(value.root, 'outside.txt')
    expect((await pending).transaction.state).toBe('applied')
    expect(await readFile(join(value.workspace, 'new.txt'), 'utf8')).toBe('authorized')
    await expect(stat(join(value.root, 'outside.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  for (const reverse of [false, true]) {
    it.each(['prepared', 'staged', 'intent', 'partial', 'applied'])(`resumes ${reverse ? 'reverse' : 'forward'} %s without rewriting confirmed entries`, async (phase) => {
      const value = await fixture(reverse)
      value.crash(phase)
      const initial = await value.store.loadOperationRecord(value.operationId, value.requestId)
      if (initial.tool !== 'apply_patch') throw new Error('Expected patch')
      const inode = (await stat(join(value.workspace, 'old.txt'))).ino
      const reopened = new FileEditStore(value.store.root)
      const result = await reopened.resumePatch(value.operationId, value.requestId, async () => {})
      expect(result.transaction.state).toBe('applied')
      expect(result.operationId).toBe(initial.operationId)
      expect(result.definitionHash).toBe(initial.definitionHash)
      expect(await readFile(join(value.workspace, 'old.txt'), 'utf8')).toBe(reverse ? 'before\n' : 'after\n')
      if (['partial', 'applied'].includes(phase)) expect((await stat(join(value.workspace, 'old.txt'))).ino).toBe(inode)
      if (reverse) await expect(stat(join(value.workspace, 'nested/empty.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      else expect(await readFile(join(value.workspace, 'nested/empty.txt'), 'utf8')).toBe('')
      const repeated = await reopened.resumePatch(value.operationId, value.requestId, async () => {})
      expect(repeated).toEqual(result)
      if (reverse) {
        await reopened.finalizePatchRestore(value.sourceOperationId, value.sourceRequestId, async () => {}, {
          inverse: { requestId: value.requestId, operationId: value.operationId }
        })
        await reopened.deleteFileEditRecordsForRequest(value.sourceRequestId)
        // A completed inverse can still replay after its source has been cleaned.
        expect((await reopened.resumePatch(value.operationId, value.requestId, async () => {})).transaction.state).toBe('resolved')
      }
      await reopened.deleteFileEditRecordsForRequest(value.requestId)
      expect(await reopened.listRetainedEditRecords()).toEqual([])
    })

    it.each(['rollback-intent', 'rollback-effect', 'rollback-partial'])(`continues ${reverse ? 'reverse' : 'forward'} %s compensation without reapplying the edit`, async (phase) => {
      const value = await fixture(reverse)
      value.crash(phase)
      const reopened = new FileEditStore(value.store.root)
      const result = await reopened.resumePatch(value.operationId, value.requestId, async () => {})
      expect(result.transaction.state).toBe('restored')
      expect(await readFile(join(value.workspace, 'old.txt'), 'utf8')).toBe(reverse ? 'after\n' : 'before\n')
      if (reverse) expect(await readFile(join(value.workspace, 'nested/empty.txt'), 'utf8')).toBe('')
      else await expect(stat(join(value.workspace, 'nested/empty.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(result.transaction.entries[0].compensated?.text).toBe(reverse ? 'after\n' : 'before\n')
      if (phase === 'rollback-effect') expect(result.transaction.entries[1].compensated).toBeUndefined()
      else expect(result.transaction.entries[1].compensated).toBeDefined()
      const changed = structuredClone(result)
      changed.revision++
      delete changed.transaction.entries[0].compensated
      expect(() => validatePatchTransition(result, changed)).toThrow('postimage')
      await writeFile(join(value.workspace, 'old.txt'), 'later user edit')
      expect((await reopened.resumePatch(value.operationId, value.requestId, async () => {})).transaction.state).toBe('restored')
      expect(await readFile(join(value.workspace, 'old.txt'), 'utf8')).toBe('later user edit')
    })
  }

  it.each(['unknown-intent', 'same-content-replacement', 'partial-external-change', 'denied', 'cancelled'])('does not write or advance metadata after %s', async (fault) => {
    const value = await fixture()
    value.crash(fault === 'partial-external-change' ? 'partial' : 'intent')
    const original = await value.store.loadOperationRecord(value.operationId, value.requestId)
    const target = join(value.workspace, 'old.txt')
    if (fault === 'unknown-intent') await writeFile(target, 'after\n')
    if (fault === 'partial-external-change') await writeFile(target, 'user edit')
    if (fault === 'same-content-replacement') {
      await writeFile(join(value.workspace, 'replacement'), 'before\n')
      await rename(join(value.workspace, 'replacement'), target)
    }
    const before = await readFile(target, 'utf8'), controller = new AbortController()
    await expect(value.store.resumePatch(value.operationId, value.requestId, async () => {
      if (fault === 'denied') throw new Error('denied')
      if (fault === 'cancelled') controller.abort(new Error('cancelled'))
    }, controller.signal)).rejects.toThrow()
    expect(await value.store.loadOperationRecord(value.operationId, value.requestId)).toEqual(original)
    expect(await readFile(target, 'utf8')).toBe(before)
    await expect(stat(join(value.workspace, 'nested/empty.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('survives another hard exit during resumption using the same record', async () => {
    const value = await fixture(true)
    value.crash('prepared')
    value.crash('partial', true)
    const inode = (await stat(join(value.workspace, 'old.txt'))).ino
    const result = await value.store.resumePatch(value.operationId, value.requestId, async () => {})
    expect(result.transaction.state).toBe('applied')
    expect((await stat(join(value.workspace, 'old.txt'))).ino).toBe(inode)
    expect(await value.store.listEditRecordsForRequest(value.requestId)).toHaveLength(1)
  })
})
