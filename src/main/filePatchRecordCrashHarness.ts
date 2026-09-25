// Isolated hard-exit fixture, loaded only by toolEffectHardCrashFixture.mjs.
import { FileEditStore } from './fileEditStore'
import { resolveFilePatchTargets } from './filePatch'
import { asPatchInput } from './filePatchTestFixtures'
import { captureFilePatchPreimages } from './filePatchState'
import { executeFilePatchTransaction, type FilePatchTransaction } from './filePatchTransaction'

export async function runFilePatchRecordCrashHarness(options: {
  workspace: string; recordsRoot: string; requestId: string; operationId: string;
  phase: 'prepared' | 'staged' | 'intent' | 'partial' | 'applied' | 'source-verified' | 'inverse-acknowledged' | 'finalized'
    | 'rollback-intent' | 'rollback-effect' | 'rollback-partial'
  sourceOperationId?: string
  sourceRequestId?: string
  finalize?: boolean
  resume?: boolean
}): Promise<void> {
  const store = new FileEditStore(options.recordsRoot)
  if (options.finalize && options.sourceOperationId && options.sourceRequestId) {
    const save = store['saveLockedPatchMetadata'].bind(store)
    store['saveLockedPatchMetadata'] = async (current, transaction) => {
      const result = await save(current, transaction)
      const reached = options.phase === 'source-verified' ? result.transaction.recovery?.state === 'pending'
        : options.phase === 'inverse-acknowledged' ? result.transaction.sourceFinalized
        : result.transaction.recovery?.state === 'complete'
      if (reached) process.exit(83)
      return result
    }
    await store.finalizePatchRestore(options.sourceOperationId, options.sourceRequestId, async () => {}, {
      inverse: { requestId: options.requestId, operationId: options.operationId }
    })
    throw new Error('Finalization did not reach the requested crash checkpoint.')
  }
  const controller = new AbortController()
  const exitAtCheckpoint = (record: Readonly<FilePatchTransaction>): void => {
    if (options.phase.startsWith('rollback') && record.entries.every((entry) => entry.state === 'applied')) {
      controller.abort(new Error('fixture cancellation'))
    }
    const reached = options.phase === 'prepared' ? record.state === 'prepared'
      : options.phase === 'staged' ? record.temporary.some((entry) => entry.identity)
      : options.phase === 'intent' ? record.entries[0].state === 'intent'
      : options.phase === 'partial' ? record.entries[0].state === 'applied' && record.entries[1].state === 'pending'
      : options.phase === 'rollback-intent' ? record.entries.some((entry) => entry.state === 'restoring')
      : options.phase === 'rollback-partial' ? record.entries.some((entry) => entry.state === 'restored')
      : options.phase === 'rollback-effect' ? false
      : record.state === 'applied'
    if (reached) process.exit(83)
  }
  const checkedPersist = async (record: Readonly<FilePatchTransaction>, persist: (record: Readonly<FilePatchTransaction>) => Promise<void>): Promise<void> => {
    // Exit after the rollback syscall, before its confirming snapshot is saved.
    if (options.phase === 'rollback-effect' && record.entries.some((entry) => entry.compensated)) process.exit(83)
    await persist(record)
    exitAtCheckpoint(record)
  }
  if (options.resume) {
    const createWriter = store['createPatchResumePersistence'].bind(store)
    store['createPatchResumePersistence'] = (record) => {
      const writer = createWriter(record)
      return { ...writer, persist: (snapshot) => checkedPersist(snapshot, writer.persist) }
    }
    await store.resumePatch(options.operationId, options.requestId, async () => {}, controller.signal)
    throw new Error('Resumption did not reach the requested crash checkpoint.')
  }
  if (options.sourceOperationId && options.sourceRequestId) {
    const createWriter = store.createPatchPersistence.bind(store)
    store.createPatchPersistence = (requestId, operationId) => {
      const writer = createWriter(requestId, operationId)
      return { ...writer, persist: (record) => checkedPersist(record, writer.persist) }
    }
    await store.restorePatch(options.sourceOperationId, options.sourceRequestId, options.requestId, async () => {}, {
      operationId: options.operationId, signal: controller.signal
    })
    throw new Error('Reverse transaction did not reach the requested crash checkpoint.')
  }
  const resolved = await resolveFilePatchTargets(asPatchInput({ operations: [
    { type: 'update', path: 'old.txt', patch: '@@\n-before\n+after\n' },
    { type: 'create', path: 'nested/empty.txt', content: '' }
  ] }), options.workspace)
  const images = await captureFilePatchPreimages(resolved.targets)
  const writer = store.createPatchPersistence(options.requestId, options.operationId)
  await executeFilePatchTransaction(options.operationId, resolved.input, images,
    (record) => checkedPersist(record, writer.persist), controller.signal)
}
