import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolMessage } from '@langchain/core/messages'
import { createAgent, FakeToolCallingModel } from 'langchain'
import { UserInputService, userInputService } from './userInputService'
import { createRuntimeTools } from '../llm/runtimeTools'
import { supportsManagedTool } from './managedToolExecution'
import { userInputSchema } from '@shared/userInput'
import { createToolInputErrorMiddleware } from './toolInputErrors'

const questions = [{ id: 'format', question: 'Choose output', options: [{ label: 'PDF' }, { label: 'Text' }] }]
const context = { threadId: 'thread', runId: 'run', source: { projectName: 'Project', threadTitle: 'Conversation' } }
const answered = { status: 'answered', answers: [{ question_id: 'format', selected_options: ['PDF'], other: '' }] }
afterEach(() => vi.useRealTimers())

describe('user input waiting', () => {
  it('starts the default timeout when displayed and does not extend it on redisplay', async () => {
    vi.useFakeTimers()
    const service = new UserInputService()
    const result = service.request({ questions }, context)
    const id = service.snapshot().requests[0].id
    await vi.advanceTimersByTimeAsync(20_000)
    service.shown(id)
    const deadline = service.snapshot().requests[0].deadline
    await vi.advanceTimersByTimeAsync(59_000)
    service.shown(id)
    expect(service.snapshot().requests[0].deadline).toBe(deadline)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(await result).toEqual({ status: 'timed_out' })
    expect(service.snapshot().requests).toEqual([])
    expect(service.respond(id, answered)).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits without a deadline when required and still cancels on abort', async () => {
    vi.useFakeTimers()
    const service = new UserInputService(), controller = new AbortController()
    const result = service.request({ questions, require_response: true, timeout_seconds: 30 }, { ...context, signal: controller.signal })
    service.shown(service.snapshot().requests[0].id)
    await vi.advanceTimersByTimeAsync(3_600_000)
    expect(service.snapshot().requests[0].deadline).toBeUndefined()
    controller.abort()
    expect(await result).toEqual({ status: 'cancelled' })
    expect(service.snapshot().requests).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['answered', 'cancelled', 'abort'])('cancels the timeout after interaction and can still finish with %s', async status => {
    vi.useFakeTimers()
    const service = new UserInputService(), controller = new AbortController()
    const result = service.request({ questions, timeout_seconds: 30 }, { ...context, signal: controller.signal })
    const id = service.snapshot().requests[0].id
    expect(service.interact(id)).toBe(false)
    service.shown(id)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(service.interact(id)).toBe(true)
    expect(service.snapshot().requests[0].interacted).toBe(true)
    expect(service.snapshot().requests[0].deadline).toBeUndefined()
    service.shown(id)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(service.interact(id)).toBe(true)
    expect(service.snapshot().requests).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
    if (status === 'abort') controller.abort()
    else service.respond(id, status === 'answered' ? answered : { status: 'cancelled' })
    expect(await result).toEqual(status === 'answered' ? answered : { status: 'cancelled' })
    expect(service.snapshot().requests).toEqual([])
    expect(service.interact(id)).toBe(false)
  })

  it('does not revive an expired question on late interaction', async () => {
    vi.useFakeTimers()
    const service = new UserInputService()
    const result = service.request({ questions, timeout_seconds: 30 }, context)
    const id = service.snapshot().requests[0].id
    service.shown(id)
    vi.setSystemTime(Date.now() + 30_000)
    expect(service.interact(id)).toBe(false)
    expect(await result).toEqual({ status: 'timed_out' })
    expect(service.snapshot().requests).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('validates answers and settles only once, accepting Other and multiple choices', async () => {
    vi.useFakeTimers()
    const service = new UserInputService()
    const result = service.request({ questions }, context)
    const id = service.snapshot().requests[0].id
    service.shown(id)
    expect(() => service.respond(id, { ...answered, answers: [{ ...answered.answers[0], selected_options: ['Unknown'] }] })).toThrow()
    expect(() => service.respond(id, { ...answered, answers: [answered.answers[0], answered.answers[0]] })).toThrow()
    const other = { ...answered, answers: [{ question_id: 'format', selected_options: [], other: 'Markdown' }] }
    expect(service.respond(id, other)).toBe(true)
    expect(service.respond(id, { status: 'cancelled' })).toBe(false)
    expect(await result).toEqual(other)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(vi.getTimerCount()).toBe(0)
    const multiple = service.request({ questions: [{ ...questions[0], multiple: true }] }, context)
    const nextId = service.snapshot().requests[0].id
    service.shown(nextId)
    const both = { ...answered, answers: [{ ...answered.answers[0], selected_options: ['PDF', 'Text'] }] }
    expect(service.respond(nextId, both)).toBe(true)
    expect(await multiple).toEqual(both)
  })

  it('rejects late submission even if the timer callback has not run yet', async () => {
    vi.useFakeTimers()
    const service = new UserInputService()
    const result = service.request({ questions, timeout_seconds: 30 }, context)
    const id = service.snapshot().requests[0].id
    service.shown(id)
    vi.setSystemTime(Date.now() + 30_000)
    expect(service.respond(id, answered)).toBe(false)
    expect(await result).toEqual({ status: 'timed_out' })
  })

  it('bounds undelivered dialogs and keeps concurrent requests independent', async () => {
    vi.useFakeTimers()
    const service = new UserInputService(), controller = new AbortController()
    const first = service.request({ questions }, { ...context, signal: controller.signal })
    const second = service.request({ questions }, { ...context, threadId: 'child' })
    controller.abort()
    expect(await first).toEqual({ status: 'cancelled' })
    expect(service.snapshot().requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(await second).toEqual({ status: 'cancelled' })
    expect(service.snapshot().requests).toEqual([])
  })

  it.each([-1, 0, 29, 601, 30.5])('rejects invalid timeout %s', timeout_seconds => {
    expect(userInputSchema.safeParse({ questions, timeout_seconds }).success).toBe(false)
  })

  it.each([
    { label: 'question IDs', invalid: [questions[0], { ...questions[0], id: ' format ' }], path: ['questions', 1, 'id'] },
    { label: 'option labels', invalid: [{ ...questions[0], options: [{ label: 'PDF' }, { label: ' PDF ', description: 'A duplicate choice' }] }], path: ['questions', 0, 'options', 1, 'label'] }
  ])('returns duplicate $label as a tool input error and accepts a corrected call', async ({ invalid, path }) => {
    vi.useFakeTimers()
    const parsed = userInputSchema.safeParse({ questions: invalid })
    expect(parsed.success).toBe(false)
    if (!parsed.success) expect(parsed.error.issues[0].path).toEqual(path)
    const controller = new AbortController()
    const tools = await createRuntimeTools({ enabled: true, primaryFolder: '.', threadId: 'thread', runId: 'run',
      userInputSource: async () => context.source,
      memory: false, network: false, shell: false, mcp: false, signal: controller.signal })
    const ask = tools.find(tool => tool.name === 'request_user_input')!
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [
      [{ id: 'invalid', name: ask.name, args: { questions: invalid } }],
      [{ id: 'corrected', name: ask.name, args: { questions } }], []
    ] }), tools: [ask], middleware: [createToolInputErrorMiddleware()] })
    const run = agent.invoke({ messages: [{ role: 'user', content: 'Ask me' }] })
    // Observe rejection immediately so a regression fails without an unhandled promise.
    const settled = run.then(output => ({ output }), error => ({ error }))
    try {
      for (let i = 0; i < 30 && !userInputService.snapshot().requests.length; i++) await vi.advanceTimersByTimeAsync(0)
      expect(userInputService.snapshot().requests).toHaveLength(1)
      expect(userInputService.snapshot().requests[0].questions).toEqual(questions)
      const id = userInputService.snapshot().requests[0].id
      userInputService.shown(id)
      userInputService.respond(id, answered)
      const output = await run
      const results = output.messages.filter(ToolMessage.isInstance)
      expect(results.map(result => result.tool_call_id)).toEqual(['invalid', 'corrected'])
      expect(results[0].status).toBe('error')
      expect(results[0].content).toContain('unique')
      expect(JSON.parse(String(results[1].content))).toEqual(answered)
      expect(output.messages.at(-1)?.type).toBe('ai')
      expect(userInputService.snapshot().requests).toEqual([])
    } finally { controller.abort(); await settled }
  })

  it('preserves queued questions until they can be displayed', async () => {
    vi.useFakeTimers()
    const service = new UserInputService()
    const first = service.request({ questions, require_response: true }, context)
    const firstId = service.snapshot().requests[0].id
    service.shown(firstId)
    const second = service.request({ questions, timeout_seconds: 30 }, context)
    const secondId = service.snapshot().requests[1].id
    expect(service.shown(secondId)).toBe(false)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(service.snapshot().requests).toHaveLength(2)
    service.respond(firstId, { status: 'cancelled' })
    expect(await first).toEqual({ status: 'cancelled' })
    service.shown(secondId)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(await second).toEqual({ status: 'timed_out' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['answered', 'timed_out'] as const)('returns %s to the native model loop without detaching', async status => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const tools = await createRuntimeTools({ enabled: true, primaryFolder: '.', threadId: 'thread', runId: 'run',
      userInputSource: async () => context.source,
      memory: false, network: false, shell: false, mcp: false, signal: controller.signal, backgroundTools: true })
    const ask = tools.find(tool => tool.name === 'request_user_input')!
    expect(supportsManagedTool(ask)).toBe(false)
    const agent = createAgent({ model: new FakeToolCallingModel({
      toolCalls: [[{ id: 'ask-1', name: ask.name, args: { questions, timeout_seconds: 30 } }], []]
    }), tools: [ask] })
    try {
      let finished = false
      const run = agent.invoke({ messages: [{ role: 'user', content: 'Ask me' }] }).then(value => { finished = true; return value })
      for (let i = 0; i < 30 && !userInputService.snapshot().requests.length; i++) await vi.advanceTimersByTimeAsync(0)
      const id = userInputService.snapshot().requests[0].id
      expect(userInputService.snapshot().requests[0].source).toEqual(context.source)
      userInputService.shown(id)
      await vi.advanceTimersByTimeAsync(11_000)
      expect(finished).toBe(false)
      if (status === 'answered') userInputService.respond(id, answered)
      else await vi.advanceTimersByTimeAsync(19_000)
      const output = await run
      const toolResult = output.messages.find(ToolMessage.isInstance)!
      expect(toolResult.tool_call_id).toBe('ask-1')
      expect(JSON.parse(String(toolResult.content)).status).toBe(status)
      expect(output.messages.at(-1)?.type).toBe('ai')
      expect(userInputService.snapshot().requests).toEqual([])
    } finally { controller.abort() }
  })
})
