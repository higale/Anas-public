import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, realpath, rename, rmdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { filePatchOperationSemantics, planFilePatch, type FilePatchPlan } from './filePatch'
import { captureFilePatchPreimages, verifyFilePatchPreimages, type FilePatchPreimage } from './filePatchState'
import { samePath } from './pathContainment'
import { validatePatchTransaction } from './filePatchRecord'

interface OwnedEntry {
  path: string
  device: string
  inode: string
}

interface StagedText extends OwnedEntry {
  snapshot: FilePatchPreimage
}

export interface FilePatchTransactionEntry {
  before: FilePatchPreimage
  afterText: string | null
  afterMode: number | undefined
  after: FilePatchPreimage | null
  compensated?: FilePatchPreimage
  state: 'pending' | 'intent' | 'applied' | 'restoring' | 'restored' | 'conflict'
}

export interface FilePatchTransaction {
  id: string
  restores?: { requestId: string; operationId: string; revision: number; definitionHash: string }
  reverseAttempt?: { requestId: string; operationId: string; definitionHash: string }
  recovery?: { state: 'pending' | 'complete'; inverse: { requestId: string; operationId: string; definitionHash: string } | null }
  sourceFinalized?: true
  state: 'prepared' | 'committing' | 'applied' | 'restoring' | 'restored' | 'retained' | 'resolved'
  entries: FilePatchTransactionEntry[]
  // Intent paths precede creation; an absent identity is deliberately not proof
  // of ownership. Recovery must not remove an object using its name alone.
  temporary: Array<{ path: string; identity: OwnedEntry | null }>
  directories: Array<{ path: string; identity: OwnedEntry | null }>
  errors: string[]
}

// The application editing store must durably save each supplied snapshot before
// resolving. There is deliberately no default/no-op writer or separate store.
export type PersistFilePatchTransaction = (record: Readonly<FilePatchTransaction>) => Promise<void>

