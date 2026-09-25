import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { tool } from '@langchain/core/tools'
import { convertToOpenAITool } from '@langchain/core/utils/function_calling'
import { filePatchSchema, parseFilePatch, planFilePatch, resolveFilePatchTargets } from './filePatch'
import { applyContextTextPatch } from './contextPatch'
import { asPatchInput } from './filePatchTestFixtures'

const root = resolve('patch-fixture')
const path = join(root, '中文 name.txt')
const destination = join(root, 'new', 'moved.txt')
const temporary: string[] = []
const noNewline = '\\ No newline at end of file'

// Whole-file context fixture: no numeric hunk generation or legacy parser.
function hunks(before: string, after: string): string {
  const side = (text: string, prefix: string): string[] => {
    if (!text) return []
    const lines = text.replace(/\r\n/g, '\n').split('\n')
    if (text.endsWith('\n')) lines.pop()
    return [...lines.map((line) => prefix + line), ...(!text.endsWith('\n') ? [noNewline] : [])]
  }
  return ['@@', ...side(before, '-'), ...side(after, '+')].join('\n')
}

afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('context text patch', () => {
  it.each([
    ['', 'first\n'], ['first\n', ''], ['old', 'new'], ['old\n', 'new'],
    ['old', 'new\n'], ['a\nb\nc\n', 'a\nB\nc\n'],
    ['a\nb\nc\n', 'before\na\nb\nc\nafter\n'],
    ['重复\n重复\n', '重复\n修改\n'], ['a\r\nb\r\n', 'a\r\nB\r\n'],
    ['a\r\nb', 'a\r\nB'], ['\ufeff中文\n旧\n', '\ufeff中文\n新\n']
  ])('roundtrips file contents %j -> %j', (before, after) => {
    expect(applyContextTextPatch(before, hunks(before, after))).toBe(after)
  })

  it('preserves untouched mixed endings and uses the local ending for additions', () => {
    expect(applyContextTextPatch('a\r\nb\nc\r\n', '@@\n-b\n+B')).toBe('a\r\nB\nc\r\n')
    expect(applyContextTextPatch('a\r\nb\r\n', '@@\n-b\n+B')).toBe('a\r\nB\r\n')
  })

  it('locates shifted multiline context without asking the model for positions/counts', () => {
    expect(applyContextTextPatch('prefix\nold one\nold two\ntail\n', '@@\n-old one\n-old two\n+new\n+extra\n+third'))
      .toBe('prefix\nnew\nextra\nthird\ntail\n')
  })

  it('matches separated blocks against the original snapshot despite earlier size changes', () => {
    expect(applyContextTextPatch('one\ntwo\nthree\nfour\nfive\n', '@@\n-one\n+ONE\n+inserted\n@@\n-four\n-five\n+last'))
      .toBe('ONE\ninserted\ntwo\nthree\nlast\n')
  })

  it('rejects ambiguous context unless an exact anchor or EOF resolves it', () => {
    expect(() => applyContextTextPatch('same\nheading\nsame\n', '@@\n-same\n+new')).toThrow('ambiguous')
    expect(applyContextTextPatch('same\nheading\nsame\n', '@@ heading\n-same\n+new')).toBe('same\nheading\nnew\n')
    expect(applyContextTextPatch('same\nsame\n', '@@\n-same\n+new\n*** End of File')).toBe('same\nnew\n')
    expect(applyContextTextPatch('same\nsame', '@@\n-same\n' + noNewline + '\n+new\n' + noNewline)).toBe('same\nnew')
    expect(() => applyContextTextPatch('heading\nsame\nheading\nsame\n', '@@ heading\n-same\n+new')).toThrow('ambiguous')
  })

  it('supports append and anchored insertion with correct line separation', () => {
    expect(applyContextTextPatch('old', '@@\n+new')).toBe('old\nnew\n')
    expect(applyContextTextPatch('first\nlast\n', '@@ first\n+middle')).toBe('first\nmiddle\nlast\n')
    expect(applyContextTextPatch('first\nlast\n', '@@\n+before\n first')).toBe('before\nfirst\nlast\n')
  })

  it.each([
    '', 'explanation', '@@ -1,2 +1,3 @@\n-old\n+new',
    '--- a/file\n+++ b/file\n@@\n-old\n+new',
    '@@\n-old\n+new\nexplanation', '@@\n old',
    '@@\n-old\n+new\n\\ wrong marker',
    '@@\n-old\n+new\n*** End of File\n@@\n+extra',
    '@@\n-old\n+new\n@@\n-old\n+next',
    '@@\n-old\n\\ No newline at end of file\n-x\n\\ No newline at end of file\n+new'
  ])('rejects malformed or overlapping input %j', (patch) => {
    expect(() => applyContextTextPatch('old\n', patch)).toThrow()
  })

  it('does not trim whitespace or accept false EOF assertions', () => {
    expect(() => applyContextTextPatch(' old\n', '@@\n-old\n+new')).toThrow('Context not found')
    expect(() => applyContextTextPatch('old\n', '@@\n-old\n' + noNewline + '\n+new')).toThrow('no-newline assertion')
    expect(() => applyContextTextPatch('old\ntail\n', '@@\n-old\n+new\n' + noNewline)).toThrow('Context not found')
  })

  it('preserves a bare CR in an unterminated content line', () => {
    const input = { patch: '*** Begin Patch\n*** Update File: file\n@@\n-old\r\n' + noNewline + '\n+new\r\n' + noNewline + '\n*** End Patch' }
    const operation = parseFilePatch(input).operations[0]
    expect(operation.type).toBe('update')
    if (operation.type === 'update') expect(applyContextTextPatch('old\r', operation.patch)).toBe('new\r')
  })

  it.each(['', '\r'])('distinguishes CRLF patch framing from an unterminated content CR %j', (suffix) => {
    const patch = ['*** Begin Patch', '*** Update File: file', '@@', '-old' + suffix, noNewline,
      '+new' + suffix, noNewline, '*** End Patch'].join('\r\n')
    const operation = parseFilePatch({ patch }).operations[0]
    expect(operation.type).toBe('update')
    if (operation.type === 'update') expect(applyContextTextPatch('old' + suffix, operation.patch)).toBe('new' + suffix)
  })

  it.each([false, true])('accepts CRLF file sections including their final content or EOF line (%s)', (eof) => {
    const patch = ['*** Begin Patch', '*** Update File: file', '@@', '-old', '+new',
      ...(eof ? ['*** End of File'] : []), '*** End Patch'].join('\r\n')
    const operation = parseFilePatch({ patch }).operations[0]
    expect(operation.type).toBe('update')
    if (operation.type === 'update') expect(applyContextTextPatch('old\r\n', operation.patch)).toBe('new\r\n')
  })

  it('bounds input/output and rejects binary or invalid Unicode text', () => {
    expect(() => applyContextTextPatch('a'.repeat(1_000_001), '@@\n+a')).toThrow('exceeds')
    expect(() => applyContextTextPatch('old\0', '@@\n+a')).toThrow('UTF-8')
    expect(() => applyContextTextPatch('\ud800', '@@\n+a')).toThrow('UTF-8')
    expect(() => applyContextTextPatch('x'.repeat(1_000_000), '@@\n+more')).toThrow('exceeds')
  })

  it('handles many untouched lines without spreading arrays onto the stack', () => {
    const before = '\n'.repeat(150_000) + 'last\n'
    expect(applyContextTextPatch(before, '@@\n-last\n+LAST')).toBe('\n'.repeat(150_000) + 'LAST\n')
  })
})

