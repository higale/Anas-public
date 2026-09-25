import type { SearchExpectation } from './codingSearch'

export type BehaviorCase = { id: string; module: string } & (
  | { kind: 'call'; export: string; args: unknown[]; expected: unknown }
  | { kind: 'exports'; expected: string[] }
  | { kind: 'value'; path: string[]; expected: unknown }
)

export interface ReviewTarget {
  path: string
  side: 'before' | 'after'
  start: number
  end: number
  priority: 'P0' | 'P1' | 'P2' | 'P3'
}

export interface ModelRequestCheck {
  call: number
  role?: 'main' | 'subagent'
  mode: 'ordinary' | 'coding'
  files: Record<string, string>
  absent?: string[]
  systemIncludes?: string[]
  systemExcludes?: string[]
  conversationIncludes?: string[]
  toolsInclude?: string[]
  toolsExclude?: string[]
}

/** Reference edits drive scripts; independent behavior cases judge candidate implementations. */
export interface CodingTask {
  id: string
  category: string
  prompt: string
  files: Record<string, string>
  expected: Record<string, string>
  absent?: string[]
  directories?: string[]
  tools?: string[]
  requireAllSelectedTools?: boolean
  subagent?: {
    name: string
    tools: string[]
    restrict: boolean
    expectedTools: string[]
    requireAllSelectedTools?: boolean
    calls: CodingTask['calls']
  }
  outputChecks?: Array<{ name: string; includes: string[]; mode?: 'ordinary' | 'coding' }>
  externalChange?: { afterTool: number; files: Record<string, string> }
  modelChecks?: ModelRequestCheck[]
  modelContextTokens?: number
  modeExpectations?: Partial<Record<ModelRequestCheck['mode'], {
    expected: Record<string, string>
    toolErrors: number
    modelCalls?: number
    ruleFailure?: string
  }>>
  behavior?: BehaviorCase[]
  calls: Array<Array<{ name: string; args: Record<string, unknown>; binding?: 'patch' | 'subagent'; search?: SearchExpectation }>>
  expectedToolErrors?: number
  compression?: 'manual' | 'automatic'
  review?: { baseline: Record<string, string>; targets: ReviewTarget[] }
}

const read = (path: string) => ({ name: 'read_file', args: { path } })
const patch = (body: string) => ({
  name: 'apply_patch', args: { patch: `*** Begin Patch\n${body}*** End Patch\n` }
})
const update = (path: string, before: string, after: string) =>
  `*** Update File: ${path}\n@@\n${before.trimEnd().split('\n').map((line) => `-${line}`).join('\n')}\n${after.trimEnd().split('\n').map((line) => `+${line}`).join('\n')}\n`

const sumBefore = 'export function sum(values) {\n  return values.reduce((a, b) => a + b);\n}\n'
const sumAfter = 'export function sum(values) {\n  return values.reduce((a, b) => a + b, 0);\n}\n'
const ruleBefore = 'export const label = "old";\n'
const ruleAfter = "export const label = 'new';\n"
const compressionRules = 'Repository contract:\nKeep sum.mjs as a numeric-array sum, including empty arrays.\nPreserve notes.txt byte for byte.\nKeep verification evidence separate from planned checks.\n'
const scopedRule = 'Use single quotes for JavaScript string literals in this directory.\nKeep unrelated files unchanged.\n'
const redecisionBefore = { 'root.mjs': 'export const enabled = false;\n', 'src/label.mjs': ruleBefore }
const redecisionAfter = { 'root.mjs': 'export const enabled = true;\n', 'src/label.mjs': ruleAfter }
const redecisionPatch = update('root.mjs', redecisionBefore['root.mjs'], redecisionAfter['root.mjs'])
  + update('src/label.mjs', ruleBefore, ruleAfter)
