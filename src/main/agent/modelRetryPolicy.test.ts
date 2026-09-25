import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { HumanMessage } from '@langchain/core/messages'
import { tool } from '@langchain/core/tools'
import { z } from 'zod/v3'
import { OpenAICompatibleChatModel } from './openAiCompatibleChatModel'
import type { ResolvedModelConfig } from '@shared/types'
import { createAgent, createMiddleware, FakeToolCallingModel, modelCallLimitMiddleware, toolStrategy } from 'langchain'
import { describe, expect, it, vi } from 'vitest'
import {
  classifyModelRetryError,
  createAnasModelRetryMiddleware,
  invokeModelWithRetry
} from './modelRetryPolicy'
import { ProjectRulesError } from './projectRules'
import { isModelSelectionError, ModelSelectionError } from './modelSelection'
import { isModelRequestChangedError, ModelRequestChangedError } from './modelRequestValidation'

const runtimeLoggerMocks = vi.hoisted(() => ({ runtimeLog: vi.fn() }))

vi.mock('../runtimeLogger', () => runtimeLoggerMocks)

function httpError(status: number, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), { status })
}

describe('model retry policy', () => {
  it('only restarts preparation for configuration changes when provider retries are already owned by the adapter', async () => {
    const exhaustedProviderError = httpError(503)
    const invoke = vi.fn()
      .mockRejectedValueOnce(new ModelRequestChangedError())
      .mockRejectedValue(exhaustedProviderError)
    const onRetry = vi.fn()

    await expect(invokeModelWithRetry(invoke, {
      initialDelayMs: 0,
      retryWhen: isModelRequestChangedError,
      onRetry
    })).rejects.toBe(exhaustedProviderError)
    expect(onRetry).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: 'configuration_changed' }))
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('re-enters preparation when the framework wraps a changed-configuration error', async () => {
    const model = new FakeToolCallingModel({ toolCalls: [[], []] })
    const prepare = vi.fn()
    const onRetry = vi.fn()
    const agent = createAgent({ model, middleware: [
      createAnasModelRetryMiddleware({ initialDelayMs: 0, onRetry }),
      createMiddleware({ name: 'PrepareCurrentModel', wrapModelCall: (request, handler) => {
        prepare()
        if (prepare.mock.calls.length === 1) throw new ModelRequestChangedError()
        return handler(request)
      } })
    ] })
    await agent.invoke({ messages: [new HumanMessage('Continue')] })
    expect(prepare).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ reason: 'configuration_changed' }))
    expect(model.index).toBe(1)
  })

  it('never retries a model-selection failure wrapped by the framework with a transient cause', async () => {
    const failure = new ModelSelectionError('Model settings could not be loaded', { cause: httpError(503) })
    const prepare = vi.fn()
    const onRetry = vi.fn()
    const agent = createAgent({ model: new FakeToolCallingModel(), middleware: [
      createAnasModelRetryMiddleware({ initialDelayMs: 0, onRetry }),
      createMiddleware({ name: 'ValidateCurrentModel', wrapModelCall: () => {
        prepare()
        throw failure
      } })
    ] })
    const wrapped = await agent.invoke({ messages: [new HumanMessage('Continue')] }).catch((error: unknown) => error)
    expect(wrapped).not.toBe(failure)
    expect(wrapped).not.toBeInstanceOf(ModelSelectionError)
    expect(isModelSelectionError(wrapped)).toBe(true)
    expect(prepare).toHaveBeenCalledOnce()
    expect(onRetry).not.toHaveBeenCalled()
  })

  it.each([true, false].flatMap(streaming => [false, true].map(structured => ({ streaming, structured }))))('rejects invalid tool responses instead of completing or executing sibling calls (streaming $streaming, structured $structured)', async ({ streaming, structured }) => {
    const format = toolStrategy(z.object({}))
    let requests = 0
    const execute = vi.fn(() => 'done')
    const model = new OpenAICompatibleChatModel({
      apiKey: 'test', model: 'qwen-fixture', streaming,
      configuration: { fetch: async () => {
        requests += 1
        if (requests > 1) throw new Error('Unexpected second model request')
        const toolCalls = [
          { index: 0, type: 'function', function: { arguments: '' } },
          { index: 1, id: 'valid-call', type: 'function', function: { name: structured ? format[0].name : 'test_tool', arguments: '{}' } }
        ]
        if (!streaming) return new Response(JSON.stringify({ id: 'invalid-response', object: 'chat.completion', created: 1,
          model: 'qwen-fixture', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '好的', tool_calls: toolCalls } }] }),
          { headers: { 'content-type': 'application/json' } })
        const chunks = [
          { role: 'assistant', content: '好的' },
          { tool_calls: toolCalls }
        ].map((delta) => ({ id: 'invalid-response', object: 'chat.completion.chunk', created: 1, model: 'qwen-fixture',
          choices: [{ index: 0, delta, finish_reason: null }] }))
        return new Response([...chunks, { id: 'invalid-response', object: 'chat.completion.chunk', created: 1, model: 'qwen-fixture',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }]
          .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } })
      } }
    })
    const agent = createAgent({ model, ...(structured ? { responseFormat: format } : {}), tools: [tool(execute, { name: 'test_tool', description: 'Test', schema: z.object({}) })],
      middleware: [createAnasModelRetryMiddleware({ initialDelayMs: 0 })] })
    const invoke = async () => {
      const input = { messages: [new HumanMessage('Read the image.')] }
      if (!streaming) return agent.invoke(input)
      const stream = await agent.streamEvents(input, { version: 'v3' })
      return stream.output
    }
    await expect(invoke()).rejects.toThrow('Model returned an invalid tool call.')
    expect(execute).not.toHaveBeenCalled()
    expect(requests).toBe(1)
  })

  it('preserves successful framework structured output', async () => {
    const format = toolStrategy(z.object({ findings: z.array(z.string()) }))
    const model = new FakeToolCallingModel({ toolCalls: [[{ id: 'report', name: format[0].name, args: { findings: [] } }]] })
    const agent = createAgent({ model, responseFormat: format, middleware: [createAnasModelRetryMiddleware()] })
    const result = await agent.invoke({ messages: [new HumanMessage('Review')] })
    expect(result.structuredResponse).toEqual({ findings: [] })
  })

  it('never retries a terminal rule error even when its detail resembles a transient failure', () => {
    const error = new Error('Middleware failed', { cause: Object.assign(new ProjectRulesError('timeout while reading rules'), { status: 503 }) })
    expect(classifyModelRetryError(error)).toEqual({ retry: false })
  })
  it.each([
    [httpError(400, 'Invalid request schema'), false, undefined],
    [httpError(401, 'Authentication failed'), false, undefined],
    [httpError(404), false, undefined],
    [httpError(429, 'Exceeded your current quota'), false, undefined],
    [Object.assign(httpError(429, 'Rate limit'), { error: { code: 'insufficient_quota' } }), false, undefined],
    [httpError(501), false, undefined],
    [Object.assign(new Error('Context length exceeded'), { status: 503 }), false, undefined],
    [Object.assign(new Error('Cancelled'), { name: 'AbortError' }), false, undefined],
    [httpError(408), true, 'timeout'],
    [httpError(429, 'Rate limit exceeded'), true, 'rate_limit'],
    [httpError(503), true, 'server'],
    [Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }), true, 'network'],
    [Object.assign(new Error('request timed out'), { name: 'TimeoutError' }), true, 'timeout'],
    [new TypeError('fetch failed'), true, 'network']
  ] as const)('classifies %# without retrying deterministic failures', (error, retry, reason) => {
    expect(classifyModelRetryError(error)).toMatchObject({ retry, ...(reason ? { reason } : {}) })
  })

  it.each([400, 401, 403, 404, 413, 422])('stops rejected requests without retrying (HTTP %s)', async (status) => {
    const error = httpError(status, 'Invalid request body')
    const invoke = vi.fn().mockRejectedValue(error)

    await expect(invokeModelWithRetry(invoke, { initialDelayMs: 1 })).rejects.toMatchObject({
      name: 'ModelSelectionError',
      code: 'MODEL_SELECTION_INVALID',
      message: expect.stringContaining(`HTTP ${status}`),
      cause: error
    })
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('retries transient failures to the configured limit with exponential backoff', async () => {
    const invoke = vi.fn()
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValueOnce(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
      .mockResolvedValue('ok')
    const onRetry = vi.fn()

    await expect(invokeModelWithRetry(invoke, {
      initialDelayMs: 1,
      maxRetries: 2,
      onRetry
    })).resolves.toBe('ok')
    expect(invoke).toHaveBeenCalledTimes(3)
    expect(onRetry).toHaveBeenNthCalledWith(1, expect.objectContaining({
      attempt: 1,
      delayMs: 1,
      maxAttempts: 3,
      reason: 'server'
    }))
    expect(onRetry).toHaveBeenNthCalledWith(2, expect.objectContaining({
      attempt: 2,
      delayMs: 2,
      reason: 'network'
    }))
  })

  it('stops after the configured transient retry limit', async () => {
    const error = httpError(503)
    const invoke = vi.fn().mockRejectedValue(error)

    await expect(invokeModelWithRetry(invoke, {
      initialDelayMs: 0,
      maxRetries: 2
    })).rejects.toBe(error)
    expect(invoke).toHaveBeenCalledTimes(3)
  })

  it('does not start a provider attempt when already cancelled', async () => {
    const controller = new AbortController()
    const reason = new DOMException('Cancelled before the request.', 'AbortError')
    controller.abort(reason)
    const invoke = vi.fn()

    await expect(invokeModelWithRetry(invoke, { signal: controller.signal })).rejects.toBe(reason)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('cancels an active backoff without starting another provider attempt', async () => {
    const controller = new AbortController()
    let retryStarted!: () => void
    const retrying = new Promise<void>((resolveRetry) => {
      retryStarted = resolveRetry
    })
    const invoke = vi.fn().mockRejectedValue(httpError(503))
    const operation = invokeModelWithRetry(invoke, {
      initialDelayMs: 60_000,
      onRetry: retryStarted,
      signal: controller.signal
    })

    await retrying
    const reason = new DOMException('Cancelled by the user.', 'AbortError')
    controller.abort(reason)
    await expect(operation).rejects.toBe(reason)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('counts one logical model call while observing every provider attempt', async () => {
    let requests = 0
    const server = createServer((_request, response) => {
      requests += 1
      response.setHeader('content-type', 'application/json')
      if (requests < 3) {
        response.statusCode = 503
        response.end(JSON.stringify({
          error: { message: 'Temporary provider failure.', type: 'server_error', code: 'server_error' }
        }))
        return
      }
      response.end(JSON.stringify({
        id: 'chatcmpl-retry-test',
        object: 'chat.completion',
        created: 1,
        model: 'retry-test',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'completed' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }))
    })
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(0, '127.0.0.1', resolveListen)
    })
    const address = server.address() as AddressInfo
    const config: ResolvedModelConfig = {
      id: 'retry-test',
      displayName: '',
      providerId: 'provider-retry',
      providerName: 'Retry Test',
      protocol: 'openai_chat_completions',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: 'retry-test',
      apiKey: 'test-key',
      parameters: {},
      parameterPresetMode: 'none',
      capabilities: { vision: false, toolUse: false },
      stream: false,
      maxContextTokens: 8_192,
      maxOutputTokens: 256,
      contextCompressionThreshold: 0.8,
      contextCompressionEnabled: false
    }

    try {
      const { createChatModel } = await import('./modelFactory')
      const agent = createAgent({
        model: createChatModel(config, { requestId: 'retry-run', requestRole: 'main' }),
        tools: [],
        middleware: [
          modelCallLimitMiddleware({ runLimit: 1, exitBehavior: 'error' }),
          createAnasModelRetryMiddleware({ initialDelayMs: 0, maxRetries: 2 })
        ]
      })

      await expect(agent.invoke({ messages: [new HumanMessage('retry once logically')] }))
        .resolves.toMatchObject({ messages: expect.any(Array) })
      expect(requests).toBe(3)
      expect(runtimeLoggerMocks.runtimeLog.mock.calls.filter((call) => call[2] === 'Provider request started.'))
        .toHaveLength(3)
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose())
      })
    }
  })
})