export class FilePatchTransactionError extends Error {
  constructor(readonly record: FilePatchTransaction, cause: unknown) {
    super(`Patch transaction ${record.id} ${record.state}: ${errorText(cause)}`, { cause })
    this.name = 'FilePatchTransactionError'
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function ownedEntry(path: string, directory: boolean): Promise<OwnedEntry> {
  const info = await lstat(path, { bigint: true })
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) {
    throw new Error(`Patch staging object changed: ${path}`)
  }
  return { path, device: String(info.dev), inode: String(info.ino) }
}

async function verifyOwned(expected: OwnedEntry, directory: boolean): Promise<void> {
  // Check the parent too: cleanup must not follow a newly substituted junction.
  if (!samePath(await realpath(dirname(expected.path)), dirname(expected.path))) {
    throw new Error(`Patch staging parent changed: ${expected.path}`)
  }
  const current = await ownedEntry(expected.path, directory)
  if (current.device !== expected.device || current.inode !== expected.inode) {
    throw new Error(`Patch staging object changed: ${expected.path}`)
  }
}

export async function cleanupFilePatchArtifacts(record: FilePatchTransaction, preserveDirectories = record.state === 'applied'): Promise<void> {
  for (const entry of [...record.temporary].reverse()) {
    if (!entry.identity) continue
    try {
      await verifyOwned(entry.identity, false)
      await unlink(entry.path)
    } catch (error) {
      if (!missing(error)) { record.errors.push(errorText(error)); continue }
    }
    record.temporary.splice(record.temporary.indexOf(entry), 1)
  }
  // Never recursively remove a directory, even one created by this transaction.
  // Successful creates need their parents; failed batches remove only empty ones.
  if (preserveDirectories) return
  for (const entry of [...record.directories].reverse()) {
    if (!entry.identity) continue
    try {
      await verifyOwned(entry.identity, true)
      await rmdir(entry.path)
    } catch (error) {
      if (!missing(error)) { record.errors.push(errorText(error)); continue }
    }
    record.directories.splice(record.directories.indexOf(entry), 1)
  }
}

async function ensureParents(
  target: string, record: FilePatchTransaction, save: () => Promise<void>, signal?: AbortSignal
): Promise<void> {
  const absent: string[] = []
  let parent = dirname(target)
  for (let depth = 0; ; depth++) {
    signal?.throwIfAborted()
    if (depth >= 256) throw new Error('Patch parent depth exceeds the limit.')
    try {
      await ownedEntry(parent, true)
      if (!samePath(await realpath(parent), parent)) throw new Error(`Patch parent changed: ${parent}`)
      break
    } catch (error) {
      if (!missing(error)) throw error
      absent.push(parent)
      parent = dirname(parent)
    }
  }
  for (const path of absent.reverse()) {
    signal?.throwIfAborted()
    const parentIdentity = await ownedEntry(dirname(path), true)
    const entry = { path, identity: null as OwnedEntry | null }
    record.directories.push(entry)
    await save()
    await verifyOwned(parentIdentity, true)
    signal?.throwIfAborted()
    // EEXIST is a conflict, not permission to adopt another writer's directory.
    await mkdir(path)
    entry.identity = await ownedEntry(path, true)
    await save()
  }
}

async function stageText(
  target: string, text: string, mode: number | undefined,
  record: FilePatchTransaction, save: () => Promise<void>
): Promise<StagedText> {
  const path = join(dirname(target), `.anas-patch-${record.id}-${randomUUID()}.tmp`)
  const parentIdentity = await ownedEntry(dirname(path), true)
  const entry = { path, identity: null as OwnedEntry | null }
  record.temporary.push(entry)
  await save()
  await verifyOwned(parentIdentity, true)
  const handle = await open(path, 'wx', mode === undefined ? 0o666 : mode & 0o777)
  try {
    const info = await handle.stat({ bigint: true })
    entry.identity = { path, device: String(info.dev), inode: String(info.ino) }
    await handle.writeFile(text, 'utf8')
    if (mode !== undefined) await handle.chmod(mode & 0o777)
    await handle.sync()
  } finally {
    await handle.close()
  }
  const [snapshot] = await captureFilePatchPreimages([{
    requestedPath: path, lexicalPath: path, canonicalPath: path, exists: true,
    finalIsSymbolicLink: false, semantics: 'entry', operationIndex: 0, field: 'path', access: 'write'
  }])
  if (snapshot.text !== text || snapshot.identity?.device !== entry.identity!.device
    || snapshot.identity.inode !== entry.identity!.inode) throw new Error(`Patch staging content changed: ${path}`)
  await save()
  return { ...entry.identity!, snapshot }
}

async function snapshotResult(entry: FilePatchTransactionEntry, exists: boolean): Promise<FilePatchPreimage> {
  const [snapshot] = await captureFilePatchPreimages([{ ...entry.before.target, exists }])
  return snapshot
}

async function installText(staged: StagedText, expected: FilePatchPreimage, signal?: AbortSignal): Promise<void> {
  await verifyFilePatchPreimages([staged.snapshot], signal)
  // Stage verification may read up to 1 MB. Recheck the destination afterwards,
  // immediately before installing; do not overwrite edits made during that read.
  await verifyFilePatchPreimages([expected], signal)
  const target = expected.target.canonicalPath
  if (expected.text !== null) await rename(staged.path, target)
  else {
    // Atomic no-replace creation on the same filesystem. Never overwrite a file
    // that appeared after preflight. Unsupported filesystems fail explicitly.
    await link(staged.path, target)
    await unlink(staged.path)
  }
}

async function rollback(
  record: FilePatchTransaction, save: () => Promise<void>, observed?: readonly FilePatchPreimage[]
): Promise<void> {
  record.state = 'restoring'
  await save()
  for (const entry of [...record.entries].reverse()) {
    if (entry.state === 'pending' || entry.state === 'restored') continue
    try {
      const current = observed?.find((image) => image.target.canonicalPath === entry.before.target.canonicalPath)
      if (current && current.text === entry.before.text && current.hash === entry.before.hash
        && current.identity?.mode === entry.before.identity?.mode) {
        await verifyFilePatchPreimages([current])
        // A matching original permits a no-op, not adoption of an external
        // replacement. Only preserve ownership when its exact identity survived.
        if (isDeepStrictEqual(current.identity, entry.before.identity) && isDeepStrictEqual(current.parent, entry.before.parent)) {
          entry.compensated ??= structuredClone(current)
        }
        entry.state = 'restored'
        await save()
        continue
      }
      if (!entry.after) {
        // A syscall or its following inspection failed. Only declare no effect
        // when the exact original identity remains; never infer ownership from
        // intended text alone (an external writer may have written that text).
        await verifyFilePatchPreimages([entry.before])
        entry.compensated = structuredClone(entry.before)
      } else {
        await verifyFilePatchPreimages([entry.after])
        entry.state = 'restoring'
        await save()
        const path = entry.before.target.canonicalPath
        if (entry.before.text === null) {
          await verifyFilePatchPreimages([entry.after])
          await unlink(path)
        } else {
          const staged = await stageText(path, entry.before.text, entry.before.identity?.mode, record, save)
          await installText(staged, entry.after)
        }
        const restored = await snapshotResult(entry, entry.before.text !== null)
        if (restored.text !== entry.before.text) throw new Error(`Patch restoration changed: ${path}`)
        entry.compensated = restored
      }
      entry.state = 'restored'
      await save()
    } catch (error) {
      entry.state = 'conflict'
      record.errors.push(errorText(error))
      // Persist each uncertain result. If persistence itself fails, stop further
      // writes; the prior durable intent and preimages remain recovery evidence.
      await save()
    }
  }
  record.state = record.entries.some((entry) => entry.state === 'conflict') ? 'retained' : 'restored'
  await save()
}

// Internal transaction executor, not a model tool. Rules/authorization must cover
// the entire resolved input before preimages are captured. Durable resumption
// goes through the editing store; this entry always builds a new transaction.
export async function executeFilePatchTransaction(
  operationId: string,
  input: FilePatchPlan,
  preimages: readonly FilePatchPreimage[],
  persist: PersistFilePatchTransaction,
  signal?: AbortSignal
): Promise<FilePatchTransaction> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(operationId)) {
    throw new Error('Patch operation identity is invalid.')
  }
  if (input.dry_run) throw new Error('Dry-run patches must use planning without executing a transaction.')
  // Own the inputs across awaits so caller changes cannot change authorized paths.
  const before = structuredClone(preimages)
  const changes = planFilePatch(input, new Map(before.map((entry) => [entry.target.canonicalPath, entry.text])))
  if (changes.length !== before.length || changes.some((change, index) => {
    const operation = input.operations[change.operationIndex]
    const expectedField = operation.type === 'move' && change.path === operation.destination ? 'destination' : 'path'
    const expectedSemantics = filePatchOperationSemantics(operation)
    return change.path !== before[index].target.canonicalPath || change.operationIndex !== before[index].target.operationIndex
      || before[index].target.field !== expectedField || before[index].target.semantics !== expectedSemantics
  })) throw new Error('Patch transaction targets do not match captured preimages.')
  const record: FilePatchTransaction = {
    id: operationId, state: 'prepared', temporary: [], directories: [], errors: [],
    entries: changes.filter((change) => change.beforeText !== change.afterText).map((change) => ({
      before: before.find((entry) => entry.target.canonicalPath === change.path)!,
      afterText: change.afterText,
      afterMode: before.find((entry) => (
        entry.target.operationIndex === change.operationIndex && entry.target.field === 'path'
      ))?.identity?.mode,
      after: null, state: 'pending'
    }))
  }
  return executePreparedFilePatchTransaction(record, before, persist, signal)
}

