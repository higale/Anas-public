import { createRequire } from 'node:module'
import { ChatAnthropic } from '@langchain/anthropic'
import { AIMessageChunk } from '@langchain/core/messages'
import { describe, expect, it, vi } from 'vitest'

const commonjs: typeof import('@langchain/anthropic') = createRequire(import.meta.url)('@langchain/anthropic')

function events(inputAtStart: number) {
  return [
    { type: 'message_start', message: { id: 'usage-test', type: 'message', role: 'assistant', model: 'test', content: [],
      usage: { input_tokens: inputAtStart, output_tokens: 1, cache_read_input_tokens: inputAtStart ? 8 : 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: null }, usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 8 } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
    { type: 'message_stop' }
  ]
}

describe.each([['ESM', ChatAnthropic], ['CommonJS', commonjs.ChatAnthropic]] as const)('%s Anthropic usage', (_name, Model) => {
  function model(inputAtStart: number, streamUsage = true) {
    const fetch = vi.fn(async () => new Response(events(inputAtStart).map((event) =>
      `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } }))
    return new Model({ model: 'test', apiKey: 'test-only', maxRetries: 0, streamUsage, clientOptions: { fetch } })
  }

  it.each([0, 10])('reconciles late and repeated cumulative usage from initial input %i in chunks', async (inputAtStart) => {
    let result: AIMessageChunk | undefined
    for await (const chunk of await model(inputAtStart).stream('read')) result = result ? result.concat(chunk) : chunk
    expect(result?.text).toBe('OK')
    expect(result?.usage_metadata).toMatchObject({ input_tokens: 18, output_tokens: 5, total_tokens: 23,
      input_token_details: { cache_read: 8, cache_creation: 0 } })
  })

  it.each([0, 10])('reconciles initial input %i in the native content event stream', async (inputAtStart) => {
    const stream = model(inputAtStart).streamEvents('read')
    const result = await stream
    expect(result.usage_metadata).toMatchObject({ input_tokens: 18, output_tokens: 5, total_tokens: 23,
      input_token_details: { cache_read: 8, cache_creation: 0 } })
  })

  it('keeps usage disabled without losing text', async () => {
    let result: AIMessageChunk | undefined
    for await (const chunk of await model(10, false).stream('read')) result = result ? result.concat(chunk) : chunk
    expect(result?.text).toBe('OK')
    expect(result?.usage_metadata).toBeUndefined()
  })
})
