import { describe, expect, it, vi } from 'vitest'
import { HumanMessage, AIMessage, mapStoredMessageToChatMessage } from '@langchain/core/messages'
import { Command, interrupt, MemorySaver } from '@langchain/langgraph'
import { createAgent, createMiddleware, FakeToolCallingModel } from 'langchain'
import { createPatch } from 'diff'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { captureCodeReview, codeReviewPrompt, validateCodeReviewSnapshot } from './codeReview'
import { codeReviewResponseFormat, createCodeReviewMiddleware, reviewSnapshotForIntent } from './codeReviewMiddleware'
import { reviewLocations, type CodeReviewReport } from '@shared/codeReview'
import { toAgentMessage } from './messageMapper'
import type { AgentDatabase } from './agentDatabase'
import { isModelSelectionError } from './modelSelection'

const mocks = vi.hoisted(() => ({ project: vi.fn(), git: vi.fn() }))
vi.mock('../projectStore', () => ({ getProject: mocks.project }))
vi.mock('../gitChanges', () => ({ queryGitChanges: mocks.git }))
const version = 'a'.repeat(64)
const request = { kind: 'recorded' as const, threadId: 'thread', runId: 'source-run', version, target: 'recorded' as const }
function source(overrides: Record<string, unknown> = {}) {
  return { getRun: () => ({ threadId: 'thread' }), getThread: () => ({ projectId: 'project' }),
    fileChanges: {
      queryRoundFiles: vi.fn(() => ({ runId: 'source-run', version, hasMore: false, pendingRunIds: [], issues: [],
        files: [{ path: '/project/a.ts', continuity: 'recorded' }], ...overrides })),
      readRoundContent: vi.fn(() => ({ status: 'ready', path: '/project/a.ts', before: 'const a = 1\n', after: 'const a = 2\n', beforeExists: true, afterExists: true }))
    }

  } as unknown as AgentDatabase
}
const snapshot = () => captureCodeReview(source(), request, 'project')

describe('code review scope capture', () => {
  it('freezes a bounded identified snapshot and rejects tampering after a JSON round trip', async () => {
    const value = await snapshot()
    expect(validateCodeReviewSnapshot(JSON.parse(JSON.stringify(value)))).toEqual(value)
    expect(value.files[0].after).toEqual([{ start: 1, end: 1 }])
    expect(() => validateCodeReviewSnapshot({ ...value, description: 'different' })).toThrow('identity')
    expect(codeReviewPrompt(value)).toContain('not a request to fix, edit, commit or push')
  })
  it('checks actual conversation, project and run ownership', async () => {
    await expect(captureCodeReview(source(), { ...request, threadId: 'other' }, 'project')).rejects.toThrow('belong')
    await expect(captureCodeReview(source(), request, 'other')).rejects.toThrow('belong')
  })
  it.each([{ hasMore: true }, { pendingRunIds: ['child'] }, { files: [] },
    { files: [{ unavailableReason: 'lost' }] }])('rejects a scope that cannot be reviewed intact: %o', async (value) => {
    await expect(captureCodeReview(source(value), request, 'project')).rejects.toThrow()
  })
  it('retains uncertainty instead of pretending discontinuous recorded changes are exact net changes', async () => {
    const database = source({ issues: [{ path: '/project/a.ts', reason: 'external change' }] })
    const value = await captureCodeReview(database, request, 'project')
    expect(value.limitations).toEqual(['/project/a.ts: external change'])
    expect(database.fileChanges.queryRoundFiles).toHaveBeenCalledWith(expect.objectContaining({ version }))
  })
  it('captures the displayed current-file target instead of silently reviewing the archived result', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'anas-round-review-')))
    try {
      const path = join(root, 'example.ts')
      await writeFile(path, 'const a = 3\n')
      const database = source({ files: [{ path, continuity: 'recorded' }] })
      vi.mocked(database.fileChanges.readRoundContent).mockReturnValue({ status: 'ready', path,
        before: 'const a = 1\n', after: 'const a = 2\n', beforeExists: true, afterExists: true })
      const archived = await captureCodeReview(database, request, 'project')
      const current = await captureCodeReview(database, { ...request, target: 'current' }, 'project')
      expect(archived.files[0].patch).toContain('+const a = 2')
      expect(current.files[0].patch).toContain('+const a = 3')
      expect(current.files[0].patch).not.toContain('+const a = 2')
      expect(current.request).toMatchObject({ target: 'current' })
      await writeFile(path, 'const a = 4\n')
      expect(validateCodeReviewSnapshot(current).files[0].patch).toContain('+const a = 3')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('pins every Git page to the user-selected version and uses resolved commits', async () => {
    mocks.project.mockResolvedValue({ kind: 'workspace', sourceFolders: ['/repo'] })
    mocks.git.mockResolvedValueOnce({ files: [{ path: '/repo/a', patch: createPatch('a', 'old\n', 'new\n') }],
      baseline: 'b'.repeat(40), head: 'c'.repeat(40), sourceFolder: '/repo', hasMore: true, nextAfter: 20 })
      .mockResolvedValueOnce({ files: [], baseline: 'b'.repeat(40), head: 'c'.repeat(40), sourceFolder: '/repo', hasMore: false })
    const value = await captureCodeReview(source(), { kind: 'git', projectId: 'project', sourceFolder: '/repo', scope: 'baseline', baseline: 'main', version }, 'project')
    expect(value.description).toContain(`${'b'.repeat(40)} → ${'c'.repeat(40)}`)
    expect(mocks.git).toHaveBeenLastCalledWith(expect.objectContaining({ after: 20, version }), expect.any(AbortSignal))
  })
  it('regeneration uses the original checkpoint scope, not today’s files', async () => {
    const value = await snapshot()
    const message = new HumanMessage({ content: codeReviewPrompt(value), additional_kwargs: { anas_code_review_scope: value } })
    expect(reviewSnapshotForIntent({ kind: 'regeneration', message: message.toDict() })).toEqual(value)
  })

  it('projects the full review user message from checkpoint content without substituting a display title', async () => {
    const value = await snapshot(), prompt = codeReviewPrompt(value)
    const stored = new HumanMessage({ content: prompt,
      additional_kwargs: { anas_display_text: '代码审核', anas_code_review_scope: value } }).toDict()
    const message = mapStoredMessageToChatMessage(stored)
    const projected = toAgentMessage(message, 'review-input')
    expect(projected.content).toEqual([{ type: 'text', text: message.text }])
    expect(projected.content).toEqual([{ type: 'text', text: prompt }])
    expect(prompt).toContain(value.files[0].patch)
    expect(projected.skillInvocation).toBeUndefined()
  })
})

