import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, posix, relative, resolve, sep } from 'node:path'
import type { AgentAccessMode } from '@shared/agentTypes'
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { reviewLocations, type CodeReviewPresentation, type CodeReviewReport, type CodeReviewSnapshot } from '@shared/codeReview'
import type { CodingTask, ModelRequestCheck, ReviewTarget } from './codingTasks'
import { runBehaviorTests, type BehaviorResult } from './codingBehavior'
import type { CodingModelTrace, CodingTokenUsage } from './codingModelTrace'
import type { checkSearchOutput } from './codingSearch'

export const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function codingDiagnostic(value: unknown) {
  const text = JSON.stringify(value)
  return { fingerprint: fingerprint(value), characters: text.length, excerpt: text.slice(0, 4000), truncated: text.length > 4000 }
}

export async function sourceFingerprints(root: string, files: string[]): Promise<Record<string, string>> {
  const entries = await Promise.all(files.map(async (file) => {
    try {
      return [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')] as const
    } catch (error) {
      // git ls-files still lists tracked files deleted during a run.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }))
  return Object.fromEntries(entries.filter((entry) => entry !== undefined))
}

export function changedSources(before: Record<string, string>, after: Record<string, string>): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((file) => before[file] !== after[file]).sort()
}

export function parseToolOutput(output: unknown): unknown {
  if (typeof output !== 'string') return output
  try { return JSON.parse(output) } catch { return output }
}

/** Resolve references only from this model's native input, never another run's events. */
export function toolResultsFromMessages(messages: BaseMessage[]) {
  const names = new Map<string, string>()
  return messages.flatMap((message) => {
    if (AIMessage.isInstance(message)) for (const call of message.tool_calls ?? []) {
      if (call.id) names.set(call.id, call.name)
    }
    if (!ToolMessage.isInstance(message)) return []
    const name = names.get(message.tool_call_id)
    if (!name || (message.name !== undefined && message.name !== name)) return []
    return [{ id: message.tool_call_id, name, output: message.content, failed: message.status === 'error' }]
  })
}

export function scriptBinding(messages: BaseMessage[], binding: 'patch' | 'subagent'): Record<string, string> {
  const name = binding === 'patch' ? 'apply_patch' : 'start_subagent'
  const result = toolResultsFromMessages(messages).reverse().find((result) =>
    result.name === name && !result.failed && !toolOutputFailed(result.output))
  const output = parseToolOutput(result?.output) as Record<string, unknown> | undefined
  const fields = binding === 'patch'
    ? { operation_id: 'operationId', request_id: 'recoveryRequestId' } : { subagent_id: 'subagent_id' }
  if (!output || output.ok !== true || Object.values(fields).some((field) => typeof output[field] !== 'string' || !output[field])) {
    throw new Error(`A successful ${name} result in the current model input is required for ${binding} binding.`)
  }
  return Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, output[field] as string]))
}

export function toolOutputFailed(output: unknown): boolean {
  const value = parseToolOutput(output)
  // Project/tool preflight uses an error ToolMessage with this plain-text
  // prefix. Successful read contents remain inside their JSON result envelope.
  if (typeof value === 'string') return value.startsWith('NOT EXECUTED:')
  if (!value || typeof value !== 'object') return false
  const result = value as { ok?: boolean; files?: Array<{ ok?: boolean }> }
  return result.ok === false || result.files?.some((file) => file.ok === false) === true
}

export function fixturePath(root: string, name: string): string {
  if (!name || name.includes('\\') || posix.isAbsolute(name) || name.split('/').some((part) => !part || part === '.' || part === '..') || name.includes(':')) {
    throw new Error(`Invalid fixture path: ${name}`)
  }
  const target = resolve(root, name)
  if (!relative(root, target) || relative(root, target).startsWith(`..${sep}`)) throw new Error('Fixture target escapes its root.')
  return target
}

export async function writeFixture(root: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    const target = fixturePath(root, name)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, { encoding: 'utf8', flag: 'wx' })
  }
}

export async function snapshotFiles(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = Object.create(null)
  let bytes = 0
  async function visit(directory: string, prefix = ''): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      if (!prefix && name === '.git') continue
      const key = prefix ? `${prefix}/${name}` : name
      const target = join(directory, name), info = await lstat(target)
      if (info.isSymbolicLink()) throw new Error(`Unexpected evaluation symlink: ${key}`)
      if (info.isDirectory()) {
        if (key.split('/').length > 16) throw new Error('Evaluation directory depth exceeded.')
        await visit(target, key)
      } else {
        bytes += info.size
        if (bytes > 8_000_000 || Object.keys(result).length >= 2000 || !info.isFile()) throw new Error('Evaluation snapshot budget exceeded.')
        result[key] = createHash('sha256').update(await readFile(target)).digest('hex')
      }
    }
  }
  await visit(root)
  return result
}

