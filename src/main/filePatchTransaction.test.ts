import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveFilePatchTargets } from './filePatch'
import { asPatchInput } from './filePatchTestFixtures'
import { captureFilePatchPreimages, verifyFilePatchPreimages } from './filePatchState'
import { executeFilePatchTransaction as executeTransaction, FilePatchTransactionError, type FilePatchTransaction } from './filePatchTransaction'
import { randomUUID } from 'node:crypto'

function executeFilePatchTransaction(
  input: Parameters<typeof executeTransaction>[1], preimages: Parameters<typeof executeTransaction>[2],
  persist: Parameters<typeof executeTransaction>[3], signal?: AbortSignal
) {
  return executeTransaction(randomUUID(), input, preimages, persist, signal)
}

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, rename: vi.fn(original.rename), link: vi.fn(original.link) }
})

vi.mock('./filePatchState', async (importOriginal) => {
  const original = await importOriginal<typeof import('./filePatchState')>()
  return { ...original, verifyFilePatchPreimages: vi.fn(original.verifyFilePatchPreimages) }
})

const roots: string[] = []
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'anas-patch-transaction-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  vi.mocked(rename).mockReset()
  vi.mocked(link).mockReset()
  vi.mocked(verifyFilePatchPreimages).mockReset()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function prepare(root: string, operations: Parameters<typeof asPatchInput>[0]['operations']) {
  const resolved = await resolveFilePatchTargets(asPatchInput({ operations }), root)
  return { input: resolved.input, preimages: await captureFilePatchPreimages(resolved.targets) }
}

const patch = '@@\n-before\n+after\n'

