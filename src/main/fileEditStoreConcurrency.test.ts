import { randomUUID } from 'node:crypto'
import { lstat, mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { FileEditStore } from './fileEditStore'
import { resolveFilePatchTargets } from './filePatch'
import { asPatchInput } from './filePatchTestFixtures'
import { captureFilePatchPreimages } from './filePatchState'
import { executeFilePatchTransaction, type FilePatchTransaction } from './filePatchTransaction'

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, open: vi.fn(original.open), lstat: vi.fn(original.lstat) }
})

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it('queues metadata replacement behind a record reader across store instances', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anas-edit-read-lock-'))
  roots.push(root)
  const store = new FileEditStore(join(root, 'records'))
  const reader = new FileEditStore(store.root)
  const requestId = randomUUID(), operationId = randomUUID()
  const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [
    { type: 'create', path: 'new.txt', content: 'after\n' }
  ] }), root)
  let prepared!: FilePatchTransaction
  await expect(executeFilePatchTransaction(operationId, resolved.input,
    await captureFilePatchPreimages(resolved.targets), async (record) => {
      prepared = structuredClone(record)
      throw new Error('Capture preparation only')
    })).rejects.toThrow('Capture preparation only')
  const writer = store.createPatchPersistence(requestId, operationId)
  await writer.persist(prepared)

  const original = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
  const metadataPath = join(store.editRecordDir(requestId, operationId), 'record.json')
  let notifyOpened!: () => void, release!: () => void
  const opened = new Promise<void>((resolve) => { notifyOpened = resolve })
  const released = new Promise<void>((resolve) => { release = resolve })
  let paused = false
  vi.mocked(open).mockImplementation(async (...args) => {
    const handle = await original.open(...args)
    if (!paused && args[0] === metadataPath) {
      paused = true
      notifyOpened()
      // Hold an actual read handle open, not a simulated filesystem result.
      await released
    }
    return handle
  })
  const pending: Promise<unknown>[] = []
  const observe = <T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> => {
    const result = promise.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason })
    )
    pending.push(result)
    return result
  }
  try {
    const reading = observe(reader.loadOperationRecord(operationId, requestId))
    await Promise.race([opened, reading.then((result) => {
      if (result.status === 'rejected') throw result.reason
      throw new Error('Reader completed before opening its metadata')
    })])
    vi.mocked(lstat).mockClear()
    const writing = observe(writer.persist(prepared))
    // exclusiveOperation enters its callback after one await. An unlocked
    // writer would already call lstat here, before its first filesystem await.
    await Promise.resolve()
    expect(lstat).not.toHaveBeenCalled()
    release()
    const [readResult, writeResult] = await Promise.all([reading, writing])
    if (readResult.status === 'rejected') throw readResult.reason
    if (writeResult.status === 'rejected') throw writeResult.reason
    expect(readResult.value.revision).toBe(0)
    expect((await reader.loadOperationRecord(operationId, requestId)).revision).toBe(1)
  } finally {
    release()
    await Promise.all(pending)
  }
})
