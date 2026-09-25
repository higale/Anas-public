import { ChatModelStream } from '@langchain/core/language_models/stream'
import { HumanMessage } from '@langchain/core/messages'
import type OpenAI from 'openai'
import { describe, expect, it } from 'vitest'
import {
  convertOpenAICompatibleMessagesToResponsesInput,
  convertOpenAICompatibleResponsesStream
} from './openAiResponsesStream'

type ResponsesStreamEvent = OpenAI.Responses.ResponseStreamEvent

function response(options: {
  reasoningContent?: string
  reasoningSummary: string
  text?: string
}): OpenAI.Responses.Response {
  const text = options.text ?? 'FINAL'
  return {
    id: 'resp_1',
    object: 'response',
    created_at: 1,
    status: 'completed',
    model: 'qwen-compatible-model',
    output_text: text,
    output: [
      {
        id: 'rs_1',
        type: 'reasoning',
        status: 'completed',
        summary: [{ type: 'summary_text', text: options.reasoningSummary }],
        ...(options.reasoningContent
          ? { content: [{ type: 'reasoning_text', text: options.reasoningContent }] }
          : {})
      },
      {
        id: 'msg_1',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text, annotations: [], logprobs: [] }]
      }
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 8,
      total_tokens: 18,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 5 }
    }
  } as OpenAI.Responses.Response
}

async function *events(items: unknown[]): AsyncGenerator<ResponsesStreamEvent> {
  for (const item of items) yield item as ResponsesStreamEvent
}

async function assembled(items: unknown[]) {
  const stream = new ChatModelStream(
    convertOpenAICompatibleResponsesStream(events(items))
  )
  const reasoning = (async () => {
    let text = ''
    for await (const delta of stream.reasoning) text += delta
    return text
  })()
  const visibleText = (async () => {
    let text = ''
    for await (const delta of stream.text) text += delta
    return text
  })()
  const message = stream.output
  return Promise.all([reasoning, visibleText, message])
}

function envelope(output: OpenAI.Responses.Response): unknown[] {
  return [
    {
      type: 'response.created',
      sequence_number: 0,
      response: { ...output, status: 'in_progress', output: [], usage: null }
    }
  ]
}

function textEvents(): unknown[] {
  return [
    {
      type: 'response.output_item.added',
      sequence_number: 10,
      output_index: 1,
      item: {
        id: 'msg_1',
        type: 'message',
        status: 'in_progress',
        role: 'assistant',
        content: []
      }
    },
    {
      type: 'response.output_text.delta',
      sequence_number: 11,
      item_id: 'msg_1',
      output_index: 1,
      content_index: 0,
      delta: 'FINAL',
      logprobs: []
    }
  ]
}

