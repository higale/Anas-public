import { isAbsolute } from 'node:path'
import { z } from 'zod/v3'
import { samePath, isSameOrInsideDirectory } from './pathContainment'
import { resolveCanonicalWorkspacePath, type CanonicalWorkspacePath, type WorkspacePathSemantics } from './workspacePath'
import { maxPatchInputBytes } from './fileEditDiff'
import { toolSummarySchema } from './llm/toolSummary'
import { applyContextTextPatch, parseContextHunks, parseContextPatchDocument } from './contextPatch'

export const maxFilePatchOperations = 20
export const maxFilePatchBatchBytes = 4_000_000
const pathSchema = z.string().trim().min(1).max(32_768).refine((value) => !value.includes('\0'), 'Path contains NUL.')
const textSchema = z.string().max(maxPatchInputBytes)
const patchSchema = textSchema.min(1)

export const writeFileSchema = z.object({
  summary: toolSummarySchema,
  path: pathSchema.describe('Path, absolute or relative to the primary/default folder.'),
  content: textSchema.describe('Complete UTF-8 file content, preserved exactly; does not append. Send ordinary source text without patch prefixes.'),
  overwrite: z.boolean().optional().default(false).describe('Allow replacing an existing file. Default false: fail if the file already exists. Set true explicitly to replace its entire content.')
}).strict()

export const filePatchLinePrefixInstructions = [
  'Put each content line\'s patch prefix in column 1, BEFORE its original indentation. The prefix is not part of the file content.',
  'Add File: EVERY content line must start with +, including comments and blank lines. An added blank line is + alone. Never paste unprefixed source code after an Add File header.',
  'For an added source line that itself starts with +, add another +: source +value becomes patch ++value. Preserve all source indentation after the patch prefix.',
  'Update File: use a space for unchanged context, - for removed lines, and + for added lines; blank content lines also need the corresponding prefix.',
  'Do not add content prefixes to patch control lines such as *** Begin Patch, *** Add File:, @@, or *** End Patch.'
].join('\n')

export const filePatchSchema = z.object({
  summary: toolSummarySchema,
  patch: z.string().min(1).max(maxFilePatchBatchBytes).describe([
    '*** Begin Patch / *** End Patch document with Add, Update, Delete File sections. Use @@ context blocks without numeric line ranges; copy exact, unique source context.',
    filePatchLinePrefixInstructions,
    'Example creating three lines (text, an empty line, and text starting with a literal +):',
    '*** Begin Patch\n*** Add File: example.txt\n+First line\n+\n++literal plus\n*** End Patch'
  ].join('\n')),
  dry_run: z.boolean().optional()
}).strict()

// Private transaction plan, not an alternate model-facing input format.
const filePatchPlanSchema = z.object({
  summary: toolSummarySchema,
  operations: z.array(z.discriminatedUnion('type', [
    z.object({ type: z.literal('create'), path: pathSchema, content: textSchema }).strict(),
    z.object({ type: z.literal('write'), path: pathSchema, content: textSchema, overwrite: z.boolean() }).strict(),
    z.object({ type: z.literal('update'), path: pathSchema, patch: patchSchema }).strict(),
    z.object({ type: z.literal('delete'), path: pathSchema }).strict(),
    z.object({ type: z.literal('move'), path: pathSchema, destination: pathSchema, patch: patchSchema.optional() }).strict()
  ])).min(1).max(maxFilePatchOperations),
  dry_run: z.boolean().optional()
}).strict()

export type FilePatchInput = z.infer<typeof filePatchSchema>
export type FilePatchPlan = z.infer<typeof filePatchPlanSchema>

export interface FilePatchTarget extends CanonicalWorkspacePath {
  operationIndex: number
  field: 'path' | 'destination'
  semantics: WorkspacePathSemantics
  access: 'read' | 'write'
}

export interface FilePatchChange {
  operationIndex: number
  path: string
  // null means absent, which is different from an existing empty file.
  beforeText: string | null
  afterText: string | null
}

export function filePatchOperationSemantics(operation: FilePatchPlan['operations'][number]): WorkspacePathSemantics {
  return operation.type === 'update' || (operation.type === 'write' && operation.overwrite) ? 'follow' : 'entry'
}

export function filePatchPathArguments(input: FilePatchPlan): Array<Pick<FilePatchTarget,
  'operationIndex' | 'field' | 'semantics' | 'access'> & { value: string }> {
  return input.operations.flatMap((operation, operationIndex) => {
    const base = { operationIndex, semantics: filePatchOperationSemantics(operation), access: input.dry_run ? 'read' as const : 'write' as const }
    return [{ ...base, field: 'path' as const, value: operation.path },
      ...(operation.type === 'move' ? [{ ...base, field: 'destination' as const, value: operation.destination }] : [])]
  })
}

function textBytes(text: string): number {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length > maxPatchInputBytes) throw new Error(`Patch text exceeds ${maxPatchInputBytes} bytes.`)
  if (text.includes('\0') || buffer.toString('utf8') !== text) throw new Error('Patch requires valid UTF-8 text without NUL.')
  return buffer.length
}

export function parseFilePatch(input: unknown): FilePatchPlan {
  const parsed = filePatchSchema.parse(input)
  const buffer = Buffer.from(parsed.patch, 'utf8')
  if (buffer.length > maxFilePatchBatchBytes) throw new Error(`Patch batch exceeds ${maxFilePatchBatchBytes} bytes.`)
  if (parsed.patch.includes('\0') || buffer.toString('utf8') !== parsed.patch) throw new Error('Patch requires valid UTF-8 text without NUL.')
  return validateFilePatchPlan({ summary: parsed.summary, dry_run: parsed.dry_run, operations: parseContextPatchDocument(parsed.patch) })
}

