import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import * as framework from 'langchain'
import * as langgraph from '@langchain/langgraph'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const commonjs: typeof framework = createRequire(import.meta.url)('langchain')

describe.each([['ESM', framework], ['CommonJS', commonjs]] as const)('%s structured response routing', (_name, native) => {
  function model(calls: NonNullable<ConstructorParameters<typeof native.FakeToolCallingModel>[0]>['toolCalls']) {
    const generate = native.FakeToolCallingModel.prototype._generate
    const spy = vi.spyOn(native.FakeToolCallingModel.prototype, '_generate').mockImplementation(async function (this: framework.FakeToolCallingModel, ...args) {
      const result = await generate.apply(this, args)
      for (const item of result.generations) {
        item.message.id = randomUUID()
        item.message.content = 'step'
        item.text = 'step'
      }
      return result
    })
    return { model: new native.FakeToolCallingModel({ toolCalls: calls }), spy }
  }

  it.each([0, 1, 3])('retries through all %i middleware hooks once per model call', async (hookCount) => {
    const format = native.toolStrategy(z.object({ findings: z.array(z.string()) }))
    const name = format[0].name
    const fixture = model([
      [{ id: 'bad', name, args: {} }],
      [{ id: 'read', name: 'read_file', args: { path: 'work.txt' } }],
      [{ id: 'good', name, args: { findings: [] } }]
    ])
    const read = vi.fn(async () => 'contents')
    const before = Array.from({ length: hookCount }, () => vi.fn(() => undefined))
    const after = Array.from({ length: hookCount }, () => vi.fn(() => undefined))
    const agent = native.createAgent({ model: fixture.model, responseFormat: format,
      tools: [native.tool(read, { name: 'read_file', description: 'Read', schema: z.object({ path: z.string() }) })],
      middleware: before.map((hook, i) => native.createMiddleware({ name: `Hooks${i}`, beforeModel: hook, afterModel: after[i] }))
    })
    const result = await agent.invoke({ messages: [new HumanMessage('Review')] })
    expect(result.structuredResponse).toEqual({ findings: [] })
    expect(fixture.spy).toHaveBeenCalledTimes(3)
    expect(read).toHaveBeenCalledOnce()
    for (const hook of [...before, ...after]) expect(hook).toHaveBeenCalledTimes(3)
    expect(result.messages.filter((message) => ToolMessage.isInstance(message) && message.tool_call_id === 'bad')).toHaveLength(1)
  })

  it('retries a named schema with no investigation tools and enforces the native call limit', async () => {
    const format = native.toolStrategy({ title: 'anas_code_review_report', type: 'object',
      properties: { findings: { type: 'array', items: { type: 'string' } } }, required: ['findings'] })
    const fixture = model([[{ id: 'bad', name: format[0].name, args: {} }], [{ id: 'good', name: format[0].name, args: { findings: [] } }]])
    const agent = native.createAgent({ model: fixture.model, responseFormat: format,
      middleware: [native.modelCallLimitMiddleware({ runLimit: 1, exitBehavior: 'error' }),
        native.createMiddleware({ name: 'After', afterModel: () => undefined })] })
    await expect(agent.invoke({ messages: [new HumanMessage('Review')] })).rejects.toThrow(/model call limit/i)
    expect(fixture.spy).toHaveBeenCalledOnce()
  })

  it('keeps schema errors fatal when native retry is disabled', async () => {
    const format = native.toolStrategy(z.object({ findings: z.array(z.string()) }), { handleError: false })
    const fixture = model([[{ id: 'bad', name: format[0].name, args: {} }]])
    await expect(native.createAgent({ model: fixture.model, responseFormat: format }).invoke({ messages: [new HumanMessage('Review')] }))
      .rejects.toThrow('Failed to parse structured output')
    expect(fixture.spy).toHaveBeenCalledOnce()
  })

  it('answers every rejected report before retrying multiple structured outputs', async () => {
    const format = native.toolStrategy(z.object({ findings: z.array(z.string()) }))
    const name = format[0].name
    const fixture = model([
      [{ id: 'first', name, args: { findings: [] } }, { id: 'second', name, args: { findings: [] } }],
      [{ id: 'good', name, args: { findings: [] } }]
    ])
    const result = await native.createAgent({ model: fixture.model, responseFormat: format }).invoke({ messages: [new HumanMessage('Review')] })
    expect(result.structuredResponse).toEqual({ findings: [] })
    expect(fixture.spy).toHaveBeenCalledTimes(2)
    for (const id of ['first', 'second']) expect(result.messages.filter((message) => ToolMessage.isInstance(message)
      && message.tool_call_id === id && message.status === 'error')).toHaveLength(1)
  })

  it('checkpoints a native interrupt before the retry and resumes without replaying the first model call', async () => {
    const graph: typeof langgraph = _name === 'ESM' ? langgraph : createRequire(import.meta.url)('@langchain/langgraph')
    const format = native.toolStrategy(z.object({ findings: z.array(z.string()) }))
    const fixture = model([[{ id: 'bad', name: format[0].name, args: {} }], [{ id: 'good', name: format[0].name, args: { findings: [] } }]])
    const agent = native.createAgent({ model: fixture.model, responseFormat: format, checkpointer: new graph.MemorySaver(),
      middleware: [native.createMiddleware({ name: 'PauseRetry', beforeModel: (state) => {
        if (state.messages.some((message: BaseMessage) => ToolMessage.isInstance(message) && message.tool_call_id === 'bad')) graph.interrupt('Continue review')
      }, afterModel: () => undefined })] })
    const config = { configurable: { thread_id: randomUUID() } }
    await agent.invoke({ messages: [new HumanMessage('Review')] }, config)
    expect(fixture.spy).toHaveBeenCalledOnce()
    const pending = await agent.getState(config) as { tasks: Array<{ interrupts?: unknown[] }> }
    expect(pending.tasks.some((task) => task.interrupts?.length)).toBe(true)
    const result = await agent.invoke(new graph.Command({ resume: true }), config)
    expect(result.structuredResponse).toEqual({ findings: [] })
    expect(fixture.spy).toHaveBeenCalledTimes(2)
  })
})
