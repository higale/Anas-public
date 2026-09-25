import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import { describe, expect, it } from 'vitest'
import { latestUserInputMessages, projectSkillMessages, toAgentMessage, toHumanMessage } from './messageMapper'

describe('agent message mapping', () => {
  it('sends the original request and exact Skill context as separate user messages without moving attachments', () => {
    const request = '/demo 用户需求 <skill> $0'
    const skill = '<skill>\n<name>demo</name>\n<path>/skills/demo/SKILL.md</path>\n---\nname: demo\n---\n$ARGUMENTS <skill>literal</skill>\n</skill>'
    const text = `${request}\n\n${skill}`
    const message = toHumanMessage(text, [{ type: 'image', mimeType: 'image/png', data: 'abc' }], request, { id: 'user-1' })
    const [user, context] = projectSkillMessages([message])
    expect(user).toBeInstanceOf(HumanMessage)
    expect(context).toBeInstanceOf(HumanMessage)
    expect(user.content).toEqual([
      { type: 'text', text: request },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc', detail: 'auto' } }
    ])
    expect(context.content).toBe(skill)
    const older = new HumanMessage('An earlier request.')
    const tool = new ToolMessage({ content: 'Result', tool_call_id: 'call' })
    expect(latestUserInputMessages([older, user, context, tool])).toEqual([user, context])
    expect(latestUserInputMessages([older, message, tool])).toEqual([message])
    expect(latestUserInputMessages([older, user, context, new HumanMessage('Next request')]))
      .toEqual([expect.objectContaining({ content: 'Next request' })])
    expect(latestUserInputMessages([tool])).toEqual([])
    expect(toAgentMessage(message, 'fallback').skillInvocation?.promptText).toBe(`${user.text}\n\n${context.text}`)
    expect(projectSkillMessages([user, context])).toEqual([user, context])
    expect(message.content).toEqual([
      { type: 'text', text },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc', detail: 'auto' } }
    ])
    const plain = new HumanMessage(text)
    expect(projectSkillMessages([plain])).toEqual([plain])
  })

  it('preserves framework message ids and tool calls', () => {
    const message = new AIMessage({
      id: 'assistant-1',
      content: [{ type: 'text', text: 'Checking.' }],
      tool_calls: [{ id: 'call-1', name: 'read_file', args: { path: '/projects/anas/a.ts' } }]
    })

    expect(toAgentMessage(message, 'fallback')).toEqual({
      id: 'assistant-1',
      role: 'assistant',
      content: [{ type: 'text', text: 'Checking.' }],
      name: undefined,
      toolCalls: [{
        id: 'call-1',
        name: 'read_file',
        args: { path: '/projects/anas/a.ts' }
      }]
    })
  })

  it('maps tool correlation ids', () => {
    const message = new ToolMessage({
      id: 'tool-1',
      content: 'done',
      tool_call_id: 'call-1'
    })
    expect(toAgentMessage(message, 'fallback')).toMatchObject({
      id: 'tool-1',
      role: 'tool',
      toolCallId: 'call-1',
      content: [{ type: 'text', text: 'done' }]
    })
  })

  it('preserves a Responses reasoning summary for activity presentation', () => {
    const message = new AIMessage({
      id: 'assistant-reasoning',
      content: [{
        type: 'reasoning',
        reasoning: 'Detailed reasoning',
        summary: [{ type: 'summary_text', text: 'Short summary' }]
      }]
    })

    expect(toAgentMessage(message, 'fallback')).toMatchObject({
      content: [{
        type: 'reasoning',
        text: 'Detailed reasoning',
        summary: 'Short summary'
      }]
    })
  })

  it('creates native human messages with multimodal content', () => {
    const message = toHumanMessage('Describe this', [{
      type: 'image',
      mimeType: 'image/png',
      data: 'abc'
    }])
    expect(message).toBeInstanceOf(HumanMessage)
    expect(message.content).toEqual([
      { type: 'text', text: 'Describe this' },
      {
        type: 'image_url',
        image_url: {
          url: 'data:image/png;base64,abc',
          detail: 'auto'
        }
      }
    ])
    expect(toAgentMessage(message, 'human-image')).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this' },
        { type: 'image', mimeType: 'image/png', data: 'abc' }
      ]
    })
  })

  it('keeps expanded skill text for the model and the slash command for the UI', () => {
    const message = toHumanMessage('Expanded skill instructions', undefined, '/summarize report')
    expect(message.text).toBe('Expanded skill instructions')
    expect(toAgentMessage(message, 'human-skill')).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: '/summarize report' }],
      skillInvocation: {
        name: 'summarize',
        args: 'report',
        promptText: 'Expanded skill instructions'
      }
    })
  })

  it('preserves the tool boundary used to place a queued direction in the timeline', () => {
    const message = toHumanMessage('Use the tool result differently.', undefined, undefined, {
      id: 'direction-1',
      runId: 'run-1',
      createdAt: '2026-08-29T12:00:00.000Z',
      directionAfterToolCallIds: ['tool-1', 'tool-2']
    })

    expect(toAgentMessage(message, 'fallback')).toMatchObject({
      id: 'direction-1',
      role: 'user',
      runId: 'run-1',
      createdAt: '2026-08-29T12:00:00.000Z',
      directionAfterToolCallIds: ['tool-1', 'tool-2']
    })
  })
})