const mergeModule = '配置 模块/merge.mjs'
const mergeBefore = `export function mergeOptions(base, override) {
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value) result[key] = value;
  }
  return result;
}
`
const mergeAfter = `const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function mergeSettings(base, override) {
  const keys = new Set([...Object.keys(base), ...Object.keys(override)]);
  return Object.fromEntries([...keys].map(key => {
    if (!Object.hasOwn(override, key)) return [key, structuredClone(base[key])];
    const value = override[key];
    return [key, Object.hasOwn(base, key) && isRecord(base[key]) && isRecord(value)
      ? mergeSettings(base[key], value)
      : structuredClone(value)];
  }));
}
`
const settingsBefore = `import { mergeOptions } from './配置 模块/merge.mjs';

export function settingsFor(override) {
  return mergeOptions({ connection: { host: 'localhost', port: 8080 }, retries: 3, tags: ['base'] }, override);
}
`
const settingsAfter = settingsBefore.replaceAll('mergeOptions', 'mergeSettings')
const mergeCases: Array<{ id: string; base: unknown; override: unknown; expected: unknown }> = [
  { id: 'empty', base: {}, override: {}, expected: {} },
  { id: 'defaults', base: { a: { b: 1 }, tags: ['base'] }, override: {}, expected: { a: { b: 1 }, tags: ['base'] } },
  { id: 'nested', base: { a: { b: 1, c: { d: 2, e: 3 } } }, override: { a: { c: { d: 4 } } }, expected: { a: { b: 1, c: { d: 4, e: 3 } } } },
  { id: 'falsy', base: { enabled: true, retries: 3, label: 'old' }, override: { enabled: false, retries: 0, label: '' }, expected: { enabled: false, retries: 0, label: '' } },
  { id: 'arrays', base: { a: [1, 2], b: [{ old: true }] }, override: { a: [], b: [{ next: true }] }, expected: { a: [], b: [{ next: true }] } },
  { id: 'null', base: { a: { b: 1 }, b: null }, override: { a: null, b: { c: 2 } }, expected: { a: null, b: { c: 2 } } },
  { id: 'type-replacement', base: { a: [1], b: { c: 1 }, c: 3 }, override: { a: { d: 2 }, b: [2], c: { e: 4 } }, expected: { a: { d: 2 }, b: [2], c: { e: 4 } } },
  { id: 'new-key', base: { a: 1 }, override: { b: { c: 2 } }, expected: { a: 1, b: { c: 2 } } },
  { id: 'ordinary-property-names', base: { ['__proto__']: { left: 1 }, constructor: 2 }, override: { ['__proto__']: { right: 3 }, toString: 4 }, expected: { ['__proto__']: { left: 1, right: 3 }, constructor: 2, toString: 4 } }
]
const sumCases: BehaviorCase[] = [[], [4], [2, -5, 8], [0.5, 0.25]].map((values, index) => ({
  id: `sum-${index}`, module: 'sum.mjs', kind: 'call', export: 'sum', args: [values],
  expected: [0, 4, 5, 0.75][index]
}))

const automaticEvidence = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [
  `src/context-${index}.txt`, `Record ${index}: ` + 'Retain this inspection evidence without modifying files.\n'.repeat(200)
]))
const automaticRootRule = 'Automatic compression root rule: Preserve all evidence files and notes.txt.'
const automaticScopedRule = 'Automatic compression module rule: Keep the value export and change only its string value.'

const movedTree = {
  'AGENTS.md': 'Tree move rule: Preserve every file byte for byte.\nMove this directory as one indivisible operation.\n',
  'deep/AGENTS.md': 'Deep move rule: Keep Unicode names and nested content unchanged.\n',
  'entry.txt': 'Tree entry: preserve.\n', 'deep/数据 file.txt': '用户数据：保持原样。\n'
}
const moveBefore = Object.fromEntries(Object.entries(movedTree).map(([name, value]) => [`source/tree/${name}`, value]))
const moveAfter = Object.fromEntries(Object.entries(movedTree).map(([name, value]) => [`destination/tree/${name}`, value]))
const moveRootRule = 'Root move rule: Preserve notes.txt and all parent-directory rule files.'
const moveSourceRule = 'Source parent rule: Move only the requested tree; leave siblings untouched.'
const moveDestinationRule = 'Destination parent rule: Preserve existing destination files and names.'
const moveScopedRules = [moveSourceRule, movedTree['AGENTS.md'].trim(), movedTree['deep/AGENTS.md'].trim(), moveDestinationRule]

// Deliberately stay within the shared 2,000-file / 8 MB snapshot budget.
const searchOwner = 'packages/网络 模块/retry-owner.mjs'
const searchHelper = 'packages/other/retry-helper.mjs'
const searchMarker = '// retry-owner: 网络重试\n'
const searchBefore = `${searchMarker}export const retries = 2;\n`
const searchAfter = `${searchMarker}export const retries = 7;\n`
const searchNoise = Object.fromEntries(Array.from({ length: 1536 }, (_, index) => [
  `packages/unit-${Math.floor(index / 32)}/src/module-${index}.mjs`,
  `export const moduleId = ${index};\n` + '// Unrelated implementation detail; retain this file unchanged.\n'.repeat(24)
]))
const ignoredSearchFiles = Object.fromEntries(['vendor', 'build'].flatMap((directory) =>
  Array.from({ length: 96 }, (_, index) => [`${directory}/retry-${index}.mjs`, searchBefore])))
const isolatedRg = 'rg --no-config --no-ignore-global --no-ignore-parent --no-follow'

