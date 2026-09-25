import { defaultCapabilities, } from '@shared/agentCapabilities'
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { modelContextKey } from '@shared/modelConfig'
import type { ResolvedModelConfig } from '@shared/types'
import { createAgentContextRuntime as createAgentContextRuntimeBase } from './contextRuntime'
import { countMessagesApproximately } from './localTokenCounting'
import { contextStatusForModel } from '@shared/contextWindow'
import { ModelRequestChangedError } from './modelRequestValidation'
import { ModelSelectionError } from './modelSelection'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgentAttachmentProjector } from './agentAttachmentProjection'
import { projectToolImages } from './toolImageProjection'
import { contextRequestKey as requestKey } from './serverTokenUsage'

import { checkpointProjectRulesText } from './projectRulesMiddleware'

function contextRequestKey(options: Omit<Parameters<typeof requestKey>[0], 'messages' | 'protocol'> & Partial<Pick<Parameters<typeof requestKey>[0], 'messages' | 'protocol'>>) {
  return requestKey({ messages: [], protocol: 'openai_chat_completions', ...options })
}

const { createCompressionChatModelMock, invokeMock } = vi.hoisted(() => {
  const invoke = vi.fn()
  return {
    createCompressionChatModelMock: vi.fn((_model: ResolvedModelConfig, options: { beforeRequest?: () => Promise<void> }) => ({
      invoke: async (...args: unknown[]) => {
        await options.beforeRequest?.()
        return invoke(...args)
      }
    })),
    invokeMock: invoke
  }
})

vi.mock('./modelFactory', () => ({
  createCompressionChatModel: createCompressionChatModelMock
}))

const model: ResolvedModelConfig = {
  id: 'test',
  displayName: '',
  providerId: 'provider-test',
  providerName: 'Test',
  protocol: 'openai_chat_completions',
  baseUrl: '',
  model: 'test-model',
  parameters: {},
  parameterPresetMode: 'none',
  capabilities: { vision: true, toolUse: true },
  stream: true,
  maxContextTokens: 10_000,
  maxOutputTokens: 1_000,
  contextCompressionThreshold: 0.8,
  contextCompressionEnabled: true
}

const outputLanguage = {
  code: 'zh-CN',
  name: '简体中文'
}

function createAgentContextRuntime(
  options: Omit<Parameters<typeof createAgentContextRuntimeBase>[0], 'outputLanguage' | 'resolveModel' | 'tools' | 'systemPrompt'> & {
    model: ResolvedModelConfig
    tools: ReturnType<Parameters<typeof createAgentContextRuntimeBase>[0]['tools']>
    systemPrompt: ReturnType<Parameters<typeof createAgentContextRuntimeBase>[0]['systemPrompt']>
  }
) {
  const { model: selectedModel, tools, systemPrompt, ...rest } = options
  return createAgentContextRuntimeBase({ ...rest, resolveModel: async () => selectedModel, tools: () => tools,
    systemPrompt: () => systemPrompt, outputLanguage })
}

