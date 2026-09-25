import { HumanMessage } from '@langchain/core/messages'
import { createDeepAgent } from 'deepagents'
import { createMiddleware, FakeToolCallingModel, tool } from 'langchain'
import { z } from 'zod/v3'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryRecallMiddleware } from './memoryPrompt'
import type { SqliteMemoryStore } from './memoryStore'
import { createSystemPromptCaptureMiddleware } from './systemPromptCapture'

describe('createMemoryRecallMiddleware', () => {
  it('retrieves against the latest user request and escapes records in the model prompt', async () => {
    const relevantMemories = vi.fn().mockResolvedValue([{
      id: 'memory-1',
      scope: 'project',
      projectId: 'project-1',
      kind: 'fact',
      content: 'Use <safe> & explicit boundaries.',
      keywords: ['safe'],
      importance: 5,
      origin: 'user',
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z'
    }])
    const store = { relevantMemories } as unknown as SqliteMemoryStore
    const onRecall = vi.fn()
    const model = new FakeToolCallingModel({ toolCalls: [[]] })
    let captured = ''
    const agent = createDeepAgent({
      model,
      systemPrompt: '<memory><memory_rules>Rules</memory_rules></memory>',
      middleware: [
        createMemoryRecallMiddleware({ enabled: true, store, projectId: 'project-1', onRecall }),
        createSystemPromptCaptureMiddleware((content) => {
          captured = content
        })
      ]
    })

    await agent.invoke({ messages: [new HumanMessage('How should this project handle safe boundaries?')] })

    expect(relevantMemories).toHaveBeenCalledWith(
      'How should this project handle safe boundaries?',
      'project-1',
      undefined
    )
    expect(captured).toContain('<relevant_memories>')
    expect(captured).toContain('Use &lt;safe&gt; &amp; explicit boundaries.')
    expect(onRecall).toHaveBeenCalledWith({
      query: 'How should this project handle safe boundaries?',
      promptText: expect.stringContaining('Use &lt;safe&gt; &amp; explicit boundaries.'),
      memoryCount: 1
    })
  })

  it('does not access the store when memory is disabled', async () => {
    const relevantMemories = vi.fn()
    const model = new FakeToolCallingModel({ toolCalls: [[]] })
    const agent = createDeepAgent({
      model,
      middleware: [createMemoryRecallMiddleware({
        enabled: false,
        store: { relevantMemories } as unknown as SqliteMemoryStore,
        projectId: 'project-1'
      })]
    })

    await agent.invoke({ messages: [new HumanMessage('Do not recall memory.')] })

    expect(relevantMemories).not.toHaveBeenCalled()
  })

  it('reuses one recall result throughout a model and tool loop', async () => {
    const relevantMemories = vi.fn().mockResolvedValue([{
      id: 'memory-1',
      scope: 'global',
      kind: 'fact',
      content: 'The repository uses SVN.',
      keywords: ['svn'],
      importance: 4,
      origin: 'user',
      createdAt: '2026-08-26T00:00:00.000Z',
      updatedAt: '2026-08-26T00:00:00.000Z'
    }])
    const inspect = tool(async () => 'inspected', {
      name: 'inspect_repository',
      description: 'Inspect the repository.',
      schema: z.object({})
    })
    const model = new FakeToolCallingModel({
      toolCalls: [[{ id: 'inspect-1', name: inspect.name, args: {} }], []]
    })
    const captured: string[] = []
    const agent = createDeepAgent({
      model,
      tools: [inspect],
      middleware: [
        createMemoryRecallMiddleware({
          enabled: true,
          store: { relevantMemories } as unknown as SqliteMemoryStore,
          projectId: 'project-1'
        }),
        createMiddleware({
          name: 'CaptureRecalledPrompts',
          wrapModelCall: async (request, handler) => {
            captured.push(request.systemMessage.text)
            return handler(request)
          }
        })
      ]
    })

    await agent.invoke({ messages: [new HumanMessage('Inspect all SVN repositories.')] })

    expect(relevantMemories).toHaveBeenCalledTimes(1)
    expect(captured).toHaveLength(2)
    expect(captured.every((prompt) => prompt.includes('The repository uses SVN.'))).toBe(true)
  })
})
