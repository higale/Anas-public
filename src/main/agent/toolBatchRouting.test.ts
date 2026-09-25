import { createRequire } from 'node:module'
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { Command, MemorySaver } from '@langchain/langgraph'
import * as framework from 'langchain'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v3'
import { createToolInputValidationMiddleware } from './toolInputErrors'

const commonjs: typeof framework = createRequire(import.meta.url)('langchain')

function expectPairedCalls(messages: readonly BaseMessage[]): void {
  let pending: string[] = []
  for (const message of messages) {
    if (ToolMessage.isInstance(message)) {
      expect(pending).toContain(message.tool_call_id)
      pending = pending.filter(id => id !== message.tool_call_id)
    } else {
      expect(pending).toEqual([])
      pending = AIMessage.isInstance(message) ? (message.tool_calls ?? []).map(call => call.id!) : []
    }
  }
  expect(pending).toEqual([])
}

describe.each([
  { name: 'ESM v1', native: framework, version: 'v1' }, { name: 'ESM v2', native: framework, version: 'v2' },
  { name: 'CommonJS v1', native: commonjs, version: 'v1' }, { name: 'CommonJS v2', native: commonjs, version: 'v2' }
] as const)('$name tool batch routing', ({ native, version }) => {
  it.each([false, true])('executes a reused call ID in the current round with afterModel=%s', async validation => {
    const execute = vi.fn(() => 'New result')
    const tools = [native.tool(execute, { name: 'operate', description: 'Fixture.', schema: z.object({}) })]
    const agent = native.createAgent({ version, model: new native.FakeToolCallingModel({ toolCalls: [
      [{ id: 'reused', name: 'operate', args: {} }], []
    ] }), tools, middleware: validation ? [createToolInputValidationMiddleware(tools)] : [] })
    const result = await agent.invoke({ messages: [
      new AIMessage({ content: '', tool_calls: [{ id: 'reused', name: 'operate', args: {} }] }),
      new ToolMessage({ tool_call_id: 'reused', content: 'Old result' }),
      { role: 'user', content: 'Perform the new operation' }
    ] })
    expectPairedCalls(result.messages)
    expect(execute).toHaveBeenCalledOnce()
    expect(result.messages.filter(ToolMessage.isInstance).map(message => message.text)).toEqual(['Old result', 'New result'])
  })

  it.each([
    ['invalid', 'valid'], ['valid', 'valid'], ['invalid', 'invalid'], ['invalid', 'valid', 'valid']
  ].map(kinds => ({ kinds })))('pairs todo results and continues through beforeModel for $kinds', async ({ kinds }) => {
    const todos = native.todoListMiddleware()
    const calls = kinds.map((kind, index) => ({ id: `todo-${index}`, name: 'write_todos', args: {
      todos: kind === 'invalid' ? 'wrong' : [{ content: `Plan ${index}`, status: 'pending' }]
    } }))
    const finalTodos = [{ content: 'Corrected plan', status: 'completed' }]
    const beforeModel = vi.fn((state: { messages: BaseMessage[] }) => { expectPairedCalls(state.messages) })
    const agent = native.createAgent({ version, model: new native.FakeToolCallingModel({ toolCalls: [calls,
      [{ id: 'corrected', name: 'write_todos', args: { todos: finalTodos } }], []] }), middleware: [
      todos, createToolInputValidationMiddleware(todos.tools ?? []),
      native.createMiddleware({ name: 'ValidateModelInput', beforeModel })
    ] })
    const result = await agent.invoke({ messages: [{ role: 'user', content: 'Plan.' }] })
    expectPairedCalls(result.messages)
    expect(result.todos).toEqual(finalTodos)
    expect(beforeModel).toHaveBeenCalledTimes(3)
    const outputs = result.messages.filter(ToolMessage.isInstance)
    expect(outputs).toHaveLength(calls.length + 1)
    const validCount = kinds.filter(kind => kind === 'valid').length
    for (const [index, kind] of kinds.entries()) {
      const output = outputs.find(message => message.tool_call_id === `todo-${index}`)!
      if (kind === 'valid' && validCount === 1) {
        expect(output.status).not.toBe('error')
        expect(output.text).toContain(`Plan ${index}`)
      } else expect(output.status).toBe('error')
    }
  })

  it.each(['schema', 'parallel'] as const)('enforces the model call limit after %s rejection', async source => {
    const todos = native.todoListMiddleware()
    const calls = source === 'schema' ? [{ id: 'bad', name: 'write_todos', args: { todos: 'wrong' } }]
      : ['one', 'two'].map(id => ({ id, name: 'write_todos', args: { todos: [] } }))
    const beforeModel = vi.fn()
    const agent = native.createAgent({ version, model: new native.FakeToolCallingModel({ toolCalls: [calls, []] }), middleware: [
      todos, createToolInputValidationMiddleware(todos.tools ?? []),
      native.createMiddleware({ name: 'ObserveRounds', beforeModel }),
      native.modelCallLimitMiddleware({ runLimit: 1, exitBehavior: 'error' })
    ] })
    await expect(agent.invoke({ messages: [{ role: 'user', content: 'Plan.' }] })).rejects.toThrow(/model call limit/i)
    expect(beforeModel).toHaveBeenCalledTimes(2)
  })

  it.each(['approve', 'reject', 'edit-and-reject'] as const)('preserves every call and result in a mixed native %s batch', async decision => {
    const execute = vi.fn(({ value }: { value: string }) => value)
    const tools = [native.tool(execute, { name: 'operate', description: 'Fixture.', schema: z.object({ value: z.string() }) })]
    const calls = [
      { id: 'review-one', name: 'operate', args: { value: 'review-one' } },
      { id: 'invalid', name: 'operate', args: { value: 4 } },
      { id: 'automatic', name: 'operate', args: { value: 'automatic' } },
      { id: 'review-two', name: 'operate', args: { value: 'review-two' } }
    ]
    const model = new native.FakeToolCallingModel({ toolCalls: [calls, []] })
    const checkpointer = new MemorySaver()
    const beforeModel = vi.fn((state: { messages: BaseMessage[] }) => { expectPairedCalls(state.messages) })
    const makeAgent = () => native.createAgent({ version, model, tools, checkpointer, middleware: [
      native.humanInTheLoopMiddleware({ interruptOn: { operate: { allowedDecisions: ['approve', 'reject', 'edit'],
        when: request => String(request.toolCall.args.value).startsWith('review') } } }),
      createToolInputValidationMiddleware(tools), native.createMiddleware({ name: 'ValidateModelInput', beforeModel })
    ] })
    const config = { configurable: { thread_id: 'mixed-batch' } }
    const paused = await makeAgent().invoke({ messages: [{ role: 'user', content: 'Operate.' }] }, config)
    expect(paused.__interrupt__![0].value).toMatchObject({ actionRequests: [
      { args: calls[0].args }, { args: calls[3].args }
    ] })
    const decisions = [decision === 'edit-and-reject'
      ? { type: 'edit', editedAction: { name: 'operate', args: { value: 'edited' } } } : { type: 'approve' },
    { type: decision === 'approve' ? 'approve' : 'reject', message: 'Skip this batch.' }]
    const completed = await makeAgent().invoke(new Command({ resume: { decisions } }), config)
    expectPairedCalls(completed.messages)
    expect(completed.messages.find(AIMessage.isInstance)?.tool_calls?.map(call => call.id)).toEqual(calls.map(call => call.id))
    expect(beforeModel).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenCalledTimes(decision === 'approve' ? 3 : 0)
    const results = completed.messages.filter(ToolMessage.isInstance)
    expect(results).toHaveLength(calls.length)
    if (decision !== 'approve') expect(results.every(message => message.status === 'error')).toBe(true)
    if (decision === 'edit-and-reject') expect(completed.messages.find(AIMessage.isInstance)?.tool_calls?.[0].args).toEqual({ value: 'edited' })
  })
})