describe('AgentContextRuntime', () => {
  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('invalidates %s usage when attachment text changes, is truncated, or leaves the request', async (protocol) => {
    const directory = await mkdtemp(join(tmpdir(), 'anas-context-attachment-usage-'))
    try {
      const path = join(directory, 'context.txt')
      await writeFile(path, 'Original attachment '.repeat(100))
      const selected = { ...model, protocol }
      const source = new HumanMessage({ id: 'input', content: 'Read attachment' })
      const artifact = { id: 'file', threadId: 'thread', messageId: source.id!, runId: 'first', name: 'context.txt',
        mimeType: 'text/plain', size: 2000, kind: 'text' as const, path, available: true, textTruncated: false,
        contextPolicy: 'one_turn' as const, createdAt: '' }
      const projector = (currentRunId = 'first', textMaxChars = 10000) => createAgentAttachmentProjector({
        artifacts: [artifact], currentRunId, textMaxChars, textOverflow: 'truncate'
      })
      const original = projector()
      const systemMessage = new SystemMessage('System')
      const response = new AIMessage({ content: 'Read it', additional_kwargs: {
        anas_model_context_key: modelContextKey(selected), anas_context_request_key: contextRequestKey({
          protocol, systemMessage, tools: [], messages: await original.project([source], true)
        })
      }, usage_metadata: { input_tokens: 8000, output_tokens: 3, total_tokens: 8003 } })
      const messages = [source, response, new HumanMessage('Continue')]
      const status = (project: ReturnType<typeof projector>) => createAgentContextRuntime({ model: selected,
        systemPrompt: 'System', tools: [], projectMessages: items => project.project(items, true)
      }).projectedStatus({ messages })
      expect((await status(original)).currentContextTokens).toBeGreaterThan(8000)
      expect((await status(projector())).currentContextTokens).toBeGreaterThan(8000)
      for (const project of [projector('second'), projector('first', 100)]) {
        const changed = await status(project)
        expect(changed.currentContextTokens).toBe(changed.estimatedInputTokens)
      }
      await writeFile(path, 'Changed attachment')
      const changed = await status(projector())
      expect(changed.currentContextTokens).toBe(changed.estimatedInputTokens)
      expect(changed.currentContextTokens).toBeLessThan(100)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('uses the shared system projection for checkpoint estimates and manual compression budgets', async () => {
    const system = new SystemMessage('Base instructions\n\nRecalled memory ' + 'm'.repeat(400))
    const projectSystemMessage = vi.fn(async (_system: SystemMessage, _messages: BaseMessage[]) => system)
    const runtime = createAgentContextRuntime({ model, systemPrompt: 'Base instructions', tools: [], projectSystemMessage })
    const messages = [new HumanMessage('Original request'), new AIMessage('Original response')]
    const projected = await runtime.projectedStatus({ messages })
    expect(projected.estimatedInputTokens).toBe(runtime.statusFromMessages(messages, model, { systemMessage: system, tools: [] }).estimatedInputTokens)
    const compressed = await runtime.compress({ messages }, new AbortController().signal)
    expect(compressed.inputTokensBefore).toBe(projected.estimatedInputTokens)
    expect(compressed.inputTokensAfter).toBe(runtime.statusFromMessages([compressed.stateEvent.summaryMessage], model,
      { systemMessage: system, tools: [] }).estimatedInputTokens)
    for (const [, source] of projectSystemMessage.mock.calls) {
      expect(source).toEqual(messages)
    }
  })

  it('keeps the pre-summary recall query while projecting only effective attachments', async () => {
    const hidden = new HumanMessage({ id: 'hidden', content: 'Original user question now summarized' })
    const visible = new HumanMessage({ id: 'visible', content: 'Current user question' })
    const attachment = new HumanMessage({ ...visible, content: 'Current user question with attachment text' })
    const summary = new HumanMessage({ content: 'Summary', additional_kwargs: { lc_source: 'summarization' } })
    const projectSystemMessage = vi.fn(async (_system: SystemMessage, _messages: BaseMessage[]) => new SystemMessage('Recalled memory'))
    const projectMessages = vi.fn(async (messages: BaseMessage[]) => messages.map(message => message.id === 'visible' ? attachment : message))
    const runtime = createAgentContextRuntime({ model, systemPrompt: '', tools: [], projectMessages, projectSystemMessage })
    await runtime.projectedStatus({ messages: [hidden, visible], _summarizationEvent: { cutoffIndex: 1, summaryMessage: summary } })
    expect(projectMessages).toHaveBeenCalledWith([summary, visible], model)
    expect(projectSystemMessage).toHaveBeenCalledWith(expect.any(SystemMessage), [hidden, attachment])
    await runtime.projectedStatus({ messages: [hidden], _summarizationEvent: { cutoffIndex: 1, summaryMessage: summary } })
    expect(projectSystemMessage.mock.calls.at(-1)?.[1]).toEqual([hidden])
  })

  it('rejects a manual summary whose required projected system context exceeds capacity', async () => {
    const runtime = createAgentContextRuntime({ model, systemPrompt: '', tools: [],
      projectSystemMessage: async () => new SystemMessage('Required memory '.repeat(4000)) })
    await expect(runtime.compress({ messages: [new HumanMessage('Question'), new AIMessage('Answer')] },
      new AbortController().signal)).rejects.toThrow('required instructions still exceed')
  })

  it('counts Responses instructions once in status and manual compression statistics', async () => {
    const selected = { ...model, protocol: 'openai_responses' as const, parameters: { instructions: 'Persistent model instructions '.repeat(80) } }
    const runtime = createAgentContextRuntime({ model: selected, systemPrompt: 'System', tools: [] })
    const messages = [new HumanMessage('Question'), new AIMessage('Answer')]
    const status = await runtime.projectedStatus({ messages })
    const expected = countMessagesApproximately([new SystemMessage('System'), ...messages], null,
      { protocol: selected.protocol, parameters: selected.parameters })
    expect(status.estimatedInputTokens).toBe(expected)
    expect(status.currentContextTokens).toBe(expected)
    expect(Object.values(status.breakdown).reduce((sum, tokens) => sum + tokens, 0)).toBe(expected)
    const result = await runtime.compress({ messages }, new AbortController().signal)
    expect(result.inputTokensBefore).toBe(expected)
    expect(result.inputTokensAfter).toBe(countMessagesApproximately([new SystemMessage('System'), result.stateEvent.summaryMessage], null,
      { protocol: selected.protocol, parameters: selected.parameters }))
  })

  it('rejects manual summary before sending when Responses instructions consume source capacity', async () => {
    const selected = { ...model, protocol: 'openai_responses' as const, maxContextTokens: 2000, maxOutputTokens: 500,
      parameters: { instructions: 'i'.repeat(5000) } }
    const runtime = createAgentContextRuntime({ model: selected, systemPrompt: '', tools: [] })
    await expect(runtime.compress({ messages: [new HumanMessage('Small source')] }, new AbortController().signal))
      .rejects.toThrow('without dropping source context')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('restores provider usage after a summarized request has completed', async () => {
    const summary = new HumanMessage({ content: 'Condensed history', additional_kwargs: {
      lc_source: 'summarization', anas_summary_id: 'summary'
    } })
    const response = new AIMessage({ content: 'Continued with the summary', additional_kwargs: {
      anas_model_context_key: modelContextKey(model), anas_context_request_key: contextRequestKey({ messages: [summary], systemMessage: new SystemMessage(''), tools: [] })
    }, usage_metadata: { input_tokens: 1500, output_tokens: 100, total_tokens: 1600 } })
    const runtime = createAgentContextRuntime({ model, systemPrompt: '', tools: [], projectMessages: async (messages) => [...messages] })
    const values = { messages: [new HumanMessage('Old request'), new AIMessage('Old answer'), response],
      _summarizationEvent: { cutoffIndex: 2, summaryMessage: summary } }
    const expected = 1500 + countMessagesApproximately([response], null, { protocol: model.protocol })
    expect((await runtime.status(values)).currentContextTokens).toBe(expected)
    expect((await runtime.projectedStatus(values)).currentContextTokens).toBe(expected)
  })

  it('counts projected attachment files as 1024 tokens each until their messages are summarized', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'anas-context-image-tokens-'))
    try {
      const imagePath = join(directory, 'image.png')
      await writeFile(imagePath, Buffer.from('image fixture'))
      const projector = createAgentAttachmentProjector({ currentRunId: 'run', textMaxChars: 1000, textOverflow: 'truncate',
        artifacts: ['first.png', 'second.png'].map(name => ({
          id: name, threadId: 'thread', messageId: 'image-input', runId: 'run', name,
          mimeType: 'image/png', size: 13, kind: 'image' as const, path: imagePath,
          available: true, textTruncated: false, contextPolicy: 'conversation' as const, createdAt: '2026-09-24T00:00:00.000Z'
        })) })
      const runtime = createAgentContextRuntime({ model, systemPrompt: '', tools: [],
        projectMessages: (messages, selected) => projector.project(messages, selected.capabilities.vision) })
      const messages = [new HumanMessage({ id: 'image-input', content: 'Compare the two images.' })]
      const projected = await projector.project(messages, true)
      const labelsOnly = projected.map(message => new HumanMessage({
        content: Array.isArray(message.content) ? message.content.filter(block => block.type === 'text') : message.content
      }))
      const status = await runtime.projectedStatus({ messages })
      expect(status.estimatedInputTokens).toBe(countMessagesApproximately(labelsOnly) + 2048)
      expect(status.currentContextTokens).toBe(status.estimatedInputTokens)
      expect(status.breakdown.attachmentTokens).toBe(status.estimatedInputTokens - countMessagesApproximately(messages))
      expect(status.breakdown.attachmentTokens).toBeGreaterThan(2048)
      const summary = new HumanMessage({ content: 'Image comparison summary.', additional_kwargs: { lc_source: 'summarization' } })
      const summarized = await runtime.projectedStatus({ messages, _summarizationEvent: { cutoffIndex: 1, summaryMessage: summary } })
      expect(summarized.estimatedInputTokens).toBe(countMessagesApproximately([summary]))
      expect(summarized.breakdown.attachmentTokens).toBe(0)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('counts the active protocol tool-image payload and drops image tokens once only its placeholder remains', async () => {
    let selected = model
    const runtime = createAgentContextRuntimeBase({ resolveModel: async () => selected, outputLanguage,
      systemPrompt: () => '', tools: () => [] })
    const messages = [new HumanMessage('Inspect the screenshot.'), new AIMessage({ content: '', tool_calls: [
      { id: 'image-call', name: 'view_image', args: {} }
    ] }), new ToolMessage({ tool_call_id: 'image-call', name: 'view_image', content: [
      { type: 'text', text: 'Captured screenshot details.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }
    ] })]
    const chat = await runtime.status({ messages })
    expect(chat.estimatedInputTokens).toBe(countMessagesApproximately(messages, null, { protocol: 'openai_chat_completions' }))
    expect(chat.currentContextTokens).toBe(chat.estimatedInputTokens)
    expect(chat.breakdown.messageTokens).toBe(chat.estimatedInputTokens)
    expect(chat.breakdown.attachmentTokens).toBe(0)
    selected = { ...model, protocol: 'anthropic_messages' }
    const anthropic = await runtime.status({ messages })
    expect(anthropic.estimatedInputTokens).toBe(countMessagesApproximately(messages, null, { protocol: 'anthropic_messages' }))
    expect(chat.estimatedInputTokens).toBeGreaterThan(anthropic.estimatedInputTokens)
    messages.push(new AIMessage('I have inspected the screenshot.'))
    const observed = await runtime.status({ messages })
    expect(observed.estimatedInputTokens).toBe(countMessagesApproximately(projectToolImages(messages), null, { protocol: 'anthropic_messages' }))
    expect(observed.estimatedInputTokens).toBeLessThan(1024)
  })

  it('counts prepared instructions and tools without reusing that estimate for another model', () => {
    const runtime = createAgentContextRuntime({ model, systemPrompt: '', tools: [] })
    const messages = [new HumanMessage('Plan this task')]
    const request = { systemMessage: new SystemMessage('Required request instructions '.repeat(60)), tools: [
      { type: 'function', function: { name: 'write_todos', description: 'Record the task plan',
        parameters: { type: 'object', properties: { todos: { type: 'array', items: { type: 'string' } } } } } }
    ] }
    const status = runtime.statusFromMessages(messages, model, request)
    expect(status.estimatedInputTokens).toBe(countMessagesApproximately([request.systemMessage, ...messages], request.tools))
    expect(status.breakdown.toolDefinitionTokens).toBeGreaterThan(0)
    expect(status.breakdown.systemInstructionTokens).toBeGreaterThan(0)
    expect(Object.values(status.breakdown).reduce((sum, tokens) => sum + tokens, 0)).toBe(status.estimatedInputTokens)
    expect(contextStatusForModel(status, { ...model, id: 'other', model: 'other-model', baseUrl: 'https://example.test' })).toBeUndefined()
  })

  it('resolves model-specific system instructions in previews without reusing the previous model prompt', async () => {
    let current = model
    const runtime = createAgentContextRuntimeBase({ resolveModel: async () => current, outputLanguage,
      systemPrompt: (selected) => selected.id === model.id ? '' : 'New model instructions '.repeat(60), tools: () => [] })
    const before = await runtime.status({ messages: [] })
    current = { ...model, id: 'other' }
    const after = await runtime.projectedStatus({ messages: [] })
    expect(after.breakdown.systemInstructionTokens).toBeGreaterThan(before.breakdown.systemInstructionTokens)
    expect(after.estimatedInputTokens).toBe(Object.values(after.breakdown).reduce((sum, tokens) => sum + tokens, 0))
  })

  it('resolves current parameters for status and manual compression without recreating the runtime', async () => {
    let currentModel = model
    const runtime = createAgentContextRuntimeBase({
      resolveModel: async () => currentModel,
      outputLanguage,
      systemPrompt: () => '',
      tools: () => []
    })
    const messages = [new HumanMessage('Summarize this history'), new AIMessage({
      content: 'Earlier response',
      additional_kwargs: { anas_model_context_key: modelContextKey(model), anas_context_request_key: contextRequestKey({ messages: [new HumanMessage('Summarize this history')], systemMessage: new SystemMessage(''), tools: [] }) },
      usage_metadata: { input_tokens: 4000, output_tokens: 1000, total_tokens: 5000 }
    })]
    expect((await runtime.status({ messages })).currentContextTokens).toBe(4000
      + countMessagesApproximately(messages.slice(1), null, { protocol: model.protocol }))
    currentModel = { ...model, parameters: { temperature: 0.4 }, maxContextTokens: 20_000,
      maxOutputTokens: 2000, contextCompressionThreshold: 0.6 }
    const status = await runtime.projectedStatus({ messages })
    expect(status).toMatchObject({ maxContextTokens: 20_000, maxOutputTokens: 2000,
      inputCapacityTokens: 18_000, compressionThresholdTokens: 10_800 })
    expect(status.serverUsage).toBeUndefined()
    expect(status.currentContextTokens).toBeLessThan(5000)
    await runtime.compress({ messages }, new AbortController().signal)
    expect(createCompressionChatModelMock.mock.calls.at(-1)?.[0]).toEqual(currentModel)
  })

  it('surfaces a deleted selection for status and compression instead of using its earlier model', async () => {
    const resolveModel = vi.fn().mockResolvedValueOnce(model).mockRejectedValue(new Error('Selected model was deleted'))
    const runtime = createAgentContextRuntimeBase({ resolveModel, outputLanguage, systemPrompt: () => '', tools: () => [] })
    await runtime.status({})
    await expect(runtime.projectedStatus({})).rejects.toThrow('Selected model was deleted')
    await expect(runtime.compress({ messages: [new HumanMessage('Continue')] }, new AbortController().signal))
      .rejects.toThrow('Selected model was deleted')
    expect(createCompressionChatModelMock).not.toHaveBeenCalled()
  })

  it('refuses to replace history if a generated summary cannot fit the current model', async () => {
    const runtime = createAgentContextRuntime({ model: { ...model, maxContextTokens: 2000, maxOutputTokens: 1000 },
      systemPrompt: 'Required instructions', tools: [] })
    invokeMock.mockResolvedValueOnce(new AIMessage('Oversized summary '.repeat(1000)))
    await expect(runtime.compress({ messages: [new HumanMessage('Summarize')] }, new AbortController().signal))
      .rejects.toThrow('still exceed the selected model')
  })

  it.each(['selection', 'parameters', 'displayName'] as const)('reprepares manual compression after a valid %s change before sending', async (change) => {
    let currentModel = model
    let changed = false
    const projectedModels: ResolvedModelConfig[] = []
    const runtime = createAgentContextRuntimeBase({ resolveModel: async () => currentModel,
      outputLanguage, systemPrompt: () => '', tools: () => [],
      projectMessages: async (messages, selected) => {
        projectedModels.push(selected)
        if (!changed) {
          changed = true
          currentModel = change === 'selection' ? { ...model, id: 'another', model: 'another-model' }
            : change === 'parameters' ? { ...model, parameters: { temperature: 0.7 }, maxContextTokens: 20_000 }
              : { ...model, displayName: 'Renamed model' }
        }
        return messages
      }
    })
    const messages = [new HumanMessage({ id: 'source', content: 'Summarize this history' })]
    const result = await runtime.compress({ messages }, new AbortController().signal)
    expect(projectedModels[0]).toBe(model)
    expect(projectedModels[1]).toBe(currentModel)
    expect(createCompressionChatModelMock.mock.calls.at(-1)?.[0]).toEqual(currentModel)
    expect(invokeMock).toHaveBeenCalledOnce()
    expect(result.summaryText).toBe('Condensed history')
    expect(result.coveredThroughMessageId).toBe('source')
    expect(messages[0].text).toBe('Summarize this history')
  })

  it('rejects a newly insufficient manual-compression budget before sending or replacing history', async () => {
    let currentModel = model
    const messages = [new HumanMessage({ id: 'source', content: 'Required coding history '.repeat(300) })]
    const runtime = createAgentContextRuntimeBase({ resolveModel: async () => currentModel,
      outputLanguage, codingMode: true, systemPrompt: () => '', tools: () => [],
      projectMessages: async (items) => {
        currentModel = { ...model, maxContextTokens: 2000, maxOutputTokens: 1000 }
        return items
      }
    })
    await expect(runtime.compress({ messages }, new AbortController().signal)).rejects.toThrow('cannot be summarized within this model’s input capacity')
    expect(invokeMock).not.toHaveBeenCalled()
    expect(messages[0].text).toBe('Required coding history '.repeat(300))
  })

  it('uses an increased budget before rejecting projected history against the obsolete limit', async () => {
    let currentModel = { ...model, maxContextTokens: 2000, maxOutputTokens: 1000 }
    const messages = [new HumanMessage('Required coding history '.repeat(300))]
    const runtime = createAgentContextRuntimeBase({ resolveModel: async () => currentModel,
      outputLanguage, codingMode: true, systemPrompt: () => '', tools: () => [],
      projectMessages: async (items) => { currentModel = model; return items }
    })
    const result = await runtime.compress({ messages }, new AbortController().signal)
    expect(createCompressionChatModelMock.mock.calls.at(-1)?.[0]).toBe(model)
    expect(invokeMock).toHaveBeenCalledOnce()
    expect(result.summaryText).toBe('Condensed history')
  })

  it('terminates manual compression when its selected model disappears during preparation', async () => {
    let removed = false
    const runtime = createAgentContextRuntimeBase({ resolveModel: async () => {
      if (removed) throw new ModelSelectionError('Selected model was deleted')
      return model
    }, outputLanguage, systemPrompt: () => '', tools: () => [],
    projectMessages: async (messages) => { removed = true; return messages } })
    await expect(runtime.compress({ messages: [new HumanMessage('Summarize')] }, new AbortController().signal))
      .rejects.toThrow('Selected model was deleted')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('bounds repeated manual-compression preparation changes without sending stale parameters', async () => {
    let currentModel = model
    let revision = 0
    const runtime = createAgentContextRuntimeBase({ resolveModel: async () => currentModel,
      outputLanguage, systemPrompt: () => '', tools: () => [],
      projectMessages: async (messages) => {
        currentModel = { ...model, displayName: `Revision ${++revision}` }
        return messages
      }
    })
    await expect(runtime.compress({ messages: [new HumanMessage('Summarize')] }, new AbortController().signal))
      .rejects.toBeInstanceOf(ModelRequestChangedError)
    expect(revision).toBe(3)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('does not retry exhausted provider failures at the manual preparation boundary', async () => {
    const exhausted = Object.assign(new Error('Temporarily unavailable'), { status: 503 })
    invokeMock.mockRejectedValueOnce(exhausted)
    const runtime = createAgentContextRuntime({ model, systemPrompt: '', tools: [] })
    await expect(runtime.compress({ messages: [new HumanMessage('Summarize')] }, new AbortController().signal))
      .rejects.toBe(exhausted)
    expect(invokeMock).toHaveBeenCalledOnce()
  })

  it('keeps the completed in-flight manual summary when model settings change after sending', async () => {
    let currentModel = model
    invokeMock.mockImplementationOnce(async () => {
      currentModel = { ...model, parameters: { temperature: 0.7 } }
      return new AIMessage('Completed with the original request settings')
    })
    const runtime = createAgentContextRuntimeBase({ resolveModel: async () => currentModel,
      outputLanguage, systemPrompt: () => '', tools: () => [] })
    const result = await runtime.compress({ messages: [new HumanMessage('Summarize')] }, new AbortController().signal)
    expect(result.summaryText).toBe('Completed with the original request settings')
    expect(invokeMock).toHaveBeenCalledOnce()
  })

  it('projects observed images for status and manual compression while preserving pending tool transactions', async () => {
    const image = { type: 'image', source_type: 'base64', data: 'SECRET_IMAGE_BYTES', mime_type: 'image/png' }
    const old = new ToolMessage({ id: 'old-result', tool_call_id: 'old', content: [{ type: 'text', text: 'Window title' }, image] })
    const pendingCall = new AIMessage({ id: 'new-call', content: '', tool_calls: [{ id: 'new', name: 'capture', args: {} }] })
    const pending = new ToolMessage({ id: 'new-result', tool_call_id: 'new', content: [image] })
    const messages = [new HumanMessage('Inspect'), old, new AIMessage({ content: 'Saw first image', additional_kwargs: { anas_model_context_key: modelContextKey(model), anas_context_request_key: contextRequestKey({ systemMessage: new SystemMessage('System'), tools: [] }) }, usage_metadata: {
      input_tokens: 9000, output_tokens: 100, total_tokens: 9100
    } }), pendingCall, pending, new HumanMessage('Continue inspecting')]
    const runtime = createAgentContextRuntime({ model, systemPrompt: 'System', tools: [] })
    // The latest request had already omitted the older image; its snapshot is absent here.
    expect((await runtime.status({ messages })).currentContextTokens).toBeLessThan(9100)
    expect(await runtime.projectedStatus!({ messages })).toEqual((await runtime.status({ messages })))
    invokeMock.mockResolvedValueOnce(new AIMessage('First screen showed window title'))
    const compressed = await runtime.compress({ messages }, new AbortController().signal)
    expect((invokeMock.mock.calls[0][0] as HumanMessage[])[0].text).not.toContain('SECRET_IMAGE_BYTES')
    expect(compressed.cutoffIndex).toBe(3)
    expect(compressed.firstPreservedMessageId).toBe('new-call')
    expect(messages[1].content).toContain(image)
    expect(messages[4].content).toEqual([image])
  })

  it('does not summarize a pending image when there is no earlier history', async () => {
    const runtime = createAgentContextRuntime({ model, systemPrompt: '', tools: [] })
    await expect(runtime.compress({ messages: [
      new AIMessage({ content: '', tool_calls: [{ id: 'capture', name: 'capture', args: {} }] }),
      new ToolMessage({ tool_call_id: 'capture', content: [{ type: 'image', data: 'PENDING' }] })
    ] }, new AbortController().signal)).rejects.toThrow('pending tool images')
    expect(invokeMock).not.toHaveBeenCalled()
  })
  it('identifies the owning run in request and persisted context status', async () => {
    const runtime = createAgentContextRuntime({ model, systemPrompt: 'System', tools: [], requestId: 'run-2' })
    const messages = [new HumanMessage('New input')]
    expect(runtime.statusFromMessages(messages, model).runId).toBe('run-2')
    expect((await runtime.status({ messages })).runId).toBe('run-2')
    expect((await runtime.projectedStatus!({ messages })).runId).toBe('run-2')
  })

  it('reports current context including messages added after the last provider snapshot', async () => {
    const runtime = createAgentContextRuntime({ model, systemPrompt: 'System', tools: [] })
    const response = new AIMessage({ content: 'Answer', additional_kwargs: { anas_model_context_key: modelContextKey(model), anas_context_request_key: contextRequestKey({ systemMessage: new SystemMessage('System'), tools: [] }) }, usage_metadata: {
      input_tokens: 4000, output_tokens: 1000, total_tokens: 5000
    } })
    const before = (await runtime.status({ messages: [response] }))
    const after = (await runtime.status({ messages: [response, new HumanMessage('New content '.repeat(300))] }))
    expect(before.currentContextTokens).toBe(4000
      + countMessagesApproximately([response], null, { protocol: model.protocol }))
    expect(after.currentContextTokens).toBeGreaterThan(before.currentContextTokens)
    expect(after.serverUsage?.totalTokens).toBe(5000)
  })

  it('does not reuse a provider snapshot for a compressed or reprojected context', async () => {
    const response = new AIMessage({ content: 'Answer', additional_kwargs: { anas_model_context_key: modelContextKey(model), anas_context_request_key: contextRequestKey({ systemMessage: new SystemMessage('System'), tools: [] }) }, usage_metadata: {
      input_tokens: 8000, output_tokens: 1000, total_tokens: 9000
    } })
    const summary = new HumanMessage({ content: 'Short summary', additional_kwargs: { lc_source: 'summarization' } })
    const runtime = createAgentContextRuntime({ model, systemPrompt: 'System', tools: [],
      projectMessages: async (messages) => [summary, ...messages] })
    const projected = await runtime.projectedStatus!({ messages: [response] })
    expect(projected.currentContextTokens).toBeLessThan(9000)
    const compressed = (await runtime.status({ messages: [new HumanMessage('Old'), response],
      _summarizationEvent: { cutoffIndex: 1, summaryMessage: summary } }))
    expect(compressed.currentContextTokens).toBeLessThan(9000)
  })
  it('uses the selected coding template for manual compression and retains supplied continuation evidence', async () => {
    const runtime = createAgentContextRuntime({ model: { ...model, maxContextTokens: 20_000 }, codingMode: true, systemPrompt: 'Rules remain separate', tools: [] })
    const evidence = 'Goal: fix src/parser.ts. Preserve user changes in README.md. npm test failed: missing token. Build NOT RUN. Next: add regression test. Background call call-7 UNKNOWN.'
    invokeMock.mockResolvedValueOnce(new AIMessage(evidence))
    const result = await runtime.compress({ messages: [new HumanMessage('Fix parsing without changing README.md'),
      new AIMessage('Investigated parser\n' + 'log detail '.repeat(400)), new HumanMessage(evidence)] }, new AbortController().signal)
    const prompt = (invokeMock.mock.calls[0][0] as HumanMessage[])[0].text
    expect(prompt).toContain('Coding continuation handoff')
    expect(prompt).toContain('Preserve user changes in README.md')
    expect(prompt).toContain('npm test failed: missing token')
    expect(result.stateEvent.summaryMessage.text).toContain(evidence)
    expect(result.stateEvent.summaryMessage.additional_kwargs.lc_source).toBe('summarization')
  })
  it('does not silently trim the original coding goal when summary input cannot fit', async () => {
    const runtime = createAgentContextRuntime({ model: { ...model, maxContextTokens: 4096, maxOutputTokens: 1024 }, codingMode: true, systemPrompt: '', tools: [] })
    await expect(runtime.compress({ messages: [new HumanMessage('ORIGINAL_GOAL: preserve user edits'),
      new AIMessage('Long result '.repeat(4000)), new HumanMessage('Continue')] }, new AbortController().signal)).rejects.toThrow('without dropping source context')
    expect(invokeMock).not.toHaveBeenCalled()
  })
  it('starts compression before the coding request guard on small context windows', async () => {
    const smallModel = { ...model, maxContextTokens: 4096, maxOutputTokens: 1024, contextCompressionThreshold: 0.95 }
    const coding = createAgentContextRuntime({ model: smallModel, tools: [], systemPrompt: '', includeProjectRules: true })
    const ordinary = createAgentContextRuntime({ model: smallModel, tools: [], systemPrompt: '' })
    expect((await coding.status({})).compressionThresholdTokens).toBe(2816)
    expect((await ordinary.status({})).compressionThresholdTokens).toBe(2918)
  })
  it('counts projected rules only when coding mode is active, ignoring prior-mode checkpoint rules', async () => {
    const values = { messages: [], anasProjectRules: {
      documents: [{ id: 'rule', path: '/project/AGENTS.md', content: 'PROJECT RULE' }],
      directories: [{ path: '/project', documentId: 'rule' }], activeScopes: ['/project']
    } }
    const ordinary = createAgentContextRuntime({ model, tools: [], systemPrompt: 'BASE', includeProjectRules: false })
    const coding = createAgentContextRuntime({ model, tools: [], systemPrompt: 'BASE', includeProjectRules: true })
    expect((await ordinary.status(values))).toEqual((await ordinary.status({ messages: [] })))
    const delta = (await coding.status(values)).estimatedInputTokens - (await ordinary.status(values)).estimatedInputTokens
    expect(delta).toBeGreaterThan(0)
    expect((await coding.status(values)).breakdown.systemInstructionTokens - (await ordinary.status(values)).breakdown.systemInstructionTokens).toBe(delta)
    expect((await coding.status(values)).currentContextTokens - (await ordinary.status(values)).currentContextTokens).toBe(delta)
  })

  it.each([false, true])('uses matching full rule projections for usage calibration and manual statistics (memory=%s)', async (memory) => {
    const rules = { documents: [{ id: 'rule', path: '/project/AGENTS.md', content: 'PROJECT RULE' }],
      directories: [{ path: '/project', documentId: 'rule' }], activeScopes: ['/project'] }
    const projectedSystem = new SystemMessage(memory ? 'BASE\n\nRECALLED MEMORY' : 'BASE')
      .concat(`\n\n${checkpointProjectRulesText({ anasProjectRules: rules })}`)
    const response = new AIMessage({ content: 'Answer', additional_kwargs: {
      anas_model_context_key: modelContextKey(model), anas_context_request_key: contextRequestKey({ messages: [new HumanMessage('Question')], systemMessage: projectedSystem, tools: [] })
    }, usage_metadata: { input_tokens: 4000, output_tokens: 10, total_tokens: 4010 } })
    const values = { messages: [new HumanMessage('Question'), response], anasProjectRules: rules }
    const runtime = createAgentContextRuntime({ model, tools: [], systemPrompt: 'BASE', includeProjectRules: true,
      ...(memory ? { projectSystemMessage: async (system: SystemMessage) => system.concat('\n\nRECALLED MEMORY') } : {}) })
    const expected = 4000 + countMessagesApproximately([response], null, { protocol: model.protocol })
    const projected = await runtime.projectedStatus(values)
    expect(projected.currentContextTokens).toBe(expected)
    if (!memory) expect((await runtime.status(values)).currentContextTokens).toBe(expected)
    expect(projected.estimatedInputTokens).toBe(countMessagesApproximately([projectedSystem, ...values.messages]))
    const withoutRules = await runtime.projectedStatus({ messages: values.messages })
    expect(withoutRules.currentContextTokens).toBe(withoutRules.estimatedInputTokens)
    const result = await runtime.compress(values, new AbortController().signal)
    expect(result.inputTokensBefore).toBe(projected.estimatedInputTokens)
    expect(result.inputTokensAfter).toBe(countMessagesApproximately([projectedSystem, result.stateEvent.summaryMessage]))
  })
  it('counts the coding section as system instructions instead of losing its tokens', async () => {
    const content = '<coding_instruction>Inspect the project and verify edits.</coding_instruction>'
    const runtime = createAgentContextRuntime({ model, tools: [], systemPrompt: {
      text: content, sections: [{ kind: 'coding_instruction', content }]
    } })
    const status = (await runtime.status({ messages: [] }))
    expect(status.breakdown.systemInstructionTokens).toBeGreaterThan(0)
    expect(status.estimatedInputTokens).toBe(status.breakdown.systemInstructionTokens)
  })

  beforeEach(() => {
    createCompressionChatModelMock.mockClear()
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(new AIMessage('Condensed history'))
  })

  it('reports structured system sections and keeps the input total additive', async () => {
    const systemPrompt = {
      text: [
        '<profile>Assistant profile</profile>',
        'Follow the current instructions.',
        'Additional project instructions.',
        '<coding_instruction>Inspect, edit and verify.</coding_instruction>',
        '<environment>Windows</environment>',
        'Workspace: C:\\project',
        '<memory>Remember this.</memory>',
        '<skills>Search skill.</skills>'
      ].join('\n\n'),
      sections: [
        { kind: 'profile' as const, content: '<profile>Assistant profile</profile>' },
        { kind: 'system_instruction' as const, content: 'Follow the current instructions.' },
        { kind: 'project_instruction' as const, content: 'Additional project instructions.' },
        { kind: 'coding_instruction' as const, content: '<coding_instruction>Inspect, edit and verify.</coding_instruction>' },
        { kind: 'runtime_context' as const, content: '<environment>Windows</environment>' },
        {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, advancedSettings: true, prompt: '', kind: 'workspace' as const, content: 'Workspace: C:\\project' },
        { kind: 'memory' as const, content: '<memory>Remember this.</memory>' },
        { kind: 'skills' as const, content: '<skills>Search skill.</skills>' }
      ]
    }
    const runtime = createAgentContextRuntime({
      model,
      systemPrompt,
      tools: [],
      projectMessages: async (messages) => [
        ...messages,
        new HumanMessage('Projected attachment body with additional context.')
      ]
    })
    const rawStatus = (await runtime.status({
      messages: [new HumanMessage('Question')]
    }))
    const projectedStatus = await runtime.projectedStatus?.({
      messages: [new HumanMessage('Question')]
    })

    expect(rawStatus.breakdown).toMatchObject({
      profileTokens: expect.any(Number),
      systemInstructionTokens: expect.any(Number),
      runtimeContextTokens: expect.any(Number),
      workspaceTokens: expect.any(Number),
      memoryTokens: expect.any(Number),
      skillTokens: expect.any(Number),
      attachmentTokens: 0
    })
    expect(rawStatus.breakdown.profileTokens).toBeGreaterThan(0)
    expect(Object.values(rawStatus.breakdown).reduce((sum, value) => sum + value, 0))
      .toBe(rawStatus.estimatedInputTokens)
    expect(projectedStatus?.breakdown.attachmentTokens).toBeGreaterThan(0)
    expect(Object.values(projectedStatus?.breakdown ?? {}).reduce(
      (sum, value) => sum + value,
      0
    )).toBe(projectedStatus?.estimatedInputTokens)
  })

  it('reports the effective context after an existing summary', async () => {
    const runtime = createAgentContextRuntime({
      model,
      systemPrompt: 'System instructions',
      tools: []
    })
    const rawMessages = [
      new HumanMessage('Old question that is already summarized'),
      new AIMessage({
        content: 'Old answer that is already summarized',
        additional_kwargs: { anas_model_context_key: modelContextKey(model), anas_context_request_key: contextRequestKey({ systemMessage: new SystemMessage('System'), tools: [] }) }, usage_metadata: {
          input_tokens: 4_000,
          output_tokens: 1_000,
          total_tokens: 5_000
        }
      }),
      new HumanMessage('Preserved recent question')
    ]
    const withoutSummary = (await runtime.status({ messages: rawMessages }))
    const withSummary = (await runtime.status({
      messages: rawMessages,
      _summarizationEvent: {
        cutoffIndex: 3,
        summaryMessage: new HumanMessage({
          content: 'Short prior summary',
          additional_kwargs: { lc_source: 'summarization' }
        }),
        filePath: null
      }
    }))

    expect(withSummary.compressionApplied).toBe(true)
    expect(withoutSummary.serverUsage?.totalTokens).toBe(5_000)
    expect(withSummary.serverUsage).toBeUndefined()
    expect(withSummary.estimatedInputTokens).toBeLessThan(withoutSummary.estimatedInputTokens)
    expect(withSummary.inputCapacityTokens).toBe(9_000)
    expect(withSummary.compressionThresholdTokens).toBe(7_200)
    expect(withSummary.manualCompressionAvailable).toBe(false)
  })

  it('includes replayed Responses output in the message window estimate', async () => {
    const runtime = createAgentContextRuntime({
      model: { ...model, protocol: 'openai_responses' },
      systemPrompt: 'System instructions',
      tools: []
    })
    const ordinary = (await runtime.status({
      messages: [new AIMessage('Visible answer')]
    }))
    const responses = (await runtime.status({
      messages: [new AIMessage({
        content: 'Visible answer',
        response_metadata: {
          output: [{
            id: 'rs_1',
            type: 'reasoning',
            encrypted_content: 'x'.repeat(4_000),
            summary: []
          }]
        }
      })]
    }))

    expect(responses.breakdown.messageTokens)
      .toBeGreaterThan(ordinary.breakdown.messageTokens + 900)
  })

  it('exposes the latest server total separately from the local estimate', async () => {
    const runtime = createAgentContextRuntime({
      model,
      systemPrompt: 'System instructions',
      tools: []
    })
    const status = (await runtime.status({
      messages: [
        new HumanMessage('Question'),
        new AIMessage({
          content: 'Answer',
          additional_kwargs: { anas_model_context_key: modelContextKey(model), anas_context_request_key: contextRequestKey({ systemMessage: new SystemMessage('System'), tools: [] }) }, usage_metadata: {
            input_tokens: 4_000,
            output_tokens: 1_000,
            total_tokens: 5_000
          }
        })
      ]
    }))

    expect(status.serverUsage).toEqual({
      inputTokens: 4_000,
      outputTokens: 1_000,
      totalTokens: 5_000
    })
    expect(status.estimatedInputTokens).not.toBe(5_000)
  })

  it('creates a manual summary with an activation anchor at the last existing message', async () => {
    const runtime = createAgentContextRuntime({
      model: {
        ...model,
        maxContextTokens: 6_000,
        maxOutputTokens: 1_000
      },
      systemPrompt: 'System instructions',
      tools: []
    })
    const messages = [
      new HumanMessage({
        id: 'message-1',
        content: 'First detailed request with enough context to summarize safely.'
      }),
      new AIMessage({
        id: 'message-2',
        content: 'First detailed answer with decisions and implementation notes.'
      }),
      new HumanMessage({
        id: 'message-3',
        content: 'Second detailed request that should remain in recent context.'
      })
    ]

    const result = await runtime.compress(
      { messages },
      new AbortController().signal
    )

    expect(invokeMock).toHaveBeenCalledOnce()
    const promptMessages = invokeMock.mock.calls[0][0] as HumanMessage[]
    expect(invokeMock.mock.calls[0][1]).toMatchObject({
      signal: expect.any(AbortSignal),
      tags: ['langsmith:hidden', 'langsmith:nostream', 'anas:context-summary']
    })
    expect(promptMessages[0].text).toContain(
      'If it has a clear primary language, write the summary in that language.'
    )
    expect(promptMessages[0].text).toContain(
      'use the configured default language:\n简体中文 (zh-CN)'
    )
    expect(createCompressionChatModelMock)
      .toHaveBeenCalledWith(
        expect.objectContaining({ stream: true }),
        expect.objectContaining({ requestRole: 'manual-compression' })
      )
    expect(result.summaryText).toBe('Condensed history')
    expect(result.activatedAfterMessageIndex).toBe(2)
    expect(result.cutoffIndex).toBeGreaterThan(0)
    expect(result.stateEvent.summaryMessage.additional_kwargs).toMatchObject({
      lc_source: 'summarization'
    })
    expect(result.inputTokensAfter).toBeLessThan(result.inputTokensBefore)
  })

  it('compresses all current history without applying the automatic keep budget', async () => {
    const runtime = createAgentContextRuntime({
      model: {
        ...model,
        maxContextTokens: 256_000,
        maxOutputTokens: 16_000
      },
      systemPrompt: 'System instructions',
      tools: []
    })
    const messages = [
      new HumanMessage({ id: 'short-1', content: 'First question' }),
      new AIMessage({ id: 'short-2', content: 'First answer' }),
      new HumanMessage({ id: 'short-3', content: 'Latest question' }),
      new AIMessage({ id: 'short-4', content: 'Latest answer' })
    ]

    expect((await runtime.status({ messages })).manualCompressionAvailable).toBe(true)
    const result = await runtime.compress({ messages }, new AbortController().signal)

    expect(result.cutoffIndex).toBe(messages.length)
    expect(result.coveredThroughMessageId).toBe('short-4')
    expect(result.firstPreservedMessageId).toBeUndefined()
  })

  it('offers forced compression for one complete turn', async () => {
    const runtime = createAgentContextRuntime({
      model,
      systemPrompt: 'System instructions',
      tools: []
    })

    expect((await runtime.status({
      messages: [
        new HumanMessage('Only question'),
        new AIMessage('Only answer')
      ]
    })).manualCompressionAvailable).toBe(true)
  })

  it('does not recompress a summary when no new raw history exists', async () => {
    const runtime = createAgentContextRuntime({
      model,
      systemPrompt: 'System instructions',
      tools: []
    })
    const messages = [
      new HumanMessage('Already summarized question'),
      new AIMessage('Only preserved answer')
    ]

    expect((await runtime.status({
      messages,
      _summarizationEvent: {
        cutoffIndex: 2,
        summaryMessage: new HumanMessage({
          content: 'Existing summary',
          additional_kwargs: { lc_source: 'summarization' }
        }),
        filePath: null
      }
    })).manualCompressionAvailable).toBe(false)
  })

  it('rejects manual compression without trimming an oversized source message', async () => {
    const runtime = createAgentContextRuntime({
      model,
      systemPrompt: 'System instructions',
      tools: []
    })
    const messages = [
      new HumanMessage({
        id: 'oversized-source',
        content: `${'x'.repeat(40_000)}TAIL_MARKER`
      }),
      new AIMessage({
        id: 'latest-answer',
        content: 'Keep the latest answer outside the summary.'
      })
    ]

    expect((await runtime.status({ messages })).manualCompressionAvailable).toBe(true)
    await expect(runtime.compress({ messages }, new AbortController().signal)).rejects.toThrow('without dropping source context')
    expect(invokeMock).not.toHaveBeenCalled()
    expect(messages[0].text).toBe(`${'x'.repeat(40_000)}TAIL_MARKER`)
  })

  it('does not trim a 40k-token history for a 240k-token input capacity', async () => {
    const runtime = createAgentContextRuntime({
      model: {
        ...model,
        maxContextTokens: 256_000,
        maxOutputTokens: 16_000
      },
      systemPrompt: 'System instructions',
      tools: []
    })
    const messages = [
      new HumanMessage({
        id: 'large-source',
        content: `HEAD_MARKER${'x'.repeat(160_000)}TAIL_MARKER`
      }),
      new AIMessage({
        id: 'large-answer',
        content: 'Completed answer'
      })
    ]

    await runtime.compress({ messages }, new AbortController().signal)
    const promptMessages = invokeMock.mock.calls[0][0] as HumanMessage[]

    expect(promptMessages[0].text).toContain('HEAD_MARKER')
    expect(promptMessages[0].text).toContain('TAIL_MARKER')
  })

  it('maps a repeated compression cutoff back to the raw message history', async () => {
    const runtime = createAgentContextRuntime({
      model,
      systemPrompt: 'System instructions',
      tools: []
    })
    const messages = [
      new HumanMessage({ id: 'raw-1', content: 'Old question already covered by the first summary.' }),
      new AIMessage({ id: 'raw-2', content: 'Old answer already covered by the first summary.' }),
      new HumanMessage({ id: 'raw-3', content: 'Preserved question with substantial follow-up context.' }),
      new AIMessage({ id: 'raw-4', content: 'Preserved answer with implementation details and decisions.' }),
      new HumanMessage({ id: 'raw-5', content: 'Newest question that must remain available after compression.' })
    ]

    const result = await runtime.compress({
      messages,
      _summarizationEvent: {
        cutoffIndex: 2,
        summaryMessage: new HumanMessage({
          content: 'First summary',
          additional_kwargs: { lc_source: 'summarization' }
        }),
        filePath: null
      }
    }, new AbortController().signal)
    const promptMessages = invokeMock.mock.calls[0][0] as HumanMessage[]

    expect(promptMessages[0].text).toContain('First summary')
    expect(promptMessages[0].text).toContain('Preserved question')
    expect(promptMessages[0].text).not.toContain('Old question already covered')
    expect(promptMessages[0].text).not.toContain('Old answer already covered')
    expect(result.cutoffIndex).toBe(messages.length)
    expect(result.activatedAfterMessageIndex).toBe(messages.length - 1)
    expect(result.coveredThroughMessageId).toBe(messages[result.cutoffIndex - 1].id)
    expect(result.firstPreservedMessageId).toBeUndefined()
    expect(result.stateEvent.cutoffIndex).toBe(result.cutoffIndex)
  })

})
