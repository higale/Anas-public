import { lstat, opendir } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { samePath } from './pathContainment'
import { canonicalizeAbsolutePath } from './workspacePath'
import { validatePatchTransaction, type FilePatchEditRecord } from './filePatchRecord'
import { captureFilePatchPreimages, verifyFilePatchPreimages, type FilePatchPreimage } from './filePatchState'
import type { FilePatchTarget } from './filePatch'
import { executePreparedFilePatchTransaction, type FilePatchTransaction, type PersistFilePatchTransaction } from './filePatchTransaction'

export interface FilePatchRestoreTarget {
  path: string
  kind: 'file' | 'temporary' | 'directory'
  index: number
  semantics: 'entry'
  access: 'read' | 'write'
}

export interface FilePatchRestorePlan {
  requestId: string
  operationId: string
  revision: number
  definitionHash: string
  evidence?: { requestId: string; operationId: string; revision: number; definitionHash: string }
  status: 'ready' | 'conflict'
  entries: Array<{
    index: number
    path: string
    action: 'restore_text' | 'remove_created' | 'already_original' | 'conflict'
    observed: FilePatchPreimage
    reason?: string
  }>
  cleanup: Array<{
    path: string
    kind: 'temporary' | 'directory'
    action: 'remove' | 'missing' | 'keep'
    reason?: string
  }>
}

// A required host callback, not a model-supplied approval flag. It must finish
// project rules and authorization for the WHOLE list before resolving.
export type AuthorizeFilePatchRestore = (targets: readonly FilePatchRestoreTarget[]) => Promise<void>

export function filePatchRestoreTargets(record: FilePatchEditRecord): FilePatchRestoreTarget[] {
  validatePatchTransaction(record.transaction)
  return [
    ...record.transaction.entries.map((entry, index) => ({ path: entry.before.target.canonicalPath, kind: 'file' as const, index })),
    ...record.transaction.temporary.map((entry, index) => ({ path: entry.path, kind: 'temporary' as const, index })),
    ...record.transaction.directories.map((entry, index) => ({ path: entry.path, kind: 'directory' as const, index }))
  ].map((target) => ({ ...target, semantics: 'entry', access: 'write' }))
}

async function resolveTargets(record: FilePatchEditRecord, signal?: AbortSignal): Promise<FilePatchTarget[]> {
  const targets: FilePatchTarget[] = []
  for (const entry of record.transaction.entries) {
    signal?.throwIfAborted()
    const original = entry.before.target
    const current = await canonicalizeAbsolutePath(original.lexicalPath, original.semantics)
    if (!samePath(current.canonicalPath, original.canonicalPath) || current.finalIsSymbolicLink !== original.finalIsSymbolicLink) {
      throw new Error(`Patch restore target changed: ${original.lexicalPath}`)
    }
    targets.push({ ...original, ...current })
  }
  for (const artifact of [...record.transaction.temporary, ...record.transaction.directories]) {
    signal?.throwIfAborted()
    const current = await canonicalizeAbsolutePath(artifact.path, 'entry')
    if (!samePath(current.canonicalPath, artifact.path) || current.finalIsSymbolicLink) {
      throw new Error(`Patch restore cleanup target changed: ${artifact.path}`)
    }
  }
  signal?.throwIfAborted()
  return targets
}

function matchesImage(current: FilePatchPreimage, expected: FilePatchPreimage): boolean {
  return current.text === expected.text && current.hash === expected.hash
    && isDeepStrictEqual(current.identity, expected.identity) && isDeepStrictEqual(current.parent, expected.parent)
}

function restoreAction(entry: FilePatchTransaction['entries'][number], current: FilePatchPreimage,
  evidence?: FilePatchEditRecord): FilePatchRestorePlan['entries'][number]['action'] {
  if (current.text === entry.before.text && current.hash === entry.before.hash
    && (current.identity?.mode ?? null) === (entry.before.identity?.mode ?? null)) return 'already_original'
  const related = evidence?.transaction.entries.find((item) => samePath(item.before.target.canonicalPath, entry.before.target.canonicalPath))
  const images = [entry.after, related?.compensated ?? related?.before].filter((value): value is FilePatchPreimage => !!value)
  if (entry.state !== 'restored' && images.some((image) => matchesImage(current, image))) {
    return entry.before.text === null ? 'remove_created' : 'restore_text'
  }
  return 'conflict'
}

