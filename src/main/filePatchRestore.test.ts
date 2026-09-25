import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chmod, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FileEditStore } from './fileEditStore'
import { resolveFilePatchTargets } from './filePatch'
import { asPatchInput } from './filePatchTestFixtures'
import { captureFilePatchPreimages } from './filePatchState'
import { prepareFilePatchRestoreAuthorization } from './agent/toolAuthorization'
import { executeFilePatchRestoreTransaction, planFilePatchRestore, type AuthorizeFilePatchRestore } from './filePatchRestore'
import { agentToolEffectArtifactId, runWithCurrentAgentToolEffect } from './agent/toolEffectScope'
import { validatePatchTransition } from './filePatchRecord'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, open: vi.fn(original.open) }
})

const roots: string[] = []
afterEach(async () => {
  vi.mocked(open).mockClear()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(external = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'anas-restore-preview-')))
  roots.push(root)
  const workspace = join(root, 'workspace')
  await mkdir(workspace)
  for (const name of ['old.txt', 'delete.txt', 'move.txt']) await writeFile(join(workspace, name), `${name}\r\n`)
  const store = new FileEditStore(join(root, 'records'))
  const requestId = randomUUID(), operationId = randomUUID()
  const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [
    { type: 'update', path: 'old.txt', patch: '@@\n-old.txt\n+changed\n' },
    { type: 'create', path: external ? join(root, 'outside', 'empty.txt') : 'nested/empty.txt', content: '' },
    { type: 'delete', path: 'delete.txt' },
    { type: 'move', path: 'move.txt', destination: 'moved.txt' }
  ] }), workspace)
  const record = await store.executePatch(resolved.input, await captureFilePatchPreimages(resolved.targets), requestId, { operationId })
  return { root, workspace, store, requestId, operationId, record }
}

