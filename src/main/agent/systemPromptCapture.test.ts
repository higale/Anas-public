import { HumanMessage } from '@langchain/core/messages'
import { createDeepAgent } from 'deepagents'
import { createMiddleware, FakeToolCallingModel } from 'langchain'
import { describe, expect, it } from 'vitest'
import { createPlanningMiddleware } from './agentFactory'
import { createSystemPromptCaptureMiddleware } from './systemPromptCapture'

describe('createSystemPromptCaptureMiddleware', () => {
  it('captures the effective system message without calling the model', async () => {
    const model = new FakeToolCallingModel({ toolCalls: [[]] })
    let captured = ''
    const agent = createDeepAgent({
      model,
      systemPrompt: '<anas_context>VISIBLE</anas_context>',
      middleware: [
        createSystemPromptCaptureMiddleware((content) => {
          captured = content
        })
      ]
    })

    await agent.invoke({
      messages: [new HumanMessage('Capture the system prompt.')]
    })

    expect(captured).toBe('<anas_context>VISIBLE</anas_context>')
    expect(model.index).toBe(0)
  })

  it('allows the application prompt to replace framework behavior instructions', async () => {
    const model = new FakeToolCallingModel({ toolCalls: [[]] })
    let captured = ''
    let toolNames: string[] = []
    const todoMiddleware = createPlanningMiddleware(true)
    const agent = createDeepAgent({
      model,
      systemPrompt: { base: '<anas_context>VISIBLE</anas_context>' },
      middleware: [
        todoMiddleware,
        createMiddleware({ name: 'FilesystemMiddleware' }),
        createMiddleware({ name: 'subAgentMiddleware' }),
        createMiddleware({
          name: 'TestToolCaptureMiddleware',
          wrapModelCall: async (request, handler) => {
            toolNames = request.tools.map((tool) => String(tool.name))
            return handler(request)
          }
        }),
        createSystemPromptCaptureMiddleware((content) => {
          captured = content
        })
      ]
    })

    await agent.invoke({
      messages: [new HumanMessage('Capture the system prompt.')]
    })

    expect(captured).toBe('<anas_context>VISIBLE</anas_context>')
    expect(captured).not.toContain('You are a Deep Agent')
    expect(captured).not.toContain('## `write_todos`')
    expect(captured).not.toContain('## `task` (subagent spawner)')
    expect(captured).not.toContain('## Filesystem Tools')
    expect(toolNames).toContain('write_todos')
    expect(toolNames).not.toContain('task')
    expect(model.index).toBe(0)
  })
})
