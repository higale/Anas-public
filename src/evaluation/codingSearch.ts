import { createHash } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'

type SearchMatch = { path: string; line: number; text: string }

export type SearchExpectation =
  | { kind: 'files'; paths: string[] }
  | { kind: 'matches'; matches: SearchMatch[] }

// Shell stdout is limited to 120000 characters. A JSON status envelope can
// escape each stdout/stderr character to six characters, plus command metadata.
const maxStdoutCharacters = 120_000
const maxEnvelopeCharacters = 1_500_000
const maxEntries = 4096
const maxRecords = maxEntries * 3 + 1
const maxEvidenceEntries = 32

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function natural(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function textField(value: unknown, name: string): string {
  requireCondition(record(value) && typeof value.text === 'string' && !Object.hasOwn(value, 'bytes'), `Invalid UTF-8 ${name}.`)
  return value.text
}

function normalizedPath(workspace: string, value: unknown): string {
  requireCondition(typeof value === 'string' && value.length > 0 && !/[\0\r\n]/.test(value), 'Invalid search path.')
  // Use the actual host's path rules: on POSIX a backslash is a filename
  // character, while Windows rg can return either slash style or absolute paths.
  if (sep === '\\') requireCondition(!value.includes(':') || isAbsolute(value) && !value.slice(2).includes(':'), 'Invalid Windows search path.')
  const path = relative(resolve(workspace), resolve(workspace, value))
  requireCondition(path && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path), 'Search path escapes the fixture root.')
  return path.split(sep).join('/')
}

function shellStdout(output: unknown): string {
  let envelope: unknown = output
  if (typeof output === 'string') {
    // A native one-line rg summary is JSON too; only Shell status fields
    // identify an envelope. Multi-record rg output is parsed below as NDJSON.
    try { envelope = JSON.parse(output) } catch { envelope = undefined }
    if (!record(envelope)) return output
    const status = envelope
    if (!['ok', 'stdout', 'stderr', 'exitCode', 'error', 'timedOut', 'aborted', 'truncated']
      .some((key) => Object.hasOwn(status, key))) return output
  }
  requireCondition(record(envelope), 'Expected Shell stdout or a Shell status envelope.')
  requireCondition(envelope.ok === true && envelope.exitCode === 0, 'Shell did not complete successfully.')
  requireCondition(typeof envelope.stdout === 'string', 'Shell envelope is missing stdout.')
  requireCondition(envelope.stderr === undefined || envelope.stderr === '', 'Shell returned stderr.')
  requireCondition(envelope.error === undefined || envelope.error === '', 'Shell returned an error.')
  requireCondition(envelope.signal === undefined || envelope.signal === null, 'Shell terminated with a signal.')
  requireCondition(envelope.timedOut === undefined || envelope.timedOut === false, 'Shell timed out.')
  requireCondition(envelope.aborted === undefined || envelope.aborted === false, 'Shell was aborted.')
  requireCondition(envelope.truncated === undefined || record(envelope.truncated)
    && envelope.truncated.stdout === false && envelope.truncated.stderr === false, 'Shell output was truncated or has invalid truncation state.')
  return envelope.stdout
}

