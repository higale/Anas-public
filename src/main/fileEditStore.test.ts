import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveFilePatchTargets } from './filePatch'
import { asPatchInput } from './filePatchTestFixtures'
import { captureFilePatchPreimages } from './filePatchState'
import { executeFilePatchTransaction, type FilePatchTransaction } from './filePatchTransaction'
import {
  assertManagedDirectChildPath,
  FileEditStore,
  isFileEditInternalId,
  managedDirectChildPath,
  pathExists
} from './fileEditStore'

const temporaryDirectories: string[] = []
const pathTestId = '01234567-89ab-4cde-8fab-0123456789ab'

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'anas-file-edit-store-'))
  temporaryDirectories.push(directory)
  return directory
}

async function prepareRecord(store: FileEditStore, targetPath: string, requestId: string) {
  const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [{ type: 'create', path: targetPath, content: 'after\n' }] }), path.dirname(targetPath))
  const preimages = await captureFilePatchPreimages(resolved.targets)
  const operationId = randomUUID()
  let prepared!: FilePatchTransaction
  await expect(executeFilePatchTransaction(operationId, resolved.input, preimages, async (record) => {
    prepared = structuredClone(record)
    throw new Error('prepared only')
  })).rejects.toThrow('prepared only')
  await store.createPatchPersistence(requestId, operationId).persist(prepared)
  return store.loadOperationRecord(operationId, requestId)
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

describe('managed file edit paths', () => {
  it('resolves exactly one POSIX or Windows UUID child', () => {
    expect(managedDirectChildPath('/var/lib/anas/file_edits', pathTestId, path.posix)).toBe(
      `/var/lib/anas/file_edits/${pathTestId}`
    )
    expect(managedDirectChildPath('C:\\Users\\user\\Anas\\file_edits', pathTestId, path.win32)).toBe(
      `C:\\Users\\user\\Anas\\file_edits\\${pathTestId}`
    )
    expect(() => assertManagedDirectChildPath(
      'c:\\users\\user\\anas\\file_edits',
      `C:\\Users\\User\\Anas\\file_edits\\${pathTestId}`,
      pathTestId,
      path.win32
    )).not.toThrow()
  })

  it('rejects non-canonical IDs before resolving a path', () => {
    const invalidIds = [
      '',
      '.',
      '..',
      '../outside',
      '..\\outside',
      '/absolute/outside',
      'C:\\absolute\\outside',
      'C:drive-relative',
      '\\\\server\\share\\outside',
      `${pathTestId}/nested`,
      `${pathTestId}\\nested`,
      `${pathTestId}.`,
      `${pathTestId} `,
      `${pathTestId}:stream`,
      pathTestId.toUpperCase(),
      '00000000-0000-0000-0000-000000000000',
      'not-a-uuid'
    ]
    for (const id of invalidIds) {
      expect(isFileEditInternalId(id)).toBe(false)
      expect(() => managedDirectChildPath('/var/lib/anas/file_edits', id, path.posix)).toThrow(
        'managed directory id is invalid'
      )
      expect(() => managedDirectChildPath('C:\\Anas\\file_edits', id, path.win32)).toThrow(
        'managed directory id is invalid'
      )
    }
  })

  it('rejects roots, descendants, siblings, and other Windows drives', () => {
    expect(() => assertManagedDirectChildPath(
      '/opt/anas/file_edits',
      '/opt/anas/file_edits',
      pathTestId,
      path.posix
    )).toThrow('not the expected direct child')
    expect(() => assertManagedDirectChildPath(
      '/opt/anas/file_edits',
      `/opt/anas/file_edits/${pathTestId}/nested`,
      pathTestId,
      path.posix
    )).toThrow('not the expected direct child')
    expect(() => assertManagedDirectChildPath(
      '/opt/anas/file_edits',
      `/opt/anas/file_edits-old/${pathTestId}`,
      pathTestId,
      path.posix
    )).toThrow('not the expected direct child')
    expect(() => assertManagedDirectChildPath(
      'C:\\Anas\\file_edits',
      `D:\\Anas\\file_edits\\${pathTestId}`,
      pathTestId,
      path.win32
    )).toThrow('not the expected direct child')
  })
})

