import { applyPatch, parsePatch } from 'diff'
import { describe, expect, it } from 'vitest'
import { createTextPatch } from './fileEditDiff'
import { join, resolve } from 'node:path'

describe('file edit diffs', () => {
  it('counts complete added and removed lines even when the displayed patch is truncated', () => {
    const result = createTextPatch({ path: 'one', beforeText: 'one\ntwo\n', afterText: 'three\nfour\nfive\n', beforeExists: true, maxChars: 10 })
    expect(result).toMatchObject({ addedLines: 3, removedLines: 2, patchTruncated: true })
    expect(result.patch.length).toBeLessThanOrEqual(10)
  })
  it('keeps distinct absolute paths for same-named external files', () => {
    const baseDirectory = resolve('project')
    for (const directory of ['external-a', 'external-b']) {
      const path = resolve(directory, 'index.ts')
      const result = createTextPatch({ path, baseDirectory, beforeText: 'old', afterText: 'new', beforeExists: true })
      expect(result.patch).toContain(path.replace(/\\/g, '/'))
    }
    const inside = createTextPatch({ path: join(baseDirectory, 'src', 'index.ts'), baseDirectory, beforeText: 'old', afterText: 'new', beforeExists: true })
    expect(inside.patch).toContain('a/src/index.ts')
  })

  it.each([
    { beforeExists: false, afterExists: true, flag: 'isCreate', header: 'new file mode' },
    { beforeExists: true, afterExists: false, flag: 'isDelete', header: 'deleted file mode' }
  ])('records empty-file lifecycle changes: $header', ({ beforeExists, afterExists, flag, header }) => {
    const result = createTextPatch({ path: 'empty.txt', beforeText: '', afterText: '', beforeExists, afterExists })
    expect(result).toMatchObject({ patchAvailable: true, patchTruncated: false })
    expect(result.patch).toContain(header)
    expect(parsePatch(result.patch)).toEqual([expect.objectContaining({ [flag]: true, hunks: [] })])
  })

  it.each([
    { beforeExists: true, afterExists: true, content: '' },
    { beforeExists: true, afterExists: true, content: 'unchanged\n' },
    { beforeExists: false, afterExists: false, content: '' }
  ])('returns no diff only when both content and existence are unchanged: %j', ({ beforeExists, afterExists, content }) => {
    expect(createTextPatch({ path: 'same.txt', beforeText: content, afterText: content, beforeExists, afterExists }))
      .toMatchObject({ patchAvailable: true, patch: '', patchTruncated: false })
  })

  it.each([
    { name: 'LF', before: 'one\ntwo\n', after: 'one\nTWO\n' },
    { name: 'CRLF', before: 'one\r\ntwo\r\n', after: 'one\r\nTWO\r\n' },
    { name: 'no final newline', before: 'one\ntwo', after: 'one\nTWO' },
    { name: 'Unicode', before: '标题\n旧内容\n', after: '标题\n新内容\n' }
  ])('preserves text changes for $name', ({ before, after }) => {
    const result = createTextPatch({ path: '中文 name.txt', beforeText: before, afterText: after, beforeExists: true })
    expect(result).toMatchObject({ patchAvailable: true, patchTruncated: false })
    expect(applyPatch(before, result.patch, { fuzzFactor: 0, autoConvertLineEndings: false })).toBe(after)
  })

  it('keeps bounded output for lifecycle-only diffs', () => {
    const result = createTextPatch({
      path: 'empty.txt', beforeText: '', afterText: '', beforeExists: false, maxChars: 30
    })
    expect(result.patchTruncated).toBe(true)
    expect(result.patch.length).toBeLessThanOrEqual(30)
  })
})
