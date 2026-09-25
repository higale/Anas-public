import Database from 'better-sqlite3'
import { AIMessage, ToolMessage } from '@langchain/core/messages'
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint'
import { createAgent, createMiddleware, FakeToolCallingModel, tool } from 'langchain'
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { CurrentStateSqliteSaver } from './currentStateSqliteSaver'
import { simpleChatHistory } from './agentFactory'
import { createProjectRulesMiddleware } from './projectRulesMiddleware'

describe('framework ownership of persisted message values', () => {
  it('dispatches standard content-block tool calls through actual project-rule middleware', async () => {
    const database = new Database(':memory:')
    try {
      const saver = new CurrentStateSqliteSaver(database)
      saver.retainRun('run', 'thread')
      const rules = createProjectRulesMiddleware({
        runId: 'run', folders: [], primaryFolder: process.cwd(), getInputCapacityTokens: () => 20000, getModelTokenCountingOptions: () => ({ protocol: 'openai_chat_completions' }), accessMode: () => 'full_access'
      })
      const execute = vi.fn(() => 'done')
      const agent = createAgent({
        checkpointer: saver,
        model: new FakeToolCallingModel({ toolCalls: [[{ id: 'call', name: 'echo', args: {} }], []] }),
        tools: [tool(execute, { name: 'echo', description: 'Echo', schema: z.object({}) })],
        middleware: [rules.middleware, rules.guard, createMiddleware({
          name: 'StandardContentBlocks',
          wrapModelCall: async (request, handler) => {
            const response = await handler(request)
            if (!AIMessage.isInstance(response)) return response
            return new AIMessage({
              ...response, content: [{ type: 'text', text: response.text }],
              response_metadata: { ...response.response_metadata, output_version: 'v1' }
            })
          }
        })]
      })
      const result = await agent.invoke({ messages: ['run'] }, { configurable: { thread_id: 'thread' }, durability: 'sync' })
      expect(execute).toHaveBeenCalledOnce()
      expect(result.messages.find(ToolMessage.isInstance)?.content).toBe('done')
    } finally { database.close() }
  })

  it.each([false, true])('projects standard content-block history into the next simple chat (reload=%s)', async (reload) => {
    const database = new Database(':memory:')
    try {
      const saver = new CurrentStateSqliteSaver(database)
      saver.retainRun('run', 'thread')
      const message = new AIMessage({
        id: 'v1', content: [{ type: 'text', text: 'completed response' }], response_metadata: { output_version: 'v1' }
      })
      const checkpoint = { ...emptyCheckpoint(), channel_values: { messages: [message] }, channel_versions: { messages: 1 } }
      await saver.put({ configurable: { thread_id: 'thread' } }, checkpoint, { source: 'loop', step: 0, parents: {} })
      if (reload) await saver.releaseRun('run')
      const restored = (await saver.getTuple({ configurable: { thread_id: 'thread' } }))!.checkpoint.channel_values.messages as AIMessage[]
      const projected = simpleChatHistory(restored)
      expect(projected).toHaveLength(1)
      expect(projected[0].text).toBe('completed response')
      expect(simpleChatHistory([message])[0].text).toBe('completed response')
    } finally { database.close() }
  })
})
