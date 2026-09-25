import { ToolMessage } from '@langchain/core/messages'
import { tool, ToolInputParsingException } from '@langchain/core/tools'
import { Command, interrupt, MemorySaver } from '@langchain/langgraph'
import { createAgent, createMiddleware, FakeToolCallingModel, MiddlewareError, ToolInvocationError } from 'langchain'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v3'
import { createToolInputErrorMiddleware, createToolInputValidationMiddleware, formatAgentToolInputError } from './toolInputErrors'
import { AgentDatabase } from './agentDatabase'
import { canonicalAgentToolEffectJson, createAgentToolEffectMiddleware } from './toolEffectMiddleware'

describe('tool input errors', () => {
  it('preserves schema guidance through middleware wrappers without exposing stack traces', () => {
    const schemaError = new ToolInputParsingException('Number must be less than or equal to 300 at timeout')
    schemaError.stack = `${schemaError.message}\nat DynamicStructuredTool.call (D:\\private\\source\\tools.ts:114:10)`
    const invocation = new ToolInvocationError(schemaError, {
      id: 'wait-call', name: 'wait_call', args: { timeout: 600 }, type: 'tool_call'
    })
    const wrapped = MiddlewareError.wrap(MiddlewareError.wrap(invocation, 'inner'), 'outer')
    expect(formatAgentToolInputError(wrapped, 'wait_call')).toBe(
      "Tool 'wait_call' received invalid input:\n"
      + 'Number must be less than or equal to 300 at timeout\n'
      + 'Correct the arguments and try again.'
    )
    expect(formatAgentToolInputError(new Error('Invalid arguments in stored checkpoint'), 'wait_call')).toBeUndefined()
  })

  it.each(['schema', 'tool', 'middleware'] as const)('lets the model correct a %s error in the next round', async source => {
    const execute = vi.fn(({ target }: { target: string }) => {
      if (source === 'tool' && target === 'missing') throw new ToolInputParsingException('Target missing does not exist. Use available.')
      return `Read ${target}`
    })
    const read = tool(execute, { name: 'read_target', description: 'Read an available target.', schema: z.object({ target: z.string() }) })
    const model = new FakeToolCallingModel({ toolCalls: [
      [{ id: 'invalid', name: read.name, args: { target: source === 'schema' ? 7 : 'missing' } }],
      [{ id: 'corrected', name: read.name, args: { target: 'available' } }], []
    ] })
    const observed: ToolMessage[] = []
    const agent = createAgent({ model, tools: [read], middleware: [
      createToolInputErrorMiddleware(),
      createMiddleware({ name: 'TargetPreflight', wrapToolCall: (request, handler) => {
        if (source === 'middleware' && request.toolCall.args.target === 'missing') {
          throw new ToolInputParsingException('Target missing does not exist. Use available.')
        }
        return handler(request)
      }, beforeModel: state => { observed.push(...state.messages.filter(ToolMessage.isInstance)) } })
    ] })
    const result = await agent.invoke({ messages: [{ role: 'user', content: 'Read the target.' }] })
    const responses = result.messages.filter(ToolMessage.isInstance)
    expect(responses).toHaveLength(2)
    expect(responses[0]).toMatchObject({ tool_call_id: 'invalid', status: 'error', content: expect.stringContaining('Correct the arguments') })
    expect(responses[1]).toMatchObject({ tool_call_id: 'corrected', status: 'success', content: 'Read available' })
    expect(observed.some(message => message.tool_call_id === 'invalid' && message.status === 'error')).toBe(true)
    expect(execute.mock.calls.map(([args]) => args.target)).toEqual(source === 'tool' ? ['missing', 'available'] : ['available'])
    expect(result).not.toHaveProperty('__interrupt__')
  })

  it.each(['execution', 'stored-data'] as const)('preserves a %s failure instead of calling it invalid model input', async kind => {
    const failure = kind === 'execution'
      ? new Error('Execution acknowledgement lost')
      : z.object({ checkpoint: z.string() }).safeParse({}).error!
    const failed = tool(() => { throw failure }, { name: 'failed', description: 'Fixture.', schema: z.object({}) })
    const model = new FakeToolCallingModel({ toolCalls: [[{ id: 'call', name: failed.name, args: {} }], []] })
    const beforeModel = vi.fn()
    const agent = createAgent({ model, tools: [failed], middleware: [
      createToolInputErrorMiddleware(), createMiddleware({ name: 'ObserveRounds', beforeModel })
    ] })
    await expect(agent.invoke({ messages: [{ role: 'user', content: 'Run.' }] })).rejects.toThrow(failure.message)
    expect(beforeModel).toHaveBeenCalledOnce()
  })

  it.each([null, [], 'wrong', 1])('returns non-object arguments %j from journal preflight to the model', async args => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'invalid-args-object')
      const execute = vi.fn(() => 'Read complete')
      const read = tool(execute, { name: 'read_target', description: 'Read a target.', schema: z.object({}) })
      const agent = createAgent({
        model: new FakeToolCallingModel({ toolCalls: [
          [{ id: 'invalid', name: read.name, args: args as unknown as Record<string, unknown> }],
          [{ id: 'corrected', name: read.name, args: {} }], []
        ] }), tools: [read], checkpointer: database.checkpointer,
        middleware: [createToolInputErrorMiddleware(), createToolInputValidationMiddleware([read]),
          createAgentToolEffectMiddleware({ database, runId: run.id, threadId: thread.id, tools: [read] })]
      })
      const result = await agent.invoke({ messages: [{ role: 'user', content: 'Read.' }] }, { configurable: { thread_id: thread.id } })
      expect(result.messages.filter(ToolMessage.isInstance)).toMatchObject([
        { tool_call_id: 'invalid', status: 'error', content: expect.stringContaining('JSON object') },
        { tool_call_id: 'corrected', status: 'success' }
      ])
      expect(execute).toHaveBeenCalledOnce()
    } finally { database.close() }
  })

  it('preserves native interrupts and resumes the same tool after user input', async () => {
    const ask = tool(() => interrupt({ question: 'Continue?' }), {
      name: 'ask', description: 'Wait for the user.', schema: z.object({})
    })
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[{ id: 'ask-call', name: ask.name, args: {} }], []] }),
      tools: [ask], checkpointer: new MemorySaver(), middleware: [createToolInputErrorMiddleware()] })
    const config = { configurable: { thread_id: 'input-interrupt' } }
    const pending = await agent.invoke({ messages: [{ role: 'user', content: 'Ask.' }] }, config)
    expect(pending.__interrupt__).toHaveLength(1)
    expect(pending.messages.filter(ToolMessage.isInstance)).toEqual([])
    const resumed = await agent.invoke(new Command({ resume: 'yes' }), config)
    expect(resumed.messages.filter(ToolMessage.isInstance)).toMatchObject([{ tool_call_id: 'ask-call', content: 'yes', status: 'success' }])
  })

  it('still treats invalid stored effect values as an internal failure', () => {
    expect(() => canonicalAgentToolEffectJson({ result: Infinity })).toThrow('finite numbers')
    try { canonicalAgentToolEffectJson({ result: Infinity }) } catch (error) {
      expect(formatAgentToolInputError(error, 'read_target')).toBeUndefined()
    }
  })

  it('does not turn cancellation into an input correction round', async () => {
    const controller = new AbortController()
    const cancelled = tool(() => {
      controller.abort(new Error('User stopped the run'))
      throw new ToolInputParsingException('Unavailable target')
    }, { name: 'cancelled', description: 'Fixture.', schema: z.object({}) })
    const beforeModel = vi.fn()
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[{ id: 'call', name: cancelled.name, args: {} }], []] }),
      tools: [cancelled], middleware: [createToolInputErrorMiddleware(), createMiddleware({ name: 'ObserveRounds', beforeModel })] })
    await expect(agent.invoke({ messages: [{ role: 'user', content: 'Run.' }] }, { signal: controller.signal })).rejects.toThrow()
    expect(beforeModel).toHaveBeenCalledOnce()
  })
})
