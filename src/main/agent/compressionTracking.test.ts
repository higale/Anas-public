import { AIMessage, AIMessageChunk, HumanMessage, mapStoredMessageToChatMessage } from '@langchain/core/messages'
import type { RunnableConfig } from '@langchain/core/runnables'
import { FakeListChatModel } from '@langchain/core/utils/testing'
import { END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph'
import { summaryPromptForLanguage } from '@shared/summaryPrompt'
import { describe, expect, it, vi } from 'vitest'
import {
  invokeWithCompressionTracking,
  isCompressionModelInput,
  withCompressionSummaryContext
} from './compressionTracking'
import { ModelSelectionError } from './modelSelection'
import { ModelRequestChangedError } from './modelRequestValidation'
import { countMessagesApproximately } from './localTokenCounting'

const compressionInput = [
  new HumanMessage(summaryPromptForLanguage({
    code: 'zh-CN',
    name: '简体中文'
  }).replace('{conversation}', 'Long conversation'))
]

describe('compression model tracking', () => {
  it.each(['', '   ', '\n\t', '<active_user_request>Only the current request</active_user_request>'])('rejects an empty provider summary before adding the active request', async (text) => {
    const onCompressionFailed = vi.fn(), onCompressionCompleted = vi.fn()
    await expect(withCompressionSummaryContext({ activeUserRequest: 'This request cannot replace the missing summary.' }, () =>
      invokeWithCompressionTracking(compressionInput, undefined,
        { onCompressionStart: () => 'empty', onCompressionFailed, onCompressionCompleted },
        async () => new AIMessage(text))))
      .rejects.toThrow('empty summary')
    expect(onCompressionCompleted).not.toHaveBeenCalled()
    expect(onCompressionFailed).toHaveBeenCalledWith('empty')
  })

  it('reprepares changed configuration before rejecting summary input against an obsolete budget', async () => {
    const invoke = vi.fn(async () => new AIMessage('Must not send with the old budget'))
    const changed = new ModelRequestChangedError()
    const onCompressionFailed = vi.fn()
    await expect(withCompressionSummaryContext({ inputCapacityTokens: 1 }, () => invokeWithCompressionTracking(
      compressionInput, undefined,
      { onCompressionStart: () => 'stale-budget', onCompressionFailed }, invoke,
      async () => { throw changed }
    ))).rejects.toBe(changed)
    expect(invoke).not.toHaveBeenCalled()
    expect(onCompressionFailed).toHaveBeenCalledWith('stale-budget')
  })

  it('stops when the selected model cannot fit the required summary input', async () => {
    const invoke = vi.fn(async () => new AIMessage('Must not summarize'))
    const onCompressionFailed = vi.fn()
    const onCompressionCompleted = vi.fn()
    await expect(withCompressionSummaryContext({ inputCapacityTokens: 1 }, () => invokeWithCompressionTracking(
      compressionInput, undefined,
      { onCompressionStart: () => 'summary-too-large', onCompressionFailed, onCompressionCompleted }, invoke
    ))).rejects.toBeInstanceOf(ModelSelectionError)
    expect(invoke).not.toHaveBeenCalled()
    expect(onCompressionFailed).toHaveBeenCalledWith('summary-too-large')
    expect(onCompressionCompleted).not.toHaveBeenCalled()
  })

  it('includes Responses instructions in the complete summary request capacity check', async () => {
    const invoke = vi.fn(async () => new AIMessage('Must not summarize'))
    const protocol = 'openai_responses'
    const capacity = countMessagesApproximately(compressionInput, null, { protocol }) + 10
    await expect(withCompressionSummaryContext({ inputCapacityTokens: capacity,
      tokenCountingOptions: { protocol, parameters: { instructions: 'Required summary instruction '.repeat(100) } } }, () =>
      invokeWithCompressionTracking(compressionInput, undefined, {}, invoke)))
      .rejects.toBeInstanceOf(ModelSelectionError)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('recognizes only the framework summarization model call', () => {
    expect(isCompressionModelInput(compressionInput)).toBe(true)
    expect(isCompressionModelInput([new HumanMessage(summaryPromptForLanguage({ code: 'en', name: 'English' }, true).replace('{conversation}', 'Coding task'))])).toBe(true)
    expect(isCompressionModelInput([
      new HumanMessage('Ordinary user request')
    ])).toBe(false)
    expect(isCompressionModelInput([
      new HumanMessage('System prompt'),
      compressionInput[0]
    ])).toBe(false)
  })

  it('reports the actual compression model lifecycle', async () => {
    let modelConfig: RunnableConfig | undefined
    const onCompressionStart = vi.fn(() => 'summary-1')
    const onCompressionCompleted = vi.fn()
    const onCompressionFailed = vi.fn()

    const response = await invokeWithCompressionTracking(
      compressionInput,
      { tags: ['parent-run'] },
      { onCompressionStart, onCompressionCompleted, onCompressionFailed },
      async (config) => {
        modelConfig = config
        return new AIMessage('Condensed conversation')
      }
    )

    expect(response.text).toBe('Condensed conversation')
    expect(onCompressionStart).toHaveBeenCalledOnce()
    expect(onCompressionCompleted).toHaveBeenCalledWith('summary-1', 'Condensed conversation')
    expect(onCompressionFailed).not.toHaveBeenCalled()
    expect(modelConfig?.tags).toEqual(expect.arrayContaining([
      'parent-run',
      'langsmith:hidden',
      'langsmith:nostream',
      'anas:context-summary'
    ]))
  })

  it('keeps compression output out of the LangGraph messages stream', async () => {
    const model = new FakeListChatModel({ responses: ['Hidden compression summary'] })
    const graph = new StateGraph(MessagesAnnotation)
      .addNode('compress', async () => {
        await invokeWithCompressionTracking(
          compressionInput,
          undefined,
          {},
          (config) => model.invoke(compressionInput, config)
        )
        return {}
      })
      .addEdge(START, 'compress')
      .addEdge('compress', END)
      .compile()

    const streamed: unknown[] = []
    for await (const event of await graph.stream(
      { messages: [new HumanMessage('Conversation to compress')] },
      { streamMode: 'messages' }
    )) {
      streamed.push(event)
    }

    expect(JSON.stringify(streamed)).not.toContain('Hidden compression summary')
  })

  it('deterministically carries an omitted active user request into the summary', async () => {
    const response = await withCompressionSummaryContext(
      { activeUserRequest: 'Finish the repository audit exactly as requested.' },
      () => invokeWithCompressionTracking(
        compressionInput,
        undefined,
        undefined,
        async () => new AIMessage([
          'Condensed conversation',
          '<active_user_request>',
          'stale request',
          '</active_user_request>'
        ].join('\n'))
      )
    )

    expect(response.text).toBe([
      'Condensed conversation',
      '<active_user_request>',
      'Finish the repository audit exactly as requested.',
      '</active_user_request>'
    ].join('\n\n'))
  })

  it('removes a started summary when compression fails', async () => {
    const failure = new Error('Compression provider failed.')
    const onCompressionStart = vi.fn(() => 'summary-2')
    const onCompressionCompleted = vi.fn()
    const onCompressionFailed = vi.fn()

    await expect(invokeWithCompressionTracking(
      compressionInput,
      undefined,
      { onCompressionStart, onCompressionCompleted, onCompressionFailed },
      async () => {
        throw failure
      }
    )).rejects.toBe(failure)
    expect(onCompressionCompleted).not.toHaveBeenCalled()
    expect(onCompressionFailed).toHaveBeenCalledWith('summary-2')
  })

  it.each([{ name: 'AIMessage', Message: AIMessage }, { name: 'AIMessageChunk', Message: AIMessageChunk }])('preserves standard content blocks when finalizing $name summaries', async ({ Message }) => {
    const usage = { input_tokens: 18, output_tokens: 5, total_tokens: 23 }
    const response = await withCompressionSummaryContext({ activeUserRequest: 'Continue the audit.' }, () =>
      invokeWithCompressionTracking(compressionInput, undefined, undefined, async () => new Message({
        id: 'summary', content: [{ type: 'text', text: 'Condensed context' }],
        response_metadata: { output_version: 'v1' }, usage_metadata: usage
      })))
    expect(response.text).toContain('Condensed context')
    expect(response.text).toContain('Continue the audit.')
    expect(Array.isArray(response.contentBlocks)).toBe(true)
    expect(mapStoredMessageToChatMessage(response.toDict()).text).toBe(response.text)
    expect(response.usage_metadata).toEqual(usage)
  })
})
