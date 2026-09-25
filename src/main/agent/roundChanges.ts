import type { DiffContents } from '@shared/diffContents'
import type { RoundFileContentInput } from '@shared/fileChanges'
import { readCurrentFileText, UnavailableText } from '../diffFileReader'
import type { FileChangeLedger } from './fileChangeLedger'

/** Resolve the path from recorded history before reading a current on-disk counterpart. */
export async function readRoundContents(ledger: FileChangeLedger, input: RoundFileContentInput, signal?: AbortSignal): Promise<DiffContents> {
  const bounded = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])])
  bounded.throwIfAborted()
  const recorded = ledger.readRoundContent(input, input.target === 'current' ? 'before' : 'both')
  if (recorded.status !== 'ready' || input.target === 'recorded') return recorded
  try {
    const current = await readCurrentFileText(recorded.path, bounded)
    bounded.throwIfAborted()
    // The conversation may change while disk I/O yields. Never attach new history to an old selection.
    ledger.queryRoundFiles({ runId: input.runId, filePath: recorded.path, version: input.version, limit: 1 })
    return { ...recorded, after: current.text, afterExists: current.exists }
  } catch (error) {
    bounded.throwIfAborted()
    if (error instanceof UnavailableText) return { status: 'unavailable', path: recorded.path, reason: error.reason }
    throw error
  }
}
