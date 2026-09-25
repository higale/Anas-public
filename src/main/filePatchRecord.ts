import { createHash } from 'node:crypto'
import { basename, dirname, isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { maxFilePatchBatchBytes, maxFilePatchOperations } from './filePatch'
import { maxPatchInputBytes } from './fileEditDiff'
import { isSameOrInsideDirectory, samePath } from './pathContainment'
import type { FilePatchTransaction } from './filePatchTransaction'

const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
const path = z.string().min(1).max(32768).refine((value) => isAbsolute(value) && !value.includes('\0'))
const integer = z.number().int().nonnegative().safe()
const decimal = z.string().regex(/^\d+$/)
const hash = z.string().regex(/^[0-9a-f]{64}$/)
const owned = z.object({ path, device: decimal, inode: decimal }).strict()
const target = z.object({
  requestedPath: z.string().min(1).max(32768), lexicalPath: path, canonicalPath: path,
  exists: z.boolean(), finalIsSymbolicLink: z.boolean(),
  operationIndex: integer.max(maxFilePatchOperations - 1), field: z.enum(['path', 'destination']),
  semantics: z.enum(['entry', 'follow']), access: z.literal('write')
}).strict()
const image = z.object({
  target, parent: owned, hash: hash.nullable(),
  identity: z.object({ device: decimal, inode: decimal, size: integer.max(maxPatchInputBytes), mode: integer,
    modifiedNs: z.string().regex(/^-?\d+$/), changedNs: z.string().regex(/^-?\d+$/) }).strict().nullable()
}).strict()
const entryState = z.enum(['pending', 'intent', 'applied', 'restoring', 'restored', 'conflict'])
const transactionState = z.enum(['prepared', 'committing', 'applied', 'restoring', 'restored', 'retained', 'resolved'])
const operationReference = z.object({ requestId: id, operationId: id, definitionHash: hash }).strict()
const artifact = z.object({ path, identity: owned.nullable() }).strict()
const maxTargets = maxFilePatchOperations * 2

// Only this metadata changes during execution. Text blobs and the operation
// definition are immutable and live in the same managed operation directory.
export const filePatchRecordMetadataSchema = z.object({
  tool: z.literal('apply_patch'), operationId: id, requestId: id, createdAt: z.string().datetime(),
  revision: integer, definitionHash: hash,
  transaction: z.object({
    id, state: transactionState,
    reverseAttempt: operationReference.optional(),
    recovery: z.object({ state: z.enum(['pending', 'complete']), inverse: operationReference.nullable() }).strict().optional(),
    sourceFinalized: z.literal(true).optional(),
    entries: z.array(z.object({ state: entryState, after: image.nullable(), compensated: image.optional() }).strict()).max(maxTargets),
    temporary: z.array(artifact).max(maxTargets * 2), directories: z.array(artifact).max(maxTargets * 256),
    errors: z.array(z.string().max(65536)).max(1024)
  }).strict()
}).strict()

export const filePatchDefinitionSchema = z.object({
  restores: z.object({ requestId: id, operationId: id, revision: integer, definitionHash: hash }).strict().optional(),
  entries: z.array(z.object({
  before: image, afterHash: hash.nullable(), afterSize: integer.max(maxPatchInputBytes).nullable(),
  afterMode: integer.nullable()
}).strict()).max(maxTargets) }).strict()

export interface FilePatchEditRecord {
  tool: 'apply_patch'
  operationId: string
  requestId: string
  createdAt: string
  revision: number
  definitionHash: string
  transaction: FilePatchTransaction
}

export function patchTextHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function withoutText<T extends { text: string | null }>(value: T): Omit<T, 'text'> {
  const { text: _text, ...metadata } = value
  return metadata
}

export function encodePatchDefinition(record: FilePatchTransaction): string {
  return JSON.stringify(filePatchDefinitionSchema.parse({ restores: record.restores, entries: record.entries.map((entry) => ({
    before: withoutText(entry.before), afterHash: entry.afterText === null ? null : patchTextHash(entry.afterText),
    afterSize: entry.afterText === null ? null : Buffer.byteLength(entry.afterText), afterMode: entry.afterMode ?? null
  })) }))
}

export function encodePatchMetadata(record: FilePatchEditRecord): string {
  const { restores: _restores, ...transaction } = record.transaction
  return JSON.stringify(filePatchRecordMetadataSchema.parse({ ...record, transaction: {
    ...transaction, entries: record.transaction.entries.map((entry) => ({
      state: entry.state, after: entry.after ? withoutText(entry.after) : null,
      ...(entry.compensated ? { compensated: withoutText(entry.compensated) } : {})
    }))
  } }))
}

export async function decodePatchRecord(
  metadata: unknown, definitionText: string,
  readText: (index: number, side: 'before' | 'after', size: number) => Promise<string>
): Promise<FilePatchEditRecord> {
  const parsed = filePatchRecordMetadataSchema.parse(metadata)
  if (patchTextHash(definitionText) !== parsed.definitionHash) throw new Error('Patch definition hash mismatch.')
  const definition = filePatchDefinitionSchema.parse(JSON.parse(definitionText))
  if (parsed.operationId !== parsed.transaction.id || definition.entries.length !== parsed.transaction.entries.length) {
    throw new Error('Patch operation identity or target count mismatch.')
  }
  let beforeBytes = 0
  let afterBytes = 0
  const entries: FilePatchTransaction['entries'] = []
  for (const [index, entry] of definition.entries.entries()) {
    beforeBytes += entry.before.identity?.size ?? 0
    afterBytes += entry.afterSize ?? 0
    if (beforeBytes > maxFilePatchBatchBytes || afterBytes > maxFilePatchBatchBytes) throw new Error('Patch snapshot batch budget exceeded.')
    const load = async (side: 'before' | 'after', expectedHash: string | null, size: number | null): Promise<string | null> => {
      if ((expectedHash === null) !== (size === null)) throw new Error('Patch text existence mismatch.')
      if (size === null) return null
      const text = await readText(index, side, size)
      if (Buffer.byteLength(text) !== size || patchTextHash(text) !== expectedHash || text.includes('\0')
        || Buffer.from(text).toString('utf8') !== text) throw new Error('Patch text snapshot is invalid or changed.')
      return text
    }
    const beforeText = await load('before', entry.before.hash, entry.before.identity?.size ?? null)
    const afterText = await load('after', entry.afterHash, entry.afterSize)
    const state = parsed.transaction.entries[index]
    entries.push({ before: { ...entry.before, text: beforeText }, afterText, afterMode: entry.afterMode ?? undefined,
      state: state.state, after: state.after ? { ...state.after, text: afterText } : null,
      ...(state.compensated ? { compensated: { ...state.compensated, text: beforeText } } : {}) })
  }
  const result: FilePatchEditRecord = { ...parsed, transaction: { ...parsed.transaction,
    ...(definition.restores ? { restores: definition.restores } : {}), entries } }
  validatePatchTransaction(result.transaction)
  return result
}

export function validatePatchTransaction(record: FilePatchTransaction): void {
  if (record.restores?.operationId === record.id) throw new Error('A patch cannot restore itself.')
  if (record.reverseAttempt && (record.restores || record.reverseAttempt.operationId === record.id
    || !['retained', 'resolved'].includes(record.state))) {
    throw new Error('Invalid patch reverse attempt association.')
  }
  // Round-trip the metadata schemas before considering any filesystem target.
  const definition = encodePatchDefinition(record)
  encodePatchMetadata({ tool: 'apply_patch', operationId: record.id, requestId: record.id,
    createdAt: new Date(0).toISOString(), revision: 0, definitionHash: patchTextHash(definition), transaction: record })
  if (record.recovery && (record.restores || record.recovery.inverse?.operationId === record.id
    || (record.recovery.state === 'pending' && !record.recovery.inverse))) throw new Error('Invalid patch recovery association.')
  if (record.sourceFinalized && (!record.restores || !record.entries.length || record.entries.some((entry) => entry.state !== 'applied'))) {
    throw new Error('Only an applied reverse operation can finalize its source.')
  }
  if (record.state === 'resolved' && record.recovery?.state !== 'complete' && !record.sourceFinalized) {
    throw new Error('Resolved patch lacks completed recovery evidence.')
  }
  if ((record.recovery || record.sourceFinalized) && !['resolved', 'retained'].includes(record.state)) {
    throw new Error('Patch recovery markers require a terminal or retained operation.')
  }
  const paths: string[] = []
  let beforeBytes = 0
  let afterBytes = 0
  for (const entry of record.entries) {
    const checkImage = (value: typeof entry.before): void => {
      if (value.target.exists !== (value.text !== null) || (value.identity === null) !== (value.text === null)
        || value.hash !== (value.text === null ? null : patchTextHash(value.text))
        || (value.identity && value.identity.size !== Buffer.byteLength(value.text!))
        || !isSameOrInsideDirectory(value.parent.path, dirname(value.target.canonicalPath))) {
        throw new Error('Patch snapshot identity is inconsistent.')
      }
    }
    checkImage(entry.before)
    const targetPath = entry.before.target.canonicalPath
    if (paths.some((previous) => isSameOrInsideDirectory(previous, targetPath) || isSameOrInsideDirectory(targetPath, previous))) {
      throw new Error('Patch record targets overlap.')
    }
    paths.push(targetPath)
    beforeBytes += Buffer.byteLength(entry.before.text ?? '')
    afterBytes += Buffer.byteLength(entry.afterText ?? '')
    if (entry.after) {
      checkImage(entry.after)
      const originalTarget = { ...entry.before.target, exists: entry.after.target.exists }
      if (!isDeepStrictEqual(originalTarget, entry.after.target) || entry.after.text !== entry.afterText) {
        throw new Error('Patch postimage does not match its target or intended text.')
      }
    }
    if ((entry.state === 'pending' || entry.state === 'intent') && entry.after) throw new Error('Unapplied patch entry has a postimage.')
    if ((entry.state === 'applied' || entry.state === 'restoring') && !entry.after) throw new Error('Applied patch entry lacks a postimage.')
    if (entry.compensated) {
      checkImage(entry.compensated)
      if (!['restored', 'conflict'].includes(entry.state) || entry.compensated.text !== entry.before.text
        || !isDeepStrictEqual(entry.compensated.target, entry.before.target)) throw new Error('Invalid patch compensation postimage.')
    }
  }
  if (beforeBytes > maxFilePatchBatchBytes || afterBytes > maxFilePatchBatchBytes) throw new Error('Patch snapshot batch budget exceeded.')
  if (record.state === 'prepared' && record.entries.some((entry) => entry.state !== 'pending')) throw new Error('Prepared patch contains effects.')
  if (record.state === 'applied' && record.entries.some((entry) => entry.state !== 'applied')) throw new Error('Applied patch has unfinished entries.')
  if (record.state === 'restored' && record.entries.some((entry) => !['pending', 'restored'].includes(entry.state))) throw new Error('Restored patch has unresolved entries.')
  for (const entry of record.temporary) {
    if (!basename(entry.path).startsWith(`.anas-patch-${record.id}-`) || !entry.path.endsWith('.tmp')
      || !paths.some((targetPath) => samePath(dirname(targetPath), dirname(entry.path)))) throw new Error('Patch temporary path is outside its targets.')
  }
  for (const entry of record.directories) {
    if (!record.entries.some((targetEntry) => isSameOrInsideDirectory(entry.path, dirname(targetEntry.before.target.canonicalPath))
      && isSameOrInsideDirectory(targetEntry.before.parent.path, entry.path)
      && !samePath(targetEntry.before.parent.path, entry.path))) throw new Error('Patch directory is outside its new target parents.')
  }
  for (const entry of [...record.temporary, ...record.directories]) {
    if (entry.identity && !samePath(entry.path, entry.identity.path)) throw new Error('Patch artifact identity path mismatch.')
  }
}

export function validatePatchTransition(previous: FilePatchEditRecord, next: FilePatchEditRecord): void {
  if (!isDeepStrictEqual(previous.transaction.reverseAttempt, next.transaction.reverseAttempt)
    && (previous.transaction.recovery || !next.transaction.reverseAttempt || next.transaction.state !== 'retained'
      || !isDeepStrictEqual(previous.transaction.entries, next.transaction.entries))) {
    throw new Error('Patch reverse attempt cannot change completed recovery or file history.')
  }
  if ((next.transaction.recovery || next.transaction.sourceFinalized)
    && !isDeepStrictEqual(previous.transaction.entries, next.transaction.entries)) {
    throw new Error('Recovery finalization must preserve the original effect history.')
  }
  const beforeRecovery = previous.transaction.recovery, afterRecovery = next.transaction.recovery
  if ((beforeRecovery && (!afterRecovery || !isDeepStrictEqual(beforeRecovery.inverse, afterRecovery.inverse)
    || (beforeRecovery.state === 'complete' && afterRecovery.state !== 'complete')))
    || (previous.transaction.sourceFinalized && !next.transaction.sourceFinalized)) {
    throw new Error('Patch recovery evidence cannot be removed or reassigned.')
  }
  if (encodePatchDefinition(previous.transaction) !== encodePatchDefinition(next.transaction)
    || previous.operationId !== next.operationId || previous.requestId !== next.requestId
    || previous.createdAt !== next.createdAt || next.revision !== previous.revision + 1) {
    throw new Error('Patch immutable definition or revision changed.')
  }
  const transitions: Record<FilePatchTransaction['state'], string[]> = {
    prepared: ['prepared', 'committing', 'restoring', 'retained', 'resolved'], committing: ['committing', 'applied', 'restoring', 'retained', 'resolved'],
    applied: ['applied', 'retained', 'resolved'], restoring: ['restoring', 'restored', 'retained', 'resolved'],
    restored: ['restored', 'retained', 'resolved'], retained: ['retained', 'committing', 'restoring', 'resolved'], resolved: ['resolved', 'retained']
  }
  if (!transitions[previous.transaction.state].includes(next.transaction.state)) throw new Error('Invalid patch transaction state transition.')
  const states: Record<FilePatchTransaction['entries'][number]['state'], string[]> = {
    pending: ['pending', 'intent'], intent: ['intent', 'applied', 'restored', 'conflict'], applied: ['applied', 'restoring', 'restored', 'conflict'],
    restoring: ['restoring', 'restored', 'conflict'], restored: ['restored'], conflict: ['conflict', 'restoring', 'restored']
  }
  for (const [index, before] of previous.transaction.entries.entries()) {
    const after = next.transaction.entries[index]
    if (!states[before.state].includes(after.state) || (before.after && !isDeepStrictEqual(before.after, after.after))
      || (before.compensated && !isDeepStrictEqual(before.compensated, after.compensated))) {
      throw new Error('Invalid patch entry state transition or changed postimage.')
    }
  }
}

export function patchCompensationComplete(transaction: FilePatchTransaction): boolean {
  return ['restored', 'retained'].includes(transaction.state)
    && transaction.entries.every((entry) => ['pending', 'restored'].includes(entry.state))
}

export function patchRecordNeedsRetention(record: FilePatchEditRecord): boolean {
  const transaction = record.transaction
  if ((transaction.reverseAttempt && transaction.recovery?.state !== 'complete') || transaction.recovery?.state === 'pending'
    || (transaction.restores && !transaction.sourceFinalized && !patchCompensationComplete(transaction))) return true
  if (transaction.state === 'prepared') return transaction.temporary.length > 0 || transaction.directories.length > 0
  return !['applied', 'restored', 'resolved'].includes(transaction.state) || transaction.temporary.length > 0
    || (transaction.state !== 'applied' && transaction.directories.length > 0)
}