describe('framework-native structured review', () => {
  it('resumes after the model checkpoint without regenerating the report or relying on ephemeral output', async () => {
    const scope = await snapshot(), format = codeReviewResponseFormat(scope), checkpointer = new MemorySaver()
    const report = { scope_id: scope.id, summary: 'Stored review', findings: [], limitations: [] }
    const finalization = createMiddleware({ name: 'FinalizeReview', afterAgent: () => { interrupt('Pause after the report checkpoint'); return undefined } })
    const model = new FakeToolCallingModel({ toolCalls: [[{ id: 'report', name: format[0].name, args: report }]] })
    const config = { configurable: { thread_id: 'resume-review' } }
    const first = createAgent({ model, checkpointer, responseFormat: format,
      middleware: [finalization, createCodeReviewMiddleware(scope, 'run', () => 100_000, () => ({ protocol: 'openai_chat_completions' }))] })
    await first.invoke({ messages: [new HumanMessage(codeReviewPrompt(scope))] }, config)
    const pending = await first.getState(config) as { tasks: Array<{ interrupts?: unknown[] }> }
    expect(pending.tasks.some((task) => task.interrupts?.length)).toBe(true)
    const unusedModel = new FakeToolCallingModel({ toolCalls: [[]] })
    const resumed = createAgent({ model: unusedModel, checkpointer, responseFormat: codeReviewResponseFormat(scope),
      middleware: [finalization, createCodeReviewMiddleware(scope, 'run', () => 100_000, () => ({ protocol: 'openai_chat_completions' }))] })
    const result = await resumed.invoke(new Command({ resume: true }), config)
    expect(unusedModel.index).toBe(0)
    expect(result.messages.filter((message) => message.id === 'run:review-report')).toHaveLength(1)
    expect(toAgentMessage(result.messages.at(-1)!, 'final').codeReview?.report).toEqual(report)
  })
  it('does not checkpoint an unanswered investigation call beside a final report', async () => {
    const scope = await snapshot(), format = codeReviewResponseFormat(scope)
    const model = new FakeToolCallingModel({ toolCalls: [[
      { name: format[0].name, id: 'report', args: { scope_id: scope.id, summary: 'Done', findings: [], limitations: [] } },
      { name: 'read_file', id: 'read', args: { path: '/repo/a' } }
    ]] })
    const agent = createAgent({ model, responseFormat: format, middleware: [createCodeReviewMiddleware(scope, 'run', () => 100_000, () => ({ protocol: 'openai_chat_completions' }))] })
    await expect(agent.invoke({ messages: [new HumanMessage('Review')] })).rejects.toThrow('separately')
  })
  it('does not mistake a plain answer for a completed structured review', async () => {
    const scope = await snapshot()
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[]] }), responseFormat: codeReviewResponseFormat(scope), middleware: [createCodeReviewMiddleware(scope, 'run', () => 100_000, () => ({ protocol: 'openai_chat_completions' }))] })
    await expect(agent.invoke({ messages: [new HumanMessage('Review')] })).rejects.toThrow('without the required structured report')
  })
  it('keeps a framework v1 report readable after adding the review presentation', async () => {
    const scope = await snapshot(), format = codeReviewResponseFormat(scope)
    const report = { scope_id: scope.id, summary: 'No regressions.', findings: [], limitations: [] }
    const model = new FakeToolCallingModel({ toolCalls: [[{ id: 'report', name: format[0].name, args: report }]] })
    const nativeBlocks = createMiddleware({ name: 'StandardReportContent', wrapModelCall: async (request, handler) => {
      const response = await handler(request)
      if (response && typeof response === 'object' && 'messages' in response && Array.isArray(response.messages)) {
        const last = response.messages.at(-1)
        if (AIMessage.isInstance(last)) {
          last.content = [{ type: 'text', text: last.text }]
          last.response_metadata = { ...last.response_metadata, output_version: 'v1' }
        }
      }
      return response
    } })
    const agent = createAgent({ model, responseFormat: format,
      middleware: [createCodeReviewMiddleware(scope, 'run', () => 100_000, () => ({ protocol: 'openai_chat_completions' })), nativeBlocks] })
    const result = await agent.invoke({ messages: [new HumanMessage('Review')] })
    expect(result.messages.at(-1)!.text).toBe('No regressions.')
    expect(toAgentMessage(result.messages.at(-1)!, 'final').codeReview?.report).toEqual(report)
  })
  it('checkpoints the report with its final model message and keeps normal later replies ordinary', async () => {
    const scope = await snapshot(), format = codeReviewResponseFormat(scope)
    const report: CodeReviewReport = { scope_id: scope.id, summary: 'No confirmed defects.', findings: [], limitations: ['Tests not run.'] }
    const model = new FakeToolCallingModel({ toolCalls: [[{ name: format[0].name, id: 'report', args: report }]] })
    const checkpointer = new MemorySaver(), config = { configurable: { thread_id: 'review' } }
    const agent = createAgent({ model, checkpointer, responseFormat: format,
      middleware: [createCodeReviewMiddleware(scope, 'review-run', () => 100_000, () => ({ protocol: 'openai_chat_completions' }))] })
    await agent.invoke({ messages: [new HumanMessage(codeReviewPrompt(scope))] }, config)
    const state = await agent.getState(config) as { values: { messages: AIMessage[] } }
    const final = (state.values.messages as AIMessage[]).at(-1)!
    expect(final.id).toBe('review-run:review-report')
    expect(toAgentMessage(final, 'fallback').codeReview?.report).toEqual(report)
    expect(toAgentMessage(final, 'fallback').content).toEqual([{ type: 'text', text: 'No confirmed defects.\n\nTests not run.' }])
    const normal = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[]] }), checkpointer })
    const next = await normal.invoke({ messages: [new HumanMessage('Thanks')] }, config)
    expect(toAgentMessage(next.messages.at(-1)!, 'next').codeReview).toBeUndefined()
    expect(next.messages.filter((message) => message.id === final.id)).toHaveLength(1)
  })
  it('rejects a scope that leaves insufficient model context before making a model call', async () => {
    const scope = await snapshot(), model = new FakeToolCallingModel({ toolCalls: [[]] })
    const agent = createAgent({ model, responseFormat: codeReviewResponseFormat(scope), middleware: [createCodeReviewMiddleware(scope, 'run', () => 20, () => ({ protocol: 'openai_chat_completions' }))] })
    const failure = await agent.invoke({ messages: [new HumanMessage('Review')] }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('too large')
    expect(isModelSelectionError(failure)).toBe(true)
    expect(model.index).toBe(0)
  })
  it('reserves configured Responses instructions before accepting the review scope', async () => {
    const scope = await snapshot(), model = new FakeToolCallingModel({ toolCalls: [[]] })
    const agent = createAgent({ model, responseFormat: codeReviewResponseFormat(scope), middleware: [
      createCodeReviewMiddleware(scope, 'run', () => 100_000,
        () => ({ protocol: 'openai_responses', parameters: { instructions: 'x'.repeat(260_000) } }))
    ] })
    const failure = await agent.invoke({ messages: [new HumanMessage('Review')] }).catch((error: unknown) => error)
    expect(isModelSelectionError(failure)).toBe(true)
    expect(model.index).toBe(0)
  })
  it('validates file identity and hunk line ranges without converting uncertainty into clickable locations', async () => {
    const scope = await snapshot()
    const finding = { priority: 'P2' as const, title: 'Defect', file_id: 'file-1', side: 'after' as const,
      start_line: 1, end_line: 1, condition: 'Trigger', impact: 'Impact', evidence: 'Evidence' }
    const report = { scope_id: scope.id, summary: 'Results', findings: [finding, { ...finding, file_id: 'unknown' }, { ...finding, end_line: 2 }], limitations: [] }
    expect(reviewLocations(scope, report).map((entry) => entry.valid)).toEqual([true, false, false])
    expect(reviewLocations(scope, { ...report, scope_id: version }).every((entry) => !entry.valid)).toBe(true)
  })
})
