import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolMessage } from '@langchain/core/messages'
import { tool } from '@langchain/core/tools'
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint'
import { z } from 'zod/v3'
import { describe, expect, it, vi } from 'vitest'
import { AgentDatabase } from './agentDatabase'
import { ManagedCallService } from './managedCallService'
import { withManagedToolExecution } from './managedToolExecution'
import { decodeManagedToolResult, decodeManagedToolResultSync } from './managedToolResult'
import { currentToolExecution } from './toolExecutionContext'

describe('managed canonical tool results', () => {
  it('stores a large final result once, pages progress and final text, and restores native artifacts', async () => {
    vi.useFakeTimers()
    const root = await mkdtemp(join(tmpdir(), 'anas-managed-result-'))
    const file = join(root, 'conversation.sqlite')
    let database = AgentDatabase.open(file, join(root, 'attachments'))
    let service = new ManagedCallService(database)
    let finish!: (value: [string, unknown]) => void
    const pending = new Promise<[string, unknown]>((resolve) => { finish = resolve })
    const content = `start:${'result中'.repeat(100_000)}:end`
    const progress = 'Dispatched.\n'
    const artifact = { bytes: new Uint8Array([1, 7, 255]), format: 'binary' }
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'large-tool-run')
      database.checkpointer.retainRun(run.id, thread.id)
      const native = tool(async () => {
        currentToolExecution()!.output('stdout', progress)
        return pending
      }, { name: 'read_file', description: 'Read', schema: z.object({}), responseFormat: 'content_and_artifact' })
      const wrapped = withManagedToolExecution(native, { database, service, threadId: thread.id, runId: run.id, allowBackground: true })
      const invocation = wrapped.invoke({ type: 'tool_call', id: 'large-call', name: wrapped.name, args: {} }) as Promise<ToolMessage>
      await vi.advanceTimersByTimeAsync(10_000)
      const handle = JSON.parse(String((await invocation).content)) as { call_id: string }
      finish([content, artifact])
      await vi.advanceTimersByTimeAsync(1)
      await service.waitForIdle()

      const call = database.getManagedCall(handle.call_id, thread.id)!
      expect(call.result!.length).toBeLessThan(256)
      expect(call.outputChars).toBe(progress.length)
      const restored = (await service.readResult(call.id, thread.id))!
      expect(restored.content).toBe(content)
      expect(restored.artifact).toEqual(artifact)
      expect(restored.id).toBeTruthy()
      expect(database.checkpointer.getMessageRecordById(thread.id, JSON.parse(call.result!).record_id)).toBeDefined()

      const checkpoint = { ...emptyCheckpoint(), id: 'completed', channel_values: { messages: [restored] },
        channel_versions: { messages: 1 } }
      await database.checkpointer.put({ configurable: { thread_id: thread.id } }, checkpoint,
        { source: 'loop', step: 1, parents: {} }, checkpoint.channel_versions)
      expect(database.checkpointer.getMessageRecordById(thread.id, JSON.parse(call.result!).record_id)).toBeDefined()
      const inspect = new Database(file, { readonly: true })
      try {
        expect(inspect.prepare('SELECT count(*) AS count FROM message_bodies').get()).toEqual({ count: 1 })
        expect(inspect.prepare('SELECT sum(length(text)) AS count FROM agent_managed_call_output').get()).toEqual({ count: progress.length })
      } finally { inspect.close() }

      expect(JSON.parse(service.readOutput({ callId: call.id, threadId: thread.id,
        offset: progress.length - 3, length: 9 }))).toMatchObject({
        output_chars_total: progress.length + content.length,
        output: [{ text: progress.slice(-3) }, { text: content.slice(0, 6) }], has_before: true, has_after: true
      })
      expect(JSON.parse(service.readOutput({ callId: call.id, threadId: thread.id, offset: -4, length: 10 })))
        .toMatchObject({ output: [{ text: ':end' }], has_after: false })
      expect(JSON.parse(service.readOutput({ callId: call.id, threadId: thread.id,
        offset: Number.MAX_SAFE_INTEGER, length: 10 }))).toMatchObject({ output: [], has_after: false })
      await expect(decodeManagedToolResult(database, call.result!, 'another-thread')).rejects.toThrow('Invalid persisted')
      expect(() => decodeManagedToolResultSync(database, call.result!, 'another-thread')).toThrow('Invalid persisted')
      const shortened = new ToolMessage({ ...restored.lc_kwargs, id: restored.id,
        tool_call_id: restored.tool_call_id, content: 'A shortened context result.' })
      const reduced = { ...checkpoint, id: 'reduced', channel_values: { messages: [shortened] }, channel_versions: { messages: 2 } }
      await database.checkpointer.put({ configurable: { thread_id: thread.id } }, reduced,
        { source: 'loop', step: 2, parents: {} }, reduced.channel_versions)
      expect((await service.readResult(call.id, thread.id))?.content === content).toBe(true)
      await database.checkpointer.releaseRun(run.id)
      database.close()
      database = AgentDatabase.open(file, join(root, 'attachments'))
      service = new ManagedCallService(database)
      expect((await service.readResult(call.id, thread.id))?.artifact).toEqual(artifact)
      expect(JSON.parse(service.readOutput({ callId: call.id, threadId: thread.id, offset: -4, length: 10 })))
        .toMatchObject({ output: [{ text: ':end' }] })
      expect(database.deleteManagedCall(call.id, thread.id)).toBe(true)
      const next = { ...reduced, id: 'after-call-deleted' }
      await database.checkpointer.put({ configurable: { thread_id: thread.id } }, next,
        { source: 'loop', step: 3, parents: {} }, {})
      expect(database.checkpointer.getMessageRecordById(thread.id, JSON.parse(call.result!).record_id)).toBeUndefined()
    } finally {
      finish([content, artifact])
      await service.waitForIdle()
      database.close()
      vi.useRealTimers()
      await rm(root, { recursive: true, force: true })
    }
  })
})