export function validatePatchRestoreEvidence(source: FilePatchEditRecord, evidence: FilePatchEditRecord): void {
  validatePatchTransaction(evidence.transaction)
  const reference = source.transaction.reverseAttempt, origin = evidence.transaction.restores
  if (!reference || reference.operationId !== evidence.operationId || reference.requestId !== evidence.requestId
    || reference.definitionHash !== evidence.definitionHash || !origin || origin.operationId !== source.operationId
    || origin.requestId !== source.requestId || origin.definitionHash !== source.definitionHash || origin.revision > source.revision) {
    throw new Error('Patch restore evidence is unrelated or stale.')
  }
  for (const entry of evidence.transaction.entries) {
    const original = source.transaction.entries.find((item) => samePath(item.before.target.canonicalPath, entry.before.target.canonicalPath))
    if (!original || entry.before.text !== original.afterText || entry.afterText !== original.before.text
      || entry.afterMode !== original.before.identity?.mode) throw new Error('Patch restore evidence does not reverse its source.')
  }
}

function evidenceReference(evidence?: FilePatchEditRecord): FilePatchRestorePlan['evidence'] {
  return evidence && { requestId: evidence.requestId, operationId: evidence.operationId,
    revision: evidence.revision, definitionHash: evidence.definitionHash }
}

async function planCleanup(record: FilePatchEditRecord, signal?: AbortSignal): Promise<FilePatchRestorePlan['cleanup']> {
  const result: FilePatchRestorePlan['cleanup'] = []
  for (const kind of ['temporary', 'directory'] as const) {
    const artifacts = kind === 'temporary' ? record.transaction.temporary : record.transaction.directories
    for (const artifact of artifacts) {
      signal?.throwIfAborted()
      const base = { path: artifact.path, kind }
      try {
        const info = await lstat(artifact.path, { bigint: true })
        if (!artifact.identity || String(info.dev) !== artifact.identity.device || String(info.ino) !== artifact.identity.inode
          || info.isSymbolicLink() || (kind === 'directory' ? !info.isDirectory() : !info.isFile())) {
          result.push({ ...base, action: 'keep', reason: 'Cleanup ownership is unconfirmed or changed.' })
          continue
        }
        if (kind === 'directory') {
          const directory = await opendir(artifact.path)
          let occupied: boolean
          try { occupied = await directory.read() !== null } finally { await directory.close() }
          const after = await lstat(artifact.path, { bigint: true })
          if (!after.isDirectory() || after.isSymbolicLink() || after.dev !== info.dev || after.ino !== info.ino) {
            throw new Error('Patch restore cleanup directory changed during inspection.')
          }
          if (occupied) {
            result.push({ ...base, action: 'keep', reason: 'Directory is not empty; recheck after file restoration, never remove recursively.' })
            continue
          }
        }
        result.push({ ...base, action: 'remove' })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        result.push({ ...base, action: 'missing' })
      }
    }
  }
  signal?.throwIfAborted()
  return result
}

