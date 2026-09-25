import { constants } from 'node:fs'
import type { Stats } from 'node:fs'
import { lstat, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { z } from 'zod/v3'
import { builtinFileToolNames } from '@shared/toolRegistry'
import { armCurrentAgentToolEffect, currentAgentToolEffectArtifactId, currentAgentToolEffectReference } from '../agent/toolEffectScope'
import { authorizeCurrentPatchTargets, verifyCurrentPatchInputTargets } from '../agent/patchAuthorization'
import { currentToolExecution } from '../agent/toolExecutionContext'
import { directoryTreePages, maximumTreeDepth } from '../directoryTree'
import { createTextPatch, defaultPatchMaxChars, defaultRequestPatchMaxChars, maxPatchMaxChars, patchFormat, type TextPatchResult } from '../fileEditDiff'
import { getDefaultFileEditStore, pathExists, type FileEditStore, type FileOperationRecord } from '../fileEditStore'
import { resolveWorkspacePath } from '../workspacePath'
import { filePatchLinePrefixInstructions, filePatchSchema, planFilePatch, resolveFilePatchTargets, resolveWriteFileTargets, writeFileSchema, type FilePatchChange } from '../filePatch'
import { captureFilePatchPreimages } from '../filePatchState'
import { FilePatchTransactionError } from '../filePatchTransaction'
import { patchCompensationComplete } from '../filePatchRecord'
import type { AuthorizeFilePatchRestore } from '../filePatchRestore'
import { createImageTools } from './imageTools'
import { toolSummarySchema } from './toolSummary'
import type { FileChangeLedger } from '../agent/fileChangeLedger'
import { readFileContentInfo } from '../fileMetadata'

export type FileEditStoreOperations = Pick<FileEditStore,
  | 'loadPatchForExecution'
  | 'executePatch'
  | 'previewPatchRestore'
  | 'restorePatch'
  | 'resumePatch'
  | 'finalizePatchRestore'
  | 'loadOperationRecord'
  | 'listRetainedEditRecords'
>

const maxMultipleReadFiles = 20
const maxLineSliceLines = 5_000
const defaultDirectoryLimit = 300
const maxDirectoryLimit = 1_000
const defaultTreeLimit = 300
const maxTreeEntries = 1_000

interface JsonResult {
  ok: boolean
  [key: string]: unknown
}

function json(value: JsonResult): string {
  return JSON.stringify(value)
}

function boundedPositiveInteger(value: unknown, fallback: number, max: number): number {
  return typeof value === 'number' ? Math.min(max, Math.max(1, Math.floor(value))) : fallback
}

function childPath(parent: string, child: string): string {
  return join(parent, child)
}

function filesystemErrorCode(error: unknown): string {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof error.code === 'string'
    ? error.code
    : 'UNKNOWN'
}

async function ensureDirectory(path: string, recursive: boolean): Promise<void> {
  try {
    await mkdir(path, { recursive })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw error
  }
}

// Slice bytes at LF boundaries so CRLF, BOM and the final newline survive intact.
// Keep only complete selected lines, including when one line exceeds the budget.
async function readUtf8Text(path: string, startLine: number, maxLines: number | undefined, byteLimit: number, signal?: AbortSignal) {
  const { file, info } = await openRegularFile(path, signal)
  try {
    if (maxLines === undefined && info.size > byteLimit) throw new Error(`file is too large to read as text (${info.size} bytes, max ${byteLimit})`)
    const selected = Buffer.alloc(Math.min(byteLimit, info.size))
    let pendingBytes = 0, returnedBytes = 0, totalBytes = 0
    let lineCount = 0, returnedLineCount = 0, lineHasBytes = false, outputLimitReached = false
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
    const finishLine = () => {
      lineCount++
      if (lineCount >= startLine && returnedLineCount < (maxLines ?? Infinity) && !outputLimitReached) {
        returnedBytes += pendingBytes
        returnedLineCount++
      }
      pendingBytes = 0
      lineHasBytes = false
    }
    const stream = file.createReadStream({ autoClose: false, signal })
    try {
      for await (const chunk of stream) {
        const bytes = chunk as Buffer
        totalBytes += bytes.length
        if (totalBytes > info.size) throw new Error('file changed while being read; retry')
        if (bytes.includes(0)) throw new Error('file appears to be binary')
        try { decoder.decode(bytes, { stream: true }) } catch { throw new Error('file is not valid UTF-8 text') }
        let offset = 0
        while (offset < bytes.length) {
          const newline = bytes.indexOf(10, offset)
          const end = newline < 0 ? bytes.length : newline + 1
          lineHasBytes = true
          if (lineCount + 1 >= startLine && returnedLineCount < (maxLines ?? Infinity) && !outputLimitReached) {
            const length = end - offset
            if (returnedBytes + pendingBytes + length > byteLimit) {
              outputLimitReached = true
              pendingBytes = 0
            } else {
              bytes.copy(selected, returnedBytes + pendingBytes, offset, end)
              pendingBytes += length
            }
          }
          if (newline >= 0) finishLine()
          offset = end
        }
      }
      try { decoder.decode() } catch { throw new Error('file is not valid UTF-8 text') }
      if (lineHasBytes) finishLine()
      const after = await file.stat()
      if (totalBytes !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('file changed while being read; retry')
      signal?.throwIfAborted()
      return {
        content: selected.subarray(0, returnedBytes).toString('utf8'),
        lineCount, returnedLineCount, returnedBytes, outputLimitReached,
        truncated: outputLimitReached || startLine - 1 + returnedLineCount < lineCount
      }
    } finally { stream.destroy() }
  } finally { await file.close() }
}

async function openRegularFile(path: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const before = await stat(path)
  signal?.throwIfAborted()
  if (!before.isFile()) throw new Error('path is not a file')
  // Follow ordinary file links, but never wait for a writer if the target is
  // replaced by a FIFO between the path check and open on POSIX.
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  try {
    signal?.throwIfAborted()
    const info = await file.stat()
    signal?.throwIfAborted()
    if (!info.isFile()) throw new Error('path is not a file')
    return { file, info }
  } catch (error) {
    await file.close()
    throw error
  }
}

function fileInfo(info: Stats): Record<string, unknown> {
  return {
    type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : info.isSymbolicLink() ? 'symlink' : 'other',
    size: info.size,
    modified: info.mtime.toISOString(),
    created: info.birthtime.toISOString()
  }
}

function toolError(error: unknown): string {
  return json({ ok: false, error: error instanceof Error ? error.message : 'File tool failed.' })
}

function unavailablePatch(reason: string): TextPatchResult {
  return {
    patchAvailable: false,
    patchFormat,
    patch: '',
    patchTruncated: false,
    patchUnavailableReason: reason
  }
}

function patchResultFields(patch: TextPatchResult): Record<string, unknown> {
  const result: Record<string, unknown> = {
    patch: patch.patch,
    patchTruncated: patch.patchTruncated
  }
  if (!patch.patchAvailable && patch.patchUnavailableReason) result.patchUnavailableReason = patch.patchUnavailableReason
  return result
}

async function patchForRecord(record: FileOperationRecord, maxChars: number, baseDirectory: string): Promise<TextPatchResult> {
  if (record.transaction.entries.some((entry) => entry.state !== 'applied' || !entry.after)) {
    return unavailablePatch(`Batch is ${record.transaction.state}; complete applied changes are not available.`)
  }
  return patchForChanges(record.transaction.entries.map((entry) => ({ path: entry.before.target.canonicalPath,
    operationIndex: entry.before.target.operationIndex, beforeText: entry.before.text, afterText: entry.after!.text })), maxChars, baseDirectory)
}

function patchForChanges(changes: readonly FilePatchChange[], maxChars: number, baseDirectory: string): TextPatchResult {
  const patches: string[] = []
  let remaining = maxChars, truncated = false
  for (const change of changes) {
    if (remaining <= 0) { truncated = true; break }
    const result = createTextPatch({ path: change.path, baseDirectory, beforeText: change.beforeText ?? '', afterText: change.afterText ?? '',
      beforeExists: change.beforeText !== null, afterExists: change.afterText !== null, maxChars: remaining })
    if (!result.patchAvailable) return result
    patches.push(result.patch)
    remaining -= result.patch.length + 1
    truncated ||= result.patchTruncated
  }
  return { patchAvailable: true, patchFormat, patch: patches.join('\n'), patchTruncated: truncated }
}

export interface FileToolOptions {
  primaryFolder: string
  // One output byte per configured context token. Null is a catalog-only preview.
  maxReadBytes: number | null | (() => Promise<number>)
  requestId?: string
  toolNames?: readonly string[]
  fileEditStore?: FileEditStoreOperations
  fileChanges?: Pick<FileChangeLedger, 'query'>
  authorizePatch?: AuthorizeFilePatchRestore
  signal?: AbortSignal
}

const workspacePathDescription = 'Path, absolute or relative to the primary/default folder.'

export function createFileTools(options: FileToolOptions): StructuredToolInterface[] {
  if (typeof options.maxReadBytes === 'number' && (!Number.isSafeInteger(options.maxReadBytes) || options.maxReadBytes <= 0)) {
    throw new Error('File read budget must be a positive safe integer.')
  }
  const readBudget = async () => {
    if (options.maxReadBytes === null) throw new Error('File reads require a configured model context capacity.')
    const bytes = typeof options.maxReadBytes === 'function' ? await options.maxReadBytes() : options.maxReadBytes
    if (!Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('File read budget must be a positive safe integer.')
    return bytes
  }
  const readLimitDescription = "The returned text limit in bytes equals the active model's configured maxContextTokens at execution time."
  const {
    primaryFolder,
    requestId,
    toolNames,
    fileEditStore = getDefaultFileEditStore(),
    authorizePatch = authorizeCurrentPatchTargets
  } = options
  const workspacePath = (input: unknown): string => resolveWorkspacePath(input, primaryFolder)
  const signal = () => currentToolExecution()?.signal ?? options.signal
  const identity = (purpose: 'file_edit' | 'file_restore') => {
    if (!requestId) throw new Error('Patch tools require an active request id.')
    const operationId = currentAgentToolEffectArtifactId(purpose)
    if (!operationId) throw new Error('Patch tools require a durable effect identity.')
    return { requestId, operationId }
  }
  const patchReferenceSchema = z.object({ requestId: z.string().uuid(), operationId: z.string().uuid() })
  const recordedEffect = () => {
    const effect = currentAgentToolEffectReference()
    if (!effect) return undefined
    if (effect.kind !== 'file_patch') throw new Error('Patch call has an unrelated durable effect.')
    return patchReferenceSchema.parse(effect.target)
  }
  const outcome = async (record: FileOperationRecord, error?: unknown) => {
    const transaction = error instanceof FilePatchTransactionError && error.record.id === record.operationId ? error.record : record.transaction
    const applied = transaction.entries.every((entry) => entry.state === 'applied')
    return json({ ok: !error && applied && ['applied', 'resolved', 'retained'].includes(transaction.state),
      operationId: record.operationId, recoveryRequestId: record.requestId, state: transaction.state,
      ...(transaction.restores ? { restores: transaction.restores } : {}),
      ...(transaction.recovery ? { recovery: transaction.recovery } : {}),
      ...(error ? { error: String(error) } : !applied ? { error: patchCompensationComplete(transaction)
        ? 'The attempt failed and was compensated; it did not complete the requested edit.' : 'The batch is incomplete; inspect retained recovery information.' } : {}),
      files: transaction.entries.map((entry) => ({ path: entry.before.target.canonicalPath, state: entry.state,
        operationIndex: entry.before.target.operationIndex, role: entry.before.target.field })),
      warnings: transaction.errors.slice(0, 20).map((message) => message.slice(0, 2000)), warningsTruncated: transaction.errors.length > 20,
      ...patchResultFields(await patchForRecord({ ...record, transaction }, defaultPatchMaxChars, primaryFolder)) })
  }
  const failed = async (error: unknown, reference?: { requestId: string; operationId: string }) => {
    const effect = currentAgentToolEffectReference()
    const publishedReference = effect?.kind === 'file_patch' ? patchReferenceSchema.safeParse(effect.target) : undefined
    // Finalizing an already-restored batch arms its source without creating the
    // preallocated inverse. Report that actual record even across requests.
    reference = publishedReference?.success ? publishedReference.data : reference
    if (reference) {
      try {
        const record = await fileEditStore.loadOperationRecord(reference.operationId, reference.requestId)
        return outcome(record, error)
      } catch (recordError) {
        const published = publishedReference?.success
          || (error instanceof FilePatchTransactionError && error.record.id === reference.operationId)
        if (published || filesystemErrorCode(recordError) !== 'ENOENT') {
          return json({ ok: false, error: String(error), operationId: reference.operationId,
            recoveryRequestId: reference.requestId, state: 'unavailable', recoveryError: String(recordError) })
        }
      }
    }
    return json({ ok: false, error: String(error) })
  }
  const executeEdit = async (dryRun: boolean, resolve: () => ReturnType<typeof resolveFilePatchTargets>) => {
    let reference: { requestId: string; operationId: string } | undefined
    try {
      if (!dryRun) {
        reference = recordedEffect() ?? identity('file_edit')
        const existing = await fileEditStore.loadPatchForExecution(reference.operationId, reference.requestId, 'file_edit')
        if (existing) {
          if (existing.transaction.restores) throw new Error('An apply call cannot resume a reverse operation.')
          return outcome(await fileEditStore.resumePatch(existing.operationId, existing.requestId, authorizePatch, signal()))
        }
      }
      const resolved = await resolve()
      if (!options.authorizePatch) verifyCurrentPatchInputTargets(resolved.targets)
      await authorizePatch(resolved.targets.map((target, index) => ({ path: target.canonicalPath, kind: 'file', index, semantics: 'entry', access: target.access })))
      const preimages = await captureFilePatchPreimages(resolved.targets, signal())
      if (dryRun) {
        const changes = planFilePatch(resolved.input, new Map(preimages.map((image) => [image.target.canonicalPath, image.text])))
        return json({ ok: true, dryRun: true, files: changes.map((change) => ({ path: change.path, changed: change.beforeText !== change.afterText })),
          ...patchResultFields(patchForChanges(changes, defaultPatchMaxChars, primaryFolder)) })
      }
      return outcome(await fileEditStore.executePatch(resolved.input, preimages, reference!.requestId, { operationId: reference!.operationId, signal: signal() }))
    } catch (error) { return failed(error, reference) }
  }
  const tools = [
    ...createImageTools(options),
    tool((input) => executeEdit(false, () => resolveWriteFileTargets(input, primaryFolder)), {
      name: 'write_file',
      description: 'Create a UTF-8 text file or replace its entire content. Prefer this tool for writing complete new files; send ordinary source text without patch prefixes. Missing parent directories are created automatically. overwrite defaults to false: fail if the file already exists. Set overwrite to true explicitly when replacing the entire existing file. Returns operationId/recoveryRequestId and a diff for get_file_edit_diff or restore_file_edit.',
      schema: writeFileSchema
    }),
    tool((input) => executeEdit(input.dry_run === true, () => resolveFilePatchTargets(input, primaryFolder)), { name: 'apply_patch', description: [
      'Apply one bounded UTF-8 file batch using a patch string enclosed by *** Begin Patch and *** End Patch.',
      'Use *** Add File: path with +content lines (an empty body creates an empty file), *** Delete File: path, or *** Update File: path.',
      filePatchLinePrefixInstructions,
      'An update may include *** Move to: destination immediately after its file header, with optional edit blocks.',
      'Start each edit block with @@ or @@ followed by an exact anchor line. No line numbers are needed.',
      'Blocks follow source order and all match the original file. An anchor is a unique complete source line before the edit; do not repeat it inside that block. A block with only additions appends at EOF, or inserts immediately after its anchor.',
      'Copy enough exact current context to match one unique location. Whitespace is significant; missing or ambiguous matches reject the entire batch. Re-read the file and add context before retrying.',
      'Use *** End of File after a block to require its context at the end of the file. Paths are absolute or relative to the primary folder.',
      'Existing line endings are preserved. Added lines normally end with a newline; place \\ No newline at end of file after the final old or new content line to explicitly assert or produce an unterminated final line.',
      'Complete example: {"patch":"*** Begin Patch\\n*** Update File: src/config.ts\\n@@\\n export const config = {\\n-  enabled: false,\\n+  enabled: true,\\n };\\n*** Add File: notes.txt\\n+Enabled the feature.\\n+\\n++This line starts with a literal plus.\\n*** End Patch"}',
      'dry_run validates the complete batch and returns its diff without writes or recovery records. A recorded edit returns operationId/recoveryRequestId for get_file_edit_diff or restore_file_edit.'
    ].join('\n'), schema: filePatchSchema }),

    tool(async (input) => {
      let reference: { requestId: string; operationId: string } | undefined
      try {
        const source = await fileEditStore.loadOperationRecord(input.operation_id, input.request_id ?? requestId)
        if (source.transaction.restores) throw new Error('Restore the original apply_patch operation, not its inverse record.')
        if (input.dry_run) {
          const plan = await fileEditStore.previewPatchRestore(source.operationId, source.requestId,
            (targets) => authorizePatch(targets.map((target) => ({ ...target, access: 'read' }))), signal())
          return json({ ok: plan.status === 'ready', dryRun: true, state: plan.status,
            files: plan.entries.map(({ path, action, reason }) => ({ path, action, ...(reason ? { reason } : {}) })),
            cleanupCount: plan.cleanup.length })
        }
        const durable = recordedEffect()
        reference = durable ?? identity('file_restore')
        let inverse = await fileEditStore.loadPatchForExecution(reference.operationId, reference.requestId, 'file_restore')
        if (inverse?.operationId === source.operationId && inverse.requestId === source.requestId) {
          inverse = undefined
          // Finalization arms the source before saving its pending marker. A
          // crash in that interval still belongs to the recorded latest inverse.
          if (!source.transaction.recovery && !source.transaction.reverseAttempt) {
            await fileEditStore.finalizePatchRestore(source.operationId, source.requestId, authorizePatch, { signal: signal() })
            return json({ ok: true, state: 'resolved', restoredOperationId: source.operationId, recoveryRequestId: source.requestId })
          }
        }
        if (!inverse && !source.transaction.recovery && source.transaction.reverseAttempt) {
          const previous = await fileEditStore.loadOperationRecord(source.transaction.reverseAttempt.operationId, source.transaction.reverseAttempt.requestId)
          if (!patchCompensationComplete(previous.transaction)) inverse = previous
        }
        if (inverse) {
          if (inverse.transaction.restores?.operationId !== source.operationId || inverse.transaction.restores.requestId !== source.requestId
            || inverse.transaction.restores.definitionHash !== source.definitionHash) throw new Error('Reverse effect does not belong to the requested source.')
          reference = { requestId: inverse.requestId, operationId: inverse.operationId }
          inverse = await fileEditStore.resumePatch(inverse.operationId, inverse.requestId, authorizePatch, signal())
          if (!inverse.transaction.entries.every((entry) => entry.state === 'applied')) return outcome(inverse)
        } else if (!source.transaction.recovery) {
          inverse = await fileEditStore.restorePatch(source.operationId, source.requestId, reference.requestId, authorizePatch,
            { operationId: reference.operationId, signal: signal() }) ?? undefined
        }
        await fileEditStore.finalizePatchRestore(source.operationId, source.requestId, authorizePatch,
          { ...(inverse ? { inverse: { requestId: inverse.requestId, operationId: inverse.operationId } } : {}), signal: signal() })
        return inverse ? outcome(await fileEditStore.loadOperationRecord(inverse.operationId, inverse.requestId))
          : json({ ok: true, state: 'resolved', restoredOperationId: source.operationId, recoveryRequestId: source.requestId })
      } catch (error) { return failed(error, reference) }
    }, { name: 'restore_file_edit', description: 'Restore an entire original apply_patch or write_file operation. Uses confirmed identities, resumes its unfinished inverse, and never overwrites conflicting external edits. Returns a separate inverse record when files changed.',
      schema: z.object({ summary: toolSummarySchema, operation_id: z.string().uuid(), request_id: z.string().uuid().optional(), dry_run: z.boolean().optional() }).strict() }),
    tool(async (input) => {
      try {
        const path = workspacePath(input.path)
        const startLine = input.start_line ?? 1
        const byteLimit = await readBudget()
        const { outputLimitReached, ...result } = await readUtf8Text(path, startLine, input.max_lines, byteLimit, signal())
        if (input.format === 'raw') {
          if (outputLimitReached) throw new Error(`Requested line range exceeds ${byteLimit} bytes; no partial raw content was returned. Request fewer lines or use format: json.`)
          return result.content
        }
        return json({ ok: true, startLine, byteLimit, ...result })
      } catch (error) {
        signal()?.throwIfAborted()
        if (input.format === 'raw') throw error
        return toolError(error)
      }
    }, {
      name: 'read_file',
      description: `Read UTF-8 text before editing, preserving original CRLF/LF, BOM and final-newline state without adding line numbers. format=json (default) returns content and range metadata; format=raw returns only the exact text of the requested range, with no wrapper. Raw fails instead of returning a byte-limited partial range. ${readLimitDescription} Use max_lines for files larger than this limit. Rejects binary or invalid UTF-8 data. Use view_image or view_multiple_images for images.`,
      schema: z.object({
        summary: toolSummarySchema,
        path: z.string().describe(workspacePathDescription),
        format: z.enum(['json', 'raw']).optional().default('json').describe('json: content with range/completeness metadata. raw: exact text only; errors are tool failures, never file content.'),
        start_line: z.number().int().min(1).optional().describe('First line to return, 1-based. Default 1. Lines end at LF or CRLF; original terminators are included.'),
        max_lines: z.number().int().min(1).max(maxLineSliceLines).optional().describe('Lines from start_line; maximum 5000. Required for files larger than the model-specific byte limit. EOF may return fewer lines. Empty files have zero lines; a final newline does not create an extra line.')
      })
    }),

    tool(async (input) => {
      try {
        const paths = Array.isArray(input.paths) ? input.paths : []
        const byteLimit = await readBudget()
        const selectedPaths = paths.slice(0, maxMultipleReadFiles)
        const files = []
        let returnedBytes = 0
        let truncated = selectedPaths.length < paths.length
        for (const rawPath of selectedPaths) {
          try {
            const path = workspacePath(rawPath)
            const info = await stat(path)
            if (!info.isFile()) throw new Error('path is not a file')
            if (returnedBytes + info.size > byteLimit) {
              truncated = true
              files.push({ ok: false, path, size: info.size, error: `aggregate read limit exceeded (${byteLimit} bytes)` })
              continue
            }
            const result = await readUtf8Text(path, 1, undefined, byteLimit - returnedBytes, signal())
            returnedBytes += result.returnedBytes
            files.push({ ok: true, path, size: result.returnedBytes, content: result.content })
          } catch (error) {
            signal()?.throwIfAborted()
            files.push({ ok: false, path: typeof rawPath === 'string' ? rawPath : '', error: error instanceof Error ? error.message : 'Read failed.' })
          }
        }
        return json({
          ok: true,
          fileLimit: maxMultipleReadFiles,
          byteLimit,
          returnedBytes,
          truncated,
          files
        })
      } catch (error) {
        signal()?.throwIfAborted()
        return toolError(error)
      }
    }, {
      name: 'read_multiple_files',
      description: `Read up to 20 UTF-8 files as JSON with per-file results. ${readLimitDescription} All files in this call share that aggregate budget. Preserves original text, including CRLF/LF, BOM and final-newline state. Rejects binary or invalid UTF-8 data. Use read_file with format=raw for a single file without a JSON wrapper.`,
      schema: z.object({
        summary: toolSummarySchema,
        paths: z.array(z.string()).describe('Paths, absolute or relative to the primary/default folder; only the first 20 are processed.')
      })
    }),

    tool(async (input) => {
      try {
        const scope = input.scope === 'operation'
          ? 'operation'
          : input.scope === 'retained'
            ? 'retained'
            : input.scope === 'request'
              ? 'request'
              : typeof input.operation_id === 'string'
                ? 'operation'
                : 'request'
        const maxChars = boundedPositiveInteger(input.max_chars, scope === 'request' ? defaultRequestPatchMaxChars : defaultPatchMaxChars, maxPatchMaxChars)
        const sourceRequestId = typeof input.request_id === 'string' && input.request_id.trim()
          ? input.request_id.trim()
          : requestId
        if (scope === 'operation') {
          const operationId = typeof input.operation_id === 'string' ? input.operation_id.trim() : ''
          if (!operationId) return json({ ok: false, error: 'operation_id is required for operation scope' })
          if (!sourceRequestId || !options.fileChanges) throw new Error('Persistent file change history is unavailable.')
          const patch = options.fileChanges.query({ runId: sourceRequestId, operationId, maxChars,
            filePath: input.file_path, after: input.after, limit: input.limit, version: input.version }, primaryFolder)
          return json({
            ok: true,
            ...patch
          })
        }

        if (scope === 'retained') {
          const records = await fileEditStore.listRetainedEditRecords()
          return json({
            ok: true,
            retained: records.map((record) => record.tool === 'unavailable' ? {
              operationId: record.operationId, recoveryRequestId: record.requestId,
              state: 'unavailable', error: record.error
            } : ({
              operationId: record.operationId,
              recoveryRequestId: record.requestId,
              paths: record.transaction.entries.map((entry) => entry.before.target.canonicalPath), state: record.transaction.state,
              tool: record.tool
            }))
          })
        }

        if (!sourceRequestId || !options.fileChanges) throw new Error('Persistent file change history is unavailable.')
        return json({
          ok: true,
          ...options.fileChanges.query({ runId: sourceRequestId, maxChars, filePath: input.file_path,
            after: input.after, limit: input.limit, version: input.version }, primaryFolder)
        })
      } catch (error) {
        return toolError(error)
      }
    }, {
      name: 'get_file_edit_diff',
      description: 'Query persistent recorded changes for an operation or a run and all its actual subagents, with bounded pagination and evidence-backed segments. Not Git workspace changes. History diffs do not imply recovery materials still exist. Retained scope lists actual crash-recovery handles.',
      schema: z.object({
        summary: toolSummarySchema,
        scope: z.enum(['operation', 'request', 'retained']).optional().describe('operation: one edit; request: selected run and actual descendants; retained: recovery handles. Inferred from operation_id.'),
        operation_id: z.string().optional().describe('Edit operation id; required for operation scope.'),
        request_id: z.string().optional().describe('Selected run ID; defaults to this run. For operation scope, use the originating run ID.'),
        file_path: z.string().optional().describe('Exact absolute file path from a previous query; filters recorded history without reading current disk files.'),
        after: z.number().int().nonnegative().optional().describe('nextAfter cursor from the previous page.'),
        limit: z.number().int().min(1).max(100).optional().describe('Maximum operations per page; default 20.'),
        version: z.string().optional().describe('Version from the first page. If history changes, restart pagination.'),
        max_chars: z.number().optional().describe('Patch limit. Default 12000 for operation or 20000 for request; maximum 40000.')
      })
    }),

    tool(async (input) => {
      try {
        const path = workspacePath(input.path)
        const recursive = input.recursive !== false
        armCurrentAgentToolEffect({
          kind: 'directory_create',
          target: { path, recursive },
          recoveryMode: 'idempotent'
        })
        await ensureDirectory(path, recursive)
        return json({ ok: true })
      } catch (error) {
        return toolError(error)
      }
    }, {
      name: 'create_directory',
      description: 'Create a directory and, by default, missing parents.',
      schema: z.object({
        summary: toolSummarySchema,
        path: z.string().describe(workspacePathDescription),
        recursive: z.boolean().optional().describe('Create missing parents. Default true.')
      })
    }),

    tool(async (input) => {
      try {
        const path = workspacePath(input.path)
        const limit = boundedPositiveInteger(input.limit, defaultDirectoryLimit, maxDirectoryLimit)
        const entries = await readdir(path, { withFileTypes: true })
        const selected = entries.slice(0, limit)
        return json({
          ok: true,
          limit,
          truncated: entries.length > selected.length,
          entries: await Promise.all(selected.map(async (entry) => {
            const fullPath = childPath(path, entry.name)
            const info = await lstat(fullPath)
            return { name: entry.name, type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : info.isSymbolicLink() ? 'symlink' : 'other', size: info.size }
          }))
        })
      } catch (error) {
        return toolError(error)
      }
    }, {
      name: 'list_directory',
      description: 'List only the immediate children of a directory; this is non-recursive. Use directory_tree to traverse descendants.',
      schema: z.object({
        summary: toolSummarySchema,
        path: z.string().describe(workspacePathDescription),
        limit: z.number().optional().describe('Entry limit. Default 300; maximum 1000.')
      })
    }),

    tool(async (input) => {
      try {
        const path = workspacePath(input.path)
        const maxEntries = boundedPositiveInteger(input.max_entries, defaultTreeLimit, maxTreeEntries)
        return json({ ok: true, ...await directoryTreePages.read({
          root: path, scope: requestId ?? primaryFolder, entryLimit: maxEntries,
          depthLimit: input.max_depth, cursor: input.cursor, signal: signal(), lifetimeSignal: options.signal
        }) })
      } catch (error) {
        return toolError(error)
      }
    }, {
      name: 'directory_tree',
      description: 'Incrementally traverse breadth-first in filesystem order, without following symlinks. Continue with nextCursor as cursor and the same path; cursors are single-use, run-scoped and expire after 5 idle minutes. Pages limit both output and scanning work, so a page may be short or empty while hasMore is true. Entries marked childrenOmitted were not expanded: use that subdirectory as a new root to inspect it. Unreadable descendants are reported and skipped. This is a live listing, not a filesystem snapshot.',
      schema: z.object({
        summary: toolSummarySchema,
        path: z.string().describe(workspacePathDescription),
        max_entries: z.number().optional().describe('Entries per page. Default 300; maximum 1000.'),
        max_depth: z.number().int().min(0).max(maximumTreeDepth).optional().describe('Maximum depth relative to the root (root is 0). Default and maximum 64; omit on continuation to keep the original depth.'),
        cursor: z.string().uuid().optional().describe('nextCursor from the previous page. Omit to start a new traversal.')
      }).strict()
    }),

    tool(async (input) => {
      try {
        const source = workspacePath(input.source)
        const destination = workspacePath(input.destination)
        if (input.overwrite !== true && await pathExists(destination)) return json({ ok: false, error: 'destination already exists', source, destination })
        armCurrentAgentToolEffect({
          kind: 'file_move',
          target: { source, destination, overwrite: input.overwrite === true }
        })
        if (input.create_parents === true) await mkdir(dirname(destination), { recursive: true })
        await rename(source, destination)
        return json({ ok: true })
      } catch (error) {
        return toolError(error)
      }
    }, {
      name: 'move_file',
      description: 'Move or rename a file or directory.',
      schema: z.object({
        summary: toolSummarySchema,
        source: z.string().describe('Source path, absolute or relative to the primary/default folder.'),
        destination: z.string().describe('Destination path, absolute or relative to the primary/default folder.'),
        create_parents: z.boolean().optional().describe('Create missing destination parents. Default false.'),
        overwrite: z.boolean().optional().describe('Allow destination replacement. Default false.')
      })
    }),

    tool(async (input) => {
      try {
        const path = workspacePath(input.path)
        armCurrentAgentToolEffect({
          kind: 'file_delete',
          target: { path, recursive: input.recursive === true, force: input.force === true }
        })
        await rm(path, { recursive: input.recursive === true, force: input.force === true })
        return json({ ok: true })
      } catch (error) {
        return toolError(error)
      }
    }, {
      name: 'delete_file',
      description: 'Delete a file or, with recursive=true, a directory.',
      schema: z.object({
        summary: toolSummarySchema,
        path: z.string().describe(workspacePathDescription),
        recursive: z.boolean().optional().describe('Delete a directory and its contents. Default false.'),
        force: z.boolean().optional().describe('Treat a missing path as success. Default false.')
      })
    }),

    tool(async (input) => {
      try {
        const path = workspacePath(input.path)
        const info = await lstat(path)
        const result = fileInfo(info)
        if (info.isFile()) {
          try {
            const { file, info: opened } = await openRegularFile(path, signal())
            try {
              if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size || opened.mtimeMs !== info.mtimeMs || opened.ctimeMs !== info.ctimeMs) {
                throw new Error('File changed before reading metadata; retry.')
              }
              Object.assign(result, await readFileContentInfo(file, opened, path, { signal: signal() }))
            } finally { await file.close() }
          } catch (error) {
            signal()?.throwIfAborted()
            result.metadataError = error instanceof Error ? error.message : 'File metadata could not be read.'
          }
        }
        return json({ ok: true, ...result })
      } catch (error) {
        signal()?.throwIfAborted()
        return toolError(error)
      }
    }, {
      name: 'get_file_info',
      description: 'Get path type, size in bytes and timestamps. Automatically inspect local images (pixel dimensions, EXIF orientation and alpha when known), audio and video (format, durationSeconds and compact track details). No pixel decoding or external command is required. UTF-8 text files up to 1 MB include lineCount. Metadata detection is bounded; metadataError explains failures while basic file information remains available.',
      schema: z.object({
        summary: toolSummarySchema,
        path: z.string().describe(workspacePathDescription)
      })
    })
  ]
  const selectedToolNames = toolNames ? new Set(toolNames) : undefined
  return tools.filter((item) =>
    builtinFileToolNames.includes(item.name as (typeof builtinFileToolNames)[number])
    && (!selectedToolNames || selectedToolNames.has(item.name))
  )
}
