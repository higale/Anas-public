import type { ChatModelStreamEvent } from '@langchain/core/language_models/event'
import { ChatModelStream } from '@langchain/core/language_models/stream'
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import { describe, expect, it, vi } from 'vitest'
import {
  OpenAICompatibleChatModel,
  preserveOpenAiToolCallMetadata
} from './openAiCompatibleChatModel'
import { countMessagesApproximately } from './localTokenCounting'

async function *qwenToolCallStream(): AsyncGenerator<ChatModelStreamEvent> {
  yield { event: 'message-start', id: 'message-1' }
  yield {
    event: 'content-block-start',
    index: 0,
    content: {
      type: 'tool_call_chunk',
      id: 'call-from-qwen',
      name: 'lookup',
      args: '',
      index: 0
    }
  }
  yield {
    event: 'content-block-delta',
    index: 0,
    delta: {
      type: 'block-delta',
      fields: {
        type: 'tool_call_chunk',
        id: 'call-from-qwen',
        name: 'lookup',
        args: '{"description":'
      }
    }
  }
  yield {
    event: 'content-block-delta',
    index: 0,
    delta: {
      type: 'block-delta',
      fields: {
        type: 'tool_call_chunk',
        id: '',
        name: '',
        args: '{"description":"inspect files"}'
      }
    }
  }
  yield {
    event: 'content-block-finish',
    index: 0,
    content: {
      type: 'tool_call',
      id: '',
      name: '',
      args: { description: 'inspect files' }
    }
  }
  yield { event: 'message-finish', reason: 'tool_use' }
}

async function generateNonStreaming(message: AIMessage) {
  const model = new OpenAICompatibleChatModel({
    apiKey: 'test-key',
    model: 'qwen-compatible-model',
    streaming: false,
    completions: {
      _generate: vi.fn().mockResolvedValue({
        generations: [{ text: message.text, message }]
      })
    } as never
  })
  return model._generate([new HumanMessage('Think first.')], {} as never)
}