const capabilityTasks: CodingTask[] = [
  { id: 'independent-writer', mainWrite: false, childWrite: true, restrict: false, writes: true },
  { id: 'restricted-writer', mainWrite: false, childWrite: true, restrict: true, writes: false },
  { id: 'child-reader', mainWrite: true, childWrite: false, restrict: false, writes: false },
  { id: 'shared-writer', mainWrite: true, childWrite: true, restrict: true, writes: true }
].map(({ id, mainWrite, childWrite, restrict, writes }): CodingTask => {
  const name = `eval-${id}`
  const tools = (write: boolean) => ['read_file', ...(write ? ['apply_patch'] : [])]
  const before = { 'work.txt': 'before\n' }, after = { 'work.txt': writes ? 'after\n' : 'before\n' }
  return {
    id: `subagent-${id}`, category: 'file-capability-matrix',
    prompt: `Read work.txt, then ask ${name} to read it and attempt the requested change from before to after. Wait for its terminal result. Preserve notes.txt.`,
    files: { ...before, 'notes.txt': 'User notes\n' }, expected: after,
    tools: tools(mainWrite), expectedToolErrors: writes ? 0 : 1,
    subagent: { name, tools: tools(childWrite), restrict, expectedTools: tools(writes),
      calls: [[read('work.txt')], [patch(update('work.txt', before['work.txt'], 'after\n'))]] },
    calls: [[read('work.txt')], [{ name: 'start_subagent', args: { agent: name,
      description: 'Read work.txt, then attempt to change before to after with apply_patch. If the tool is unavailable, report that result and leave all files unchanged. Preserve notes.txt.' } }],
    [{ name: 'wait_subagent', args: { timeout: 10 }, binding: 'subagent' }]],
    modelChecks: (['ordinary', 'coding'] as const).flatMap((mode): ModelRequestCheck[] => [
      ...[1, 2, 3, 4].map((call): ModelRequestCheck => ({
        role: 'main', call, mode, files: call < 3 ? before : call === 4 ? after : {},
        toolsInclude: [...tools(mainWrite), 'start_subagent', 'wait_subagent'],
        toolsExclude: [...(mainWrite ? [] : ['apply_patch']), 'run_shell', 'zsh', 'bash', 'powershell', 'pwsh']
      })),
      ...[1, 2, 3].map((call): ModelRequestCheck => ({
        role: 'subagent', call, mode, files: call === 3 ? after : before,
        toolsInclude: tools(writes),
        toolsExclude: [...(writes ? [] : ['apply_patch']), 'start_subagent', 'run_shell', 'zsh', 'bash', 'powershell', 'pwsh']
      }))
    ])
  }
})

