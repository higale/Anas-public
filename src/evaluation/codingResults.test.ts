import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { AIMessage, ToolMessage } from '@langchain/core/messages'
import type { CodeReviewReport, CodeReviewSnapshot } from '@shared/codeReview'
import { codingTasks } from './codingTasks'
import { changedSources, checkModelRequest, checkTaskFiles, fixturePath, scoreReview, scriptBinding, snapshotFiles, sourceFingerprints, toolOutputFailed, toolResultsFromMessages, writeFixture } from './codingResults'
import { runBehaviorTests } from './codingBehavior'

const sumTask = codingTasks.find((task) => task.id === 'empty-sum')!

describe('coding evaluation oracles', () => {
  it('binds references from paired successful native tool results in the current input', () => {
    const pair = (name: string, id: string, output: unknown, failed = false) => [
      new AIMessage({ content: '', tool_calls: [{ name, id, args: {} }] }),
      new ToolMessage({ content: JSON.stringify(output), name, tool_call_id: id, status: failed ? 'error' : 'success' })
    ]
    const first = pair('apply_patch', 'patch-one', { ok: true, operationId: 'one', recoveryRequestId: 'restore-one' })
    const second = pair('apply_patch', 'patch-two', { ok: true, operationId: 'two', recoveryRequestId: 'restore-two' })
    const unrelated = pair('read_file', 'read', { ok: true, operationId: 'wrong', recoveryRequestId: 'wrong', subagent_id: 'wrong' })
    expect(scriptBinding([...first, ...second, ...unrelated], 'patch')).toEqual({ operation_id: 'two', request_id: 'restore-two' })
    expect(scriptBinding([...first, ...unrelated], 'patch')).toEqual({ operation_id: 'one', request_id: 'restore-one' })
    expect(() => scriptBinding(unrelated, 'patch')).toThrow('current model input')
    expect(() => scriptBinding(second.slice(1), 'patch')).toThrow('current model input')
    expect(() => scriptBinding(pair('start_subagent', 'child', { ok: true, subagent_id: 'child-id' }, true), 'subagent')).toThrow('current model input')
    expect(scriptBinding([...pair('start_subagent', 'child', { ok: true, subagent_id: 'child-id' }), ...unrelated], 'subagent'))
      .toEqual({ subagent_id: 'child-id' })
    const mismatched = [first[0], new ToolMessage({ content: '{}', tool_call_id: 'patch-one', name: 'read_file' })]
    expect(toolResultsFromMessages(mismatched)).toEqual([])
    expect(toolResultsFromMessages(pair('apply_patch', 'disabled', 'Unavailable tool', true))[0].failed).toBe(true)
  })
  it('requires actual bound-tool evidence for both inclusion and exclusion checks', async () => {
    const check = { call: 1, role: 'subagent' as const, mode: 'coding' as const, files: {},
      toolsInclude: ['read_file'], toolsExclude: ['apply_patch'] }
    const input = { systemText: 'read_file is available; apply_patch is disabled.', conversationText: '' }
    expect((await checkModelRequest(check, '', input)).every((item) => !item.passed)).toBe(true)
    expect((await checkModelRequest(check, '', { ...input, toolNames: ['read_file'] })).every((item) => item.passed)).toBe(true)
    expect((await checkModelRequest(check, '', { ...input, toolNames: ['read_file', 'apply_patch'] }))
      .filter((item) => !item.passed).map((item) => item.name)).toEqual(['model-request:subagent:1:tool-excluded:apply_patch'])
  })
  it('rejects premature directory creation and dangling links at a move boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-eval-move-boundary-'))
    const task = codingTasks.find((task) => task.id === 'directory-move-rules')!
    const check = task.modelChecks!.find((check) => check.mode === 'coding' && check.call === 2)!
    const input = { systemText: check.systemIncludes!.join('\n'), conversationText: '' }
    const destination = join(root, 'destination/tree')
    try {
      await writeFixture(root, task.files)
      expect((await checkModelRequest(check, root, input)).every((item) => item.passed)).toBe(true)
      await mkdir(destination)
      expect((await checkModelRequest(check, root, input)).filter((item) => !item.passed).map((item) => item.name))
        .toEqual(['model-request:2:absent:destination/tree'])
      await rm(destination, { recursive: true })
      await symlink(join(root, 'missing-target'), destination, process.platform === 'win32' ? 'junction' : 'dir')
      expect((await checkModelRequest(check, root, input)).filter((item) => !item.passed).map((item) => item.name))
        .toEqual(['model-request:2:absent:destination/tree'])
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('requires summary content in the actual conversation before a post-compression write', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-eval-summary-boundary-'))
    const task = codingTasks.find((task) => task.id === 'automatic-compression-rules')!
    const check = task.modelChecks!.find((check) => check.mode === 'coding' && check.call === 13)!
    const systemText = check.systemIncludes!.join('\n')
    const conversationText = check.conversationIncludes!.join('\n')
    try {
      await writeFixture(root, task.files)
      expect((await checkModelRequest(check, root, { systemText, conversationText })).every((item) => item.passed)).toBe(true)
      expect((await checkModelRequest(check, root, { systemText: systemText + conversationText, conversationText: 'Unsummarized history' }))
        .filter((item) => !item.passed).map((item) => item.name)).toEqual(['model-request:13:conversation:0'])
      await writeFile(join(root, 'src/value.mjs'), task.expected['src/value.mjs'])
      expect((await checkModelRequest(check, root, { systemText, conversationText })).filter((item) => !item.passed).map((item) => item.name))
        .toEqual(['model-request:13:file:src/value.mjs'])
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('runs nested merge cases including ordinary __proto__ keys and rejects shallow replacements', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-eval-merge-'))
    const task = codingTasks.find((task) => task.id === 'merge-settings')!
    try {
      await writeFixture(root, task.files)
      const before = await snapshotFiles(root)
      for (const [name, content] of Object.entries(task.expected)) await writeFile(join(root, name), content)
      const correct = await checkTaskFiles(task, root, before)
      expect(correct.behavior, correct.behavior?.output).toMatchObject({ status: 'passed', completed: 13 })
      const nullPrototypeResult = task.expected['配置 模块/merge.mjs'].replace('return Object.fromEntries([...keys].map(key => {', 'return Object.assign(Object.create(null), Object.fromEntries([...keys].map(key => {')
        .replace('  }));', '  })));')
      await writeFile(join(root, '配置 模块/merge.mjs'), nullPrototypeResult)
      expect((await checkTaskFiles(task, root, before)).behavior?.status).toBe('passed')
      await writeFile(join(root, '配置 模块/merge.mjs'), 'export const mergeSettings = (base, override) => ({ ...base, ...override });\n')
      expect((await checkTaskFiles(task, root, before)).behavior?.status).toBe('failed')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('keeps result values type-strict when object prototypes are not part of the contract', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-eval-value-types-'))
    try {
      await writeFixture(root, { 'value.mjs': "export const value = () => ({ count: '1' });\n" })
      const result = await runBehaviorTests(root, [{ id: 'type', module: 'value.mjs', kind: 'call', export: 'value', args: [], expected: { count: 1 } }])
      expect(result.status).toBe('failed')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('rejects premature partial writes and incomplete rule text at the next model request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-eval-rule-boundary-'))
    const task = codingTasks.find((task) => task.id === 'new-rule-redecision')!
    const check = task.modelChecks!.find((check) => check.mode === 'coding' && check.call === 2)!
    const rules = check.systemIncludes![0]
    try {
      await writeFixture(root, task.files)
      expect((await checkModelRequest(check, root, { systemText: rules, conversationText: '' })).every((item) => item.passed)).toBe(true)
      expect((await checkModelRequest(check, root, { systemText: rules.split('\n')[0], conversationText: '' })).some((item) => !item.passed)).toBe(true)
      await writeFile(join(root, 'root.mjs'), task.expected['root.mjs'])
      expect((await checkModelRequest(check, root, { systemText: rules, conversationText: '' })).filter((item) => !item.passed).map((item) => item.name))
        .toEqual(['model-request:2:file:root.mjs'])
      await rm(join(root, 'src/label.mjs'))
      expect((await checkModelRequest(check, root, { systemText: rules, conversationText: '' })).some((item) => item.name.endsWith('src/label.mjs') && !item.passed)).toBe(true)
      const initial = task.modelChecks!.find((check) => check.mode === 'coding' && check.call === 1)!
      expect((await checkModelRequest(initial, root, { systemText: rules, conversationText: '' })).some((item) => item.name.includes('unseen-rule') && !item.passed)).toBe(true)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('requires requested moves, deletions and directories while protecting restored content', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-eval-file-management-'))
    const task = codingTasks.find((task) => task.id === 'file-tool-roundtrip')!
    try {
      await writeFixture(root, task.files)
      const before = await snapshotFiles(root)
      expect((await checkTaskFiles(task, root, before)).checks.filter((check) => !check.passed).length).toBeGreaterThan(0)
      await mkdir(join(root, 'scratch'))
      await rename(join(root, 'asset.bin'), join(root, 'scratch/asset.bin'))
      await rm(join(root, 'obsolete.txt'))
      expect((await checkTaskFiles(task, root, before)).checks.every((check) => check.passed)).toBe(true)
      await writeFile(join(root, 'work.txt'), 'after\n')
      expect((await checkTaskFiles(task, root, before)).unrelatedChanges).toEqual(['work.txt'])
      await writeFile(join(root, 'obsolete.txt'), 'not removed')
      expect((await checkTaskFiles(task, root, before)).checks.find((check) => check.name === 'absent:obsolete.txt')?.passed).toBe(false)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it.each(['__proto__', 'constructor', 'toString'])('tracks and protects the ordinary filename %s', async (name) => {
    const root = await mkdtemp(join(tmpdir(), 'anas-eval-object-key-'))
    const task = codingTasks.find((task) => task.id === 'batch-preflight')!
    try {
      await writeFixture(root, task.files)
      const before = await snapshotFiles(root)
      await writeFile(join(root, name), 'unrelated addition')
      const added = await checkTaskFiles(task, root, before)
      expect(Object.hasOwn(added.after, name)).toBe(true)
      expect(added.unrelatedChanges).toEqual([name])
      await writeFile(join(root, name), 'changed')
      expect((await checkTaskFiles(task, root, added.after)).unrelatedChanges).toEqual([name])
      const changed = await snapshotFiles(root)
      await rm(join(root, name))
      expect((await checkTaskFiles(task, root, changed)).unrelatedChanges).toEqual([name])
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('retains the starting source fingerprints and detects edits, additions and deletions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-eval-source-'))
    try {
      await writeFixture(root, { 'runtime.ts': 'before', 'removed.ts': 'old' })
      const before = await sourceFingerprints(root, ['runtime.ts', 'removed.ts'])
      expect(changedSources(before, await sourceFingerprints(root, ['runtime.ts', 'removed.ts']))).toEqual([])
      await writeFile(join(root, 'runtime.ts'), 'after')
      await rm(join(root, 'removed.ts'))
      await writeFile(join(root, 'added.ts'), 'new')
      const after = await sourceFingerprints(root, ['runtime.ts', 'added.ts', 'removed.ts'])
      expect(changedSources(before, after)).toEqual(['added.ts', 'removed.ts', 'runtime.ts'])
      expect(before['runtime.ts']).not.toBe(after['runtime.ts'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('counts tool failures from result state rather than file contents', () => {
    expect(toolOutputFailed(JSON.stringify({ ok: true, content: '{"ok":false}' }))).toBe(false)
    expect(toolOutputFailed({ ok: false, error: 'Missing context' })).toBe(true)
    expect(toolOutputFailed({ ok: true, files: [{ ok: true }, { ok: false }] })).toBe(true)
    expect(toolOutputFailed('NOT EXECUTED: Patch must start with *** Begin Patch.')).toBe(true)
    expect(toolOutputFailed('Ordinary plain-text tool output.')).toBe(false)
    expect(toolOutputFailed({ ok: true, content: 'NOT EXECUTED: copied source text' })).toBe(false)
  })
  it('rejects an unfixed fixture and detects changes to user work and extra files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-eval-oracle-'))
    const task = sumTask
    try {
      await writeFixture(root, task.files)
      const before = await snapshotFiles(root)
      expect((await checkTaskFiles(task, root, before)).checks.some((check) => !check.passed)).toBe(true)
      for (const [name, content] of Object.entries(task.expected)) await writeFile(join(root, name), content)
      expect((await checkTaskFiles(task, root, before)).checks.every((check) => check.passed)).toBe(true)
      await writeFile(join(root, 'notes.txt'), 'lost user edit')
      await writeFile(join(root, 'extra.txt'), 'unrelated')
      expect((await checkTaskFiles(task, root, before)).unrelatedChanges.sort()).toEqual(['extra.txt', 'notes.txt'])
      await expect(writeFixture(root, task.files)).rejects.toMatchObject({ code: 'EEXIST' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects fixture paths outside the fresh workspace on every host', () => {
    for (const name of ['../user', '/user', 'C:/user', 'a\\b', '.', 'a/../b', 'a//b']) {
      expect(() => fixturePath(tmpdir(), name)).toThrow()
    }
  })

  it.each([
    ['empty-sum', { 'sum.mjs': 'export const sum = xs => { let total = 0; for (const x of xs) total += x; return total; };\n' }],
    ['rename-export', { 'math.mjs': 'export function twice(value) { return value + value; }\n', 'index.mjs': "export * from './math.mjs';\n" }],
    ['diagnose-range', { 'range.mjs': 'export function contains(n, max) { return !(n < 0 || n >= max); }\n' }],
    ['find-owner', { 'modules/retry.mjs': 'const limit = 3; export const retryPolicy = { limit };\n' }],
    ['compression-resume', { 'sum.mjs': 'export const sum = xs => xs.length ? xs.reduce((a, b) => a + b) : 0;\n' }]
  ])('accepts a behaviorally equivalent implementation for %s', async (id, files) => {
    const root = await mkdtemp(join(tmpdir(), 'anas-eval-alternative-'))
    try {
      const task = codingTasks.find((task) => task.id === id)!
      await writeFixture(root, task.files)
      const before = await snapshotFiles(root)
      for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content!)
      const result = await checkTaskFiles(task, root, before)
      expect(result.behavior).toMatchObject({ status: 'passed', completed: task.behavior!.length, failed: 0 })
      expect(result.checks.every((check) => check.passed)).toBe(true)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it.each([
    'export const sum = () => 0;',
    'export const sum = xs => { const value = xs.reduce((a,b) => a+b,0); xs.length = 0; return value; };',
    'export const sum = ;',
    'process.exit(0);'
  ])('rejects wrong behavior, input mutation, syntax errors and early successful exit: %s', async (source) => {
    const root = await mkdtemp(join(tmpdir(), 'anas-eval-bad-code-'))
    try {
      await writeFixture(root, { 'sum.mjs': source })
      const result = await runBehaviorTests(root, sumTask.behavior!)
      expect(result.status).toBe('failed')
      expect(result.error).not.toBeNull()
      if (source.includes('() => 0')) expect(result).toMatchObject({ completed: 4, passed: 1, failed: 3 })
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it.each(codingTasks.filter((task) => task.behavior))('fails the original unfixed $id input', async (task) => {
    const root = await mkdtemp(join(tmpdir(), 'anas-eval-unfixed-'))
    try {
      await writeFixture(root, task.files)
      const result = await runBehaviorTests(root, task.behavior!)
      expect(result.status).toBe('failed')
      expect(result.completed).toBe(task.behavior!.length)
      expect(result.failed).toBeGreaterThan(0)
    } finally { await rm(root, { recursive: true, force: true }) }
  })

  it('kills and drains a blocking candidate before returning on cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-eval-cancel-code-'))
    const controller = new AbortController()
    let evaluation: ReturnType<typeof runBehaviorTests> | undefined
    try {
      await writeFixture(root, { 'sum.mjs': "import { writeFileSync } from 'node:fs'; writeFileSync('runner.pid', String(process.pid)); while (true) {}" })
      evaluation = runBehaviorTests(root, sumTask.behavior!, controller.signal)
      const pid = await vi.waitFor(async () => Number(await readFile(join(root, 'runner.pid'), 'utf8')), { timeout: 3000 })
      controller.abort()
      expect(await evaluation).toMatchObject({ status: 'failed', completed: 0 })
      expect(() => process.kill(pid, 0)).toThrow()
    } finally {
      controller.abort()
      await evaluation
      await rm(root, { recursive: true, force: true })
    }
  })

  it('loads filesystem names containing spaces, percent signs and hashes literally', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-eval-file-url-'))
    try {
      const module = 'sum # %.mjs'
      await writeFixture(root, { [module]: sumTask.expected['sum.mjs'] })
      expect(await runBehaviorTests(root, sumTask.behavior!.map((item) => ({ ...item, module }))))
        .toMatchObject({ status: 'passed', completed: 4 })
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})

describe('review location rubric', () => {
  const scope: CodeReviewSnapshot = {
    id: 'a'.repeat(64), projectId: 'project', capturedAt: '2026-09-10T00:00:00Z', description: 'fixture', limitations: [],
    request: { kind: 'recorded', target: 'recorded', threadId: 'thread', runId: 'run', version: 'b'.repeat(64) },
    files: [{ id: 'sum', path: '/fixture/sum.mjs', patch: 'fixture', before: [{ start: 1, end: 3 }], after: [{ start: 1, end: 3 }] }]
  }
  const targets = [{ path: '/fixture/sum.mjs', side: 'after' as const, start: 2, end: 2, priority: 'P2' as const }]
  const finding: CodeReviewReport['findings'][number] = { file_id: 'sum', side: 'after', start_line: 2, end_line: 2,
    priority: 'P2', title: 'Regression', condition: 'Trigger', impact: 'Impact', evidence: 'Evidence' }
  const report: CodeReviewReport = { scope_id: scope.id, summary: 'Review', findings: [finding], limitations: [] }

  it('counts misses, duplicates and clean scopes without claiming semantic correctness', () => {
    expect(scoreReview(scope, report, targets)).toMatchObject({ matchedFindings: 1, unmatchedFindings: 0, missedFindings: 0, semanticCorrectness: null })
    expect(scoreReview(scope, { ...report, findings: [finding, finding] }, targets)).toMatchObject({ matchedFindings: 1, unmatchedFindings: 1, precision: 0.5 })
    expect(scoreReview(scope, { ...report, findings: [] }, targets)).toMatchObject({ missedFindings: 1, precision: null, recall: 0 })
    expect(scoreReview(scope, report, [])).toMatchObject({ unmatchedFindings: 1, recall: null })
    expect(scoreReview(scope, { ...report, findings: [] }, [])).toMatchObject({ matchedFindings: 0, unmatchedFindings: 0, missedFindings: 0, precision: null, recall: null })
  })

  it.each([
    { file_id: 'missing' }, { side: 'before' as const }, { start_line: 1 }, { end_line: 3 },
    { priority: 'P1' as const }, { start_line: 4, end_line: 4 }
  ])('rejects a finding with the wrong target or severity: %o', (change) => {
    expect(scoreReview(scope, { ...report, findings: [{ ...finding, ...change }] }, targets))
      .toMatchObject({ matchedFindings: 0, missedFindings: 1, unmatchedFindings: 1 })
  })

  it('rejects a different captured scope even when no findings are expected', () => {
    expect(scoreReview(scope, { ...report, scope_id: 'c'.repeat(64) }, targets)).toMatchObject({ scopeMatched: false, matchedFindings: 0 })
    expect(scoreReview(scope, { ...report, scope_id: 'c'.repeat(64), findings: [] }, [])).toMatchObject({ scopeMatched: false })
  })
})
