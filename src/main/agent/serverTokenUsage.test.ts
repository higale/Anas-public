import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { describe, expect, it } from 'vitest'
import { contextRequestKey as requestKey, currentContextWindowTokens as windowTokens, latestServerTokenUsage, latestServerTokenUsageSnapshot } from './serverTokenUsage'

import { countMessagesApproximately } from './localTokenCounting'
import { tool } from '@langchain/core/tools'
import { convertToOpenAITool } from '@langchain/core/utils/function_calling'
import { z } from 'zod'
import { projectSkillMessages, toHumanMessage } from './messageMapper'

function contextRequestKey(options: Omit<Parameters<typeof requestKey>[0], 'messages' | 'protocol'> & Partial<Pick<Parameters<typeof requestKey>[0], 'messages' | 'protocol'>>) {
  return requestKey({ messages: [], protocol: 'openai_chat_completions', ...options })
}

function currentContextWindowTokens(options: Omit<Parameters<typeof windowTokens>[0], 'protocol'> & Partial<Pick<Parameters<typeof windowTokens>[0], 'protocol'>>) {
  return windowTokens({ protocol: 'openai_chat_completions', ...options })
}

function serverMessage(options: {
  id: string
  input: number
  output: number
  total: number
}): AIMessage {
  return new AIMessage({
    id: options.id,
    content: 'Answer',
    additional_kwargs: { anas_context_request_key: contextRequestKey({ systemMessage: undefined, tools: [] }) },
    usage_metadata: {
      input_tokens: options.input,
      output_tokens: options.output,
      total_tokens: options.total
    }
  })
}

