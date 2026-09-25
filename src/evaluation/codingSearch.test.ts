import { createHash } from 'node:crypto'
import { join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkSearchOutput, type SearchExpectation } from './codingSearch'

const workspace = resolve('search oracle fixture')
const owner = '模块 空格/owner.mjs'
const sibling = 'src/other.mjs'
const files: SearchExpectation = { kind: 'files', paths: [owner, sibling] }
const matches = [{ path: owner, line: 7, text: 'export const owner = "SEARCH_OWNER_MARKER";\n' }]
const expected: SearchExpectation = { kind: 'matches', matches }
const elapsed = { secs: 0, nanos: 123, human: '0.000000s' }
const stats = (matchedLines: number, count: number, searches = 1) => ({
  elapsed, searches, searches_with_match: searches, bytes_searched: 1000, bytes_printed: 1000, matched_lines: matchedLines, matches: count
})
const encode = (records: unknown[]) => records.map((item) => JSON.stringify(item)).join('\n') + '\n'

function rgRecords(entries = matches) {
  const records: Array<{ type: string; data: Record<string, unknown> }> = []
  const paths = [...new Set(entries.map((entry) => entry.path))]
  let totalLines = 0
  for (const path of paths) {
    const group = entries.filter((entry) => entry.path === path)
    let fileLines = 0
    records.push({ type: 'begin', data: { path: { text: path } } })
    for (const entry of group) {
      const matchText = entry.text.replace(/\r?\n$/, '')
      fileLines += entry.text.replace(/\r?\n$/, '').split('\n').length
      records.push({ type: 'match', data: {
        path: { text: path }, lines: { text: entry.text }, line_number: entry.line, absolute_offset: 0,
        submatches: [{ match: { text: matchText }, start: 0, end: Buffer.byteLength(matchText) }]
      } })
    }
    totalLines += fileLines
    records.push({ type: 'end', data: { path: { text: path }, binary_offset: null, stats: stats(fileLines, group.length) } })
  }
  records.push({ type: 'summary', data: { elapsed_total: elapsed, stats: stats(totalLines, entries.length, paths.length) } })
  return records
}

function envelope(stdout: string, changes: Record<string, unknown> = {}) {
  return {
    ok: true, command: 'rg --json SEARCH_OWNER_MARKER .', workingDir: workspace, timeoutSec: 0,
    exitCode: 0, signal: null, timedOut: false, aborted: false, stdout, stderr: '',
    truncated: { stdout: false, stderr: false }, ...changes
  }
}