// Read-only preflight. This does not change records, restore files, or clean up
// artifacts. The executor must revalidate its revision and observations
// at the write boundary and durably record the reverse operation separately.
export async function planFilePatchRestore(
  source: FilePatchEditRecord, authorize: AuthorizeFilePatchRestore, signal?: AbortSignal, recoveryEvidence?: FilePatchEditRecord
): Promise<FilePatchRestorePlan> {
  const record = structuredClone(source)
  const evidence = recoveryEvidence && structuredClone(recoveryEvidence)
  if (evidence) validatePatchRestoreEvidence(record, evidence)
  const authorizationTargets = filePatchRestoreTargets(record)
  const resolved = await resolveTargets(record, signal)
  await authorize(structuredClone(authorizationTargets))
  const checked = await resolveTargets(record, signal)
  if (!isDeepStrictEqual(resolved, checked)) throw new Error('Patch restore targets changed during authorization.')
  const observed = checked.length ? await captureFilePatchPreimages(checked, signal) : []
  const entries: FilePatchRestorePlan['entries'] = record.transaction.entries.map((entry, index) => {
    const current = observed[index]
    const base = { index, path: entry.before.target.canonicalPath, observed: current }
    // Matching original content permits a NO-OP only, never ownership claims or
    // deletion. In particular, an external same-content replacement stays intact.
    const action = restoreAction(entry, current, evidence)
    if (action !== 'conflict') return { ...base, action }
    return { ...base, action: 'conflict', reason: entry.after
      ? 'Current file no longer matches the confirmed postimage.'
      : 'No confirmed postimage; intended content does not prove this operation owns the current file.' }
  })
  const cleanup = await planCleanup(record, signal)
  const conflict = entries.some((entry) => entry.action === 'conflict')
  if (conflict) for (const artifact of cleanup) {
    if (artifact.action === 'remove') { artifact.action = 'keep'; artifact.reason = 'Batch has unresolved files; retain recovery material.' }
  }
  if (observed.length) await verifyFilePatchPreimages(observed, signal)
  await resolveTargets(record, signal)
  return { requestId: record.requestId, operationId: record.operationId, revision: record.revision,
    definitionHash: record.definitionHash, ...(evidence ? { evidence: evidenceReference(evidence) } : {}),
    status: conflict ? 'conflict' : 'ready', entries, cleanup }
}

// Internal only. The host must retain the source and bind its revision for the
// duration of execution. This consumes a fresh authorized preview, never an
// unchecked list of replacement texts or a model-provided force flag.
export async function executeFilePatchRestoreTransaction(
  operationId: string, source: FilePatchEditRecord, preview: FilePatchRestorePlan,
  persist: PersistFilePatchTransaction, signal?: AbortSignal, recoveryEvidence?: FilePatchEditRecord
): Promise<FilePatchTransaction | null> {
  const record = structuredClone(source), plan = structuredClone(preview)
  const evidence = recoveryEvidence && structuredClone(recoveryEvidence)
  if (evidence) validatePatchRestoreEvidence(record, evidence)
  validatePatchTransaction(record.transaction)
  if (record.transaction.restores) throw new Error('Restoring a reverse operation is not supported.')
  if (plan.status !== 'ready' || plan.requestId !== record.requestId || plan.operationId !== record.operationId
    || plan.revision !== record.revision || plan.definitionHash !== record.definitionHash
    || !isDeepStrictEqual(plan.evidence, evidenceReference(evidence))
    || plan.entries.length !== record.transaction.entries.length) throw new Error('Patch restore plan is stale or conflicted.')
  const before = plan.entries.map((item, index) => {
    const entry = record.transaction.entries[index]
    if (item.index !== index || item.path !== entry.before.target.canonicalPath
      || !isDeepStrictEqual({ ...entry.before.target, exists: item.observed.target.exists }, item.observed.target)
      || item.action === 'conflict' || item.action !== restoreAction(entry, item.observed, evidence)) {
      throw new Error('Patch restore observation does not match its source.')
    }
    return item.observed
  })
  const transaction: FilePatchTransaction = {
    id: operationId, restores: { requestId: record.requestId, operationId: record.operationId,
      revision: record.revision, definitionHash: record.definitionHash },
    state: 'prepared', temporary: [], directories: [], errors: [],
    entries: plan.entries.flatMap((item, index) => item.action === 'already_original' ? [] : [{
      before: before[index], afterText: record.transaction.entries[index].before.text,
      afterMode: record.transaction.entries[index].before.identity?.mode, after: null, state: 'pending' as const
    }])
  }
  validatePatchTransaction(transaction)
  if (!transaction.entries.length) {
    if (before.length) await verifyFilePatchPreimages(before, signal)
    signal?.throwIfAborted()
    return null
  }
  return executePreparedFilePatchTransaction(transaction, before, persist, signal)
}