export function parseWriteFile(input: unknown): FilePatchPlan {
  const { summary, path, content, overwrite } = writeFileSchema.parse(input)
  return validateFilePatchPlan({ summary, operations: [{ type: 'write', path, content, overwrite }] })
}

function validateFilePatchPlan(input: unknown): FilePatchPlan {
  const parsed = filePatchPlanSchema.parse(input)
  let bytes = 0
  for (const operation of parsed.operations) {
    if ('content' in operation) bytes += textBytes(operation.content)
    if ('patch' in operation && operation.patch !== undefined) {
      bytes += textBytes(operation.patch)
      parseContextHunks(operation.patch)
    }
    if (bytes > maxFilePatchBatchBytes) throw new Error(`Patch batch exceeds ${maxFilePatchBatchBytes} bytes.`)
  }
  return parsed
}

// Path resolution is separate from reading file contents. Callers must finish
// rule/approval checks for every returned target before loading text snapshots.
export function resolveFilePatchTargets(input: unknown, primaryFolder: string) {
  return resolveFilePlanTargets(parseFilePatch(input), primaryFolder)
}

export function resolveWriteFileTargets(input: unknown, primaryFolder: string) {
  return resolveFilePlanTargets(parseWriteFile(input), primaryFolder)
}

async function resolveFilePlanTargets(parsed: FilePatchPlan, primaryFolder: string): Promise<{
  input: FilePatchPlan
  targets: FilePatchTarget[]
}> {
  const targets: FilePatchTarget[] = []
  for (const { operationIndex, field, value, semantics, access } of filePatchPathArguments(parsed)) {
    const target = await resolveCanonicalWorkspacePath(value, primaryFolder, semantics)
    targets.push({ ...target, operationIndex, field, semantics, access })
    const operation = parsed.operations[operationIndex]
    if (field === 'destination' && operation.type === 'move') operation.destination = target.canonicalPath
    else operation.path = target.canonicalPath
  }
  assertDistinctTargets(targets.map((target) => target.canonicalPath))
  return { input: parsed, targets }
}

function assertDistinctTargets(paths: string[]): void {
  for (const [index, path] of paths.entries()) {
    if (!isAbsolute(path)) throw new Error('Patch planning requires resolved absolute paths.')
    for (const previous of paths.slice(0, index)) {
      if (samePath(previous, path)
        || isSameOrInsideDirectory(previous, path)
        || isSameOrInsideDirectory(path, previous)) {
        throw new Error('Patch targets overlap; combine edits for each file and do not chain moves within one batch.')
      }
    }
  }
}

// Snapshots must be loaded from the resolved targets after authorization. This
// pure phase calculates the entire batch before any staging or target write.
export function planFilePatch(input: unknown, snapshots: ReadonlyMap<string, string | null>): FilePatchChange[] {
  const parsed = validateFilePatchPlan(input)
  const paths = parsed.operations.flatMap((operation) => operation.type === 'move'
    ? [operation.path, operation.destination] : [operation.path])
  assertDistinctTargets(paths)
  const changes: FilePatchChange[] = []
  let bytes = 0
  const read = (path: string) => {
    if (!snapshots.has(path)) throw new Error(`Patch target snapshot is missing: ${path}`)
    const text = snapshots.get(path)!
    if (text !== null) bytes += textBytes(text)
    if (bytes > maxFilePatchBatchBytes) throw new Error(`Patch snapshots exceed ${maxFilePatchBatchBytes} bytes.`)
    return text
  }
  for (const [operationIndex, operation] of parsed.operations.entries()) {
    const before = read(operation.path)
    if (operation.type === 'write') {
      if (!operation.overwrite && before !== null) throw new Error(`File already exists and overwrite is false: ${operation.path}`)
      changes.push({ operationIndex, path: operation.path, beforeText: before, afterText: operation.content })
    } else if (operation.type === 'create') {
      if (before !== null) throw new Error(`Patch create target already exists: ${operation.path}`)
      changes.push({ operationIndex, path: operation.path, beforeText: null, afterText: operation.content })
    } else {
      if (before === null) throw new Error(`Patch source does not exist: ${operation.path}`)
      if (operation.type === 'delete') {
        changes.push({ operationIndex, path: operation.path, beforeText: before, afterText: null })
      } else {
        let after = before
        if (operation.patch !== undefined) {
          try { after = applyContextTextPatch(before, operation.patch) }
          catch (error) { throw new Error(`File ${JSON.stringify(operation.path)} (operation ${operationIndex + 1}): ${error instanceof Error ? error.message : String(error)}`) }
        }
        if (operation.type === 'move') {
          if (read(operation.destination) !== null) throw new Error(`Patch move destination already exists: ${operation.destination}`)
          changes.push({ operationIndex, path: operation.path, beforeText: before, afterText: null })
          changes.push({ operationIndex, path: operation.destination, beforeText: null, afterText: after })
        } else {
          changes.push({ operationIndex, path: operation.path, beforeText: before, afterText: after })
        }
      }
    }
  }
  const outputBytes = changes.reduce((sum, change) => sum + (change.afterText === null ? 0 : textBytes(change.afterText)), 0)
  if (outputBytes > maxFilePatchBatchBytes) throw new Error(`Patch output exceeds ${maxFilePatchBatchBytes} bytes.`)
  return changes
}