describe('server token usage', () => {
  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('binds %s usage to the replayed input while allowing new messages and metadata', (protocol) => {
    const systemMessage = new SystemMessage('System')
    const original = new HumanMessage({ id: 'input', content: 'Read this exact content' })
    const options = { systemMessage, tools: [], protocol }
    const response = serverMessage({ id: 'response', input: 9000, output: 3, total: 9003 })
    response.additional_kwargs.anas_context_request_key = contextRequestKey({ ...options, messages: [original] })
    const tail = new HumanMessage('Continue')
    const calibrated = (messages: BaseMessage[]) => currentContextWindowTokens({ ...options, messages })
    const expected = 9000 + countMessagesApproximately([response, tail], null, { protocol })
    expect(calibrated([original, response, tail])).toBe(expected)
    const restored = new HumanMessage({ id: 'restored-id', content: original.content, additional_kwargs: { anas_run_id: 'new-run' } })
    expect(calibrated([restored, response, tail])).toBe(expected)
    for (const content of ['Read this changed content', '', 'Read this exact content plus attachment']) {
      expect(calibrated([new HumanMessage(content), response, tail])).toBeLessThan(9000)
    }
    expect(calibrated([response, tail])).toBeLessThan(9000)
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('reconstructs request-only Skill expansion for %s usage', (protocol) => {
    const input = toHumanMessage('/review\n\n<skill>\nReview carefully.\n</skill>', undefined, '/review', { id: 'skill' })
    const options = { systemMessage: new SystemMessage('System'), tools: [], protocol }
    const response = serverMessage({ id: 'response', input: 9000, output: 3, total: 9003 })
    response.additional_kwargs.anas_context_request_key = contextRequestKey({ ...options, messages: projectSkillMessages([input]) })
    expect(currentContextWindowTokens({ ...options, messages: [input, response] })).toBeGreaterThan(9000)
    expect(contextRequestKey({ ...options, messages: [input] })).toBe(response.additional_kwargs.anas_context_request_key)
  })

  it('normalizes instruction content and executable tools while preserving native tool definitions', () => {
    const lookup = tool(async () => 'result', { name: 'lookup', description: 'Search', schema: z.object({ query: z.string() }) })
    const native = { type: 'web_search', filters: { allowed_domains: ['example.com'] } }
    const first = contextRequestKey({ systemMessage: new SystemMessage({ id: 'first', content: 'Instructions' }), tools: [lookup, native] })
    const restored = contextRequestKey({
      systemMessage: new SystemMessage({ id: 'restored', content: [{ type: 'text', text: 'Instructions' }] }),
      tools: [{ filters: { allowed_domains: ['example.com'] }, type: 'web_search' }, convertToOpenAITool(lookup)]
    })
    expect(restored).toBe(first)
    expect(contextRequestKey({ systemMessage: new SystemMessage('Instructions'), tools: [lookup,
      { ...native, filters: { allowed_domains: ['other.example'] } }] })).not.toBe(first)
  })

  it('invalidates earlier provider input after recalled instructions or tools are removed', () => {
    const previousRequest = { systemMessage: new SystemMessage('Recalled memory '.repeat(400)), tools: [
      { type: 'function', function: { name: 'lookup', description: 'Search', parameters: { type: 'object', properties: {} } } }
    ] }
    const response = serverMessage({ id: 'previous', input: 9000, output: 5, total: 9005 })
    response.additional_kwargs.anas_context_request_key = contextRequestKey(previousRequest)
    const messages = [response, new HumanMessage('Continue')]
    const count = (request: typeof previousRequest) => currentContextWindowTokens({ ...request, messages })
    expect(count(previousRequest)).toBeGreaterThan(9000)
    for (const request of [{ ...previousRequest, systemMessage: new SystemMessage('Base') }, { ...previousRequest, tools: [] }]) {
      expect(count(request)).toBe(countMessagesApproximately([request.systemMessage, ...messages], request.tools))
    }
    delete response.additional_kwargs.anas_context_request_key
    expect(count(previousRequest)).toBe(countMessagesApproximately([previousRequest.systemMessage, ...messages], previousRequest.tools))
  })

  it('counts Responses instructions once in a full estimate and never again in the usage increment', () => {
    const context = { systemMessage: new SystemMessage('Base'), tools: [], protocol: 'openai_responses' as const }
    const response = serverMessage({ id: 'previous', input: 1000, output: 5, total: 1005 })
    response.additional_kwargs.anas_context_request_key = contextRequestKey(context)
    const messages = [response, new HumanMessage('Continue')]
    const options = { ...context, messages, protocol: 'openai_responses' as const, parameters: { instructions: 'i'.repeat(2000) } }
    expect(currentContextWindowTokens({ ...options }))
      .toBe(1000 + countMessagesApproximately(messages, [], { protocol: options.protocol }))
  })

  it('uses only usage produced after the currently active summary boundary', () => {
    const summary = new HumanMessage({ content: 'Condensed history', additional_kwargs: {
      lc_source: 'summarization', anas_summary_id: 'first-summary'
    } })
    const old = serverMessage({ id: 'old', input: 9000, output: 1000, total: 10000 })
    const context = { systemMessage: undefined, tools: [] }
    expect(currentContextWindowTokens({ ...context, messages: [old] })).toBeGreaterThan(9000)
    expect(currentContextWindowTokens({ ...context, messages: [summary, old] })).toBeLessThan(10000)
    const fresh = serverMessage({ id: 'fresh', input: 1500, output: 100, total: 1600 })
    fresh.additional_kwargs.anas_context_request_key = contextRequestKey({ ...context, messages: [summary, old] })
    const tail = new HumanMessage('Continue after the summarized request')
    expect(currentContextWindowTokens({ ...context, messages: [summary, old, fresh, tail] }))
      .toBe(1500 + countMessagesApproximately([fresh, tail]))
    const replaced = new HumanMessage({ content: summary.content, additional_kwargs: {
      lc_source: 'summarization', anas_summary_id: 'second-summary'
    } })
    expect(currentContextWindowTokens({ ...context, messages: [replaced, fresh, tail] })).toBeLessThan(1600)
  })

  it('adds pending images and protocol transport text to a valid provider snapshot', () => {
    const pending = new ToolMessage({ tool_call_id: 'image-call', name: 'view_image', content: [
      { type: 'text', text: 'Captured a screenshot.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }
    ] })
    const previous = serverMessage({ id: 'previous', input: 9000, output: 1000, total: 10000 })
    const encodedIncrement = countMessagesApproximately([pending], null, { protocol: 'openai_chat_completions' })
    const context = { systemMessage: undefined, tools: [],
      protocol: 'openai_chat_completions' as const }
    expect(encodedIncrement).toBeGreaterThan(1024)
    expect(currentContextWindowTokens({ ...context, messages: [previous, pending] })).toBe(9000
      + countMessagesApproximately([previous, pending], null, { protocol: context.protocol }))
    const observed = serverMessage({ id: 'observed', input: 10000 + encodedIncrement, output: 100, total: 10100 + encodedIncrement })
    observed.additional_kwargs.anas_context_request_key = contextRequestKey({ ...context, messages: [previous, pending] })
    expect(currentContextWindowTokens({ ...context, messages: [previous, pending, observed] })).toBeLessThan(1024)
  })

  it('adds only the replayed response to calibrated input instead of billed hidden reasoning', () => {
    const response = new AIMessage({ content: 'Visible answer', additional_kwargs: { anas_model_context_key: 'current', anas_context_request_key: contextRequestKey({ systemMessage: undefined, tools: [] }) },
      usage_metadata: { input_tokens: 1000, output_tokens: 8000, total_tokens: 9000,
        output_token_details: { reasoning: 7996 } } })
    const followup = new HumanMessage('Continue')
    const messages = [response, followup]
    expect(currentContextWindowTokens({ messages, systemMessage: undefined, tools: [],
      modelContextKey: 'current', protocol: 'openai_chat_completions' }))
      .toBe(1000 + countMessagesApproximately(messages, null, { protocol: 'openai_chat_completions' }))
    expect(latestServerTokenUsage(messages, 'current')?.totalTokens).toBe(9000)
  })

  it('does not reuse another model configuration usage or search past the newest response', () => {
    const old = serverMessage({ id: 'old', input: 8000, output: 1000, total: 9000 })
    old.additional_kwargs.anas_model_context_key = 'current'
    const newest = serverMessage({ id: 'new', input: 9000, output: 1000, total: 10000 })
    newest.additional_kwargs.anas_model_context_key = 'previous-parameters'
    const messages = [old, newest]
    expect(latestServerTokenUsage(messages, 'current')).toBeUndefined()
    expect(latestServerTokenUsage(messages, 'previous-parameters')?.totalTokens).toBe(10000)
    expect(currentContextWindowTokens({ messages, systemMessage: undefined, tools: [],
      modelContextKey: 'current' })).toBeLessThan(9000)
  })

  it('uses the latest response total as a snapshot instead of accumulating responses', () => {
    const usage = latestServerTokenUsage([
      serverMessage({ id: 'first', input: 80, output: 20, total: 100 }),
      new HumanMessage('Follow-up'),
      serverMessage({ id: 'second', input: 120, output: 30, total: 150 }),
      new ToolMessage({ content: 'Tool result', tool_call_id: 'call-1' })
    ])

    expect(usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150
    })
  })

  it('keeps the standard cache, reasoning, and modality details', () => {
    const usage = latestServerTokenUsage([new AIMessage({
      content: 'Answer',
    additional_kwargs: { anas_context_request_key: contextRequestKey({ systemMessage: undefined, tools: [] }) },
      usage_metadata: {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        input_token_details: {
          text: 80,
          image: 20,
          cache_read: 60,
          cache_creation: 10
        },
        output_token_details: {
          text: 20,
          reasoning: 30
        }
      }
    })])

    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      inputTokenDetails: {
        textTokens: 80,
        imageTokens: 20,
        cacheReadTokens: 60,
        cacheCreationTokens: 10
      },
      outputTokenDetails: {
        textTokens: 20,
        reasoningTokens: 30
      }
    })
  })

  it('does not reuse an older snapshot when the latest response has no usage', () => {
    expect(latestServerTokenUsage([
      serverMessage({ id: 'reported', input: 80, output: 20, total: 100 }),
      new HumanMessage('Follow-up'),
      new AIMessage({ id: 'unreported', content: 'Answer without usage' })
    ])).toBeUndefined()
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)(
    'keeps %s provider usage before a synthetic review report and counts its complete suffix', (protocol) => {
      const input = new HumanMessage('Review the captured changes.')
      const context = { systemMessage: new SystemMessage('Review instructions'), tools: [], protocol }
      const response = serverMessage({ id: 'provider-review', input: 8000, output: 50, total: 8050 })
      response.tool_calls = [{ id: 'review-call', name: 'review_report', args: { summary: 'Done' } }]
      response.additional_kwargs.anas_model_context_key = 'current'
      response.additional_kwargs.anas_context_request_key = contextRequestKey({ ...context, messages: [input] })
      const toolResult = new ToolMessage({ tool_call_id: 'review-call', content: '{"summary":"Done"}' })
      const report = new AIMessage({ content: 'The rendered review report.', additional_kwargs: {
        anas_code_review: { report: { summary: 'Done' } }
      } })
      const messages = [input, response, toolResult, report, new HumanMessage('Explain the review.')]

      expect(latestServerTokenUsageSnapshot(messages, 'current')).toEqual({
        messageIndex: 1, usage: { inputTokens: 8000, outputTokens: 50, totalTokens: 8050 }
      })
      expect(currentContextWindowTokens({ ...context, messages, modelContextKey: 'current' }))
        .toBe(8000 + countMessagesApproximately(messages.slice(1), null, { protocol }))
      expect(latestServerTokenUsage(messages, 'different-model')).toBeUndefined()
      expect(latestServerTokenUsage([...messages, new AIMessage({ content: 'An unreported provider response',
        additional_kwargs: { anas_model_context_key: 'current' } }), report], 'current')).toBeUndefined()
    }
  )

  it('rejects zero totals emitted for missing provider usage', () => {
    expect(latestServerTokenUsage([
      serverMessage({ id: 'empty', input: 0, output: 0, total: 0 })
    ])).toBeUndefined()
  })
})
