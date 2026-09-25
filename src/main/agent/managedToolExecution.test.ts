import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command, interrupt } from '@langchain/langgraph'
import { createFileTools } from '../llm/fileTools'
import { FileEditStore } from '../fileEditStore'
import { ToolMessage } from '@langchain/core/messages'
import { tool } from '@langchain/core/tools'
import { z } from 'zod/v3'
import { createAgent, FakeToolCallingModel } from 'langchain'
import { AgentDatabase } from './agentDatabase'
import { ManagedCallService } from './managedCallService'
import { withManagedToolExecution } from './managedToolExecution'
import { armCurrentAgentToolEffect } from './toolEffectScope'
import { currentToolExecution } from './toolExecutionContext'
import { createRuntimeTools } from '../llm/runtimeTools'
import { commandShellMetadata } from '@shared/commandShell'
import { runPreparedProcess } from '../shellRuntime'
import { createAgentToolEffectMiddleware } from './toolEffectMiddleware'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

function harness(allowBackground = true) {
  const database = AgentDatabase.open(':memory:')
  const thread = database.createThread({ title: 'Managed tools' })
  const run = database.createRun(thread.id, 'managed-tools-run')
  const service = new ManagedCallService(database)
  return { database, service, threadId: thread.id, runId: run.id, allowBackground }
}

function invoke(tool: ReturnType<typeof withManagedToolExecution>, id: string) {
  return tool.invoke({ type: 'tool_call', id, name: tool.name, args: {} }) as Promise<ToolMessage>
}

afterEach(() => vi.useRealTimers())

