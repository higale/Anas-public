import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import { Command, interrupt, MemorySaver, type StateSnapshot } from '@langchain/langgraph'
import { createAgent, createMiddleware, FakeToolCallingModel, tool } from 'langchain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v3'
import { z as z4 } from 'zod/v4'
import type { AgentAccessMode } from '@shared/agentTypes'
import { createInterruptPolicy } from './agentFactory'
import { createToolApprovalMiddleware } from './toolApprovalMiddleware'
import { createFileTools } from '../llm/fileTools'

const roots: string[] = []
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'anas-approval-')))
  roots.push(root)
  await writeFile(join(root, 'note.txt'), 'read succeeded')
  return root
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const read = (id: string, path: unknown) => ({ id, name: 'read_file', args: { path } })
const modes: AgentAccessMode[] = ['strict_approval', 'read_only_allowed', 'full_access']
function middleware(root: string, accessMode: AgentAccessMode) {
  return createToolApprovalMiddleware(createInterruptPolicy({ availableTools: ['read_file', 'delete_file'],
    primaryFolder: root, trustedFolders: [root], accessMode: () => accessMode }),
  createFileTools({ maxReadBytes: 1_000_000, primaryFolder: root, toolNames: ['read_file', 'delete_file'] }))
}

describe('native tool approval validation', () => {
  it.each([
    { format: 'Zod 3', schema: z.object({ command: z.string() }) },
    { format: 'Zod 4', schema: z4.object({ command: z4.string() }) },
    { format: 'JSON Schema', schema: { type: 'object' as const, properties: { command: { type: 'string' } }, required: ['command'] } }
  ])('validates $format arguments before asking for approval', async ({ schema }) => {
    const execute = vi.fn(async () => 'Executed once')
    const tools = [tool(execute, { name: 'pwsh', description: 'Shell fixture.', schema })]
    const when = vi.fn(() => true)
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [
      [{ id: 'invalid', name: 'pwsh', args: { command: 3 } }],
      [{ id: 'corrected', name: 'pwsh', args: { command: 'Get-Date' } }], []
    ] }), tools, checkpointer: new MemorySaver(), middleware: [
      createToolApprovalMiddleware({ pwsh: { allowedDecisions: ['approve', 'reject'], when } }, tools)
    ] })
    const config = { configurable: { thread_id: 'schema-before-approval' } }
    const pending = await agent.invoke({ messages: [new HumanMessage('Run a command.')] }, config)
    expect(pending.messages.filter(ToolMessage.isInstance)).toMatchObject([
      { tool_call_id: 'invalid', status: 'error', content: expect.stringContaining('command') }
    ])
    expect(pending.__interrupt__).toHaveLength(1)
    expect(pending.__interrupt__![0].value).toMatchObject({ actionRequests: [{ name: 'pwsh', args: { command: 'Get-Date' } }] })
    expect(when).toHaveBeenCalledOnce()
    expect(execute).not.toHaveBeenCalled()
    const result = await agent.invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), config)
    expect(result.messages.filter(ToolMessage.isInstance).at(-1)).toMatchObject({ tool_call_id: 'corrected', content: 'Executed once' })
    expect(execute).toHaveBeenCalledOnce()
  })

  it.each(modes)('lets the model correct empty, missing and non-string paths in %s', async (mode) => {
    const root = await fixture()
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [
      [read('empty', '')], [{ id: 'missing', name: 'read_file', args: {} }], [read('number', 3)],
      [read('corrected', 'note.txt')], []
    ] }), tools: createFileTools({ maxReadBytes: 1_000_000, primaryFolder: root, toolNames: ['read_file'] }), middleware: [middleware(root, mode)] })
    const result = await agent.invoke({ messages: [{ role: 'user', content: 'Read note.txt' }] })
    const outputs = result.messages.filter(ToolMessage.isInstance)
    for (const id of ['empty', 'missing', 'number']) {
      expect(outputs.filter(message => message.tool_call_id === id)).toHaveLength(1)
      expect(outputs.find(message => message.tool_call_id === id)?.status).toBe('error')
      expect(outputs.find(message => message.tool_call_id === id)?.text).toContain('NOT EXECUTED')
    }
    expect(outputs.find(message => message.tool_call_id === 'corrected')?.text).toContain('read succeeded')
  })

  it('rejects an invalid write while the native router executes an independent valid read', async () => {
    const root = await fixture()
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[
      { id: 'invalid-write', name: 'delete_file', args: { path: '' } }, read('valid-read', 'note.txt')
    ], []] }), tools: createFileTools({ maxReadBytes: 1_000_000, primaryFolder: root, toolNames: ['read_file', 'delete_file'] }),
      middleware: [middleware(root, 'full_access')] })
    const result = await agent.invoke({ messages: [{ role: 'user', content: 'Inspect files' }] })
    const outputs = result.messages.filter(ToolMessage.isInstance)
    expect(outputs.find(message => message.tool_call_id === 'invalid-write')?.status).toBe('error')
    expect(outputs.find(message => message.tool_call_id === 'valid-read')?.text).toContain('read succeeded')
    expect(await readFile(join(root, 'note.txt'), 'utf8')).toBe('read succeeded')
  })

  it.each(['approve', 'reject'] as const)('keeps external writes under native %s after restoring an interrupted batch', async (decision) => {
    const root = await fixture(), outside = await fixture()
    const target = join(outside, 'note.txt')
    const saver = new MemorySaver()
    const model = new FakeToolCallingModel({ toolCalls: [[read('invalid', ''),
      { id: 'external-write', name: 'delete_file', args: { path: target } }
    ], []] })
    const makeAgent = () => createAgent({ model, checkpointer: saver,
      tools: createFileTools({ maxReadBytes: 1_000_000, primaryFolder: root, toolNames: ['read_file', 'delete_file'] }),
      middleware: [middleware(root, 'read_only_allowed')] })
    const config = { configurable: { thread_id: 'restore-approval' } }
    const paused = await makeAgent().invoke({ messages: [{ role: 'user', content: 'Inspect and delete the selected file' }] }, config)
    expect(paused.__interrupt__).toHaveLength(1)
    expect(paused.__interrupt__![0].value).toMatchObject({ actionRequests: [{ name: 'delete_file', args: { path: target } }] })
    expect(await readFile(target, 'utf8')).toBe('read succeeded')
    const restored = makeAgent()
    const completed = await restored.invoke(new Command({ resume: { decisions: [{ type: decision }] } }), config)
    expect(completed.messages.filter(ToolMessage.isInstance).filter(message => message.tool_call_id === 'invalid')).toHaveLength(1)
    if (decision === 'approve') await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    else expect(await readFile(target, 'utf8')).toBe('read succeeded')
    const checkpoint = await restored.getState(config) as StateSnapshot
    expect(checkpoint.values.messages.filter(ToolMessage.isInstance).find((message: ToolMessage) => message.tool_call_id === 'invalid')?.status).toBe('error')
  })

  it('preserves native interrupts raised while evaluating a predicate', async () => {
    const root = await fixture()
    const tools = createFileTools({ maxReadBytes: 1_000_000, primaryFolder: root, toolNames: ['read_file'] })
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[read('read', 'note.txt')], []] }),
      checkpointer: new MemorySaver(), tools,
      middleware: [createToolApprovalMiddleware({ read_file: { allowedDecisions: ['approve'], when: () => {
        interrupt('predicate needs input')
        return false
      } } }, tools)] })
    const result = await agent.invoke({ messages: [{ role: 'user', content: 'Read' }] }, { configurable: { thread_id: 'interrupt' } })
    expect(result.__interrupt__![0].value).toBe('predicate needs input')
    expect(result.messages.filter(ToolMessage.isInstance)).toHaveLength(0)
  })

  it('keeps a predicate input error exactly once when another action is rejected', async () => {
    const root = await fixture(), outside = await fixture()
    const target = join(outside, 'note.txt')
    const calls = [read('invalid', ''), read('automatic', 'note.txt'),
      { id: 'review', name: 'delete_file', args: { path: target } }]
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [calls, []] }),
      checkpointer: new MemorySaver(), tools: createFileTools({ maxReadBytes: 1_000_000, primaryFolder: root, toolNames: ['read_file', 'delete_file'] }),
      middleware: [middleware(root, 'read_only_allowed')] })
    const config = { configurable: { thread_id: 'predicate-error-and-reject' } }
    const paused = await agent.invoke({ messages: [new HumanMessage('Inspect and delete')] }, config)
    expect(paused.__interrupt__![0].value).toMatchObject({ actionRequests: [{ name: 'delete_file' }] })
    const completed = await agent.invoke(new Command({ resume: { decisions: [{ type: 'reject', message: 'Keep it' }] } }), config)
    const outputs = completed.messages.filter(ToolMessage.isInstance)
    expect(outputs).toHaveLength(calls.length)
    expect(new Set(outputs.map(message => message.tool_call_id)).size).toBe(calls.length)
    expect(outputs.find(message => message.tool_call_id === 'invalid')?.text).toMatch(/path/i)
    expect(outputs.find(message => message.tool_call_id === 'automatic')?.text).toContain('NOT EXECUTED')
    expect(outputs.find(message => message.tool_call_id === 'review')?.text).toContain('Keep it')
    expect(outputs.every(message => message.status === 'error')).toBe(true)
    expect(completed.messages.find(AIMessage.isInstance)?.tool_calls?.map(call => call.id)).toEqual(calls.map(call => call.id))
    expect(await readFile(target, 'utf8')).toBe('read succeeded')
  })

  it('preserves cancellation instead of converting it into a tool validation error', async () => {
    const root = await fixture()
    const controller = new AbortController()
    const tools = createFileTools({ maxReadBytes: 1_000_000, primaryFolder: root, toolNames: ['read_file'] })
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[read('read', 'note.txt')], []] }),
      tools,
      middleware: [createToolApprovalMiddleware({ read_file: { allowedDecisions: ['approve'], when: () => {
        controller.abort(new Error('cancelled approval evaluation'))
        throw new Error('predicate interrupted')
      } } }, tools)] })
    await expect(agent.invoke({ messages: [{ role: 'user', content: 'Read' }] }, { signal: controller.signal })).rejects.toThrow()
  })
})

