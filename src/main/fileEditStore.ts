import { randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import path, { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { getFileEditRecordsDir } from './config/dataDir'
import { withApplicationDataMutation } from './applicationDataSnapshot'
import { decodePatchRecord, encodePatchDefinition, encodePatchMetadata, filePatchRecordMetadataSchema,
  patchCompensationComplete, patchRecordNeedsRetention, patchTextHash, validatePatchTransaction, validatePatchTransition, type FilePatchEditRecord } from './filePatchRecord'
import { cleanupFilePatchArtifacts, executeFilePatchTransaction, resumeFilePatchTransaction, type FilePatchTransaction, type PersistFilePatchTransaction } from './filePatchTransaction'
import type { FilePatchPlan } from './filePatch'
import { verifyFilePatchPreimages, type FilePatchPreimage } from './filePatchState'
import { armCurrentAgentToolEffect, canRestartUnpublishedEffectArtifact, currentAgentToolEffectArtifactId, persistCurrentFileChange } from './agent/toolEffectScope'
import { executeFilePatchRestoreTransaction, filePatchRestoreTargets, planFilePatchRestore, validatePatchRestoreEvidence, type AuthorizeFilePatchRestore, type FilePatchRestorePlan } from './filePatchRestore'

export type FileOperationRecord = FilePatchEditRecord
export interface UnavailableFileEditRecord {
  tool: 'unavailable'
  requestId: string
  operationId: string
  error: string
}
export type RetainedFileEditRecord = FileOperationRecord | UnavailableFileEditRecord
const operationWrites = new Map<string, Promise<void>>()
const patchExecutions = new Map<string, Promise<void>>()

type ManagedPathModule = Pick<typeof path, 'isAbsolute' | 'relative' | 'resolve' | 'sep'>

interface ManagedDirectoryIdentity {
  path: string
  canonicalPath: string
  device: number
  inode: number
}

const internalIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function isFileEditInternalId(value: unknown): value is string {
  return typeof value === 'string' && internalIdPattern.test(value)
}

function requireInternalId(value: unknown, name: string): string {
  if (!isFileEditInternalId(value)) throw new Error(`${name} is invalid`)
  return value
}

export function assertManagedDirectChildPath(
  managedRoot: string,
  targetPath: string,
  expectedId: string,
  pathModule: ManagedPathModule = path
): void {
  const id = requireInternalId(expectedId, 'managed directory id')
  const root = pathModule.resolve(managedRoot)
  const target = pathModule.resolve(targetPath)
  const relativePath = pathModule.relative(root, target)
  if (
    !relativePath
    || pathModule.isAbsolute(relativePath)
    || relativePath === '..'
    || relativePath.startsWith(`..${pathModule.sep}`)
    || relativePath.split(pathModule.sep).length !== 1
    || relativePath !== id
  ) {
    throw new Error(`Managed directory ${id} is not the expected direct child.`)
  }
}

export function managedDirectChildPath(
  managedRoot: string,
  id: string,
  pathModule: ManagedPathModule = path
): string {
  const internalId = requireInternalId(id, 'managed directory id')
  const root = pathModule.resolve(managedRoot)
  const target = pathModule.resolve(root, internalId)
  assertManagedDirectChildPath(root, target, internalId, pathModule)
  return target
}

export function fileEditRecordsRoot(): string {
  return path.resolve(getFileEditRecordsDir())
}

function missingRequestId(requestId: string | undefined, purpose: string): string {
  if (!requestId) throw new Error(`request id is required to ${purpose}`)
  return requireInternalId(requestId, 'request id')
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function editOperationNotFound(operationId: string): Error & { code: 'ENOENT' } {
  return Object.assign(new Error(`edit operation was not found: ${operationId}`), { code: 'ENOENT' as const })
}

class UnpublishedFileEditError extends Error {}

function sameCanonicalPath(left: string, right: string): boolean {
  return path.relative(path.resolve(left), path.resolve(right)) === ''
}

export class FileEditStore {
  readonly root: string

  constructor(root: string = fileEditRecordsRoot()) {
    this.root = path.resolve(root)
  }

  editRecordsDir(requestId: string): string {
    return managedDirectChildPath(this.root, requireInternalId(requestId, 'request id'))
  }

  editRecordDir(requestId: string, operationId: string): string {
    return managedDirectChildPath(
      this.editRecordsDir(requestId),
      requireInternalId(operationId, 'operation_id')
    )
  }

  private async readManagedText(requestId: string, operationId: string, name: string, maxBytes: number): Promise<string> {
    const directory = await this.assertOperationDirectory(requestId, operationId)
    if (!directory) throw editOperationNotFound(operationId)
    const file = join(directory.path, name)
    const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
    try {
      const before = await handle.stat()
      if (!before.isFile() || before.size > maxBytes) throw new Error('Managed edit file is invalid or exceeds its byte budget.')
      const bytes = Buffer.alloc(before.size + 1)
      let length = 0
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, length)
        if (!result.bytesRead) break
        length += result.bytesRead
      }
      const after = await lstat(file)
      if (!after.isFile() || after.isSymbolicLink() || length !== before.size || after.dev !== before.dev
        || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
        throw new Error('Managed edit file changed during reading.')
      }
      await this.assertSameDirectoryIdentity(directory, 'Managed edit read directory')
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length))
    } finally { await handle.close() }
  }

  private async writeManagedText(requestId: string, operationId: string, name: string, text: string, replace = false): Promise<void> {
    const directory = await this.assertOperationDirectory(requestId, operationId)
    if (!directory) throw editOperationNotFound(operationId)
    const final = join(directory.path, name)
    const temporary = replace ? join(directory.path, `.record-${randomUUID()}.tmp`) : final
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally { await handle.close() }
    // Never publish metadata through a replaced operation directory.
    await this.assertSameDirectoryIdentity(directory, 'Managed edit write directory')
    if (replace) await rename(temporary, final)
    if (process.platform !== 'win32') {
      const parent = await open(directory.path, 'r')
      try { await parent.sync() } finally { await parent.close() }
    }
    await this.assertSameDirectoryIdentity(directory, 'Managed edit write directory')
  }

  private async exclusiveOperation<T>(requestId: string, operationId: string, operation: () => Promise<T>,
    queue = operationWrites): Promise<T> {
    return withApplicationDataMutation(async () => {
      const directory = this.editRecordDir(requestId, operationId)
      const key = process.platform === 'win32' ? directory.toLowerCase() : directory
      const previous = queue.get(key) ?? Promise.resolve()
      let release!: () => void
      const current = new Promise<void>((resolve) => { release = resolve })
      queue.set(key, current)
      await previous
      try { return await operation() } finally {
        release()
        if (queue.get(key) === current) queue.delete(key)
      }
    })
  }

  // Creates a writer for a NEW operation only. A replay must first load the
  // existing record; invoking the executor again is never crash recovery.
  createPatchPersistence(requestId: string, operationId = currentAgentToolEffectArtifactId('file_edit') ?? ''): {
    operationId: string; persist: PersistFilePatchTransaction
  } {
    return this.patchPersistence(requestId, operationId)
  }

  private createPatchResumePersistence(record: FilePatchEditRecord): { operationId: string; persist: PersistFilePatchTransaction } {
    return this.patchPersistence(record.requestId, record.operationId, record)
  }

  // Tool dispatch must look up its stable artifact before choosing new execution
  // versus resumption. Absence alone proves nothing: only an unarmed durable
  // effect can authorize discarding unpublished preparation or starting anew.
  async loadPatchForExecution(operationId: string, requestId: string,
    purpose: 'file_edit' | 'file_restore'): Promise<FilePatchEditRecord | undefined> {
    requireInternalId(requestId, 'request id')
    requireInternalId(operationId, 'operation_id')
    return this.exclusiveOperation(requestId, operationId, async () => {
      try {
        const record = await this.loadLockedOperationRecord(operationId, requestId)
        persistCurrentFileChange(record, true)
        return record
      } catch (error) {
        if (!(error instanceof UnpublishedFileEditError) && !isMissing(error)) throw error
        if (!(error instanceof UnpublishedFileEditError) && await this.assertOperationDirectory(requestId, operationId)) throw error
        if (!canRestartUnpublishedEffectArtifact(requestId, operationId, purpose)) {
          throw new Error('Missing patch preparation requires a matching unarmed effect journal; preserve recovery evidence.', { cause: error })
        }
        if (error instanceof UnpublishedFileEditError) {
          await this.deleteManagedDirectChild(this.editRecordsDir(requestId), operationId)
        }
        return undefined
      }
    })
  }

  private patchPersistence(requestId: string, operationId: string, initial?: FilePatchEditRecord): {
    operationId: string; persist: PersistFilePatchTransaction
  } {
    requireInternalId(requestId, 'request id')
    requireInternalId(operationId, 'operation_id')
    let expectedRevision = initial?.revision ?? -1
    return { operationId, persist: async (value) => {
      const snapshot = structuredClone(value)
      validatePatchTransaction(snapshot)
      if (snapshot.id !== operationId) throw new Error('Patch transaction does not match its stable operation identity.')
      await this.exclusiveOperation(requestId, operationId, async () => {
        const previous = await this.loadLockedOperationRecord(operationId, requestId).catch((error) => {
          if (isMissing(error)) return undefined
          throw error
        })
        if (expectedRevision < 0 ? previous !== undefined : !previous || previous.revision !== expectedRevision) {
          throw new Error('Patch operation already exists or its revision changed; load it for recovery instead of executing again.')
        }
        if (initial && (!previous || previous.definitionHash !== initial.definitionHash)) {
          throw new Error('Patch definition changed before resumption.')
        }
        if (!previous && snapshot.state !== 'prepared') throw new Error('A patch must persist preparation before effects.')
        const definition = encodePatchDefinition(snapshot)
        const next: FilePatchEditRecord = { tool: 'apply_patch', operationId, requestId,
          createdAt: previous?.createdAt ?? new Date().toISOString(), revision: expectedRevision + 1,
          definitionHash: patchTextHash(definition), transaction: snapshot }
        if (previous) validatePatchTransition(previous, next)
        const metadata = encodePatchMetadata(next)
        if (Buffer.byteLength(metadata) > 8_000_000 || Buffer.byteLength(definition) > 8_000_000) throw new Error('Patch metadata budget exceeded.')
        if (!previous) {
          // Missing metadata may mean corruption after effects, not merely an
          // interrupted initial save. Never destroy or reuse such evidence.
          if (await this.assertOperationDirectory(requestId, operationId)) {
            throw new Error('Patch operation directory already exists; preserve it for recovery.')
          }
          await this.createOperationDirectory(requestId, operationId)
          for (const [index, entry] of snapshot.entries.entries()) {
            if (entry.before.text !== null) await this.writeManagedText(requestId, operationId, `${index}.before.txt`, entry.before.text)
            if (entry.afterText !== null) await this.writeManagedText(requestId, operationId, `${index}.after.txt`, entry.afterText)
          }
          await this.writeManagedText(requestId, operationId, 'definition.json', definition)
        }
        await this.writeManagedText(requestId, operationId, 'record.json', metadata, true)
        expectedRevision = next.revision
        persistCurrentFileChange(next)
      })
    } }
  }

  // Internal service only. The caller must already have authorized every target
  // before capturing preimages. Model registration remains separate work.
  async executePatch(input: FilePatchPlan, preimages: readonly FilePatchPreimage[], requestId: string,
    options: { operationId?: string; signal?: AbortSignal } = {}): Promise<FilePatchEditRecord> {
    const capturedInput = structuredClone(input), capturedPreimages = structuredClone(preimages), signal = options.signal
    const writer = this.createPatchPersistence(requestId, options.operationId)
    return this.exclusiveOperation(requestId, writer.operationId, async () => {
      let armed = false
      const transaction = await executeFilePatchTransaction(writer.operationId, capturedInput, capturedPreimages, async (record) => {
        await writer.persist(record)
        if (!armed && record.entries.length) {
          armCurrentAgentToolEffect({ kind: 'file_patch', recoveryMode: 'confirm', target: {
            requestId, operationId: writer.operationId,
            paths: record.entries.map((entry) => entry.before.target.canonicalPath)
          } })
          armed = true
        }
      }, signal)
      const record = await this.loadOperationRecord(writer.operationId, requestId)
      return { ...record, transaction }
    }, patchExecutions)
  }

  private async retainLockedPatchOperation(current: FilePatchEditRecord): Promise<FilePatchEditRecord> {
    if (current.transaction.state === 'retained') return current
    return this.saveLockedPatchMetadata(current, { ...current.transaction, state: 'retained' })
  }

  private async saveLockedPatchMetadata(current: FilePatchEditRecord, transaction: FilePatchTransaction): Promise<FilePatchEditRecord> {
    validatePatchTransaction(transaction)
    const next = { ...current, revision: current.revision + 1, transaction: structuredClone(transaction) }
    validatePatchTransition(current, next)
    await this.writeManagedText(current.requestId, current.operationId, 'record.json', encodePatchMetadata(next), true)
    persistCurrentFileChange(next)
    return next
  }

  async previewPatchRestore(operationId: string, requestId: string, authorize: AuthorizeFilePatchRestore,
    signal?: AbortSignal): Promise<FilePatchRestorePlan> {
    const record = await this.loadOperationRecord(operationId, requestId)
    const evidence = await this.loadPatchRestoreEvidence(record)
    const plan = await planFilePatchRestore(record, authorize, signal, evidence)
    const latest = await this.loadOperationRecord(operationId, requestId)
    if (latest.revision !== record.revision || latest.definitionHash !== record.definitionHash) {
      throw new Error('Patch operation changed during restore preview.')
    }
    const latestEvidence = await this.loadPatchRestoreEvidence(latest)
    if (latestEvidence?.revision !== evidence?.revision) throw new Error('Patch restore evidence changed during preview.')
    signal?.throwIfAborted()
    return plan
  }

  private async loadPatchRestoreEvidence(source: FilePatchEditRecord): Promise<FilePatchEditRecord | undefined> {
    if (source.transaction.recovery?.state === 'complete') return undefined
    const reference = source.transaction.reverseAttempt
    if (!reference) return undefined
    const evidence = await this.loadOperationRecord(reference.operationId, reference.requestId)
    validatePatchRestoreEvidence(source, evidence)
    return evidence
  }

  // Internal reverse execution, not restore_file_edit registration or automatic
  // crash replay. Both records remain available until finalizePatchRestore;
  // interrupted execution uses resumePatch rather than creating a new operation.
  async restorePatch(operationId: string, sourceRequestId: string, requestId: string,
    authorize: AuthorizeFilePatchRestore, options: { operationId?: string; signal?: AbortSignal } = {}
  ): Promise<FilePatchEditRecord | null> {
    const signal = options.signal
    const writer = this.createPatchPersistence(requestId, options.operationId ?? currentAgentToolEffectArtifactId('file_restore') ?? '')
    if (writer.operationId === operationId) throw new Error('A patch cannot restore itself.')
    // A known identity must never turn into a fresh attempt or an apparent no-op.
    // In particular, an intent without a postimage cannot be replayed safely.
    if (await this.assertOperationDirectory(requestId, writer.operationId)) {
      throw new Error('Reverse operation already exists; preserve it for recovery instead of executing again.')
    }
    const plan = await this.previewPatchRestore(operationId, sourceRequestId, authorize, signal)
    return this.exclusiveOperation(sourceRequestId, operationId, async () => {
      const loaded = await this.loadOperationRecord(operationId, sourceRequestId)
      let source = loaded
      const evidence = await this.loadPatchRestoreEvidence(source)
      if (evidence && !patchCompensationComplete(evidence.transaction)
        && !(evidence.transaction.entries.every((entry) => entry.state === 'applied')
          && plan.entries.every((entry) => entry.action === 'already_original'))) {
        throw new Error('Previous reverse attempt is unfinished; resume it before starting another restore.')
      }
      if (plan.status !== 'ready' || source.revision !== plan.revision || source.definitionHash !== plan.definitionHash) {
        throw new Error('Patch restore plan is stale or conflicted.')
      }
      if (plan.entries.some((entry) => entry.action !== 'already_original')) {
        source = await this.exclusiveOperation(sourceRequestId, operationId, () => this.retainLockedPatchOperation(source))
        plan.revision = source.revision
      }
      let armed = false
      const transaction = await executeFilePatchRestoreTransaction(writer.operationId, source, plan, async (record) => {
        await writer.persist(record)
        if (!armed) {
          // Publish the inverse before replacing the prior evidence pointer.
          // A crash while writing its definition must not lose the previous
          // compensation facts. This association still precedes all file effects.
          await this.exclusiveOperation(sourceRequestId, operationId, () => this.saveLockedPatchMetadata(source, {
            ...source.transaction, state: 'retained', reverseAttempt: { requestId, operationId: writer.operationId,
              definitionHash: patchTextHash(encodePatchDefinition(record)) }
          }))
          armCurrentAgentToolEffect({ kind: 'file_patch', recoveryMode: 'confirm', target: {
            requestId, operationId: writer.operationId,
            paths: record.entries.map((entry) => entry.before.target.canonicalPath)
          } })
          armed = true
        }
      }, signal, evidence)
      if (!transaction) return null
      const record = await this.loadOperationRecord(writer.operationId, requestId)
      return { ...record, transaction }
    }, patchExecutions)
  }

  // Completes recovery bookkeeping and removes only owned staging/empty parents.
  // File restoration is a separate transaction; this method never rewrites files.
  async finalizePatchRestore(operationId: string, requestId: string, authorize: AuthorizeFilePatchRestore,
    options: { inverse?: { requestId: string; operationId: string }; signal?: AbortSignal } = {}
  ): Promise<FilePatchEditRecord> {
    const requested = options.inverse ? { ...options.inverse } : undefined
    const signal = options.signal
    const initial = await this.loadOperationRecord(operationId, requestId)
    if (initial.transaction.restores) throw new Error('Recovery finalization requires a forward patch.')
    if (requested && initial.transaction.recovery
      && (requested.operationId !== initial.transaction.recovery.inverse?.operationId
        || requested.requestId !== initial.transaction.recovery.inverse.requestId)) {
      throw new Error('Patch recovery is already bound to another inverse.')
    }
    const reference = requested ?? initial.transaction.recovery?.inverse ?? undefined
    if (reference?.operationId === operationId) throw new Error('A patch cannot finalize itself as its inverse.')
    const loadInverse = async (readRecord: FileEditStore['loadOperationRecord']): Promise<FilePatchEditRecord | undefined> => {
      if (!reference) return undefined
      const inverse = await readRecord(reference.operationId, reference.requestId).catch((error) => {
        if (initial.transaction.recovery?.state === 'complete' && isMissing(error)) return undefined
        throw error
      })
      if (!inverse) return undefined // Already finalized and subsequently cleaned.
      if (initial.transaction.reverseAttempt
        && (initial.transaction.reverseAttempt.operationId !== inverse.operationId
          || initial.transaction.reverseAttempt.requestId !== inverse.requestId
          || initial.transaction.reverseAttempt.definitionHash !== inverse.definitionHash)) {
        throw new Error('Inverse operation is unrelated to the latest recorded reverse attempt.')
      }
      const restored = inverse.transaction.restores
      if (restored?.operationId !== operationId || restored.requestId !== requestId
        || restored.definitionHash !== initial.definitionHash || restored.revision > initial.revision
        || !inverse.transaction.entries.length || !['applied', 'retained', 'resolved'].includes(inverse.transaction.state)
        || inverse.transaction.entries.some((entry) => entry.state !== 'applied')) throw new Error('Inverse operation is unrelated or incomplete.')
      for (const entry of inverse.transaction.entries) {
        const source = initial.transaction.entries.find((item) => item.before.target.canonicalPath === entry.before.target.canonicalPath)
        if (!source || source.before.text !== entry.afterText || source.before.identity?.mode !== entry.afterMode) {
          throw new Error('Inverse operation does not restore its source definition.')
        }
      }
      return inverse
    }
    const initialInverse = await loadInverse(this.loadOperationRecord.bind(this))
    const inverseReference = initialInverse ? { requestId: initialInverse.requestId, operationId: initialInverse.operationId,
      definitionHash: initialInverse.definitionHash } : initial.transaction.recovery?.inverse ?? null
    if (initial.transaction.recovery && !isDeepStrictEqual(initial.transaction.recovery.inverse, inverseReference)) {
      throw new Error('Patch recovery is already bound to another inverse.')
    }
    const extraTargets = initialInverse ? filePatchRestoreTargets(initialInverse).filter((target) => target.kind !== 'file') : []
    let plan: FilePatchRestorePlan | undefined
    if (!initial.transaction.recovery) {
      plan = await planFilePatchRestore(initial, (targets) => authorize([...targets, ...extraTargets]), signal)
      if (plan.entries.some((entry) => entry.action !== 'already_original')) throw new Error('Patch files are not fully restored; preserve recovery material.')
    } else {
      // The persisted pending marker already proves file restoration completed.
      // Later user edits do not undo that fact or authorize writing those files.
      await authorize([...filePatchRestoreTargets(initial), ...extraTargets])
    }
    signal?.throwIfAborted()
    return this.exclusiveOperation(requestId, operationId, () => this.exclusiveOperation(requestId, operationId, async () => {
      const finish = async (): Promise<FilePatchEditRecord> => {
        let source = await this.loadLockedOperationRecord(operationId, requestId)
        if (source.revision !== initial.revision || source.definitionHash !== initial.definitionHash) {
          throw new Error('Patch changed during recovery finalization.')
        }
        // finish holds the source and (when present) inverse metadata locks.
        let inverse = await loadInverse(this.loadLockedOperationRecord.bind(this))
        if (inverse?.revision !== initialInverse?.revision || inverse?.definitionHash !== initialInverse?.definitionHash) {
          throw new Error('Inverse changed during recovery finalization.')
        }
        signal?.throwIfAborted()
        if (plan?.entries.length) await verifyFilePatchPreimages(plan.entries.map((entry) => entry.observed), signal)
        const effectRecord = inverse ?? source
        armCurrentAgentToolEffect({ kind: 'file_patch', recoveryMode: 'confirm', target: {
          requestId: effectRecord.requestId, operationId: effectRecord.operationId,
          paths: effectRecord.transaction.entries.map((entry) => entry.before.target.canonicalPath)
        } })
        if (!source.transaction.recovery) source = await this.saveLockedPatchMetadata(source, { ...source.transaction,
          state: inverse ? 'retained' : 'resolved', recovery: { state: inverse ? 'pending' : 'complete', inverse: inverseReference } })
        // Publication order matters: source pending -> inverse acknowledgement ->
        // source complete. Cleanup gates both sides until all markers are durable.
        if (inverse && (!inverse.transaction.sourceFinalized || inverse.transaction.state !== 'resolved')) inverse = await this.saveLockedPatchMetadata(inverse, {
          ...inverse.transaction, state: 'resolved', sourceFinalized: true
        })
        if (source.transaction.recovery!.state === 'pending' || source.transaction.state !== 'resolved') source = await this.saveLockedPatchMetadata(source, {
          ...source.transaction, state: 'resolved', recovery: { state: 'complete', inverse: inverseReference }
        })
        for (const record of [source, ...(inverse ? [inverse] : [])]) {
          const cleaned = structuredClone(record.transaction)
          // This does not delete recorded originals/postimages. Those remain in
          // the managed store until the normal request cleanup is permitted.
          await cleanupFilePatchArtifacts(cleaned)
          if (!isDeepStrictEqual(cleaned, record.transaction)) {
            const saved = await this.saveLockedPatchMetadata(record, cleaned)
            if (record.operationId === operationId) source = saved
          }
        }
        return source
      }
      return reference ? this.exclusiveOperation(reference.requestId, reference.operationId, finish) : finish()
    }), patchExecutions)
  }

  // Host recovery entry: use the original stable identity and whole-group
  // authorization. The LangGraph effect middleware remains responsible for
  // obtaining any required recovery confirmation before invoking this service.
  async resumePatch(operationId: string, requestId: string, authorize: AuthorizeFilePatchRestore,
    signal?: AbortSignal): Promise<FilePatchEditRecord> {
    const initial = await this.loadOperationRecord(operationId, requestId)
    const parent = initial.transaction.restores
    const terminal = initial.transaction.recovery || initial.transaction.sourceFinalized || initial.transaction.reverseAttempt
      || ['applied', 'restored', 'resolved'].includes(initial.transaction.state)
    if (terminal) {
      await authorize(filePatchRestoreTargets(initial))
      const group = parent ?? initial
      return this.exclusiveOperation(group.requestId, group.operationId, async () => {
        signal?.throwIfAborted()
        const current = await this.loadOperationRecord(operationId, requestId)
        if (current.revision !== initial.revision || current.definitionHash !== initial.definitionHash) {
          throw new Error('Patch changed during recovery authorization.')
        }
        // The original effect is history once an inverse owns recovery. Do not
        // recommit it or remove directories needed by that unfinished inverse.
        if (current.transaction.reverseAttempt && !current.transaction.recovery) return current
        if (!current.transaction.temporary.length
          && (current.transaction.state === 'applied' || !current.transaction.directories.length)) return current
        // Known history survives later edits. Only idempotent owned-artifact
        // cleanup may still be outstanding after the applied marker was saved.
        const cleaned = structuredClone(current.transaction)
        armCurrentAgentToolEffect({ kind: 'file_patch', recoveryMode: 'confirm', target: {
          requestId, operationId, paths: current.transaction.entries.map((entry) => entry.before.target.canonicalPath)
        } })
        await cleanupFilePatchArtifacts(cleaned)
        if (isDeepStrictEqual(cleaned, current.transaction)) return current
        return this.exclusiveOperation(requestId, operationId, () => this.saveLockedPatchMetadata(current, cleaned))
      }, patchExecutions)
    }
    const source = parent ? await this.loadOperationRecord(parent.operationId, parent.requestId) : initial
    if (source.transaction.restores
      || (parent && source.definitionHash !== parent.definitionHash)) throw new Error('Patch recovery source is invalid or changed.')
    const extraTargets = parent ? filePatchRestoreTargets(source) : []
    const attempt = source.transaction.reverseAttempt
    const needsAssociation = parent && (attempt?.operationId !== operationId || attempt.requestId !== requestId
      || attempt.definitionHash !== initial.definitionHash)
    if (needsAssociation && (source.revision !== parent.revision || initial.transaction.state !== 'prepared'
      || initial.transaction.temporary.length || initial.transaction.directories.length
      || initial.transaction.entries.some((entry) => entry.state !== 'pending'))) {
      throw new Error('Reverse operation is not the active recovery attempt.')
    }
    let sourcePlan: FilePatchRestorePlan | undefined
    const plan = await planFilePatchRestore(initial, (targets) => authorize([...targets, ...extraTargets]), signal)
    if (plan.status === 'conflict') throw new Error('Patch recovery has unresolved target conflicts; no files were changed.')
    if (parent && !initial.transaction.entries.some((entry) => ['restoring', 'restored', 'conflict'].includes(entry.state))
      && initial.transaction.state !== 'restoring') {
      // The same approved source targets are re-resolved by the preview; this
      // does not extend authorization to any new path or clear a conflict.
      sourcePlan = await planFilePatchRestore(source, async (targets) => {
        if (!isDeepStrictEqual(targets, extraTargets)) throw new Error('Patch source targets changed after authorization.')
      }, signal, needsAssociation ? await this.loadPatchRestoreEvidence(source) : initial)
      if (sourcePlan.status === 'conflict') throw new Error('Patch source has changed; reverse resumption refused.')
    }
    signal?.throwIfAborted()
    return this.exclusiveOperation(source.requestId, source.operationId, async () => {
      const current = await this.loadOperationRecord(operationId, requestId)
      const latestSource = parent ? await this.loadOperationRecord(source.operationId, source.requestId) : current
      if (current.revision !== initial.revision || current.definitionHash !== initial.definitionHash
        || latestSource.revision !== source.revision || latestSource.definitionHash !== source.definitionHash) {
        throw new Error('Patch changed during recovery authorization.')
      }
      signal?.throwIfAborted()
      if (needsAssociation) {
        await this.exclusiveOperation(source.requestId, source.operationId, () => this.saveLockedPatchMetadata(latestSource, {
          ...latestSource.transaction, state: 'retained', reverseAttempt: { requestId, operationId, definitionHash: initial.definitionHash }
        }))
      }
      const writer = this.createPatchResumePersistence(current)
      let armed = false
      const observed = sourcePlan?.entries.map((entry) => entry.observed) ?? plan.entries.map((entry) => entry.observed)
      const transaction = await resumeFilePatchTransaction(current.transaction, observed, async (record) => {
        await writer.persist(record)
        if (!armed) {
          armCurrentAgentToolEffect({ kind: 'file_patch', recoveryMode: 'confirm', target: {
            requestId, operationId, paths: record.entries.map((entry) => entry.before.target.canonicalPath)
          } })
          armed = true
        }
      }, signal)
      const saved = await this.loadOperationRecord(operationId, requestId)
      return { ...saved, transaction }
    }, patchExecutions)
  }

  private async patchFinalizationNeedsRetention(record: FilePatchEditRecord): Promise<boolean> {
    const compensated = !!record.transaction.restores && patchCompensationComplete(record.transaction)
    if (!record.transaction.sourceFinalized && !compensated) return false
    const reference = record.transaction.restores!
    const source = await this.loadOperationRecord(reference.operationId, reference.requestId).catch((error) => {
      if (isMissing(error)) return undefined
      return null // Keep the peer; the ordinary listing reports the corrupt source separately.
    })
    if (source === null) return true
    if (!source) return false // Source cleanup can run before inverse cleanup.
    if (source.definitionHash !== reference.definitionHash
      || source.transaction.recovery?.state !== 'complete') return true
    if (compensated) return false
    return source.transaction.recovery.inverse?.operationId !== record.operationId
      || source.transaction.recovery.inverse.requestId !== record.requestId
      || source.transaction.recovery.inverse.definitionHash !== record.definitionHash
  }

  private async readDirectoryIdentity(
    directoryPath: string,
    name: string
  ): Promise<ManagedDirectoryIdentity | undefined> {
    let before
    try {
      before = await lstat(directoryPath)
    } catch (error) {
      if (isMissing(error)) return undefined
      throw error
    }
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw new Error(`${name} is not a real directory.`)
    }
    const canonicalPath = await realpath(directoryPath)
    const after = await lstat(directoryPath)
    if (
      after.isSymbolicLink()
      || !after.isDirectory()
      || before.dev !== after.dev
      || before.ino !== after.ino
    ) {
      throw new Error(`${name} changed while its identity was being resolved.`)
    }
    return {
      path: directoryPath,
      canonicalPath,
      device: after.dev,
      inode: after.ino
    }
  }

  private async assertSameDirectoryIdentity(
    expected: ManagedDirectoryIdentity,
    name: string
  ): Promise<void> {
    const current = await this.readDirectoryIdentity(expected.path, name)
    if (
      !current
      || !sameCanonicalPath(current.canonicalPath, expected.canonicalPath)
      || current.device !== expected.device
      || current.inode !== expected.inode
    ) {
      throw new Error(`${name} changed during the managed operation.`)
    }
  }

  private async managedRootIdentity(): Promise<ManagedDirectoryIdentity | undefined> {
    return this.readDirectoryIdentity(this.root, 'Managed file edit root')
  }

  private async assertExistingDirectChild(
    managedRoot: string,
    id: string
  ): Promise<ManagedDirectoryIdentity | undefined> {
    const target = managedDirectChildPath(managedRoot, id)
    const managedRootIdentity = await this.readDirectoryIdentity(managedRoot, 'Managed directory root')
    if (!managedRootIdentity) return undefined
    const targetIdentity = await this.readDirectoryIdentity(target, `Managed directory ${id}`)
    if (!targetIdentity) return undefined
    assertManagedDirectChildPath(
      managedRootIdentity.canonicalPath,
      targetIdentity.canonicalPath,
      id
    )
    await this.assertSameDirectoryIdentity(managedRootIdentity, 'Managed directory root')
    return targetIdentity
  }

  private async ensureRequestDirectory(requestId: string): Promise<string> {
    const id = requireInternalId(requestId, 'request id')
    await mkdir(this.root, { recursive: true })
    const rootIdentity = await this.managedRootIdentity()
    if (!rootIdentity) throw new Error('Managed file edit root was not created.')
    const requestDirectory = this.editRecordsDir(id)
    try {
      await mkdir(requestDirectory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const verified = await this.assertExistingDirectChild(this.root, id)
    if (!verified) throw new Error(`Managed request directory ${id} was not created.`)
    await this.assertSameDirectoryIdentity(rootIdentity, 'Managed file edit root')
    return verified.path
  }

  private async createOperationDirectory(requestId: string, operationId: string): Promise<string> {
    const requestDirectory = await this.ensureRequestDirectory(requestId)
    const id = requireInternalId(operationId, 'operation_id')
    const operationDirectory = managedDirectChildPath(requestDirectory, id)
    await mkdir(operationDirectory)
    const verified = await this.assertExistingDirectChild(requestDirectory, id)
    if (!verified) throw new Error(`Managed operation directory ${id} was not created.`)
    return verified.path
  }

  private async assertOperationDirectory(
    requestId: string,
    operationId: string
  ): Promise<ManagedDirectoryIdentity | undefined> {
    const requestDirectory = this.editRecordsDir(requestId)
    const verifiedRequest = await this.assertExistingDirectChild(this.root, requestId)
    if (!verifiedRequest) return undefined
    return this.assertExistingDirectChild(requestDirectory, operationId)
  }

  private async deleteManagedDirectChild(managedRoot: string, id: string): Promise<void> {
    const fileEditRootIdentity = await this.managedRootIdentity()
    if (!fileEditRootIdentity) return
    const parentIdentity = sameCanonicalPath(managedRoot, this.root)
      ? fileEditRootIdentity
      : await this.readDirectoryIdentity(managedRoot, 'Managed deletion parent')
    if (!parentIdentity) return
    const target = managedDirectChildPath(managedRoot, id)
    const targetIdentity = await this.assertExistingDirectChild(managedRoot, id)
    if (!targetIdentity) return

    // Reassert the lexical invariant immediately around the destructive call. The
    // existing-directory check above independently verifies the realpath relation.
    assertManagedDirectChildPath(managedRoot, target, id)
    await this.assertSameDirectoryIdentity(fileEditRootIdentity, 'Managed file edit root')
    if (parentIdentity !== fileEditRootIdentity) {
      await this.assertSameDirectoryIdentity(parentIdentity, 'Managed deletion parent')
    }
    await this.assertSameDirectoryIdentity(targetIdentity, `Managed deletion target ${id}`)
    await rm(target, { recursive: true, force: true })
    assertManagedDirectChildPath(managedRoot, target, id)
    try {
      await lstat(target)
      throw new Error(`Managed deletion target ${id} still exists after removal.`)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    await this.assertSameDirectoryIdentity(fileEditRootIdentity, 'Managed file edit root')
    if (parentIdentity !== fileEditRootIdentity) {
      await this.assertSameDirectoryIdentity(parentIdentity, 'Managed deletion parent')
    }
  }

  async loadOperationRecord(operationId: string, requestId: string | undefined): Promise<FileOperationRecord> {
    const requiredRequestId = missingRequestId(requestId, 'restore a file edit')
    const requiredOperationId = requireInternalId(operationId, 'operation_id')
    // Windows cannot replace record.json while our reader still holds it open.
    // Share the metadata mutation/deletion lock across store instances; keep
    // the identity checks below for changes outside this managed operation.
    return this.exclusiveOperation(requiredRequestId, requiredOperationId,
      () => this.loadLockedOperationRecord(requiredOperationId, requiredRequestId))
  }

  // Caller must already hold this operation's operationWrites lock.
  private async loadLockedOperationRecord(operationId: string, requestId: string | undefined): Promise<FileOperationRecord> {
    const requiredRequestId = missingRequestId(requestId, 'restore a file edit')
    const requiredOperationId = requireInternalId(operationId, 'operation_id')
    try {
      if (!await this.assertOperationDirectory(requiredRequestId, requiredOperationId)) {
        throw editOperationNotFound(requiredOperationId)
      }
      const text = await this.readManagedText(requiredRequestId, requiredOperationId, 'record.json', 8_000_000).catch((error) => {
        if (isMissing(error)) throw new UnpublishedFileEditError(`Missing metadata for edit operation ${requiredOperationId}; preserve its recovery material.`, { cause: error })
        throw new Error(`Cannot read existing edit operation ${requiredOperationId}; preserve its recovery material.`, { cause: error })
      })
      const parsed = JSON.parse(text) as unknown
      if (parsed && typeof parsed === 'object' && 'tool' in parsed && parsed.tool === 'apply_patch') {
        // A missing blob is corruption, NOT a missing operation. Callers must
        // not delete/recreate its directory and lose the remaining evidence.
        try {
          const metadata = filePatchRecordMetadataSchema.parse(parsed)
          if (metadata.requestId !== requiredRequestId || metadata.operationId !== requiredOperationId) throw new Error('Patch record identity mismatch.')
          const definition = await this.readManagedText(requiredRequestId, requiredOperationId, 'definition.json', 8_000_000)
          return await decodePatchRecord(metadata, definition, (index, side, size) =>
            this.readManagedText(requiredRequestId, requiredOperationId, `${index}.${side}.txt`, size))
        } catch (error) { throw new Error(`Cannot load batch edit ${requiredOperationId}: ${String(error)}`, { cause: error }) }
      }
      throw new Error('Stored file operation is not a batch patch record.')
    } catch (error) {
      if (isMissing(error)) throw editOperationNotFound(requiredOperationId)
      throw error
    }
  }

  async listEditRecordsForRequest(requestId: string | undefined, unavailable?: UnavailableFileEditRecord[]): Promise<FileOperationRecord[]> {
    const requiredRequestId = missingRequestId(requestId, 'read file edit diffs')
    const requestDirectory = this.editRecordsDir(requiredRequestId)
    try {
      if (!await this.assertExistingDirectChild(this.root, requiredRequestId)) return []
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }

    const entries = await readdir(requestDirectory, { withFileTypes: true })
    const records: FileOperationRecord[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !isFileEditInternalId(entry.name)) continue
      try {
        records.push(await this.loadOperationRecord(entry.name, requiredRequestId))
      } catch (error) {
        if (isMissing(error)) continue
        if (!unavailable) throw error
        unavailable.push({ tool: 'unavailable', requestId: requiredRequestId, operationId: entry.name,
          error: error instanceof Error ? error.message : String(error) })
      }
    }
    records.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    return records
  }

  async listRetainedEditRecords(): Promise<RetainedFileEditRecord[]> {
    if (!await this.managedRootIdentity()) return []
    const requests = await readdir(this.root, { withFileTypes: true })
    const records: FileOperationRecord[] = []
    const unavailable: UnavailableFileEditRecord[] = []
    for (const request of requests) {
      if (!request.isDirectory() || !isFileEditInternalId(request.name)) {
        throw new Error('Managed file edit root contains an unexpected entry.')
      }
      for (const record of await this.listEditRecordsForRequest(request.name, unavailable)) {
        if (patchRecordNeedsRetention(record) || await this.patchFinalizationNeedsRetention(record)) {
          records.push(record)
        }
      }
    }
    records.sort((left, right) => (
      left.createdAt.localeCompare(right.createdAt)
      || left.requestId.localeCompare(right.requestId)
      || left.operationId.localeCompare(right.operationId)
    ))
    return [...records, ...unavailable.sort((left, right) => left.requestId.localeCompare(right.requestId) || left.operationId.localeCompare(right.operationId))]
  }

  async deleteFileEditRecordsForRequest(
    requestId: string,
    retainedOperationIds: readonly string[] = []
  ): Promise<void> {
    return withApplicationDataMutation(() => this.deleteRequestRecords(requestId, retainedOperationIds))
  }

  private async deleteRequestRecords(requestId: string, retainedOperationIds: readonly string[]): Promise<void> {
    const requiredRequestId = requireInternalId(requestId, 'request id')
    const retained = new Set(retainedOperationIds.map((operationId) => (
      requireInternalId(operationId, 'retained operation id')
    )))
    const retainedFound = new Set<string>()
    const requestDirectory = this.editRecordsDir(requiredRequestId)
    if (!await this.managedRootIdentity()) return
    if (!await this.assertExistingDirectChild(this.root, requiredRequestId)) return
    const entries = await readdir(requestDirectory, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !isFileEditInternalId(entry.name)) {
        throw new Error('Managed file edit request contains an unexpected entry.')
      }
      const record = await this.loadOperationRecord(entry.name, requiredRequestId).catch((error) => {
        if (isMissing(error)) return undefined
        throw error
      })
      if (record) {
        const group = record.transaction.restores ?? record
        await this.exclusiveOperation(group.requestId, group.operationId, () => this.exclusiveOperation(requiredRequestId, entry.name, async () => {
          const current = await this.loadLockedOperationRecord(entry.name, requiredRequestId)
          // Archive confirmed facts and content atomically before removing the
          // only remaining recovery copy. Failure leaves the cleanup outbox.
          persistCurrentFileChange(current, true)
          const waitingForSource = await this.patchFinalizationNeedsRetention(current)
          if (patchRecordNeedsRetention(current) || retained.has(entry.name) || waitingForSource) {
            if (!waitingForSource || retained.has(entry.name)) await this.retainLockedPatchOperation(current)
            retainedFound.add(entry.name)
          } else await this.deleteManagedDirectChild(requestDirectory, entry.name)
        }), patchExecutions)
        continue
      }
    }
    for (const operationId of retained) {
      if (!retainedFound.has(operationId)) {
        throw new Error(`Retained file edit ${operationId} was not found.`)
      }
    }
    if ((await readdir(requestDirectory)).length === 0) {
      await this.deleteManagedDirectChild(this.root, requiredRequestId)
    }
  }
}