describe('coding search output oracle', () => {
  it('checks unordered complete file sets with native relative and absolute paths', () => {
    for (const paths of [[sibling, owner], [join(workspace, owner), join(workspace, sibling)],
      [`.${sep}${owner.split('/').join(sep)}`, sibling.split('/').join(sep)]]) {
      expect(checkSearchOutput(workspace, paths.join('\r\n') + '\r\n', files)).toMatchObject({ passed: true, actualCount: 2 })
    }
    expect(checkSearchOutput(workspace, '', { kind: 'files', paths: [] }).passed).toBe(true)
  })

  it.each([
    ['missing', [owner]],
    ['additional', [owner, sibling, 'extra.mjs']],
    ['duplicate', [owner, sibling, owner]],
    ['normalized duplicate', [owner, sibling, `./${owner}`]],
    ['blank record', [owner, '', sibling]]
  ])('rejects %s file records', (_name, paths) => {
    expect(checkSearchOutput(workspace, paths.join('\n') + '\n', files).passed).toBe(false)
  })

  it.each(['../outside.mjs', join(workspace, '..', 'outside.mjs'), workspace, '\0invalid'])('rejects file path outside the fixture or invalid: %s', (path) => {
    expect(checkSearchOutput(workspace, path + '\n', { kind: 'files', paths: [owner] }).passed).toBe(false)
    expect(checkSearchOutput(workspace, encode(rgRecords([{ ...matches[0], path }])), expected).passed).toBe(false)
  })

  it('accepts complete native rg JSON records and exact line text on native paths', () => {
    for (const path of [owner, join(workspace, owner), `.${sep}${owner.split('/').join(sep)}`]) {
      expect(checkSearchOutput(workspace, encode(rgRecords([{ ...matches[0], path }])), expected))
        .toMatchObject({ passed: true, actualCount: 1, entries: [{ path: owner, line: 7, text: matches[0].text, truncated: false }] })
    }
    const reordered = { text: matches[0].text, line: 7, path: owner }
    expect(checkSearchOutput(workspace, encode(rgRecords()), { kind: 'matches', matches: [reordered] }).passed).toBe(true)
  })

  it('does not misclassify a native one-line JSON summary as a Shell envelope', () => {
    expect(checkSearchOutput(workspace, encode(rgRecords([])), { kind: 'matches', matches: [] }))
      .toMatchObject({ passed: true, actualCount: 0 })
  })

  it.each([
    ['missing match', []],
    ['additional match', [...matches, { path: sibling, line: 1, text: matches[0].text }]],
    ['duplicate match', [...matches, ...matches]],
    ['incorrect line', [{ ...matches[0], line: 8 }]],
    ['incorrect text', [{ ...matches[0], text: 'SEARCH_OWNER_MARKER but incorrect content\n' }]],
    ['missing line terminator', [{ ...matches[0], text: matches[0].text.trimEnd() }]],
    ['incorrect path', [{ ...matches[0], path: sibling }]]
  ])('rejects %s even when marker text is present elsewhere', (_name, entries) => {
    expect(checkSearchOutput(workspace, encode(rgRecords(entries)), expected).passed).toBe(false)
  })

  it('requires complete begin/match/end/summary structure', () => {
    const records = rgRecords()
    for (const invalid of [records.slice(1), records.slice(0, -1), records.filter((item) => item.type !== 'end'),
      [records[0], records[0], ...records.slice(1)], [...records, records.at(-1)], [records[1], records[0], ...records.slice(2)]]) {
      expect(checkSearchOutput(workspace, encode(invalid), expected).passed).toBe(false)
    }
    for (const output of [encode(records).slice(0, -20), encode(records) + 'diagnostic warning\n',
      encode(records).replace('\n', '\n\n'), 'SEARCH_OWNER_MARKER\n', '{"type":"summary","data":{}}\n']) {
      expect(checkSearchOutput(workspace, output, expected).passed).toBe(false)
    }
  })

  it.each([
    ['bytes path', { path: { bytes: Buffer.from(owner).toString('base64') } }],
    ['mixed path encoding', { path: { text: owner, bytes: '' } }],
    ['bytes lines', { lines: { bytes: 'YWJj' } }],
    ['invalid line', { line_number: 0 }],
    ['fractional line', { line_number: 1.5 }],
    ['missing offset', { absolute_offset: undefined }],
    ['missing submatches', { submatches: [] }],
    ['bad submatch offsets', { submatches: [{ match: { text: 'x' }, start: -1, end: 1 }] }],
    ['bad submatch text', { submatches: [{ match: { text: 'x' }, start: 0, end: 1 }] }]
  ])('rejects malformed JSON match data: %s', (_name, changes) => {
    const records = rgRecords()
    Object.assign(records[1].data, changes)
    expect(checkSearchOutput(workspace, encode(records), expected).passed).toBe(false)
  })

  it('rejects invalid summary counts, incomplete end statistics, and binary results', () => {
    for (const [index, changes] of [
      [3, { stats: stats(1, 2) }], [3, { elapsed_total: null }],
      [2, { stats: {} }], [2, { binary_offset: 100 }]
    ] as const) {
      const records = rgRecords()
      Object.assign(records[index].data, changes)
      expect(checkSearchOutput(workspace, encode(records), expected).passed).toBe(false)
    }
  })

  it('accepts only explicitly successful clean Shell envelopes as objects or JSON', () => {
    const stdout = encode(rgRecords())
    expect(checkSearchOutput(workspace, envelope(stdout), expected).passed).toBe(true)
    expect(checkSearchOutput(workspace, JSON.stringify(envelope(stdout)), expected).passed).toBe(true)
    expect(checkSearchOutput(workspace, envelope(''), { kind: 'files', paths: [] }).passed).toBe(true)
  })

  it.each([
    ['failure', { ok: false }], ['missing ok', { ok: undefined }], ['nonzero exit', { exitCode: 1 }],
    ['missing exit', { exitCode: undefined }], ['null exit', { exitCode: null }], ['stderr', { stderr: 'warning' }],
    ['error', { error: 'failed' }], ['timeout', { timedOut: true }], ['abort', { aborted: true }],
    ['signal', { signal: 'SIGTERM' }], ['stdout truncated', { truncated: { stdout: true, stderr: false } }],
    ['stderr truncated', { truncated: { stdout: false, stderr: true } }], ['invalid truncation', { truncated: true }]
  ])('rejects %s envelope even with exact valid stdout and command markers', (_name, changes) => {
    expect(checkSearchOutput(workspace, JSON.stringify(envelope(encode(rgRecords()), changes)), expected).passed).toBe(false)
    expect(checkSearchOutput(workspace, JSON.stringify(envelope(`${owner}\n${sibling}\n`, changes)), files).passed).toBe(false)
  })

  it('does not accept a failed envelope that contains expected filenames only in the command', () => {
    const output = JSON.stringify(envelope('', { ok: false, exitCode: 2, command: `rg --files ${owner} ${sibling}` }))
    expect(checkSearchOutput(workspace, output, files).passed).toBe(false)
  })

  it('checks full output beyond the diagnostic excerpt and fingerprints all of it', () => {
    const longText = 'p'.repeat(4500) + 'SEARCH_OWNER_MARKER\n'
    const longMatches = [{ ...matches[0], text: longText }]
    const stdout = encode(rgRecords(longMatches))
    const result = checkSearchOutput(workspace, stdout, { kind: 'matches', matches: longMatches })
    expect(result).toMatchObject({ passed: true, output: {
      characters: stdout.length, fingerprint: createHash('sha256').update(stdout).digest('hex'), truncated: true
    }, entries: [{ text: longText.slice(0, 512), truncated: true }] })
    expect(result.output.excerpt).toHaveLength(4000)
    expect(result.output.excerpt).not.toContain('SEARCH_OWNER_MARKER')
    const changed = stdout.replaceAll('SEARCH_OWNER_MARKER', 'SEARCH_OTHER_MARKER')
    const invalid = checkSearchOutput(workspace, changed, { kind: 'matches', matches: longMatches })
    expect(invalid.passed).toBe(false)
    expect(invalid.output.excerpt).toBe(result.output.excerpt)
    expect(invalid.output.fingerprint).not.toBe(result.output.fingerprint)
  })

  it('bounds parsed evidence and rejects stdout above the Shell character limit', () => {
    const paths = Array.from({ length: 80 }, (_, index) => `src/file-${index}.mjs`)
    const result = checkSearchOutput(workspace, paths.join('\n') + '\n', { kind: 'files', paths })
    expect(result).toMatchObject({ passed: true, actualCount: 80, entriesTruncated: true })
    expect(result.entries).toHaveLength(32)
    const oversized = checkSearchOutput(workspace, 'x'.repeat(120_001), files)
    expect(oversized.passed).toBe(false)
    expect(oversized.errors).toEqual(['Shell stdout character budget exceeded.'])
  })
})