it('preserves original auto-approved arguments before the tools node and after runtime recreation', async () => {
  const saver = new MemorySaver()
  const run = vi.fn(async (_args: { command: string }) => 'done')
  const config = { configurable: { thread_id: 'normalized' } }
  const tools = [tool(run, { name: 'pwsh', description: 'Shell', schema: z.object({ command: z.string() }) })]
  const create = (stop: boolean) => createAgent({
    model: new FakeToolCallingModel({ toolCalls: [[{ id: 'read', name: 'pwsh', args: { command: 'original' } }], []], index: stop ? 0 : 1 }),
    tools,
    checkpointer: saver,
    middleware: [createToolApprovalMiddleware({ pwsh: { allowedDecisions: ['approve', 'reject'], when: (request) => {
      expect(request.toolCall.args.command).toBe('original')
      return false
    } } }, tools), createMiddleware({ name: 'StopBeforeDispatch', wrapToolCall: async (request, handler) => {
      if (stop) interrupt('before dispatch')
      return handler(request)
    } })]
  })
  await create(true).invoke({ messages: [new HumanMessage('read')] }, config)
  expect(run).not.toHaveBeenCalled()
  const checkpoint = await saver.get(config)
  const messages = checkpoint?.channel_values.messages as AIMessage[]
  expect(messages.find(AIMessage.isInstance)?.tool_calls?.[0].args.command).toBe('original')
  await create(false).invoke(null, config)
  expect(run).toHaveBeenCalledOnce()
  expect(run.mock.calls[0][0]).toMatchObject({ command: 'original' })
})