describe('file edit store lifecycle', () => {
  it('loads a prepared batch after moving the store without absolute asset paths', async () => {
    const directory = await temporaryDirectory()
    const store = new FileEditStore(join(directory, 'records'))
    const requestId = randomUUID()
    const record = await prepareRecord(store, join(directory, 'new.txt'), requestId)
    const moved = join(directory, 'moved')
    await rename(store.root, moved)
    const reopened = new FileEditStore(moved)
    expect(await reopened.loadOperationRecord(record.operationId, requestId)).toEqual(record)
    expect(await reopened.listEditRecordsForRequest(requestId)).toEqual([record])
    await reopened.deleteFileEditRecordsForRequest(requestId)
    expect(await readdir(moved)).toEqual([])
  })

  it('rejects a corrupted immutable snapshot without deleting its evidence', async () => {
    const directory = await temporaryDirectory()
    const store = new FileEditStore(join(directory, 'records'))
    const requestId = randomUUID()
    const record = await prepareRecord(store, join(directory, 'new.txt'), requestId)
    const asset = join(store.editRecordDir(requestId, record.operationId), '0.after.txt')
    await writeFile(asset, 'changed')
    await expect(store.loadOperationRecord(record.operationId, requestId)).rejects.toThrow()
    await expect(store.deleteFileEditRecordsForRequest(requestId)).rejects.toThrow()
    expect(await readFile(asset, 'utf8')).toBe('changed')
  })

  it.each(['', '中文\r\n原文\r\n'])('preserves exact original text across reopen and restore: %j', async (before) => {
    const directory = await temporaryDirectory()
    const store = new FileEditStore(join(directory, 'records'))
    const requestId = randomUUID(), target = join(directory, 'old.txt')
    await writeFile(target, before)
    const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [{ type: 'delete', path: target }] }), directory)
    const record = await store.executePatch(resolved.input, await captureFilePatchPreimages(resolved.targets), requestId, { operationId: randomUUID() })
    const reopened = new FileEditStore(store.root)
    expect((await reopened.loadOperationRecord(record.operationId, requestId)).transaction.entries[0].before.text).toBe(before)
    const inverse = await reopened.restorePatch(record.operationId, requestId, randomUUID(), async () => {}, { operationId: randomUUID() })
    expect(inverse?.transaction.state).toBe('applied')
    expect(await readFile(target, 'utf8')).toBe(before)
  })

  it('deletes only the requested direct child and preserves the managed root and siblings', async () => {
    const temporaryRoot = await temporaryDirectory()
    const managedRoot = join(temporaryRoot, 'file_edits')
    const store = new FileEditStore(managedRoot)
    const deletedRequestId = randomUUID()
    const retainedRequestId = randomUUID()
    const outsideSentinel = join(temporaryRoot, 'outside.txt')
    await writeFile(outsideSentinel, 'keep', 'utf8')
    await prepareRecord(store, join(temporaryRoot, 'missing-a.txt'), deletedRequestId)
    await prepareRecord(store, join(temporaryRoot, 'missing-b.txt'), retainedRequestId)
    const rootIdentity = await lstat(managedRoot)

    await store.deleteFileEditRecordsForRequest(deletedRequestId)

    expect(await pathExists(store.editRecordsDir(deletedRequestId))).toBe(false)
    expect(await pathExists(store.editRecordsDir(retainedRequestId))).toBe(true)
    expect(await pathExists(managedRoot)).toBe(true)
    expect(await readFile(outsideSentinel, 'utf8')).toBe('keep')
    const retainedRootIdentity = await lstat(managedRoot)
    expect({ device: retainedRootIdentity.dev, inode: retainedRootIdentity.ino }).toEqual({
      device: rootIdentity.dev,
      inode: rootIdentity.ino
    })
  })

  it('treats cleanup of a missing root or request directory as idempotent', async () => {
    const temporaryRoot = await temporaryDirectory()
    const managedRoot = join(temporaryRoot, 'file_edits')
    const store = new FileEditStore(managedRoot)
    const requestId = randomUUID()

    await store.deleteFileEditRecordsForRequest(requestId)
    await store.deleteFileEditRecordsForRequest(requestId)
    expect(await pathExists(managedRoot)).toBe(false)

    await mkdir(managedRoot)
    await store.deleteFileEditRecordsForRequest(requestId)
    await store.deleteFileEditRecordsForRequest(requestId)
    expect(await readdir(managedRoot)).toEqual([])
  })

  it('rejects invalid request and operation IDs without touching the filesystem', async () => {
    const temporaryRoot = await temporaryDirectory()
    const managedRoot = join(temporaryRoot, 'file_edits')
    const store = new FileEditStore(managedRoot)
    const requestId = randomUUID()
    await mkdir(managedRoot, { recursive: true })
    const sentinel = join(temporaryRoot, 'sentinel.txt')
    await writeFile(sentinel, 'keep', 'utf8')

    await expect(store.deleteFileEditRecordsForRequest('../outside')).rejects.toThrow('request id is invalid')
    expect(() => store.createPatchPersistence('..\\outside', randomUUID())).toThrow('request id is invalid')
    await expect(store.loadOperationRecord('../outside', requestId)).rejects.toThrow('operation_id is invalid')

    expect(await readdir(managedRoot)).toEqual([])
    expect(await readFile(sentinel, 'utf8')).toBe('keep')
  })

  it.skipIf(process.platform === 'win32')('does not follow a request-directory symlink during recursive deletion', async () => {
    const temporaryRoot = await temporaryDirectory()
    const managedRoot = join(temporaryRoot, 'file_edits')
    const outsideDirectory = join(temporaryRoot, 'outside')
    const outsideSentinel = join(outsideDirectory, 'sentinel.txt')
    const store = new FileEditStore(managedRoot)
    const requestId = randomUUID()
    await mkdir(managedRoot, { recursive: true })
    await mkdir(outsideDirectory)
    await writeFile(outsideSentinel, 'keep', 'utf8')
    await symlink(outsideDirectory, store.editRecordsDir(requestId), 'dir')

    await expect(store.deleteFileEditRecordsForRequest(requestId)).rejects.toThrow('is not a real directory')

    expect((await lstat(store.editRecordsDir(requestId))).isSymbolicLink()).toBe(true)
    expect(await readFile(outsideSentinel, 'utf8')).toBe('keep')
  })

  it.runIf(process.platform === 'win32')('does not follow a request-directory junction during recursive deletion', async () => {
    const temporaryRoot = await temporaryDirectory()
    const managedRoot = join(temporaryRoot, 'file_edits')
    const outsideDirectory = join(temporaryRoot, 'outside')
    const outsideSentinel = join(outsideDirectory, 'sentinel.txt')
    const store = new FileEditStore(managedRoot)
    const requestId = randomUUID()
    await mkdir(managedRoot, { recursive: true })
    await mkdir(outsideDirectory)
    await writeFile(outsideSentinel, 'keep', 'utf8')
    await symlink(outsideDirectory, store.editRecordsDir(requestId), 'junction')

    await expect(store.deleteFileEditRecordsForRequest(requestId)).rejects.toThrow('is not a real directory')

    expect((await lstat(store.editRecordsDir(requestId))).isSymbolicLink()).toBe(true)
    expect(await readFile(outsideSentinel, 'utf8')).toBe('keep')
  })

  it('rejects a non-directory managed root', async () => {
    const temporaryRoot = await temporaryDirectory()
    const managedRoot = join(temporaryRoot, 'file_edits')
    const store = new FileEditStore(managedRoot)
    await writeFile(managedRoot, 'not a directory', 'utf8')

    await expect(store.deleteFileEditRecordsForRequest(randomUUID())).rejects.toThrow(
      'Managed file edit root is not a real directory'
    )
    expect(await readFile(managedRoot, 'utf8')).toBe('not a directory')
  })

  it.skipIf(process.platform === 'win32')('rejects a symlink used as the managed root', async () => {
    const temporaryRoot = await temporaryDirectory()
    const managedRoot = join(temporaryRoot, 'file_edits')
    const outsideDirectory = join(temporaryRoot, 'outside-root')
    const requestId = randomUUID()
    const outsideSentinel = join(outsideDirectory, 'sentinel.txt')
    await mkdir(join(outsideDirectory, requestId), { recursive: true })
    await writeFile(outsideSentinel, 'keep', 'utf8')
    await symlink(outsideDirectory, managedRoot, 'dir')
    const store = new FileEditStore(managedRoot)

    await expect(store.deleteFileEditRecordsForRequest(requestId)).rejects.toThrow(
      'Managed file edit root is not a real directory'
    )
    expect((await lstat(managedRoot)).isSymbolicLink()).toBe(true)
    expect(await readFile(outsideSentinel, 'utf8')).toBe('keep')
  })

  it.runIf(process.platform === 'win32')('rejects a junction used as the managed root', async () => {
    const temporaryRoot = await temporaryDirectory()
    const managedRoot = join(temporaryRoot, 'file_edits')
    const outsideDirectory = join(temporaryRoot, 'outside-root')
    const requestId = randomUUID()
    const outsideSentinel = join(outsideDirectory, 'sentinel.txt')
    await mkdir(join(outsideDirectory, requestId), { recursive: true })
    await writeFile(outsideSentinel, 'keep', 'utf8')
    await symlink(outsideDirectory, managedRoot, 'junction')
    const store = new FileEditStore(managedRoot)

    await expect(store.deleteFileEditRecordsForRequest(requestId)).rejects.toThrow(
      'Managed file edit root is not a real directory'
    )
    expect((await lstat(managedRoot)).isSymbolicLink()).toBe(true)
    expect(await readFile(outsideSentinel, 'utf8')).toBe('keep')
  })
})