function linesOf(stdout: string): string[] {
  if (!stdout) return []
  const lines = stdout.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

function parseFiles(workspace: string, stdout: string): SearchMatch[] {
  const lines = linesOf(stdout)
  requireCondition(lines.length <= maxEntries, 'Search entry budget exceeded.')
  const paths = lines.map((line) => normalizedPath(workspace, line))
  requireCondition(new Set(paths).size === paths.length, 'Duplicate file paths in rg output.')
  return paths.map((path) => ({ path, line: 0, text: '' }))
}

function duration(value: unknown): boolean {
  return record(value) && natural(value.secs) && natural(value.nanos) && value.nanos < 1_000_000_000 && typeof value.human === 'string'
}

function searchStats(value: unknown): Record<string, number> {
  requireCondition(record(value) && duration(value.elapsed)
    && ['searches', 'searches_with_match', 'bytes_searched', 'bytes_printed', 'matched_lines', 'matches'].every((key) => natural(value[key])),
  'Invalid rg statistics.')
  return value as Record<string, number>
}

function parseMatches(workspace: string, stdout: string): SearchMatch[] {
  const lines = linesOf(stdout)
  requireCondition(lines.length > 0 && lines.length <= maxRecords, 'Missing rg records or record budget exceeded.')
  const active = new Map<string, { lines: number; matches: number }>()
  const ended = new Set<string>()
  const entries: SearchMatch[] = []
  const keys = new Set<string>()
  let summary = false, totalLines = 0, totalMatches = 0
  for (const line of lines) {
    requireCondition(!summary, 'Unexpected output after the rg summary.')
    let item: unknown
    try { item = JSON.parse(line) } catch { throw new Error('Malformed or incomplete rg JSON record.') }
    requireCondition(record(item) && record(item.data), 'Invalid rg JSON record.')
    const data = item.data
    if (item.type === 'summary') {
      requireCondition(active.size === 0, 'Missing rg end record.')
      const stats = searchStats(data.stats)
      requireCondition(duration(data.elapsed_total) && stats.matched_lines === totalLines && stats.matches === totalMatches
        && stats.searches_with_match === ended.size && stats.searches >= ended.size, 'rg summary does not match the complete record stream.')
      summary = true
      continue
    }
    requireCondition(item.type === 'begin' || item.type === 'match' || item.type === 'end', 'Unexpected rg record type.')
    const path = normalizedPath(workspace, textField(data.path, 'path'))
    if (item.type === 'begin') {
      requireCondition(!active.has(path) && !ended.has(path), 'Duplicate rg begin record.')
      requireCondition(active.size + ended.size < maxEntries, 'Search entry budget exceeded.')
      active.set(path, { lines: 0, matches: 0 })
      continue
    }
    const file = active.get(path)
    requireCondition(file !== undefined, 'rg record has no matching begin record.')
    if (item.type === 'end') {
      const stats = searchStats(data.stats)
      requireCondition(data.binary_offset === null && file.matches > 0 && stats.searches === 1 && stats.searches_with_match === 1
        && stats.matched_lines === file.lines && stats.matches === file.matches, 'Invalid or incomplete rg end record.')
      active.delete(path)
      ended.add(path)
      continue
    }
    const text = textField(data.lines, 'matched lines')
    requireCondition(natural(data.line_number) && data.line_number > 0 && natural(data.absolute_offset), 'Invalid rg match location.')
    requireCondition(Array.isArray(data.submatches) && data.submatches.length > 0, 'Missing rg submatches.')
    const bytes = Buffer.from(text, 'utf8')
    for (const match of data.submatches) {
      requireCondition(record(match) && natural(match.start) && natural(match.end) && match.end >= match.start && match.end <= bytes.length,
        'Invalid rg submatch offsets.')
      requireCondition(textField(match.match, 'submatch') === bytes.subarray(match.start, match.end).toString('utf8'), 'Invalid rg submatch text.')
    }
    const entry = { path, line: data.line_number, text }
    const key = JSON.stringify([path, entry.line])
    requireCondition(!keys.has(key), 'Duplicate rg matching line.')
    requireCondition(entries.length < maxEntries, 'Search entry budget exceeded.')
    keys.add(key)
    entries.push(entry)
    const matchedLines = linesOf(text).length
    file.lines += matchedLines
    file.matches += data.submatches.length
    totalLines += matchedLines
    totalMatches += data.submatches.length
  }
  requireCondition(summary, 'Missing final rg summary.')
  return entries
}

/** Check full tool_completed output; excerpts below are diagnostics only. */
export function checkSearchOutput(workspace: string, output: unknown, expected: SearchExpectation) {
  let raw: string
  try { raw = typeof output === 'string' ? output : JSON.stringify(output) ?? String(output) }
  catch { raw = '[Unserializable tool output]' }
  const evidence = {
    fingerprint: createHash('sha256').update(raw).digest('hex'),
    characters: raw.length,
    excerpt: raw.slice(0, 4000),
    truncated: raw.length > 4000
  }
  const errors: string[] = []
  let actual: SearchMatch[] | undefined
  const expectedCount = expected.kind === 'files' ? expected.paths.length : expected.matches.length
  try {
    requireCondition(raw.length <= maxEnvelopeCharacters, 'Shell envelope character budget exceeded.')
    const stdout = shellStdout(output)
    requireCondition(stdout.length <= maxStdoutCharacters, 'Shell stdout character budget exceeded.')
    requireCondition(expectedCount <= maxEntries, 'Expected search entry budget exceeded.')
    const wanted = expected.kind === 'files'
      ? expected.paths.map((path) => ({ path: normalizedPath(workspace, path), line: 0, text: '' }))
      : expected.matches.map((match) => {
        requireCondition(natural(match.line) && match.line > 0 && typeof match.text === 'string', 'Invalid expected match.')
        return { ...match, path: normalizedPath(workspace, match.path) }
      })
    const entryKey = (entry: SearchMatch) => JSON.stringify([entry.path, entry.line, entry.text])
    const expectedKeys = new Set(wanted.map(entryKey))
    requireCondition(expectedKeys.size === expectedCount, 'Duplicate expected search entries.')
    actual = expected.kind === 'files' ? parseFiles(workspace, stdout) : parseMatches(workspace, stdout)
    requireCondition(actual.length === expectedCount && actual.every((entry) => expectedKeys.has(entryKey(entry))),
      'Search results differ from the exact expected set.')
  } catch (error) {
    errors.push(error instanceof Error ? error.message : 'Search output validation failed.')
  }
  return {
    kind: expected.kind,
    passed: errors.length === 0,
    output: evidence,
    expectedCount,
    actualCount: actual?.length ?? null,
    entries: (actual ?? []).slice(0, maxEvidenceEntries).map((entry) => ({
      path: entry.path.slice(0, 512),
      ...(expected.kind === 'matches' ? { line: entry.line, text: entry.text.slice(0, 512) } : {}),
      truncated: entry.path.length > 512 || entry.text.length > 512
    })),
    entriesTruncated: (actual?.length ?? 0) > maxEvidenceEntries,
    errors
  }
}
