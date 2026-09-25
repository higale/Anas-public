import { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import { CallbackManager, type Callbacks } from '@langchain/core/callbacks/manager'
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from '@langchain/core/messages'
import { ChatGenerationChunk } from '@langchain/core/outputs'
import { FakeListChatModel } from '@langchain/core/utils/testing'
import { ChatAnthropic } from '@langchain/anthropic'
import { OpenAICompatibleChatModel } from '../main/agent/openAiCompatibleChatModel'
import { describe, expect, it, vi } from 'vitest'
import { CodingModelTraceCollector } from './codingModelTrace'
import { fingerprint } from './codingResults'

const usage = { input_tokens: 10, output_tokens: 3, total_tokens: 13 }

function nativeModel(protocol: 'anthropic' | 'openai' = 'anthropic', callbacks?: Callbacks, withUsage = true) {
  const model = protocol === 'anthropic' ? new ChatAnthropic({ apiKey: 'test-only', model: 'test', callbacks })
    : new OpenAICompatibleChatModel({ apiKey: 'test-only', model: 'test', callbacks })
  // Stub only transport generation; invocation, binding and callbacks stay native.
  vi.spyOn(protocol === 'anthropic' ? ChatAnthropic.prototype : OpenAICompatibleChatModel.prototype, '_generate').mockImplementation(async () => ({ generations: [{ text: 'done',
    message: new AIMessage({ id: 'repeated-provider-id', content: 'done', usage_metadata: withUsage ? usage : undefined })
  }] }))
  return model
}

describe('coding model trace', () => {
  it.each([
    ['array', 'anthropic'], ['manager', 'anthropic'], ['array', 'openai'], ['manager', 'openai']
  ] as const)('preserves %s callbacks through %s tool binding and configuration', async (kind, protocol) => {
    const ended = vi.fn()
    const existing = BaseCallbackHandler.fromMethods({ handleLLMEnd: ended })
    existing.awaitHandlers = true
    const callbacks = kind === 'array' ? [existing] : new CallbackManager(undefined, { handlers: [existing] })
    const trace = new CodingModelTraceCollector()
    const model = nativeModel(protocol, trace.callbacks({ requestId: 'app-run', requestRole: 'main' }, callbacks), false)
    await model.bindTools([]).withConfig({ tags: ['evaluation'] }).invoke([
      new HumanMessage({ id: 'user-1', content: 'inspect file' }),
      new AIMessage({ id: 'ai-1', content: '', tool_calls: [{ id: 'tool-1', name: 'read_file', args: { path: 'work.txt' } }] }),
      new ToolMessage({ id: 'result-1', tool_call_id: 'tool-1', content: 'file contents' })
    ])
    expect(ended).toHaveBeenCalledOnce()
    expect(trace.snapshot()).toMatchObject({ tokens: { coverage: 'unavailable', totals: null }, trace: { calls: [{
      requestId: 'app-run', role: 'main', status: 'completed', inputCount: 3,
      inputs: [
        { id: 'user-1', type: 'human', contentFingerprint: fingerprint('inspect file') },
        { id: 'ai-1', toolCalls: [{ id: 'tool-1', name: 'read_file', argsFingerprint: fingerprint({ path: 'work.txt' }) }] },
        { id: 'result-1', type: 'tool', toolResultFor: 'tool-1' }
      ]
    }] } })
    expect(JSON.stringify(trace.snapshot())).not.toContain('file contents')
  })

  it('counts native calls separately even when provider message IDs repeat', async () => {
    const collector = new CodingModelTraceCollector()
    const model = nativeModel('anthropic', collector.callbacks({ requestRole: 'compression' }))
    await model.invoke('one')
    await model.invoke('two')
    const { trace, tokens } = collector.snapshot()
    expect(new Set(trace.calls.map((call) => call.callbackRunId)).size).toBe(2)
    expect(trace.calls.map((call) => call.outputs[0].id)).toEqual(['repeated-provider-id', 'repeated-provider-id'])
    expect(tokens).toMatchObject({ coverage: 'complete', observedCalls: 2, callsWithUsage: 2,
      totals: { inputTokens: 20, outputTokens: 6, totalTokens: 26 } })
  })

  it('records a streamed response once using the merged usage', async () => {
    const collector = new CodingModelTraceCollector()
    const model = nativeModel('anthropic', collector.callbacks())
    vi.spyOn(model, '_streamResponseChunks').mockImplementation(async function* () {
      yield new ChatGenerationChunk({ text: 'first ', message: new AIMessageChunk({ id: 'streamed', content: 'first ' }) })
      yield new ChatGenerationChunk({ text: 'second', message: new AIMessageChunk({ id: 'streamed', content: 'second', usage_metadata: usage }) })
    })
    let text = ''
    for await (const chunk of await model.bindTools([]).stream('read')) text += chunk.content
    expect(text).toBe('first second')
    expect(collector.snapshot()).toMatchObject({
      tokens: { coverage: 'complete', observedCalls: 1, totals: { totalTokens: 13 } },
      trace: { calls: [{ status: 'completed', outputCount: 1,
        outputs: [{ contentFingerprint: fingerprint('first second') }] }] }
    })
  })

  it('preserves missing and failed usage as unknown and propagates the model error', async () => {
    const collector = new CodingModelTraceCollector()
    await nativeModel('anthropic', collector.callbacks()).invoke('one')
    const model = new FakeListChatModel({ responses: ['without usage'], callbacks: collector.callbacks() })
    await model.invoke('two')
    await expect(model.invoke('three', { thrownErrorString: 'provider failed' })).rejects.toThrow('provider failed')
    expect(collector.snapshot()).toMatchObject({
      tokens: { coverage: 'partial', observedCalls: 3, callsWithUsage: 1, totals: { totalTokens: 13 } },
      trace: { calls: [{ usage: { totalTokens: 13 } }, { usage: null }, { status: 'failed', error: 'provider failed', usage: null }] }
    })
  })

  it('bounds call and message evidence and never labels omitted calls as complete usage', async () => {
    const collector = new CodingModelTraceCollector({ calls: 1, messages: 1 })
    const model = nativeModel('anthropic', collector.callbacks())
    await model.invoke([new HumanMessage('first'), new HumanMessage('last')])
    await model.invoke('omitted call')
    const snapshot = collector.snapshot()
    expect(snapshot).toMatchObject({ trace: { callsTruncated: true, calls: [{ inputCount: 2, messagesTruncated: true }] },
      tokens: { coverage: 'partial', observedCalls: 1, callsWithUsage: 1 } })
    expect(snapshot.trace.calls[0].inputs).toHaveLength(1)
    expect(snapshot.trace.calls[0].inputs[0].contentFingerprint).toBe(fingerprint('last'))
    snapshot.trace.calls[0].status = 'failed'
    expect(collector.snapshot().trace.calls[0].status).toBe('completed')
  })

  it('does not report zero usage for an unobserved sample', () => {
    expect(new CodingModelTraceCollector().snapshot().tokens).toMatchObject({ coverage: 'unavailable', observedCalls: 0, totals: null })
  })
})