// Shared commit/compensation engine for forward patches and independently
// recorded reverse operations. Callers build and validate the immutable plan.
export async function executePreparedFilePatchTransaction(
  prepared: FilePatchTransaction, preimages: readonly FilePatchPreimage[],
  persist: PersistFilePatchTransaction, signal?: AbortSignal
): Promise<FilePatchTransaction> {
  const record = structuredClone(prepared), before = structuredClone(preimages)
  const save = () => persist(structuredClone(record))
  if (before.length) await verifyFilePatchPreimages(before, signal)
  // A failed initial write has no filesystem side effects to undo.
  await save()
  try {
    if (record.temporary.length) {
      await cleanupFilePatchArtifacts(record, true)
      await save()
    }
    const stages = new Map<FilePatchTransactionEntry, StagedText>()
    for (const entry of record.entries) {
      signal?.throwIfAborted()
      if (entry.state === 'applied' || entry.afterText === null) continue
      const path = entry.before.target.canonicalPath
      await verifyFilePatchPreimages([entry.before], signal)
      await ensureParents(path, record, save, signal)
      stages.set(entry, await stageText(path, entry.afterText, entry.afterMode, record, save))
    }
    if (before.length) await verifyFilePatchPreimages(before, signal)
    record.state = 'committing'
    await save()
    for (const entry of record.entries) {
      signal?.throwIfAborted()
      if (entry.state === 'applied') continue
      entry.state = 'intent'
      await save()
      const path = entry.before.target.canonicalPath
      if (entry.afterText === null) {
        await verifyFilePatchPreimages([entry.before], signal)
        await unlink(path)
      } else await installText(stages.get(entry)!, entry.before, signal)
      // Do not abort between a filesystem effect and recording its true outcome.
      const after = await snapshotResult(entry, entry.afterText !== null)
      if (after.text !== entry.afterText) throw new Error(`Patch result changed: ${path}`)
      const staged = stages.get(entry)
      if (staged && (after.identity?.device !== staged.device || after.identity.inode !== staged.inode)) {
        throw new Error(`Patch result identity changed: ${path}`)
      }
      entry.after = after
      entry.state = 'applied'
      await save()
    }
    signal?.throwIfAborted()
    // Include unchanged targets: a batch must not report success if a no-op
    // member changed while another member was being committed.
    const finalImages = before.map((image) => record.entries.find((entry) =>
      entry.before.target.canonicalPath === image.target.canonicalPath)?.after ?? image)
    if (finalImages.length) await verifyFilePatchPreimages(finalImages, signal)
    record.state = 'applied'
    await save()
  } catch (error) {
    record.errors.push(errorText(error))
    try {
      // Rollback must finish or report conflicts even when the caller cancelled.
      await rollback(record, save)
    } catch (rollbackError) {
      record.state = 'retained'
      record.errors.push(errorText(rollbackError))
    }
    await cleanupFilePatchArtifacts(record)
    try { await save() } catch (saveError) {
      record.state = 'retained'
      record.errors.push(errorText(saveError))
    }
    throw new FilePatchTransactionError(structuredClone(record), error)
  }
  // Once applied is durable, cleanup failure must not pretend the edit failed or
  // roll it back. The returned errors and recorded artifacts require attention.
  await cleanupFilePatchArtifacts(record)
  try { await save() } catch (error) { record.errors.push(errorText(error)) }
  return structuredClone(record)
}

