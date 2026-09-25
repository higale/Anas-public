import { AIMessage, HumanMessage, ToolMessage, type MessageContent } from '@langchain/core/messages'
import { OpenAICompatibleChatModel } from './openAiCompatibleChatModel'
import { describe, expect, it } from 'vitest'
import { approximateContentTokens, countMessagesApproximately, modelParameterInputTokens } from './localTokenCounting'
import { ModelSelectionError } from './modelSelection'
import { encodeOpenAiToolImages } from './toolImageTransport'

function completedOpenAiResponse(): Response {
  return new Response(JSON.stringify({
    id: 'chat_counting', object: 'chat.completion', created: 1, model: 'fixture',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Done' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }), { headers: { 'content-type': 'application/json' } })
}

describe('local token counting', () => {
  it('counts Responses instructions once for the complete request alongside messages and tools', () => {
    const messages = [new HumanMessage('First input'), new AIMessage('Earlier answer'), new HumanMessage('Follow-up')]
    const tools = [{ type: 'function', name: 'lookup', description: 'Find project information', parameters: { type: 'object' } }]
    const parameters = { instructions: 'Required provider instructions. '.repeat(100) }
    const protocol = 'openai_responses' as const
    expect(countMessagesApproximately(messages, tools, { protocol, parameters }))
      .toBe(countMessagesApproximately(messages, tools, { protocol }) + Math.ceil(parameters.instructions.length / 4))
    expect(modelParameterInputTokens(protocol, parameters)).toBe(Math.ceil(parameters.instructions.length / 4))
    expect(countMessagesApproximately(messages, tools, { protocol, parameters: { instructions: null } }))
      .toBe(countMessagesApproximately(messages, tools, { protocol }))
  })

  it('rejects invalid Responses instructions as a terminal configuration error', () => {
    for (const instructions of [false, 100, {}, []]) {
      expect(() => countMessagesApproximately([], [], { protocol: 'openai_responses', parameters: { instructions } }))
        .toThrow(ModelSelectionError)
    }
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('counts the %s structured-output schema once without charging sampling settings', (protocol) => {
    const schema = { type: 'object', description: 'Required output structure. '.repeat(100), properties: { image: { type: 'string' } } }
    const format = protocol === 'anthropic_messages' ? { type: 'json_schema', schema }
      : protocol === 'openai_responses' ? { type: 'json_schema', name: 'answer', schema }
        : { type: 'json_schema', json_schema: { name: 'answer', schema } }
    const parameters = protocol === 'anthropic_messages' ? { output_config: { format }, temperature: 0.5 }
      : protocol === 'openai_responses' ? { text: { format }, temperature: 0.5 }
        : { response_format: format, temperature: 0.5 }
    const messages = [new HumanMessage('Question'), new AIMessage('Prior response'), new HumanMessage('Continue')]
    expect(countMessagesApproximately(messages, [], { protocol, parameters }))
      .toBe(countMessagesApproximately(messages, [], { protocol }) + Math.ceil(JSON.stringify(format).length / 4))
    expect(modelParameterInputTokens(protocol, { temperature: 0.5, top_p: 0.9 })).toBe(0)
  })

  it('counts the raw Responses output that will be replayed instead of only visible text', () => {
    const visibleOnly = new AIMessage('Short answer')
    const responsesMessage = new AIMessage({
      content: 'Short answer',
      response_metadata: {
        output: [
          {
            id: 'rs_1',
            type: 'reasoning',
            encrypted_content: 'x'.repeat(2_000),
            summary: []
          },
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Short answer', annotations: [] }]
          }
        ]
      }
    })

    const options = { protocol: 'openai_responses' as const }
    expect(countMessagesApproximately([responsesMessage], null, options))
      .toBeGreaterThan(countMessagesApproximately([visibleOnly], null, options) + 400)
  })

  it('does not count visible Responses text twice when raw output is available', () => {
    const rawOutput = [{
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'x'.repeat(1_000), annotations: [] }]
    }]
    const shortVisible = new AIMessage({
      content: 'x',
      response_metadata: { output: rawOutput }
    })
    const longVisible = new AIMessage({
      content: 'y'.repeat(10_000),
      response_metadata: { output: rawOutput }
    })

    const options = { protocol: 'openai_responses' as const }
    expect(countMessagesApproximately([longVisible], null, options))
      .toBe(countMessagesApproximately([shortVisible], null, options))

    const visibleImage = new AIMessage({
      content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(20_000)}` } }],
      response_metadata: { output: rawOutput }
    })
    expect(countMessagesApproximately([visibleImage], null, options))
      .toBe(countMessagesApproximately([shortVisible], null, options))
  })

  it('counts each Responses generated image once while preserving replay metadata', () => {
    const metadata = { type: 'image_generation_call', id: 'ig_flower', status: 'completed' }
    const count = (output: Record<string, unknown>[]) => countMessagesApproximately([
      new AIMessage({ content: '', response_metadata: { output } })
    ], null, { protocol: 'openai_responses' })
    const expected = Math.ceil(JSON.stringify(metadata).length / 4) + 1024
    expect(count([{ ...metadata, result: 'AA==' }])).toBe(expected)
    expect(count([{ ...metadata, result: 'A'.repeat(100_000) }])).toBe(expected)
    expect(count([{ ...metadata, result: 'AA==' }, { ...metadata, id: 'ig_second', result: 'AA==' }]))
      .toBeGreaterThanOrEqual(2048)
    for (const result of [null, '']) expect(count([{ ...metadata, result }])).toBeLessThan(100)
    expect(count([{ ...metadata, result: 'AA==', revised_prompt: 'x'.repeat(8_000) }]))
      .toBeGreaterThan(expected + 2000)
  })

  it('counts each native Responses code interpreter image while retaining logs and call metadata', () => {
    const count = (urls: string[], logs = 'Chart generated') => countMessagesApproximately([
      new AIMessage({ content: '', response_metadata: { output: [{
        type: 'code_interpreter_call', id: 'ci_chart', status: 'completed', container_id: 'cntr_chart', code: 'plot()',
        outputs: [{ type: 'logs', logs }, ...urls.map(url => ({ type: 'image', url }))]
      }] } })
    ], null, { protocol: 'openai_responses' })
    const short = 'https://example.test/chart.png'
    const long = `data:image/png;base64,${'A'.repeat(100_000)}`
    const withoutImages = count([])
    const oneImage = count([short])
    const twoImages = count([short, short])
    expect(oneImage - withoutImages).toBeGreaterThanOrEqual(1024)
    expect(oneImage - withoutImages).toBeLessThanOrEqual(1025)
    expect(twoImages - oneImage).toBeGreaterThanOrEqual(1024)
    expect(twoImages - oneImage).toBeLessThanOrEqual(1025)
    expect(count([long, long])).toBe(twoImages)
    expect(count([short, short], `Chart generated${'x'.repeat(8_000)}`)).toBe(twoImages + 2_000)
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('counts code-interpreter-shaped %s tool arguments and logs as ordinary JSON text', (protocol) => {
    const value = { type: 'code_interpreter_call', outputs: [{ type: 'image', url: 'A'.repeat(16_000) }] }
    const messages = [
      new AIMessage({ content: '', tool_calls: [{ id: 'call_json', name: 'write_json', args: value }] }),
      new ToolMessage({ tool_call_id: 'call_json', content: JSON.stringify(value) })
    ]
    expect(countMessagesApproximately(messages, null, { protocol })).toBeGreaterThan(8_000)
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('treats image-generation-shaped %s tool JSON as text', (protocol) => {
    const value = { type: 'image_generation_call', result: 'A'.repeat(16_000) }
    const messages = [
      new AIMessage({ content: '', tool_calls: [{ id: 'call_json', name: 'write_json', args: value }] }),
      new ToolMessage({ tool_call_id: 'call_json', content: JSON.stringify(value) })
    ]
    expect(countMessagesApproximately(messages, null, { protocol })).toBeGreaterThan(8_000)
  })

  it('does not use historical output usage as the next request content', () => {
    const message = new AIMessage({
      content: 'Answer',
      response_metadata: {
        output: [{ id: 'rs_server_retained', type: 'reasoning', summary: [] }]
      },
      usage_metadata: {
        input_tokens: 10,
        output_tokens: 2_000,
        total_tokens: 2_010,
        output_token_details: { reasoning: 1_990 }
      }
    })

    for (const protocol of [undefined, 'openai_responses', 'openai_chat_completions', 'anthropic_messages'] as const) {
      expect(countMessagesApproximately([message], null, { protocol })).toBeLessThan(100)
    }
  })

  it('continues to count ordinary messages and tool definitions', () => {
    const messages = [new HumanMessage('A'.repeat(400))]
    const withoutTools = countMessagesApproximately(messages)
    const withTools = countMessagesApproximately(messages, [{
      type: 'function',
      function: {
        name: 'search',
        description: 'Search the web',
        parameters: { type: 'object', properties: {} }
      }
    }])

    expect(withoutTools).toBeGreaterThan(90)
    expect(withTools).toBeGreaterThan(withoutTools)
  })

  it('counts generic tool calls once when the AI message already has standard content blocks', () => {
    const call = { id: 'call_lookup', name: 'lookup', args: { query: 'text'.repeat(100) } }
    const original = new AIMessage({ content: '', tool_calls: [call] })
    const standard = new AIMessage({
      content: [{ type: 'tool_call', ...call }],
      tool_calls: [call],
      response_metadata: { output_version: 'v1' }
    })
    expect(countMessagesApproximately([standard])).toBe(countMessagesApproximately([original]))
  })

  it('counts Anthropic thinking blocks that are replayed with their signatures', () => {
    const withoutThinking = new AIMessage('Answer')
    const withThinking = new AIMessage({
      content: [
        { type: 'thinking', thinking: 'x'.repeat(2_000), signature: 'signed-reasoning' },
        { type: 'text', text: 'Answer' }
      ]
    })

    const options = { protocol: 'anthropic_messages' as const }
    expect(countMessagesApproximately([withThinking], null, options))
      .toBeGreaterThan(countMessagesApproximately([withoutThinking], null, options) + 400)
  })

  it.each(['image', 'image_url', 'input_image'])('assigns one fixed image budget to %s regardless of payload length', (type) => {
    for (const payload of ['https://example.com/a.png', `data:image/png;base64,${'A'.repeat(100_000)}`]) {
      const image = type === 'image'
        ? { type, source_type: 'url', url: payload }
        : type === 'image_url'
          ? { type, image_url: { url: payload } }
          : { type, image_url: payload }
      const content = [{ type: 'text', text: 'A'.repeat(400) }, image] as MessageContent
      expect(countMessagesApproximately([new HumanMessage({ content })])).toBe(1124)
      expect(approximateContentTokens(content)).toBe(1124)
    }
  })

  it('counts every image once alongside Responses text blocks', () => {
    const content: MessageContent = [
      { type: 'input_text', text: 'A'.repeat(400) },
      { type: 'input_image', image_url: 'https://example.com/one.png' },
      { type: 'image_url', image_url: { url: 'https://example.com/two.png' } }
    ]
    const message = new HumanMessage({ content })
    expect(countMessagesApproximately([message])).toBe(2148)
    expect(countMessagesApproximately([message], null, { protocol: 'openai_responses' })).toBe(2148)
    expect(approximateContentTokens(content)).toBe(2148)
    expect(message.content).toEqual(content)
  })

  it.each(['input_text', 'output_text'])('counts %s with ordinary text without losing tool-call framing', (type) => {
    const message = new ToolMessage({ tool_call_id: 'call', content: [
      { type: 'text', text: 'ab' }, { type, text: 'cd' }
    ] })
    const ordinary = new ToolMessage({ tool_call_id: 'call', content: 'abcd' })
    expect(countMessagesApproximately([message])).toBe(countMessagesApproximately([ordinary]))
    expect(approximateContentTokens(message.content)).toBe(1)
  })

  it('includes Chat Completions image transport labels and copied text exactly once', () => {
    const messages = [
      new ToolMessage({ tool_call_id: 'first', name: 'view_image', content: [
        { type: 'text', text: 'First chart description. '.repeat(20) },
        { type: 'image_url', image_url: { url: 'https://example.com/first.png' } }
      ] }),
      new ToolMessage({ tool_call_id: 'second', name: 'view_image', content: [
        { type: 'input_text', text: 'Second chart description. '.repeat(20) },
        { type: 'input_image', image_url: 'https://example.com/second.png' }
      ] })
    ]
    const original = messages.map((message) => message.toDict())
    const transmitted = encodeOpenAiToolImages(messages, false)
    const options = { protocol: 'openai_chat_completions' as const }
    expect(countMessagesApproximately(messages, null, options)).toBeGreaterThan(countMessagesApproximately(messages))
    expect(countMessagesApproximately(messages, null, options)).toBe(countMessagesApproximately(transmitted, null, options))
    expect(countMessagesApproximately(messages, null, { protocol: 'openai_responses' })).toBeLessThan(countMessagesApproximately(messages, null, options))
    expect(messages.map((message) => message.toDict())).toEqual(original)
  })

  it('counts only the content actually sent after switching Responses history to Chat Completions', async () => {
    const previous = new AIMessage({
      content: [{ type: 'text', text: 'Done' }],
      response_metadata: {
        output_version: 'v1', model_provider: 'openai',
        output: [{ type: 'reasoning', id: 'rs_previous', encrypted_content: 'x'.repeat(32_000), summary: [] }]
      },
      usage_metadata: { input_tokens: 10, output_tokens: 20_000, total_tokens: 20_010 },
      additional_kwargs: { reasoning: { encrypted_content: 'x'.repeat(32_000) } }
    })
    const messages = [new HumanMessage('Start'), previous, new HumanMessage('Continue')]
    const bodies: Record<string, unknown>[] = []
    const model = new OpenAICompatibleChatModel({
      apiKey: 'test-key', model: 'fixture', streaming: false, maxRetries: 0,
      configuration: { fetch: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return completedOpenAiResponse()
      } }
    })
    await model.invoke(messages)
    expect(JSON.stringify(bodies[0].messages)).not.toContain('encrypted_content')
    expect(JSON.stringify(bodies[0].messages).length).toBeLessThan(200)
    expect(countMessagesApproximately(messages, null, { protocol: 'openai_chat_completions' })).toBeLessThan(20)
    expect(countMessagesApproximately(messages, null, { protocol: 'openai_responses' })).toBeGreaterThan(8_000)
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('ignores image payload lengths inside actual %s tool result framing', (protocol) => {
    const makeMessages = (url: string) => [new ToolMessage({ tool_call_id: 'call_image', content: [
      { type: 'text', text: 'Image result' }, { type: 'image_url', image_url: { url } }
    ] })]
    const short = countMessagesApproximately(makeMessages('https://example.com/image.png'), null, { protocol })
    const long = countMessagesApproximately(makeMessages(`data:image/png;base64,${'A'.repeat(100_000)}`), null, { protocol })
    expect(short).toBeGreaterThanOrEqual(1024)
    expect(long).toBe(short)
    expect(long).toBeLessThan(1124)
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('counts image-shaped JSON tool arguments as text for %s', (protocol) => {
    const message = new AIMessage({ content: '', tool_calls: [{
      id: 'call_json', name: 'write_json', args: { type: 'image', data: 'A'.repeat(16_000) }
    }] })
    const estimated = countMessagesApproximately([message], null, { protocol })
    expect(estimated).toBeGreaterThan(4_000)
    expect(estimated).toBeLessThan(4_200)
  })
})