// These integration cases fsync both forward and reverse records repeatedly.
describe('internal batch reverse execution', { timeout: 20_000 }, () => {
  it('restores update/create/delete/move as a separate durable operation and retains both records', async () => {
    const value = await fixture()
    const requestId = randomUUID(), operationId = randomUUID()
    const result = await value.store.restorePatch(value.operationId, value.requestId, requestId, async () => {}, { operationId })
    expect(result?.transaction.state).toBe('applied')
    expect(result?.transaction.restores).toEqual({ requestId: value.requestId, operationId: value.operationId,
      revision: value.record.revision + 1, definitionHash: value.record.definitionHash })
    expect(result?.transaction.entries).toHaveLength(5)
    for (const name of ['old.txt', 'delete.txt', 'move.txt']) {
      expect(await readFile(join(value.workspace, name), 'utf8')).toBe(`${name}\r\n`)
    }
    for (const name of ['nested/empty.txt', 'moved.txt']) await expect(stat(join(value.workspace, name))).rejects.toMatchObject({ code: 'ENOENT' })
    // Source-owned directories are deliberately retained, never recursively removed.
    expect((await stat(join(value.workspace, 'nested'))).isDirectory()).toBe(true)
    const reopened = new FileEditStore(value.store.root)
    expect(await reopened.loadOperationRecord(operationId, requestId)).toEqual(result)
    const source = await reopened.loadOperationRecord(value.operationId, value.requestId)
    expect(source).toMatchObject({ transaction: { state: 'retained' }, definitionHash: value.record.definitionHash })
    await reopened.deleteFileEditRecordsForRequest(value.requestId)
    await reopened.deleteFileEditRecordsForRequest(requestId)
    expect(await reopened.listRetainedEditRecords()).toHaveLength(2)
  }, 20_000) // Full durable forward + inverse + reopen + two cleanup passes.

  it('uses a distinct stable effect identity and registers every changed target once', async () => {
    const value = await fixture()
    const requestId = randomUUID()
    const key = { runId: requestId, checkpointId: 'checkpoint', checkpointNs: '', taskId: 'task', callKey: 'restore', inputHash: 'input' }
    const arm = vi.fn()
    const result = await runWithCurrentAgentToolEffect({ effectKey: key, arm }, () =>
      value.store.restorePatch(value.operationId, value.requestId, requestId, async () => {}))
    expect(result?.operationId).toBe(agentToolEffectArtifactId(key, 'file_restore'))
    expect(arm).toHaveBeenCalledExactlyOnceWith({ kind: 'file_patch', recoveryMode: 'confirm', target: {
      requestId, operationId: result!.operationId, paths: result!.transaction.entries.map((entry) => entry.before.target.canonicalPath)
    } })
  })

  it('does not rewrite an externally restored original and creates no record for a complete no-op', async () => {
    const value = await fixture()
    await writeFile(join(value.workspace, 'old.txt'), 'old.txt\r\n')
    const inode = (await stat(join(value.workspace, 'old.txt'))).ino
    const first = await value.store.restorePatch(value.operationId, value.requestId, value.requestId, async () => {}, { operationId: randomUUID() })
    expect(first?.transaction.entries).toHaveLength(4)
    expect((await stat(join(value.workspace, 'old.txt'))).ino).toBe(inode)
    const operationId = randomUUID()
    const source = await value.store.loadOperationRecord(value.operationId, value.requestId)
    expect(await value.store.restorePatch(value.operationId, value.requestId, value.requestId, async () => {}, { operationId })).toBeNull()
    await expect(stat(value.store.editRecordDir(value.requestId, operationId))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await value.store.loadOperationRecord(value.operationId, value.requestId)).toEqual(source)
  })

  it.each(['denied', 'conflict', 'cancel'] as const)('leaves all files and source metadata untouched after %s', async (fault) => {
    const value = await fixture()
    const controller = new AbortController(), operationId = randomUUID()
    if (fault === 'conflict') await writeFile(join(value.workspace, 'old.txt'), 'user')
    await expect(value.store.restorePatch(value.operationId, value.requestId, value.requestId, async () => {
      if (fault === 'denied') throw new Error('denied')
      if (fault === 'cancel') controller.abort(new Error('cancelled'))
    }, { operationId, signal: controller.signal })).rejects.toThrow()
    expect(await value.store.loadOperationRecord(value.operationId, value.requestId)).toEqual(value.record)
    expect(await readFile(join(value.workspace, 'old.txt'), 'utf8')).toBe(fault === 'conflict' ? 'user' : 'changed\r\n')
    expect(await readFile(join(value.workspace, 'moved.txt'), 'utf8')).toBe('move.txt\r\n')
    await expect(stat(value.store.editRecordDir(value.requestId, operationId))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['cancel', 'save-failure'] as const)('compensates a partial reverse after %s using its own preimages', async (fault) => {
    const value = await fixture()
    const operationId = randomUUID(), controller = new AbortController()
    const createWriter = value.store.createPatchPersistence.bind(value.store)
    let injected = false
    vi.spyOn(value.store, 'createPatchPersistence').mockImplementation((requestId, id) => {
      const writer = createWriter(requestId, id)
      return { ...writer, persist: async (record) => {
        if (!injected && record.entries[0].state === 'applied') {
          injected = true
          if (fault === 'save-failure') throw new Error('save failed')
          controller.abort(new Error('cancelled'))
        }
        await writer.persist(record)
      } }
    })
    await expect(value.store.restorePatch(value.operationId, value.requestId, value.requestId, async () => {},
      { operationId, signal: controller.signal })).rejects.toThrow()
    expect(injected).toBe(true)
    expect(await readFile(join(value.workspace, 'old.txt'), 'utf8')).toBe('changed\r\n')
    expect(await readFile(join(value.workspace, 'nested/empty.txt'), 'utf8')).toBe('')
    const reversed = await value.store.loadOperationRecord(operationId, value.requestId)
    expect(reversed).toMatchObject({ transaction: { state: 'restored',
      restores: { operationId: value.operationId } } })
    // Compensation is durable, but a repeated identity still must not start a new attempt.
    await expect(value.store.restorePatch(value.operationId, value.requestId, value.requestId, async () => {}, { operationId }))
      .rejects.toThrow('already exists')
  })

  it('rejects changed observations and forged source bindings before any persistence', async () => {
    const value = await fixture()
    const plan = await value.store.previewPatchRestore(value.operationId, value.requestId, async () => {})
    const persist = vi.fn(async () => {})
    await expect(executeFilePatchRestoreTransaction(randomUUID(), value.record, { ...plan, revision: plan.revision + 1 }, persist)).rejects.toThrow('stale')
    const forged = structuredClone(plan)
    forged.entries[0].observed.target.canonicalPath = join(value.workspace, 'different')
    await expect(executeFilePatchRestoreTransaction(randomUUID(), value.record, forged, persist)).rejects.toThrow('observation')
    await writeFile(join(value.workspace, 'old.txt'), 'user edit')
    await expect(executeFilePatchRestoreTransaction(randomUUID(), value.record, plan, persist)).rejects.toThrow()
    expect(persist).not.toHaveBeenCalled()
  })

  it('refuses a repeated completed reverse identity, even after a later user edit', async () => {
    const value = await fixture(), operationId = randomUUID()
    await value.store.restorePatch(value.operationId, value.requestId, value.requestId, async () => {}, { operationId })
    await writeFile(join(value.workspace, 'old.txt'), 'later edit')
    await expect(value.store.restorePatch(value.operationId, value.requestId, value.requestId, async () => {}, { operationId })).rejects.toThrow('already exists')
    expect(await readFile(join(value.workspace, 'old.txt'), 'utf8')).toBe('later edit')
  })

  it('keeps the source association immutable across metadata revisions', async () => {
    const value = await fixture()
    const result = (await value.store.restorePatch(value.operationId, value.requestId, value.requestId, async () => {}, { operationId: randomUUID() }))!
    const changed = structuredClone(result)
    changed.revision++
    changed.transaction.restores!.operationId = randomUUID()
    expect(() => validatePatchTransition(result, changed)).toThrow('immutable')
    await expect(value.store.restorePatch(result.operationId, value.requestId, value.requestId, async () => {}, { operationId: randomUUID() }))
      .rejects.toThrow('reverse operation')
  })

  it.each(['applied', 'pre-effect-failure'] as const)('serializes competing restores and concurrent cleanup when the first restore is %s', async (outcome) => {
    const value = await fixture()
    const requestId = randomUUID(), operationId = randomUUID()
    const createWriter = value.store.createPatchPersistence.bind(value.store)
    let notifyStarted!: () => void, release!: () => void
    const started = new Promise<void>((resolve) => { notifyStarted = resolve })
    const released = new Promise<void>((resolve) => { release = resolve })
    const injectedFailure = new Error('Injected failure before inverse effects')
    const pending: Promise<unknown>[] = []
    const observe = <T>(operation: Promise<T>): Promise<PromiseSettledResult<T>> => {
      // Observe rejection at launch, not when a later gate lets us await it.
      const result = operation.then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason: unknown) => ({ status: 'rejected' as const, reason })
      )
      pending.push(result)
      return result
    }
    const waitForGate = async <T>(gate: Promise<void>, result: Promise<PromiseSettledResult<T>>): Promise<void> => {
      await Promise.race([gate, result.then((settled) => {
        if (settled.status === 'rejected') throw settled.reason
        throw new Error('Restore completed before reaching its expected test gate.')
      })])
    }
    let paused = false
    vi.spyOn(value.store, 'createPatchPersistence').mockImplementation((runId, id) => {
      const writer = createWriter(runId, id)
      return { ...writer, persist: async (record) => {
        await writer.persist(record)
        if (!paused) {
          paused = true
          notifyStarted()
          await released
          if (outcome === 'pre-effect-failure') throw injectedFailure
        }
      } }
    })
    try {
      const first = observe(value.store.restorePatch(value.operationId, value.requestId, requestId, async () => {}, { operationId }))
      await waitForGate(started, first)
      const other = new FileEditStore(value.store.root)
      let notifyAuthorized!: () => void
      const authorized = new Promise<void>((resolve) => { notifyAuthorized = resolve })
      const second = observe(other.restorePatch(value.operationId, value.requestId, requestId, async () => {
        notifyAuthorized()
      }, { operationId: randomUUID() }))
      await waitForGate(authorized, second)
      const cleanup = observe(other.deleteFileEditRecordsForRequest(value.requestId))
      release()
      const [firstResult, secondResult, cleanupResult] = await Promise.all([first, second, cleanup])
      if (cleanupResult.status === 'rejected') throw cleanupResult.reason
      if (outcome === 'pre-effect-failure') {
        expect(firstResult).toEqual({ status: 'rejected', reason: injectedFailure })
        // The first attempt stopped before any file effect or source binding;
        // the already queued second restore can complete the original request.
        if (secondResult.status === 'rejected') throw secondResult.reason
        expect(secondResult.value?.transaction.state).toBe('applied')
        expect(await other.loadOperationRecord(operationId, requestId)).toMatchObject({ transaction: { state: 'prepared' } })
      } else {
        if (firstResult.status === 'rejected') throw firstResult.reason
        expect(firstResult.value?.transaction.state).toBe('applied')
        // The second preview either sees restored files (no-op), or its captured
        // forward snapshots fail validation. It must never apply a second inverse.
        const result = secondResult.status === 'rejected' ? secondResult.reason : secondResult.value
        expect(result === null || result instanceof Error).toBe(true)
      }
      expect(await other.loadOperationRecord(value.operationId, value.requestId)).toMatchObject({ transaction: { state: 'retained' } })
      expect(await readFile(join(value.workspace, 'old.txt'), 'utf8')).toBe('old.txt\r\n')
    } finally {
      // Assertions, I/O errors, and gate failures must not leave live operations
      // racing afterEach's recursive removal of their fixture directories.
      release()
      await Promise.all(pending)
    }
  })

  it.skipIf(process.platform === 'win32')('restores ordinary file permissions from the source preimage', async () => {
    const value = await fixture()
    const target = join(value.workspace, 'mode.txt')
    await writeFile(target, 'executable\n')
    await chmod(target, 0o751)
    const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [{ type: 'delete', path: target }] }), value.workspace)
    const source = await value.store.executePatch(resolved.input, await captureFilePatchPreimages(resolved.targets), value.requestId, { operationId: randomUUID() })
    await value.store.restorePatch(source.operationId, value.requestId, value.requestId, async () => {}, { operationId: randomUUID() })
    expect((await stat(target)).mode & 0o777).toBe(0o751)
  })

  it('rolls back changed members if an initially unchanged member is edited during commit', async () => {
    const value = await fixture()
    const unchanged = join(value.workspace, 'old.txt')
    await writeFile(unchanged, 'old.txt\r\n')
    const createWriter = value.store.createPatchPersistence.bind(value.store)
    let injected = false
    vi.spyOn(value.store, 'createPatchPersistence').mockImplementation((requestId, id) => {
      const writer = createWriter(requestId, id)
      return { ...writer, persist: async (record) => {
        await writer.persist(record)
        if (!injected && record.entries.every((entry) => entry.state === 'applied')) {
          injected = true
          await writeFile(unchanged, 'user change')
        }
      } }
    })
    await expect(value.store.restorePatch(value.operationId, value.requestId, value.requestId, async () => {}, { operationId: randomUUID() })).rejects.toThrow()
    expect(injected).toBe(true)
    expect(await readFile(unchanged, 'utf8')).toBe('user change')
    expect(await readFile(join(value.workspace, 'nested/empty.txt'), 'utf8')).toBe('')
    expect(await readFile(join(value.workspace, 'moved.txt'), 'utf8')).toBe('move.txt\r\n')
  })

  it.each(['prepared', 'intent', 'partial', 'applied'] as const)('retains both durable operations after a reverse %s hard exit without replay', async (phase) => {
    const value = await fixture(), operationId = randomUUID(), requestId = randomUUID()
    const crashed = spawnSync(process.execPath, [fileURLToPath(new URL('./agent/toolEffectHardCrashFixture.mjs', import.meta.url)), JSON.stringify({
      scenario: 'file_patch_store', phase, workspace: value.workspace, recordsRoot: value.store.root, requestId, operationId,
      sourceRequestId: value.requestId, sourceOperationId: value.operationId, viteCacheDirectory: join(value.root, 'reverse-cache')
    })], { cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 20_000 })
    expect(crashed.status, crashed.stderr).toBe(83)
    const reopened = new FileEditStore(value.store.root)
    const record = await reopened.loadOperationRecord(operationId, requestId)
    expect(record).toMatchObject({ transaction: { restores: { operationId: value.operationId } } })
    expect(await readFile(join(value.workspace, 'old.txt'), 'utf8')).toBe(phase === 'partial' || phase === 'applied' ? 'old.txt\r\n' : 'changed\r\n')
    await expect(reopened.restorePatch(value.operationId, value.requestId, requestId, async () => {}, { operationId })).rejects.toThrow('already exists')
    await reopened.deleteFileEditRecordsForRequest(value.requestId)
    await reopened.deleteFileEditRecordsForRequest(requestId)
    expect(await reopened.listRetainedEditRecords()).toHaveLength(2)
  })
})