describe('OpenAICompatibleChatModel', () => {
  it.each(['invoke-nonstream', 'invoke-stream', 'events', 'chunks'] as const)('uses the same raw Responses replay and tool images for %s and local counting', async (mode) => {
    const rawOutput = [
      { type: 'reasoning', id: 'rs_saved', encrypted_content: 'x'.repeat(32_000), summary: [] },
      { type: 'function_call', id: 'fc_saved', call_id: 'call_image', name: 'view_image', arguments: '{"path":"chart.png"}', status: 'completed' }
    ]
    const previous = new AIMessage({
      content: [{ type: 'reasoning', reasoning: 'Visible summary is not replayed'.repeat(1_000) }],
      response_metadata: { output_version: 'v1', model_provider: 'openai', output: rawOutput },
      tool_calls: [{ id: 'call_image', name: 'view_image', args: { path: 'chart.png' } }]
    })
    const messages = [new HumanMessage('Inspect'), previous, new ToolMessage({
      tool_call_id: 'call_image',
      content: [{ type: 'text', text: 'Chart' }, { type: 'image_url', image_url: { url: 'https://example.com/chart.png' } }]
    })]
    const original = messages.map((message) => message.toDict())
    const requests: Record<string, unknown>[] = []
    const completed = {
      id: 'resp_done', object: 'response', created_at: 1, status: 'completed', model: 'fixture', output_text: 'Done',
      output: [{ type: 'message', id: 'msg_done', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done', annotations: [] }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    }
    const model = new OpenAICompatibleChatModel({
      apiKey: 'test-key', model: 'fixture', anasUseResponsesApi: true, streaming: mode !== 'invoke-nonstream', maxRetries: 0,
      configuration: { fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        requests.push(body)
        if (!body.stream) return new Response(JSON.stringify(completed), { headers: { 'content-type': 'application/json' } })
        const events = [
          { type: 'response.created', sequence_number: 0, response: { ...completed, output: [], status: 'in_progress' } },
          { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...completed.output[0], content: [], status: 'in_progress' } },
          { type: 'response.output_text.delta', sequence_number: 2, item_id: 'msg_done', output_index: 0, content_index: 0, delta: 'Done', logprobs: [] },
          { type: 'response.completed', sequence_number: 3, response: completed }
        ]
        return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
      } }
    })
    if (mode === 'events') await model.streamEvents(messages).output
    else if (mode === 'chunks') {
      const stream = await model.stream(messages)
      for await (const _chunk of stream) { /* consume the native chunk path */ }
    } else await model.invoke(messages)
    expect(requests).toHaveLength(1)
    expect(requests[0].input).toEqual([
      { type: 'message', role: 'user', content: 'Inspect' },
      ...rawOutput,
      { type: 'function_call_output', call_id: 'call_image', output: [
        { type: 'input_text', text: 'Chart' },
        { type: 'input_image', image_url: 'https://example.com/chart.png', detail: 'auto' }
      ] }
    ])
    const estimated = countMessagesApproximately(messages, null, { protocol: 'openai_responses' })
    expect(estimated).toBeGreaterThan(9_024)
    expect(estimated).toBeLessThan(9_200)
    expect(messages.map((message) => message.toDict())).toEqual(original)
  })

  it('counts tokens locally without downloading an OpenAI tokenizer', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const model = new OpenAICompatibleChatModel({
      apiKey: 'test-key',
      model: 'qwen-compatible-model'
    })

    try {
      expect(await model.getNumTokens('12345678')).toBe(2)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('keeps provider tool-call metadata when later Qwen deltas contain empty values', async () => {
    const toolCallState = {
      ids: new Map<number, string>(),
      names: new Map<number, string>()
    }
    const events = (async function *() {
      for await (const event of qwenToolCallStream()) {
        yield preserveOpenAiToolCallMetadata(event, toolCallState)
      }
    })()

    const message = await new ChatModelStream(events)

    expect(message.tool_calls).toEqual([{
      type: 'tool_call',
      id: 'call-from-qwen',
      name: 'lookup',
      args: { description: 'inspect files' }
    }])
  })

  it('does not invent tool-call metadata when the provider never supplies it', () => {
    const event = preserveOpenAiToolCallMetadata({
      event: 'content-block-finish',
      index: 0,
      content: {
        type: 'tool_call',
        id: '',
        name: '',
        args: {}
      }
    }, {
      ids: new Map(),
      names: new Map()
    })

    expect(event).toMatchObject({
      event: 'content-block-finish',
      content: {
        type: 'tool_call',
        args: {}
      }
    })
    expect(event).not.toHaveProperty('content.id')
    expect(event).not.toHaveProperty('content.name')
  })

  it('normalizes non-streaming reasoning content into a standard reasoning block', async () => {
    const result = await generateNonStreaming(new AIMessage({
      id: 'non-streaming-response',
      content: 'FINAL_RESPONSE',
      additional_kwargs: { reasoning_content: 'INTERNAL_REASONING' },
      response_metadata: { model_provider: 'openai' }
    }))

    expect(result.generations[0].message.contentBlocks).toEqual([
      { type: 'reasoning', reasoning: 'INTERNAL_REASONING' },
      { type: 'text', text: 'FINAL_RESPONSE' }
    ])
  })

  it('preserves tool calls while normalizing non-streaming reasoning', async () => {
    const result = await generateNonStreaming(new AIMessage({
      id: 'non-streaming-tool-response',
      content: '',
      additional_kwargs: { reasoning_content: 'CHOOSE_TOOL' },
      response_metadata: { model_provider: 'openai' },
      tool_calls: [{
        id: 'tool-1',
        name: 'search',
        args: { query: 'weather' }
      }]
    }))
    const message = result.generations[0].message

    expect(message.contentBlocks).toEqual([
      { type: 'reasoning', reasoning: 'CHOOSE_TOOL' },
      { type: 'tool_call', id: 'tool-1', name: 'search', args: { query: 'weather' } }
    ])
    expect(AIMessage.isInstance(message) && message.tool_calls).toEqual([{
      id: 'tool-1',
      name: 'search',
      args: { query: 'weather' }
    }])
  })

})
