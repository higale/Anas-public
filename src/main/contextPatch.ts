import { maxPatchInputBytes } from './fileEditDiff'

export type ContextPatchOperation =
  | { type: 'create'; path: string; content: string }
  | { type: 'update'; path: string; patch: string }
  | { type: 'delete'; path: string }
  | { type: 'move'; path: string; destination: string; patch?: string }

interface ContextHunk {
  anchor?: string
  lines: string[]
  oldLines: string[]
  oldNoNewline: boolean
  newNoNewline: boolean
  eof: boolean
}

const noNewline = '\\ No newline at end of file'
const maxPatchLines = 100_000

function withoutFramingCR(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

function patchLines(text: string): string[] {
  // A file section extracted from a CRLF document may end in CR with its LF
  // outside the section. Normalize control lines independently of that LF.
  const lines = text.split('\n').map(withoutFramingCR)
  if (lines.at(-1) === '') lines.pop()
  if (lines.length > maxPatchLines) throw new Error(`Patch exceeds ${maxPatchLines} lines.`)
  return lines
}

function syntaxError(line: number, message: string): never {
  throw new Error(`Patch line ${line}: ${message}`)
}

/** Model-facing file envelope; the transaction layer receives typed operations,
 * never reparses a second model protocol or executes patch text as a command. */
export function parseContextPatchDocument(text: string): ContextPatchOperation[] {
  const lines = patchLines(text)
  const rawLines = text.split('\n')
  if (lines[0] !== '*** Begin Patch') syntaxError(1, 'Start with *** Begin Patch; do not include Markdown fences.')
  if (lines.at(-1) !== '*** End Patch') syntaxError(lines.length, 'Finish with *** End Patch.')
  const operations: ContextPatchOperation[] = []
  let cursor = 1
  while (cursor < lines.length - 1) {
    const headerLine = cursor + 1
    const header = /^\*\*\* (Add|Update|Delete) File: (.+)$/.exec(lines[cursor++])
    if (!header) syntaxError(headerLine, 'Expected *** Add File:, *** Update File:, or *** Delete File: followed by a path.')
    const [, kind, path] = header
    if (kind === 'Delete') {
      operations.push({ type: 'delete', path })
      continue
    }
    let destination: string | undefined
    if (kind === 'Update' && lines[cursor]?.startsWith('*** Move to: ')) destination = lines[cursor++].slice(13)
    const bodyStart = cursor
    const body: string[] = []
    while (cursor < lines.length - 1 && !/^\*\*\* (?:Add|Update|Delete) File: /.test(lines[cursor])) body.push(lines[cursor++])
    try {
      if (kind === 'Add') {
        let endsWithNewline = true
        if (body.at(-1) === noNewline) { body.pop(); endsWithNewline = false }
        if (body.some((line) => !line.startsWith('+')) || (!body.length && !endsWithNewline)) {
          throw new Error('Every added content line must start with +; only the final line may have a no-newline marker.')
        }
        // Content CRs belong to the new file; only control lines are normalized.
        const contentLines = rawLines.slice(bodyStart, bodyStart + body.length).map((line) => line.slice(1))
        if (!endsWithNewline && rawLines[0].endsWith('\r')) {
          contentLines[contentLines.length - 1] = withoutFramingCR(contentLines[contentLines.length - 1])
        }
        const content = contentLines.join('\n')
        operations.push({ type: 'create', path, content: content + (body.length && endsWithNewline ? '\n' : '') })
      } else {
        const patch = rawLines.slice(bodyStart, bodyStart + body.length).join('\n')
        if (body.length) parseContextHunks(patch)
        else if (destination === undefined) throw new Error('An Update File section needs at least one @@ edit block.')
        operations.push(destination !== undefined ? { type: 'move', path, destination, ...(body.length ? { patch } : {}) } : { type: 'update', path, patch })
      }
    } catch (error) {
      throw new Error(`File ${JSON.stringify(path)} (section at patch line ${headerLine}): ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (!operations.length) throw new Error('Patch must contain at least one file operation.')
  return operations
}

export function parseContextHunks(patch: string): ContextHunk[] {
  const lines = patchLines(patch)
  const rawLines = patch.split('\n')
  const crlfFraming = rawLines[0].endsWith('\r')
  const hunks: ContextHunk[] = []
  let cursor = 0
  while (cursor < lines.length) {
    const header = lines[cursor++]
    if (/^@@ -\d/.test(header)) syntaxError(cursor, 'Do not calculate line numbers. Use @@ or @@ <exact anchor line>.')
    const match = /^@@(?: (.+))?$/.exec(header)
    if (!match) syntaxError(cursor, 'Expected @@ or @@ <exact anchor line>, without numeric ranges or file headers.')
    const hunk: ContextHunk = { anchor: match[1], lines: [], oldLines: [], oldNoNewline: false, newNoNewline: false, eof: false }
    let added = 0, removed = 0, newCount = 0
    let oldMarkerAt: number | undefined, newMarkerAt: number | undefined
    while (cursor < lines.length && !lines[cursor].startsWith('@@')) {
      // With LF framing a marked content CR is literal. With CRLF framing
      // remove only its separator CR, retaining any preceding literal CR.
      let line = lines[cursor]
      if (lines[cursor + 1] === noNewline && /^[ +-]/.test(line)) {
        line = crlfFraming ? withoutFramingCR(rawLines[cursor]) : rawLines[cursor]
      }
      cursor++
      if (line === '*** End of File') {
        hunk.eof = true
        if (cursor !== lines.length) syntaxError(cursor, '*** End of File must finish the last edit block for this file.')
        break
      }
      if (line === noNewline) {
        const previous = hunk.lines.at(-1)
        if (!previous || previous === noNewline) syntaxError(cursor, 'A no-newline marker must follow a content line.')
        if (previous[0] !== '+') {
          if (oldMarkerAt !== undefined) syntaxError(cursor, 'Duplicate old-content no-newline marker.')
          oldMarkerAt = hunk.oldLines.length
        }
        if (previous[0] !== '-') {
          if (newMarkerAt !== undefined) syntaxError(cursor, 'Duplicate new-content no-newline marker.')
          newMarkerAt = newCount
        }
      } else {
        if (!/^[ +-]/.test(line)) syntaxError(cursor, 'Content lines must begin with a space (context), + (add), or - (remove).')
        if (line[0] !== '+') hunk.oldLines.push(line.slice(1))
        if (line[0] !== '-') newCount++
        if (line[0] === '+') added++
        if (line[0] === '-') removed++
      }
      hunk.lines.push(line)
    }
    if (!added && !removed) syntaxError(cursor, 'Edit block contains no additions or removals.')
    if ((oldMarkerAt !== undefined && oldMarkerAt !== hunk.oldLines.length)
      || (newMarkerAt !== undefined && newMarkerAt !== newCount)) syntaxError(cursor, 'A no-newline marker may only describe the last content line.')
    hunk.oldNoNewline = oldMarkerAt !== undefined
    hunk.newNoNewline = newMarkerAt !== undefined
    hunks.push(hunk)
    if (hunks.length > 1000) throw new Error('Patch exceeds 1000 edit blocks.')
  }
  if (!hunks.length) throw new Error('Patch needs at least one @@ edit block.')
  return hunks
}

interface TextLine { text: string; ending: string }

function sourceLines(source: string): TextLine[] {
  return (source.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((line) => {
    const ending = line.endsWith('\r\n') ? '\r\n' : line.endsWith('\n') ? '\n' : ''
    return { text: ending ? line.slice(0, -ending.length) : line, ending }
  })
}

/** Locate exact complete lines, not numeric ranges. The newline-framed index
 * delegates searching to the runtime string implementation and detects a second
 * match before applying anything. All blocks refer to the same source snapshot. */
export function applyContextTextPatch(source: string, patch: string): string {
  for (const text of [source, patch]) {
    const buffer = Buffer.from(text, 'utf8')
    if (buffer.length > maxPatchInputBytes) throw new Error(`Patch text exceeds ${maxPatchInputBytes} bytes.`)
    if (text.includes('\0') || buffer.toString('utf8') !== text) throw new Error('Patch requires valid UTF-8 text without NUL.')
  }
  const lines = sourceLines(source)
  const offsets: number[] = []
  let length = 0
  for (const line of lines) { offsets.push(length); length += line.text.length + 1 }
  offsets.push(length)
  const lineAtOffset = new Map(offsets.map((offset, index) => [offset, index]))
  const haystack = '\n' + lines.map((line) => line.text).join('\n') + (lines.length ? '\n' : '')
  const defaultEnding = lines.find((line) => line.ending)?.ending ?? '\n'
  const hunks = parseContextHunks(patch)
  const result: TextLine[] = []
  let cursor = 0, searchBudget = 64_000_000
  const locate = (pattern: string[], start: number, eof: boolean): number => {
    if (!pattern.length) return eof ? lines.length : start
    const needle = '\n' + pattern.join('\n') + '\n'
    searchBudget -= haystack.length - offsets[start]
    if (searchBudget < 0) throw new Error('Context search budget exceeded; split the edit into smaller batches.')
    const from = eof ? haystack.length - needle.length : offsets[start]
    const first = from < offsets[start] ? -1 : haystack.indexOf(needle, from)
    if (first < 0 || (eof && first + needle.length !== haystack.length)) {
      throw new Error(`Context not found. Expected lines:\n${pattern.join('\n').slice(0, 1200)}\nRead the current file and copy exact context.`)
    }
    if (!eof && haystack.indexOf(needle, first + 1) >= 0) {
      throw new Error(`Context is ambiguous (multiple matches). Add surrounding lines or a unique @@ anchor. Expected lines:\n${pattern.join('\n').slice(0, 1200)}`)
    }
    return lineAtOffset.get(first)!
  }
  for (const [index, hunk] of hunks.entries()) {
    try {
      let start = cursor
      if (hunk.anchor !== undefined) start = locate([hunk.anchor], start, false) + 1
      // Without old content or an anchor, additions have one explicit meaning:
      // append at EOF. Inserting elsewhere requires surrounding context.
      if (!hunk.oldLines.length && hunk.anchor === undefined) start = lines.length
      start = locate(hunk.oldLines, start, hunk.eof || hunk.oldNoNewline || hunk.newNoNewline)
      const end = start + hunk.oldLines.length
      if ((hunk.oldNoNewline || hunk.newNoNewline) && (end !== lines.length || index !== hunks.length - 1)) {
        throw new Error('A no-newline marker must describe the end of the file.')
      }
      if (hunk.oldNoNewline && (!hunk.oldLines.length || lines[end - 1].ending !== '')) {
        throw new Error('The old no-newline assertion does not match the current file.')
      }
      for (let i = cursor; i < start; i++) result.push(lines[i])
      let oldOffset = start
      const inserted: TextLine[] = []
      const ending = lines[start]?.ending || defaultEnding
      for (const line of hunk.lines) {
        if (line === noNewline) continue
        if (line[0] === ' ') inserted.push({ ...lines[oldOffset++] })
        else if (line[0] === '-') oldOffset++
        else inserted.push({ text: line.slice(1), ending })
      }
      if (hunk.newNoNewline && inserted.length) inserted[inserted.length - 1].ending = ''
      for (const line of inserted) result.push(line)
      cursor = end
    } catch (error) {
      throw new Error(`Edit block ${index + 1}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (let i = cursor; i < lines.length; i++) result.push(lines[i])
  // Appending after an unterminated line necessarily creates its separator.
  const output = result.map((line, index) => line.text + (line.ending || (index < result.length - 1 ? defaultEnding : ''))).join('')
  if (Buffer.byteLength(output, 'utf8') > maxPatchInputBytes) throw new Error(`Patch output exceeds ${maxPatchInputBytes} bytes.`)
  return output
}
