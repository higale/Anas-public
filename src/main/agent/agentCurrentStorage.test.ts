import Database from 'better-sqlite3'
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint'
import { describe, expect, it, vi } from 'vitest'
import { AgentDatabase } from './agentDatabase'

async function save(database: AgentDatabase, threadId: string, messages: BaseMessage[], runId: string, completed = false) {
  const checkpoint = emptyCheckpoint()
  checkpoint.channel_values = { messages, todos: [], anasRunLifecycle: { runId, status: completed ? 'completed' : 'running' } }
  checkpoint.channel_versions = { messages: checkpoint.id, todos: checkpoint.id, anasRunLifecycle: checkpoint.id }
  return database.checkpointer.put({ configurable: { thread_id: threadId } }, checkpoint, { source: 'loop', step: 1, parents: {} }, checkpoint.channel_versions)
}

describe('conversation current storage integration', () => {
  it('loads one tool without hydrating other tools or models in the same run', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'tools-run')
      const messages: BaseMessage[] = []
      for (let index = 0; index < 100; index += 1) {
        messages.push(new AIMessage({
          id: `model-${index}`, content: '', additional_kwargs: { anas_run_id: run.id },
          tool_calls: [{ id: `call-${index}`, name: 'lookup', args: { index } }]
        }), new ToolMessage({ id: `result-${index}`, tool_call_id: `call-${index}`, content: `result ${index}` }))
      }
      await save(database, thread.id, messages, run.id)
      const allActivities = vi.spyOn(database, 'getRunActivity').mockImplementation(() => { throw new Error('A tool lookup must not read the whole run') })
      const bodyRead = vi.spyOn(database.checkpointer, 'getMessageRecordById')
      expect(database.getToolActivity(run.id, 'call-42')).toMatchObject({
        call: { id: 'call-42', name: 'lookup', args: { index: 42 } }, output: 'result 42', status: 'completed'
      })
      expect(allActivities).not.toHaveBeenCalled()
      expect(bodyRead.mock.results.map(result => result.value?.messageId)).toEqual(['model-42', 'result-42'])
      expect(database.getToolActivity(run.id, 'absent')).toBeUndefined()
    } finally { database.close() }
  })

  it('appends to a long conversation without encoding old message bodies and reads only the requested UI window', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'long-run')
      database.checkpointer.retainRun(run.id, thread.id)
      const messages: BaseMessage[] = Array.from({ length: 1000 }, (_, index) => new HumanMessage({
        id: `input-${index}`, content: `${index}:${'x'.repeat(4096)}`, additional_kwargs: { anas_run_id: run.id }
      }))
      await save(database, thread.id, messages, run.id)
      const initialBytes = database.checkpointer.encodedMessageBytes
      for (let index = 0; index < 20; index += 1) {
        messages.push(new AIMessage({ id: `answer-${index}`, content: 'answer'.repeat(100), additional_kwargs: { anas_run_id: run.id } }))
        await save(database, thread.id, [...messages], run.id)
      }
      expect(initialBytes).toBeGreaterThan(4_000_000)
      expect(database.checkpointer.encodedMessageBytes - initialBytes).toBeLessThan(50_000)
      const tuple = vi.spyOn(database.checkpointer, 'getTuple').mockRejectedValue(new Error('A page must not load the whole state'))
      const window = await database.readMessageWindow(thread.id, undefined, 25)
      expect(window).toMatchObject({ totalCount: 1020, startIndex: 995 })
      expect(window.messages).toHaveLength(25)
      expect(window.messages.at(-1)?.id).toBe('answer-19')
      expect(tuple).not.toHaveBeenCalled()
      tuple.mockRestore()
      await database.checkpointer.releaseRun(run.id)
      expect(database.checkpointer.hasRetainedRun(thread.id)).toBe(false)
      expect((await database.checkpointer.getTuple({ configurable: { thread_id: thread.id } }))?.checkpoint.channel_values.messages).toHaveLength(1020)
    } finally { database.close() }
  }, 15_000)

  it('removes tool result payloads with the discarded run even when native tool messages have no run metadata', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const first = database.createRun(thread.id, 'first')
      const prefix = [new HumanMessage({ id: 'first-input', content: 'keep', additional_kwargs: { anas_run_id: first.id } })]
      await save(database, thread.id, prefix, first.id, true)
      database.finishRun(first.id, 'completed')
      const second = database.createRun(thread.id, 'second')
      const messages = [...prefix,
        new AIMessage({ id: 'calling', content: '', tool_calls: [{ id: 'call', name: 'lookup', args: { query: 'discard' } }], additional_kwargs: { anas_run_id: second.id } }),
        new ToolMessage({ id: 'result', tool_call_id: 'call', content: 'discard'.repeat(1000) })]
      await save(database, thread.id, messages, second.id, true)
      database.finishRun(second.id, 'completed')
      await database.replaceMessageHistory(thread.id, prefix, second.id)
      const raw = (database as unknown as { database: Database.Database }).database
      expect(raw.prepare('SELECT message_id FROM message_bodies').all()).toEqual([{ message_id: 'first-input' }])
      expect(raw.prepare('SELECT * FROM agent_tool_messages').all()).toEqual([])
      expect(database.getRun(second.id)).toBeNull()
    } finally { database.close() }
  })
})
