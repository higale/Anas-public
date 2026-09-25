import { contextRequestKey as requestKey, currentContextWindowTokens as windowTokens } from './serverTokenUsage'

import type {
  BaseLanguageModelInput
} from '@langchain/core/language_models/base'
import { ContextOverflowError } from '@langchain/core/errors'
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type AIMessageChunk,
  type BaseMessage
} from '@langchain/core/messages'
import type { RunnableConfig } from '@langchain/core/runnables'
import {
  FakeListChatModel,
  type FakeListChatModelCallOptions
} from '@langchain/core/utils/testing'
import { StateBackend, type BackendRuntime } from 'deepagents'
import { countTokensApproximately, createAgent, createMiddleware, FakeToolCallingModel } from 'langchain'
import { MemorySaver } from '@langchain/langgraph'
import { describe, expect, it, vi } from 'vitest'
import {
  invokeWithCompressionTracking,
  type CompressionTrackingCallbacks
} from './compressionTracking'
import {
  createAnasSummarizationMiddleware as createAnasSummarizationMiddlewareBase,
  selectCompressionRetention
} from './summarizationMiddleware'
import { countMessagesApproximately } from './localTokenCounting'
import type { ModelProtocol, ResolvedModelConfig } from '@shared/types'
import { assertModelInputFits } from './modelRequestValidation'
import { createMemoryRecallMiddleware, createMemoryRecallProjector } from './memoryPrompt'
import type { SqliteMemoryStore } from './memoryStore'

function contextRequestKey(options: Omit<Parameters<typeof requestKey>[0], 'messages' | 'protocol'> & Partial<Pick<Parameters<typeof requestKey>[0], 'messages' | 'protocol'>>) {
  return requestKey({ messages: [], protocol: 'openai_chat_completions', ...options })
}

function currentContextWindowTokens(options: Omit<Parameters<typeof windowTokens>[0], 'protocol'> & Partial<Pick<Parameters<typeof windowTokens>[0], 'protocol'>>) {
  return windowTokens({ protocol: 'openai_chat_completions', ...options })
}

function createAnasSummarizationMiddleware(options: Omit<Parameters<typeof createAnasSummarizationMiddlewareBase>[0], 'resolveRequest'> & {
  model: ReturnType<Parameters<typeof createAnasSummarizationMiddlewareBase>[0]['resolveRequest']>['model']
  inputCapacityTokens: number
  threshold: number
  protocol?: ModelProtocol
}) {
  const { model, inputCapacityTokens, threshold, protocol = 'openai_chat_completions', ...rest } = options
  return createAnasSummarizationMiddlewareBase({ ...rest,
    resolveRequest: () => ({ model, inputCapacityTokens, threshold, protocol, enabled: true, modelContextKey: 'test-model' }) })
}

function toolTransaction(id: string, result: string) {
  return [
    new AIMessage({
      id: `${id}:request`,
      content: '',
      tool_calls: [{
        id,
        name: 'search',
        args: { query: id },
        type: 'tool_call'
      }]
    }),
    new ToolMessage({
      id: `${id}:result`,
      content: result,
      tool_call_id: id
    })
  ] as const
}

function tokens(messages: BaseMessage[]): number {
  return countMessagesApproximately(messages, null, { protocol: 'openai_chat_completions' })
}

class TrackedFakeChatModel extends FakeListChatModel {
  readonly inputs: BaseLanguageModelInput[] = []

  constructor(
    responses: string[],
    private readonly compressionTracking: CompressionTrackingCallbacks
  ) {
    super({ responses })
  }

  override invoke(
    input: BaseLanguageModelInput,
    options?: Partial<FakeListChatModelCallOptions>
  ): Promise<AIMessageChunk> {
    this.inputs.push(input)
    return invokeWithCompressionTracking(
      input,
      options,
      this.compressionTracking,
      (trackedOptions) => super.invoke(input, trackedOptions)
    )
  }
}

const outputLanguage = {
  code: 'zh-CN',
  name: '简体中文'
}

class SummaryOnlyBackend extends StateBackend {
  override downloadFiles(paths: string[]) {
    return paths.map(path => ({ path, content: null, error: 'file_not_found' as const }))
  }

  override write() { return { error: 'Conversation history offloading is disabled.' } }
}