// Resolve the configured profile at the operation boundary. Each instance keeps
// its root fixed while asynchronous work continues or another profile is selected.
export function getDefaultFileEditStore(): FileEditStore {
  return new FileEditStore()
}

export async function loadOperationRecord(operationId: string, requestId: string | undefined): Promise<FileOperationRecord> {
  return getDefaultFileEditStore().loadOperationRecord(operationId, requestId)
}

export function editRecordsDir(requestId: string): string {
  return getDefaultFileEditStore().editRecordsDir(requestId)
}

export function editRecordDir(requestId: string, operationId: string): string {
  return getDefaultFileEditStore().editRecordDir(requestId, operationId)
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await stat(targetPath)
    return true
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

export async function listEditRecordsForRequest(requestId: string | undefined): Promise<FileOperationRecord[]> {
  return getDefaultFileEditStore().listEditRecordsForRequest(requestId)
}

export async function listRetainedEditRecords(): Promise<RetainedFileEditRecord[]> {
  return getDefaultFileEditStore().listRetainedEditRecords()
}

export async function deleteFileEditRecordsForRequest(
  requestId: string,
  retainedOperationIds: readonly string[] = []
): Promise<void> {
  return getDefaultFileEditStore().deleteFileEditRecordsForRequest(requestId, retainedOperationIds)
}
