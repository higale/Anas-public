import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolMessage } from '@langchain/core/messages'
import { ToolInputParsingException } from '@langchain/core/tools'
import { createAgent, FakeToolCallingModel } from 'langchain'
import { createRuntimeTools } from '../llm/runtimeTools'
import { createToolInputErrorMiddleware } from './toolInputErrors'
import { createAgentToolEffectMiddleware } from './toolEffectMiddleware'
import { AgentDatabase } from './agentDatabase'
import { ManagedCallService, type ManagedCallControl } from './managedCallService'
import {
  currentAgentToolEffectArtifactId,
  runWithCurrentAgentToolEffect
} from './toolEffectScope'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function createRun(database: AgentDatabase, suffix: string) {
  const thread = database.createThread({ title: `Managed call ${suffix}` })
  const run = database.createRun(thread.id, `run-${suffix}`)
  return { thread, run }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('ManagedCallService', () => {
  it('cancels queued calls before execution and retains busy slots until real settlement', async () => {
    vi.useFakeTimers()
    const database = AgentDatabase.open(':memory:'), service = new ManagedCallService(database)
    const { thread, run } = createRun(database, 'queued-cancel')
    const releases = Array.from({ length: 10 }, () => deferred<string>())
    const executed: number[] = []
    try {
      const starts = releases.map((release, index) => service.start({ kind: 'builtin', threadId: thread.id, runId: run.id,
        summary: `call ${index}`, execute: control => { control.markRunning(); executed.push(index); return release.promise } }))
      await vi.advanceTimersByTimeAsync(10_000)
      const handles = (await Promise.all(starts)).map(result => JSON.parse(result))
      expect(executed).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
      expect(JSON.parse(await service.cancel(handles[8].call_id, thread.id))).toMatchObject({ status: 'cancelled', executor_lingering: false })
      const cancelRunning = service.cancel(handles[0].call_id, thread.id)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(JSON.parse(await cancelRunning)).toMatchObject({ executor_lingering: true })
      expect(executed).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
      releases[0].resolve('done')
      await vi.advanceTimersByTimeAsync(0)
      expect(executed).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 9])
    } finally { releases.forEach(release => release.resolve('done')); await service.waitForIdle(); database.close() }
  })

  it('serializes conflicting mutations without consuming the other execution slots', async () => {
    vi.useFakeTimers()
    const database = AgentDatabase.open(':memory:'), service = new ManagedCallService(database)
    const { thread, run } = createRun(database, 'queued-mutations')
    const release = deferred<string>(), writes: number[] = []
    try {
      const starts = Array.from({ length: 6 }, (_, index) => service.start({ kind: 'builtin', threadId: thread.id,
        runId: run.id, summary: `write ${index}`, serialGroup: 'filesystem-writes', execute: control => {
          control.markRunning(); writes.push(index); return release.promise
        } }))
      await vi.advanceTimersByTimeAsync(0)
      expect(writes).toEqual([0])
      expect(await service.start({ kind: 'builtin', threadId: thread.id, runId: run.id, summary: 'read', execute: async control => {
        control.markRunning(); return 'read while writes wait'
      } })).toBe('read while writes wait')
      release.resolve('done')
      expect(await Promise.all(starts)).toEqual(Array(6).fill('done'))
      expect(writes).toEqual([0, 1, 2, 3, 4, 5])
    } finally { release.resolve('done'); await service.waitForIdle(); database.close() }
  })

  it('bounds queued work and removes it on shutdown without dispatching it', async () => {
    vi.useFakeTimers()
    const database = AgentDatabase.open(':memory:'), service = new ManagedCallService(database)
    const { thread, run } = createRun(database, 'queue-bound')
    let executions = 0
    try {
      const start = () => service.start({ kind: 'builtin' as const, threadId: thread.id, runId: run.id, summary: 'waiting',
        execute: async control => {
          executions++; control.markRunning()
          await new Promise<void>(resolve => control.signal.addEventListener('abort', () => resolve(), { once: true }))
          return 'cancelled'
        } })
      const starts = Array.from({ length: 64 }, start)
      expect(JSON.parse(await start())).toMatchObject({ ok: false, error: expect.stringContaining('queue is full') })
      expect(executions).toBe(8)
      await service.shutdown()
      await Promise.all(starts)
      expect(executions).toBe(8)
      expect(service.activeCallIds()).toEqual([])
    } finally { await service.shutdown(); database.close() }
  })

  it('binds input to the live terminal instance and never carries it across ownership or restart', async () => {
    vi.useFakeTimers()
    const database = AgentDatabase.open(':memory:')
    const service = new ManagedCallService(database)
    const finish = deferred<string>()
    try {
      const { thread, run } = createRun(database, 'pty')
      const acknowledgement = deferred<void>()
      const apply = vi.fn(() => acknowledgement.promise)
      const terminal = { id: '22222222-2222-4222-8222-222222222222', size: { columns: 100, rows: 30 }, apply }
      const starting = service.start({ kind: 'shell', threadId: thread.id, runId: run.id, summary: 'Interactive CLI',
        execute: async (control) => {
          control.markRunning(); control.setTerminal!(terminal)
          control.output('stdout', 'READY'); return finish.promise
        } })
      await vi.advanceTimersByTimeAsync(10_000)
      const { call_id: callId } = JSON.parse(await starting)
      expect(JSON.parse(service.read({ callId, threadId: thread.id })).pty).toEqual({ terminal_id: terminal.id, ...terminal.size, input_available: true })
      const action = { type: 'text' as const, text: 'hello\r' }
      const arm = vi.fn()
      const send = () => service.writeTerminal(callId, thread.id, terminal.id, action)
      const accepted = vi.fn()
      const sending = runWithCurrentAgentToolEffect({ arm }, send).then(accepted)
      await vi.advanceTimersByTimeAsync(0)
      expect(accepted).not.toHaveBeenCalled()
      acknowledgement.resolve()
      await sending
      expect(JSON.parse(accepted.mock.calls[0][0])).toMatchObject({ ok: true, call_id: callId })
      expect(arm).toHaveBeenCalledWith(expect.objectContaining({ kind: 'terminal_input', recoveryMode: 'confirm',
        target: { callId, threadId: thread.id, terminalId: terminal.id, action } }))
      expect(apply).toHaveBeenCalledExactlyOnceWith(action)
      await expect(service.writeTerminal(callId, 'other-thread', terminal.id, action)).rejects.toBeInstanceOf(ToolInputParsingException)
      await expect(service.writeTerminal(callId, thread.id, 'stale-terminal', action)).rejects.toBeInstanceOf(ToolInputParsingException)
      await expect(new ManagedCallService(database).writeTerminal(callId, thread.id, terminal.id, action)).rejects.toBeInstanceOf(ToolInputParsingException)
      await expect(runWithCurrentAgentToolEffect({ arm: () => { throw new Error('journal failed') } }, send)).rejects.toThrow('journal failed')
      expect(apply).toHaveBeenCalledTimes(1)
      apply.mockRejectedValueOnce(new Error('acknowledgement lost'))
      await expect(runWithCurrentAgentToolEffect({ arm }, send)).rejects.toThrow('acknowledgement lost')
      expect(apply).toHaveBeenCalledTimes(2) // A failed acknowledgement must not cause an automatic resend.
      finish.resolve('done'); await vi.advanceTimersByTimeAsync(1)
      await expect(send()).rejects.toThrow('unavailable')
      expect(JSON.parse(service.read({ callId, threadId: thread.id }))).not.toHaveProperty('pty')
    } finally { finish.resolve('done'); await service.waitForIdle(); database.close() }
  })

  it('returns a stale terminal target to the model before dispatch and allows a status read', async () => {
    const database = AgentDatabase.open(':memory:')
    const service = new ManagedCallService(database)
    try {
      const { thread, run } = createRun(database, 'stale-terminal')
      const available = await createRuntimeTools({ enabled: true, primaryFolder: '.', threadId: thread.id, runId: run.id,
        memory: false, network: false, shell: true, mcp: false, backgroundTools: true, managedCalls: service,
        commandShell: { executable: 'pwsh', name: 'PowerShell', family: 'powershell', version: '7.5.0' } })
      const tools = available.filter(tool => ['write_call', 'read_call'].includes(tool.name))
      const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[{
        id: 'stale', name: 'write_call', args: {
          call_id: '11111111-1111-4111-8111-111111111111', terminal_id: '22222222-2222-4222-8222-222222222222',
          action: { type: 'text', text: 'do not send' }
        }
      }], [{ id: 'inspect', name: 'read_call', args: {} }], []] }), tools, checkpointer: database.checkpointer,
        middleware: [createToolInputErrorMiddleware(), createAgentToolEffectMiddleware({ database, runId: run.id, threadId: thread.id, tools })] })
      const result = await agent.invoke({ messages: [{ role: 'user', content: 'Inspect the terminal.' }] }, {
        configurable: { thread_id: thread.id }, durability: 'sync'
      })
      const responses = result.messages.filter(ToolMessage.isInstance)
      expect(responses).toMatchObject([
        { tool_call_id: 'stale', status: 'error', content: expect.stringContaining('terminal instance is unavailable') },
        { tool_call_id: 'inspect', status: 'success' }
      ])
      expect(result).not.toHaveProperty('__interrupt__')
      expect(JSON.parse(responses[1].content as string)).toMatchObject({ count: 0, calls: [] })
    } finally { await service.waitForIdle(); database.close() }
  })

  it('flushes a large burst before its timer without losing persisted output', async () => {
    vi.useFakeTimers()
    const database = AgentDatabase.open(':memory:')
    const service = new ManagedCallService(database)
    const finish = deferred<string>()
    let starting: Promise<string> | undefined
    try {
      const { thread, run } = createRun(database, 'pty-burst')
      starting = service.start({ kind: 'shell', threadId: thread.id, runId: run.id, summary: 'output',
        execute: async (control) => { control.markRunning(); control.output('stdout', '中'.repeat(1_000_000)); return finish.promise } })
      // Yield promises but not the 50 ms output flush timer.
      await vi.advanceTimersByTimeAsync(0)
      const callId = service.activeCallIds()[0]
      expect(database.getManagedCall(callId, thread.id)!.outputChars).toBeGreaterThan(0)
      finish.resolve('done'); await starting
    } finally { finish.resolve('done'); await starting; await service.waitForIdle(); database.close() }
  })
  it('keeps fast operations as ordinary tool results', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const { thread, run } = createRun(database, 'fast')
      const service = new ManagedCallService(database)
      await expect(service.start({
        kind: 'http',
        threadId: thread.id,
        runId: run.id,
        summary: 'fast request',
        execute: async (control) => {
          control.markRunning()
          return 'fast result'
        }
      })).resolves.toBe('fast result')
    } finally {
      database.close()
    }
  })

  it('keeps a fast effect-scoped result available to a replay without re-executing', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const { thread, run } = createRun(database, 'fast-effect-replay')
      const effectKey = {
        runId: run.id,
        checkpointId: 'checkpoint-fast-effect-replay',
        checkpointNs: '',
        taskId: 'framework-task-fast-effect-replay',
        callKey: 'id:tool-call-fast-effect-replay',
        inputHash: 'b'.repeat(64)
      }
      const scope = { effectKey, arm: vi.fn() }
      const callId = runWithCurrentAgentToolEffect(
        scope,
        () => currentAgentToolEffectArtifactId('managed-call')
      )
      if (!callId) throw new Error('Expected a stable managed call ID.')
      const execute = vi.fn(async (control: ManagedCallControl) => {
        control.markRunning()
        return 'durable fast result'
      })
      const startOptions = {
        kind: 'http' as const,
        threadId: thread.id,
        runId: run.id,
        summary: 'fast effect request',
        execute
      }

      await expect(runWithCurrentAgentToolEffect(
        scope,
        () => new ManagedCallService(database).start(startOptions)
      )).resolves.toBe('durable fast result')
      expect(database.getManagedCall(callId, thread.id)).toMatchObject({
        status: 'completed',
        result: 'durable fast result'
      })
      expect(database.getManagedCall(callId, thread.id)).not.toHaveProperty('detachedAt')

      const replayExecute = vi.fn(async () => 'must not execute')
      const replay = await runWithCurrentAgentToolEffect(
        scope,
        () => new ManagedCallService(database).start({
          ...startOptions,
          execute: replayExecute
        })
      )

      expect(replay).toBe('durable fast result')
      expect(replayExecute).not.toHaveBeenCalled()
      expect(database.getManagedCall(callId, thread.id)).toMatchObject({
        result: 'durable fast result'
      })
    } finally {
      database.close()
    }
  })

  it('returns a durable handle after ten seconds and exposes output separately', async () => {
    vi.useFakeTimers()
    const database = AgentDatabase.open(':memory:')
    try {
      const { thread, run } = createRun(database, 'slow')
      const service = new ManagedCallService(database)
      const completion = deferred<string>()
      let control!: ManagedCallControl
      const starting = service.start({
        kind: 'shell',
        threadId: thread.id,
        runId: run.id,
        summary: 'long build',
        execute: async (callControl) => {
          control = callControl
          control.markRunning()
          control.output('stdout', 'building\n')
          return completion.promise
        }
      })

      let detached = false
      void starting.then(() => { detached = true })
      await vi.advanceTimersByTimeAsync(9_999)
      expect(detached).toBe(false)
      control.output('stderr', 'late')
      await vi.advanceTimersByTimeAsync(1)
      const handle = JSON.parse(await starting) as {
        call_id: string
        status: string
        output_chars_total: number
      }
      expect(handle.status).toBe('running')
      expect(handle.output_chars_total).toBe(13)
      expect(service.unresolvedForRun(run.id).map((call) => call.id)).toEqual([handle.call_id])
      expect(JSON.parse(service.read({
        callId: handle.call_id,
        threadId: thread.id
      }))).toMatchObject({
        status: 'running',
        output_chars_total: 13
      })
      expect(JSON.parse(service.read({ threadId: thread.id }))).toMatchObject({
        count: 1,
        calls: [{ call_id: handle.call_id, status: 'running', output_chars_total: 13 }]
      })
      control.progress(500, 'bytes', 1_000)
      await vi.advanceTimersByTimeAsync(250)
      expect(JSON.parse(service.read({
        callId: handle.call_id,
        threadId: thread.id
      }))).toMatchObject({
        progress: { current: 500, total: 1_000, unit: 'bytes' }
      })
      expect(JSON.parse(service.readOutput({
        callId: handle.call_id,
        threadId: thread.id,
        offset: -100,
        length: 100
      }))).toMatchObject({
        output_start: 0,
        output_end: 13,
        output_chars_total: 13,
        output: [
          { stream: 'stdout', start: 0, end: 9, text: 'building\n' },
          { stream: 'stderr', start: 9, end: 13, text: 'late' }
        ]
      })

      completion.resolve('build complete')
      await vi.advanceTimersByTimeAsync(0)
      const finished = JSON.parse(await service.wait({
        callId: handle.call_id,
        threadId: thread.id
      }))
      expect(finished).toMatchObject({
        status: 'completed',
        terminal: true,
        output_chars_total: 13
      })
      expect(service.unresolvedForRun(run.id).map((call) => call.id)).toEqual([handle.call_id])
      service.resolveObservedCall(handle.call_id, thread.id, run.id)
      expect(service.unresolvedForRun(run.id)).toEqual([])
    } finally {
      database.close()
    }
  })

  it('surfaces a structured failed operation outcome without returning its output', async () => {
    vi.useFakeTimers()
    const database = AgentDatabase.open(':memory:')
    try {
      const { thread, run } = createRun(database, 'failed-outcome')
      const service = new ManagedCallService(database)
      const completion = deferred<string>()
      const starting = service.start({
        kind: 'shell',
        threadId: thread.id,
        runId: run.id,
        summary: 'failing build',
        execute: async (control) => {
          control.markRunning()
          control.output('stderr', 'compiler failed\n')
          control.setOutcome({ ok: false, exit_code: 1, error: 'command exited with code 1' })
          return completion.promise
        }
      })
      await vi.advanceTimersByTimeAsync(10_000)
      const handle = JSON.parse(await starting) as { call_id: string }
      completion.resolve('opaque result')
      await vi.advanceTimersByTimeAsync(0)

      expect(JSON.parse(service.read({
        callId: handle.call_id,
        threadId: thread.id
      }))).toMatchObject({
        status: 'failed',
        terminal: true,
        output_chars_total: 16,
        outcome: { ok: false, exit_code: 1, error: 'command exited with code 1' },
        error: 'command exited with code 1'
      })
    } finally {
      database.close()
    }
  })

  it('waits for the full timeout regardless of existing output', async () => {
    vi.useFakeTimers()
    const database = AgentDatabase.open(':memory:')
    try {
      const { thread, run } = createRun(database, 'wait-timeout')
      const call = database.createManagedCall({
        id: '99999999-9999-8999-8999-999999999999',
        threadId: thread.id,
        runId: run.id,
        kind: 'shell',
        summary: 'long quiet call'
      })
      database.markManagedCallRunning(call.id, thread.id)
      database.appendManagedCallOutput({
        callId: call.id,
        threadId: thread.id,
        stream: 'stderr',
        text: 'already observed\n'
      })
      const service = new ManagedCallService(database)

      let settled = false
      const waiting = service.wait({
        callId: call.id,
        threadId: thread.id,
        timeoutMs: 30_000
      }).then((result) => {
        settled = true
        return result
      })
      await vi.advanceTimersByTimeAsync(29_999)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(JSON.parse(await waiting)).toMatchObject({
        status: 'running',
        terminal: false,
        output_chars_total: 17
      })
    } finally {
      database.close()
    }
  })

  it('does not return before the timeout when new output arrives', async () => {
    vi.useFakeTimers()
    const database = AgentDatabase.open(':memory:')
    try {
      const { thread, run } = createRun(database, 'wait-new-output')
      const service = new ManagedCallService(database)
      const completion = deferred<string>()
      let control!: ManagedCallControl
      const starting = service.start({
        kind: 'shell',
        threadId: thread.id,
        runId: run.id,
        summary: 'long call with delayed output',
        execute: async (callControl) => {
          control = callControl
          control.markRunning()
          return completion.promise
        }
      })
      await vi.advanceTimersByTimeAsync(10_000)
      const handle = JSON.parse(await starting) as { call_id: string }

      let settled = false
      const waiting = service.wait({
        callId: handle.call_id,
        threadId: thread.id,
        timeoutMs: 30_000
      }).then((result) => {
        settled = true
        return result
      })
      control.output('stdout', 'new output\n')
      await vi.advanceTimersByTimeAsync(49)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toBe(false)
      await vi.advanceTimersByTimeAsync(29_950)
      expect(JSON.parse(await waiting)).toMatchObject({
        status: 'running',
        output_chars_total: 11
      })

      completion.resolve('done')
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      database.close()
    }
  })

  it('returns before the timeout when a quiet call reaches a terminal state', async () => {
    vi.useFakeTimers()
    const database = AgentDatabase.open(':memory:')
    try {
      const { thread, run } = createRun(database, 'wait-completion')
      const service = new ManagedCallService(database)
      const completion = deferred<string>()
      const starting = service.start({
        kind: 'http',
        threadId: thread.id,
        runId: run.id,
        summary: 'quiet call that completes',
        execute: async (control) => {
          control.markRunning()
          return completion.promise
        }
      })
      await vi.advanceTimersByTimeAsync(10_000)
      const handle = JSON.parse(await starting) as { call_id: string }

      let settled = false
      const waiting = service.wait({
        callId: handle.call_id,
        threadId: thread.id,
        timeoutMs: 30_000
      }).then((result) => {
        settled = true
        return result
      })
      await vi.advanceTimersByTimeAsync(1_000)
      expect(settled).toBe(false)
      completion.resolve('completed result')
      await vi.advanceTimersByTimeAsync(0)

      expect(JSON.parse(await waiting)).toMatchObject({
        call_id: handle.call_id,
        status: 'completed',
        terminal: true,
        output_chars_total: 0
      })
    } finally {
      database.close()
    }
  })

  it('wakes concurrent waiters only when their own call finishes', async () => {
    vi.useFakeTimers()
    const database = AgentDatabase.open(':memory:')
    try {
      const { thread, run } = createRun(database, 'wait-routing')
      const service = new ManagedCallService(database)
      const firstCompletion = deferred<string>()
      const secondCompletion = deferred<string>()
      let firstControl!: ManagedCallControl
      let secondControl!: ManagedCallControl
      const firstStarting = service.start({
        kind: 'shell',
        threadId: thread.id,
        runId: run.id,
        summary: 'first concurrent wait call',
        execute: async (control) => {
          firstControl = control
          control.markRunning()
          return firstCompletion.promise
        }
      })
      const secondStarting = service.start({
        kind: 'http',
        threadId: thread.id,
        runId: run.id,
        summary: 'second concurrent wait call',
        execute: async (control) => {
          secondControl = control
          control.markRunning()
          return secondCompletion.promise
        }
      })
      await vi.advanceTimersByTimeAsync(10_000)
      const firstHandle = JSON.parse(await firstStarting) as { call_id: string }
      const secondHandle = JSON.parse(await secondStarting) as { call_id: string }

      let firstSettled = false
      let secondSettled = false
      const firstWaiting = service.wait({
        callId: firstHandle.call_id,
        threadId: thread.id,
        timeoutMs: 30_000
      }).then((result) => {
        firstSettled = true
        return result
      })
      const secondWaiting = service.wait({
        callId: secondHandle.call_id,
        threadId: thread.id,
        timeoutMs: 30_000
      }).then((result) => {
        secondSettled = true
        return result
      })

      firstControl.output('stdout', 'first output\n')
      await vi.advanceTimersByTimeAsync(50)
      expect(firstSettled).toBe(false)
      expect(secondSettled).toBe(false)
      firstCompletion.resolve('first done')
      await vi.advanceTimersByTimeAsync(0)
      expect(JSON.parse(await firstWaiting)).toMatchObject({
        call_id: firstHandle.call_id,
        status: 'completed',
        output_chars_total: 13
      })

      secondControl.output('progress', 'second output\n')
      await vi.advanceTimersByTimeAsync(50)
      expect(secondSettled).toBe(false)
      secondCompletion.resolve('second done')
      await vi.advanceTimersByTimeAsync(0)
      expect(JSON.parse(await secondWaiting)).toMatchObject({
        call_id: secondHandle.call_id,
        status: 'completed',
        output_chars_total: 14
      })
    } finally {
      database.close()
    }
  })

  it('batches rapid output into one persistence transaction', async () => {
    vi.useFakeTimers()
    const database = AgentDatabase.open(':memory:')
    try {
      const { thread, run } = createRun(database, 'batched-output')
      const service = new ManagedCallService(database)
      const completion = deferred<string>()
      const append = vi.spyOn(database, 'appendManagedCallOutputBatch')
      const starting = service.start({
        kind: 'shell',
        threadId: thread.id,
        runId: run.id,
        summary: 'chatty process',
        execute: async (control) => {
          control.markRunning()
          for (let index = 0; index < 100; index += 1) {
            control.output('stdout', `${index}\n`)
          }
          return completion.promise
        }
      })

      await vi.advanceTimersByTimeAsync(50)
      expect(append).toHaveBeenCalledOnce()
      expect(append.mock.calls[0][0].chunks).toHaveLength(100)

      completion.resolve('done')
      await vi.advanceTimersByTimeAsync(0)
      await expect(starting).resolves.toBe('done')
    } finally {
      database.close()
    }
  })

  it('aborts and records uncertainty instead of dropping output after a persistence failure', async () => {
    vi.useFakeTimers()
    const database = AgentDatabase.open(':memory:')
    try {
      const { thread, run } = createRun(database, 'output-failure')
      const service = new ManagedCallService(database)
      vi.spyOn(database, 'appendManagedCallOutputBatch').mockImplementation(() => {
        throw new Error('disk full')
      })
      const starting = service.start({
        kind: 'shell',
        threadId: thread.id,
        runId: run.id,
        summary: 'output must remain durable',
        execute: async (control) => {
          control.markRunning()
          control.output('stdout', 'must not be silently discarded')
          await new Promise<void>((resolve) => {
            control.signal.addEventListener('abort', () => resolve(), { once: true })
          })
          return 'executor stopped'
        }
      })

      await vi.advanceTimersByTimeAsync(50)
      const handle = JSON.parse(await starting) as { call_id: string; status: string }
      expect(handle.status).toBe('uncertain')
      expect(JSON.parse(service.read({
        callId: handle.call_id,
        threadId: thread.id
      }))).toMatchObject({
        status: 'uncertain',
        terminal: true,
        output_chars_total: 0,
        error: expect.stringContaining('disk full')
      })
    } finally {
      database.close()
    }
  })

  it('falls back to a durable uncertain state when the exact terminal result cannot be stored', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const { thread, run } = createRun(database, 'terminal-persistence-failure')
      const service = new ManagedCallService(database)
      const finishManagedCall = database.finishManagedCall.bind(database)
      const finish = vi.spyOn(database, 'finishManagedCall')
        .mockImplementationOnce(() => {
          throw new Error('result is too large')
        })
        .mockImplementation((input) => finishManagedCall(input))

      const handle = JSON.parse(await service.start({
        kind: 'http',
        threadId: thread.id,
        runId: run.id,
        summary: 'store terminal result',
        execute: async (control) => {
          control.markRunning()
          control.setOutcome({ ok: true, status: 200 })
          return 'completed response'
        }
      })) as { call_id: string; status: string }

      expect(finish).toHaveBeenCalledTimes(2)
      expect(handle.status).toBe('uncertain')
      expect(JSON.parse(service.read({
        callId: handle.call_id,
        threadId: thread.id
      }))).toMatchObject({
        status: 'uncertain',
        terminal: true,
        error: expect.stringContaining('result is too large')
      })
    } finally {
      database.close()
    }
  })

  it('cancels an exact active call and reports its terminal state', async () => {
    vi.useFakeTimers()
    const database = AgentDatabase.open(':memory:')
    try {
      const { thread, run } = createRun(database, 'cancel')
      const service = new ManagedCallService(database)
      const starting = service.start({
        kind: 'shell',
        threadId: thread.id,
        runId: run.id,
        summary: 'cancel me',
        execute: (control) => new Promise<string>((resolve) => {
          control.markRunning()
          control.signal.addEventListener('abort', () => resolve('cancelled by signal'), { once: true })
        })
      })
      await vi.advanceTimersByTimeAsync(10_000)
      const handle = JSON.parse(await starting) as { call_id: string }

      const cancellation = service.cancel(handle.call_id, thread.id)
      await vi.advanceTimersByTimeAsync(0)
      expect(JSON.parse(await cancellation)).toMatchObject({
        status: 'cancelled',
        changed: true,
        executor_lingering: false,
        outcome_uncertain: false,
        message: 'The call was cancelled.'
      })
      expect(JSON.parse(service.read({
        callId: handle.call_id,
        threadId: thread.id
      }))).toMatchObject({
        status: 'cancelled',
        terminal: true
      })
    } finally {
      database.close()
    }
  })

  it('bounds exact cancellation and keeps an unresponsive dispatched executor identifiable', async () => {
    vi.useFakeTimers()
    const database = AgentDatabase.open(':memory:')
    try {
      const { thread, run } = createRun(database, 'exact-cancel-timeout')
      const service = new ManagedCallService(database)
      const completion = deferred<string>()
      const starting = service.start({
        kind: 'shell',
        threadId: thread.id,
        runId: run.id,
        summary: 'ignore cancellation after dispatch',
        execute: async (control) => {
          control.markRunning()
          return completion.promise
        }
      })
      await vi.advanceTimersByTimeAsync(10_000)
      const handle = JSON.parse(await starting) as { call_id: string }

      const cancellation = service.cancel(handle.call_id, thread.id)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(JSON.parse(await cancellation)).toMatchObject({
        status: 'running',
        changed: true,
        executor_lingering: true,
        outcome_uncertain: true,
        message: expect.stringContaining('executor is still running')
      })
      expect(service.hasActiveForThread(thread.id)).toBe(true)
      expect(JSON.parse(await service.cancel(handle.call_id, thread.id))).toMatchObject({
        status: 'running',
        changed: false,
        executor_lingering: true
      })

      completion.resolve('late result')
      await vi.advanceTimersByTimeAsync(0)
      expect(service.hasActiveForThread(thread.id)).toBe(false)
      expect(JSON.parse(service.read({
        callId: handle.call_id,
        threadId: thread.id
      }))).toMatchObject({
        status: 'cancelled',
        terminal: true
      })
    } finally {
      database.close()
    }
  })

  it('keeps pre-dispatch cancellation pending until its executor winds down', async () => {
    vi.useFakeTimers()
    const database = AgentDatabase.open(':memory:')
    try {
      const { thread, run } = createRun(database, 'exact-pre-dispatch-timeout')
      const service = new ManagedCallService(database)
      const completion = deferred<string>()
      let callControl!: ManagedCallControl
      const starting = service.start({
        kind: 'shell',
        threadId: thread.id,
        runId: run.id,
        summary: 'ignore cancellation before dispatch',
        execute: (control) => {
          callControl = control
          return completion.promise
        }
      })
      await vi.advanceTimersByTimeAsync(10_000)
      const handle = JSON.parse(await starting) as { call_id: string; status: string }
      expect(handle.status).toBe('preparing')

      const cancellation = service.cancel(handle.call_id, thread.id)
      expect(() => callControl.markRunning()).toThrow('cancelled before dispatch')
      await vi.advanceTimersByTimeAsync(5_000)
      expect(JSON.parse(await cancellation)).toMatchObject({
        status: 'preparing',
        changed: true,
        executor_lingering: true,
        outcome_uncertain: false,
        message: expect.stringContaining('executor is still running')
      })
      expect(service.hasActiveForThread(thread.id)).toBe(true)

      completion.resolve('late result')
      await vi.advanceTimersByTimeAsync(0)
      expect(service.hasActiveForThread(thread.id)).toBe(false)
      expect(JSON.parse(service.read({
        callId: handle.call_id,
        threadId: thread.id
      }))).toMatchObject({
        status: 'cancelled',
        terminal: true
      })
    } finally {
      database.close()
    }
  })

  it.each(['http', 'builtin', 'mcp'] as const)('recovers dispatched %s work as a detached uncertain call after an application restart', async (kind) => {
    const root = mkdtempSync(join(tmpdir(), 'anas-managed-call-'))
    const file = join(root, 'agent.sqlite')
    try {
      const first = AgentDatabase.open(file, join(root, 'attachments'))
      const { thread, run } = createRun(first, 'restart')
      first.createManagedCall({
        id: 'call-restart',
        threadId: thread.id,
        runId: run.id,
        kind,
        summary: 'remote mutation'
      })
      first.markManagedCallRunning('call-restart', thread.id)
      first.close()

      const recovered = AgentDatabase.open(file, join(root, 'attachments'))
      try {
        expect(recovered.getManagedCall('call-restart', thread.id)).toMatchObject({
          status: 'uncertain',
          detachedAt: expect.any(String),
          error: expect.stringContaining('outcome is unknown')
        })
        const service = new ManagedCallService(recovered)
        expect(service.unresolvedForRun(run.id).map((call) => call.id)).toEqual(['call-restart'])
        expect(service.unresolvedForThread(thread.id).map((call) => call.id)).toEqual(['call-restart'])
        await expect(service.cancelRun(run.id)).resolves.toEqual({
          uncertainCallIds: ['call-restart'],
          lingeringCallIds: []
        })
        service.resolveObservedCall('call-restart', thread.id, run.id)
        expect(service.unresolvedForRun(run.id)).toEqual([])
      } finally {
        recovered.close()
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('re-executes an uncertain durable call after effect recovery authorizes a retry', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const { thread, run } = createRun(database, 'effect-retry')
      const effectKey = {
        runId: run.id,
        checkpointId: 'checkpoint-retry',
        checkpointNs: '',
        taskId: 'framework-task-retry',
        callKey: 'id:tool-call-retry',
        inputHash: 'a'.repeat(64)
      }
      const scope = { effectKey, arm: vi.fn() }
      const callId = runWithCurrentAgentToolEffect(
        scope,
        () => currentAgentToolEffectArtifactId('managed-call')
      )
      if (!callId) throw new Error('Expected a stable managed call ID.')
      database.createManagedCall({
        id: callId,
        threadId: thread.id,
        runId: run.id,
        kind: 'http',
        summary: 'retry remote request'
      })
      database.markManagedCallRunning(callId, thread.id)
      database.finishManagedCall({
        callId,
        threadId: thread.id,
        status: 'uncertain',
        error: 'The previous attempt ended without a durable result.'
      })

      const execute = vi.fn(async (control: ManagedCallControl) => {
        control.markRunning()
        return 'retried result'
      })
      await expect(runWithCurrentAgentToolEffect(scope, () => new ManagedCallService(database).start({
        kind: 'http',
        threadId: thread.id,
        runId: run.id,
        summary: 'retry remote request',
        execute
      }))).resolves.toBe('retried result')
      expect(execute).toHaveBeenCalledOnce()
      expect(database.getManagedCall(callId, thread.id)).toMatchObject({
        status: 'completed',
        result: 'retried result'
      })
    } finally {
      database.close()
    }
  })

  it('keeps a fast uncertain outcome as a durable call instead of a normal result', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const { thread, run } = createRun(database, 'fast-uncertain')
      const service = new ManagedCallService(database)
      const handle = JSON.parse(await service.start({
        kind: 'http',
        threadId: thread.id,
        runId: run.id,
        summary: 'ambiguous POST',
        execute: async (control) => {
          control.markRunning()
          control.markUncertain('The connection ended after dispatch.')
          return JSON.stringify({ ok: false, error: 'connection reset' })
        }
      })) as { call_id: string; status: string }

      expect(handle.status).toBe('uncertain')
      expect(service.unresolvedForRun(run.id).map((call) => call.id)).toEqual([handle.call_id])
      expect(JSON.parse(service.read({
        callId: handle.call_id,
        threadId: thread.id
      }))).toMatchObject({
        status: 'uncertain',
        error: 'The connection ended after dispatch.'
      })
      expect(service.unresolvedForRun(run.id).map((call) => call.id)).toEqual([handle.call_id])
      service.resolveObservedCall(handle.call_id, thread.id, run.id)
      expect(service.unresolvedForRun(run.id)).toEqual([])
    } finally {
      database.close()
    }
  })

  it.each([false, true])('retains late output and outcomes after cancellation times out (remote uncertainty: %s)', async (remote) => {
    vi.useFakeTimers()
    const database = AgentDatabase.open(':memory:')
    const service = new ManagedCallService(database)
    const completion = deferred<string>()
    try {
      const { thread, run } = createRun(database, 'cancel-timeout')
      let callControl!: ManagedCallControl
      const starting = service.start({
        kind: remote ? 'mcp' : 'shell', threadId: thread.id, runId: run.id,
        summary: 'unresponsive process',
        uncertainWhenCancelledAfterDispatch: remote,
        execute: async (control) => {
          callControl = control
          control.markRunning()
          control.output('stdout', 'before\n')
          return completion.promise
        }
      })
      await vi.advanceTimersByTimeAsync(10_000)
      const handle = JSON.parse(await starting) as { call_id: string }
      const cancellation = service.cancelRun(run.id)
      await vi.advanceTimersByTimeAsync(5_000)
      await expect(cancellation).resolves.toEqual({ uncertainCallIds: [handle.call_id], lingeringCallIds: [handle.call_id] })
      expect(JSON.parse(service.read({ callId: handle.call_id, threadId: thread.id }))).toMatchObject({
        status: 'running', terminal: false, cancellation_requested: true
      })
      expect(service.hasActiveForThread(thread.id)).toBe(true)
      expect(() => service.resolveObservedCall(handle.call_id, thread.id, run.id)).toThrow('still running')
      callControl.output('stdout', 'after\n')
      await vi.advanceTimersByTimeAsync(50)
      expect(JSON.parse(service.readOutput({ callId: handle.call_id, threadId: thread.id, offset: 0, length: 100 })).output
        .map((chunk: { text: string }) => chunk.text).join('')).toBe('before\nafter\n')
      const waiting = service.wait({ callId: handle.call_id, threadId: thread.id })
      callControl.setOutcome({ ok: true, exit_code: 0 })
      completion.resolve('late result')
      await service.waitForIdle()
      expect(JSON.parse(await waiting)).toMatchObject({ terminal: true, status: remote ? 'uncertain' : 'cancelled' })
      expect(database.getManagedCall(handle.call_id, thread.id)).toMatchObject({
        outputChars: 'before\nafter\n'.length, result: 'late result', outcome: { ok: true, exit_code: 0 }
      })
    } finally { completion.resolve('done'); await service.waitForIdle(); database.close() }
  })

  it('tracks a noncooperative preparation after cancellation times out', async () => {
    vi.useFakeTimers()
    const database = AgentDatabase.open(':memory:')
    try {
      const { thread, run } = createRun(database, 'pre-dispatch-timeout')
      const service = new ManagedCallService(database)
      const completion = deferred<string>()
      const starting = service.start({
        kind: 'shell',
        threadId: thread.id,
        runId: run.id,
        summary: 'stalled preparation',
        execute: () => completion.promise
      })

      await vi.advanceTimersByTimeAsync(0)
      const cancellation = service.cancelRun(run.id)
      await vi.advanceTimersByTimeAsync(5_000)
      await vi.runOnlyPendingTimersAsync()
      const cancellationResult = await cancellation
      expect(cancellationResult.uncertainCallIds).toEqual([])
      expect(cancellationResult.lingeringCallIds).toHaveLength(1)
      expect(JSON.parse(await starting)).toMatchObject({ ok: true, status: 'preparing', call_id: expect.any(String) })
      expect(service.hasActiveForThread(thread.id)).toBe(true)

      completion.resolve('late result')
      await vi.advanceTimersByTimeAsync(0)
      expect(service.hasActiveForThread(thread.id)).toBe(false)
    } finally {
      database.close()
    }
  })

  it('waits for actual run executor settlement independently of other runs after shutdown cancellation', async () => {
    vi.useFakeTimers()
    const database = AgentDatabase.open(':memory:')
    const service = new ManagedCallService(database)
    const finishing = [deferred<string>(), deferred<string>()]
    try {
      const owners = [createRun(database, 'local-shutdown-one'), createRun(database, 'local-shutdown-two')]
      const starts = owners.map(({ thread, run }, index) => service.start({
        kind: 'builtin', threadId: thread.id, runId: run.id, summary: 'Local commit',
        execute: async (control) => {
          control.markRunning()
          control.markLocalCommit()
          const result = await finishing[index].promise
          control.setOutcome({ ok: true, local_commit_completed: true })
          return result
        }
      }))
      await vi.advanceTimersByTimeAsync(10_000)
      const ids = (await Promise.all(starts)).map((value) => JSON.parse(value).call_id as string)
      const shutdown = service.shutdown()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(await shutdown).toEqual({ uncertainCallIds: [], lingeringCallIds: ids })
      expect(database.getManagedCall(ids[0], owners[0].thread.id)?.status).toBe('running')
      let firstIdle = false
      let allIdle = false
      const runIdle = service.waitForRunIdle(owners[0].run.id).then(() => { firstIdle = true })
      const idle = service.waitForIdle().then(() => { allIdle = true })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(firstIdle).toBe(false)
      finishing[0].resolve('confirmed first commit')
      await vi.advanceTimersByTimeAsync(1)
      await runIdle
      expect(firstIdle).toBe(true)
      expect(allIdle).toBe(false)
      expect(service.hasActiveForRun(owners[0].run.id)).toBe(false)
      expect(service.hasActiveForRun(owners[1].run.id)).toBe(true)
      expect(database.getManagedCall(ids[0], owners[0].thread.id)).toMatchObject({ status: 'completed', result: 'confirmed first commit' })
      finishing[1].resolve('confirmed second commit')
      await idle
    } finally {
      finishing.forEach((finish) => finish.resolve('done'))
      await vi.advanceTimersByTimeAsync(1)
      database.close()
    }
  })

  it('keeps reporting a persisted unresolved uncertain call across cancellation retries', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const { thread, run } = createRun(database, 'persistent-uncertain')
      database.createManagedCall({
        id: '11111111-1111-8111-8111-111111111111',
        threadId: thread.id,
        runId: run.id,
        kind: 'http',
        summary: 'uncertain mutation'
      })
      database.markManagedCallRunning('11111111-1111-8111-8111-111111111111', thread.id)
      database.finishManagedCall({
        callId: '11111111-1111-8111-8111-111111111111',
        threadId: thread.id,
        status: 'uncertain',
        error: 'The remote outcome is unknown.'
      })
      database.markManagedCallDetached('11111111-1111-8111-8111-111111111111', thread.id)
      const service = new ManagedCallService(database)
      const expected = {
        uncertainCallIds: ['11111111-1111-8111-8111-111111111111'],
        lingeringCallIds: []
      }

      await expect(service.cancelRun(run.id)).resolves.toEqual(expected)
      await expect(service.cancelRuns([run.id])).resolves.toEqual(expected)
      await expect(service.cancelRuns([run.id])).resolves.toEqual(expected)
      await expect(service.cancelThread(thread.id)).resolves.toEqual(expected)

      service.resolveObservedCall(
        '11111111-1111-8111-8111-111111111111',
        thread.id,
        run.id
      )
      await expect(service.cancelRuns([run.id])).resolves.toEqual({
        uncertainCallIds: [],
        lingeringCallIds: []
      })
    } finally {
      database.close()
    }
  })
})