describe('patch operation contract and complete batch planning', () => {
  it.each(['', '\r'])('does not include CRLF patch framing in an unterminated added file %j', (suffix) => {
    const patch = ['*** Begin Patch', '*** Add File: file', '+new' + suffix, noNewline, '*** End Patch'].join('\r\n')
    expect(parseFilePatch({ patch }).operations).toEqual([{ type: 'create', path: 'file', content: 'new' + suffix }])
  })
  it('parses all file sections and preserves new-file BOM, CRLF and EOF state', () => {
    const input = asPatchInput({ operations: [
      { type: 'create', path, content: '\ufeff中文\r\n' },
      { type: 'create', path: 'empty', content: '' },
      { type: 'create', path: 'no-newline', content: 'last' },
      { type: 'update', path: 'update', patch: '@@\n-old\n+new' },
      { type: 'move', path: 'from', destination: 'to' },
      { type: 'delete', path: 'remove' }
    ] })
    expect(parseFilePatch(input).operations).toEqual([
      { type: 'create', path, content: '\ufeff中文\r\n' },
      { type: 'create', path: 'empty', content: '' },
      { type: 'create', path: 'no-newline', content: 'last' },
      { type: 'update', path: 'update', patch: '@@\n-old\n+new' },
      { type: 'move', path: 'from', destination: 'to' },
      { type: 'delete', path: 'remove' }
    ])
  })

  it.each([
    '', '*** Begin Patch\n*** End Patch',
    '```\n*** Begin Patch\n*** Delete File: x\n*** End Patch\n```',
    '*** Begin Patch\n*** Add File: x\nmissing plus\n*** End Patch',
    '*** Begin Patch\n*** Update File: x\n@@ -1 +1 @@\n-old\n+new\n*** End Patch',
    '*** Begin Patch\n*** Move File: x\n*** End Patch',
    '*** Begin Patch\n*** Update File: x\n*** End Patch',
    '*** Begin Patch\n*** Delete File: x\nextra\n*** End Patch'
  ])('rejects malformed file envelopes %j', (patch) => {
    expect(() => parseFilePatch({ patch })).toThrow()
  })

  it('reports the failing file and edit block without writing earlier plans', () => {
    expect(() => planFilePatch({ operations: [
      { type: 'create', path, content: 'valid' },
      { type: 'update', path: destination, patch: '@@\n-absent\n+new' }
    ] }, new Map([[path, null], [destination, 'actual\n']]))).toThrow(/moved.txt.*operation 2.*Edit block 1/)
  })

  it('resolves dry runs as reads and actual patches as writes', async () => {
    for (const dry_run of [true, false]) {
      const result = await resolveFilePatchTargets({ patch: '*** Begin Patch\n*** Update File: from.txt\n*** Move to: to.txt\n*** End Patch', dry_run }, root)
      expect(result.targets.map((target) => target.access)).toEqual([dry_run ? 'read' : 'write', dry_run ? 'read' : 'write'])
    }
  })
  it('uses a normal JSON tool schema with one patch document and no legacy operations', () => {
    const definition = convertToOpenAITool(tool(async () => 'not executed', { name: 'apply_patch', description: 'Apply text edits.', schema: filePatchSchema }))
    expect(definition.function.name).toBe('apply_patch')
    const schema = JSON.stringify(definition.function.parameters)
    expect(schema).toContain('patch')
    expect(schema).not.toContain('"operations"')
    expect(schema).not.toContain('"destination"')
  })

  it('plans all four operations without writing or mutating input/snapshots', () => {
    const update = join(root, 'update.txt')
    const remove = join(root, 'delete.txt')
    const input = { operations: [
      { type: 'create', path, content: '' },
      { type: 'update', path: update, patch: hunks('old\n', 'new\n') },
      { type: 'delete', path: remove },
      { type: 'move', path: join(root, 'from.txt'), destination, patch: hunks('move\n', 'moved\n') }
    ], dry_run: true }
    const originalInput = structuredClone(input)
    const snapshots = new Map<string, string | null>([
      [path, null], [update, 'old\n'], [remove, ''], [join(root, 'from.txt'), 'move\n'], [destination, null]
    ])
    const originalSnapshots = new Map(snapshots)
    expect(planFilePatch(input, snapshots)).toEqual([
      { operationIndex: 0, path, beforeText: null, afterText: '' },
      { operationIndex: 1, path: update, beforeText: 'old\n', afterText: 'new\n' },
      { operationIndex: 2, path: remove, beforeText: '', afterText: null },
      { operationIndex: 3, path: join(root, 'from.txt'), beforeText: 'move\n', afterText: null },
      { operationIndex: 3, path: destination, beforeText: null, afterText: 'moved\n' }
    ])
    expect(input).toEqual(originalInput)
    expect(snapshots).toEqual(originalSnapshots)
  })

  it('plans a pure rename including empty content', () => {
    expect(planFilePatch({ operations: [{ type: 'move', path, destination }] }, new Map([[path, ''], [destination, null]])))
      .toEqual([
        { operationIndex: 0, path, beforeText: '', afterText: null },
        { operationIndex: 0, path: destination, beforeText: null, afterText: '' }
      ])
  })

  it.each([
    [{ type: 'create', path, content: 'new' }, 'old', 'already exists'],
    [{ type: 'delete', path }, null, 'does not exist'],
    [{ type: 'update', path, patch: hunks('old\n', 'new\n') }, null, 'does not exist'],
    [{ type: 'move', path, destination }, null, 'does not exist']
  ])('rejects target existence conflicts: %j', (operation, before, error) => {
    expect(() => planFilePatch({ operations: [operation] }, new Map([[path, before as string | null]]))).toThrow(error as string)
  })

  it('rejects missing snapshots and occupied move destinations', () => {
    expect(() => planFilePatch({ operations: [{ type: 'delete', path }] }, new Map())).toThrow('snapshot is missing')
    expect(() => planFilePatch({ operations: [{ type: 'move', path, destination }] }, new Map([[path, ''], [destination, '']])))
      .toThrow('destination already exists')
  })

  it.each([
    [{ type: 'delete', path }, { type: 'create', path, content: '' }],
    [{ type: 'move', path, destination: path }],
    [{ type: 'move', path, destination }, { type: 'delete', path: destination }],
    [{ type: 'create', path, content: '' }, { type: 'create', path: join(path, 'child'), content: '' }],
    [{ type: 'create', path, content: '' }, { type: 'create', path: join(path, '..child'), content: '' }]
  ])('rejects repeated, nested, and chained targets: %j', (...operations) => {
    expect(() => planFilePatch({ operations }, new Map())).toThrow('overlap')
  })

  it('rejects unsupported schema fields and resource excess before planning', () => {
    for (const input of [
      { operations: [] }, { operations: [{ type: 'shell', path }] },
      { operations: [{ type: 'delete', path, recursive: true }] },
      { operations: [{ type: 'create', path, content: '中'.repeat(400_000) }] },
      { operations: Array.from({ length: 21 }, () => ({ type: 'delete', path })) },
      { operations: [{ type: 'delete', path: 'bad\0path' }] },
      { operations: [{ type: 'create', path, content: '' }], force: true },
      { operations: Array.from({ length: 5 }, (_, index) => ({ type: 'create', path: `${path}${index}`, content: 'a'.repeat(900_000) })) }
    ]) expect(() => planFilePatch(input, new Map())).toThrow()
    expect(() => parseFilePatch({ operations: [{ type: 'delete', path }] })).toThrow()
  })

  it('bounds the combined source snapshots and expanded output', () => {
    const snapshots = new Map(Array.from({ length: 5 }, (_, index) => [`${path}${index}`, 'a'.repeat(900_000)]))
    expect(() => planFilePatch({ operations: [...snapshots.keys()].map((path) => ({ type: 'delete', path })) }, snapshots))
      .toThrow('snapshots exceed')
  })

  it('resolves all source/destination paths without changing the supplied input', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'anas-patch-paths-')))
    temporary.push(directory)
    const input = asPatchInput({ operations: [{ type: 'move', path: 'from.txt', destination: 'new/to.txt' }] })
    const original = structuredClone(input)
    const result = await resolveFilePatchTargets(input, directory)
    expect(result.targets).toEqual([
      expect.objectContaining({ operationIndex: 0, field: 'path', canonicalPath: join(directory, 'from.txt'), semantics: 'entry' }),
      expect.objectContaining({ operationIndex: 0, field: 'destination', canonicalPath: join(directory, 'new', 'to.txt'), access: 'write' })
    ])
    expect(input).toEqual(original)
    expect(result.input.operations[0].path).toBe(join(directory, 'from.txt'))
  })

  it('rejects aliased targets through a linked parent', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'anas-patch-alias-'))
    temporary.push(directory)
    await mkdir(join(directory, 'real'))
    await symlink(join(directory, 'real'), join(directory, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(resolveFilePatchTargets(asPatchInput({ operations: [
      { type: 'create', path: 'real/file.txt', content: '' },
      { type: 'create', path: 'link/file.txt', content: '' }
    ] }), directory)).rejects.toThrow('overlap')
  })
})