const coreCodingTasks: CodingTask[] = [
  {
    id: 'large-rg-owner', category: 'repository-search',
    prompt: 'Use the bundled rg through the command shell to discover retry modules and find the source marked retry-owner: 网络重试. Respect hidden/ignored files, read the owning module, and change its exported retries from 2 to 7. Preserve every unrelated file.',
    files: { ...searchNoise, ...ignoredSearchFiles,
      '.ignore': 'vendor/\nbuild/\n', '.cache/retry-hidden.mjs': searchBefore,
      'packages/docs/retry-owner.txt': searchBefore,
      [searchOwner]: searchBefore, [searchHelper]: 'export const helper = true;\n',
      'notes.txt': 'User notes: keep all unrelated files.\n' },
    expected: { [searchOwner]: searchAfter },
    tools: ['run_shell', 'read_file', 'apply_patch'], requireAllSelectedTools: true,
    behavior: [{ id: 'owner-retries', module: searchOwner, kind: 'value', path: ['retries'], expected: 7 }],
    calls: [
      [{ name: 'run_shell', args: { command: `${isolatedRg} --files --glob '*retry*.mjs' .` },
        search: { kind: 'files', paths: [searchOwner, searchHelper] } }],
      [{ name: 'run_shell', args: { command: `${isolatedRg} --json --glob '*.mjs' --fixed-strings 'retry-owner: 网络重试' .` },
        search: { kind: 'matches', matches: [{ path: searchOwner, line: 1, text: searchMarker }] } }],
      [read(searchOwner)], [patch(update(searchOwner, searchBefore, searchAfter))]
    ],
    modelChecks: (['ordinary', 'coding'] as const).flatMap((mode): ModelRequestCheck[] =>
      [1, 2, 3, 4, 5].map((call) => ({ call, mode,
        files: { [searchOwner]: call === 5 ? searchAfter : searchBefore },
        toolsInclude: ['run_shell', 'read_file', 'apply_patch'], toolsExclude: ['start_subagent'] })))
  },
  {
    id: 'empty-sum', category: 'small-bug',
    prompt: 'Fix sum([]) throwing. Preserve non-empty sums and all unrelated files.',
    files: { 'sum.mjs': sumBefore, 'notes.txt': 'User draft: keep this line.\n' },
    expected: { 'sum.mjs': sumAfter },
    behavior: sumCases,
    calls: [[read('sum.mjs')], [patch(update('sum.mjs', sumBefore, sumAfter))]]
  },
  {
    id: 'rename-export', category: 'multi-file',
    prompt: 'Rename the double export in math.mjs to twice and update its consumer index.mjs. Both modules must export twice and no longer export double. Preserve behavior.',
    files: { 'math.mjs': 'export const double = n => n * 2;\n', 'index.mjs': "export { double } from './math.mjs';\n" },
    expected: { 'math.mjs': 'export const twice = n => n * 2;\n', 'index.mjs': "export { twice } from './math.mjs';\n" },
    behavior: ['math.mjs', 'index.mjs'].flatMap((module): BehaviorCase[] => [
      { id: `${module}-exports`, module, kind: 'exports', expected: ['twice'] },
      ...[-3, 0, 2.5].map((value): BehaviorCase => ({
        id: `${module}-${value}`, module, kind: 'call', export: 'twice', args: [value], expected: value * 2
      }))
    ]),
    calls: [
      [{ name: 'read_multiple_files', args: { paths: ['math.mjs', 'index.mjs'] } }],
      [patch(update('math.mjs', 'export const double = n => n * 2;\n', 'export const twice = n => n * 2;\n')
        + update('index.mjs', "export { double } from './math.mjs';\n", "export { twice } from './math.mjs';\n"))]
    ]
  },
  {
    id: 'merge-settings', category: 'multiline-multi-file',
    prompt: 'Replace the shallow truthiness-based mergeOptions in 配置 模块/merge.mjs with the exported mergeSettings(base, override), and update settings.mjs to call it. Remove the old export. Inputs are JSON-compatible records. Recursively merge only when both values are non-null non-array records; keep missing default keys, replace arrays in full, and honor null, false, 0 and empty strings. Treat every string key as data, including __proto__, constructor and toString. Preserve both inputs and all unrelated files. Keep settingsFor defaults unchanged.',
    files: { [mergeModule]: mergeBefore, 'settings.mjs': settingsBefore, 'notes.txt': 'User draft: keep unrelated text.\n' },
    expected: { [mergeModule]: mergeAfter, 'settings.mjs': settingsAfter },
    behavior: [
      ...mergeCases.map((item): BehaviorCase => ({ id: `merge-${item.id}`, module: mergeModule, kind: 'call', export: 'mergeSettings', args: [item.base, item.override], expected: item.expected })),
      { id: 'merge-exports', module: mergeModule, kind: 'exports', expected: ['mergeSettings'] },
      { id: 'consumer-exports', module: 'settings.mjs', kind: 'exports', expected: ['settingsFor'] },
      { id: 'consumer-defaults', module: 'settings.mjs', kind: 'call', export: 'settingsFor', args: [{}], expected: { connection: { host: 'localhost', port: 8080 }, retries: 3, tags: ['base'] } },
      { id: 'consumer-overrides', module: 'settings.mjs', kind: 'call', export: 'settingsFor', args: [{ connection: { port: 0 }, retries: 0, tags: [] }], expected: { connection: { host: 'localhost', port: 0 }, retries: 0, tags: [] } }
    ],
    calls: [[{ name: 'read_multiple_files', args: { paths: [mergeModule, 'settings.mjs'] } }],
      [patch(update(mergeModule, mergeBefore, mergeAfter) + update('settings.mjs', settingsBefore, settingsAfter))]]
  },
  {
    id: 'diagnose-range', category: 'test-localization',
    prompt: 'The fixed test transcript is in failure.txt. Find and fix the range defect; do not change the test expectation.',
    files: { 'range.mjs': 'export const contains = (n, max) => n >= 0 && n <= max;\n', 'failure.txt': 'contains(3, 3): expected false, actual true. Range is [0, max).\n' },
    expected: { 'range.mjs': 'export const contains = (n, max) => n >= 0 && n < max;\n' },
    behavior: [[-1, 3, false], [0, 3, true], [2, 3, true], [3, 3, false], [4, 3, false], [0, 0, false], [0, -1, false]]
      .map(([n, max, expected], index) => ({ id: `range-${index}`, module: 'range.mjs', kind: 'call', export: 'contains', args: [n, max], expected })),
    calls: [[read('failure.txt')], [read('range.mjs')], [patch(update('range.mjs', 'export const contains = (n, max) => n >= 0 && n <= max;\n', 'export const contains = (n, max) => n >= 0 && n < max;\n'))]]
  },
  {
    id: 'parallel-patches', category: 'parallel-tools',
    prompt: 'Independently change left.txt and nested/右 file.txt from before to after using two patch calls in one response. Preserve notes.txt.',
    files: { 'left.txt': 'before\n', 'nested/右 file.txt': 'before\n', 'notes.txt': 'User draft: preserve.\n' },
    expected: { 'left.txt': 'after\n', 'nested/右 file.txt': 'after\n' },
    calls: [
      [patch(update('left.txt', 'before\n', 'after\n')), patch(update('nested/右 file.txt', 'before\n', 'after\n'))]
    ],
    modelChecks: (['ordinary', 'coding'] as const).flatMap((mode): ModelRequestCheck[] => [
      { call: 1, mode, files: { 'left.txt': 'before\n', 'nested/右 file.txt': 'before\n' } },
      { call: 2, mode, files: { 'left.txt': 'after\n', 'nested/右 file.txt': 'after\n' } }
    ])
  },
  {
    id: 'nested-rules', category: 'rule-conflict',
    prompt: 'Change the label in src/label.mjs to new, following the applicable project rules.',
    files: { 'AGENTS.md': 'Use double quotes unless a more specific directory rule overrides this.\n', 'src/AGENTS.md': 'Use single quotes for JavaScript string literals in this directory.\n', 'src/label.mjs': ruleBefore },
    expected: { 'src/label.mjs': ruleAfter },
    calls: [[read('src/label.mjs')], [patch(update('src/label.mjs', ruleBefore, ruleAfter))]]
  },
  {
    id: 'new-rule-redecision', category: 'rule-conflict',
    prompt: 'Enable root.mjs and change src/label.mjs to new in one batch. Follow the applicable project rules. If the batch is rejected for newly discovered rules, reconsider it with the full rules before issuing another write.',
    files: { 'AGENTS.md': 'Preserve unrelated files.\n', 'src/AGENTS.md': scopedRule,
      ...redecisionBefore, 'notes.txt': 'User draft: preserve.\n' },
    expected: redecisionAfter, expectedToolErrors: 1,
    calls: [[patch(redecisionPatch)], [patch(redecisionPatch)]],
    outputChecks: [{ name: 'apply_patch', mode: 'coding',
      includes: ['NOT EXECUTED: Newly discovered scoped project rules', 'no original write has been replayed.'] }],
    modelChecks: (['ordinary', 'coding'] as const).flatMap((mode): ModelRequestCheck[] => [
      { call: 1, mode, files: redecisionBefore, systemExcludes: [scopedRule.trim()] },
      { call: 2, mode, files: mode === 'coding' ? redecisionBefore : redecisionAfter,
        ...(mode === 'coding' ? { systemIncludes: [scopedRule.trim()] } : { systemExcludes: [scopedRule.trim()] }) },
      { call: 3, mode, files: redecisionAfter }
    ])
  },
  {
    id: 'directory-move-rules', category: 'directory-rule-boundary',
    prompt: 'Move source/tree and all its descendants to destination/tree as one directory operation. Follow the complete source, descendant and destination rules before execution. Preserve file contents, rule files, unrelated folders and notes.txt.',
    files: {
      'AGENTS.md': moveRootRule + '\n', 'source/AGENTS.md': moveSourceRule + '\n',
      'destination/AGENTS.md': moveDestinationRule + '\n',
      'inactive/AGENTS.md': 'Inactive move rule: Convert all text to uppercase.\n',
      ...moveBefore, 'notes.txt': 'User draft: preserve while moving directories.\n'
    },
    expected: moveAfter, absent: Object.keys(moveBefore), directories: ['destination/tree', 'destination/tree/deep'],
    tools: ['move_file'], requireAllSelectedTools: true, expectedToolErrors: 1,
    calls: Array.from({ length: 2 }, () => [{ name: 'move_file', args: { source: 'source/tree', destination: 'destination/tree' } }]),
    outputChecks: [{ name: 'move_file', mode: 'coding',
      includes: ['NOT EXECUTED: Newly discovered scoped project rules', 'no original write has been replayed.'] }],
    modelChecks: (['ordinary', 'coding'] as const).flatMap((mode): ModelRequestCheck[] => [1, 2, 3].map((call) => {
      const moved = call === 3 || (call === 2 && mode === 'ordinary')
      return {
        call, mode, files: moved ? moveAfter : moveBefore, absent: [moved ? 'source/tree' : 'destination/tree'],
        systemIncludes: mode === 'coding' ? [moveRootRule, ...(call > 1 ? moveScopedRules : [])] : [],
        systemExcludes: ['Inactive move rule: Convert all text to uppercase.',
          ...(mode === 'ordinary' ? [moveRootRule, ...moveScopedRules] : call === 1 ? moveScopedRules : [])]
      }
    }))
  },
  {
    id: 'rule-budget-terminal', category: 'rule-budget', modelContextTokens: 16000,
    prompt: 'Change child/work.txt from before to after with one patch, subject to the complete project rules. Do not bypass a terminal rule-budget failure.',
    files: { 'AGENTS.md': 'Preserve unrelated files.\n', 'child/AGENTS.md': 'R '.repeat(30000),
      'child/work.txt': 'before\n', 'notes.txt': 'User draft: preserve.\n' },
    expected: { 'child/work.txt': 'after\n' },
    calls: [[patch(update('child/work.txt', 'before\n', 'after\n'))]],
    modeExpectations: { coding: { expected: {}, toolErrors: 1, modelCalls: 1, ruleFailure: 'indivisible apply_patch' } },
    modelChecks: [
      { call: 1, mode: 'ordinary', files: { 'child/work.txt': 'before\n' } },
      { call: 2, mode: 'ordinary', files: { 'child/work.txt': 'after\n' } },
      { call: 1, mode: 'coding', files: { 'child/work.txt': 'before\n' } }
    ]
  },
  {
    id: 'find-owner', category: 'search',
    prompt: 'Using the repository index, locate the module owning retryPolicy and change its limit from 2 to 3. Leave all other modules unchanged.',
    files: {
      'index.txt': 'retryPolicy: modules/retry.mjs\n',
      ...Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`modules/entry-${i}.mjs`, `export const value = ${i};\n`])),
      'modules/retry.mjs': 'export const retryPolicy = { limit: 2 };\n'
    },
    expected: { 'modules/retry.mjs': 'export const retryPolicy = { limit: 3 };\n' },
    behavior: [{ id: 'retry-limit', module: 'modules/retry.mjs', kind: 'value', path: ['retryPolicy', 'limit'], expected: 3 }],
    calls: [[read('index.txt')], [read('modules/retry.mjs')], [patch(update('modules/retry.mjs', 'export const retryPolicy = { limit: 2 };\n', 'export const retryPolicy = { limit: 3 };\n'))]]
  },
  {
    id: 'automatic-compression-rules', category: 'automatic-compression',
    compression: 'automatic', modelContextTokens: 16000,
    prompt: 'Read all twelve src/context-N.txt evidence files in numeric order, then change the exported value in src/value.mjs from before to after. Preserve all evidence and notes.txt. Follow the project rules throughout the task.',
    files: {
      'AGENTS.md': automaticRootRule + '\n', 'src/AGENTS.md': automaticScopedRule + '\n',
      'inactive/AGENTS.md': 'Inactive automatic compression rule: Remove all exports.\n',
      ...automaticEvidence, 'src/value.mjs': 'export const value = "before";\n',
      'notes.txt': 'User draft: preserve during automatic compression.\n'
    },
    expected: { 'src/value.mjs': 'export const value = "after";\n' },
    behavior: [{ id: 'value-after-long-inspection', module: 'src/value.mjs', kind: 'value', path: ['value'], expected: 'after' }],
    calls: [...Object.keys(automaticEvidence).map((path) => [read(path)]),
      [patch(update('src/value.mjs', 'export const value = "before";\n', 'export const value = "after";\n'))]],
    modelChecks: (['ordinary', 'coding'] as const).flatMap((mode): ModelRequestCheck[] => Array.from({ length: 14 }, (_, index) => ({
      call: index + 1, mode,
      files: { 'src/value.mjs': index === 13 ? 'export const value = "after";\n' : 'export const value = "before";\n' },
      systemIncludes: mode === 'coding' ? [automaticRootRule, ...(index > 0 ? [automaticScopedRule] : [])] : [],
      systemExcludes: ['Inactive automatic compression rule: Remove all exports.',
        ...(mode === 'ordinary' ? [automaticRootRule, automaticScopedRule] : index === 0 ? [automaticScopedRule] : [])],
      ...(index === 12 ? { conversationIncludes: ['Resume from the retained tool results.'] } : {})
    })))
  },
  {
    id: 'compression-resume', category: 'compression', compression: 'manual',
    prompt: 'Remember the task: fix sum([]) to return zero. Keep notes.txt unchanged. First inspect sum.mjs; implement the fix after the next instruction.',
    files: { 'sum.mjs': sumBefore, 'notes.txt': 'User draft: preserve after compression.\n' },
    expected: { 'sum.mjs': sumAfter },
    behavior: sumCases,
    calls: [[read('sum.mjs')], [patch(update('sum.mjs', sumBefore, sumAfter))]]
  },
  {
    id: 'compression-rules', category: 'compression', compression: 'manual',
    prompt: 'Remember the task: fix sum([]) to return zero while preserving notes.txt. First inspect sum.mjs and follow the project rules; implement the fix after the next instruction.',
    files: { 'AGENTS.md': compressionRules, 'sum.mjs': sumBefore, 'notes.txt': 'User draft: preserve after compression.\n' },
    expected: { 'sum.mjs': sumAfter }, behavior: sumCases,
    calls: [[read('sum.mjs')], [patch(update('sum.mjs', sumBefore, sumAfter))]],
    modelChecks: (['ordinary', 'coding'] as const).flatMap((mode): ModelRequestCheck[] => [1, 3].map((call) => ({
      call, mode, files: { 'sum.mjs': sumBefore },
      ...(mode === 'coding' ? { systemIncludes: [compressionRules.trim()] } : { systemExcludes: [compressionRules.trim()] })
    })))
  },
  {
    id: 'compression-scoped-redecision', category: 'compression-rules', compression: 'manual',
    prompt: 'Inspect both label modules, then change their exported label from old to new after context compression. Follow the complete rules applicable to each path before editing. Preserve notes.txt and unrelated scopes.',
    files: {
      'AGENTS.md': 'Repository rule: Use double quotes unless a more specific directory rule overrides this.\n',
      'modules/AGENTS.md': 'Module rule: Use single quotes for JavaScript strings in this directory and its descendants.\n',
      'modules/deep/AGENTS.md': 'Deep module rule: Override the parent quote convention with double quotes here.\n',
      'inactive/AGENTS.md': 'Inactive rule: Convert strings into template literals.\n',
      'modules/label.mjs': 'export const label = "old";\n',
      'modules/deep/label.mjs': 'export const label = "old";\n',
      'notes.txt': 'User draft: preserve after scoped compression.\n'
    },
    expected: {
      'modules/label.mjs': "export const label = 'new';\n",
      'modules/deep/label.mjs': 'export const label = "new";\n'
    },
    behavior: ['modules/label.mjs', 'modules/deep/label.mjs'].map((module): BehaviorCase => ({
      id: module, module, kind: 'value', path: ['label'], expected: 'new'
    })),
    expectedToolErrors: 1,
    calls: [
      [{ name: 'read_multiple_files', args: { paths: ['modules/label.mjs', 'modules/deep/label.mjs'] } }],
      ...Array.from({ length: 2 }, () => [patch(
        update('modules/label.mjs', 'export const label = "old";\n', "export const label = 'new';\n")
        + update('modules/deep/label.mjs', 'export const label = "old";\n', 'export const label = "new";\n')
      )])
    ],
    outputChecks: [{ name: 'apply_patch', mode: 'coding',
      includes: ['NOT EXECUTED: Newly discovered scoped project rules', 'no original write has been replayed.'] }],
    modelChecks: (['ordinary', 'coding'] as const).flatMap((mode): ModelRequestCheck[] => [1, 2, 3, 4, 5].map((call) => {
      const scoped = call === 2 || call >= 4
      const changed = call === 5 || (mode === 'ordinary' && call === 4)
      const rootRule = 'Repository rule: Use double quotes unless a more specific directory rule overrides this.'
      const scopedRules = [
        'Module rule: Use single quotes for JavaScript strings in this directory and its descendants.',
        'Deep module rule: Override the parent quote convention with double quotes here.'
      ]
      return {
        call, mode,
        files: {
          'modules/label.mjs': changed ? "export const label = 'new';\n" : 'export const label = "old";\n',
          'modules/deep/label.mjs': changed ? 'export const label = "new";\n' : 'export const label = "old";\n'
        },
        systemIncludes: mode === 'coding' ? [rootRule, ...(scoped ? scopedRules : [])] : [],
        systemExcludes: ['Inactive rule: Convert strings into template literals.',
          ...(mode === 'ordinary' ? [rootRule, ...scopedRules] : scoped ? [] : scopedRules)]
      }
    }))
  },
  {
    id: 'review-regression', category: 'code-review',
    review: { baseline: { 'sum.mjs': sumAfter }, targets: [{ path: 'sum.mjs', side: 'after', start: 2, end: 2, priority: 'P2' }] },
    prompt: 'Review the captured change to sum for a concrete regression. Its input contract is arrays of numbers, including empty arrays. Do not edit files.',
    files: { 'sum.mjs': sumBefore }, expected: {}, calls: []
  },
  {
    id: 'review-clean', category: 'code-review',
    review: { baseline: { 'sum.mjs': sumAfter }, targets: [] },
    prompt: 'Review this comment-only change to sum, whose input contract is arrays of numbers, including empty arrays. Report only concrete regressions; do not edit files.',
    files: { 'sum.mjs': `// Sum numeric values, including empty input.\n${sumAfter}` }, expected: {}, calls: []
  },
  {
    id: 'file-tool-roundtrip', category: 'file-tools',
    prompt: 'Inspect the files, create scratch, move asset.bin into scratch, delete obsolete.txt, change work.txt with apply_patch, inspect its recorded diff, and restore that patch. Preserve notes.txt and restore work.txt to its original content.',
    files: { 'work.txt': 'before\n', 'asset.bin': '\u0000asset', 'obsolete.txt': 'delete me\n', 'notes.txt': 'User notes\n' },
    expected: { 'scratch/asset.bin': '\u0000asset' }, absent: ['asset.bin', 'obsolete.txt'], directories: ['scratch'],
    tools: ['read_file', 'read_multiple_files', 'apply_patch', 'list_directory', 'directory_tree', 'get_file_info',
      'create_directory', 'move_file', 'delete_file', 'get_file_edit_diff', 'restore_file_edit'],
    requireAllSelectedTools: true,
    calls: [
      [{ name: 'list_directory', args: { path: '.' } }],
      [{ name: 'directory_tree', args: { path: '.' } }],
      [{ name: 'get_file_info', args: { path: 'work.txt' } }],
      [read('work.txt')], [{ name: 'read_multiple_files', args: { paths: ['work.txt', 'notes.txt'] } }],
      [{ name: 'create_directory', args: { path: 'scratch' } }],
      [{ name: 'move_file', args: { source: 'asset.bin', destination: 'scratch/asset.bin' } }],
      [{ name: 'delete_file', args: { path: 'obsolete.txt' } }],
      [patch(update('work.txt', 'before\n', 'after\n'))],
      [{ name: 'get_file_edit_diff', args: { scope: 'operation' }, binding: 'patch' }],
      [{ name: 'restore_file_edit', args: {}, binding: 'patch' }]
    ],
    outputChecks: [
      { name: 'list_directory', includes: ['asset.bin', 'work.txt'] },
      { name: 'directory_tree', includes: ['notes.txt', 'obsolete.txt'] },
      { name: 'get_file_info', includes: ['"size":7', '"lineCount":1'] },
      { name: 'read_file', includes: ['before'] },
      { name: 'read_multiple_files', includes: ['before', 'User notes'] },
      { name: 'get_file_edit_diff', includes: ['-before', '+after'] }
    ]
  },
  {
    id: 'invalid-path-recovery', category: 'boundary',
    prompt: 'An empty path was supplied by mistake. Read work.txt using its correct path and change before to after. Preserve notes.txt.',
    files: { 'work.txt': 'before\n', 'notes.txt': 'User notes\n' },
    expected: { 'work.txt': 'after\n' }, expectedToolErrors: 1,
    calls: [[read('')], [read('work.txt')], [patch(update('work.txt', 'before\n', 'after\n'))]],
    outputChecks: [{ name: 'read_file', includes: ['NOT EXECUTED', 'path'] }]
  },
  {
    id: 'external-edit', category: 'boundary',
    prompt: 'Read work.txt and attempt the fixed before-to-after patch. An independent editor changes the file after the read; preserve that external edit when the old context no longer matches.',
    files: { 'work.txt': 'before\n', 'notes.txt': 'User notes\n' },
    expected: { 'work.txt': 'External editor change\n' }, expectedToolErrors: 1,
    externalChange: { afterTool: 1, files: { 'work.txt': 'External editor change\n' } },
    calls: [[read('work.txt')], [patch(update('work.txt', 'before\n', 'after\n'))]]
  },
  {
    id: 'ambiguous-context', category: 'boundary',
    prompt: 'Attempt the supplied ambiguous one-line patch and report the failure. Do not guess a location or alter any file.',
    files: { 'duplicate.txt': 'same\nsame\n' }, expected: {}, expectedToolErrors: 1,
    calls: [[patch('*** Update File: duplicate.txt\n@@\n-same\n+changed\n')]]
  },
  {
    id: 'batch-preflight', category: 'boundary',
    prompt: 'Attempt this batch with a missing context in its second file. Confirm the batch fails without modifying either file.',
    files: { 'first.txt': 'before\n', 'second.txt': 'actual\n' }, expected: {}, expectedToolErrors: 1,
    calls: [[patch(update('first.txt', 'before\n', 'after\n') + update('second.txt', 'missing\n', 'changed\n'))]]
  },
  ...capabilityTasks
]