// Resume a validated, authorized durable transaction without replacing its ID
// or definition. A supplied observation is a fresh preflight, not an approval.
export async function resumeFilePatchTransaction(
  source: FilePatchTransaction, observations: readonly FilePatchPreimage[],
  persist: PersistFilePatchTransaction, signal?: AbortSignal
): Promise<FilePatchTransaction> {
  const record = structuredClone(source), observed = structuredClone(observations)
  validatePatchTransaction(record)
  if (record.recovery || record.sourceFinalized || record.reverseAttempt || ['applied', 'restored', 'resolved'].includes(record.state)) return record
  if (record.entries.some((entry) => !observed.some((image) => image.target.canonicalPath === entry.before.target.canonicalPath))) {
    throw new Error('Patch recovery is missing target observations.')
  }
  if (observed.length) await verifyFilePatchPreimages(observed, signal)
  const compensating = record.state === 'restoring' || record.entries.some((entry) => ['restoring', 'restored', 'conflict'].includes(entry.state))
  if (!compensating) {
    const expected = record.entries.map((entry) => entry.after ?? entry.before)
    if (expected.length) await verifyFilePatchPreimages(expected, signal)
    return executePreparedFilePatchTransaction(record, observed, persist, signal)
  }
  const save = () => persist(structuredClone(record))
  signal?.throwIfAborted()
  try {
    await rollback(record, save, observed)
  } catch (error) {
    record.state = 'retained'
    record.errors.push(errorText(error))
    try { await save() } catch (saveError) { record.errors.push(errorText(saveError)) }
    throw new FilePatchTransactionError(record, error)
  }
  await cleanupFilePatchArtifacts(record)
  await save()
  return structuredClone(record)
}
