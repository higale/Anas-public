import { ChatModelStream } from '@langchain/core/language_models/stream'
import { countMessagesApproximately } from './localTokenCounting'
import { describe, expect, it, vi } from 'vitest'
import { AIMessage, HumanMessage, ToolMessage, mapStoredMessageToChatMessage } from '@langchain/core/messages'
import { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import { encodeOpenAiToolImages } from './toolImageTransport'
import { ChatAnthropic } from '@langchain/anthropic'
import { tool } from '@langchain/core/tools'
import type { ResolvedModelConfig } from '@shared/types'
import { z } from 'zod'
import { OpenAICompatibleChatModel } from './openAiCompatibleChatModel'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { filePatchSchema } from '../filePatch'
import { ModelSelectionError } from './modelSelection'
import { assertModelInputFits, assertModelInputSupported, ModelRequestChangedError } from './modelRequestValidation'
import { toAgentMessage } from './messageMapper'

const runtimeLoggerMocks = vi.hoisted(() => ({
  runtimeLog: vi.fn()
}))

vi.mock('../config/apiKeys', () => ({
  resolveModelApiKey: (model: ResolvedModelConfig) => model.apiKey
}))

vi.mock('../runtimeLogger', () => runtimeLoggerMocks)

const baseModel: ResolvedModelConfig = {
  id: 'test',
  displayName: '',
  providerId: 'provider-test',
  providerName: 'Test',
  protocol: 'openai_chat_completions',
  baseUrl: 'https://example.com/v1',
  model: 'test-model',
  apiKey: 'secret',
  parameters: {},
  parameterPresetMode: 'none',
  capabilities: { vision: true, toolUse: true },
  stream: true,
  maxContextTokens: 128000,
  maxOutputTokens: 16000,
  contextCompressionThreshold: 0.8,
  contextCompressionEnabled: true
}

function responsesSse(id: string, reasoning: string, text: string): string {
  const reasoningItem = {
    id: `rs_${id}`,
    type: 'reasoning',
    status: 'completed',
    summary: [{ type: 'summary_text', text: reasoning }]
  }
  const messageItem = {
    id: `msg_${id}`,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [], logprobs: [] }]
  }
  const response = {
    id,
    object: 'response',
    created_at: 1,
    status: 'completed',
    model: 'qwen-compatible-model',
    output_text: text,
    output: [reasoningItem, messageItem],
    usage: {
      input_tokens: 10,
      output_tokens: 8,
      total_tokens: 18,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 5 }
    }
  }
  const stream = [
    {
      type: 'response.created',
      sequence_number: 0,
      response: { ...response, status: 'in_progress', output: [], usage: null }
    },
    {
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: { ...reasoningItem, status: 'in_progress', summary: [] }
    },
    {
      type: 'response.reasoning_text.delta',
      sequence_number: 2,
      item_id: reasoningItem.id,
      output_index: 0,
      content_index: 0,
      delta: reasoning
    },
    {
      type: 'response.reasoning_text.done',
      sequence_number: 3,
      item_id: reasoningItem.id,
      output_index: 0,
      content_index: 0,
      text: reasoning
    },
    {
      type: 'response.output_item.done',
      sequence_number: 4,
      output_index: 0,
      item: reasoningItem
    },
    {
      type: 'response.output_item.added',
      sequence_number: 5,
      output_index: 1,
      item: { ...messageItem, status: 'in_progress', content: [] }
    },
    {
      type: 'response.output_text.delta',
      sequence_number: 6,
      item_id: messageItem.id,
      output_index: 1,
      content_index: 0,
      delta: text,
      logprobs: []
    },
    { type: 'response.completed', sequence_number: 7, response }
  ]
  return stream
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('') + 'data: [DONE]\n\n'
}