const fileRoundtrip = coreCodingTasks.find((task) => task.id === 'file-tool-roundtrip')!
export const codingTasks: CodingTask[] = [
  ...coreCodingTasks,
  ...[false, true].map((restrict): CodingTask => {
    const name = restrict ? 'eval-shared-file-tools' : 'eval-independent-file-tools'
    const tools = fileRoundtrip.tools!
    return {
      ...fileRoundtrip,
      id: `subagent-file-roundtrip-${restrict ? 'restricted' : 'independent'}`,
      category: 'file-capability-matrix',
      prompt: `Delegate the complete file operation to ${name}, then wait for its terminal result. ${fileRoundtrip.prompt}`,
      tools: restrict ? tools : [], requireAllSelectedTools: false,
      subagent: { name, tools, restrict, expectedTools: tools, requireAllSelectedTools: true, calls: fileRoundtrip.calls },
      calls: [[{ name: 'start_subagent', args: { agent: name, description: fileRoundtrip.prompt } }],
        [{ name: 'wait_subagent', args: { timeout: 10 }, binding: 'subagent' }]],
      modelChecks: (['ordinary', 'coding'] as const).flatMap((mode): ModelRequestCheck[] => [
        ...[1, 2, 3].map((call): ModelRequestCheck => ({ role: 'main', call, mode,
          files: call === 1 || call === 3 ? { 'work.txt': 'before\n' } : {},
          toolsInclude: ['start_subagent', 'wait_subagent', ...(restrict ? tools : [])],
          toolsExclude: ['run_shell', ...(restrict ? [] : tools)] })),
        ...Array.from({ length: 12 }, (_, index): ModelRequestCheck => ({ role: 'subagent', call: index + 1, mode,
          files: { 'work.txt': index === 9 || index === 10 ? 'after\n' : 'before\n' },
          toolsInclude: tools, toolsExclude: ['run_shell', 'start_subagent'] }))
      ])
    }
  })
]

export const pendingCodingEvaluations = [
  'Real providers: multiline patch quality across the actual calling protocols and models.',
  'Real models: matched ordinary/coding and compression-continuation quality comparisons.',
  'Independent semantic adjudication of review findings; location/priority scores are not correctness judgments.',
  'Real-repository rg performance and remaining file-tool capability boundaries; bounded scripted search is not a model-quality benchmark.',
  'Concurrent/external edits and authorization-time mode changes.',
  'Nested subagent attribution, undo/history cleanup and crash recovery quality.',
  'Current-version cross-platform integration and signed/notarized package acceptance.'
]