describe('unified tool execution', () => {
  it.each([
    { kind: 'builtin', name: 'read_file', metadata: {} },
    { kind: 'shell', name: 'pwsh', metadata: commandShellMetadata() },
    { kind: 'http', name: 'http_request', metadata: {} },
    { kind: 'custom', name: 'custom_query', metadata: { anasCustomToolId: 'query' } },
    { kind: 'mcp', name: 'mcp_server_query', metadata: { annotations: { readOnlyHint: true } } }
  ].flatMap(entry => [false, true].map(background => ({ ...entry, background }))))(
    'passes ok:false content through $kind results without changing status (background: $background)', async ({ name, metadata, background }) => {
      vi.useFakeTimers()
      const h = harness(background)
      const finish = deferred<string>()
      const content = '{"ok":false,"error":"具体原因"}'
      const native = tool(() => {
        currentToolExecution()!.markRunning()
        return finish.promise
      }, { name, description: 'Return file contents.', metadata, schema: z.object({}) })
      try {
        const pending = invoke(withManagedToolExecution(native, h), 'file-content')
        let callId: string | undefined
        if (background) {
          await vi.advanceTimersByTimeAsync(10_000)
          callId = JSON.parse(String((await pending).content)).call_id as string
        }
        finish.resolve(content)
        await vi.advanceTimersByTimeAsync(1)
        const result = callId ? await h.service.readResult(callId, h.threadId) : await pending
        expect(result?.content).toBe(content)
        expect(result?.status).toBe('success')
        if (callId) {
          const status = JSON.parse(h.service.read({ threadId: h.threadId, callId }))
          expect(status).toMatchObject({ status: 'completed', outcome: { ok: true } })
          expect(status).not.toHaveProperty('error')
          expect(status.outcome).not.toHaveProperty('error')
        }
      } finally { await h.service.shutdown(); h.database.close() }
    }
  )

  it('stops an unlimited inline Shell and its child when background tools are disabled', async () => {
    const h = harness(false)
    const controller = new AbortController()
    let pids: number[] = []
    let stdout = ''
    const native = tool(async () => {
      const control = currentToolExecution()!
      return runPreparedProcess({
        command: 'inline cancellation fixture', workingDir: process.cwd(), timeoutSec: 0,
        invocation: { executable: process.execPath, windowsHide: true, env: { ELECTRON_RUN_AS_NODE: '1' }, args: ['-e', [
          "const child = require('node:child_process').spawn(process.execPath, ['-e', \"process.send('ready'); setInterval(() => {}, 1000)\"], {stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}})",
          "child.once('message', () => console.log('READY:' + process.pid + ':' + child.pid))",
          'setInterval(() => {}, 1000)'
        ].join(';')] },
        logScope: 'test', successMessage: 'Finished.', failureMessage: 'Failed.',
        abortBeforeStartError: 'Cancelled before dispatch.', abortError: 'Cancelled.', timeoutError: 'Timed out.'
      }, control.signal, {
        onDispatched: control.markRunning, onOutcomeUncertain: control.markUncertain,
        onOutput: (_stream, text) => {
          stdout += text
          const match = stdout.match(/READY:(\d+):(\d+)/)
          if (match) pids = [Number(match[1]), Number(match[2])]
        },
        onResult: (result) => control.setOutcome({ ok: result.ok, aborted: result.aborted, timed_out: result.timedOut })
      })
    }, { name: 'pwsh', description: 'Shell', metadata: commandShellMetadata(), schema: z.object({}) })
    const pending = invoke(withManagedToolExecution(native, { ...h, signal: controller.signal }), 'inline-shell-stop')
    try {
      await expect.poll(() => pids.length, { timeout: 5000 }).toBe(2)
      controller.abort(new Error('User stopped the run.'))
      const result = await pending
      expect(JSON.parse(String(result.content))).toMatchObject({ ok: false, aborted: true, timedOut: false })
      await expect.poll(() => pids.every((pid) => { try { process.kill(pid, 0); return false } catch { return true } }), { timeout: 5000 }).toBe(true)
      expect(h.service.unresolvedForThread(h.threadId)).toHaveLength(0)
    } finally {
      controller.abort()
      await pending.catch(() => {})
      await h.service.shutdown()
      h.database.close()
    }
  }, 15_000)
  it('reports uncertainty inline without stranding disabled background supervision', async () => {
    const h = harness(false)
    try {
      const native = tool(async () => {
        armCurrentAgentToolEffect({ kind: 'mcp_call', target: 'remote' })
        throw new Error('Connection lost after dispatch')
      }, { name: 'mcp_remote_write', description: 'Write', schema: z.object({}) })
      const result = await invoke(withManagedToolExecution(native, h), 'uncertain')
      expect(result.status).toBe('error')
      expect(JSON.parse(String(result.content))).toMatchObject({ ok: false, outcome_uncertain: true })
      expect(h.service.unresolvedForThread(h.threadId)).toHaveLength(0)
    } finally { h.database.close() }
  })

  it('finishes the framework tool stream with its handle before the executor finishes', async () => {
    vi.useFakeTimers()
    const h = harness()
    const finish = deferred<string>()
    let entered = false
    const native = tool(() => { entered = true; return finish.promise }, {
      name: 'read_file', description: 'Read', schema: z.object({})
    })
    try {
      const agent = createAgent({
        model: new FakeToolCallingModel({ toolCalls: [[{ id: 'stream-call', name: 'read_file', args: {} }], []] }),
        tools: [withManagedToolExecution(native, h)]
      })
      const stream = await agent.streamEvents({ messages: [{ role: 'user', content: 'read' }] }, { version: 'v3' })
      for (let index = 0; index < 20 && !entered; index++) await vi.advanceTimersByTimeAsync(0)
      expect(entered).toBe(true)
      await vi.advanceTimersByTimeAsync(10_000)
      const result = await stream.output
      const messages = result.messages.filter(ToolMessage.isInstance)
      const handle = JSON.parse(String(messages[0].content))
      expect(handle).toMatchObject({ status: 'running', call_id: expect.any(String) })
      const events = []
      for await (const event of stream.toolCalls) events.push(event)
      expect(events).toHaveLength(1)
      expect(await events[0].status).toBe('finished')
      expect(await events[0].output).toBe(messages[0].content)
      finish.resolve('late actual result')
      await vi.advanceTimersByTimeAsync(1)
      expect((await h.service.readResult(handle.call_id, h.threadId))?.content).toBe('late actual result')
    } finally { h.database.close() }
  })

  it('returns a preparing handle for the ninth call and starts it automatically', async () => {
    vi.useFakeTimers()
    const h = harness()
    const finish = deferred<string>()
    let executed = 0
    const native = tool(() => { executed++; return finish.promise }, { name: 'read_file', description: 'Read', schema: z.object({}) })
    try {
      const managed = withManagedToolExecution(native, h)
      const starts = Array.from({ length: 9 }, (_, index) => invoke(managed, String(index)))
      await vi.advanceTimersByTimeAsync(10_000)
      const results = await Promise.all(starts)
      const ninth = JSON.parse(String(results[8].content))
      expect(results.every(result => result.status === 'success')).toBe(true)
      expect(ninth).toMatchObject({ ok: true, status: 'preparing', call_id: expect.any(String) })
      expect(executed).toBe(8)
      finish.resolve('done')
      await vi.advanceTimersByTimeAsync(1)
      expect(executed).toBe(9)
      expect((await h.service.readResult(ninth.call_id, h.threadId))?.content).toBe('done')
    } finally { finish.resolve('done'); await h.service.waitForIdle(); h.database.close() }
  })

  it.each([false, true])('executes a framework batch larger than capacity without tool errors (background: %s)', async background => {
    vi.useFakeTimers()
    const h = harness(background)
    const release = deferred<void>()
    let active = 0, peak = 0
    const executed: number[] = []
    const native = tool(async ({ index }) => {
      active++; peak = Math.max(peak, active); executed.push(index)
      await release.promise
      active--
      return `file ${index}`
    }, { name: 'get_file_info', description: 'Inspect', schema: z.object({ index: z.number() }) })
    try {
      const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [
        Array.from({ length: 9 }, (_, index) => ({ id: `call-${index}`, name: native.name, args: { index } })), []
      ] }), tools: [withManagedToolExecution(native, h)] })
      const pending = agent.invoke({ messages: [{ role: 'user', content: 'Inspect nine files.' }] })
      for (let index = 0; index < 40 && executed.length < 8; index++) await vi.advanceTimersByTimeAsync(0)
      expect(executed).toHaveLength(8)
      release.resolve()
      const result = await pending
      const messages = result.messages.filter(ToolMessage.isInstance)
      expect(messages).toHaveLength(9)
      expect(messages.every(message => message.status === 'success' && String(message.content).startsWith('file '))).toBe(true)
      expect(peak).toBe(8)
      expect(new Set(executed).size).toBe(9)
    } finally { release.resolve(); await h.service.waitForIdle(); h.database.close() }
  })

  it.each(['complete', 'cancel'])('keeps a queued side effect unarmed and persists its later %s outcome', async outcome => {
    vi.useFakeTimers()
    const h = harness()
    const releases = Array.from({ length: 9 }, () => deferred<string>())
    const executed: number[] = []
    const native = tool(async ({ index }) => {
      armCurrentAgentToolEffect({ kind: 'mcp_call', target: { index } })
      executed.push(index)
      return releases[index].promise
    }, { name: 'mcp_remote_mutation', description: 'Remote mutation', schema: z.object({ index: z.number() }) })
    const tools = [withManagedToolExecution(native, h)]
    const prepare = vi.spyOn(h.database, 'prepareToolEffect')
    try {
      const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [
        Array.from({ length: 9 }, (_, index) => ({ id: `mutation-${index}`, name: native.name, args: { index } })), []
      ] }), tools, checkpointer: h.database.checkpointer,
      middleware: [createAgentToolEffectMiddleware({ database: h.database, runId: h.runId, threadId: h.threadId, tools })] })
      const pending = agent.invoke({ messages: [{ role: 'user', content: 'Run nine operations.' }] }, {
        configurable: { thread_id: h.threadId }, durability: 'sync'
      })
      for (let index = 0; index < 80 && executed.length < 8; index++) await vi.advanceTimersByTimeAsync(0)
      expect(executed).toHaveLength(8)
      await vi.advanceTimersByTimeAsync(10_000)
      const result = await pending
      const queued = result.messages.filter(ToolMessage.isInstance).find(message => message.tool_call_id === 'mutation-8')!
      const handle = JSON.parse(String(queued.content))
      expect(handle).toMatchObject({ status: 'preparing' })
      const key = prepare.mock.calls.find(([input]) => input.toolCallId === 'mutation-8')![0]
      expect(h.database.loadToolEffect(key)).toMatchObject({ state: 'prepared', effectAttempt: 0 })
      if (outcome === 'cancel') {
        expect(JSON.parse(await h.service.cancel(handle.call_id, h.threadId))).toMatchObject({ status: 'cancelled' })
        expect(h.database.loadToolEffect(key)).toMatchObject({ state: 'prepared', effectAttempt: 0 })
        expect(executed).toHaveLength(8)
        return
      }
      releases[0].resolve('first')
      await vi.advanceTimersByTimeAsync(1)
      expect(executed).toHaveLength(9)
      expect(h.database.loadToolEffect(key)).toMatchObject({ state: 'intent', effectAttempt: 1 })
      releases.forEach(release => release.resolve('done'))
      await h.service.waitForIdle()
      expect(h.database.loadToolEffect(key)).toMatchObject({ state: 'intent', effectAttempt: 1 })
      expect((await h.service.readResult(handle.call_id, h.threadId))?.content).toBe('done')
    } finally { releases.forEach(release => release.resolve('done')); await h.service.waitForIdle(); h.database.close() }
  })

  it.each(['cancelled', 'failed'] as const)('preserves queued cancellation and a late local commit after the owner is %s', async status => {
    vi.useFakeTimers()
    const h = harness()
    const releaseCapacity = deferred<string>()
    const finishCommit = deferred<string>()
    const entered = deferred<void>()
    const blocker = tool(() => releaseCapacity.promise, { name: 'read_file', description: 'Read', schema: z.object({}) })
    const effect = tool(async () => {
      armCurrentAgentToolEffect({ kind: 'file_patch', target: 'test' })
      entered.resolve()
      return finishCommit.promise
    }, { name: 'write_file', description: 'Write', schema: z.object({}) })
    const tools = [blocker, effect].map(native => withManagedToolExecution(native, h))
    try {
      const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[
        ...Array.from({ length: 8 }, (_, index) => ({ id: `block-${index}`, name: blocker.name, args: {} })),
        { id: 'late-write', name: effect.name, args: {} },
        { id: 'queued-write', name: effect.name, args: {} }
      ], []] }), tools, checkpointer: h.database.checkpointer,
      middleware: [createAgentToolEffectMiddleware({ database: h.database, runId: h.runId, threadId: h.threadId, tools })] })
      const pending = agent.invoke({ messages: [{ role: 'user', content: 'Write two files.' }] }, {
        configurable: { thread_id: h.threadId }, durability: 'sync'
      })
      for (let index = 0; index < 80 && h.service.activeCallIds().length < 10; index++) await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(10_000)
      const result = await pending
      const handles = result.messages.filter(ToolMessage.isInstance).slice(-2).map(message => JSON.parse(String(message.content)))
      expect(handles.map(handle => handle.status)).toEqual(['preparing', 'preparing'])
      releaseCapacity.resolve('read')
      await entered.promise
      h.database.finishRun(h.runId, status)
      const cancellation = h.service.cancelRun(h.runId)
      finishCommit.resolve('committed once')
      expect(await cancellation).toEqual({ uncertainCallIds: [], lingeringCallIds: [] })
      expect(h.database.getManagedCall(handles[0].call_id, h.threadId)).toMatchObject({
        status: 'completed', outcome: { local_commit_completed: true }
      })
      expect((await h.service.readResult(handles[0].call_id, h.threadId))?.content).toBe('committed once')
      expect(h.database.getManagedCall(handles[1].call_id, h.threadId)).toMatchObject({ status: 'cancelled' })
    } finally {
      releaseCapacity.resolve('read'); finishCommit.resolve('done')
      await h.service.waitForIdle(); h.database.close()
    }
  })

  it('dispatches a previously queued real file write while the owner waits for user input', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'anas-queued-file-'))
    const database = AgentDatabase.open(':memory:')
    const thread = database.createThread()
    const run = database.createRun(thread.id, randomUUID())
    const service = new ManagedCallService(database)
    const capacity = deferred<string>()
    const prepare = vi.spyOn(database, 'prepareToolEffect')
    const fileEditStore = new FileEditStore(join(root, 'changes'))
    const nativeWrite = createFileTools({ primaryFolder: root, requestId: run.id, fileEditStore,
      fileChanges: database.fileChanges, authorizePatch: async () => {}, maxReadBytes: 1_000_000,
      toolNames: ['write_file'] })[0]
    const blocker = tool(() => capacity.promise, { name: 'read_file', description: 'Read', schema: z.object({}) })
    const ask = tool(() => interrupt('Continue?'), { name: 'request_user_input', description: 'Ask', schema: z.object({}) })
    const tools = [blocker, nativeWrite, ask].map(native => withManagedToolExecution(native, {
      database, service, threadId: thread.id, runId: run.id, allowBackground: true
    }))
    try {
      const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[
        ...Array.from({ length: 8 }, (_, index) => ({ id: `block-${index}`, name: blocker.name, args: {} })),
        { id: 'queued-file', name: nativeWrite.name, args: { path: 'created.txt', content: 'created once', summary: 'Create a file' } }
      ], [{ id: 'ask', name: ask.name, args: {} }], []] }), tools, checkpointer: database.checkpointer,
      middleware: [createAgentToolEffectMiddleware({ database, runId: run.id, threadId: thread.id, tools })] })
      const config = { configurable: { thread_id: thread.id }, durability: 'sync' as const }
      const pending = agent.invoke({ messages: [{ role: 'user', content: 'Write then ask.' }] }, config)
      for (let index = 0; index < 80 && service.activeCallIds().length < 9; index++) await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(10_000)
      const stopped = await pending
      const queued = stopped.messages.filter(ToolMessage.isInstance).find(message => message.tool_call_id === 'queued-file')!
      const handle = JSON.parse(String(queued.content))
      expect(handle.status).toBe('preparing')
      const key = prepare.mock.calls.find(([entry]) => entry.toolCallId === 'queued-file')![0]
      database.finishRun(run.id, 'interrupted')
      capacity.resolve('read')
      await service.waitForIdle()
      expect(await readFile(join(root, 'created.txt'), 'utf8')).toBe('created once')
      expect(database.getManagedCall(handle.call_id, thread.id)).toMatchObject({ status: 'completed' })
      expect(database.loadToolEffect(key)).toMatchObject({ state: 'intent', effectAttempt: 1 })
      const pendingInterrupt = (stopped as unknown as { __interrupt__: Array<{ id: string }> }).__interrupt__[0]
      database.resumeRun(run.id, [{ interruptId: pendingInterrupt.id, response: 'Yes' }])
      await agent.invoke(new Command({ resume: 'Yes' }), config)
      expect(await readFile(join(root, 'created.txt'), 'utf8')).toBe('created once')
      expect(database.fileChanges.query({ runId: run.id }, root).operationCount).toBe(1)
    } finally {
      capacity.resolve('read'); await service.waitForIdle(); database.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it.each([
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
    { type: 'image', mimeType: 'image/png', data: 'AA==' }
  ])('preserves fast native text, $type, metadata and artifact results', async (image) => {
    const h = harness()
    try {
      const content = [{ type: 'text', text: 'answer' }, image]
      const artifact = [{ type: 'mcp_structured_content', structuredContent: { answer: 42 } }]
      const native = tool(async () => [content, artifact], {
        name: 'mcp_server_query', description: 'Query', schema: z.object({}),
        metadata: { annotations: { readOnlyHint: true } }, responseFormat: 'content_and_artifact'
      })
      const managed = withManagedToolExecution(native, h)
      expect(managed.schema).toBe(native.schema)
      const result = await invoke(managed, 'original-id')
      expect(result.content).toEqual(content)
      expect(result.artifact).toEqual(artifact)
      expect(result.tool_call_id).toBe('original-id')
    } finally { h.database.close() }
  })

  it('yields at ten seconds, keeps identical invocations separate and retrieves late artifacts', async () => {
    vi.useFakeTimers()
    const h = harness()
    const finishes = [deferred<string>(), deferred<string>()]
    let index = 0
    const native = tool(async () => {
      const text = await finishes[index++].promise
      return [[{ type: 'text', text }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }], { text }]
    }, {
      name: 'mcp_server_query', description: 'Query', schema: z.object({}),
      metadata: { annotations: { readOnlyHint: true } }, responseFormat: 'content_and_artifact'
    })
    try {
      const managed = withManagedToolExecution(native, h)
      let returned = false
      const first = invoke(managed, 'first').then((value) => { returned = true; return value })
      const second = invoke(managed, 'second')
      await vi.advanceTimersByTimeAsync(9_999)
      expect(returned).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const a = JSON.parse(String((await first).content)).call_id as string
      const b = JSON.parse(String((await second).content)).call_id as string
      expect(a).not.toBe(b)
      finishes[1].resolve('second result')
      await vi.advanceTimersByTimeAsync(1)
      expect(JSON.parse(h.service.read({ threadId: h.threadId, callId: a })).status).toBe('running')
      expect((await h.service.readResult(b, h.threadId))?.tool_call_id).toBe('second')
      const controls = await createRuntimeTools({ enabled: true, primaryFolder: process.cwd(), shell: false,
        network: false, memory: false, mcp: false, backgroundTools: true,
        threadId: h.threadId, managedCalls: h.service })
      const read = controls.find((entry) => entry.name === 'read_call_output')!
      const output = await read.invoke({ type: 'tool_call', id: 'read-result', name: read.name,
        args: { call_id: b, output_offset: 0, output_length: 100 } }) as ToolMessage
      expect(output.artifact).toEqual({ text: 'second result' })
      expect(output.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image_url' })]))
      finishes[0].resolve('first result')
      await vi.advanceTimersByTimeAsync(1)
    } finally { h.database.close() }
  })

  it('waits inline when disabled and leaves an existing background call intact', async () => {
    vi.useFakeTimers()
    const h = harness()
    const finishes = [deferred<string>(), deferred<string>()]
    let index = 0
    const native = tool(() => finishes[index++].promise, { name: 'read_file', description: 'Read', schema: z.object({}) })
    try {
      const first = invoke(withManagedToolExecution(native, h), 'first')
      await vi.advanceTimersByTimeAsync(10_000)
      const id = JSON.parse(String((await first).content)).call_id as string
      let returned = false
      const second = invoke(withManagedToolExecution(native, { ...h, allowBackground: false }), 'second')
        .then((result) => { returned = true; return result })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(returned).toBe(false)
      expect(JSON.parse(h.service.read({ threadId: h.threadId, callId: id })).status).toBe('running')
      finishes[1].resolve('inline')
      expect((await second).content).toBe('inline')
      finishes[0].resolve('background')
      await vi.advanceTimersByTimeAsync(1)
    } finally { h.database.close() }
  })

  it('does not recursively wrap orchestration and graph-state tools', () => {
    const h = harness()
    try {
      for (const name of ['wait_call', 'read_call', 'read_call_output', 'cancel_call', 'write_call', 'write_todos', 'start_subagent', 'wait_subagent']) {
        const native = tool(async () => 'ok', { name, description: name, schema: z.object({}) })
        expect(withManagedToolExecution(native, h)).toBe(native)
      }
    } finally { h.database.close() }
  })

  it('finishes a dispatched local commit truthfully when cancellation races it', async () => {
    vi.useFakeTimers()
    const h = harness()
    const finish = deferred<string>()
    const native = tool(async () => {
      armCurrentAgentToolEffect({ kind: 'file_patch', target: 'test' })
      return finish.promise
    }, { name: 'apply_patch', description: 'Write', schema: z.object({}) })
    try {
      const started = invoke(withManagedToolExecution(native, h), 'write')
      await vi.advanceTimersByTimeAsync(10_000)
      const id = JSON.parse(String((await started).content)).call_id as string
      const cancellation = h.service.cancel(id, h.threadId)
      finish.resolve('done')
      await vi.advanceTimersByTimeAsync(1)
      expect(JSON.parse(await cancellation).status).toBe('completed')
    } finally { h.database.close() }
  })

  it.each([false, true])('preserves confirmed Shell cancellation (uncertain termination: %s)', async (uncertain) => {
    vi.useFakeTimers()
    const h = harness()
    const native = tool(async () => {
      const control = currentToolExecution()!
      armCurrentAgentToolEffect({ kind: 'shell', target: 'long command' })
      await new Promise<void>((resolve) => control.signal.addEventListener('abort', () => resolve(), { once: true }))
      if (uncertain) control.markUncertain('The supervisor could not confirm termination.')
      const result = { ok: false, aborted: true, exit_code: 1, error: 'Command cancelled.' }
      control.setOutcome(result)
      return JSON.stringify(result)
    }, { name: 'pwsh', description: 'Shell', metadata: commandShellMetadata(), schema: z.object({}) })
    try {
      const started = invoke(withManagedToolExecution(native, h), 'shell-cancel')
      await vi.advanceTimersByTimeAsync(10_000)
      const id = JSON.parse(String((await started).content)).call_id as string
      const result = JSON.parse(await h.service.cancel(id, h.threadId))
      expect(result).toMatchObject({
        status: uncertain ? 'uncertain' : 'cancelled',
        executor_lingering: false,
        outcome_uncertain: uncertain
      })
      expect(h.database.getManagedCall(id, h.threadId)?.outcome).toMatchObject({ aborted: true, exit_code: 1 })
    } finally { h.database.close() }
  })

  it('keeps dispatched MCP cancellation uncertain when the remote outcome is not confirmed', async () => {
    vi.useFakeTimers()
    const h = harness()
    const native = tool(async () => {
      const control = currentToolExecution()!
      armCurrentAgentToolEffect({ kind: 'mcp_call', target: 'remote mutation' })
      await new Promise<void>((_resolve, reject) => control.signal.addEventListener('abort', () => reject(control.signal.reason), { once: true }))
      return 'unreachable'
    }, { name: 'mcp_remote_write', description: 'Write', schema: z.object({}) })
    try {
      const started = invoke(withManagedToolExecution(native, h), 'mcp-cancel')
      await vi.advanceTimersByTimeAsync(10_000)
      const id = JSON.parse(String((await started).content)).call_id as string
      expect(JSON.parse(await h.service.cancel(id, h.threadId))).toMatchObject({
        status: 'uncertain', executor_lingering: false, outcome_uncertain: true
      })
    } finally { h.database.close() }
  })

  it.each([true, false])('retains the real local commit result after cancellation has waited five seconds (ok: %s)', async (ok) => {
    vi.useFakeTimers()
    const h = harness()
    const finish = deferred<string>()
    const native = tool(async () => {
      armCurrentAgentToolEffect({ kind: 'file_patch', target: 'test' })
      const result = await finish.promise
      currentToolExecution()!.setOutcome({ ok })
      return result
    }, { name: 'apply_patch', description: 'Write', schema: z.object({}) })
    try {
      const started = invoke(withManagedToolExecution(native, h), 'slow-local-commit')
      await vi.advanceTimersByTimeAsync(10_000)
      const id = JSON.parse(String((await started).content)).call_id as string
      const cancellation = h.service.cancel(id, h.threadId)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(JSON.parse(await cancellation)).toMatchObject({
        status: 'running', executor_lingering: true, outcome_uncertain: false
      })
      expect(JSON.parse(h.service.read({ threadId: h.threadId, callId: id }))).toMatchObject({ status: 'running', terminal: false })
      expect(h.service.unresolvedForThread(h.threadId)).toEqual([expect.objectContaining({ id, status: 'running' })])
      expect(() => h.service.resolveObservedCall(id, h.threadId, h.runId)).toThrow('is still running')
      expect(h.database.deleteManagedCall(id, h.threadId)).toBe(false)
      let waitReturned = false
      const waiting = h.service.wait({ callId: id, threadId: h.threadId }).then((value) => { waitReturned = true; return value })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(waitReturned).toBe(false)
      const content = JSON.stringify({ ok, ...(ok ? { saved: true } : { error: 'Commit failed with a confirmed result.' }) })
      finish.resolve(content)
      await vi.advanceTimersByTimeAsync(1)
      expect(JSON.parse(await waiting)).toMatchObject({ status: ok ? 'completed' : 'failed', terminal: true })
      expect((await h.service.readResult(id, h.threadId))?.content).toBe(content)
      expect(JSON.parse(h.service.readOutput({ callId: id, threadId: h.threadId, offset: 0, length: 1_000 }))).toMatchObject({
        output_chars_total: content.length,
        output: [expect.objectContaining({ text: content })]
      })
      expect(h.service.activeCallIds()).not.toContain(id)
    } finally { h.database.close() }
  })

  it('preserves executor failure outcomes and fractional progress', async () => {
    vi.useFakeTimers()
    const h = harness()
    const finish = deferred<string>()
    const native = tool(async () => {
      const control = currentToolExecution()!
      control.progress(0.5, 'steps', 2.5)
      control.setOutcome({ ok: false, error: 'executor failure' })
      return finish.promise
    }, { name: 'read_file', description: 'Read', schema: z.object({}) })
    try {
      const started = invoke(withManagedToolExecution(native, h), 'failure')
      await vi.advanceTimersByTimeAsync(10_000)
      const id = JSON.parse(String((await started).content)).call_id as string
      expect(h.database.getManagedCall(id, h.threadId)?.progressCurrent).toBe(0.5)
      finish.resolve('failure details')
      await vi.advanceTimersByTimeAsync(1)
      expect(h.database.getManagedCall(id, h.threadId)?.status).toBe('failed')
    } finally { h.database.close() }
  })
})