describe('createChatModel', () => {
  it('counts native Anthropic stream reasoning and non-standard content replayed by its HTTP adapter', async () => {
    const thinking = 't'.repeat(32_000)
    const signature = 's'.repeat(400)
    const redacted = 'r'.repeat(8_000)
    const events = [
      { type: 'message_start', message: { id: 'msg_thinking', type: 'message', role: 'assistant', model: 'claude-fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: redacted } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Done' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 123_456 } },
      { type: 'message_stop' }
    ]
    const bodies: Record<string, unknown>[] = []
    const { createChatModel } = await import('./modelFactory')
    const model = createChatModel({ ...baseModel, protocol: 'anthropic_messages', model: 'claude-fixture', stream: false }, {
      providerFetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        bodies.push(body)
        if (body.stream) return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
        return new Response(JSON.stringify({ id: 'msg_done', type: 'message', role: 'assistant', model: 'claude-fixture', content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } })
      }
    }) as ChatAnthropic
    const previous = await new ChatModelStream(model._streamChatModelEvents([new HumanMessage('Start')], {}))
    expect(previous.content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'reasoning', reasoning: thinking, signature }),
      expect.objectContaining({ type: 'non_standard', value: { type: 'redacted_thinking', data: redacted } })
    ]))
    const restored = mapStoredMessageToChatMessage(previous.toDict())
    expect(restored.response_metadata).toMatchObject({ model_provider: 'anthropic', output_version: 'v1' })
    const messages = [new HumanMessage('Start'), restored, new HumanMessage('Continue')]
    await model.invoke(messages)
    expect(bodies[1].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', content: expect.arrayContaining([
        { type: 'thinking', thinking, signature }, { type: 'redacted_thinking', data: redacted }
      ]) })
    ]))
    const estimated = countMessagesApproximately(messages, null, { protocol: 'anthropic_messages' })
    expect(estimated).toBeGreaterThan(10_100)
    expect(estimated).toBeLessThan(10_200)
    expect(countMessagesApproximately(messages, null, { protocol: 'openai_chat_completions' })).toBeLessThan(20)
  })


  it.each([
    ...(['openai_chat_completions', 'openai_responses'] as const).flatMap((protocol) =>
      ['temperature', 'topP', 'top_p', 'frequencyPenalty', 'frequency_penalty', 'presencePenalty', 'presence_penalty', 'n'].map((parameter) => ({ protocol, parameter }))),
    ...['temperature', 'topP', 'top_p', 'topK', 'top_k'].map((parameter) => ({ protocol: 'anthropic_messages' as const, parameter }))
  ])('rejects invalid mapped numeric $parameter for $protocol instead of dropping it', async ({ protocol, parameter }) => {
    const { createChatModel } = await import('./modelFactory')
    for (const value of ['0.5', false, {}, NaN, Infinity, ...(protocol === 'anthropic_messages' ? [null] : [])]) {
      expect(() => createChatModel({ ...baseModel, protocol, parameters: { [parameter]: value } })).toThrow(ModelSelectionError)
      expect(() => createChatModel({ ...baseModel, protocol, parameters: { [parameter]: value } })).toThrow(parameter)
    }
  })

  it.each([
    { protocol: 'openai_chat_completions', parameter: 'stop' },
    { protocol: 'openai_responses', parameter: 'stop' },
    { protocol: 'anthropic_messages', parameter: 'stop_sequences' }
  ] as const)('rejects malformed $parameter for $protocol without dropping array entries', async ({ protocol, parameter }) => {
    const { createChatModel } = await import('./modelFactory')
    for (const value of [1, ['END', 1], ...(protocol === 'anthropic_messages' ? ['END', null] : [])]) {
      expect(() => createChatModel({ ...baseModel, protocol, parameters: { [parameter]: value } })).toThrow(ModelSelectionError)
    }
    expect(createChatModel({ ...baseModel, protocol, parameters: { [parameter]: ['END', 'DONE'] } })).toMatchObject(
      protocol === 'anthropic_messages' ? { stopSequences: ['END', 'DONE'] } : { stop: ['END', 'DONE'] }
    )
  })

  it('checks both mapped aliases and preserves provider-specific parameters', async () => {
    const { createChatModel } = await import('./modelFactory')
    expect(() => createChatModel({ ...baseModel, parameters: { topP: 0.5, top_p: 'invalid' } })).toThrow('top_p')
    expect(createChatModel({ ...baseModel, parameters: { temperature: 0, native_provider_setting: { mode: 'custom' } } })).toMatchObject({
      temperature: 0, modelKwargs: { native_provider_setting: { mode: 'custom' } }
    })
  })

  it.each(['openai_chat_completions', 'openai_responses'] as const)('preserves legal null sampling and string, array or null stop values in actual %s requests', async (protocol) => {
    const { createChatModel } = await import('./modelFactory')
    const sent: Record<string, unknown>[] = []
    const providerFetch: typeof fetch = async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)))
      const response = protocol === 'openai_responses'
        ? { id: 'resp_nullable', object: 'response', created_at: 1, status: 'completed', model: 'fixture', output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } }
        : { id: 'chat_nullable', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Done' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
      return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } })
    }
    for (const stop of ['END', ['END', 'DONE'], null]) {
      const parameters = { temperature: null, topP: null, frequencyPenalty: null, presence_penalty: null, n: null, stop, native_provider_setting: { mode: 'custom' } }
      const model = createChatModel({ ...baseModel, protocol, stream: false, parameters }, { providerFetch })
      await model.invoke([new HumanMessage('Finish.')])
      expect(sent.at(-1)).toMatchObject({
        temperature: null, top_p: null, frequency_penalty: null, presence_penalty: null, n: null, stop,
        native_provider_setting: { mode: 'custom' }
      })
      expect(sent.at(-1)).not.toHaveProperty('topP')
      expect(sent.at(-1)).not.toHaveProperty('frequencyPenalty')
    }
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)(
    'carries one strict JSON patch schema and preserves the batch through %s', async (protocol) => {
      const { createChatModel } = await import('./modelFactory')
      const args = { summary: '更新中文文件并移动说明', patch: [
        '*** Begin Patch',
        '*** Update File: src/中文 文件.ts',
        '@@',
        '-before',
        '+after',
        '*** Update File: old.md',
        '*** Move to: docs/new.md',
        '*** End Patch'
      ].join('\n') }
      let sent: Record<string, unknown> | undefined
      const providerFetch: typeof fetch = async (_url, init) => {
        sent = JSON.parse(String(init?.body))
        const body = protocol === 'anthropic_messages'
          ? { id: 'msg_patch', type: 'message', role: 'assistant', model: 'fixture', stop_reason: 'tool_use', stop_sequence: null,
              content: [{ type: 'tool_use', id: 'call_patch', name: 'apply_patch', input: args }], usage: { input_tokens: 10, output_tokens: 20 } }
          : protocol === 'openai_responses'
            ? { id: 'resp_patch', object: 'response', created_at: 1, status: 'completed', model: 'fixture',
                output: [{ type: 'function_call', id: 'fc_patch', call_id: 'call_patch', name: 'apply_patch', arguments: JSON.stringify(args), status: 'completed' }],
                usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } }
            : { id: 'chat_patch', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, finish_reason: 'tool_calls',
                message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_patch', type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify(args) } }] } }],
                usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      const model = createChatModel({ ...baseModel, protocol, stream: false }, { providerFetch }) as BaseChatModel
      const bound = model.bindTools!([tool(async () => 'unused', { name: 'apply_patch', description: 'Edit a complete batch.', schema: filePatchSchema })])
      const response = await bound.invoke([new HumanMessage('Edit both files')])
      expect(response.tool_calls).toMatchObject([{ name: 'apply_patch', args }])
      const tools = sent?.tools as Array<Record<string, unknown>>
      expect(tools).toHaveLength(1)
      const definition = protocol === 'openai_chat_completions' ? tools[0].function as Record<string, unknown> : tools[0]
      expect(definition.name).toBe('apply_patch')
      const schema = (definition.parameters ?? definition.input_schema) as {
        additionalProperties: boolean
        properties: Record<string, unknown>
        required: string[]
      }
      expect(schema.additionalProperties).toBe(false)
      expect(Object.keys(schema.properties).sort()).toEqual(['dry_run', 'patch', 'summary'])
      expect(schema.properties.patch).toMatchObject({ type: 'string' })
      expect(schema.required).toContain('patch')
      expect(filePatchSchema.parse(response.tool_calls![0].args)).toEqual(args)
    })

  it('keeps request image encoding stable when called again', () => {
    const original = new ToolMessage({ tool_call_id: 'image', content: [
      { type: 'input_text', text: 'picture.png' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' }
    ] })
    for (const responses of [true, false]) {
      const once = encodeOpenAiToolImages([original], responses)
      const twice = encodeOpenAiToolImages(once, responses)
      expect(twice.map((message) => message.content)).toEqual(once.map((message) => message.content))
      expect(JSON.stringify(once)).toContain('data:image/png;base64,AAAA')
    }
    expect(original.content).toEqual(expect.arrayContaining([{ type: 'input_text', text: 'picture.png' }]))
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('sends actual tool images through %s in streaming and ordinary requests', async (protocol) => {
    const { createChatModel } = await import('./modelFactory')
    for (const stream of [false, true]) {
      let sent: any
      const response = protocol === 'anthropic_messages'
        ? { id: 'msg_image', type: 'message', role: 'assistant', model: 'fixture', stop_reason: 'end_turn', stop_sequence: null,
            content: [{ type: 'text', text: 'Seen' }], usage: { input_tokens: 10, output_tokens: 2 } }
        : protocol === 'openai_responses'
          ? { id: 'resp_image', object: 'response', created_at: 1, status: 'completed', model: 'fixture',
              output: [{ id: 'msg_image', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Seen', annotations: [] }] }],
              usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }
          : { id: 'chat_image', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Seen' } }],
              usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }
      const providerFetch: typeof fetch = async (input, init) => {
        sent = input instanceof Request ? await input.clone().json() : JSON.parse(String(init?.body))
        if (!stream) return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } })
        const events = protocol === 'anthropic_messages' ? [
          { type: 'message_start', message: { ...response, content: [], stop_reason: null } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Seen' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
          { type: 'message_stop' }
        ] : [{ id: 'chat_image', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Seen' }, finish_reason: null }] },
          { id: 'chat_image', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]
        const body = protocol === 'openai_responses' ? responsesSse('resp_image', '', 'Seen')
          : events.map((event) => `${'type' in event ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('') + (protocol === 'openai_chat_completions' ? 'data: [DONE]\n\n' : '')
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
      }
      const images = new ToolMessage({ tool_call_id: 'images', name: 'view_multiple_images', response_metadata: { output_version: 'v1' }, content: [
        { type: 'text', text: 'first.png' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' },
        { type: 'text', text: 'second.jpg' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } }
      ] })
      const messages = [new HumanMessage('Inspect the pictures'), new AIMessage({ content: '', tool_calls: [
        { id: 'images', name: 'view_multiple_images', args: { paths: ['first.png', 'second.jpg'] } },
        { id: 'text', name: 'read_file', args: { path: 'notes.txt' } }
      ] }), images, new ToolMessage({ tool_call_id: 'text', content: 'Notes' })]
      const original = JSON.stringify(messages)
      const model = createChatModel({ ...baseModel, protocol, stream }, { providerFetch }) as OpenAICompatibleChatModel
      if (stream) await model.streamEvents(messages).output
      else await model.invoke(messages)
      expect(JSON.stringify(messages)).toBe(original)
      if (protocol === 'openai_responses') {
        expect(sent.input.find((item: any) => item.call_id === 'images' && item.type === 'function_call_output').output).toEqual([
          { type: 'input_text', text: 'first.png' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' },
          { type: 'input_text', text: 'second.jpg' }, { type: 'input_image', image_url: 'data:image/jpeg;base64,BBBB', detail: 'auto' }
        ])
      } else if (protocol === 'anthropic_messages') {
        const result = sent.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).find((block: any) => block.type === 'tool_result' && block.tool_use_id === 'images')
        expect(result.content.filter((block: any) => block.type === 'image')).toEqual([
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } }
        ])
      } else {
        expect(sent.messages.slice(-3).map((message: any) => message.role)).toEqual(['tool', 'tool', 'user'])
        expect(sent.messages.at(-1).content.filter((block: any) => block.type === 'image_url')).toEqual([
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } }
        ])
      }
    }
  })

  it('creates an OpenAI-compatible model from the current configuration', async () => {
    const { createChatModel } = await import('./modelFactory')
    const model = createChatModel({
      ...baseModel,
      parameters: { temperature: 0.2, enable_thinking: false }
    })

    expect(model).toMatchObject({
      model: 'test-model',
      temperature: 0.2,
      streaming: true
    })
    expect(model.profile).toMatchObject({
      maxInputTokens: 112000,
      maxOutputTokens: 16000
    })
    expect(model).toBeInstanceOf(OpenAICompatibleChatModel)
    const bound = (model as OpenAICompatibleChatModel).bindTools([
      tool(async () => 'ok', {
        name: 'probe',
        description: 'Probe tool',
        schema: z.object({})
      })
    ])
    expect(bound).toBeInstanceOf(OpenAICompatibleChatModel)
    expect((bound as OpenAICompatibleChatModel).profile).toMatchObject({
      maxInputTokens: 112000,
      maxOutputTokens: 16000
    })
  })

  it('maps Anthropic API thinking parameters to the adapter fields', async () => {
    const { createChatModel } = await import('./modelFactory')
    const model = createChatModel({
      ...baseModel,
      protocol: 'anthropic_messages',
      parameters: {
        thinking: { type: 'adaptive' },
        output_config: { effort: 'medium' }
      }
    }) as unknown as {
      invocationKwargs: Record<string, unknown>
      invocationParams(): Record<string, unknown>
    }

    expect(model.invocationKwargs).not.toHaveProperty('thinking')
    expect(model.invocationKwargs).not.toHaveProperty('output_config')
    expect(model.invocationParams()).toMatchObject({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' }
    })
  })

  it.each([
    { parameters: { thinking: { type: 'enabled', budget_tokens: 2048 } }, reason: 'thinking.type="enabled"' },
    { parameters: { temperature: 0.2 }, reason: 'temperature is not supported' }
  ])('reports unsupported Anthropic model parameter combinations during construction: $reason', async ({ parameters, reason }) => {
    const { createChatModel } = await import('./modelFactory')
    const create = () => createChatModel({ ...baseModel, protocol: 'anthropic_messages', model: 'claude-opus-4-7', parameters })
    expect(create).toThrow(ModelSelectionError)
    expect(create).toThrow(reason)
  })

  it('passes MiniMax OpenAI thinking controls through model kwargs', async () => {
    const { createChatModel } = await import('./modelFactory')
    const model = createChatModel({
      ...baseModel,
      parameters: {
        thinking: { type: 'adaptive' },
        reasoning_split: true
      }
    })

    expect(model).toMatchObject({
      modelKwargs: {
        thinking: { type: 'adaptive' },
        reasoning_split: true
      }
    })
  })

  it('keeps Responses server tools out of raw model kwargs for framework binding', async () => {
    const { createChatModel } = await import('./modelFactory')
    const model = createChatModel({
      ...baseModel,
      protocol: 'openai_responses',
      parameters: { tools: [{ type: 'web_search' }] }
    })

    expect(model).toMatchObject({ modelKwargs: {} })
    expect(() => createChatModel({
      ...baseModel,
      parameters: { tools: [{ type: 'web_search' }] }
    })).toThrow('only supported by the OpenAI Responses protocol')
  })

  it('forces compression calls to be non-streaming', async () => {
    const { createCompressionChatModel } = await import('./modelFactory')
    const openAiModel = createCompressionChatModel(baseModel)
    const anthropicModel = createCompressionChatModel({
      ...baseModel,
      protocol: 'anthropic_messages'
    })

    expect(openAiModel).toMatchObject({
      streaming: false,
      timeout: 120_000
    })
    expect(anthropicModel).toMatchObject({
      streaming: false,
      clientOptions: { timeout: 120_000 }
    })
    expect(openAiModel.profile.maxInputTokens).toBe(112000)
    expect(anthropicModel.profile.maxInputTokens).toBe(112000)
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)(
    'preserves constructor callbacks through %s main and compression bindings', async (protocol) => {
      const { createChatModel, createCompressionChatModel } = await import('./modelFactory')
      const ended = vi.fn()
      const callback = BaseCallbackHandler.fromMethods({ handleLLMEnd: ended })
      callback.awaitHandlers = true
      const generate = async () => ({ generations: [{ text: 'done', message: new AIMessage('done') }] })
      vi.spyOn(ChatAnthropic.prototype, '_generate').mockImplementation(generate)
      vi.spyOn(OpenAICompatibleChatModel.prototype, '_generate').mockImplementation(generate)
      for (const factory of [createChatModel, createCompressionChatModel]) {
        const model = factory({ ...baseModel, protocol, stream: false }, { callbacks: [callback] }) as BaseChatModel
        await model.bindTools!([]).withConfig({ tags: ['callback-verification'] }).invoke('inspect')
      }
      expect(ended).toHaveBeenCalledTimes(2)
    }
  )

  it('uses provider and adapter defaults when maximum output tokens is zero', async () => {
    const { createChatModel } = await import('./modelFactory')
    const openAiModel = createChatModel({ ...baseModel, maxOutputTokens: 0 })
    const anthropicModel = createChatModel({
      ...baseModel,
      protocol: 'anthropic_messages',
      maxOutputTokens: 0
    })

    expect(openAiModel).toMatchObject({ maxTokens: -1 })
    expect((openAiModel as OpenAICompatibleChatModel).invocationParams()).toMatchObject({
      max_tokens: undefined
    })
    expect(anthropicModel).toMatchObject({ maxTokens: 4096 })
    expect(openAiModel.profile).toEqual({ maxInputTokens: 128000 })
    expect(anthropicModel.profile).toEqual({ maxInputTokens: 128000 })
  })

  it('never downloads tokenizer data for supported model protocols', async () => {
    const { createChatModel } = await import('./modelFactory')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const openAiModel = createChatModel(baseModel) as OpenAICompatibleChatModel
    const models = [
      openAiModel,
      openAiModel.withConfig({ tags: ['local-token-counting'] }) as OpenAICompatibleChatModel,
      openAiModel.bindTools([]) as OpenAICompatibleChatModel,
      createChatModel({ ...baseModel, protocol: 'anthropic_messages' })
    ]

    try {
      await expect(Promise.all(models.map((model) =>
        model.getNumTokens('Count these tokens locally.')
      ))).resolves.toEqual([7, 7, 7, 7])
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('requires a configured model id but accepts an empty API key', async () => {
    const { createChatModel } = await import('./modelFactory')
    expect(() => createChatModel({ ...baseModel, model: '' })).toThrow('incomplete model configuration')
    expect(() => createChatModel({ ...baseModel, apiKey: undefined })).not.toThrow()
    expect(() => createChatModel({ ...baseModel, protocol: 'anthropic_messages', apiKey: undefined })).not.toThrow()
  })

  it('invokes both adapters with non-sensitive fallback credentials', async () => {
    const { createChatModel } = await import('./modelFactory')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input)
      const body = url.endsWith('/messages')
        ? {
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'anthropic-ok' }],
            model: 'test-model',
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 }
          }
        : {
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: 1,
            model: 'test-model',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'openai-ok' },
              finish_reason: 'stop'
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    })

    try {
      const openAiModel = createChatModel({ ...baseModel, apiKey: undefined, stream: false })
      const anthropicModel = createChatModel({
        ...baseModel,
        protocol: 'anthropic_messages',
        apiKey: undefined,
        stream: false
      })

      await expect(openAiModel.invoke('Hello')).resolves.toMatchObject({ content: 'openai-ok' })
      await expect(anthropicModel.invoke('Hello')).resolves.toMatchObject({ content: 'anthropic-ok' })
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      const requestHeaders = fetchSpy.mock.calls.map(([input, init]) => ({
        headers: input instanceof Request ? input.headers : new Headers(init?.headers),
        url: input instanceof Request ? input.url : String(input)
      }))
      const openAiHeaders = requestHeaders.find((request) => request.url.includes('/chat/completions'))?.headers
      const anthropicHeaders = requestHeaders.find((request) => request.url.endsWith('/messages'))?.headers
      expect(openAiHeaders?.get('authorization')).toBe('Bearer anas-no-auth')
      expect(anthropicHeaders?.get('x-api-key')).toBe('anas-no-auth')
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('uses the selected OpenAI endpoint and preserves Responses output items', async () => {
    const { createChatModel } = await import('./modelFactory')
    const requestedUrls: string[] = []
    const requestBodies: Array<Record<string, unknown>> = []
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      requestedUrls.push(url)
      const requestBody = input instanceof Request
        ? await input.clone().json() as Record<string, unknown>
        : JSON.parse(String(init?.body)) as Record<string, unknown>
      requestBodies.push(requestBody)
      if (url.endsWith('/responses')) {
        return new Response(JSON.stringify({
          id: 'resp_test',
          object: 'response',
          created_at: 1,
          status: 'completed',
          model: 'gpt-5',
          output_text: 'responses-ok',
          output: [
            {
              id: 'rs_test',
              type: 'reasoning',
              summary: [{ type: 'summary_text', text: 'reasoning summary' }]
            },
            {
              id: 'msg_test',
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'responses-ok', annotations: [] }]
            }
          ],
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            total_tokens: 3,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 1 }
          }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-5',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'chat-ok' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    try {
      const responsesModel = createChatModel({
        ...baseModel,
        protocol: 'openai_responses',
        model: 'gpt-5',
        stream: false
      })
      const chatModel = createChatModel({
        ...baseModel,
        protocol: 'openai_chat_completions',
        model: 'gpt-5',
        stream: false
      })

      const response = await responsesModel.invoke('Hello')
      await responsesModel.invoke([
        new HumanMessage('Hello'),
        response,
        new HumanMessage('Follow up')
      ])
      await expect(chatModel.invoke('Hello')).resolves.toMatchObject({ content: 'chat-ok' })

      expect(requestedUrls).toEqual([
        'https://example.com/v1/responses',
        'https://example.com/v1/responses',
        'https://example.com/v1/chat/completions'
      ])
      expect(requestBodies[1].input).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'rs_test', type: 'reasoning' }),
        expect.objectContaining({ id: 'msg_test', type: 'message' }),
        expect.objectContaining({ role: 'user', content: 'Follow up' })
      ]))
      expect(response.response_metadata.output).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'rs_test', type: 'reasoning' }),
        expect.objectContaining({ id: 'msg_test', type: 'message' })
      ]))
      expect(response.contentBlocks).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'reasoning', reasoning: 'reasoning summary' }),
        expect.objectContaining({ type: 'text', text: 'responses-ok' })
      ]))
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it.each([false, true])('replays a generated Responses image unchanged while budgeting it once (stream=%s)', async (stream) => {
    const { createChatModel } = await import('./modelFactory')
    const image = { type: 'image_generation_call', id: 'ig_flower', status: 'completed', result: 'A'.repeat(100_000) }
    const response = { id: 'resp_image', object: 'response', created_at: 1, model: 'test-model',
      status: 'completed', output: [image], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    const bodies: Record<string, unknown>[] = []
    const selected = { ...baseModel, protocol: 'openai_responses' as const, stream, maxContextTokens: 4096, maxOutputTokens: 1024 }
    const model = createChatModel(selected, { providerFetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      if (!body.stream) return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } })
      const events = [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...image, status: 'in_progress', result: null } },
        { type: 'response.output_item.done', output_index: 0, item: image },
        { type: 'response.completed', response }
      ]
      return new Response(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } })
    } }) as OpenAICompatibleChatModel
    const prompt = new HumanMessage('Draw a flower.')
    const generated = stream ? await model.streamEvents([prompt]).output : await model.invoke([prompt])
    const messages = [prompt, generated, new HumanMessage('Continue.')]
    expect(toAgentMessage(generated, 'generated').content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image', mimeType: 'image/png', data: image.result })
    ]))
    expect(generated.response_metadata.output).toEqual([image])
    expect(countMessagesApproximately(messages, [], { protocol: selected.protocol })).toBeLessThan(1100)
    expect(() => assertModelInputFits(selected, messages, [])).not.toThrow()
    if (stream) await model.streamEvents(messages).output
    else await model.invoke(messages)
    expect(bodies[1].input).toEqual(expect.arrayContaining([image]))
  })

  it.each([false, true])('budgets native code interpreter images in the actual Responses replay (stream=%s)', async (stream) => {
    const { createChatModel } = await import('./modelFactory')
    const output = { type: 'code_interpreter_call', id: 'ci_chart', status: 'completed',
      container_id: 'cntr_chart', code: 'plot()', outputs: [
        { type: 'logs', logs: 'Generated two charts.' },
        { type: 'image', url: 'https://example.test/chart.png' },
        { type: 'image', url: `data:image/png;base64,${'A'.repeat(100_000)}` }
      ] }
    const response = { id: 'resp_charts', object: 'response', created_at: 1, model: 'test-model',
      status: 'completed', output: [output], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    const bodies: Record<string, unknown>[] = []
    const selected = { ...baseModel, protocol: 'openai_responses' as const, stream,
      parameters: { tools: [{ type: 'code_interpreter', container: { type: 'auto' } }], include: ['code_interpreter_call.outputs'] } }
    const model = (createChatModel(selected, { providerFetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      if (!body.stream) return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } })
      const events = [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...output, status: 'in_progress', outputs: null } },
        { type: 'response.output_item.done', output_index: 0, item: output },
        { type: 'response.completed', response }
      ]
      return new Response(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } })
    } }) as OpenAICompatibleChatModel).bindTools(selected.parameters.tools) as OpenAICompatibleChatModel
    const prompt = new HumanMessage('Plot two charts.')
    const generated = stream ? await model.streamEvents([prompt]).output : await model.invoke([prompt])
    const restored = mapStoredMessageToChatMessage(generated.toDict())
    const messages = [prompt, restored, new HumanMessage('Interpret the charts.')]
    expect(restored.response_metadata).toMatchObject({ output: [output] })
    expect(() => assertModelInputSupported(selected, messages, false)).not.toThrow()
    expect(() => assertModelInputSupported({ ...selected, capabilities: { ...selected.capabilities, vision: false } }, messages, false))
      .toThrow('does not support the images')
    const tokens = countMessagesApproximately(messages, selected.parameters.tools, selected)
    expect(tokens).toBeGreaterThanOrEqual(2048)
    expect(tokens).toBeLessThan(2300)
    const exactCapacity = { ...selected, maxContextTokens: tokens + selected.maxOutputTokens }
    expect(() => assertModelInputFits(exactCapacity, messages, selected.parameters.tools)).not.toThrow()
    expect(() => assertModelInputFits({ ...exactCapacity, maxContextTokens: exactCapacity.maxContextTokens - 1 }, messages, selected.parameters.tools))
      .toThrow('required context does not fit')
    if (stream) await model.streamEvents(messages).output
    else await model.invoke(messages)
    expect(bodies[1]).toMatchObject({ tools: selected.parameters.tools, include: selected.parameters.include,
      input: expect.arrayContaining([output]) })
  })

  it('streams Responses reasoning and replays the exact output on the next call', async () => {
    const { createChatModel } = await import('./modelFactory')
    const requestBodies: Array<Record<string, unknown>> = []
    let requestNumber = 0
    const providerFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requestNumber += 1
      requestBodies.push(input instanceof Request
        ? await input.clone().json() as Record<string, unknown>
        : JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(
        responsesSse(`resp_${requestNumber}`, `REASONING_${requestNumber}`, `ANSWER_${requestNumber}`),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      )
    })
    const model = createChatModel({
      ...baseModel,
      protocol: 'openai_responses',
      model: 'qwen-compatible-model',
      stream: true
    }, { providerFetch }) as OpenAICompatibleChatModel

    const first = model.streamEvents([new HumanMessage('FIRST')])
    const firstReasoning = (async () => {
      let text = ''
      for await (const delta of first.reasoning) text += delta
      return text
    })()
    const firstOutput = first.output
    const [reasoning, message] = await Promise.all([firstReasoning, firstOutput])

    const second = model.streamEvents([
      new HumanMessage('FIRST'),
      message,
      new HumanMessage('FOLLOW UP')
    ])
    await second.output

    expect(reasoning).toBe('REASONING_1')
    expect(message.response_metadata.output).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'rs_resp_1', type: 'reasoning' }),
      expect.objectContaining({ id: 'msg_resp_1', type: 'message' })
    ]))
    expect(requestBodies[1].input).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'rs_resp_1', type: 'reasoning' }),
      expect.objectContaining({ id: 'msg_resp_1', type: 'message' }),
      expect.objectContaining({ role: 'user', content: 'FOLLOW UP' })
    ]))
  })

  it('disables provider and AsyncCaller retries for every adapter', async () => {
    const { createChatModel } = await import('./modelFactory')
    const openAiModel = createChatModel(baseModel)
    const anthropicModel = createChatModel({ ...baseModel, protocol: 'anthropic_messages' })

    expect((openAiModel as unknown as { caller: { maxRetries: number } }).caller.maxRetries).toBe(0)
    expect((anthropicModel as unknown as { caller: { maxRetries: number } }).caller.maxRetries).toBe(0)
  })

  it('rejects reserved extra parameters instead of overriding explicit fields', async () => {
    const { createChatModel } = await import('./modelFactory')
    expect(() => createChatModel({
      ...baseModel,
      parameters: { model: 'shadow-model', stream: false, max_retries: 99 }
    })).toThrow(/max_retries, model, stream/)
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)(
    'rejects runtime request overrides before constructing %s main or compression requests', async (protocol) => {
      const { createChatModel, createCompressionChatModel } = await import('./modelFactory')
      const providerFetch = vi.fn()
      for (const field of ['input', 'messages', 'system', 'conversation', 'previous_response_id', 'prompt']) {
        for (const factory of [createChatModel, createCompressionChatModel]) {
          expect(() => factory({ ...baseModel, protocol, parameters: { [field]: 'shadow context' } }, { providerFetch }))
            .toThrow(ModelSelectionError)
        }
      }
      expect(providerFetch).not.toHaveBeenCalled()
    }
  )

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)(
    'rejects configured client function declarations before %s main or compression requests', async (protocol) => {
      const { createChatModel, createCompressionChatModel } = await import('./modelFactory')
      const providerFetch = vi.fn()
      for (const parameters of [
        { functions: [{ name: 'unregistered', description: 'x'.repeat(20_000), parameters: { type: 'object' } }] },
        { function_call: { name: 'unregistered' } }
      ]) {
        for (const factory of [createChatModel, createCompressionChatModel]) {
          expect(() => factory({ ...baseModel, protocol, parameters }, { providerFetch }))
            .toThrow(`reserved keys: ${Object.keys(parameters)[0]}`)
        }
      }
      expect(providerFetch).not.toHaveBeenCalled()
    }
  )

  it('preserves counted Responses instructions on main and forced non-streaming compression requests', async () => {
    const { createChatModel, createCompressionChatModel } = await import('./modelFactory')
    const instructions = 'Use the configured answer format. '.repeat(100)
    const selected = { ...baseModel, protocol: 'openai_responses' as const, parameters: { instructions }, stream: false }
    const bodies: Array<Record<string, unknown>> = []
    const providerFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ id: 'response_instructions', object: 'response', created_at: 1,
        status: 'completed', model: 'test-model', output_text: 'Done', output: [{
          type: 'message', id: 'msg_instructions', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'Done', annotations: [] }]
        }] }), { headers: { 'content-type': 'application/json' } })
    })
    const messages = [new HumanMessage('Apply the format.')]
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(providerFetch)
    try {
      await createChatModel(selected, { providerFetch }).invoke(messages)
      await createCompressionChatModel({ ...selected, stream: true }).invoke(messages)
      expect(bodies).toHaveLength(2)
      for (const body of bodies) expect(body).toMatchObject({ instructions, stream: false,
        input: [{ role: 'user', content: 'Apply the format.' }] })
      expect(countMessagesApproximately(messages, [], { protocol: selected.protocol, parameters: selected.parameters }))
        .toBe(countMessagesApproximately(messages, [], { protocol: selected.protocol }) + Math.ceil(instructions.length / 4))
    } finally { fetchSpy.mockRestore() }
  })

  it.each([false, 10, {}, []])('rejects invalid Responses instructions before any request: %j', async (instructions) => {
    const { createChatModel, createCompressionChatModel } = await import('./modelFactory')
    const selected = { ...baseModel, protocol: 'openai_responses' as const, parameters: { instructions } }
    expect(() => createChatModel(selected)).toThrow(ModelSelectionError)
    expect(() => createCompressionChatModel(selected)).toThrow('instructions')
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('preserves the counted %s output schema in actual provider requests', async (protocol) => {
    const { createChatModel, createCompressionChatModel } = await import('./modelFactory')
    const schema = { type: 'object', description: 'Expected answer. '.repeat(100), properties: { answer: { type: 'string' } }, additionalProperties: false, required: ['answer'] }
    const format = protocol === 'anthropic_messages' ? { type: 'json_schema', schema }
      : protocol === 'openai_responses' ? { type: 'json_schema', name: 'answer', strict: true, schema }
        : { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } }
    const parameters = protocol === 'anthropic_messages' ? { output_config: { format } }
      : protocol === 'openai_responses' ? { text: { format } } : { response_format: format }
    const selected = { ...baseModel, protocol, parameters, stream: false }
    const messages = [new HumanMessage('Question')]
    const bodies: Record<string, unknown>[] = []
    const providerFetch: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      const response = protocol === 'anthropic_messages'
        ? { id: 'msg_schema', type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'text', text: '{"answer":"Done"}' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
        : protocol === 'openai_responses'
          ? { id: 'resp_schema', object: 'response', created_at: 1, status: 'completed', model: 'fixture', output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } }
          : { id: 'chat_schema', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"answer":"Done"}' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
      return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } })
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(providerFetch)
    try {
      await createChatModel(selected, { providerFetch }).invoke(messages)
      await createCompressionChatModel({ ...selected, stream: true }).invoke(messages)
      for (const body of bodies) expect(body).toMatchObject(parameters)
      expect(countMessagesApproximately(messages, [], { protocol, parameters }))
        .toBe(countMessagesApproximately(messages, [], { protocol }) + Math.ceil(JSON.stringify(format).length / 4))
    } finally { fetchSpy.mockRestore() }
  })

  it.each([
    { tools: [] },
    { temperature: 'invalid' },
    { model: 'shadow-model' }
  ])('classifies invalid compression parameters as terminal selection errors: %j', async (parameters) => {
    const { createCompressionChatModel } = await import('./modelFactory')
    expect(() => createCompressionChatModel({ ...baseModel, parameters })).toThrow(ModelSelectionError)
  })

  it('observes each actual provider fetch without logging request contents', async () => {
    const { createChatModel } = await import('./modelFactory')
    runtimeLoggerMocks.runtimeLog.mockClear()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }))
    const model = createChatModel(baseModel) as OpenAICompatibleChatModel
    const providerFetch = (model as unknown as {
      clientConfig: { fetch: typeof fetch }
    }).clientConfig.fetch

    try {
      await expect(providerFetch('https://example.com/v1/chat/completions')).resolves.toMatchObject({ status: 204 })
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(runtimeLoggerMocks.runtimeLog).toHaveBeenNthCalledWith(
        1,
        'debug',
        'agent-model',
        'Provider request started.',
        expect.objectContaining({ protocol: 'openai_chat_completions', model: 'test-model', requestNumber: 1 })
      )
      expect(runtimeLoggerMocks.runtimeLog).toHaveBeenNthCalledWith(
        2,
        'debug',
        'agent-model',
        'Provider request completed.',
        expect.objectContaining({ status: 204, requestNumber: 1 })
      )
      expect(JSON.stringify(runtimeLoggerMocks.runtimeLog.mock.calls)).not.toContain('/chat/completions')
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('uses the same cancellable retry policy for non-streaming compression requests', async () => {
    const { createCompressionChatModel } = await import('./modelFactory')
    const controller = new AbortController()
    const compression = createCompressionChatModel(baseModel, {
      requestId: 'compression-run',
      requestRole: 'compression',
      signal: controller.signal
    })

    expect((compression as unknown as {
      anasRetryOptions?: { runId?: string; signal?: AbortSignal }
    }).anasRetryOptions).toEqual({ runId: 'compression-run', signal: controller.signal })
  })

  it.each((['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)
    .flatMap(protocol => [
      { protocol, failure: new ModelSelectionError('The selected model was deleted.') },
      { protocol, failure: new ModelRequestChangedError() }
    ]))(
    'returns $failure.name to preparation before resending a $protocol compression request', async ({ protocol, failure }) => {
      const { createCompressionChatModel } = await import('./modelFactory')
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
        JSON.stringify({ error: { type: 'server_error', message: 'Temporarily unavailable' } }),
        { status: 503, headers: { 'content-type': 'application/json' } }
      ))
      const beforeRequest = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(failure)
      try {
        const compression = createCompressionChatModel({ ...baseModel, protocol }, { beforeRequest })
        await expect(compression.invoke([new HumanMessage('Summarize this conversation.')])).rejects.toBe(failure)
        expect(fetchSpy).toHaveBeenCalledTimes(1)
        expect(beforeRequest).toHaveBeenCalledTimes(2)
      } finally { fetchSpy.mockRestore() }
    }
  )
})