describe('Anas summarization middleware', () => {
  it.each([false, true])('stops after selecting a smaller window without trimming summary source (coding=%s)', async (codingMode) => {
    const summary = new TrackedFakeChatModel(['No previous conversation was supplied.'], {})
    const generate = vi.spyOn(summary, '_generate')
    let selected: ResolvedModelConfig = {
      id: 'selected', displayName: '', providerId: 'provider', providerName: 'Provider',
      protocol: 'openai_chat_completions', baseUrl: '', model: 'fixture', parameters: {}, parameterPresetMode: 'none',
      capabilities: { vision: true, toolUse: true }, stream: false, maxContextTokens: 20_000, maxOutputTokens: 1000,
      contextCompressionThreshold: 0.5, contextCompressionEnabled: true
    }
    const middleware = createAnasSummarizationMiddlewareBase({ codingMode,
      backend: (runtime: BackendRuntime) => new SummaryOnlyBackend(runtime), outputLanguage,
      resolveRequest: () => ({ model: summary, protocol: selected.protocol, parameters: selected.parameters,
        modelContextKey: selected.id, inputCapacityTokens: selected.maxContextTokens - selected.maxOutputTokens, threshold: 2000, enabled: true }) })
    const send = vi.fn()
    const guard = createMiddleware({ name: 'SmallerWindowGuard', wrapModelCall: (request, handler) => {
      assertModelInputFits(selected, [request.systemMessage, ...request.messages], request.tools)
      send(request.messages)
      return handler(request)
    } })
    const graph = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[]] }), middleware: [middleware, guard], checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: `smaller-summary-window-${codingMode}` } }
    const prior = [new HumanMessage({ id: 'original', content: 'ORIGINAL_USER_CONSTRAINT' }),
      new AIMessage({ id: 'old-answer', content: 'IMPORTANT_PREVIOUS_ANSWER ' + 'd'.repeat(24_000) })]
    await graph.updateState(config, { messages: prior })
    selected = { ...selected, maxContextTokens: 5000 }
    await expect(graph.invoke({ messages: [new HumanMessage({ id: 'current', content: 'Continue' })] }, config)).rejects.toThrow('complete summary input exceeds')
    expect(generate).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    const prompt = (summary.inputs[0] as HumanMessage[])[0].text
    expect(prompt).toContain('ORIGINAL_USER_CONSTRAINT')
    expect(prompt).toContain(prior[1].text)
    const snapshot = await graph.getState(config) as { values: { messages: BaseMessage[], _summarizationEvent?: unknown } }
    expect(snapshot.values._summarizationEvent).toBeUndefined()
    expect(snapshot.values.messages.map(message => message.text)).toEqual([...prior.map(message => message.text), 'Continue'])
  })

  it('rejects an automatic summary when model instructions leave insufficient capacity for the complete source', async () => {
    const summary = new TrackedFakeChatModel(['Must not summarize'], {})
    const generate = vi.spyOn(summary, '_generate')
    const protocol = 'openai_responses'
    const parameters = { instructions: 'i'.repeat(4000) }
    const inputCapacityTokens = 1500
    const middleware = createAnasSummarizationMiddlewareBase({
      backend: (runtime: BackendRuntime) => new SummaryOnlyBackend(runtime), outputLanguage,
      resolveRequest: () => ({ model: summary, protocol, parameters, modelContextKey: 'responses',
        inputCapacityTokens, threshold: 500, enabled: true }) })
    const graph = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[]] }), middleware: [middleware], checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: 'summary-parameter-capacity' } }
    const messages = [new HumanMessage('SOURCE_' + 'q'.repeat(1200)), new AIMessage('a'.repeat(1200)), new HumanMessage('Continue')]
    await expect(graph.invoke({ messages }, config)).rejects.toThrow('complete summary input exceeds')
    expect(generate).not.toHaveBeenCalled()
    const summaryInput = summary.inputs[0] as HumanMessage[]
    expect(countMessagesApproximately(summaryInput, null, { protocol })).toBeLessThan(inputCapacityTokens - 256)
    expect(countMessagesApproximately(summaryInput, null, { protocol, parameters })).toBeGreaterThan(inputCapacityTokens - 256)
    const snapshot = await graph.getState(config) as { values: { messages: BaseMessage[], _summarizationEvent?: unknown } }
    expect(snapshot.values._summarizationEvent).toBeUndefined()
    expect(snapshot.values.messages.map(message => message.text)).toEqual(messages.map(message => message.text))
  })

  it('does not summarize when a new request no longer recalls the memory included in old usage', async () => {
    const store = { relevantMemories: vi.fn(async (query: string) => query.startsWith('alpha')
      ? [0, 1].map(id => ({ id: String(id), scope: 'project', kind: 'fact', importance: 3, content: 'm'.repeat(8000) })) : []) } as unknown as SqliteMemoryStore
    const options = { enabled: true, store, projectId: 'project' }
    const project = createMemoryRecallProjector(options)
    const old = new HumanMessage('alpha ' + 'a'.repeat(2400))
    const firstSystem = await project(new SystemMessage('Base'), [old])
    const previous = new AIMessage({ content: 'Done', usage_metadata: { input_tokens: 4700, output_tokens: 1, total_tokens: 4701 },
      additional_kwargs: { anas_model_context_key: 'test-model', anas_context_request_key: contextRequestKey({ messages: [old], systemMessage: firstSystem, tools: [] }) } })
    const current = new HumanMessage('Unrelated small question')
    const messages = [old, previous, current]
    const summary = new TrackedFakeChatModel(['Unnecessary summary'], {})
    const sent: BaseMessage[][] = []
    const capture = createMiddleware({ name: 'CaptureAfterMemoryRemoval', wrapModelCall: (request, handler) => {
      expect(request.systemMessage.text).toBe('Base')
      expect(currentContextWindowTokens({ ...request, modelContextKey: 'test-model', protocol: 'openai_chat_completions' })).toBe(610)
      sent.push(request.messages)
      return handler(request)
    } })
    const graph = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[]] }), systemPrompt: 'Base', middleware: [
      createMemoryRecallMiddleware(options, project), createAnasSummarizationMiddleware({ model: summary,
        backend: (runtime: BackendRuntime) => new SummaryOnlyBackend(runtime), inputCapacityTokens: 9000, outputLanguage, threshold: 4000 }), capture
    ] })
    await graph.invoke({ messages })
    expect(summary.inputs).toHaveLength(0)
    expect(sent[0].map(message => message.text)).toEqual(messages.map(message => message.text))
    expect(currentContextWindowTokens({ messages, systemMessage: firstSystem, tools: [],
      modelContextKey: 'test-model', protocol: 'openai_chat_completions' })).toBe(4707)
  })

  it('preserves the checkpoint history when the provider returns an empty automatic summary', async () => {
    const onCompressionCompleted = vi.fn(), onCompressionFailed = vi.fn()
    const model = new TrackedFakeChatModel(['   '], {
      onCompressionStart: () => 'empty-summary', onCompressionCompleted, onCompressionFailed
    })
    const middleware = createAnasSummarizationMiddleware({ model,
      backend: (runtime: BackendRuntime) => new StateBackend(runtime), inputCapacityTokens: 20_000, outputLanguage, threshold: 600 })
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[]] }),
      middleware: [middleware], checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: 'empty-summary' } }
    const messages = [new HumanMessage('ORIGINAL_REQUIRED_CONSTRAINT ' + 'details '.repeat(1000)),
      new AIMessage('Original answer'), new HumanMessage('Continue')]
    await expect(agent.invoke({ messages }, config)).rejects.toThrow('empty summary')
    const { values: state } = await agent.getState(config) as { values: { messages: BaseMessage[], _summarizationEvent?: unknown } }
    expect(state._summarizationEvent).toBeUndefined()
    expect(JSON.stringify(state.messages)).toContain('ORIGINAL_REQUIRED_CONSTRAINT')
    expect(onCompressionCompleted).not.toHaveBeenCalled()
    expect(onCompressionFailed).toHaveBeenCalledWith('empty-summary')
  })

  it('reports repeated compression against the effective context including request instructions', async () => {
    const completed = vi.fn()
    let count = 0
    const model = new TrackedFakeChatModel(['First summary', 'Second summary'], {
      onCompressionStart: () => `summary-${++count}`, onCompressionCompleted: completed
    })
    const middleware = createAnasSummarizationMiddleware({ model,
      backend: (runtime: BackendRuntime) => new StateBackend(runtime), inputCapacityTokens: 20_000, outputLanguage, threshold: 600 })
    const prepared: Array<{ messages: BaseMessage[], systemMessage: SystemMessage }> = []
    const capture = createMiddleware({ name: 'CapturePreparedRequest', wrapModelCall: (request, handler) => {
      prepared.push(request)
      return handler(request)
    } })
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[], []] }),
      systemPrompt: 'Required instructions '.repeat(20), middleware: [middleware, capture], checkpointer: new MemorySaver() })
    const config = { configurable: { thread_id: 'repeat-statistics' } }
    await agent.invoke({ messages: [new HumanMessage('Old source ' + 'x'.repeat(24_000)),
      new AIMessage('Old answer'), new HumanMessage('Continue first task')] }, config)
    const { values: first } = await agent.getState(config) as { values: { messages: BaseMessage[], _summarizationEvent: { cutoffIndex: number, summaryMessage: BaseMessage } } }
    const next = [new HumanMessage('Second source ' + 'y'.repeat(3000)), new AIMessage('Second source answer'), new HumanMessage('Continue again')]
    const effectiveBefore = [first._summarizationEvent.summaryMessage, ...first.messages.slice(first._summarizationEvent.cutoffIndex), ...next]
    await agent.invoke({ messages: next }, config)
    expect(completed).toHaveBeenCalledTimes(2)
    const last = prepared.at(-1)!
    expect(completed.mock.calls[1][2]).toMatchObject({
      inputTokensBefore: countMessagesApproximately([last.systemMessage, ...effectiveBefore], null, { protocol: 'openai_chat_completions' }),
      inputTokensAfter: countMessagesApproximately([last.systemMessage, ...last.messages], null, { protocol: 'openai_chat_completions' })
    })
  })

  it('recovers from the real local capacity guard and reports the compacted request', async () => {
    const selected = { id: 'test', displayName: 'Test', providerId: 'provider', providerName: 'Provider',
      protocol: 'openai_chat_completions' as const, baseUrl: 'https://example.com', model: 'test', parameters: {},
      parameterPresetMode: 'none' as const, capabilities: { vision: true, toolUse: true }, stream: false,
      maxContextTokens: 3000, maxOutputTokens: 1000, contextCompressionThreshold: 0.5, contextCompressionEnabled: true }
    const completed = vi.fn()
    const model = new TrackedFakeChatModel(['Condensed history'], { onCompressionStart: () => 'oversized-result', onCompressionCompleted: completed })
    const middleware = createAnasSummarizationMiddleware({ model,
      backend: (runtime: BackendRuntime) => new StateBackend(runtime), inputCapacityTokens: 2000, outputLanguage, threshold: 1000 })
    const sent: BaseMessage[][] = []
    const guard = createMiddleware({ name: 'ActualModelGuard', wrapModelCall: (request, handler) => {
      assertModelInputFits(selected, [request.systemMessage, ...request.messages], request.tools)
      sent.push([request.systemMessage, ...request.messages])
      return handler(request)
    } })
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[]] }), middleware: [middleware, guard] })
    const latest = toolTransaction('large-result', 'TOOL_RESULT '.repeat(2000))
    const result = await agent.invoke({ messages: [new HumanMessage('Earlier question'), new AIMessage('Earlier answer'), new HumanMessage('Do the task'), ...latest] })
    expect(AIMessage.isInstance(result.messages.at(-1))).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].at(-1)?.text).toContain('Tool result compacted')
    expect(completed.mock.calls[0][2].inputTokensAfter).toBe(countMessagesApproximately(sent[0], null, { protocol: selected.protocol }))
    expect(latest[1].text).toBe('TOOL_RESULT '.repeat(2000))
  })

  it('triggers on pending image tokens and keeps the complete parallel image batch outside the summary', async () => {
    const model = new TrackedFakeChatModel(['Earlier observations'], {})
    const pending = new AIMessage({ id: 'batch', content: '', tool_calls: [
      { id: 'first', name: 'capture', args: {} }, { id: 'second', name: 'capture', args: {} }
    ] })
    const images = ['first', 'second'].map((id) => new ToolMessage({
      id: `${id}-result`, tool_call_id: id, name: 'capture', content: [{
        type: 'image', source_type: 'base64', data: 'AA==', mime_type: 'image/png'
      }]
    }))
    const queued = new HumanMessage('Also inspect the window title')
    const messages = [new HumanMessage('Earlier request'), new AIMessage('Earlier answer'), pending, ...images, queued]
    expect(countTokensApproximately(messages)).toBeLessThan(1800)
    const middleware = createAnasSummarizationMiddleware({ model,
      backend: (runtime: BackendRuntime) => new StateBackend(runtime), inputCapacityTokens: 8000, outputLanguage, threshold: 1800 })
    const handler = vi.fn(async (request: { messages: BaseMessage[] }) => {
      expect(request.messages.slice(1)).toEqual([pending, ...images, queued])
      return new AIMessage('Images consumed')
    })
    await middleware.wrapModelCall!({ model, messages, state: { messages, files: {} },
      systemMessage: new SystemMessage('System'), tools: [], runtime: {} } as never, handler as never)
    expect(model.inputs).toHaveLength(1)
    const prompt = (model.inputs[0] as HumanMessage[])[0].text
    expect(prompt).toContain('Earlier request')
    expect(prompt).not.toContain('AA==')
    expect(prompt).not.toContain('Also inspect the window title')
    expect(handler).toHaveBeenCalledOnce()
  })

  it('includes Chat Completions tool-image transport text when choosing the compression trigger', async () => {
    const latest = toolTransaction('image', '')
    latest[1].content = [{ type: 'text', text: 'Image metadata '.repeat(80) },
      { type: 'image', source_type: 'base64', data: 'AA==', mime_type: 'image/png' }]
    const messages = [new HumanMessage('Earlier request'), new AIMessage('Earlier answer'), ...latest]
    const systemMessage = new SystemMessage('System')
    const generic = countMessagesApproximately([systemMessage, ...messages])
    const encoded = countMessagesApproximately([systemMessage, ...messages], null, { protocol: 'openai_chat_completions' })
    const threshold = Math.floor((generic + encoded) / 2)
    expect(generic).toBeLessThan(threshold)
    const model = new TrackedFakeChatModel(['Earlier observations'], {})
    const middleware = createAnasSummarizationMiddleware({ model,
      backend: (runtime: BackendRuntime) => new StateBackend(runtime), inputCapacityTokens: 8000, outputLanguage, threshold })
    await middleware.wrapModelCall!({ model, messages, state: { messages, files: {} },
      systemMessage, tools: [], runtime: {} } as never, async (request) => {
      expect(request.messages.slice(1)).toEqual([...latest])
      return new AIMessage('Image consumed')
    })
    expect(model.inputs).toHaveLength(1)
  })

  it('uses the current model and threshold when compression is enabled during the same run', async () => {
    const firstModel = new TrackedFakeChatModel(['First model summary'], {})
    const nextModel = new TrackedFakeChatModel(['Current model summary'], {})
    let current = { model: firstModel, protocol: 'openai_chat_completions' as ModelProtocol, modelContextKey: 'first', inputCapacityTokens: 8000,
      threshold: 7000, enabled: false }
    const middleware = createAnasSummarizationMiddlewareBase({
      backend: (runtime: BackendRuntime) => new StateBackend(runtime), outputLanguage,
      resolveRequest: () => current
    })
    const messages = [new HumanMessage('Old request ' + 'history '.repeat(300)),
      new AIMessage('Old answer ' + 'history '.repeat(300)), new HumanMessage('Continue')]
    const request = { model: firstModel, messages, state: { messages, files: {} },
      systemMessage: new SystemMessage('System'), tools: [], runtime: {} }
    const handler = vi.fn(async () => new AIMessage('Response'))
    await middleware.wrapModelCall!(request as never, handler as never)
    expect(firstModel.inputs).toHaveLength(0)
    current = { model: nextModel, protocol: 'openai_chat_completions', modelContextKey: 'second', inputCapacityTokens: 6000, threshold: 100, enabled: true }
    await middleware.wrapModelCall!(request as never, handler as never)
    expect(firstModel.inputs).toHaveLength(0)
    expect(nextModel.inputs).toHaveLength(1)
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('keeps the checkpoint summary projected when automatic compression is disabled', async () => {
    const model = new TrackedFakeChatModel(['Should not summarize'], {})
    const middleware = createAnasSummarizationMiddlewareBase({
      backend: (runtime: BackendRuntime) => new StateBackend(runtime), outputLanguage,
      resolveRequest: () => ({ model, protocol: 'openai_chat_completions', modelContextKey: 'model', inputCapacityTokens: 6000, threshold: 100, enabled: false })
    })
    const messages = [new HumanMessage('Old request'), new AIMessage('Old answer'), new HumanMessage('Continue')]
    const summary = new HumanMessage({ content: 'Preserved summary', additional_kwargs: { lc_source: 'summarization' } })
    const handler = vi.fn(async (request: { messages: BaseMessage[] }) => {
      expect(request.messages).toEqual([summary, messages[2]])
      return new AIMessage('Response')
    })
    await middleware.wrapModelCall!({ model, messages,
      state: { messages, files: {}, _summarizationEvent: { cutoffIndex: 2, summaryMessage: summary } },
      systemMessage: new SystemMessage('System'), tools: [], runtime: {} } as never, handler as never)
    expect(model.inputs).toHaveLength(0)
  })

  it('excludes observed image bytes from summaries and retains all pending images with queued user input', async () => {
    const old = toolTransaction('old-image', 'Old screenshot metadata')
    old[1].content = [{ type: 'text', text: 'Old screenshot metadata' }, { type: 'image', data: 'OLD_IMAGE_BYTES' }]
    const latest = toolTransaction('latest-image', 'Fresh screenshot metadata')
    latest[1].content = [{ type: 'text', text: 'Fresh screenshot metadata '.repeat(100) },
      { type: 'image', source_type: 'base64', data: 'FRESH_IMAGE_BYTES', mime_type: 'image/png' }]
    const queued = new HumanMessage('Also check the window title')
    const messages = [new HumanMessage('Inspect ' + 'old context '.repeat(300)), ...old,
      new AIMessage('Observed old screen'), ...latest, queued]
    const model = new TrackedFakeChatModel(['Condensed screen observations'], {})
    const middleware = createAnasSummarizationMiddleware({ model,
      backend: (runtime: BackendRuntime) => new StateBackend(runtime), inputCapacityTokens: 8000, outputLanguage, threshold: 200 })
    const handler = vi.fn(async (request: { messages: BaseMessage[] }) => {
      expect(request.messages.slice(-3)).toEqual([...latest, queued])
      return new AIMessage('Saw the fresh image')
    })
    await middleware.wrapModelCall?.({ model, messages, state: { messages, files: {} },
      systemMessage: new SystemMessage('System'), tools: [], runtime: {} } as never, handler as never)
    expect(handler).toHaveBeenCalledOnce()
    expect(model.inputs).toHaveLength(1)
    const summaryInput = (model.inputs[0] as HumanMessage[])[0].text
    expect(summaryInput).toContain('Old screenshot metadata')
    expect(summaryInput).not.toContain('OLD_IMAGE_BYTES')
    expect(summaryInput).not.toContain('FRESH_IMAGE_BYTES')
    expect(JSON.stringify(old[1].content)).toContain('OLD_IMAGE_BYTES')
  })

  it('does not compress just because the previous request included now-omitted images', async () => {
    const transaction = toolTransaction('capture', '')
    transaction[1].content = [{ type: 'image', data: 'LARGE_IMAGE'.repeat(1000) }]
    const messages = [new HumanMessage('Inspect'), ...transaction,
      new AIMessage({ content: 'Observed', additional_kwargs: { anas_model_context_key: 'test-model', anas_context_request_key: contextRequestKey({ systemMessage: new SystemMessage('System'), tools: [] }) }, usage_metadata: { input_tokens: 9000, output_tokens: 50, total_tokens: 9050 } })]
    const model = new TrackedFakeChatModel(['Should not summarize'], {})
    const middleware = createAnasSummarizationMiddleware({ model,
      backend: (runtime: BackendRuntime) => new StateBackend(runtime), inputCapacityTokens: 10000, outputLanguage, threshold: 200 })
    await middleware.wrapModelCall?.({ model, messages, state: { messages, files: {} },
      systemMessage: new SystemMessage('System'), tools: [], runtime: {} } as never, async (request) => {
      expect(JSON.stringify(request.messages)).not.toContain('LARGE_IMAGE')
      return new AIMessage('Continue')
    })
    expect(model.inputs).toHaveLength(0)
  })

  it('fails on image overflow without truncating image data or summarizing the pending image', async () => {
    const latest = toolTransaction('image', '')
    latest[1].content = [{ type: 'image', data: 'PENDING_IMAGE'.repeat(1000) }]
    const messages = [new HumanMessage('Old context '.repeat(100)), new AIMessage('Old answer'), ...latest]
    const model = new TrackedFakeChatModel(['Summary'], { onCompressionStart: () => 'image-overflow' })
    const middleware = createAnasSummarizationMiddleware({ model,
      backend: (runtime: BackendRuntime) => new StateBackend(runtime), inputCapacityTokens: 1000, outputLanguage, threshold: 100 })
    const handler = vi.fn(async (request: { messages: BaseMessage[] }) => {
      expect(request.messages.at(-1)?.content).toEqual(latest[1].content)
      throw new ContextOverflowError()
    })
    await expect(middleware.wrapModelCall?.({ model, messages, state: { messages, files: {} },
      systemMessage: new SystemMessage('System'), tools: [], runtime: {} } as never, handler as never)).rejects.toThrow('unit still exceeds')
    expect(handler).toHaveBeenCalledOnce()
    expect(model.inputs).toHaveLength(1)
    expect((model.inputs[0] as HumanMessage[])[0].text).not.toContain('PENDING_IMAGE')
  })
  it('passes complete coding evidence to native summarization and preserves the supplied handoff and current request', async () => {
    const evidence = 'Goal: fix parser. Preserve README user edits. Changed src/parser.ts. npm test FAILED: missing token. Build NOT RUN. Next: regression test. call-7 UNKNOWN; recheck it.'
    const onCompressionCompleted = vi.fn()
    const model = new TrackedFakeChatModel([evidence], { onCompressionStart: () => 'coding-summary', onCompressionCompleted })
    const middleware = createAnasSummarizationMiddleware({ codingMode: true, model,
      backend: (runtime: BackendRuntime) => new StateBackend(runtime), inputCapacityTokens: 12_000, outputLanguage, threshold: 100 })
    const current = new HumanMessage('Continue without changing README.md')
    const messages = [new HumanMessage('Fix parser; README.md has my changes'),
      ...toolTransaction('tests', 'npm test FAILED: missing token\n' + 'diagnostic detail '.repeat(350)),
      new AIMessage('Changed src/parser.ts. Build NOT RUN. Next: regression test. Background call call-7 is UNKNOWN.'), current]
    const handler = vi.fn(async (request: { messages: BaseMessage[] }) => {
      expect(request.messages[0].text).toContain(evidence)
      expect(request.messages.at(-1)).toBe(current)
      return new AIMessage('Continue with the regression test, not a completed build.')
    })
    await middleware.wrapModelCall?.({ model, messages, state: { messages, files: {} },
      systemMessage: new SystemMessage('Applicable rules stay separate'), tools: [], runtime: {} } as never, handler as never)
    const prompt = (model.inputs[0] as HumanMessage[])[0].text
    for (const text of ['Coding continuation handoff', 'README.md has my changes', 'npm test FAILED', 'Build NOT RUN', 'call-7 is UNKNOWN']) expect(prompt).toContain(text)
    expect(handler).toHaveBeenCalledOnce()
    expect(onCompressionCompleted).toHaveBeenCalledWith('coding-summary', evidence, expect.anything())
  })

  it('rejects an oversized coding summary at the actual model boundary without trimming old constraints or publishing a summary', async () => {
    const onCompressionFailed = vi.fn(), onCompressionCompleted = vi.fn()
    const model = new TrackedFakeChatModel(['must not be generated'], { onCompressionStart: () => 'summary', onCompressionFailed, onCompressionCompleted })
    const generate = vi.spyOn(FakeListChatModel.prototype, 'invoke')
    const middleware = createAnasSummarizationMiddleware({ codingMode: true, model,
      backend: (runtime: BackendRuntime) => new StateBackend(runtime), inputCapacityTokens: 1000, outputLanguage, threshold: 20 })
    const messages = [new HumanMessage('ORIGINAL_CONSTRAINT: preserve user data'), new AIMessage('Large log '.repeat(1000)), new HumanMessage('Continue')]
    const handler = vi.fn(async () => new AIMessage('must not run'))
    await expect(middleware.wrapModelCall?.({ model, messages, state: { messages, files: {} },
      systemMessage: new SystemMessage('Rules'), tools: [], runtime: {} } as never, handler)).rejects.toMatchObject({ code: 'MODEL_SELECTION_INVALID' })
    expect((model.inputs[0] as HumanMessage[])[0].text).toContain('ORIGINAL_CONSTRAINT')
    expect(generate).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
    expect(onCompressionCompleted).not.toHaveBeenCalled()
    expect(onCompressionFailed).toHaveBeenCalledWith('summary')
  })
  it('calibrates the earlier input and adds the actual response when no new context follows it', () => {
    const messages = [new AIMessage({
      content: 'answer',
      additional_kwargs: { anas_model_context_key: 'test-model', anas_context_request_key: contextRequestKey({ systemMessage: new SystemMessage('System'), tools: [] }) }, usage_metadata: { input_tokens: 80, output_tokens: 20, total_tokens: 100 }
    })]

    expect(currentContextWindowTokens({
      messages,
      systemMessage: new SystemMessage('System'),
      tools: [],

    })).toBe(80 + countMessagesApproximately(messages))
  })

  it('does not let old provider usage hide newly added instructions and tool schemas', () => {
    const messages = [new AIMessage({ content: 'answer', additional_kwargs: { anas_model_context_key: 'test-model', anas_context_request_key: contextRequestKey({ systemMessage: new SystemMessage('System'), tools: [] }) }, usage_metadata: { input_tokens: 80, output_tokens: 20, total_tokens: 100 } })]
    const systemMessage = new SystemMessage('New instructions '.repeat(500))
    const tools = [{ type: 'function', function: { name: 'report', description: 'New schema '.repeat(500), parameters: { type: 'object', properties: {} } } }]
    const current = currentContextWindowTokens({ messages, systemMessage, tools })
    expect(current).toBe(countMessagesApproximately([systemMessage, ...messages], tools, {}))
    expect(current).toBeGreaterThan(100)
  })

  it('adds user and tool context after a server snapshot', () => {
    const snapshot = new AIMessage({
      content: 'answer',
      additional_kwargs: { anas_model_context_key: 'test-model', anas_context_request_key: contextRequestKey({ systemMessage: new SystemMessage('System'), tools: [] }) }, usage_metadata: { input_tokens: 80, output_tokens: 20, total_tokens: 100 }
    })
    const additions = [
      new HumanMessage('follow-up ' + 'x'.repeat(400)),
      new ToolMessage({ content: 'result ' + 'y'.repeat(400), tool_call_id: 'call-1' })
    ]

    expect(currentContextWindowTokens({
      messages: [snapshot, ...additions],
      protocol: 'openai_chat_completions',
      systemMessage: new SystemMessage('System'),
      tools: [],

    })).toBe(80 + tokens([snapshot, ...additions]))
  })

  it('ignores a stale server snapshot after context reconstruction', () => {
    const messages = [new AIMessage({
      content: 'answer ' + 'x'.repeat(400),
      additional_kwargs: { anas_model_context_key: 'test-model', anas_context_request_key: contextRequestKey({ systemMessage: new SystemMessage('System'), tools: [] }) }, usage_metadata: { input_tokens: 8_000, output_tokens: 2_000, total_tokens: 10_000 }
    })]

    expect(currentContextWindowTokens({
      messages,
      systemMessage: undefined,
      tools: [],

    })).toBe(countMessagesApproximately(messages, null, {}))
  })

  it('tracks the configured summary model independently of the main model and preserves the current user turn', async () => {
    const onCompressionStart = vi.fn(() => 'summary-1')
    const onCompressionCompleted = vi.fn()
    const onCompressionFailed = vi.fn()
    const model = new TrackedFakeChatModel(
      ['Condensed history'],
      { onCompressionStart, onCompressionCompleted, onCompressionFailed }
    )
    const middleware = createAnasSummarizationMiddleware({
      model,
      backend: (runtime: BackendRuntime) => new StateBackend(runtime),
      inputCapacityTokens: 1_200,
      outputLanguage,
      threshold: 20
    })
    const currentUser = new HumanMessage('CURRENT_USER_TURN')
    const messages = [
      new HumanMessage('Old question ' + 'x'.repeat(1_000)),
      new AIMessage('Old answer ' + 'y'.repeat(1_000)),
      currentUser
    ]
    const handledMessages: unknown[][] = []
    const mainModel = new FakeListChatModel({ responses: ['Wrong main model summary'] })

    const result = await middleware.wrapModelCall?.({
      model: mainModel,
      messages,
      state: { messages, files: {} },
      systemMessage: new SystemMessage('System'),
      systemPrompt: 'System',
      tools: [],
      runtime: {}
    } as never, async (request) => {
      expect(request.model).toBe(mainModel)
      expect(onCompressionCompleted).not.toHaveBeenCalled()
      handledMessages.push(request.messages)
      return new AIMessage('Main response')
    })

    expect(onCompressionStart).toHaveBeenCalledOnce()
    expect(onCompressionCompleted).toHaveBeenCalledWith(
      'summary-1',
      'Condensed history',
      expect.objectContaining({ cutoffIndex: 2 })
    )
    expect(onCompressionFailed).not.toHaveBeenCalled()
    const summaryPromptMessage = Array.isArray(model.inputs[0])
      ? model.inputs[0][0]
      : undefined
    expect(
      HumanMessage.isInstance(summaryPromptMessage) ? summaryPromptMessage.text : ''
    ).toContain(
      'use the configured default language:\n简体中文 (zh-CN)'
    )
    expect(handledMessages).toHaveLength(1)
    expect(handledMessages[0].at(-1)).toBe(currentUser)
    expect(handledMessages[0]).toEqual([
      expect.objectContaining({
        additional_kwargs: expect.objectContaining({ lc_source: 'summarization' })
      }),
      currentUser
    ])
    expect(result).toMatchObject({
      update: {
        _summarizationEvent: {
          cutoffIndex: 2,
          summaryMessage: expect.objectContaining({
            additional_kwargs: expect.objectContaining({
              lc_source: 'summarization',
              anas_summary_id: 'summary-1'
            })
          })
        }
      }
    })
  })

  it('triggers framework summarization when replayed Responses output crosses the threshold', async () => {
    const model = new TrackedFakeChatModel(['Condensed Responses history'], {})
    const currentUser = new HumanMessage('Current question')
    const messages = [
      new HumanMessage('Earlier question'),
      new AIMessage({
        content: 'Short visible answer',
        response_metadata: {
          output: [{
            id: 'rs_large',
            type: 'reasoning',
            encrypted_content: 'x'.repeat(4_000),
            summary: []
          }]
        }
      }),
      currentUser
    ]
    const middleware = createAnasSummarizationMiddleware({
      model,
      protocol: 'openai_responses',
      backend: (runtime: BackendRuntime) => new StateBackend(runtime),
      inputCapacityTokens: 10_000,
      outputLanguage,
      threshold: 200
    })
    const handledMessages: BaseMessage[][] = []

    await middleware.wrapModelCall?.({
      model,
      messages,
      state: { messages, files: {} },
      systemMessage: new SystemMessage('System'),
      systemPrompt: 'System',
      tools: [],
      runtime: {}
    } as never, async (request) => {
      handledMessages.push(request.messages)
      return new AIMessage('Main response')
    })

    expect(model.inputs).toHaveLength(1)
    expect(handledMessages[0]).toEqual([
      expect.objectContaining({
        additional_kwargs: expect.objectContaining({ lc_source: 'summarization' })
      }),
      currentUser
    ])
  })

  it('uses the latest server total to trigger compression when local counting is lower', async () => {
    const model = new TrackedFakeChatModel(['Condensed server-sized history'], {})
    const currentUser = new HumanMessage('Current question')
    const messages = [
      new HumanMessage('Earlier question ' + 'x'.repeat(120)),
      new AIMessage({
        content: 'Earlier answer ' + 'y'.repeat(120),
        additional_kwargs: { anas_model_context_key: 'test-model', anas_context_request_key: contextRequestKey({ systemMessage: new SystemMessage('System'), tools: [] }) }, usage_metadata: {
          input_tokens: 250,
          output_tokens: 50,
          total_tokens: 300
        }
      }),
      currentUser
    ]
    messages[1].additional_kwargs.anas_context_request_key = contextRequestKey({ messages: messages.slice(0, 1), systemMessage: new SystemMessage('System'), tools: [] })
    const middleware = createAnasSummarizationMiddleware({
      model,
      backend: (runtime: BackendRuntime) => new StateBackend(runtime),
      inputCapacityTokens: 1_000,
      outputLanguage,
      threshold: 200
    })
    const handledMessages: BaseMessage[][] = []

    expect(tokens(messages)).toBeLessThan(200)
    await middleware.wrapModelCall?.({
      model,
      messages,
      state: { messages, files: {} },
      systemMessage: new SystemMessage('System'),
      systemPrompt: 'System',
      tools: [],
      runtime: {}
    } as never, async (request) => {
      handledMessages.push(request.messages)
      return new AIMessage('Main response')
    })

    expect(model.inputs).toHaveLength(1)
    expect(handledMessages[0]).toEqual([
      expect.objectContaining({
        additional_kwargs: expect.objectContaining({ lc_source: 'summarization' })
      }),
      currentUser
    ])
  })

  it('adds new user input to the latest server total without recounting old history', async () => {
    const model = new TrackedFakeChatModel(['Unused summary'], {})
    const messages = [
      new HumanMessage('Earlier question ' + 'x'.repeat(1_000)),
      new AIMessage({
        content: 'Earlier answer ' + 'y'.repeat(1_000),
        additional_kwargs: { anas_model_context_key: 'test-model', anas_context_request_key: contextRequestKey({ systemMessage: new SystemMessage('System'), tools: [] }) }, usage_metadata: {
          input_tokens: 80,
          output_tokens: 20,
          total_tokens: 100
        }
      }),
      new HumanMessage('Current question ' + 'z'.repeat(800))
    ]
    const middleware = createAnasSummarizationMiddleware({
      model,
      backend: (runtime: BackendRuntime) => new StateBackend(runtime),
      inputCapacityTokens: 1_200,
      outputLanguage,
      threshold: 200
    })
    const handledMessages: BaseMessage[][] = []

    expect(tokens(messages)).toBeGreaterThan(200)
    await middleware.wrapModelCall?.({
      model,
      messages,
      state: { messages, files: {} },
      systemMessage: new SystemMessage('System'),
      systemPrompt: 'System',
      tools: [],
      runtime: {}
    } as never, async (request) => {
      handledMessages.push(request.messages)
      return new AIMessage('Main response')
    })

    expect(model.inputs).toHaveLength(1)
    expect(handledMessages[0][0].additional_kwargs).toMatchObject({
      lc_source: 'summarization'
    })
  })

  it('carries a truncated active request into the framework summary output', async () => {
    const onCompressionCompleted = vi.fn()
    const model = new TrackedFakeChatModel(
      ['Condensed active work'],
      {
        onCompressionStart: () => 'summary-active',
        onCompressionCompleted
      }
    )
    const activeUser = new HumanMessage({
      id: 'active-user',
      content: 'Finish the active investigation without changing its scope.'
    })
    const olderTransaction = toolTransaction(
      'call-old',
      'older active result '.repeat(300)
    )
    const newestTransaction = toolTransaction(
      'call-new',
      'newest active result '.repeat(40)
    )
    const newestTokens = tokens([...newestTransaction])
    const middleware = createAnasSummarizationMiddleware({
      model,
      backend: (runtime: BackendRuntime) => new StateBackend(runtime),
      inputCapacityTokens: 10_000,
      outputLanguage,
      threshold: (newestTokens + 1) * 4
    })
    const messages = [
      new HumanMessage('Earlier question ' + 'x'.repeat(1_000)),
      new AIMessage('Earlier answer ' + 'y'.repeat(1_000)),
      activeUser,
      ...olderTransaction,
      ...newestTransaction
    ]
    const handledMessages: unknown[][] = []

    await middleware.wrapModelCall?.({
      model,
      messages,
      state: { messages, files: {} },
      systemMessage: new SystemMessage('System'),
      systemPrompt: 'System',
      tools: [],
      runtime: {}
    } as never, async (request) => {
      handledMessages.push(request.messages)
      return new AIMessage('Main response')
    })

    expect(onCompressionCompleted).toHaveBeenCalledWith(
      'summary-active',
      [
        'Condensed active work',
        '<active_user_request>',
        'Finish the active investigation without changing its scope.',
        '</active_user_request>'
      ].join('\n\n'),
      expect.objectContaining({
        cutoffIndex: messages.indexOf(newestTransaction[0]),
        firstPreservedMessageId: newestTransaction[0].id
      })
    )
    expect(handledMessages[0]).toEqual([
      expect.objectContaining({
        content: expect.stringContaining(
          'Finish the active investigation without changing its scope.'
        )
      }),
      ...newestTransaction
    ])
  })

  it('does not report a normal main-model call as compression', async () => {
    const onCompressionStart = vi.fn(() => 'summary-2')
    const model = new TrackedFakeChatModel(
      ['Normal response'],
      { onCompressionStart }
    )

    await model.invoke([
      new SystemMessage('System'),
      new HumanMessage('Ordinary request')
    ], { tags: ['root-agent'] } satisfies RunnableConfig)

    expect(onCompressionStart).not.toHaveBeenCalled()
  })

  it('cuts a large active turn only between complete tool transactions', () => {
    const activeUser = new HumanMessage({
      id: 'active-user',
      content: 'Complete the active research task.'
    })
    const first = toolTransaction('call-1', 'old result '.repeat(200))
    const newest = toolTransaction('call-2', 'latest result '.repeat(40))
    const messages = [
      new HumanMessage('Earlier question'),
      new AIMessage('Earlier answer'),
      activeUser,
      ...first,
      ...newest
    ]
    const newestTokens = tokens([...newest])
    const selection = selectCompressionRetention(
      messages,
      messages,
      (newestTokens + 1) * 4,
      'openai_chat_completions'
    )

    expect(selection.cutoffIndex).toBe(messages.indexOf(newest[0]))
    expect(messages.slice(selection.cutoffIndex)).toEqual([...newest])
    expect(selection.activeUserRequest).toBe('Complete the active research task.')
  })

  it('always preserves the newest causal unit even when it exceeds the retention limit', () => {
    const activeUser = new HumanMessage({
      id: 'active-user',
      content: 'Continue the active task.'
    })
    const older = toolTransaction('call-old', 'Older result')
    const oversizedNewest = toolTransaction(
      'call-oversized',
      'Oversized newest result '.repeat(500)
    )
    const messages = [
      new HumanMessage('Earlier question'),
      new AIMessage('Earlier answer'),
      activeUser,
      ...older,
      ...oversizedNewest
    ]
    const threshold = Math.max(400, tokens([...older]) * 4)
    expect(tokens([...oversizedNewest])).toBeGreaterThan(
      Math.floor(threshold / 4)
    )

    const selection = selectCompressionRetention(
      messages,
      messages,
      threshold,
      'openai_chat_completions'
    )

    expect(selection.cutoffIndex).toBe(messages.indexOf(oversizedNewest[0]))
    expect(messages.slice(selection.cutoffIndex)).toEqual([
      ...oversizedNewest
    ])
    expect(selection.retainedTokens).toBe(tokens([...oversizedNewest]))
    expect(selection.activeUserRequest).toBe('Continue the active task.')
  })

  it('compacts an oversized final tool result instead of dropping its causal unit', async () => {
    const onCompressionStart = vi.fn(() => 'summary-overflow')
    const onCompressionCompleted = vi.fn()
    const onCompressionFailed = vi.fn()
    const model = new TrackedFakeChatModel(
      ['Condensed history'],
      { onCompressionStart, onCompressionCompleted, onCompressionFailed }
    )
    const latest = toolTransaction(
      'call-latest',
      'Oversized latest tool result '.repeat(1_000)
    )
    const messages = [
      new HumanMessage('Old question ' + 'x'.repeat(400)),
      new AIMessage('Old answer ' + 'y'.repeat(400)),
      new HumanMessage({
        id: 'active-user',
        content: 'Continue after the latest tool result.'
      }),
      ...latest
    ]
    const middleware = createAnasSummarizationMiddleware({
      model,
      backend: (runtime: BackendRuntime) => new StateBackend(runtime),
      inputCapacityTokens: 1_000,
      outputLanguage,
      threshold: 200
    })
    const handledMessages: BaseMessage[][] = []

    const output = await middleware.wrapModelCall?.({
      model,
      messages,
      state: { messages, files: {} },
      systemMessage: new SystemMessage('System'),
      systemPrompt: 'System',
      tools: [],
      runtime: {}
    } as never, async (request) => {
      handledMessages.push(request.messages)
      if (handledMessages.length === 1) throw new ContextOverflowError()
      return new AIMessage('Recovered response')
    })

    expect(handledMessages).toHaveLength(2)
    expect(handledMessages[0].slice(-2)).toEqual([...latest])
    expect(handledMessages[1].at(-2)?.id).toBe(latest[0].id)
    expect(handledMessages[1].at(-1)?.id).toBe(latest[1].id)
    expect(handledMessages[1].at(-1)?.text).toContain(
      'Tool result compacted for model context'
    )
    expect(onCompressionStart).toHaveBeenCalledOnce()
    expect(onCompressionCompleted).toHaveBeenCalledOnce()
    expect(onCompressionFailed).not.toHaveBeenCalled()
    expect(output).toMatchObject({
      update: {
        _summarizationEvent: {
          cutoffIndex: messages.indexOf(latest[0])
        }
      }
    })
  })

  it('fails explicitly rather than dropping an oversized final user message', async () => {
    const onCompressionStart = vi.fn(() => 'summary-user-overflow')
    const onCompressionCompleted = vi.fn()
    const onCompressionFailed = vi.fn()
    const model = new TrackedFakeChatModel(
      ['Condensed history'],
      { onCompressionStart, onCompressionCompleted, onCompressionFailed }
    )
    const finalUser = new HumanMessage({
      id: 'oversized-user',
      content: 'Oversized final user input '.repeat(1_000)
    })
    const messages = [
      new HumanMessage('Old question ' + 'x'.repeat(400)),
      new AIMessage('Old answer ' + 'y'.repeat(400)),
      finalUser
    ]
    const middleware = createAnasSummarizationMiddleware({
      model,
      backend: (runtime: BackendRuntime) => new StateBackend(runtime),
      inputCapacityTokens: 1_000,
      outputLanguage,
      threshold: 200
    })
    const handledMessages: BaseMessage[][] = []

    await expect(middleware.wrapModelCall?.({
      model,
      messages,
      state: { messages, files: {} },
      systemMessage: new SystemMessage('System'),
      systemPrompt: 'System',
      tools: [],
      runtime: {}
    } as never, async (request) => {
      handledMessages.push(request.messages)
      throw new ContextOverflowError()
    })).rejects.toThrow('The latest complete conversation unit still exceeds')

    expect(handledMessages).toHaveLength(1)
    expect(handledMessages[0].at(-1)).toBe(finalUser)
    expect(onCompressionCompleted).not.toHaveBeenCalled()
    expect(onCompressionFailed).toHaveBeenCalledWith('summary-user-overflow')
  })

  it('adds only complete older turns within the remaining twenty-percent budget', () => {
    const oldest = [
      new HumanMessage({ id: 'oldest-user', content: 'Old large question' }),
      new AIMessage('large old answer '.repeat(500))
    ]
    const recent = [
      new HumanMessage({ id: 'recent-user', content: 'Recent compact question' }),
      new AIMessage('Recent compact answer')
    ]
    const current = [
      new HumanMessage({ id: 'current-user', content: 'Current question' }),
      new AIMessage('Current answer')
    ]
    const recentTokens = tokens(recent)
    const threshold = (recentTokens + 10) * 8
    const messages = [...oldest, ...recent, ...current]
    const selection = selectCompressionRetention(messages, messages, threshold, 'openai_chat_completions')

    expect(selection.cutoffIndex).toBe(oldest.length)
    expect(messages.slice(selection.cutoffIndex)).toEqual([...recent, ...current])
    expect(selection.retainedTokens).toBe(tokens([...recent, ...current]))
    expect(selection.activeUserRequest).toBeUndefined()
  })

  it('does not partially retain an older user turn that exceeds its remaining budget', () => {
    const previous = [
      new HumanMessage({ id: 'previous-user', content: 'Previous question' }),
      new AIMessage('Previous answer '.repeat(300))
    ]
    const current = [
      new HumanMessage({ id: 'current-user', content: 'Current question' }),
      new AIMessage('Current answer')
    ]
    const currentTokens = tokens(current)
    const threshold = Math.max(currentTokens * 4 + 40, 400)
    const messages = [...previous, ...current]
    const selection = selectCompressionRetention(messages, messages, threshold, 'openai_chat_completions')

    expect(selection.cutoffIndex).toBe(previous.length)
    expect(messages.slice(selection.cutoffIndex)).toEqual(current)
  })

  it('retains more than five complete older turns during an actual compression', () => {
    const olderTurns = Array.from({ length: 8 }, (_, index) => [
      new HumanMessage({
        id: `older-user-${index}`,
        content: `Question ${index}`
      }),
      new AIMessage(`Answer ${index}`)
    ]).flat()
    const current = [
      new HumanMessage({ id: 'current-user', content: 'Current question' }),
      new AIMessage('Current answer')
    ]
    const discardedPrefix = [
      new HumanMessage({ id: 'discarded-user', content: 'Discard this question' }),
      new AIMessage('Discarded answer '.repeat(8_000))
    ]
    const messages = [...discardedPrefix, ...olderTurns, ...current]
    const threshold = 8_000
    expect(tokens(messages)).toBeGreaterThan(threshold)
    expect(tokens(olderTurns)).toBeLessThanOrEqual(Math.floor(threshold / 8))
    const selection = selectCompressionRetention(messages, messages, threshold, 'openai_chat_completions')

    expect(selection.cutoffIndex).toBe(discardedPrefix.length)
    expect(messages.slice(selection.cutoffIndex)).toEqual([
      ...olderTurns,
      ...current
    ])
  })

  it('does not repeatedly summarize an unchanged previous summary', () => {
    const previousSummary = new HumanMessage({
      id: 'previous-summary',
      content: 'Here is a summary of the conversation to date.',
      additional_kwargs: { lc_source: 'summarization' }
    })
    const tail = toolTransaction('call-1', 'Current result')
    const effectiveMessages = [previousSummary, ...tail]
    const rawMessages = [
      new HumanMessage({ id: 'active-user', content: 'Active request' }),
      ...tail
    ]
    const selection = selectCompressionRetention(
      effectiveMessages,
      rawMessages,
      10_000,
      'openai_chat_completions'
    )

    expect(selection.cutoffIndex).toBe(0)
    expect(selection.retainedTokens).toBe(tokens(effectiveMessages))
  })
})