it.each(['approve', 'reject'] as const)('retains native HITL %s decisions', async (decision) => {
  const run = vi.fn(async (_args: { command: string }) => 'done')
  const config = { configurable: { thread_id: decision } }
  const tools = [tool(run, { name: 'pwsh', description: 'Shell', schema: z.object({ command: z.string() }) })]
  const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [
    [{ id: 'write', name: 'pwsh', args: { command: 'unknown command' } }], []
  ] }), tools,
  checkpointer: new MemorySaver(), middleware: [createToolApprovalMiddleware({ pwsh: {
    allowedDecisions: ['approve', 'reject'], when: () => true
  } }, tools)] })
  const paused = await agent.invoke({ messages: [new HumanMessage('run')] }, config)
  expect(paused.__interrupt__).toHaveLength(1)
  expect(run).not.toHaveBeenCalled()
  await agent.invoke(new Command({ resume: { decisions: [{ type: decision, ...(decision === 'reject' ? { message: 'cancelled' } : {}) }] } }), config)
  expect(run).toHaveBeenCalledTimes(decision === 'approve' ? 1 : 0)
})

it('still checkpoints structured file path binding independently of Shell commands', async () => {
  const root = await fixture()
  const saver = new MemorySaver()
  const config = { configurable: { thread_id: 'file-binding' } }
  const create = (pause: boolean) => createAgent({ checkpointer: saver,
    model: new FakeToolCallingModel({ toolCalls: [[read('read', 'note.txt')], []], index: pause ? 0 : 1 }),
    tools: createFileTools({ maxReadBytes: 1_000_000, primaryFolder: root, toolNames: ['read_file'] }),
    middleware: [middleware(root, 'strict_approval'), createMiddleware({ name: 'PauseRead', wrapToolCall: (request, handler) => {
      if (pause) interrupt('before file dispatch')
      return handler(request)
    } })]
  })
  await create(true).invoke({ messages: [{ role: 'user', content: 'Read' }] }, config)
  const messages = (await saver.get(config))?.channel_values.messages as AIMessage[]
  expect(messages.find(AIMessage.isInstance)?.tool_calls?.[0].args.path).toBe(join(root, 'note.txt'))
  const completed = await create(false).invoke(null, config)
  expect(completed.messages.filter(ToolMessage.isInstance).at(-1)?.text).toContain('read succeeded')
})