describe('OpenAI-compatible Responses stream', () => {
  it.each(['completed', 'incomplete'] as const)('preserves generated images alongside streamed text and reasoning (%s)', async (status) => {
    const completed = response({ reasoningSummary: 'PLAN' })
    const images = [
      { type: 'image_generation_call' as const, id: 'ig_1', status: 'completed' as const, result: 'FIRST_IMAGE' },
      { type: 'image_generation_call' as const, id: 'ig_2', status: 'completed' as const, result: 'SECOND_IMAGE' },
      { type: 'image_generation_call' as const, id: 'ig_empty', status: 'failed' as const, result: null }
    ]
    completed.status = status
    completed.output.push(...images)
    const [reasoning, text, message] = await assembled([
      ...envelope(completed),
      { type: 'response.output_item.done', sequence_number: 2, output_index: 2, item: images[0] },
      ...textEvents(),
      { type: `response.${status}`, sequence_number: 20, response: completed }
    ])

    expect(reasoning).toBe('PLAN')
    expect(text).toBe('FINAL')
    expect(message.contentBlocks.filter((block) => block.type === 'image')).toEqual([
      expect.objectContaining({ type: 'image', id: 'ig_1', mimeType: 'image/png', data: 'FIRST_IMAGE' }),
      expect.objectContaining({ type: 'image', id: 'ig_2', mimeType: 'image/png', data: 'SECOND_IMAGE' })
    ])
    expect(message.contentBlocks).toHaveLength(4)
    expect(message.response_metadata.output).toEqual(completed.output)
    const replay = convertOpenAICompatibleMessagesToResponsesInput({
      messages: [new HumanMessage('Draw two images.'), message], model: completed.model, zdrEnabled: false
    })
    expect(replay.filter((item) => item.type === 'image_generation_call')).toEqual(images)
  })

  it('streams Qwen reasoning_text and preserves the final output for replay', async () => {
    const completed = response({ reasoningSummary: 'THINKING' })
    const [reasoning, text, message] = await assembled([
      ...envelope(completed),
      {
        type: 'response.output_item.added',
        sequence_number: 1,
        output_index: 0,
        item: { id: 'rs_1', type: 'reasoning', status: 'in_progress', summary: [] }
      },
      {
        type: 'response.reasoning_text.delta',
        sequence_number: 2,
        item_id: 'rs_1',
        output_index: 0,
        content_index: 0,
        delta: 'THINK'
      },
      {
        type: 'response.reasoning_text.delta',
        sequence_number: 3,
        item_id: 'rs_1',
        output_index: 0,
        content_index: 0,
        delta: 'ING'
      },
      {
        type: 'response.reasoning_text.done',
        sequence_number: 4,
        item_id: 'rs_1',
        output_index: 0,
        content_index: 0,
        text: 'THINKING'
      },
      {
        type: 'response.output_item.done',
        sequence_number: 5,
        output_index: 0,
        item: completed.output[0]
      },
      ...textEvents(),
      { type: 'response.completed', sequence_number: 20, response: completed }
    ])

    expect(reasoning).toBe('THINKING')
    expect(text).toBe('FINAL')
    expect(message.contentBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'reasoning',
        id: 'rs_1',
        reasoning: 'THINKING',
        summary: [{ type: 'summary_text', text: 'THINKING' }]
      }),
      expect.objectContaining({ type: 'text', text: 'FINAL' })
    ]))
    expect(message.response_metadata.output).toEqual(completed.output)

    const nextInput = convertOpenAICompatibleMessagesToResponsesInput({
      messages: [new HumanMessage('FIRST'), message, new HumanMessage('FOLLOW UP')],
      model: 'qwen-compatible-model',
      zdrEnabled: false
    })
    expect(nextInput).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'rs_1', type: 'reasoning' }),
      expect.objectContaining({ id: 'msg_1', type: 'message' }),
      expect.objectContaining({ role: 'user', content: 'FOLLOW UP' })
    ]))
  })

  it('continues to stream OpenAI reasoning_summary_text events', async () => {
    const completed = response({ reasoningSummary: 'SUMMARY' })
    const [reasoning] = await assembled([
      ...envelope(completed),
      {
        type: 'response.output_item.added',
        sequence_number: 1,
        output_index: 0,
        item: { id: 'rs_1', type: 'reasoning', status: 'in_progress', summary: [] }
      },
      {
        type: 'response.reasoning_summary_text.delta',
        sequence_number: 2,
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        delta: 'SUM'
      },
      {
        type: 'response.reasoning_summary_text.delta',
        sequence_number: 3,
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        delta: 'MARY'
      },
      {
        type: 'response.output_item.done',
        sequence_number: 4,
        output_index: 0,
        item: completed.output[0]
      },
      ...textEvents(),
      { type: 'response.completed', sequence_number: 20, response: completed }
    ])

    expect(reasoning).toBe('SUMMARY')
  })

  it('uses the final reasoning item when the provider emits no reasoning deltas', async () => {
    const completed = response({ reasoningSummary: 'FINAL SUMMARY' })
    const [reasoning] = await assembled([
      ...envelope(completed),
      {
        type: 'response.output_item.added',
        sequence_number: 1,
        output_index: 0,
        item: { id: 'rs_1', type: 'reasoning', status: 'in_progress', summary: [] }
      },
      {
        type: 'response.output_item.done',
        sequence_number: 2,
        output_index: 0,
        item: completed.output[0]
      },
      ...textEvents(),
      { type: 'response.completed', sequence_number: 20, response: completed }
    ])

    expect(reasoning).toBe('FINAL SUMMARY')
  })

  it('does not duplicate reasoning when both event families are present', async () => {
    const completed = response({ reasoningSummary: 'THINKING' })
    const [reasoning] = await assembled([
      ...envelope(completed),
      {
        type: 'response.output_item.added',
        sequence_number: 1,
        output_index: 0,
        item: { id: 'rs_1', type: 'reasoning', status: 'in_progress', summary: [] }
      },
      {
        type: 'response.reasoning_text.delta',
        sequence_number: 2,
        item_id: 'rs_1',
        output_index: 0,
        content_index: 0,
        delta: 'THINKING'
      },
      {
        type: 'response.reasoning_summary_text.delta',
        sequence_number: 3,
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        delta: 'THINKING'
      },
      {
        type: 'response.output_item.done',
        sequence_number: 4,
        output_index: 0,
        item: completed.output[0]
      },
      ...textEvents(),
      { type: 'response.completed', sequence_number: 20, response: completed }
    ])

    expect(reasoning).toBe('THINKING')
  })

  it('keeps summary and reasoning text separate regardless of event order', async () => {
    const completed = response({
      reasoningSummary: 'SHORT SUMMARY',
      reasoningContent: 'FULL REASONING'
    })
    const [reasoning, , message] = await assembled([
      ...envelope(completed),
      {
        type: 'response.output_item.added',
        sequence_number: 1,
        output_index: 0,
        item: { id: 'rs_1', type: 'reasoning', status: 'in_progress', summary: [] }
      },
      {
        type: 'response.reasoning_summary_text.delta',
        sequence_number: 2,
        item_id: 'rs_1',
        output_index: 0,
        summary_index: 0,
        delta: 'SHORT SUMMARY'
      },
      {
        type: 'response.reasoning_text.delta',
        sequence_number: 3,
        item_id: 'rs_1',
        output_index: 0,
        content_index: 0,
        delta: 'FULL REASONING'
      },
      {
        type: 'response.output_item.done',
        sequence_number: 4,
        output_index: 0,
        item: completed.output[0]
      },
      ...textEvents(),
      { type: 'response.completed', sequence_number: 20, response: completed }
    ])

    expect(reasoning).toBe('FULL REASONING')
    expect(message.contentBlocks).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'reasoning',
        reasoning: 'FULL REASONING',
        summary: [{ type: 'summary_text', text: 'SHORT SUMMARY' }]
      })
    ]))
  })

  it('prefers final reasoning content over its summary when no deltas arrive', async () => {
    const completed = response({
      reasoningSummary: 'SHORT SUMMARY',
      reasoningContent: 'FULL REASONING'
    })
    const [reasoning] = await assembled([
      ...envelope(completed),
      {
        type: 'response.output_item.done',
        sequence_number: 1,
        output_index: 0,
        item: completed.output[0]
      },
      ...textEvents(),
      { type: 'response.completed', sequence_number: 20, response: completed }
    ])

    expect(reasoning).toBe('FULL REASONING')
  })
})
