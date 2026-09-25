import { afterEach, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { loadMcpTools } from '@langchain/mcp-adapters'
import { AIMessage, ToolMessage } from '@langchain/core/messages'
import { createAgent, FakeToolCallingModel } from 'langchain'
import { AgentDatabase } from './agentDatabase'
import { ManagedCallService } from './managedCallService'
import { withManagedToolExecution } from './managedToolExecution'
import { createManagedCallTools } from '../llm/runtimeTools'
import { hasToolImages, projectToolImages } from './toolImageProjection'
import { createToolInputErrorMiddleware } from './toolInputErrors'
import { createAgentToolEffectMiddleware } from './toolEffectMiddleware'

afterEach(() => vi.useRealTimers())

it.each(['schema', 'server'])('returns MCP %s argument errors to the model and accepts its correction', async source => {
  const client = new Client({ name: 'anas-test', version: '1.0.0' })
  const server = new Server({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'lookup',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    annotations: { readOnlyHint: true } }] }))
  const received: unknown[] = []
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const name = request.params.arguments?.name
    received.push(name)
    return name === 'available'
      ? { content: [{ type: 'text', text: 'Found available' }] }
      : { isError: true, content: [{ type: 'text', text: 'Unknown name. Choose available.' }] }
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const database = AgentDatabase.open(':memory:')
  const service = new ManagedCallService(database)
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    const [native] = await loadMcpTools('test', client, { additionalToolNamePrefix: 'mcp' })
    const thread = database.createThread({ title: 'MCP argument correction' })
    const run = database.createRun(thread.id, 'mcp-input-errors')
    const managed = withManagedToolExecution(native, { database, service, threadId: thread.id, runId: run.id, allowBackground: true })
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [
      [{ id: 'invalid', name: managed.name, args: { name: source === 'schema' ? 42 : 'missing' } }],
      [{ id: 'corrected', name: managed.name, args: { name: 'available' } }], []
    ] }), tools: [managed], checkpointer: database.checkpointer,
      middleware: [createToolInputErrorMiddleware(), createAgentToolEffectMiddleware({ database, runId: run.id, threadId: thread.id, tools: [managed] })] })
    const result = await agent.invoke({ messages: [{ role: 'user', content: 'Look it up.' }] }, { configurable: { thread_id: thread.id } })
    const responses = result.messages.filter(ToolMessage.isInstance)
    expect(responses).toMatchObject([
      { tool_call_id: 'invalid', status: 'error' }, { tool_call_id: 'corrected', status: 'success' }
    ])
    expect(JSON.stringify(responses[0].content)).toContain(source === 'schema' ? 'name' : 'Unknown name')
    expect(JSON.stringify(responses[1].content)).toContain('Found available')
    expect(received).toEqual(source === 'schema' ? ['available'] : ['missing', 'available'])
    expect(result).not.toHaveProperty('__interrupt__')
  } finally {
    await service.waitForIdle()
    await Promise.all([client.close(), server.close()])
    database.close()
  }
})

it.each([false, true])('keeps MCP identity, cancellation and late image lifetime (standard blocks: %s)', async (useStandardContentBlocks) => {
  const client = new Client({ name: 'anas-test', version: '1.0.0' })
  const server = new Server({ name: 'test-server', version: '1.0.0' }, { capabilities: { tools: {} } })
  const requests: Array<{ id: string | number; signal: AbortSignal; finish(): void }> = []
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'work',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
    annotations: { readOnlyHint: true } }] }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    requests.push({ id: extra.requestId, signal: extra.signal, finish })
    extra.signal.addEventListener('abort', finish, { once: true })
    const token = request.params._meta?.progressToken
    if (token !== undefined) await extra.sendNotification({ method: 'notifications/progress',
      params: { progressToken: token, progress: 0.5, total: 1 } })
    await done
    extra.signal.removeEventListener('abort', finish)
    return { content: [{ type: 'text', text: 'finished' }, { type: 'image', data: 'AA==', mimeType: 'image/png' }],
      structuredContent: { finished: true } }
  })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  const progress = vi.fn()
  const [native] = await loadMcpTools('test', client, { additionalToolNamePrefix: 'mcp', onProgress: progress, useStandardContentBlocks })
  const database = AgentDatabase.open(':memory:')
  const thread = database.createThread({ title: 'MCP background' })
  const run = database.createRun(thread.id, 'mcp-test-run')
  const service = new ManagedCallService(database)
  vi.useFakeTimers()
  try {
    const managed = withManagedToolExecution(native, { database, service, threadId: thread.id,
      runId: run.id, allowBackground: true })
    const args = { text: 'identical' }
    const starts = ['one', 'two'].map((id) => managed.invoke({ type: 'tool_call', id, name: managed.name, args }))
    await vi.advanceTimersByTimeAsync(10_000)
    const handles = (await Promise.all(starts)).map((result) => JSON.parse(String((result as ToolMessage).content)))
    expect(requests).toHaveLength(2)
    expect(requests[0].id).not.toBe(requests[1].id)
    expect(handles[0].call_id).not.toBe(handles[1].call_id)
    expect(progress).toHaveBeenCalledTimes(2)
    await service.cancel(handles[0].call_id, thread.id)
    expect(requests[0].signal.aborted).toBe(true)
    expect(requests[1].signal.aborted).toBe(false)
    requests[1].finish()
    await vi.advanceTimersByTimeAsync(1)
    const result = await service.readResult(handles[1].call_id, thread.id)
    expect(result?.tool_call_id).toBe('two')
    expect(result?.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: useStandardContentBlocks ? 'image' : 'image_url' })]))
    expect(result?.artifact).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'mcp_structured_content' })]))
    const read = createManagedCallTools({ managedCalls: service, threadId: thread.id })
      .find((tool) => tool.name === 'read_call_output')!
    const retrieve = async (id: string) => read.invoke({ type: 'tool_call', id, name: read.name,
      args: { summary: 'Inspect captured image', call_id: handles[1].call_id, output_offset: 0, output_length: 1000 } }) as Promise<ToolMessage>
    const observed = new AIMessage('The background call has completed')
    const delivered = await retrieve('read-image')
    expect(projectToolImages([observed, delivered])[1]).toBe(delivered)
    const processed = new AIMessage('Image observed')
    expect(hasToolImages(projectToolImages([observed, delivered, processed])[1])).toBe(false)
    const reread = await retrieve('read-image-again')
    expect(hasToolImages(projectToolImages([observed, delivered, processed, reread])[3])).toBe(true)
    expect((await service.readResult(handles[1].call_id, thread.id))?.content).toEqual(result?.content)
    await expect(client.ping()).resolves.toBeDefined()
  } finally {
    for (const request of requests) request.finish()
    await vi.advanceTimersByTimeAsync(1)
    await Promise.all([client.close(), server.close()])
    database.close()
  }
})