describe('batch patch transaction execution', () => {
  it('stages all targets before committing create/update/delete/move, including empty files and parents', async () => {
    const root = await directory()
    await writeFile(join(root, 'update.txt'), 'before\n')
    await writeFile(join(root, 'delete.txt'), '')
    await writeFile(join(root, 'source.txt'), '\ufeff中文\r\n')
    const { input, preimages } = await prepare(root, [
      { type: 'update', path: 'update.txt', patch },
      { type: 'delete', path: 'delete.txt' },
      { type: 'move', path: 'source.txt', destination: 'nested/moved.txt' },
      { type: 'create', path: 'nested/deep/empty.txt', content: '' }
    ])
    const history: FilePatchTransaction[] = []
    const result = await executeFilePatchTransaction(input, preimages, async (record) => {
      history.push(structuredClone(record))
      if (record.state === 'committing' && record.entries.every((entry) => entry.state === 'pending')) {
        expect(record.temporary.filter((entry) => entry.identity)).toHaveLength(3)
        expect(await readFile(join(root, 'update.txt'), 'utf8')).toBe('before\n')
        expect(await readFile(join(root, 'source.txt'), 'utf8')).toBe('\ufeff中文\r\n')
      }
      if (record.state === 'prepared' && !record.temporary.length && !record.directories.length) {
        expect(await readdir(root)).toEqual(['delete.txt', 'source.txt', 'update.txt'])
      }
    })
    expect(result.state).toBe('applied')
    expect(result.errors).toEqual([])
    expect(history[0].entries.every((entry) => entry.after === null)).toBe(true)
    expect(await readFile(join(root, 'update.txt'), 'utf8')).toBe('after\n')
    expect(await readFile(join(root, 'nested/moved.txt'), 'utf8')).toBe('\ufeff中文\r\n')
    expect(await readFile(join(root, 'nested/deep/empty.txt'), 'utf8')).toBe('')
    await expect(lstat(join(root, 'source.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(join(root, 'delete.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    for (const temporary of result.temporary) await expect(lstat(temporary.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not touch the filesystem if the initial record cannot be persisted', async () => {
    const root = await directory()
    const { input, preimages } = await prepare(root, [{ type: 'create', path: 'new/nested.txt', content: 'new' }])
    await expect(executeFilePatchTransaction(input, preimages, async () => { throw new Error('disk full') })).rejects.toThrow('disk full')
    expect(await readdir(root)).toEqual([])
  })

  it('rolls back earlier writes and removes owned empty parents after a later intent fails', async () => {
    const root = await directory()
    await writeFile(join(root, 'old.txt'), 'before\n')
    const { input, preimages } = await prepare(root, [
      { type: 'update', path: 'old.txt', patch },
      { type: 'create', path: 'new/empty.txt', content: '' },
      { type: 'create', path: 'new/deep/last.txt', content: 'last' }
    ])
    let failed = false
    let failure: FilePatchTransactionError | undefined
    try {
      await executeFilePatchTransaction(input, preimages, async (record) => {
        if (!failed && record.entries[2].state === 'intent') {
          failed = true
          throw new Error('injected record failure')
        }
      })
    } catch (error) { failure = error as FilePatchTransactionError }
    expect(failure).toBeInstanceOf(FilePatchTransactionError)
    expect(failure?.record.state).toBe('restored')
    expect(await readFile(join(root, 'old.txt'), 'utf8')).toBe('before\n')
    expect(await readdir(root)).toEqual(['old.txt'])
  })

  it('cancellation after a deletion restores its preimage without an abortable rollback', async () => {
    const root = await directory()
    await writeFile(join(root, 'old.txt'), 'before\r\n')
    const { input, preimages } = await prepare(root, [
      { type: 'delete', path: 'old.txt' },
      { type: 'create', path: 'new.txt', content: 'new' }
    ])
    const controller = new AbortController()
    await expect(executeFilePatchTransaction(input, preimages, async (record) => {
      if (record.entries[0].state === 'applied') controller.abort(new Error('cancel after delete'))
    }, controller.signal)).rejects.toMatchObject({ record: { state: 'restored' } })
    expect(await readFile(join(root, 'old.txt'), 'utf8')).toBe('before\r\n')
    expect(await readdir(root)).toEqual(['old.txt'])
  })

  it.each(['change', 'replace_same_text'])('preserves an external %s of an applied file during rollback', async (action) => {
    const root = await directory()
    const path = join(root, 'old.txt')
    await writeFile(path, 'before\n')
    const { input, preimages } = await prepare(root, [
      { type: 'update', path: 'old.txt', patch },
      { type: 'create', path: 'next.txt', content: '' }
    ])
    let injected = false
    await expect(executeFilePatchTransaction(input, preimages, async (record) => {
      if (!injected && record.entries[0].state === 'applied') {
        injected = true
        if (action === 'change') await writeFile(path, 'user edit')
        else {
          await writeFile(join(root, 'replacement'), 'after\n')
          await rename(join(root, 'replacement'), path)
        }
        throw new Error('stop transaction')
      }
    })).rejects.toMatchObject({ record: { state: 'retained', entries: [{ state: 'conflict' }, { state: 'pending' }] } })
    expect(await readFile(path, 'utf8')).toBe(action === 'change' ? 'user edit' : 'after\n')
    expect(await readdir(root)).toEqual(['old.txt'])
  })

  it('rejects an occupied create target without overwriting it', async () => {
    const root = await directory()
    const { input, preimages } = await prepare(root, [{ type: 'create', path: 'new.txt', content: 'new' }])
    let injected = false
    await expect(executeFilePatchTransaction(input, preimages, async (record) => {
      if (!injected && record.entries[0].state === 'intent') {
        injected = true
        await writeFile(join(root, 'new.txt'), 'user file')
      }
    })).rejects.toMatchObject({ record: { state: 'retained' } })
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('user file')
  })

  it('rolls back an earlier update after a later filesystem write fails', async () => {
    const root = await directory()
    await writeFile(join(root, 'old.txt'), 'before\n')
    const { input, preimages } = await prepare(root, [
      { type: 'update', path: 'old.txt', patch },
      { type: 'create', path: 'new.txt', content: 'new' }
    ])
    vi.mocked(link).mockRejectedValueOnce(Object.assign(new Error('injected filesystem failure'), { code: 'EIO' }))
    await expect(executeFilePatchTransaction(input, preimages, async () => {})).rejects.toMatchObject({ record: { state: 'restored' } })
    expect(await readFile(join(root, 'old.txt'), 'utf8')).toBe('before\n')
    expect(await readdir(root)).toEqual(['old.txt'])
  })

  it('does not adopt an external replacement between the write and result capture', async () => {
    const root = await directory()
    await writeFile(join(root, 'old.txt'), 'before\n')
    const { input, preimages } = await prepare(root, [{ type: 'update', path: 'old.txt', patch }])
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.mocked(rename).mockImplementationOnce(async (source, destination) => {
      await actual.rename(source, destination)
      await writeFile(join(root, 'external'), 'after\n')
      await actual.rename(join(root, 'external'), destination)
    })
    await expect(executeFilePatchTransaction(input, preimages, async () => {})).rejects.toMatchObject({ record: { state: 'retained' } })
    expect(await readFile(join(root, 'old.txt'), 'utf8')).toBe('after\n')
  })

  it('rechecks the destination after potentially slow staged-content verification', async () => {
    const root = await directory()
    const path = join(root, 'old.txt')
    await writeFile(path, 'before\n')
    const { input, preimages } = await prepare(root, [{ type: 'update', path: 'old.txt', patch }])
    const actual = await vi.importActual<typeof import('./filePatchState')>('./filePatchState')
    let injected = false
    vi.mocked(verifyFilePatchPreimages).mockImplementation(async (snapshots, signal) => {
      await actual.verifyFilePatchPreimages(snapshots, signal)
      if (!injected && snapshots[0].target.canonicalPath.includes('.anas-patch-')) {
        injected = true
        await writeFile(path, 'user edit during stage check')
      }
    })
    await expect(executeFilePatchTransaction(input, preimages, async () => {})).rejects.toMatchObject({ record: { state: 'retained' } })
    expect(await readFile(path, 'utf8')).toBe('user edit during stage check')
  })

  it.each(['directory', 'temporary'])('rechecks the parent after persisting a %s creation intent', async (kind) => {
    const root = await directory()
    const outside = await directory()
    const parent = join(root, 'parent')
    await mkdir(parent)
    const { input, preimages } = await prepare(root, [{
      type: 'create', path: kind === 'directory' ? 'parent/new/file.txt' : 'parent/file.txt', content: 'new'
    }])
    let injected = false
    await expect(executeFilePatchTransaction(input, preimages, async (record) => {
      const entries = kind === 'directory' ? record.directories : record.temporary
      if (!injected && entries.some((entry) => entry.identity === null)) {
        injected = true
        await rename(parent, join(root, 'original-parent'))
        await symlink(outside, parent, process.platform === 'win32' ? 'junction' : 'dir')
      }
    })).rejects.toBeInstanceOf(FilePatchTransactionError)
    expect(injected).toBe(true)
    expect(await readdir(outside)).toEqual([])
    expect(await readdir(join(root, 'original-parent'))).toEqual([])
  })

  it('rechecks staged bytes before installing them over the original file', async () => {
    const root = await directory()
    await writeFile(join(root, 'old.txt'), 'before\n')
    const { input, preimages } = await prepare(root, [{ type: 'update', path: 'old.txt', patch }])
    let injected = false
    await expect(executeFilePatchTransaction(input, preimages, async (record) => {
      if (!injected && record.state === 'committing') {
        injected = true
        await writeFile(record.temporary[0].path, 'broken stage')
      }
    })).rejects.toMatchObject({ record: { state: 'restored' } })
    expect(await readFile(join(root, 'old.txt'), 'utf8')).toBe('before\n')
    expect(await readdir(root)).toEqual(['old.txt'])
  })

  it('does not delete a replacement of an owned temporary file during cleanup', async () => {
    const root = await directory()
    await writeFile(join(root, 'old.txt'), 'before\n')
    const { input, preimages } = await prepare(root, [{ type: 'update', path: 'old.txt', patch }])
    let substituted: string | undefined
    let failure: FilePatchTransactionError | undefined
    try {
      await executeFilePatchTransaction(input, preimages, async (record) => {
        if (!substituted && record.state === 'committing') {
          substituted = record.temporary[0].path
          await writeFile(join(root, 'replacement'), 'external stage file')
          await rename(join(root, 'replacement'), substituted)
        }
      })
    } catch (error) { failure = error as FilePatchTransactionError }
    expect(failure?.record.state).toBe('restored')
    expect(failure?.record.errors.some((error) => error.includes('staging object changed'))).toBe(true)
    expect(await readFile(substituted!, 'utf8')).toBe('external stage file')
    expect(await readFile(join(root, 'old.txt'), 'utf8')).toBe('before\n')
  })

  it('leaves applied content and reports retained state when recording rollback also fails', async () => {
    const root = await directory()
    await writeFile(join(root, 'old.txt'), 'before\n')
    const { input, preimages } = await prepare(root, [{ type: 'update', path: 'old.txt', patch }])
    await expect(executeFilePatchTransaction(input, preimages, async (record) => {
      if (record.entries[0].after) throw new Error('record storage offline')
    })).rejects.toMatchObject({ record: { state: 'retained' } })
    // No unjournaled reverse write: the prepared record is the recovery evidence.
    expect(await readFile(join(root, 'old.txt'), 'utf8')).toBe('after\n')
  })

  it('retains nonempty created directories when another writer adds a file', async () => {
    const root = await directory()
    const { input, preimages } = await prepare(root, [{ type: 'create', path: 'new/owned.txt', content: '' }])
    const controller = new AbortController()
    await expect(executeFilePatchTransaction(input, preimages, async (record) => {
      if (!controller.signal.aborted && record.entries[0].state === 'applied') {
        await writeFile(join(root, 'new/user.txt'), 'keep')
        controller.abort()
      }
    }, controller.signal)).rejects.toMatchObject({ record: { state: 'restored' } })
    expect(await readdir(join(root, 'new'))).toEqual(['user.txt'])
  })

  it('does not expose mutable transaction inputs to the persistence callback', async () => {
    const root = await directory()
    const { input, preimages } = await prepare(root, [{ type: 'create', path: 'new.txt', content: 'new' }])
    const result = await executeFilePatchTransaction(input, preimages, async (record) => {
      record.entries[0].afterText = 'wrong'
      preimages[0].target.canonicalPath = join(root, 'wrong.txt')
      input.operations[0].path = join(root, 'wrong.txt')
    })
    expect(result.entries[0].afterText).toBe('new')
    expect(await readdir(root)).toEqual(['new.txt'])
    expect(await readFile(join(root, 'new.txt'), 'utf8')).toBe('new')
  })

  it('rejects dry-run execution, mismatched target sets and stale preimages before saving', async () => {
    const root = await directory()
    await writeFile(join(root, 'old.txt'), 'before\n')
    const { input, preimages } = await prepare(root, [{ type: 'update', path: 'old.txt', patch }])
    let saves = 0
    const persist = async () => { saves++ }
    await expect(executeFilePatchTransaction({ ...input, dry_run: true }, preimages, persist)).rejects.toThrow('Dry-run')
    await expect(executeFilePatchTransaction(input, [...preimages, preimages[0]], persist)).rejects.toThrow('targets')
    const wrongSemantics = structuredClone(preimages)
    wrongSemantics[0].target.semantics = 'entry'
    await expect(executeFilePatchTransaction(input, wrongSemantics, persist)).rejects.toThrow('targets')
    await writeFile(join(root, 'old.txt'), 'user edit')
    await expect(executeFilePatchTransaction(input, preimages, persist)).rejects.toThrow('changed')
    expect(saves).toBe(0)
  })

  it('does not replace a file for an exact no-op patch', async () => {
    const root = await directory()
    const path = join(root, 'old.txt')
    await writeFile(path, 'before\n')
    const original = await lstat(path, { bigint: true })
    const { input, preimages } = await prepare(root, [{ type: 'update', path: 'old.txt', patch: '@@\n-before\n+before\n' }])
    const result = await executeFilePatchTransaction(input, preimages, async () => {})
    expect(result.state).toBe('applied')
    expect(result.entries).toEqual([])
    expect((await lstat(path, { bigint: true })).ino).toBe(original.ino)
  })

  it.skipIf(process.platform === 'win32')('preserves executable permissions on update and move', async () => {
    const root = await directory()
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'update.sh'), 'before\n')
    await writeFile(join(root, 'move.sh'), 'before\n')
    await chmod(join(root, 'update.sh'), 0o751)
    await chmod(join(root, 'move.sh'), 0o750)
    const { input, preimages } = await prepare(root, [
      { type: 'update', path: 'update.sh', patch },
      { type: 'move', path: 'move.sh', destination: 'nested/moved.sh' }
    ])
    await executeFilePatchTransaction(input, preimages, async () => {})
    expect((await lstat(join(root, 'update.sh'))).mode & 0o777).toBe(0o751)
    expect((await lstat(join(root, 'nested/moved.sh'))).mode & 0o777).toBe(0o750)
  })
})