describe('batch restore preflight', () => {
  it('plans every update/create/delete/move target without changing any file or record', async () => {
    const value = await fixture()
    const metadata = join(value.store.editRecordDir(value.requestId, value.operationId), 'record.json')
    const before = await readFile(metadata, 'utf8')
    const inode = (await stat(join(value.workspace, 'old.txt'))).ino
    const authorize = vi.fn<AuthorizeFilePatchRestore>(async () => {})
    const plan = await value.store.previewPatchRestore(value.operationId, value.requestId, authorize)
    expect(plan.status).toBe('ready')
    expect(plan.entries.map((entry) => entry.action)).toEqual(['restore_text', 'remove_created', 'restore_text', 'restore_text', 'remove_created'])
    expect(authorize).toHaveBeenCalledOnce()
    expect(authorize.mock.calls[0][0]).toHaveLength(6) // Five files plus the created parent directory.
    expect(plan.cleanup).toMatchObject([{ kind: 'directory', action: 'keep' }])
    expect(await readFile(metadata, 'utf8')).toBe(before)
    expect((await stat(join(value.workspace, 'old.txt'))).ino).toBe(inode)
    expect(await readFile(join(value.workspace, 'old.txt'), 'utf8')).toBe('changed\r\n')
    expect(plan.entries[4].observed.text).toBe('move.txt\r\n')
  })

  it.each(['strict_approval', 'read_only_allowed', 'full_access'] as const)('uses all targets with the existing %s policy', async (accessMode) => {
    const value = await fixture(true)
    const plan = await value.store.previewPatchRestore(value.operationId, value.requestId, async (targets) => {
      const authorization = await prepareFilePatchRestoreAuthorization({ targets, primaryFolder: value.workspace,
        trustedFolders: [value.workspace], accessMode })
      expect(authorization.targets).toHaveLength(targets.length)
      expect(authorization.requiresApproval).toBe(accessMode !== 'full_access')
      expect(authorization.targets.some((target) => target.canonicalPath === join(value.root, 'outside'))).toBe(true)
    })
    expect(plan.status).toBe('ready')
  })

  it('does not add approval for an entirely in-project batch', async () => {
    const value = await fixture()
    await value.store.previewPatchRestore(value.operationId, value.requestId, async (targets) => {
      const result = await prepareFilePatchRestoreAuthorization({ targets, primaryFolder: value.workspace,
        trustedFolders: [value.workspace], accessMode: 'read_only_allowed' })
      expect(result.requiresApproval).toBe(false)
    })
  })

  it('does not read target contents before the complete host authorization returns', async () => {
    const value = await fixture()
    vi.mocked(open).mockClear()
    await expect(value.store.previewPatchRestore(value.operationId, value.requestId, async () => {
      throw new Error('denied')
    })).rejects.toThrow('denied')
    expect(vi.mocked(open).mock.calls.filter(([path]) => String(path).startsWith(value.workspace))).toEqual([])
  })

  it.each(['external-edit', 'same-content-replacement'])('does not claim ownership after %s', async (fault) => {
    const value = await fixture()
    const target = join(value.workspace, 'old.txt')
    if (fault === 'external-edit') await writeFile(target, 'user change\n')
    else {
      await writeFile(join(value.workspace, 'replacement.txt'), 'changed\r\n')
      await rename(join(value.workspace, 'replacement.txt'), target)
    }
    const plan = await value.store.previewPatchRestore(value.operationId, value.requestId, async () => {})
    expect(plan.status).toBe('conflict')
    expect(plan.entries[0].action).toBe('conflict')
    expect(plan.cleanup.every((entry) => entry.action !== 'remove')).toBe(true)
  })

  it('treats externally restored original content only as a no-op', async () => {
    const value = await fixture()
    const target = join(value.workspace, 'old.txt')
    await writeFile(join(value.workspace, 'replacement.txt'), 'old.txt\r\n')
    await rename(join(value.workspace, 'replacement.txt'), target)
    const inode = (await stat(target)).ino
    const plan = await value.store.previewPatchRestore(value.operationId, value.requestId, async () => {})
    expect(plan.entries[0].action).toBe('already_original')
    expect((await stat(target)).ino).toBe(inode)
    expect((await value.store.loadOperationRecord(value.operationId, value.requestId))).toMatchObject({ transaction: { state: 'applied' } })
  })

  it('rejects a record revision changed while authorization was pending', async () => {
    const value = await fixture()
    await expect(value.store.previewPatchRestore(value.operationId, value.requestId, async () => {
      await value.store.deleteFileEditRecordsForRequest(value.requestId, [value.operationId])
    })).rejects.toThrow('changed during restore preview')
  })

  it('reports edits made during authorization as conflicts', async () => {
    const value = await fixture()
    const plan = await value.store.previewPatchRestore(value.operationId, value.requestId, async () => {
      await writeFile(join(value.workspace, 'old.txt'), 'user changed while waiting')
    })
    expect(plan.status).toBe('conflict')
    expect(plan.entries[0].action).toBe('conflict')
  })

  it.skipIf(process.platform === 'win32')('rejects a link substituted during authorization before reading it', async () => {
    const value = await fixture()
    const path = join(value.workspace, 'old.txt')
    const outside = join(value.root, 'private.txt')
    await writeFile(outside, 'outside')
    vi.mocked(open).mockClear()
    await expect(value.store.previewPatchRestore(value.operationId, value.requestId, async () => {
      await rm(path)
      await symlink(outside, path)
    })).rejects.toThrow('target changed')
    expect(vi.mocked(open).mock.calls.some(([path]) => path === outside)).toBe(false)
  })

  it('does not let a callback mutate the stored target list', async () => {
    const value = await fixture()
    const plan = await value.store.previewPatchRestore(value.operationId, value.requestId, async (targets) => {
      const mutable = targets as unknown as Array<{ path: string }>
      mutable[0].path = join(value.root, 'different.txt')
    })
    expect(plan.entries[0].path).toBe(join(value.workspace, 'old.txt'))
  })

  it('honors cancellation before target reads and does not change records', async () => {
    const value = await fixture()
    const controller = new AbortController()
    await expect(value.store.previewPatchRestore(value.operationId, value.requestId, async () => {
      controller.abort(new Error('cancelled'))
    }, controller.signal)).rejects.toThrow('cancelled')
    expect(await value.store.loadOperationRecord(value.operationId, value.requestId)).toEqual(value.record)
  })

  it('repeats preflight without changing operation identity or revision', async () => {
    const value = await fixture()
    const first = await value.store.previewPatchRestore(value.operationId, value.requestId, async () => {})
    const second = await value.store.previewPatchRestore(value.operationId, value.requestId, async () => {})
    expect(second).toEqual(first)
    expect(second.revision).toBe(value.record.revision)
  })

  it('rejects missing original material before authorization or target reads', async () => {
    const value = await fixture()
    await rm(join(value.store.editRecordDir(value.requestId, value.operationId), '0.before.txt'))
    const authorize = vi.fn<AuthorizeFilePatchRestore>(async () => {})
    vi.mocked(open).mockClear()
    await expect(value.store.previewPatchRestore(value.operationId, value.requestId, authorize)).rejects.toThrow('Cannot load batch edit')
    expect(authorize).not.toHaveBeenCalled()
    expect(vi.mocked(open).mock.calls.filter(([path]) => String(path).startsWith(value.workspace))).toEqual([])
  })

  it('preserves user files in a directory created by the patch', async () => {
    const value = await fixture()
    const path = join(value.workspace, 'nested', 'user.txt')
    await writeFile(path, 'user content')
    const plan = await value.store.previewPatchRestore(value.operationId, value.requestId, async () => {})
    expect(plan.cleanup).toMatchObject([{ kind: 'directory', action: 'keep' }])
    expect(await readFile(path, 'utf8')).toBe('user content')
  })

  it.each(['intent', 'partial', 'applied'] as const)('previews persisted %s after a hard exit without replaying it', async (phase) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'anas-restore-crash-')))
    roots.push(root)
    const workspace = join(root, 'workspace')
    await mkdir(workspace)
    await writeFile(join(workspace, 'old.txt'), 'before\n')
    const store = new FileEditStore(join(root, 'records'))
    const requestId = randomUUID(), operationId = randomUUID()
    const crashed = spawnSync(process.execPath, [fileURLToPath(new URL('./agent/toolEffectHardCrashFixture.mjs', import.meta.url)), JSON.stringify({
      scenario: 'file_patch_store', phase, workspace, recordsRoot: store.root, requestId, operationId, viteCacheDirectory: join(root, 'cache')
    })], { cwd: process.cwd(), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 20_000 })
    expect(crashed.status, crashed.stderr).toBe(83)
    const record = await store.loadOperationRecord(operationId, requestId)
    if (record.tool !== 'apply_patch') throw new Error('Expected batch')
    if (phase === 'intent') await writeFile(join(workspace, 'old.txt'), 'after\n') // Outcome lacks a durable postimage.
    const plan = await planFilePatchRestore(record, async () => {})
    expect(plan.entries[0].action).toBe(phase === 'intent' ? 'conflict' : 'restore_text')
    expect(plan.entries[1].action).toBe(phase === 'applied' ? 'remove_created' : 'already_original')
    expect(await store.loadOperationRecord(operationId, requestId)).toEqual(record)
    expect(await readFile(join(workspace, 'old.txt'), 'utf8')).toBe('after\n')
  })
})