export async function checkModelRequest(check: ModelRequestCheck, root: string, input: {
  systemText: string
  conversationText: string
  toolNames?: string[]
}) {
  const prefix = `model-request:${check.role === 'subagent' ? 'subagent:' : ''}${check.call}`
  const checks = await Promise.all(Object.entries(check.files).map(async ([name, expected]) => ({
    name: `${prefix}:file:${name}`,
    passed: await readFile(fixturePath(root, name), 'utf8').then((actual) => actual === expected, () => false)
  })))
  checks.push(...await Promise.all((check.absent ?? []).map(async (name) => ({
    name: `${prefix}:absent:${name}`,
    passed: await lstat(fixturePath(root, name)).then(() => false, (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
  }))))
  for (const [index, text] of (check.systemIncludes ?? []).entries()) {
    checks.push({ name: `${prefix}:complete-rule:${index}`, passed: input.systemText.includes(text) })
  }
  for (const [index, text] of (check.systemExcludes ?? []).entries()) {
    checks.push({ name: `${prefix}:unseen-rule:${index}`, passed: !input.systemText.includes(text) })
  }
  for (const [index, text] of (check.conversationIncludes ?? []).entries()) {
    checks.push({ name: `${prefix}:conversation:${index}`, passed: input.conversationText.includes(text) })
  }
  for (const name of check.toolsInclude ?? []) checks.push({ name: `${prefix}:tool-included:${name}`,
    passed: input.toolNames?.includes(name) === true })
  for (const name of check.toolsExclude ?? []) checks.push({ name: `${prefix}:tool-excluded:${name}`,
    passed: input.toolNames !== undefined && !input.toolNames.includes(name) })
  return checks
}

export async function checkTaskFiles(task: CodingTask, root: string, before: Record<string, string>, signal?: AbortSignal) {
  for (const item of task.behavior ?? []) fixturePath(root, item.module)
  const behavior = task.behavior ? await runBehaviorTests(root, task.behavior, signal) : null
  const after = await snapshotFiles(root)
  const checks = behavior ? [{ name: 'behavior-tests', passed: behavior.status === 'passed' }]
    : await Promise.all(Object.entries(task.expected).map(async ([name, expected]) => ({
    name: `expected:${name}`,
    passed: await readFile(fixturePath(root, name), 'utf8').then((actual) => actual === expected, () => false)
  })))
  for (const name of task.absent ?? []) {
    const missing = await lstat(fixturePath(root, name)).then(() => false, (error: NodeJS.ErrnoException) => error.code === 'ENOENT')
    checks.push({ name: `absent:${name}`, passed: missing })
  }
  for (const name of task.directories ?? []) {
    checks.push({ name: `directory:${name}`, passed: await lstat(fixturePath(root, name)).then((info) => info.isDirectory(), () => false) })
  }
  const unrelatedChanges = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((name) => !Object.hasOwn(task.expected, name) && !task.absent?.includes(name) && before[name] !== after[name])
  checks.push({ name: 'preserve-unrelated-files', passed: unrelatedChanges.length === 0 })
  return { checks, unrelatedChanges, after, behavior }
}

/** Measures location/severity only; free-text semantic correctness needs a separate judge. */
export function scoreReview(scope: CodeReviewSnapshot, report: CodeReviewReport, targets: ReviewTarget[]) {
  const locations = reviewLocations(scope, report)
  const matched = new Set<number>()
  let unmatchedFindings = 0
  for (const [index, finding] of report.findings.entries()) {
    const path = scope.files.find((file) => file.id === finding.file_id)?.path
    const targetIndex = targets.findIndex((target, targetIndex) => !matched.has(targetIndex)
      && locations[index].valid && target.path === path && target.side === finding.side
      && target.priority === finding.priority && finding.start_line >= target.start && finding.end_line <= target.end)
    if (targetIndex < 0) unmatchedFindings += 1
    else matched.add(targetIndex)
  }
  return {
    rubric: 'location-and-priority' as const,
    scopeMatched: report.scope_id === scope.id,
    expectedFindings: targets.length, matchedFindings: matched.size, unmatchedFindings,
    missedFindings: targets.length - matched.size,
    precision: report.findings.length ? matched.size / report.findings.length : null,
    recall: targets.length ? matched.size / targets.length : null,
    semanticCorrectness: null
  }
}

export interface CodingEvaluationResult {
  taskId: string
  category: string
  taskFingerprint: string
  mode: 'ordinary' | 'coding'
  accessMode: AgentAccessMode
  sample: number
  status: 'passed' | 'failed'
  evidence: 'scripted-runtime' | 'provider-runtime'
  model: { name: string; parameters: Record<string, unknown>; protocol: string | null }
  shellEnabled: boolean
  shellToolName?: string
  startedAt: string
  elapsedMs: number
  modelCalls: number
  toolCalls: number
  toolErrors: number
  approvalRequests: number
  interruptions: Array<{ runId: string; interruptId: string; value: ReturnType<typeof codingDiagnostic>; pathPreviews: ReturnType<typeof codingDiagnostic> }>
  tokens: CodingTokenUsage | null
  modelTrace: CodingModelTrace | null
  modelQuality: null
  agentExecutedTests: null
  evaluatorTests: BehaviorResult | null
  reviewScore: ReturnType<typeof scoreReview> | null
  reviewReport?: CodeReviewPresentation
  compression: 'not-requested' | 'completed' | 'failed'
  checkpointReopened: boolean
  toolOutputs: Array<{ name: string; excerpt: string; source: 'tool-event' | 'checkpoint' }>
  searchOutputs: Array<ReturnType<typeof checkSearchOutput> & { callId: string; name: string }>
  checks: Array<{ name: string; passed: boolean }>
  unrelatedChanges: string[]
  errors: string[]
  expectedRunFailures?: string[]
}
