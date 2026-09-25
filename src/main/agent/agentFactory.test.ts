import { toolPackageFixture, selectedTools } from '../../test/toolPackageFixture'
import * as toolsStore from '../toolsStore'
vi.mock('../toolsStore', async importOriginal => ({ ...await importOriginal<typeof import('../toolsStore')>(), listToolSnapshot: vi.fn(async () => ({ roots: [], tools: [] })) }))
import { customToolDefaults } from '@shared/customTools'
import { defaultCapabilitySettings } from '@shared/agentCapabilities'
import { diffViewSettingsFixture } from '../../test/diffViewSettingsFixture'
import * as subagentTools from './subagentTools'
import { environmentContextFixture } from '../../test/environmentContextFixture'
import { defaultCapabilities, capabilityFeatures, resolveSkillSelection } from '@shared/agentCapabilities'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tool } from '@langchain/core/tools'
import { z } from 'zod/v3'
import * as mcpRuntimeService from '../mcpRuntimeService'
import { canonicalAgentToolEffectJson } from './toolEffectMiddleware'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { AIMessage, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { ChatModelStream } from '@langchain/core/language_models/stream'
import { convertResponsesMessageToAIMessage } from '@langchain/openai'
import { FakeToolCallingModel } from 'langchain'
import type { createDeepAgent } from 'deepagents'
import { Command } from '@langchain/langgraph'
import { createPatch } from 'diff'
import { captureCodeReview, codeReviewPrompt } from './codeReview'
import { codeReviewResponseFormat } from './codeReviewMiddleware'
import { toAgentMessage } from './messageMapper'
import * as modelFactory from './modelFactory'
import * as gitChanges from '../gitChanges'
import * as contextRuntimeModule from './contextRuntime'
import * as summarizationModule from './summarizationMiddleware'
import { manualContextCompressionInput } from './manualCompressionMiddleware'
import type { AgentThread } from '@shared/agentTypes'
import { DEFAULT_WORKSPACE_PROJECT_ID, type AppConfigSnapshot, type ModelProviderConfigDetail, type Project, type ResolvedModelConfig } from '@shared/types'
import { resolveProviderModelConfig } from '@shared/modelConfig'
import { AgentDatabase } from './agentDatabase'
import { ManagedCallService } from './managedCallService'
import { ModelSelectionError } from './modelSelection'
import { contextRequestKey } from './serverTokenUsage'
import { countMessagesApproximately, projectModelInput } from './localTokenCounting'
import { convertOpenAICompatibleResponsesStream } from './openAiResponsesStream'
import {
  captureAgentModelRequest,
  captureAgentSystemPrompt,
  createAgentAccessModeResolver,
  createAgentInstance,
  projectAgentContextStatus,
  createPlanningMiddleware,
  createInterruptPolicy,
  prepareAgentSystemPrompt,
  shouldIncludeCommandShell,
  simpleChatHistory
} from './agentFactory'
import { buildSubagentSystemPrompt } from './subagentPrompt'
import * as skillsStore from '../skillsStore'
import { orderedToolCatalog } from '@shared/toolRegistry'
import { isCommandShellToolName } from '@shared/commandShell'

const testPaths = vi.hoisted(() => ({ root: '' }))
vi.mock('../config/dataDir', async (importOriginal) => ({
  ...await importOriginal<typeof import('../config/dataDir')>(),
  getConfigFile: (name: string) => join(testPaths.root, 'config', name),
  getSkillsDir: () => join(testPaths.root, 'skills'),
  getSystemSkillsDir: () => join(testPaths.root, 'skills_system'),
  getSkillExamplesDir: () => join(testPaths.root, 'skills_examples')
}))
beforeAll(async () => { testPaths.root = await mkdtemp(join(tmpdir(), 'anas-agent-factory-')) })
afterAll(async () => { await rm(testPaths.root, { recursive: true, force: true }) })

const projectStoreMocks = vi.hoisted(() => ({
  getProject: vi.fn()
}))
const memoryStoreMocks = vi.hoisted(() => ({
  buildMemoryRulesPrompt: vi.fn(),
  createMemoryRecallMiddleware: vi.fn()
}))
const languageStoreMocks = vi.hoisted(() => ({
  resolveConfiguredLanguage: vi.fn(async () => ({
    code: 'en',
    name: 'English',
    builtIn: true
  }))
}))
const appConfigMocks = vi.hoisted(() => ({
  getAppConfigSnapshot: vi.fn()
}))
const runtimeToolMocks = vi.hoisted(() => ({
  createRuntimeTools: vi.fn(),
  createdToolNames: vi.fn()
}))
const langchainMocks = vi.hoisted(() => ({
  modelCallLimitMiddleware: vi.fn()
}))

vi.mock('../projectStore', () => ({
  getProject: projectStoreMocks.getProject
}))
vi.mock('./memoryPrompt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./memoryPrompt')>()
  return {
    ...actual,
    buildMemoryRulesPrompt: memoryStoreMocks.buildMemoryRulesPrompt,
    createMemoryRecallMiddleware: (...args: Parameters<typeof actual.createMemoryRecallMiddleware>) => {
      const [options] = args
      memoryStoreMocks.createMemoryRecallMiddleware(options)
      return actual.createMemoryRecallMiddleware(...args)
    }
  }
})
vi.mock('../languageStore', () => ({
  resolveConfiguredLanguage: languageStoreMocks.resolveConfiguredLanguage
}))
vi.mock('../config/appConfig', async (importOriginal) => ({
  ...await importOriginal<typeof import('../config/appConfig')>(),
  getAppConfigSnapshot: appConfigMocks.getAppConfigSnapshot
}))
vi.mock('../llm/runtimeTools', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../llm/runtimeTools')>()
  return {
    ...actual,
    createRuntimeTools: async (options: Parameters<typeof actual.createRuntimeTools>[0]) => {
      runtimeToolMocks.createRuntimeTools(options)
      const tools = await actual.createRuntimeTools(options)
      runtimeToolMocks.createdToolNames(tools.map((tool) => tool.name))
      return tools
    }
  }
})
vi.mock('langchain', async (importOriginal) => {
  const actual = await importOriginal<typeof import('langchain')>()
  return {
    ...actual,
    modelCallLimitMiddleware: (...args: Parameters<typeof actual.modelCallLimitMiddleware>) => {
      langchainMocks.modelCallLimitMiddleware(...args)
      return actual.modelCallLimitMiddleware(...args)
    }
  }
})

function config(settings: Partial<AppConfigSnapshot['settings']> = {}): AppConfigSnapshot {
  return { customTools: [],
    defaultCapabilities: structuredClone(defaultCapabilitySettings),
    providers: [],
    subagents: [{
 capabilities: { ...structuredClone(defaultCapabilities), profile: false, workspace: true,
        memory: true, toolMode: 'all', tools: [], skills: { enabled: true, mode: 'default', project: false, entries: [] } },
      index: 0,
      name: 'general-purpose',
      enabled: true,
      preset: 'general-purpose',
      builtIn: true,
      description: 'Handle complex delegated tasks.',
      systemPrompt: 'Complete the delegated task.',
    }],
    mcpServers: [],
    settings: {
      profile: {
        assistant: {
          name: 'Ananas',
          role: 'AI assistant',
          instructions: 'Be clear and useful.',
          newAvatarPath: ''
        },
        user: {
          preferredName: '',
          personalInfo: ''
        }
      },
      speechReply: {
        enabled: false,
        voice: '',
        speed: 1
      },
      language: 'en',
      theme: 'dark',
      fontSize: 14,
      chatContentWidth: 'narrow',
      newThreadModelSelection: 'default',
      attachmentTextMaxChars: 1000,
      attachmentTextOverflow: 'truncate',
      logLevel: 'info',
      logRetentionDays: 14,
      maxModelCallsPerRun: 0,
      environmentContext: environmentContextFixture(),
      sidebarVisible: true,
      sidebarWidth: 260,
      workspacePanelWidth: 480, ...diffViewSettingsFixture,
      sidebarCollapsedSections: {
        projects: false,
        simpleChats: false
      },
      backupDir: '',
      ...settings
    }
  }
}

function thread(projectId = DEFAULT_WORKSPACE_PROJECT_ID): AgentThread {
  return {
    id: 'thread-1',
    title: 'Thread',
    projectId,
    pinned: false,
    accessMode: 'read_only_allowed',
    status: 'idle',
    userTurnCount: 0,
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z'
  }
}

function defaultWorkspaceProject(): Project {
  return {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '',
    id: DEFAULT_WORKSPACE_PROJECT_ID,
    name: 'Default Workspace',
    kind: 'workspace',
    pinned: false,
    collapsed: false,
    sourceFolders: ['/workspace/default'],
    createdAt: '2026-07-29T00:00:00.000Z',
    updatedAt: '2026-07-29T00:00:00.000Z'
  }
}

describe('planning capability', () => {
  it('registers write_todos only when planning is enabled', () => {
    expect(createPlanningMiddleware(true).tools?.map((tool) => tool.name))
      .toContain('write_todos')
    expect(createPlanningMiddleware(false).tools ?? []).toEqual([])
  })

  it('does not modify the system message', () => {
    const middleware = createPlanningMiddleware(true)
    expect(middleware.wrapModelCall).toBeUndefined()
  })
})

describe('runtime command shell context', () => {
  it('keeps the Windows PowerShell switch independent from command execution', () => {
    const settings = config().settings
    const features = { ...capabilityFeatures(defaultCapabilities), commandExecution: false }

    expect(shouldIncludeCommandShell('win32', settings, features)).toBe(true)

    settings.environmentContext.powerShell = false
    expect(shouldIncludeCommandShell('win32', settings, features)).toBe(false)
  })

  it('preserves the existing POSIX command execution gate', () => {
    const settings = config().settings
    const features = { ...capabilityFeatures(defaultCapabilities), commandExecution: false }

    expect(shouldIncludeCommandShell('linux', settings, features)).toBe(false)
  })
})

function previewProvider(): ModelProviderConfigDetail {
  return {
    index: 0,
    id: 'preview-provider',
    name: 'Preview model',
    protocol: 'openai_chat_completions',
    baseUrl: 'http://127.0.0.1:1',
    modelListUrl: '',
    modelListAuth: 'bearer',
    apiKey: 'test',
    parameters: {},
    models: [{
      index: 0,
      id: 'preview-model',
      displayName: '',
      model: 'preview-model',
      parameters: {},
      parameterPresetMode: 'none',
      capabilities: { vision: true, toolUse: true },
      stream: false,
      maxContextTokens: 100_000,
      maxOutputTokens: 4_000,
      contextCompressionThreshold: 0.8,
      contextCompressionEnabled: false
    }]
  }
}

function previewConfig(toolUse = true): AppConfigSnapshot {
  const base = previewProvider()
  const provider: ModelProviderConfigDetail = {
    ...base,
    models: [{
      ...base.models[0],
      capabilities: { ...base.models[0].capabilities, toolUse }
    }]
  }
  const defaultModel = resolveProviderModelConfig(provider, provider.models[0])
  return {
    ...config(),
    providers: [provider],
    defaultModelId: defaultModel.id,
    defaultModel
  }
}

function configuredThread(database: AgentDatabase, input: Parameters<AgentDatabase['createThread']>[0] = {}) {
  return database.createThread({ modelConfigId: 'preview-model', ...input })
}

class LiveSelectionTestModel extends FakeToolCallingModel {
  constructor(private readonly respond: (messages: BaseMessage[]) => AIMessage | Promise<AIMessage>) { super() }

  override bindTools() { return this }

  override async _generate(messages: BaseMessage[]) {
    const message = await this.respond(messages)
    return { generations: [{ text: message.text, message }], llmOutput: {} }
  }
}

describe('live model selection in one running graph', () => {
  beforeEach(() => {
    vi.mocked(toolsStore.listToolSnapshot).mockReset().mockResolvedValue({ roots: [], tools: [] })
    projectStoreMocks.getProject.mockReset().mockResolvedValue(defaultWorkspaceProject())
    memoryStoreMocks.buildMemoryRulesPrompt.mockReset().mockResolvedValue('')
    appConfigMocks.getAppConfigSnapshot.mockReset()
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)(
    'rejects calibrated over-capacity %s input before provider fetch', async protocol => {
      const snapshot = previewConfig()
      snapshot.providers[0].protocol = protocol
      const selected = snapshot.providers[0].models[0]
      selected.contextCompressionEnabled = true
      appConfigMocks.getAppConfigSnapshot.mockImplementation(async () => structuredClone(snapshot))
      projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), capabilities: {
        ...structuredClone(defaultCapabilities), profile: false, environment: false, workspace: false,
        planning: false, toolMode: 'selected', tools: [], subagents: false, backgroundTools: false, memory: false,
        skills: { enabled: false, mode: 'default', project: false, entries: [] }
      } })
      const bodies: Record<string, unknown>[] = []
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        const response = protocol === 'anthropic_messages'
          ? { id: 'msg_guard', type: 'message', role: 'assistant', model: 'preview-model', content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 8000, output_tokens: 1 } }
          : protocol === 'openai_responses'
            ? { id: 'resp_guard', object: 'response', created_at: 1, status: 'completed', model: 'preview-model', output: [{ type: 'message', id: 'msg_guard', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done', annotations: [] }] }], usage: { input_tokens: 8000, output_tokens: 1, total_tokens: 8001 } }
            : { id: 'chat_guard', object: 'chat.completion', created: 1, model: 'preview-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Done' } }], usage: { prompt_tokens: 8000, completion_tokens: 1, total_tokens: 8001 } }
        return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } })
      })
      const database = AgentDatabase.open(':memory:')
      const target = configuredThread(database)
      const onContextStatus = vi.fn()
      const instance = await createAgentInstance(target, database, { prepareWorkspace: false, onContextStatus })
      try {
        const graphConfig = { configurable: { thread_id: target.id } }
        await instance.agent.invoke({ messages: [new HumanMessage('分析：' + '中'.repeat(6000))] }, graphConfig)
        expect(bodies).toHaveLength(1)
        selected.maxContextTokens = 10000
        selected.contextCompressionEnabled = false
        const values = (await database.checkpointer.getTuple(graphConfig))!.checkpoint.channel_values
        const preview = await projectAgentContextStatus(target, database, values)
        expect(preview.currentContextTokens).toBeGreaterThan(8000)
        expect(preview.inputCapacityTokens).toBe(6000)
        expect(preview.estimatedInputTokens).toBeLessThan(6000)
        await expect(instance.agent.invoke({ messages: [new HumanMessage('Continue')] }, graphConfig)).rejects.toThrow('required context does not fit')
        expect(bodies).toHaveLength(1)
        const secondStatus = onContextStatus.mock.lastCall![0]
        expect(secondStatus.currentContextTokens).toBeGreaterThan(8000)
        expect(secondStatus.inputCapacityTokens).toBe(6000)
      } finally { await instance.dispose(); fetchSpy.mockRestore(); database.close() }
    }
  )

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'].flatMap(protocol =>
    [false, true].map(summarized => ({ protocol: protocol as ResolvedModelConfig['protocol'], summarized }))))(
    'projects moved simple-chat history before counting or sending ($protocol/summary=$summarized)', async ({ protocol, summarized }) => {
      const snapshot = previewConfig()
      snapshot.providers[0].protocol = protocol
      appConfigMocks.getAppConfigSnapshot.mockImplementation(async () => structuredClone(snapshot))
      const simple: Project = { id: 'plain-chat', name: 'Plain chat', kind: 'simple_chat', pinned: false,
        collapsed: false, prompt: 'Plain system', createdAt: '', updatedAt: '' }
      projectStoreMocks.getProject.mockImplementation(async id => id === simple.id ? simple : defaultWorkspaceProject())
      const database = AgentDatabase.open(':memory:')
      const original = configuredThread(database)
      const target = database.updateThread(original.id, { projectId: simple.id })
      const history = [new HumanMessage({ id: 'old-user', content: 'Inspect with detailed Skill instructions',
        additional_kwargs: { anas_display_text: '/inspect visible request' } }),
        new AIMessage({ id: 'old-call', content: 'Reading', tool_calls: [{ id: 'read-call', name: 'read_file', args: { path: 'file.txt' } }] }),
        new ToolMessage({ id: 'old-tool', tool_call_id: 'read-call', content: 'Large tool output '.repeat(1000) }),
        new AIMessage({ id: 'old-answer', content: 'Inspected' })]
      const summary = new HumanMessage({ id: 'summary', content: 'Previous inspection', additional_kwargs: { lc_source: 'summarization' } })
      const event = summarized ? { _summarizationEvent: { cutoffIndex: history.length, summaryMessage: summary, filePath: null } } : {}
      const current = new HumanMessage({ id: 'current', content: 'CURRENT REQUEST' })
      const path = join(testPaths.root, `moved-chat-${protocol}-${summarized}.txt`)
      await writeFile(path, 'Attached evidence '.repeat(20))
      vi.spyOn(database, 'listAttachmentsForThread').mockReturnValue([{ id: 'attachment', threadId: target.id,
        messageId: 'old-user', runId: 'old-run', name: 'evidence.txt', mimeType: 'text/plain', size: 360,
        kind: 'text', path, available: true, textTruncated: false, contextPolicy: 'conversation', createdAt: '' }])
      const delivered: BaseMessage[][] = []
      const onContextStatus = vi.fn()
      const factory = vi.spyOn(modelFactory, 'createChatModel').mockImplementation(() => new LiveSelectionTestModel(messages => {
        delivered.push(messages)
        return new AIMessage('Done')
      }))
      const instance = await createAgentInstance(target, database, { prepareWorkspace: false, onContextStatus })
      try {
        const graphConfig = { configurable: { thread_id: target.id } }
        await (instance.agent as unknown as Pick<ReturnType<typeof createDeepAgent>, 'updateState'>)
          .updateState(graphConfig, { messages: history, ...event }, 'AnasManualContextCompressionMiddleware.before_agent')
        const values = { messages: [...history, current], ...event }
        const preview = await instance.context.projectedStatus(values)
        const readonlyPreview = await projectAgentContextStatus(target, database, values)
        await instance.agent.invoke({ messages: [current] }, graphConfig)
        expect(delivered).toHaveLength(1)
        expect(delivered[0].some(message => message.id === current.id)).toBe(true)
        expect(delivered[0].some(ToolMessage.isInstance)).toBe(false)
        expect(delivered[0].filter(AIMessage.isInstance).every(message => !message.tool_calls?.length)).toBe(true)
        if (summarized) {
          expect(delivered[0].some(message => message.text === summary.text)).toBe(true)
          expect(delivered[0].some(message => message.id === 'old-user')).toBe(false)
        }
        const actual = countMessagesApproximately(delivered[0], [], { protocol })
        expect(preview.estimatedInputTokens).toBe(actual)
        expect(readonlyPreview.estimatedInputTokens).toBe(actual)
        expect(Object.values(preview.breakdown).reduce((sum, value) => sum + value, 0)).toBe(actual)
        expect(onContextStatus.mock.lastCall?.[0].breakdown.attachmentTokens).toBe(preview.breakdown.attachmentTokens)
        expect(preview.breakdown.attachmentTokens > 0).toBe(!summarized)
      } finally { await instance.dispose(); factory.mockRestore(); database.close() }
    }
  )

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('keeps %s attachment usage for the active run and drops it before the next run compresses', async (protocol) => {
    const snapshot = previewConfig()
    snapshot.providers[0].protocol = protocol
    Object.assign(snapshot.providers[0].models[0], { contextCompressionEnabled: true, contextCompressionThreshold: 0.08 })
    appConfigMocks.getAppConfigSnapshot.mockImplementation(async () => structuredClone(snapshot))
    projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), capabilities: {
      ...structuredClone(defaultCapabilities), profile: false, environment: false, workspace: false,
      planning: false, toolMode: 'selected', tools: [], subagents: false, backgroundTools: false, memory: false,
      skills: { enabled: false, mode: 'default', project: false, entries: [] }
    } })
    const path = join(testPaths.root, `attachment-usage-${protocol}.txt`)
    await writeFile(path, 'Attachment evidence '.repeat(100))
    const database = AgentDatabase.open(':memory:')
    const target = configuredThread(database)
    const firstRun = database.createRun(target.id, 'attachment-first')
    const source = new HumanMessage({ id: `${firstRun.id}:input`, content: 'Read the attachment' })
    vi.spyOn(database, 'listAttachmentsForThread').mockReturnValue([{ id: 'attachment', threadId: target.id,
      messageId: source.id!, runId: firstRun.id, name: 'evidence.txt', mimeType: 'text/plain', size: 2000,
      kind: 'text', path, available: true, textTruncated: false, contextPolicy: 'one_turn', createdAt: '' }])
    const delivered: BaseMessage[][] = []
    const factory = vi.spyOn(modelFactory, 'createChatModel').mockImplementation(() => new LiveSelectionTestModel(messages => {
      delivered.push(messages)
      return new AIMessage({ content: 'Read it', usage_metadata: { input_tokens: 8000, output_tokens: 3, total_tokens: 8003 } })
    }))
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected summary request after attachment removal'))
    const graphConfig = { configurable: { thread_id: target.id } }
    try {
      const first = await createAgentInstance(target, database, { requestId: firstRun.id, prepareWorkspace: false })
      try {
        await first.agent.invoke({ messages: [source] }, graphConfig)
        const values = (await database.checkpointer.getTuple(graphConfig))!.checkpoint.channel_values
        expect(delivered[0].some(message => message.text.includes('Attachment evidence'))).toBe(true)
        expect((await first.context.projectedStatus(values)).currentContextTokens).toBeGreaterThan(8000)
      } finally { await first.dispose() }
      database.finishRun(firstRun.id, 'completed')
      const values = (await database.checkpointer.getTuple(graphConfig))!.checkpoint.channel_values
      const preview = await projectAgentContextStatus(target, database, values)
      expect(preview.currentContextTokens).toBe(preview.estimatedInputTokens)
      expect(preview.currentContextTokens).toBeLessThan(8000)
      const nextRun = database.createRun(target.id, 'attachment-next')
      const next = await createAgentInstance(target, database, { requestId: nextRun.id, prepareWorkspace: false })
      try { await next.agent.invoke({ messages: [new HumanMessage('Continue')] }, graphConfig) }
      finally { await next.dispose() }
      expect(delivered).toHaveLength(2)
      expect(delivered[1].some(message => message.text.includes('Attachment evidence'))).toBe(false)
      expect(fetch).not.toHaveBeenCalled()
    } finally { factory.mockRestore(); fetch.mockRestore(); database.close() }
  })

  it('retains streaming Responses usage after the SDK adds image-generation transport options', async () => {
    const snapshot = previewConfig()
    snapshot.providers[0].protocol = 'openai_responses'
    Object.assign(snapshot.providers[0].models[0], { stream: true, parameters: { tools: [{ type: 'image_generation' }] } })
    appConfigMocks.getAppConfigSnapshot.mockImplementation(async () => structuredClone(snapshot))
    projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), capabilities: {
      ...structuredClone(defaultCapabilities), profile: false, environment: false, workspace: false,
      planning: false, toolMode: 'selected', tools: [], subagents: false, backgroundTools: false, memory: false,
      skills: { enabled: false, mode: 'default', project: false, entries: [] }
    } })
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      expect(JSON.parse(String(init?.body)).tools).toEqual([{ type: 'image_generation', partial_images: 1 }])
      const event = { type: 'response.completed', response: { id: 'response', object: 'response', created_at: 1,
        model: 'preview-model', status: 'completed', output: [{ id: 'answer', type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'Done', annotations: [] }] }],
        usage: { input_tokens: 8000, output_tokens: 1, total_tokens: 8001 }
      } }
      return new Response(`data: ${JSON.stringify(event)}\n\n`, { headers: { 'content-type': 'text/event-stream' } })
    })
    const database = AgentDatabase.open(':memory:')
    const target = configuredThread(database)
    const instance = await createAgentInstance(target, database, { prepareWorkspace: false })
    try {
      const graphConfig = { configurable: { thread_id: target.id } }
      await instance.agent.invoke({ messages: [new HumanMessage('Draw a square')] }, graphConfig)
      const values = (await database.checkpointer.getTuple(graphConfig))!.checkpoint.channel_values
      const preview = await projectAgentContextStatus(target, database, values)
      expect(preview.estimatedInputTokens).toBeLessThan(8000)
      expect(preview.currentContextTokens).toBeGreaterThanOrEqual(8000)
    } finally { await instance.dispose(); fetch.mockRestore(); database.close() }
  })

  it('recomputes the selected protocol without building a model or loading MCP connections', async () => {
    const snapshot = previewConfig()
    snapshot.mcpServers = [{ id: 'preview-mcp', index: 0, name: 'Preview MCP', enabled: true,
      type: 'stdio', command: 'must-not-start', args: [], env: {}, workingDir: '', timeoutMs: 1000, url: '' }]
    snapshot.providers[0].protocol = 'anthropic_messages'
    appConfigMocks.getAppConfigSnapshot.mockImplementation(async () => structuredClone(snapshot))
    const database = AgentDatabase.open(':memory:')
    const target = configuredThread(database)
    const factory = vi.spyOn(modelFactory, 'createChatModel')
    const connect = vi.spyOn(mcpRuntimeService, 'getCachedMcpRuntime')
    const messages = [new HumanMessage('Inspect'), new AIMessage({ content: '', tool_calls: [
      { id: 'capture', name: 'view_image', args: {} }
    ] }), new ToolMessage({ tool_call_id: 'capture', name: 'view_image', content: [
      { type: 'text', text: 'Image metadata '.repeat(1000) },
      { type: 'image_url', image_url: { url: 'https://example.test/image.png' } }
    ] })]
    try {
      const first = await projectAgentContextStatus(target, database, { messages })
      snapshot.providers[0].protocol = 'openai_chat_completions'
      const next = await projectAgentContextStatus(target, database, { messages })
      expect(next.estimatedInputTokens).toBeGreaterThan(first.estimatedInputTokens + 2000)
      expect(next.modelContextKey).not.toBe(first.modelContextKey)
      expect(factory).not.toHaveBeenCalled()
      expect(connect).not.toHaveBeenCalled()
      expect(await database.checkpointer.getTuple({ configurable: { thread_id: target.id } })).toBeUndefined()
    } finally { factory.mockRestore(); connect.mockRestore(); database.close() }
  })

  it.each([true, false])('includes management schemas in readonly preview with background tools %s', async (backgroundTools) => {
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(previewConfig())
    projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), capabilities: {
      ...structuredClone(defaultCapabilities), profile: false, environment: false, workspace: false,
      planning: false, toolMode: 'selected', tools: [], subagents: false, backgroundTools, memory: false,
      skills: { enabled: false, mode: 'default', project: false, entries: [] }
    } })
    const database = AgentDatabase.open(':memory:')
    const target = configuredThread(database)
    if (!backgroundTools) createUnresolvedManagedCall(database, target)
    const factory = vi.spyOn(modelFactory, 'createChatModel')
    const connect = vi.spyOn(mcpRuntimeService, 'getCachedMcpRuntime')
    const values = { messages: [new HumanMessage('Inspect background work.')] }
    try {
      const preview = await projectAgentContextStatus(target, database, values)
      expect(factory).not.toHaveBeenCalled()
      expect(connect).not.toHaveBeenCalled()
      expect(await database.checkpointer.getTuple({ configurable: { thread_id: target.id } })).toBeUndefined()
      expect(runtimeToolMocks.createdToolNames.mock.lastCall![0]).toEqual([
        'read_call', 'read_call_output', 'wait_call', 'cancel_call'
      ])
      const instance = await createAgentInstance(target, database, {
        prepareWorkspace: false, managedCalls: new ManagedCallService(database)
      })
      try {
        const actual = await instance.context.projectedStatus(values)
        expect(preview.breakdown?.toolDefinitionTokens).toBeGreaterThan(0)
        expect(preview.breakdown?.toolDefinitionTokens).toBe(actual.breakdown?.toolDefinitionTokens)
        expect(preview.estimatedInputTokens).toBe(actual.estimatedInputTokens)
      } finally { await instance.dispose() }
    } finally { factory.mockRestore(); connect.mockRestore(); database.close() }
  })

  it('previews the next run using current project capabilities after the previous run finishes', async () => {
    const { AgentRuntime } = await import('./agentRuntime')
    const snapshot = previewConfig()
    appConfigMocks.getAppConfigSnapshot.mockImplementation(async () => structuredClone(snapshot))
    const project = { ...defaultWorkspaceProject(), capabilities: {
      ...structuredClone(defaultCapabilities), profile: false, environment: false, workspace: false,
      planning: false, toolMode: 'selected' as const, tools: [], subagents: false, backgroundTools: false, memory: false,
      skills: { enabled: false, mode: 'default' as const, project: false, entries: [] }
    } }
    projectStoreMocks.getProject.mockImplementation(async () => structuredClone(project))
    const database = AgentDatabase.open(':memory:')
    const target = configuredThread(database)
    const oldRun = database.createRun(target.id, 'previous-project-config')
    const factory = vi.spyOn(modelFactory, 'createChatModel').mockImplementation(() => new LiveSelectionTestModel(() => new AIMessage('Done')))
    try {
      const first = await createAgentInstance(target, database, {
        requestId: oldRun.id, prepareWorkspace: false,
        onConfigurationResolved: configuration => database.resolveRunConfiguration(oldRun.id, configuration)
      })
      const graphConfig = { configurable: { thread_id: target.id } }
      try {
        await first.agent.invoke({ messages: [new HumanMessage('Hello')] }, graphConfig)
      } finally { await first.dispose() }
      database.finishRun(oldRun.id, 'completed')
      project.capabilities.planning = true
      snapshot.providers[0].models[0].model = 'changed-model'
      const runtime = new AgentRuntime(database, undefined, undefined, async () => {})
      const preview = await runtime.getContextStatus(target.id)
      const values = (await database.checkpointer.getTuple(graphConfig))!.checkpoint.channel_values
      const nextRun = database.createRun(target.id, 'current-project-config')
      const second = await createAgentInstance(database.getThread(target.id)!, database, {
        requestId: nextRun.id, prepareWorkspace: false
      })
      try {
        const actual = await second.context.projectedStatus(values)
        expect(preview?.breakdown?.toolDefinitionTokens).toBeGreaterThan(0)
        expect(preview?.breakdown?.toolDefinitionTokens).toBe(actual.breakdown?.toolDefinitionTokens)
        expect(preview?.estimatedInputTokens).toBe(actual.estimatedInputTokens)
      } finally { await second.dispose() }
    } finally { factory.mockRestore(); database.close() }
  })

  it('compresses history when recalled memory pushes the complete request over its budget', async () => {
    const snapshot = previewConfig()
    const selected = snapshot.providers[0].models[0]
    selected.contextCompressionEnabled = true
    appConfigMocks.getAppConfigSnapshot.mockImplementation(async () => structuredClone(snapshot))
    projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), capabilities: {
      ...structuredClone(defaultCapabilities), profile: false, environment: false, workspace: false,
      planning: false, toolMode: 'selected', tools: [], subagents: false, backgroundTools: false, memory: true,
      skills: { enabled: false, mode: 'default', project: false, entries: [] }
    } })
    const database = AgentDatabase.open(':memory:')
    const target = configuredThread(database)
    const relevant = vi.spyOn(database.memoryStore, 'relevantMemories').mockResolvedValue([{
      id: 'memory', scope: 'project', projectId: target.projectId, kind: 'fact', importance: 1,
      content: 'Remember the project constraint. ' + 'm'.repeat(4400), keywords: [], origin: 'user',
      createdAt: '2026-09-24T00:00:00.000Z', updatedAt: '2026-09-24T00:00:00.000Z'
    }])
    const delivered = vi.fn((_messages: BaseMessage[]) => new AIMessage('Finished'))
    const factory = vi.spyOn(modelFactory, 'createChatModel').mockImplementation(() => new LiveSelectionTestModel(delivered))
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      id: 'summary', object: 'chat.completion', created: 1, model: 'preview-model',
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Condensed earlier history.' } }]
    }), { headers: { 'content-type': 'application/json' } }))
    const messages = [new HumanMessage({ id: 'old-user', content: 'h'.repeat(4400) }),
      new AIMessage({ id: 'old-answer', content: 'a'.repeat(4400) }), new HumanMessage('Continue')]
    try {
      const before = await projectAgentContextStatus(target, database, { messages })
      relevant.mockResolvedValueOnce([])
      const withoutRecall = await projectAgentContextStatus(target, database, { messages })
      expect(before.estimatedInputTokens).toBeGreaterThan(withoutRecall.estimatedInputTokens + 1000)
      const capacity = withoutRecall.estimatedInputTokens + 500
      selected.maxContextTokens = capacity + selected.maxOutputTokens
      selected.contextCompressionThreshold = (withoutRecall.estimatedInputTokens + 250) / capacity
      const instance = await createAgentInstance(target, database, { prepareWorkspace: false })
      try {
        const graphConfig = { configurable: { thread_id: target.id } }
        await instance.agent.invoke({ messages }, graphConfig)
        const deliveredMessages = delivered.mock.calls.at(-1)![0]
        expect(deliveredMessages[0].text).toContain('Remember the project constraint.')
        expect(deliveredMessages.some(message => message.id === 'old-user')).toBe(false)
        const state = (await database.checkpointer.getTuple(graphConfig))!.checkpoint.channel_values
        expect(state._summarizationEvent).toMatchObject({ cutoffIndex: 2 })
        const response = (state.messages as BaseMessage[]).at(-1)!
        expect(response.additional_kwargs.anas_context_request_key).toBe(contextRequestKey({
          messages: deliveredMessages.slice(1), systemMessage: deliveredMessages[0], tools: [],
          protocol: 'openai_chat_completions'
        }))
        expect(deliveredMessages.some(message => message.text.includes('Condensed earlier history.'))).toBe(true)
      } finally { await instance.dispose() }
    } finally { relevant.mockRestore(); factory.mockRestore(); fetchSpy.mockRestore(); database.close() }
  })

  it('includes the framework planning tool in live and reconstructed context estimates', async () => {
    const snapshot = previewConfig()
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(),
      capabilities: { ...structuredClone(defaultCapabilities), profile: false, environment: false, workspace: false,
        planning: true, toolMode: 'selected', tools: [], subagents: false, backgroundTools: false, memory: false,
        skills: { enabled: false, mode: 'default', project: false, entries: [] } } })
    const database = AgentDatabase.open(':memory:')
    const target = configuredThread(database)
    const onContextStatus = vi.fn()
    const factory = vi.spyOn(modelFactory, 'createChatModel').mockImplementation(() => new LiveSelectionTestModel(() => new AIMessage('Done')))
    const messages = [new HumanMessage('Verify the next model request.')]
    try {
      const instance = await createAgentInstance(target, database, { prepareWorkspace: false, onContextStatus })
      try {
        await instance.agent.invoke({ messages }, { configurable: { thread_id: target.id } })
        const prepared = onContextStatus.mock.lastCall![0]
        expect(prepared.breakdown.toolDefinitionTokens).toBeGreaterThan(0)
        expect(prepared.estimatedInputTokens).toBeGreaterThan(prepared.breakdown.messageTokens)
        expect(prepared.estimatedInputTokens).toBe(Object.values(prepared.breakdown as Record<string, number>).reduce((sum, tokens) => sum + tokens, 0))
        const preview = await instance.context.projectedStatus({ messages })
        expect(preview.breakdown.toolDefinitionTokens).toBe(prepared.breakdown.toolDefinitionTokens)
        const fresh = await createAgentInstance(target, database, { prepareWorkspace: false })
        try {
          expect((await fresh.context.projectedStatus({ messages })).estimatedInputTokens).toBe(preview.estimatedInputTokens)
        } finally { await fresh.dispose() }
      } finally { await instance.dispose() }
    } finally { factory.mockRestore(); database.close() }
  })

  it.each([false, true].flatMap(codingMode => (['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)
    .map(protocol => ({ codingMode, protocol }))))('reuses matching checkpoint usage in $protocol previews with coding=$codingMode', async ({ codingMode, protocol }) => {
    const directory = await mkdtemp(join(testPaths.root, 'usage-preview-'))
    await writeFile(join(directory, 'AGENTS.md'), 'Preserve the project conventions.')
    const snapshot = previewConfig()
    snapshot.providers[0].protocol = protocol
    if (protocol === 'openai_responses') snapshot.providers[0].models[0].parameters = { instructions: 'Additional request instructions.' }
    appConfigMocks.getAppConfigSnapshot.mockImplementation(async () => structuredClone(snapshot))
    projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), sourceFolders: [directory], codingMode,
      capabilities: { ...structuredClone(defaultCapabilities), profile: false, environment: false, workspace: false,
        planning: true, toolMode: 'selected', tools: [], subagents: false, backgroundTools: false, memory: false,
        skills: { enabled: false, mode: 'default', project: false, entries: [] } } })
    const database = AgentDatabase.open(':memory:')
    const target = configuredThread(database)
    const factory = vi.spyOn(modelFactory, 'createChatModel').mockImplementation(() => new LiveSelectionTestModel(() => new AIMessage({
      content: 'Done', usage_metadata: { input_tokens: 10_000, output_tokens: 20, total_tokens: 10_020 }
    })))
    const instance = await createAgentInstance(target, database, { prepareWorkspace: false })
    try {
      const graphConfig = { configurable: { thread_id: target.id } }
      await instance.agent.invoke({ messages: [new HumanMessage('Verify the current request.')] }, graphConfig)
      const values = (await database.checkpointer.getTuple(graphConfig))!.checkpoint.channel_values
      for (const projected of [await instance.context.projectedStatus(values), await projectAgentContextStatus(target, database, values)]) {
        expect(projected.estimatedInputTokens).toBeLessThan(10_000)
        expect(projected.currentContextTokens).toBeGreaterThan(10_000)
      }
    } finally { await instance.dispose(); factory.mockRestore(); database.close(); await rm(directory, { recursive: true, force: true }) }
  })

  it.each(['selection', 'parameters', 'retry', 'deleted', 'invalid', 'tool-capability', 'small-window'] as const)(
    'reads %s changes before the next request without rebuilding the graph', async (change) => {
      const snapshot = previewConfig()
      const second = { ...snapshot.providers[0].models[0], id: 'second-model', model: 'second-model', parameters: { temperature: 0.2 } }
      snapshot.providers[0].models.push(second)
      appConfigMocks.getAppConfigSnapshot.mockImplementation(async () => structuredClone(snapshot))
      const database = AgentDatabase.open(':memory:')
      const target = configuredThread(database)
      const run = database.createRun(target.id, `live-model-${change}`)
      const observed: ResolvedModelConfig[] = []
      const factory = vi.spyOn(modelFactory, 'createChatModel').mockImplementation((selected) => new LiveSelectionTestModel(async () => {
        observed.push(structuredClone(selected))
        if (observed.length > 1) return new AIMessage('Finished with the current model.')
        if (change === 'selection' || change === 'retry') database.updateThread(target.id, { modelConfigId: second.id, modelParameterPresetId: null })
        if (change === 'retry') throw Object.assign(new Error('Temporarily unavailable'), { status: 503 })
        if (change === 'parameters') snapshot.providers[0].models[0].parameters = { temperature: 0.7 }
        if (change === 'deleted') snapshot.providers[0].models.shift()
        if (change === 'invalid') snapshot.providers[0].models[0].model = ''
        if (change === 'tool-capability') snapshot.providers[0].models[0].capabilities.toolUse = false
        if (change === 'small-window') {
          snapshot.providers[0].models[0].maxContextTokens = 4100
          snapshot.providers[0].models[0].maxOutputTokens = 4090
        }
        return new AIMessage({ content: 'Updating the plan.', tool_calls: [
          { id: 'plan', name: 'write_todos', args: { todos: [{ content: 'Finish the reply', status: 'in_progress' }] } }
        ] })
      }))
      try {
        const instance = await createAgentInstance(target, database, { requestId: run.id, prepareWorkspace: false })
        const pending = instance.agent.invoke({ messages: [new HumanMessage('Continue after updating the plan.')] }, {
          configurable: { thread_id: target.id }
        })
        if (change === 'selection' || change === 'parameters' || change === 'retry') {
          await pending
          expect(observed).toHaveLength(2)
          expect(observed[0].id).toBe('preview-model')
          expect(observed[1]).toMatchObject(change !== 'parameters'
            ? { id: 'second-model', parameters: { temperature: 0.2 } }
            : { id: 'preview-model', parameters: { temperature: 0.7 } })
        } else {
          await expect(pending).rejects.toThrow()
          expect(observed).toHaveLength(1)
          const state = await database.checkpointer.getTuple({ configurable: { thread_id: target.id } })
          expect(state?.checkpoint.channel_values.messages).toBeDefined()
        }
        await instance.dispose()
      } finally { factory.mockRestore(); database.close() }
    }
  )

  it('allows a text-only vision setting after an earlier tool image has been consumed', async () => {
    const snapshot = previewConfig()
    snapshot.providers[0].models[0].capabilities.vision = false
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    const database = AgentDatabase.open(':memory:')
    const target = configuredThread(database)
    const invoked = vi.fn(() => new AIMessage('Continuing with the text history.'))
    const factory = vi.spyOn(modelFactory, 'createChatModel').mockImplementation(() => new LiveSelectionTestModel(invoked))
    try {
      const instance = await createAgentInstance(target, database, { prepareWorkspace: false })
      await instance.agent.invoke({ messages: [
        new HumanMessage('Inspect the picture.'),
        new AIMessage({ content: '', tool_calls: [{ id: 'image', name: 'view_image', args: {} }] }),
        new ToolMessage({ tool_call_id: 'image', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }),
        new AIMessage('The image shows a chart.'),
        new HumanMessage('Now explain the result in text.')
      ] }, { configurable: { thread_id: target.id } })
      expect(invoked).toHaveBeenCalledOnce()
      await instance.dispose()
    } finally { factory.mockRestore(); database.close() }
  })

  it.each([false, true])('checks tool capability against the checkpoint summary boundary (compressed: %s)', async (compressed) => {
    const snapshot = previewConfig(false)
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    const database = AgentDatabase.open(':memory:')
    const target = configuredThread(database)
    const invoked = vi.fn((_messages: BaseMessage[]) => new AIMessage('Continuing from the summary.'))
    const factory = vi.spyOn(modelFactory, 'createChatModel').mockImplementation(() => new LiveSelectionTestModel(invoked))
    const messages = [
      new HumanMessage({ id: 'old-human', content: 'Read the file.' }),
      new AIMessage({ id: 'old-ai', content: '', tool_calls: [{ id: 'read', name: 'read_file', args: {} }] }),
      new ToolMessage({ id: 'old-tool', tool_call_id: 'read', content: 'Earlier file contents.' }),
      new AIMessage({ id: 'old-result', content: 'The file has been read.' }),
      new HumanMessage({ id: 'new-human', content: 'Explain the result in text.' })
    ]
    try {
      const instance = await createAgentInstance(target, database, { prepareWorkspace: false })
      try {
        const graph = instance.agent as ReturnType<typeof createDeepAgent>
        const graphConfig = { configurable: { thread_id: target.id } }
        await graph.updateState(graphConfig, { messages, _summarizationEvent: {
          filePath: null, cutoffIndex: compressed ? 4 : 1,
          summaryMessage: new HumanMessage({ id: 'summary', content: 'Earlier file work.', additional_kwargs: { lc_source: 'summarization' } })
        } }, 'AnasManualContextCompressionMiddleware.before_agent')
        expect((await database.checkpointer.getTuple(graphConfig))?.checkpoint.channel_values).toHaveProperty('_summarizationEvent.cutoffIndex', compressed ? 4 : 1)
        const pending = graph.invoke({ messages: [] }, graphConfig)
        if (compressed) {
          const result = await pending
          expect(invoked).toHaveBeenCalledOnce()
          expect(invoked.mock.calls[0][0].some(ToolMessage.isInstance)).toBe(false)
          expect(invoked.mock.calls[0][0].map((message) => message.id)).toEqual(expect.arrayContaining(['summary', 'new-human']))
          // Summary projection must not destroy the checkpoint's raw history.
          expect(result.messages.some((message: BaseMessage) => message.id === 'old-tool')).toBe(true)
        } else {
          await expect(pending).rejects.toThrow('does not support the tool context')
          expect(invoked).not.toHaveBeenCalled()
        }
      } finally { await instance.dispose() }
    } finally { factory.mockRestore(); database.close() }
  })

  it.each([false, true].flatMap(compressed => [false, true].map(reportContext => ({ compressed, reportContext }))))(
    'checks image capability against the checkpoint summary boundary (compressed: $compressed, context status: $reportContext)',
    async ({ compressed, reportContext }) => {
      const snapshot = previewConfig()
      snapshot.providers[0].models[0].capabilities.vision = false
      appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
      const database = AgentDatabase.open(':memory:')
      const target = configuredThread(database)
      vi.spyOn(database, 'listAttachmentsForThread').mockReturnValue([{
        id: 'old-image', threadId: target.id, messageId: 'old-human', runId: 'old-run',
        name: 'earlier-chart.png', mimeType: 'image/png', size: 4, kind: 'image', path: 'unused.png',
        available: true, textTruncated: false, contextPolicy: 'conversation', createdAt: target.createdAt
      }])
      const invoked = vi.fn((_messages: BaseMessage[]) => new AIMessage('Continuing from the summary.'))
      const factory = vi.spyOn(modelFactory, 'createChatModel').mockImplementation(() => new LiveSelectionTestModel(invoked))
      const onContextStatus = vi.fn()
      try {
        const instance = await createAgentInstance(target, database, {
          prepareWorkspace: false, ...(reportContext ? { onContextStatus } : {})
        })
        try {
          const input = {
            messages: [
              new HumanMessage({ id: 'old-human', content: 'Read the image.' }),
              new AIMessage({ id: 'old-result', content: 'It is a chart.' }),
              new HumanMessage({ id: 'new-human', content: 'Explain the result in text.' })
            ],
            _summarizationEvent: {
              filePath: null, cutoffIndex: compressed ? 2 : 0,
              summaryMessage: new HumanMessage({ id: 'summary', content: 'Earlier chart observations.', additional_kwargs: { lc_source: 'summarization' } })
            }
          }
          const graph = instance.agent as ReturnType<typeof createDeepAgent>
          const graphConfig = { configurable: { thread_id: target.id } }
          await graph.updateState(graphConfig, input, 'AnasManualContextCompressionMiddleware.before_agent')
          const pending = graph.invoke({ messages: [] }, graphConfig)
          if (compressed) {
            await pending
            expect(invoked).toHaveBeenCalledOnce()
            expect(invoked.mock.calls[0][0].map((message) => message.id)).toEqual(expect.arrayContaining(['summary', 'new-human']))
            expect(invoked.mock.calls[0][0].some((message) => message.id === 'old-human')).toBe(false)
            if (reportContext) expect(onContextStatus.mock.calls[0][0]).toMatchObject({
              compressionApplied: true, breakdown: { attachmentTokens: 0 }
            })
          } else {
            await expect(pending).rejects.toThrow('does not support the required image attachment')
            expect(invoked).not.toHaveBeenCalled()
          }
        } finally { await instance.dispose() }
      } finally { factory.mockRestore(); database.close() }
    }
  )

  it.each(['parameters', 'displayName', 'deleted', 'in-flight'] as const)(
    'uses current settings when automatic compression changes during %s', async (change) => {
      const snapshot = previewConfig()
      snapshot.providers[0].models[0].contextCompressionEnabled = true
      snapshot.providers[0].models[0].contextCompressionThreshold = 0.1
      appConfigMocks.getAppConfigSnapshot.mockImplementation(async () => structuredClone(snapshot))
      const database = AgentDatabase.open(':memory:')
      const target = configuredThread(database)
      const invoked = vi.fn((_messages: BaseMessage[]) => new AIMessage('Finished with the current settings.'))
      const mainModels: ResolvedModelConfig[] = []
      const factory = vi.spyOn(modelFactory, 'createChatModel').mockImplementation((selected) => new LiveSelectionTestModel((messages) => {
        mainModels.push(selected)
        return invoked(messages)
      }))
      const compressionFactory = modelFactory.createCompressionChatModel
      const compression = vi.spyOn(modelFactory, 'createCompressionChatModel').mockImplementation((selected, options) => {
        if (change === 'displayName') snapshot.providers[0].models[0].displayName = 'Renamed during preparation'
        return compressionFactory(selected, options)
      })
      const requests: Array<Record<string, unknown>> = []
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        requests.push(input instanceof Request ? await input.clone().json() : JSON.parse(String(init?.body)))
        if (requests.length === 1 && change !== 'displayName') {
          if (change === 'deleted') snapshot.providers[0].models = []
          else snapshot.providers[0].models[0].parameters = { temperature: 0.7 }
          if (change !== 'in-flight') return new Response(JSON.stringify({ error: { message: 'Temporarily unavailable', type: 'server_error' } }), {
            status: 503, headers: { 'content-type': 'application/json' }
          })
        }
        return new Response(JSON.stringify({ id: `summary-response-${requests.length}`, object: 'chat.completion', created: 1,
          model: 'preview-model', choices: [{ index: 0, finish_reason: 'stop',
            message: { role: 'assistant', content: `Condensed history ${requests.length}` } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        }), { headers: { 'content-type': 'application/json' } })
      })
      let summaryNumber = 0
      const onCompressionFailed = vi.fn()
      const onCompressionCompleted = vi.fn()
      try {
        const instance = await createAgentInstance(target, database, { prepareWorkspace: false,
          onCompressionStart: () => `summary-${++summaryNumber}`, onCompressionFailed, onCompressionCompleted })
        try {
          const graph = instance.agent as ReturnType<typeof createDeepAgent>
          const graphConfig = { configurable: { thread_id: target.id } }
          const pending = graph.invoke({ messages: [
            new HumanMessage({ id: 'old-input', content: 'Earlier details. '.repeat(8000) }),
            new AIMessage({ id: 'old-answer', content: 'Earlier work completed.' }),
            new HumanMessage({ id: 'new-input', content: 'Continue with the next task.' })
          ] }, graphConfig)
          if (change === 'deleted') {
            await expect(pending).rejects.toThrow('no longer exists')
            expect(requests).toHaveLength(1)
            expect(invoked).not.toHaveBeenCalled()
            expect((await database.checkpointer.getTuple(graphConfig))?.checkpoint.channel_values._summarizationEvent).toBeUndefined()
          } else {
            await pending
            expect(invoked).toHaveBeenCalledOnce()
            expect(requests).toHaveLength(change === 'displayName' ? 1 : 2)
            if (change === 'displayName') expect(mainModels[0].displayName).toBe('Renamed during preparation')
            else {
              expect(requests.at(-1)?.temperature).toBe(0.7)
              expect(mainModels[0].parameters.temperature).toBe(0.7)
            }
            const state = (await database.checkpointer.getTuple(graphConfig))!.checkpoint.channel_values
            expect(state._summarizationEvent).toMatchObject({ cutoffIndex: 2 })
            expect((state.messages as BaseMessage[]).some((message) => message.id === 'old-input')).toBe(true)
            expect(invoked.mock.calls[0][0].some((message) => message.id === 'old-input')).toBe(false)
            if (change === 'in-flight') {
              expect(onCompressionFailed).toHaveBeenCalledWith('summary-1')
              expect(state._summarizationEvent).toMatchObject({ summaryMessage: { content: expect.stringContaining('Condensed history 2') } })
            }
          }
        } finally { await instance.dispose() }
      } finally { fetchSpy.mockRestore(); compression.mockRestore(); factory.mockRestore(); database.close() }
    }
  )

  it('rejects invalid server tool settings even when tool use is disabled', async () => {
    const snapshot = previewConfig(false)
    snapshot.providers[0].protocol = 'openai_responses'
    snapshot.providers[0].models[0].parameters = { tools: [{}] }
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    const database = AgentDatabase.open(':memory:')
    const target = configuredThread(database)
    const invoked = vi.fn(() => new AIMessage('Must not be sent'))
    const factory = vi.spyOn(modelFactory, 'createChatModel').mockImplementation(() => new LiveSelectionTestModel(invoked))
    try {
      const instance = await createAgentInstance(target, database, { prepareWorkspace: false })
      await expect(instance.agent.invoke({ messages: [new HumanMessage('Hello')] }, { configurable: { thread_id: target.id } }))
        .rejects.toThrow('invalid tool parameters')
      expect(invoked).not.toHaveBeenCalled()
    } finally { factory.mockRestore(); database.close() }
  })
})

function createUnresolvedManagedCall(database: AgentDatabase, agentThread: AgentThread) {
  const run = database.createRun(agentThread.id, 'managed-call-run')
  database.createManagedCall({
    id: '11111111-1111-8111-8111-111111111111',
    threadId: agentThread.id,
    runId: run.id,
    kind: 'http',
    summary: 'Request still needs supervision'
  })
  database.markManagedCallDetached('11111111-1111-8111-8111-111111111111', agentThread.id)
  database.finishManagedCall({
    callId: '11111111-1111-8111-8111-111111111111',
    threadId: agentThread.id,
    status: 'completed',
    result: 'done'
  })
  return run
}

function managedCallContext(database: AgentDatabase) {
  return {
    start: vi.fn(),
    read: vi.fn(),
    readOutput: vi.fn(),
    readResult: vi.fn(),
    wait: vi.fn(),
    cancel: vi.fn(),
    cancelRun: vi.fn().mockResolvedValue({ uncertainCallIds: [], lingeringCallIds: [] }),
    unresolvedForRun: vi.fn((runId: string) => database.listUnresolvedManagedCalls(runId)),
    unresolvedForThread: vi.fn((threadId: string) => (
      database.listUnresolvedManagedCallsForThread(threadId)
    )),
    resolveObservedCall: vi.fn()
  }
}

describe('managed call supervision availability', () => {
  beforeEach(() => {
    vi.mocked(toolsStore.listToolSnapshot).mockReset().mockResolvedValue({ roots: [], tools: [] })
    appConfigMocks.getAppConfigSnapshot.mockReset()
    runtimeToolMocks.createRuntimeTools.mockClear()
    projectStoreMocks.getProject.mockReset()
    projectStoreMocks.getProject.mockResolvedValue(defaultWorkspaceProject())
    memoryStoreMocks.buildMemoryRulesPrompt.mockReset()
    memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('')
  })

  it.each([false, true].flatMap(subagent => [256_000, 1_000_000].map(maxContextTokens => ({ subagent, maxContextTokens }))))(
    'enforces the selected model read budget in the graph ($maxContextTokens, subagent: $subagent)', async ({ subagent, maxContextTokens }) => {
      const root = await mkdtemp(join(tmpdir(), 'anas-read-budget-'))
      const path = join(root, 'content.txt')
      await writeFile(path, 'x'.repeat(300_000))
      const snapshot = previewConfig()
      snapshot.providers[0].models.push({ ...snapshot.providers[0].models[0], id: 'read-budget-model', maxContextTokens, contextCompressionEnabled: false })
      appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
      projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), sourceFolders: [root] })
      const database = AgentDatabase.open(':memory:')
      const owner = configuredThread(database, { title: 'Owner' })
      const target = configuredThread(database, { title: 'Read with selected model', modelConfigId: 'read-budget-model' })
      const run = database.createRun(target.id, 'read-budget-run')
      const managedCalls = new ManagedCallService(database)
      const model = vi.spyOn(modelFactory, 'createChatModel').mockReturnValue(new FakeToolCallingModel({ toolCalls: [
        [{ id: 'read-budget', name: 'read_file', args: { path } }], []
      ] }))
      try {
        const instance = await createAgentInstance(target, database, {
          requestId: run.id, prepareWorkspace: false, managedCalls,
          ...(subagent ? { subagentCall: {
            id: '91919191-9191-8191-8191-919191919191', ownerThreadId: owner.id, parentThreadId: owner.id,
            parentRunId: 'parent-budget-run', childThreadId: target.id, childRunId: run.id,
            agentName: 'general-purpose', config: snapshot.subagents[0], description: 'Read the file.',
            status: 'running' as const, createdAt: target.createdAt, updatedAt: target.updatedAt
          } } : {})
        })
        try {
          const result = await instance.agent.invoke({ messages: [new HumanMessage('Read the file.')] }, { configurable: { thread_id: target.id } })
          const read = result.messages.filter(ToolMessage.isInstance).find((message: ToolMessage) => message.tool_call_id === 'read-budget')!
          const output = JSON.parse(String(read.content))
          if (maxContextTokens < 300_000) expect(output).toMatchObject({ ok: false, error: expect.stringContaining(String(maxContextTokens)) })
          else expect(output).toMatchObject({ ok: true, byteLimit: maxContextTokens, returnedBytes: 300_000 })
        } finally { await instance.dispose() }
      } finally { model.mockRestore(); await managedCalls.shutdown(); database.close(); await rm(root, { recursive: true, force: true }) }
    }
  )

  it('executes selected custom scripts through the graph, corrects errors, and freezes the run definition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-custom-graph-'))
    const scriptPath = join(root, 'submit.cjs')
    await writeFile(scriptPath, `const data=JSON.parse(process.argv[2]);if(!data.title.trim()){console.log(JSON.stringify({ok:false,error:'title is blank'}))}else{require('fs').appendFileSync('received.jsonl',JSON.stringify(data)+'\\n');console.log(JSON.stringify({ok:true,accepted:data.title}))}`)
    const snapshot = previewConfig()
    snapshot.customTools = [toolPackageFixture({ ...customToolDefaults, id: 'submit', name: 'submit_result', description: 'Submit a title.', directory: root,
      command: `"${process.execPath}" "${scriptPath}" {{args}}`, inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false } })]
    snapshot.subagents = []
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: snapshot.customTools })
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), sourceFolders: [root],
      capabilities: { ...structuredClone(defaultCapabilities), customTools: selectedTools(['submit']), memory: false, subagents: false,
        skills: { enabled: false, mode: 'default', project: false, entries: [] } } })
    const database = AgentDatabase.open(':memory:')
    const thread = configuredThread(database, { title: 'Custom tools' })
    const run = database.createRun(thread.id, 'custom-graph')
    const model = vi.spyOn(modelFactory, 'createChatModel').mockReturnValue(new FakeToolCallingModel({ toolCalls: [
      [{ id: 'invalid', name: 'submit_result', args: { title: 123 } }],
      [{ id: 'business-error', name: 'submit_result', args: { title: ' ' } }],
      [{ id: 'corrected', name: 'submit_result', args: { title: '有效标题' } }], []
    ] }))
    const managedCalls = new ManagedCallService(database)
    try {
      const instance = await createAgentInstance(thread, database, { requestId: run.id, prepareWorkspace: false, managedCalls,
        onConfigurationResolved: (value) => database.resolveRunConfiguration(run.id, value) })
      try {
        const result = await instance.agent.invoke({ messages: [new HumanMessage('Submit a result.')] }, { configurable: { thread_id: thread.id } })
        const responses = result.messages.filter(ToolMessage.isInstance)
        expect(responses).toMatchObject([
          { tool_call_id: 'invalid', status: 'error' },
          { tool_call_id: 'business-error', status: 'success', content: expect.stringContaining('title is blank') },
          { tool_call_id: 'corrected', status: 'success', content: expect.stringContaining('有效标题') }
        ])
        expect(result).not.toHaveProperty('__interrupt__')
        expect(await readFile(join(root, 'received.jsonl'), 'utf8')).toBe('{"title":"有效标题"}\n')
      } finally { await instance.dispose() }
      snapshot.customTools[0].definition!.name = 'renamed_after_run'
      const originalCommand = snapshot.customTools[0].definition!.command
      snapshot.customTools[0].definition!.command = 'another-command {{args}}'
      const configuration = database.getRunConfiguration(run.id)!
      expect(configuration.customTools[0].name).toBe('submit_result')
      expect(configuration.customTools[0].command).toBe(originalCommand)
      const resumedModel = new FakeToolCallingModel()
      const bindings = vi.spyOn(resumedModel, 'bindTools')
      model.mockReturnValue(resumedModel)
      const resumed = await createAgentInstance(thread, database, { requestId: run.id, configuration, prepareWorkspace: false, managedCalls })
      try {
        await resumed.agent.invoke({ messages: [new HumanMessage('Continue.')] }, { configurable: { thread_id: thread.id } })
        expect(bindings.mock.calls.flatMap(([tools]) => tools.map((tool) => 'name' in tool ? tool.name : undefined))).toContain('submit_result')
        expect(bindings.mock.calls.flatMap(([tools]) => tools.map((tool) => 'name' in tool ? tool.name : undefined))).not.toContain('renamed_after_run')
      } finally { await resumed.dispose() }
    } finally { model.mockRestore(); await managedCalls.shutdown(); database.close(); await rm(root, { recursive: true, force: true }) }
  })

  it.each([false, true].flatMap(memory => [false, true].map(tools => ({ memory, tools }))))('runs automatic recall $memory independently from memory tools $tools', async ({ memory, tools }) => {
    const names = ['read_memory', 'save_to_memory', 'forget_memory']
    projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), sourceFolders: [process.cwd()],
      capabilities: { ...structuredClone(defaultCapabilities), memory, subagents: false, backgroundTools: false, planning: false,
        toolMode: 'selected', tools: tools ? names : [], skills: { enabled: false, mode: 'default', project: false, entries: [] } } })
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue({ ...previewConfig(), subagents: [] })
    const database = AgentDatabase.open(':memory:')
    const thread = configuredThread(database)
    database.createRun(thread.id, 'memory-options')
    const recall = vi.spyOn(database.memoryStore, 'relevantMemories').mockResolvedValue([])
    const model = vi.spyOn(modelFactory, 'createChatModel').mockReturnValue(new FakeToolCallingModel({ toolCalls: [[]] }))
    try {
      const instance = await createAgentInstance(thread, database, { requestId: 'memory-options', prepareWorkspace: false })
      try {
        await instance.agent.invoke({ messages: [new HumanMessage('Recall project preferences.')] }, { configurable: { thread_id: thread.id } })
        expect(recall).toHaveBeenCalledTimes(memory ? 1 : 0)
        for (const name of names) expect(runtimeToolMocks.createdToolNames.mock.lastCall![0].includes(name)).toBe(tools)
      } finally { await instance.dispose() }
    } finally { model.mockRestore(); recall.mockRestore(); database.close() }
  })

  it.each(['todos', 'approval'] as const)('completes a mixed %s batch through the production middleware and SQLite', async source => {
    projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), sourceFolders: [process.cwd()], codingMode: true,
      capabilities: { ...structuredClone(defaultCapabilities), planning: true, toolMode: 'selected', tools: ['read_file', 'update_config'], memory: false,
        skills: { enabled: false, mode: 'default', project: false, entries: [] } } })
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue({ ...previewConfig(), subagents: [] })
    const database = AgentDatabase.open(':memory:')
    const thread = configuredThread(database)
    database.createRun(thread.id, 'batch-recovery')
    const todos = [{ content: 'A valid plan', status: 'pending' }]
    const calls = source === 'todos' ? [
      { id: 'invalid', name: 'write_todos', args: { todos: 'wrong' } },
      { id: 'valid', name: 'write_todos', args: { todos } }
    ] : [
      { id: 'invalid', name: 'read_file', args: { path: 4 } },
      { id: 'automatic', name: 'read_file', args: { path: 'package.json' } },
      { id: 'review', name: 'update_config', args: { config: 'settings', key: 'theme', value: 'dark' } }
    ]
    const model = vi.spyOn(modelFactory, 'createChatModel').mockReturnValue(new FakeToolCallingModel({ toolCalls: [calls, []] }))
    const managedCalls = new ManagedCallService(database)
    const execute = vi.spyOn(managedCalls, 'start')
    try {
      const instance = await createAgentInstance(thread, database, { requestId: 'batch-recovery', prepareWorkspace: false, managedCalls })
      try {
        const config = { configurable: { thread_id: thread.id } }
        let result = await instance.agent.invoke({ messages: [new HumanMessage('Process the batch.')] }, config)
        if (source === 'approval') {
          expect(result.__interrupt__).toHaveLength(1)
          result = await instance.agent.invoke(new Command({ resume: { decisions: [{ type: 'reject', message: 'Leave settings alone' }] } }), config)
        }
        const messages = result.messages as BaseMessage[]
        const responses = messages.filter(ToolMessage.isInstance)
        expect(responses).toHaveLength(calls.length)
        expect(new Set(responses.map(message => message.tool_call_id)).size).toBe(calls.length)
        expect(responses.find(message => message.tool_call_id === 'invalid')?.status).toBe('error')
        expect(messages.find(AIMessage.isInstance)?.tool_calls?.map(call => call.id)).toEqual(calls.map(call => call.id))
        expect(messages.filter(AIMessage.isInstance)).toHaveLength(2)
        if (source === 'todos') expect(result.todos).toEqual(todos)
        else expect(responses.every(message => message.status === 'error')).toBe(true)
        expect(execute).not.toHaveBeenCalled()
        expect(result).not.toHaveProperty('__interrupt__')
      } finally { await instance.dispose() }
    } finally { model.mockRestore(); await managedCalls.shutdown(); database.close() }
  })

  it('returns invalid arguments before production preflight while preserving the valid batch and next correction', async () => {
    projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), sourceFolders: [process.cwd()], codingMode: true,
      capabilities: { ...structuredClone(defaultCapabilities), toolMode: 'selected', tools: ['read_file'], memory: false,
        skills: { enabled: false, mode: 'default', project: false, entries: [] } } })
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue({ ...previewConfig(), subagents: [] })
    const database = AgentDatabase.open(':memory:')
    const thread = configuredThread(database)
    database.createRun(thread.id, 'input-validation-run')
    const model = vi.spyOn(modelFactory, 'createChatModel').mockReturnValue(new FakeToolCallingModel({ toolCalls: [[
      { id: 'invalid', name: 'read_file', args: { path: 'package.json', extra: { limit: Infinity } } },
      { id: 'valid', name: 'read_file', args: { path: 'package.json' } }
    ], [{ id: 'corrected', name: 'read_file', args: { path: 'package.json' } }], []] }))
    const managedCalls = new ManagedCallService(database)
    const execute = vi.spyOn(managedCalls, 'start')
    try {
      const instance = await createAgentInstance(thread, database, {
        requestId: 'input-validation-run', prepareWorkspace: false, managedCalls
      })
      try {
        const result = await instance.agent.invoke({ messages: [new HumanMessage('Read the package metadata.')] },
          { configurable: { thread_id: thread.id } })
        const responses = result.messages.filter(ToolMessage.isInstance)
        expect(responses).toMatchObject([
          { tool_call_id: 'invalid', status: 'error', content: expect.stringContaining('/extra/limit') },
          { tool_call_id: 'valid', status: 'success' }, { tool_call_id: 'corrected', status: 'success' }
        ])
        expect((result.messages as AIMessage[]).filter(AIMessage.isInstance)[0].tool_calls?.map(call => call.id)).toEqual(['invalid', 'valid'])
        expect(execute).toHaveBeenCalledTimes(2)
        expect(result).not.toHaveProperty('__interrupt__')
      } finally { await instance.dispose() }
    } finally { model.mockRestore(); await managedCalls.shutdown(); database.close() }
  })

  it('publishes the owning run context before manual compression starts', async () => {
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue({ ...previewConfig(), subagents: [] })
    const database = AgentDatabase.open(':memory:')
    const thread = configuredThread(database, { title: 'Compression status' })
    database.createRun(thread.id, 'compression-run', 'compression')
    const onContextStatus = vi.fn()
    const instance = await createAgentInstance(thread, database, {
      requestId: 'compression-run', prepareWorkspace: false, onContextStatus,
      onCompressionStart: () => {
        expect(onContextStatus.mock.lastCall?.[0]).toMatchObject({
          runId: 'compression-run', maxContextTokens: 100_000, maxOutputTokens: 4_000
        })
        expect(onContextStatus.mock.lastCall?.[0].breakdown.messageTokens).toBeGreaterThan(0)
        return 'summary-1'
      }
    })
    const compress = vi.spyOn(instance.context, 'compress').mockRejectedValue(new Error('Compression probe'))
    try {
      await expect(instance.agent.invoke({ ...manualContextCompressionInput('compression-run'),
        messages: [new HumanMessage('Summarize this input')] },
      { configurable: { thread_id: thread.id }, signal: new AbortController().signal }))
        .rejects.toThrow('Compression probe')
      expect(compress).toHaveBeenCalled()
    } finally { await instance.dispose(); database.close() }
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)(
    'retains %s structured review usage through the production factory and SQLite checkpointer', async protocol => {
    projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), sourceFolders: [process.cwd()], codingMode: true,
      capabilities: { ...structuredClone(defaultCapabilities), toolMode: 'selected', tools: [], memory: false, skills: { enabled: false, mode: 'default', project: false, entries: [] } } })
    const snapshot = { ...previewConfig(), subagents: [] }
    snapshot.providers[0].protocol = protocol
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    const database = AgentDatabase.open(':memory:')
    const thread = configuredThread(database, { title: 'Review' })
    const git = vi.spyOn(gitChanges, 'queryGitChanges').mockResolvedValue({ sourceFolder: process.cwd(), repositoryRoot: process.cwd(), scope: 'workspace',
      head: 'a'.repeat(40), baseline: 'a'.repeat(40), version: 'b'.repeat(64), fileCount: 1, hasMore: false,
      files: [{ path: `${process.cwd()}/example.ts`, relativePath: 'example.ts', status: 'M', source: 'tracked', patchTruncated: false, patch: createPatch('example.ts', 'old\n', 'new\n') }] })
    let fetch: ReturnType<typeof vi.spyOn> | undefined
    try {
      const scope = await captureCodeReview(database, { kind: 'git', projectId: thread.projectId, sourceFolder: process.cwd(), scope: 'workspace', version: 'b'.repeat(64) }, thread.projectId)
      const format = codeReviewResponseFormat(scope)
      const report = { scope_id: scope.id, summary: 'No confirmed defect', findings: [], limitations: [] }
      fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
        const response = protocol === 'anthropic_messages'
          ? { id: 'review-response', type: 'message', role: 'assistant', model: 'preview-model',
              content: [{ type: 'tool_use', id: 'report-call', name: format[0].name, input: report }],
              stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 80000, output_tokens: 50 } }
          : protocol === 'openai_responses'
            ? { id: 'review-response', object: 'response', created_at: 1, status: 'completed', model: 'preview-model',
                output: [{ id: 'report-item', type: 'function_call', call_id: 'report-call', name: format[0].name,
                  arguments: JSON.stringify(report), status: 'completed' }],
                usage: { input_tokens: 80000, output_tokens: 50, total_tokens: 80050 } }
            : { id: 'review-response', object: 'chat.completion', created: 1, model: 'preview-model',
                choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '',
                  tool_calls: [{ id: 'report-call', type: 'function', function: { name: format[0].name, arguments: JSON.stringify(report) } }] } }],
                usage: { prompt_tokens: 80000, completion_tokens: 50, total_tokens: 80050 } }
        return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } })
      })
      database.createRun(thread.id, 'review-run', 'agent', [], { kind: 'user', text: codeReviewPrompt(scope), codeReview: scope })
      expect(database.getRunInputIntent('review-run')).toMatchObject({ codeReview: scope })
      const userMessage = new HumanMessage({ content: codeReviewPrompt(scope),
        additional_kwargs: { anas_display_text: 'Code review', anas_code_review_scope: scope } })
      expect(simpleChatHistory([userMessage])[0].content).toEqual(userMessage.content)
      expect(toAgentMessage(userMessage, 'review-input').content).toEqual([{ type: 'text', text: userMessage.text }])
      const instance = await createAgentInstance(thread, database, { requestId: 'review-run', prepareWorkspace: false })
      try {
        const graphConfig = { configurable: { thread_id: thread.id } }
        const result = await instance.agent.invoke({ messages: [userMessage] }, graphConfig)
        const messages = result.messages as AIMessage[]
        expect(toAgentMessage(messages.at(-1)!, 'final').codeReview?.report).toEqual(report)
        expect(messages.at(-1)!.usage_metadata).toBeUndefined()
        const values = (await database.checkpointer.getTuple(graphConfig))!.checkpoint.channel_values
        const status = await instance.context.projectedStatus(values)
        expect(status.serverUsage).toMatchObject({ inputTokens: 80000, outputTokens: 50, totalTokens: 80050 })
        const providerIndex = messages.findIndex(message => AIMessage.isInstance(message) && message.usage_metadata)
        expect(providerIndex).toBeGreaterThan(0)
        expect(status.currentContextTokens).toBe(80000 + countMessagesApproximately(messages.slice(providerIndex), null, { protocol }))
        for (const message of messages.filter(AIMessage.isInstance)) {
          expect(message.additional_kwargs.anas_run_id).toBe('review-run')
          expect(message.additional_kwargs.anas_project_rules_receipt).toMatchObject({ runId: 'review-run' })
        }
        database.finishRun('review-run', 'completed')
        const nextRunStatus = await projectAgentContextStatus(thread, database, values)
        expect(nextRunStatus.serverUsage).toMatchObject({ inputTokens: 80000, outputTokens: 50, totalTokens: 80050 })
      } finally { await instance.dispose() }
    } finally { fetch?.mockRestore(); git.mockRestore(); database.close() }
  })

  it('exposes supervision tools for persisted unresolved calls when shell and HTTP are disabled', async () => {
    const snapshot = previewConfig()
    snapshot.subagents = []
    projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), capabilities: { ...structuredClone(defaultCapabilities), toolMode: 'selected', tools: [], backgroundTools: false } })
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: snapshot.customTools })
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    const database = AgentDatabase.open(':memory:')
    const agentThread = configuredThread(database, { title: 'Supervise retained call' })
    const priorRun = createUnresolvedManagedCall(database, agentThread)
    database.finishRun(priorRun.id, 'cancelled')
    const currentRun = database.createRun(agentThread.id, 'current-supervision-run')

    try {
      const instance = await createAgentInstance(agentThread, database, {
        requestId: currentRun.id,
        prepareWorkspace: false,
        managedCalls: managedCallContext(database)
      })
      await instance.dispose()

      expect(runtimeToolMocks.createRuntimeTools).toHaveBeenCalledTimes(1)
      expect(runtimeToolMocks.createRuntimeTools).toHaveBeenCalledWith(expect.objectContaining({
        enabled: true,
        shell: false,
        network: false,
        managedCallSupervision: true
      }))
    } finally {
      database.close()
    }
  })

  it('binds MCP tools by per-server policy across catalog changes without affecting builtins', async () => {
    const snapshot = previewConfig()
    snapshot.mcpServers = ['alpha', 'beta'].map((id, index) => ({ id, index, name: id, enabled: true, type: 'stdio', command: 'unused', args: [], env: {}, workingDir: '', timeoutMs: 1000, url: '' }))
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: snapshot.customTools })
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    const runtime = vi.spyOn(mcpRuntimeService, 'getCachedMcpRuntime')
    const database = AgentDatabase.open(':memory:')
    const thread = configuredThread(database, { title: 'MCP policies' })
    const capabilities = { ...structuredClone(defaultCapabilities), mcp: { defaultMode: 'selected' as const, servers: [
      { id: 'alpha', mode: 'all' as const, tools: ['unused_saved_choice'] },
      { id: 'beta', mode: 'selected' as const, tools: ['beta_read'] }
    ] } }
    try {
      for (const alphaNames of [['alpha_search'], ['alpha_new']]) {
        const names = [...alphaNames, 'beta_read', 'beta_new']
        runtime.mockResolvedValue({ tools: names.map((name) => tool(async () => 'ok', { name, description: name, schema: z.object({}) })), loaded: [
          { id: 'alpha', index: 0, name: 'alpha', toolCount: alphaNames.length, toolNames: alphaNames },
          { id: 'beta', index: 1, name: 'beta', toolCount: 2, toolNames: ['beta_read', 'beta_new'] }
        ], errors: [], ping: vi.fn(async () => {}), close: vi.fn(async () => {}) })
        const instance = await createAgentInstance(thread, database, { prepareWorkspace: false, configuration: { customTools: [], codingMode: false, capabilities } })
        await instance.dispose()
        expect(runtimeToolMocks.createRuntimeTools.mock.lastCall?.[0].mcpTools.map((entry: { name: string }) => entry.name)).toEqual([...alphaNames, 'beta_read'])
        expect(runtimeToolMocks.createRuntimeTools.mock.lastCall?.[0].toolNames).toBeUndefined()
      }
      const disabled = { ...capabilities, mcp: { defaultMode: 'selected' as const, servers: [] } }
      runtime.mockClear()
      const instance = await createAgentInstance(thread, database, { prepareWorkspace: false, configuration: { customTools: [], codingMode: false, capabilities: disabled } })
      await instance.dispose()
      expect(runtime).not.toHaveBeenCalled()
      expect(runtimeToolMocks.createRuntimeTools.mock.lastCall?.[0].mcpTools).toEqual([])
    } finally { runtime.mockRestore(); database.close() }
  })

  it('passes the allowed built-in tool set to the runtime when using exclusions', async () => {
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(previewConfig())
    const database = AgentDatabase.open(':memory:')
    const agentThread = configuredThread(database, { title: 'Excluded file tool' })
    try {
      const instance = await createAgentInstance(agentThread, database, {
        prepareWorkspace: false,
        configuration: { customTools: [], codingMode: false, capabilities: { ...structuredClone(defaultCapabilities), toolMode: 'except', tools: ['read_multiple_files'] } }
      })
      await instance.dispose()
      const options = runtimeToolMocks.createRuntimeTools.mock.lastCall?.[0]
      expect(options.toolNames).toContain('read_file')
      expect(options.toolNames).toContain('http_request')
      expect(options.toolNames).not.toContain('read_multiple_files')
    } finally { database.close() }
  })

  it('uses an inherited background setting instead of a later global setting', async () => {
    const snapshot = previewConfig()
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: snapshot.customTools })
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    const database = AgentDatabase.open(':memory:')
    const thread = configuredThread(database, { title: 'Inherited capability' })
    const run = database.createRun(thread.id, 'inherited-background-run')
    const resolved = vi.fn()
    try {
      const instance = await createAgentInstance(thread, database, {
        requestId: run.id,
        prepareWorkspace: false,
        configuration: { customTools: [], codingMode: false, capabilities: { ...structuredClone(defaultCapabilities), backgroundTools: false } },
        onConfigurationResolved: resolved,
        managedCalls: managedCallContext(database)
      })
      await instance.dispose()
      expect(runtimeToolMocks.createRuntimeTools).toHaveBeenCalledWith(expect.objectContaining({ backgroundTools: false }))
      expect(resolved).not.toHaveBeenCalled()
    } finally { database.close() }
  })

  it.each([
    { mode: 'a model without tool use', toolUse: false, simpleChat: false },
    { mode: 'simple chat', toolUse: true, simpleChat: true }
  ])('rejects $mode while the conversation has unresolved background calls', async ({ toolUse, simpleChat }) => {
    const snapshot = previewConfig(toolUse)
    const simpleChatProject: Project = {
      id: 'simple-chat-managed-call',
      name: 'Plain chat',
      kind: 'simple_chat',
      pinned: false,
      collapsed: false,
      prompt: 'Answer plainly.',
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z'
    }
    if (simpleChat) {
      projectStoreMocks.getProject.mockImplementation(async (projectId: string) => (
        projectId === simpleChatProject.id ? simpleChatProject : defaultWorkspaceProject()
      ))
    }
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: snapshot.customTools })
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    const database = AgentDatabase.open(':memory:')
    const agentThread = configuredThread(database, {
      title: 'Unsupported supervision',
      ...(simpleChat ? { projectId: simpleChatProject.id } : {})
    })
    const run = createUnresolvedManagedCall(database, agentThread)

    try {
      const unsupported = createAgentInstance(agentThread, database, {
        requestId: run.id,
        prepareWorkspace: false,
        managedCalls: managedCallContext(database)
      })
      await expect(unsupported).rejects.toBeInstanceOf(ModelSelectionError)
      await expect(unsupported).rejects.toThrow(
        'Continue it in an agent project with a model that supports tool use'
      )
      expect(runtimeToolMocks.createRuntimeTools).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })
  it('treats a model unable to supervise its persisted subagents as a terminal configuration failure', async () => {
    const snapshot = previewConfig(false)
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: snapshot.customTools })
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    const database = AgentDatabase.open(':memory:')
    const thread = configuredThread(database, { title: 'Unsupported child supervision' })
    const run = database.createRun(thread.id, 'unsupported-child-supervision')
    database.createSubagentCall({
      id: 'persisted-child', ownerThreadId: thread.id, parentThreadId: thread.id, parentRunId: run.id,
      childThreadId: 'persisted-child-thread', childRunId: 'persisted-child-run',
      config: snapshot.subagents[0], description: 'Continue delegated work.', childThread: { projectId: thread.projectId }
    })
    try {
      await expect(createAgentInstance(thread, database, { requestId: run.id, prepareWorkspace: false }))
        .rejects.toBeInstanceOf(ModelSelectionError)
    } finally { database.close() }
  })
})

describe('main-agent model call limit', () => {
  it('does not install the main-run limit in an asynchronous subagent graph', async () => {
    langchainMocks.modelCallLimitMiddleware.mockClear()
    projectStoreMocks.getProject.mockResolvedValue(defaultWorkspaceProject())
    memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('')
    const snapshot = previewConfig()
    snapshot.settings.maxModelCallsPerRun = 3
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: snapshot.customTools })
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    const database = AgentDatabase.open(':memory:')
    const owner = configuredThread(database, { title: 'Model limit owner' })
    const child = configuredThread(database, { title: 'Model limit child' })
    const subagentCall = {
      id: '91919191-9191-8191-8191-919191919191',
      ownerThreadId: owner.id,
      parentThreadId: owner.id,
      parentRunId: 'parent-model-limit-run',
      childThreadId: child.id,
      childRunId: 'child-model-limit-run',
      agentName: 'general-purpose',
      config: config().subagents[0],
      description: 'Continue independently.',
      status: 'running' as const,
      createdAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z'
    }

    try {
      const main = await createAgentInstance(owner, database, { prepareWorkspace: false })
      await main.dispose()
      expect(langchainMocks.modelCallLimitMiddleware).toHaveBeenCalledOnce()
      expect(langchainMocks.modelCallLimitMiddleware).toHaveBeenLastCalledWith({
        runLimit: 3,
        exitBehavior: 'error'
      })

      langchainMocks.modelCallLimitMiddleware.mockClear()
      const delegated = await createAgentInstance(child, database, {
        prepareWorkspace: false,
        subagentCall
      })
      await delegated.dispose()
      expect(langchainMocks.modelCallLimitMiddleware).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })
})

describe('user input source', () => {
  it.each([0, 1, 2])('identifies the owning conversation for delegation depth %s', async depth => {
    const snapshot = previewConfig()
    const project = defaultWorkspaceProject()
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: snapshot.customTools })
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    projectStoreMocks.getProject.mockResolvedValue(project)
    memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('')
    const database = AgentDatabase.open(':memory:')
    const owner = configuredThread(database, { title: 'Owning conversation' })
    let thread = owner
    let run = database.createRun(owner.id, 'source-root')
    let call: ReturnType<typeof database.createSubagentCall> | undefined
    try {
      for (let level = 1; level <= depth; level++) {
        call = database.createSubagentCall({
          id: `source-call-${level}`, ownerThreadId: owner.id, parentThreadId: thread.id, parentRunId: run.id,
          parentSubagentId: call?.id, childThreadId: `source-child-${level}`, childRunId: `source-run-${level}`,
          config: snapshot.subagents[0], description: 'Investigate the task.',
          childThread: { title: `Hidden child ${level}`, projectId: owner.projectId }
        })
        thread = database.getThread(call.childThreadId)!
        run = database.getRun(call.childRunId)!
      }
      const instance = await createAgentInstance(thread, database, {
        requestId: run.id, subagentCall: call, prepareWorkspace: false
      })
      try {
        const source = runtimeToolMocks.createRuntimeTools.mock.lastCall![0].userInputSource
        expect(await source()).toEqual({ projectName: project.name, threadTitle: owner.title,
          ...(call ? { agentName: call.agentName } : {}) })
        database.updateThread(owner.id, { title: 'Renamed conversation' })
        projectStoreMocks.getProject.mockResolvedValue({ ...project, name: 'Renamed project' })
        expect(await source()).toEqual({ projectName: 'Renamed project', threadTitle: 'Renamed conversation',
          ...(call ? { agentName: call.agentName } : {}) })
      } finally { await instance.dispose() }
    } finally { database.close() }
  })
})

describe('subagent definition snapshots', () => {
  it.each([false, true])('keeps default selections stable when resuming a run (child %s)', async (child) => {
    const snapshot = previewConfig()
    const base = snapshot.subagents[0]
    snapshot.subagents = [base, { ...base, name: 'reviewer', enabled: false }]
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: snapshot.customTools })
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    projectStoreMocks.getProject.mockResolvedValue(defaultWorkspaceProject())
    const database = AgentDatabase.open(':memory:')
    const owner = configuredThread(database, { title: 'Stable delegation' })
    const parent = database.createRun(owner.id, 'stable-delegation-root')
    const call = child ? database.createSubagentCall({
      id: '12929292-9292-8292-8292-929292929292', ownerThreadId: owner.id, parentThreadId: owner.id, parentRunId: parent.id,
      childThreadId: '13939393-9393-8393-8393-939393939393', childRunId: '14949494-9494-8494-9494-949494949494',
      config: base, description: 'Use defaults.', childThread: { title: 'Child', projectId: owner.projectId }
    }) : undefined
    const tools = vi.spyOn(subagentTools, 'createSubagentTools')
    const resolved = vi.fn()
    const context = { requestId: call?.childRunId ?? parent.id, subagentCall: call, prepareWorkspace: false,
      parentConfiguration: { customTools: [], codingMode: false, capabilities: structuredClone(defaultCapabilities),
        subagentSelection: { mode: 'custom' as const, names: ['general-purpose', 'reviewer'] } } }
    try {
      const thread = call ? database.getThread(call.childThreadId)! : owner
      const first = await createAgentInstance(thread, database, { ...context, onConfigurationResolved: resolved })
      await first.dispose()
      database.resolveRunConfiguration(context.requestId, resolved.mock.lastCall![0])
      const configuration = database.getRunConfiguration(context.requestId)
      snapshot.subagents = snapshot.subagents.map(a => ({ ...a, enabled: !a.enabled }))
      const resumed = await createAgentInstance(thread, database, { ...context, configuration })
      await resumed.dispose()
      const start = tools.mock.results.at(-1)!.value.find((tool: { name: string }) => tool.name === 'start_subagent')
      expect(start.description).toContain('- general-purpose:')
      expect(start.description).not.toContain('- reviewer:')
      const next = await createAgentInstance(thread, database, context)
      await next.dispose()
      const nextStart = tools.mock.results.at(-1)!.value.find((tool: { name: string }) => tool.name === 'start_subagent')
      expect(nextStart.description).toContain('- reviewer:')
      expect(nextStart.description).not.toContain('- general-purpose:')
    } finally { tools.mockRestore(); database.close() }
  })

  it.each((['default', 'custom', 'empty'] as const).flatMap(mode => [false, true].map(nested => ({ mode, nested }))))('intersects a child $mode selection with the root project range (nested $nested)', async ({ mode, nested }) => {
    const snapshot = previewConfig()
    const base = snapshot.subagents[0]
    snapshot.subagents = [base, { ...base, name: 'reviewer', enabled: false }, { ...base, name: 'outside' }]
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: snapshot.customTools })
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    const database = AgentDatabase.open(':memory:')
    const owner = configuredThread(database, { title: 'Delegation selection' })
    const parent = database.createRun(owner.id, 'delegation-root')
    const call = database.createSubagentCall({
      id: '12929292-9292-8292-8292-929292929292', ownerThreadId: owner.id, parentThreadId: owner.id, parentRunId: parent.id,
      childThreadId: '13939393-9393-8393-8393-939393939393', childRunId: '14949494-9494-8494-9494-949494949494',
      config: { ...base, subagentSelection: { mode: mode === 'default' ? 'default' : 'custom', names: mode === 'empty' ? [] : ['reviewer', 'outside'] } },
      description: 'Delegate within the project.', childThread: { title: 'Child', projectId: owner.projectId }
    })
    const tools = vi.spyOn(subagentTools, 'createSubagentTools')
    try {
      const instance = await createAgentInstance(database.getThread(call.childThreadId)!, database, {
        requestId: call.childRunId, subagentCall: call, prepareWorkspace: false,
        parentConfiguration: { customTools: [], codingMode: false, capabilities: structuredClone(defaultCapabilities),
          subagentSelection: { mode: 'custom', names: nested ? ['general-purpose'] : ['general-purpose', 'reviewer'] },
          ...(nested ? { subagentSelectionLimit: { mode: 'custom' as const, names: ['general-purpose', 'reviewer'] } } : {}) }
      })
      await instance.dispose()
      const start = tools.mock.results.at(-1)!.value.find((tool: { name: string }) => tool.name === 'start_subagent')
      if (mode === 'empty') expect(start).toBeUndefined()
      else {
        expect(start.description).toContain(`- ${mode === 'default' ? 'general-purpose' : 'reviewer'}:`)
        expect(start.description).not.toContain('- outside:')
        expect(start.description).not.toContain(`- ${mode === 'default' ? 'reviewer' : 'general-purpose'}:`)
      }
    } finally { tools.mockRestore(); database.close() }
  })

  it.each([false, true])('resolves coding mode %s independently of advanced settings and freezes it on continuation', async (codingMode) => {
    const snapshot = previewConfig()
    snapshot.providers[0].models[0].contextCompressionEnabled = true
    snapshot.defaultModel = { ...snapshot.defaultModel!, contextCompressionEnabled: true }
    const contextFactory = vi.spyOn(contextRuntimeModule, 'createAgentContextRuntime')
    const summaryFactory = vi.spyOn(summarizationModule, 'createAnasSummarizationMiddleware')
    projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), codingMode, advancedSettings: false })
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: snapshot.customTools })
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    const database = AgentDatabase.open(':memory:')
    const owner = configuredThread(database, { title: 'Coding mode' })
    const resolved = vi.fn()
    try {
      const instance = await createAgentInstance(owner, database, { prepareWorkspace: false, onConfigurationResolved: resolved })
      expect(contextFactory.mock.lastCall![0].codingMode).toBe(codingMode)
      expect(summaryFactory.mock.lastCall![0].codingMode).toBe(codingMode)
      const originalStatus = await instance.context.status({ messages: [] })
      await instance.dispose()
      const configuration = resolved.mock.lastCall![0]
      expect(configuration.codingMode).toBe(codingMode)
      expect(configuration.capabilities).toMatchObject({ memory: true, workspace: true, toolMode: 'all' })
      const tools = runtimeToolMocks.createdToolNames.mock.lastCall![0]
      const prompt = await prepareAgentSystemPrompt(owner, snapshot)
      expect(prompt.systemPrompt.text.includes('<coding_instruction>')).toBe(codingMode)
      projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), codingMode: !codingMode, advancedSettings: false })
      resolved.mockClear()
      const resumed = await createAgentInstance(owner, database, { prepareWorkspace: false, configuration, onConfigurationResolved: resolved })
      expect(contextFactory.mock.lastCall![0].codingMode).toBe(codingMode)
      expect(summaryFactory.mock.lastCall![0].codingMode).toBe(codingMode)
      expect((await resumed.context.status({ messages: [] })).breakdown.systemInstructionTokens).toBe(originalStatus.breakdown.systemInstructionTokens)
      await resumed.dispose()
      expect(resolved).not.toHaveBeenCalled()
      expect(runtimeToolMocks.createdToolNames.mock.lastCall![0]).toEqual(tools)
      expect((await prepareAgentSystemPrompt(owner, snapshot, configuration.capabilities, configuration.codingMode)).systemPrompt.text.includes('<coding_instruction>')).toBe(codingMode)
      expect((await prepareAgentSystemPrompt(owner, snapshot)).systemPrompt.text.includes('<coding_instruction>')).toBe(!codingMode)
      const next = await createAgentInstance(owner, database, { prepareWorkspace: false })
      expect(contextFactory.mock.lastCall![0].codingMode).toBe(!codingMode)
      expect(summaryFactory.mock.lastCall![0].codingMode).toBe(!codingMode)
      expect((await next.context.status({ messages: [] })).breakdown.systemInstructionTokens).not.toBe(originalStatus.breakdown.systemInstructionTokens)
      await next.dispose()
    } finally { database.close() }
  })

  it('ignores stored project capability restrictions when advanced settings are off', async () => {
    const project = { ...defaultWorkspaceProject(), advancedSettings: false, prompt: 'Hidden project instruction', restrictSubagents: true,
      capabilities: { ...structuredClone(defaultCapabilities), memory: false, workspace: false, toolMode: 'selected' as const, tools: [] } }
    projectStoreMocks.getProject.mockResolvedValue(project)
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(previewConfig())
    const database = AgentDatabase.open(':memory:')
    const owner = configuredThread(database, { title: 'Default capabilities' })
    const resolved = vi.fn()
    try {
      const instance = await createAgentInstance(owner, database, { prepareWorkspace: false, onConfigurationResolved: resolved })
      await instance.dispose()
      expect(resolved.mock.lastCall![0].capabilities).toMatchObject({ memory: true, workspace: true, toolMode: 'all' })
      expect(resolved.mock.lastCall![0].subagentLimit).toBeUndefined()
      expect(runtimeToolMocks.createdToolNames.mock.lastCall![0]).toContain('save_to_memory')
      expect((await prepareAgentSystemPrompt(owner, previewConfig())).systemPrompt.text).not.toContain('Hidden project instruction')
    } finally { database.close() }
  })

  it.each([false, true].flatMap(customized => [false, true].map(restricted => ({ customized, restricted }))))('uses editable defaults, project overrides, independent children and stable snapshots ($customized, $restricted)', async ({ customized, restricted }) => {
    const snapshot = previewConfig()
    snapshot.defaultCapabilities.capabilities = { ...structuredClone(defaultCapabilities), profile: false,
      memory: false, workspace: false, toolMode: 'selected', tools: ['http_request'] }
    snapshot.defaultCapabilities.restrictSubagents = restricted
    snapshot.subagents.push({ ...snapshot.subagents[0], name: 'reviewer', enabled: false })
    snapshot.defaultCapabilities.subagentSelection = { mode: 'custom', names: ['reviewer'] }
    const project = { ...defaultWorkspaceProject(), advancedSettings: customized, restrictSubagents: restricted,
      capabilities: { ...structuredClone(defaultCapabilities), toolMode: 'selected' as const, tools: ['read_file'] } }
    projectStoreMocks.getProject.mockResolvedValue(project)
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: snapshot.customTools })
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('')
    const database = AgentDatabase.open(':memory:')
    const owner = configuredThread(database, { title: 'Editable defaults' })
    const run = database.createRun(owner.id, 'default-policy-root')
    const resolved = vi.fn()
    try {
      const parent = await createAgentInstance(owner, database, { prepareWorkspace: false, onConfigurationResolved: resolved })
      await parent.dispose()
      const configuration = structuredClone(resolved.mock.lastCall![0])
      const parentTools = runtimeToolMocks.createdToolNames.mock.lastCall![0]
      expect(configuration.capabilities).toMatchObject({ profile: customized, workspace: customized,
        toolMode: 'selected', tools: customized ? ['read_file'] : ['http_request'] })
      expect(Boolean(configuration.subagentLimit)).toBe(restricted)
      expect(configuration.subagentSelection.names).toEqual(customized ? ['general-purpose'] : ['reviewer'])
      const prompt = await prepareAgentSystemPrompt(owner, snapshot)
      expect(prompt.systemPrompt.sections.some(section => section.kind === 'workspace')).toBe(customized)
      const call = database.createSubagentCall({
        id: '12929292-9292-8292-8292-929292929292', ownerThreadId: owner.id, parentThreadId: owner.id, parentRunId: run.id,
        childThreadId: '13939393-9393-8393-8393-939393939393', childRunId: '14949494-9494-8494-9494-949494949494',
        config: { ...snapshot.subagents[0], capabilities: structuredClone(defaultCapabilities) }, description: 'Independent child.',
        childThread: { title: 'Child', projectId: owner.projectId }
      })
      const child = await createAgentInstance(database.getThread(call.childThreadId)!, database, {
        prepareWorkspace: false, subagentCall: call, parentConfiguration: configuration, onConfigurationResolved: resolved
      })
      await child.dispose()
      const childCapabilities = resolved.mock.lastCall![0].capabilities
      expect(childCapabilities.profile).toBe(!restricted || customized)
      expect(childCapabilities.toolMode).toBe(restricted ? 'selected' : 'all')
      snapshot.defaultCapabilities.capabilities = { ...structuredClone(defaultCapabilities), toolMode: 'selected', tools: [] }
      const resumed = await createAgentInstance(owner, database, { prepareWorkspace: false, configuration })
      await resumed.dispose()
      expect(runtimeToolMocks.createdToolNames.mock.lastCall![0]).toEqual(parentTools)
      const next = await createAgentInstance(owner, database, { prepareWorkspace: false, onConfigurationResolved: resolved })
      await next.dispose()
      expect(resolved.mock.lastCall![0].capabilities.tools).toEqual(customized ? ['read_file'] : [])
    } finally { database.close() }
  })

  it.each([false, true])('injects project instructions independently of workspace context (%s)', async (workspace) => {
    const project = { ...defaultWorkspaceProject(), advancedSettings: true, prompt: 'Follow the project rules.',
      capabilities: { ...structuredClone(defaultCapabilities), workspace } }
    projectStoreMocks.getProject.mockResolvedValue(project)
    const prepared = await prepareAgentSystemPrompt(thread(), config())
    const sections = prepared.systemPrompt.sections
    expect(sections.find((section) => section.kind === 'project_instruction')?.content).toContain(project.prompt)
    expect(sections.some((section) => section.kind === 'workspace')).toBe(workspace)
    if (workspace) expect(sections.findIndex((section) => section.kind === 'project_instruction')).toBeLessThan(sections.findIndex((section) => section.kind === 'workspace'))
  })

  it.each((['main', 'independent', 'restricted'] as const).flatMap((scope) => [false, true].map((parentCodingMode) => ({ scope, parentCodingMode }))))('enforces memory tool selection in $scope with parent coding mode $parentCodingMode', async ({ scope, parentCodingMode }) => {
    const project = { customTools: [], ...defaultWorkspaceProject(), codingMode: true, subagentSelection: { mode: 'custom' as const, names: ['general-purpose'] }, capabilities: {
      ...structuredClone(defaultCapabilities), toolMode: 'except' as const, tools: ['save_to_memory', 'forget_memory']
    } }
    projectStoreMocks.getProject.mockResolvedValue(project)
    memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('MEMORY RULES')
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(previewConfig())
    const database = AgentDatabase.open(':memory:')
    const owner = configuredThread(database, { title: 'Memory tool selection' })
    const parentRun = database.createRun(owner.id, 'memory-capability-parent')
    const call = scope === 'main' ? undefined : database.createSubagentCall({
      id: '12929292-9292-8292-8292-929292929292', ownerThreadId: owner.id, parentThreadId: owner.id, parentRunId: parentRun.id,
      childThreadId: '13939393-9393-8393-8393-939393939393', childRunId: '14949494-9494-8494-9494-949494949494',
      config: { ...config().subagents[0], capabilities: structuredClone(defaultCapabilities) }, description: 'Use own capabilities.',
      childThread: { title: 'Child', projectId: owner.projectId }
    })
    const resolved = vi.fn()
    try {
      const instance = await createAgentInstance(call ? database.getThread(call.childThreadId)! : owner, database, {
        onConfigurationResolved: resolved,
        requestId: call?.childRunId ?? parentRun.id, subagentCall: call, prepareWorkspace: false,
        parentConfiguration: { customTools: [], codingMode: parentCodingMode, subagentSelection: { mode: 'custom', names: [] }, capabilities: project.capabilities, ...(scope === 'restricted' ? { subagentLimit: { ...project.capabilities, customTools: selectedTools(), skills: resolveSkillSelection(project.capabilities.skills, []) } } : {}) }
      })
      await instance.dispose()
      expect(resolved.mock.lastCall![0].codingMode).toBe(scope === 'main' || parentCodingMode)
      expect(resolved.mock.lastCall![0].subagentSelection).toEqual(scope === 'main' ? project.subagentSelection : { mode: 'custom', names: [] })
      const actual = runtimeToolMocks.createdToolNames.mock.lastCall![0] as string[]
      expect(actual.filter((name) => ['read_memory', 'save_to_memory', 'forget_memory'].includes(name))).toEqual(
        scope === 'independent' ? ['read_memory', 'save_to_memory', 'forget_memory'] : ['read_memory']
      )
    } finally { database.close() }
  })

  it.each([false, true])('uses the effective project or default custom tool selections (%s)', async customized => {
    const snapshot = previewConfig()
    const definition = { ...customToolDefaults, description: 'Read data.', inputSchema: { type: 'object' }, command: 'node reader.cjs {{args}}' }
    const tools = ['default_reader', 'project_reader', 'unselected_reader'].map(name => toolPackageFixture({ ...definition, id: name, name }))
    snapshot.defaultCapabilities.capabilities.customTools = selectedTools(['default_reader'])
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools })
    projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), advancedSettings: customized,
      capabilities: { ...structuredClone(defaultCapabilities), customTools: selectedTools(['project_reader']) } })
    const database = AgentDatabase.open(':memory:')
    const thread = configuredThread(database)
    const resolved = vi.fn()
    try {
      const instance = await createAgentInstance(thread, database, { prepareWorkspace: false, onConfigurationResolved: resolved })
      await instance.dispose()
      expect(resolved.mock.lastCall![0].customTools.map((tool: { id: string }) => tool.id)).toEqual([customized ? 'project_reader' : 'default_reader'])
    } finally { database.close() }
  })

  it.each([false, true])('resolves same-name custom tools after the root identity ceiling (%s)', async restricted => {
    const snapshot = previewConfig()
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    const base = { ...customToolDefaults, name: 'read_complete', description: 'Read data.',
      inputSchema: { type: 'object', properties: {} }, command: 'node reader.cjs {{args}}' }
    const user = toolPackageFixture({ ...base, id: 'user:reader' })
    const project = { ...toolPackageFixture({ ...base, id: 'project:reader' }), source: 'project' as const, rootId: 'project', rootName: 'Project' }
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: [project, user] })
    const database = AgentDatabase.open(':memory:')
    const owner = configuredThread(database)
    const run = database.createRun(owner.id, 'tool-precedence')
    const call = database.createSubagentCall({
      id: '15959595-9595-8595-8595-959595959595', ownerThreadId: owner.id, parentThreadId: owner.id, parentRunId: run.id,
      childThreadId: '16969696-9696-8696-8696-969696969696', childRunId: '17979797-9797-8797-9797-979797979797',
      config: { ...config().subagents[0], capabilities: { ...structuredClone(defaultCapabilities), customTools: { project: true, entries: [user.id] } } },
      description: 'Read data.', childThread: { title: 'Child', projectId: owner.projectId }
    })
    const limit = { ...structuredClone(defaultCapabilities), customTools: selectedTools([user.id]), skills: resolveSkillSelection(defaultCapabilities.skills, []) }
    const resolved = vi.fn()
    try {
      const instance = await createAgentInstance(database.getThread(call.childThreadId)!, database, {
        requestId: call.childRunId, subagentCall: call, prepareWorkspace: false, onConfigurationResolved: resolved,
        parentConfiguration: { customTools: [], codingMode: false, capabilities: limit, ...(restricted ? { subagentLimit: limit } : {}) }
      })
      await instance.dispose()
      expect(resolved.mock.lastCall![0].customTools.map((tool: { id: string }) => tool.id)).toEqual([restricted ? user.id : project.id])
    } finally { database.close() }
  })

  it.each([false, true])('resolves subagent project skills before applying the root ceiling (%s)', async (restricted) => {
    const project = defaultWorkspaceProject()
    projectStoreMocks.getProject.mockResolvedValue(project)
    memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('')
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(previewConfig())
    const catalog = vi.spyOn(skillsStore, 'listSkillSnapshot').mockResolvedValue({ scriptAutoApprove: false, roots: [], skills: [{ scriptAutoApprove: false,
      id: 'current-project:search', rootId: 'current-project', name: 'search', description: 'Project skill',
      source: 'project', rootName: 'Current project', shortcutAlias: 'project', linked: false,
      modelAvailable: false, userAvailable: false, dirPath: '/project/search', relativePath: 'search'
    }] })
    const prompt = vi.spyOn(skillsStore, 'buildSkillsPrompt').mockResolvedValue('')
    const database = AgentDatabase.open(':memory:')
    const owner = configuredThread(database, { title: 'Project skill rule' })
    const parentRun = database.createRun(owner.id, 'project-skill-parent')
    const call = database.createSubagentCall({
      id: '15959595-9595-8595-8595-959595959595', ownerThreadId: owner.id, parentThreadId: owner.id, parentRunId: parentRun.id,
      childThreadId: '16969696-9696-8696-8696-969696969696', childRunId: '17979797-9797-8797-8797-979797979797',
      config: { ...config().subagents[0], capabilities: { ...structuredClone(defaultCapabilities),
        skills: { enabled: true, mode: 'custom', project: true, entries: [] } } },
      description: 'Use current project skills.', childThread: { title: 'Child', projectId: owner.projectId }
    })
    const resolved = vi.fn()
    const limit = { ...structuredClone(defaultCapabilities), customTools: selectedTools(), skills: { enabled: true, mode: 'custom' as const, project: false,
      entries: [{ id: 'current-project:search', model: false, shortcut: true }] } }
    try {
      const instance = await createAgentInstance(database.getThread(call.childThreadId)!, database, {
        requestId: call.childRunId, subagentCall: call, prepareWorkspace: false,
        parentConfiguration: { customTools: [], codingMode: false, capabilities: limit, ...(restricted ? { subagentLimit: limit } : {}) },
        onConfigurationResolved: resolved
      })
      await instance.dispose()
      const selection = resolved.mock.lastCall![0].capabilities.skills
      expect(selection).toMatchObject({ project: false, entries: [{ id: 'current-project:search', model: !restricted, shortcut: false }] })
      expect(catalog).toHaveBeenCalledWith(owner.projectId, ['/workspace/default'])
      expect(prompt).toHaveBeenCalledWith(owner.projectId, selection, ['/workspace/default'])
    } finally { database.close(); catalog.mockRestore(); prompt.mockRestore() }
  })

  it.each([false, true])('applies a root project ceiling only when enabled (%s)', async (restricted) => {
    const project = { ...defaultWorkspaceProject(), capabilities: { ...structuredClone(defaultCapabilities), memory: false, applicationEnvironment: false, toolMode: 'selected' as const, tools: [] } }
    projectStoreMocks.getProject.mockResolvedValue(project)
    memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('MEMORY RULES')
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(previewConfig())
    const database = AgentDatabase.open(':memory:')
    const owner = configuredThread(database, { title: 'Scoped subagent' })
    const parentRun = database.createRun(owner.id, 'capability-parent')
    const ownCapabilities = { ...structuredClone(defaultCapabilities), toolMode: 'selected' as const, tools: ['read_memory', 'http_request'] }
    const call = database.createSubagentCall({
      id: '12929292-9292-8292-8292-929292929292', ownerThreadId: owner.id, parentThreadId: owner.id, parentRunId: parentRun.id,
      childThreadId: '13939393-9393-8393-8393-939393939393', childRunId: '14949494-9494-8494-8494-949494949494',
      config: { ...config().subagents[0], capabilities: ownCapabilities }, description: 'Use own capabilities.',
      childThread: { title: 'Child', projectId: owner.projectId }
    })
    const resolved = vi.fn()
    try {
      const instance = await createAgentInstance(database.getThread(call.childThreadId)!, database, {
        requestId: call.childRunId, subagentCall: call, prepareWorkspace: false,
        parentConfiguration: { customTools: [], codingMode: false, capabilities: project.capabilities, ...(restricted ? { subagentLimit: { ...project.capabilities, customTools: selectedTools(), skills: resolveSkillSelection(project.capabilities.skills, []) } } : {}) },
        onConfigurationResolved: resolved
      })
      await instance.dispose()
      expect(resolved.mock.lastCall?.[0].capabilities).toMatchObject({ memory: !restricted, applicationEnvironment: !restricted })
      expect(runtimeToolMocks.createRuntimeTools.mock.lastCall?.[0]).toMatchObject({ memory: !restricted, network: !restricted })
    } finally { database.close() }
  })
  it('keeps recovery independent from disabled, deleted, or edited live definitions', async () => {
    projectStoreMocks.getProject.mockResolvedValue(defaultWorkspaceProject())
    memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('')
    runtimeToolMocks.createRuntimeTools.mockClear()
    const database = AgentDatabase.open(':memory:')
    const owner = configuredThread(database, { title: 'Subagent definition owner' })
    const parentRun = database.createRun(owner.id, 'subagent-definition-parent-run')
    const original = {
      ...config().subagents[0],
 capabilities: { ...structuredClone(defaultCapabilities), profile: false, workspace: true, memory: false, toolMode: 'selected' as const, tools: ['read_file'], skills: { enabled: true, mode: 'custom' as const, project: false, entries: [] } },
      preset: undefined,
      builtIn: false,
      name: 'reviewer',
      description: 'Original reviewer definition.',
      systemPrompt: 'Use the original reviewer instructions.',
    }
    const call = database.createSubagentCall({
      id: '92929292-9292-8292-8292-929292929292',
      ownerThreadId: owner.id,
      parentThreadId: owner.id,
      parentRunId: parentRun.id,
      childThreadId: '93939393-9393-8393-8393-939393939393',
      childRunId: '94949494-9494-8494-8494-949494949494',
      config: original,
      description: 'Review independently.',
      childThread: { title: 'Persisted reviewer', projectId: owner.projectId }
    })
    const changed = {
      ...original,
      enabled: true,
      systemPrompt: 'Changed live instructions.',
      capabilities: { ...original.capabilities, workspace: false, memory: true, tools: ['http_request'] }
    }
    const liveDefinitions = [
      [{ ...changed, enabled: false }],
      [],
      [changed]
    ]

    try {
      for (const subagents of liveDefinitions) {
        const snapshot = previewConfig()
        snapshot.subagents = subagents
        appConfigMocks.getAppConfigSnapshot.mockResolvedValueOnce(snapshot)
        const instance = await createAgentInstance(
          database.getThread(call.childThreadId)!,
          database,
          { requestId: call.childRunId, prepareWorkspace: false, subagentCall: call }
        )
        await instance.dispose()
      }

      expect(database.getSubagentCall(call.id, owner.id)?.config).toEqual(original)
      expect(runtimeToolMocks.createRuntimeTools.mock.calls.slice(-3).map(([options]) => ({
        toolNames: options.toolNames,
        memory: options.memory
      }))).toEqual(Array.from({ length: 3 }, () => ({
        toolNames: ['read_call', 'read_call_output', 'write_call', 'wait_call', 'cancel_call', 'read_file'], memory: false
      })))
    } finally {
      database.close()
    }
  })
})

describe('agent tool approval policy', () => {
  it('requires shell approval when read analysis is unavailable until full access is granted', async () => {
    let accessMode: AgentThread['accessMode'] = 'read_only_allowed'
    const policy = createInterruptPolicy({
      availableTools: ['pwsh'],
      commandShellToolName: 'pwsh',
      primaryFolder: process.platform === 'win32'
        ? 'C:\\workspace\\default'
        : '/workspace/default',
      trustedFolders: [],
      accessMode: () => accessMode
    })
    const shellPolicy = policy.pwsh
    expect(shellPolicy).toBeDefined()
    expect(shellPolicy.allowedDecisions).toEqual(['approve', 'reject'])
    expect(shellPolicy.description).toBe('Run a command with pwsh.')
    const request = {
      toolCall: {
        args: { command: 'pwd' }
      }
    }
    const evaluate = shellPolicy.when as unknown as (
      input: typeof request
    ) => boolean | Promise<boolean>

    expect(await evaluate(request)).toBe(true)
    accessMode = 'full_access'
    expect(await evaluate(request)).toBe(false)
  })

  it('requires a checkpointed Shell decision without bypassing project-rule blocks', async () => {
    const policy = createInterruptPolicy({ availableTools: ['pwsh'], commandShellToolName: 'pwsh',
      primaryFolder: process.cwd(), trustedFolders: [process.cwd()], accessMode: () => 'strict_approval', requestId: 'run',
      shellCommandAuthorization: { requiresApproval: vi.fn(), inspect: vi.fn() } })
    const request = { toolCall: { id: 'call', args: { command: 'known read' } },
      state: { anasProjectRules: { runId: 'run', blockedCalls: [] as string[] } } }
    const evaluate = policy.pwsh.when as unknown as (input: typeof request) => Promise<boolean>
    expect(await evaluate(request)).toBe(true)
    request.toolCall.args.command = 'unknown'
    expect(await evaluate(request)).toBe(true)
    request.state.anasProjectRules.blockedCalls.push('call')
    expect(await evaluate(request)).toBe(false)
  })

  it('skips approval only for rule-blocked calls in the current run, never stale checkpoint IDs', async () => {
    const policy = createInterruptPolicy({ availableTools: ['delete_file'], primaryFolder: process.cwd(), trustedFolders: [], accessMode: () => 'strict_approval', requestId: 'current' })
    const request = { toolCall: { id: 'reused-id', name: 'delete_file', args: { path: process.cwd() } },
      state: { anasProjectRules: { runId: 'previous', blockedCalls: ['reused-id'] } } }
    const evaluate = policy.delete_file.when as unknown as (input: typeof request) => Promise<boolean>
    expect(await evaluate(request)).toBe(true)
    request.state.anasProjectRules.runId = 'current'
    expect(await evaluate(request)).toBe(false)
  })

  it('uses the owner conversation access mode for every subagent tool call', async () => {
    const database = AgentDatabase.open(':memory:')
    const owner = configuredThread(database, { accessMode: 'full_access' })
    const child = configuredThread(database, { accessMode: 'full_access' })
    try {
      const policy = createInterruptPolicy({
        availableTools: ['pwsh'],
        commandShellToolName: 'pwsh',
        primaryFolder: process.platform === 'win32'
          ? 'C:\\workspace\\default'
          : '/workspace/default',
        trustedFolders: [],
        accessMode: createAgentAccessModeResolver(database, child.id, {
          ownerThreadId: owner.id
        })
      })
      const request = { toolCall: { args: { command: 'pwd' } } }
      const evaluate = policy.pwsh.when as unknown as (
        input: typeof request
      ) => boolean | Promise<boolean>

      expect(await evaluate(request)).toBe(false)
      database.setAccessMode(owner.id, 'read_only_allowed')
      expect(database.getThread(child.id)?.accessMode).toBe('full_access')
      expect(await evaluate(request)).toBe(true)
    } finally {
      database.close()
    }
  })

  it('registers configuration changes for approval until full access is granted', async () => {
    let accessMode: AgentThread['accessMode'] = 'read_only_allowed'
    const policy = createInterruptPolicy({
      availableTools: ['update_config'],
      primaryFolder: process.platform === 'win32'
        ? 'C:\\workspace\\default'
        : '/workspace/default',
      trustedFolders: [],
      accessMode: () => accessMode
    })
    const configPolicy = policy.update_config
    expect(configPolicy).toBeDefined()
    expect(configPolicy.allowedDecisions).toEqual(['approve', 'reject'])
    expect(configPolicy.description).toBe('Modify application configuration.')
    const request = {
      toolCall: {
        args: { config: 'settings', key: 'theme', value: 'dark' }
      }
    }
    const evaluate = configPolicy.when as unknown as (
      input: typeof request
    ) => boolean | Promise<boolean>

    expect(await evaluate(request)).toBe(true)
    accessMode = 'full_access'
    expect(await evaluate(request)).toBe(false)
  })

  it('reads the access mode for every tool call', async () => {
    let accessMode: AgentThread['accessMode'] = 'read_only_allowed'
    const outsidePath = process.platform === 'win32'
      ? 'C:\\outside\\result.txt'
      : '/outside/result.txt'
    const policy = createInterruptPolicy({
      availableTools: ['delete_file'],
      primaryFolder: process.platform === 'win32'
        ? 'C:\\workspace\\default'
        : '/workspace/default',
      trustedFolders: [],
      accessMode: () => accessMode
    })
    const when = policy.delete_file.when
    expect(typeof when).toBe('function')
    expect(policy.delete_file.allowedDecisions).toEqual(['approve', 'reject'])
    const request = {
      toolCall: {
        args: { path: outsidePath, content: 'done' }
      }
    }
    const evaluate = when as unknown as (
      input: typeof request
    ) => boolean | Promise<boolean>

    expect(await evaluate(request)).toBe(true)
    accessMode = 'full_access'
    expect(await evaluate(request)).toBe(false)
  })

  it.each([true, false])('uses checkpointed restore approval=%s without rewriting model arguments', async (requiresApproval) => {
    const args = { operation_id: 'operation-1', request_id: 'origin-request' }
    const call = { id: 'restore-call', name: 'restore_file_edit', args }
    const state = { anasPatchAuthorization: { runId: 'current-request', calls: [{
      id: call.id, name: call.name, inputHash: createHash('sha256').update(canonicalAgentToolEffectJson(args)).digest('hex'),
      targets: [{ path: '/outside/file.txt', lexicalPath: '/outside/file.txt', locator: ['targets', 0, 'path'], kind: 'file', access: 'write' }], requiresApproval, humanApproved: false
    }] } }
    const policy = createInterruptPolicy({ availableTools: ['restore_file_edit'], primaryFolder: process.cwd(), trustedFolders: [],
      accessMode: () => 'read_only_allowed', requestId: 'current-request' })
    const evaluate = policy.restore_file_edit.when as unknown as (input: { toolCall: typeof call; state: unknown }) => Promise<boolean>
    expect(await evaluate({ toolCall: call, state })).toBe(requiresApproval)
    expect(call.args).toEqual(args)
    expect(call.args).not.toHaveProperty('resolved_path')
    expect(await evaluate({ toolCall: call, state: {} })).toBe(false)
  })
})

describe('simple chat history boundary', () => {
  async function responsesMessage(output: unknown[], stream: boolean): Promise<AIMessage> {
    const response = { id: 'resp_history', object: 'response', created_at: 1, status: 'completed', model: 'reasoning-model',
      output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } as Parameters<typeof convertResponsesMessageToAIMessage>[0]
    if (!stream) return convertResponsesMessageToAIMessage(response)
    async function *events(): Parameters<typeof convertOpenAICompatibleResponsesStream>[0] {
      let sequence_number = 0
      yield { type: 'response.created', sequence_number: sequence_number++, response: { ...response, status: 'in_progress', output: [] } }
      for (let output_index = 0; output_index < response.output.length; output_index++) {
        const item = response.output[output_index]
        yield { type: 'response.output_item.added', sequence_number: sequence_number++, output_index, item }
        if (item.type === 'message') {
          for (let content_index = 0; content_index < item.content.length; content_index++) {
            const part = item.content[content_index]
            if (part.type === 'output_text') yield { type: 'response.output_text.delta', sequence_number: sequence_number++,
              output_index, content_index, item_id: item.id, delta: part.text, logprobs: [] }
          }
        }
        yield { type: 'response.output_item.done', sequence_number: sequence_number++, output_index, item }
      }
      yield { type: 'response.completed', sequence_number: sequence_number++, response }
    }
    return new ChatModelStream(convertOpenAICompatibleResponsesStream(events())).output
  }

  const reasoningItem = (id: string) => ({ type: 'reasoning', id, summary: [{ type: 'summary_text', text: `Useful reasoning ${id}` }],
    encrypted_content: `encrypted-${id}` })
  const callItem = { type: 'function_call', id: 'fc_history', call_id: 'call_history', name: 'read_file', arguments: '{"path":"notes.txt"}', status: 'completed' }
  const textItem = { type: 'message', id: 'msg_history', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'Visible answer', annotations: [] }] }
  const serverItem = { type: 'web_search_call', id: 'search_history', status: 'completed', action: { type: 'search', query: 'Reference' } }

  it.each([false, true].flatMap(stream => [false, true].map(text => ({ stream, text }))))(
    'detaches reasoning from removed Responses client calls (stream=$stream, visible text=$text)', async ({ stream, text }) => {
      const source = await responsesMessage([reasoningItem('rs_client'), callItem, ...(text ? [textItem] : [])], stream)
      const original = JSON.stringify(source)
      const projected = simpleChatHistory([new HumanMessage('Read the notes'), source,
        new ToolMessage({ tool_call_id: 'call_history', content: 'Tool result' }), new HumanMessage('Continue in plain chat')])
      const wire = projectModelInput(projected, { protocol: 'openai_responses' }).messages
      expect(wire).toContainEqual({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Useful reasoning rs_client' }],
        encrypted_content: 'encrypted-rs_client' })
      expect(wire.some(item => typeof item === 'object' && item !== null && 'id' in item && item.id === 'rs_client')).toBe(false)
      expect(JSON.stringify(wire)).not.toContain('call_history')
      expect(JSON.stringify(wire)).not.toContain('Tool result')
      expect(wire).toHaveLength(text ? 4 : 3)
      if (text) expect(wire).toContainEqual(textItem)
      const assistant = projected.find(AIMessage.isInstance)!
      expect(assistant.contentBlocks.filter(block => block.type === 'reasoning').every(block => !('id' in block))).toBe(true)
      if (assistant.additional_kwargs.reasoning) expect(assistant.additional_kwargs.reasoning).not.toHaveProperty('id')
      expect(JSON.stringify(source)).toBe(original)
    }
  )

  it.each([false, true])('retains reasoning IDs paired with surviving provider output (stream=%s)', async stream => {
    const source = await responsesMessage([reasoningItem('rs_server'), serverItem, reasoningItem('rs_text'), textItem,
      reasoningItem('rs_client'), callItem], stream)
    const projected = simpleChatHistory([new HumanMessage('Inspect'), source, new HumanMessage('Continue')])
    const wire = projectModelInput(projected, { protocol: 'openai_responses' }).messages
    expect(wire).toEqual([expect.objectContaining({ role: 'user' }), reasoningItem('rs_server'), serverItem,
      reasoningItem('rs_text'), textItem, expect.objectContaining({ type: 'reasoning', encrypted_content: 'encrypted-rs_client' }),
      expect.objectContaining({ role: 'user' })])
    expect(wire[5]).not.toHaveProperty('id')
  })

  it.each([false, true])('preserves unchanged Responses reasoning replay (stream=%s)', async stream => {
    const source = await responsesMessage([reasoningItem('rs_text'), textItem], stream)
    const projected = simpleChatHistory([new HumanMessage('Inspect'), source, new HumanMessage('Continue')])
    expect(projectModelInput(projected, { protocol: 'openai_responses' }).messages)
      .toEqual(projectModelInput([new HumanMessage('Inspect'), source, new HumanMessage('Continue')], { protocol: 'openai_responses' }).messages)
  })

  it.each(['standard', 'non-standard', 'metadata'] as const)('detaches reasoning in the %s representation without raw output', format => {
    const reason = reasoningItem('rs_client')
    const call = { type: 'tool_call' as const, id: 'call_history', name: 'read_file', args: { path: 'notes.txt' } }
    const source = new AIMessage({ content: format === 'metadata' ? [] : format === 'standard'
      ? [{ ...reason, reasoning: 'Useful reasoning rs_client' }, call]
      : [{ type: 'non_standard', value: reason }, { type: 'non_standard', value: callItem }],
      tool_calls: [call], additional_kwargs: format === 'metadata' ? { reasoning: reason } : {},
      response_metadata: { model_provider: 'openai', ...(format !== 'metadata' ? { output_version: 'v1' } : {}) }
    })
    const wire = projectModelInput(simpleChatHistory([source]), { protocol: 'openai_responses' }).messages
    expect(wire).toHaveLength(1)
    expect(wire[0]).toMatchObject({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Useful reasoning rs_client' }] })
    expect(wire[0]).not.toHaveProperty('id')
  })

  it.each(['openai_responses', 'anthropic_messages'].flatMap(protocol => ['native', 'standard'].map(format => ({
    protocol: protocol as ResolvedModelConfig['protocol'], format
  }))))('removes client calls from actual $protocol/$format replay while retaining text and provider context', ({ protocol, format }) => {
    const call = { id: 'call_1', name: 'read_file', args: { path: 'file.txt' } }
    const responseOutput = [{ type: 'function_call', id: 'fc_1', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args), status: 'completed' },
      { type: 'reasoning', id: 'reasoning_1', summary: [{ type: 'summary_text', text: 'Reasoned' }] },
      { type: 'web_search_call', id: 'search_1', status: 'completed' },
      { type: 'message', id: 'message_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Reading', annotations: [] }] }]
    const content = format === 'standard'
      ? [{ type: 'text', text: 'Reading' }, { type: 'tool_call', ...call }]
      : protocol === 'anthropic_messages'
        ? [{ type: 'text', text: 'Reading' }, { type: 'thinking', thinking: 'Reasoned', signature: 'signed' },
            { type: 'tool_use', id: call.id, name: call.name, input: call.args }]
        : 'Reading'
    const message = new AIMessage({ content, tool_calls: [call], response_metadata: {
      model_provider: protocol === 'anthropic_messages' ? 'anthropic' : 'openai',
      ...(protocol === 'openai_responses' && format === 'native' ? { output: responseOutput } : {})
    } })
    const messages = simpleChatHistory([new HumanMessage('Inspect'), message,
      new ToolMessage({ tool_call_id: call.id, content: 'Tool result' }), new HumanMessage('Explain')])
    const wire = JSON.stringify(projectModelInput(messages, { protocol }))
    expect(wire).not.toContain('call_1')
    expect(wire).not.toContain('read_file')
    expect(wire).not.toContain('Tool result')
    expect(wire).toContain('Reading')
    expect(wire).toContain('Explain')
    if (format === 'native') expect(wire).toContain('Reasoned')
    if (format === 'native' && protocol === 'openai_responses') expect(wire).toContain('web_search_call')
    if (format === 'native' && protocol === 'anthropic_messages') expect(wire).toContain('signed')
  })

  it.each(['openai_responses', 'anthropic_messages'] as const)('omits a client-call-only assistant from %s plain history', protocol => {
    const call = { id: 'call_1', name: 'read_file', args: {} }
    const message = new AIMessage({ tool_calls: [call],
      content: protocol === 'anthropic_messages' ? [{ type: 'tool_use', id: call.id, name: call.name, input: {} }] : '',
      response_metadata: protocol === 'openai_responses' ? { output: [{ type: 'function_call', id: 'fc_1', call_id: call.id,
        name: call.name, arguments: '{}', status: 'completed' }] } : { model_provider: 'anthropic' }
    })
    const messages = simpleChatHistory([new HumanMessage('Inspect'), message,
      new ToolMessage({ tool_call_id: call.id, content: 'Tool result' }), new HumanMessage('Explain')])
    expect(messages.every(HumanMessage.isInstance)).toBe(true)
    expect(JSON.stringify(projectModelInput(messages, { protocol }))).not.toContain('assistant')
  })

  it('keeps conversation, summaries and attachments while removing tool execution state', () => {
    const messages = simpleChatHistory([
      new SystemMessage('Injected system context'),
      new HumanMessage({
        id: 'user-1',
        content: [
          { type: 'text', text: 'Expanded skill instructions' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
        ],
        additional_kwargs: {
          anas_display_text: '/summarize report',
          anas_run_id: 'run-1'
        }
      }),
      new AIMessage({
        id: 'assistant-1',
        content: 'Calling a tool.',
        tool_calls: [{ id: 'call-1', name: 'read_memory', args: {} }],
        additional_kwargs: {
          reasoning: { id: 'rs_1', type: 'reasoning', summary: [] }
        },
        response_metadata: {
          output: [{ id: 'rs_1', type: 'reasoning', summary: [] }]
        }
      }),
      new ToolMessage({ content: 'Private memory content', tool_call_id: 'call-1' }),
      new HumanMessage({
        content: 'Summary containing old tool output.',
        additional_kwargs: { lc_source: 'summarization' }
      })
    ])

    expect(messages).toHaveLength(3)
    expect(messages[0].content).toEqual([
      { type: 'text', text: '/summarize report' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
    ])
    expect((messages[1] as AIMessage).tool_calls).toEqual([])
    expect(messages[1].additional_kwargs.reasoning).toEqual({ type: 'reasoning', summary: [] })
    expect((messages[1].response_metadata as Record<string, unknown>).output)
      .toEqual([{ type: 'reasoning', summary: [] }])
    expect(messages.map((message) => message.text).join('\n')).not.toContain('Private memory content')
    expect(messages.map((message) => message.text).join('\n')).toContain('Summary containing old tool output')
  })
})

describe('prepareAgentSystemPrompt workspace context', () => {
  beforeEach(() => {
    projectStoreMocks.getProject.mockReset()
    memoryStoreMocks.buildMemoryRulesPrompt.mockReset()
    memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('')
  })

  it('includes the built-in default workspace and relative path rules', async () => {
    projectStoreMocks.getProject.mockResolvedValue(defaultWorkspaceProject())

    const prepared = await prepareAgentSystemPrompt(thread(), config())
    const workspace = prepared.systemPrompt.sections.find((section) => section.kind === 'workspace')

    expect(workspace?.content).toContain('The active project is "Default Workspace".')
    expect(workspace?.content).toContain('`/workspace/default`')
    expect(workspace?.content).toContain('Resolve every relative path from the primary/default folder')
  })

  it('includes a tagged workspace context when the task has a project', async () => {
    const project: Project = {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '',
      id: 'project-1',
      name: 'Anas',
      kind: 'workspace',
      pinned: false,
      collapsed: false,
      sourceFolders: ['/workspace/Anas', '/workspace/docs'],
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z'
    }
    projectStoreMocks.getProject.mockImplementation(async (projectId: string) => (
      projectId === project.id ? project : defaultWorkspaceProject()
    ))

    const prepared = await prepareAgentSystemPrompt(thread(project.id), config())
    const workspace = prepared.systemPrompt.sections.find((section) => section.kind === 'workspace')

    expect(workspace?.content).toMatch(/^<workspace_context>\n/)
    expect(workspace?.content).toContain('The active project is "Anas".')
    expect(workspace?.content).toContain('`/workspace/Anas`')
    expect(workspace?.content).toContain('`/workspace/docs`')
    expect(workspace?.content).toContain('relative paths refer only to the primary/default folder')
    expect(workspace?.content).toMatch(/\n<\/workspace_context>$/)
  })

  it('uses only the custom prompt and does not load agent context in simple chat', async () => {
    const project: Project = {
      id: 'simple-chat-1',
      name: 'Plain chat',
      kind: 'simple_chat',
      pinned: false,
      collapsed: false,
      prompt: 'Answer only from the conversation.',
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z'
    }
    projectStoreMocks.getProject.mockImplementation(async (projectId: string) => (
      projectId === project.id ? project : defaultWorkspaceProject()
    ))

    const prepared = await prepareAgentSystemPrompt(thread(project.id), config())

    expect(prepared.systemPrompt.text).toBe('Answer only from the conversation.')
    expect(prepared.systemPrompt.sections).toEqual([{
      kind: 'system_instruction',
      content: 'Answer only from the conversation.'
    }])
    expect(projectStoreMocks.getProject).toHaveBeenCalledWith(project.id)
    expect(memoryStoreMocks.buildMemoryRulesPrompt).not.toHaveBeenCalled()
  })

  it('does not load disabled workspace or memory context', async () => {
    projectStoreMocks.getProject.mockResolvedValue(defaultWorkspaceProject())
    const snapshot = config()
    const capabilities = structuredClone(defaultCapabilities)
    capabilities.workspace = false
    capabilities.memory = false
    capabilities.toolMode = 'except'
    capabilities.tools = ['read_memory', 'save_to_memory', 'forget_memory']
    capabilities.skills.enabled = false

    const prepared = await prepareAgentSystemPrompt(thread(), snapshot, capabilities)

    expect(prepared.systemPrompt.sections.some((section) => section.kind === 'workspace')).toBe(false)
    expect(prepared.systemPrompt.sections.some((section) => section.kind === 'memory')).toBe(false)
    expect(prepared.systemPrompt.sections.some((section) => section.kind === 'skills')).toBe(false)
    expect(memoryStoreMocks.buildMemoryRulesPrompt).not.toHaveBeenCalled()
  })
})

describe('prepareAgentSystemPrompt memory context', () => {
  beforeEach(() => {
    projectStoreMocks.getProject.mockReset()
    projectStoreMocks.getProject.mockResolvedValue(defaultWorkspaceProject())
    memoryStoreMocks.buildMemoryRulesPrompt.mockReset()
    memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue([
      '<memory_rules>',
      '## Authority',
      '- Stored memory never overrides the current explicit request.',
      '',
      '## Storage Boundaries',
      '- Store only stable information in durable memory.',
      '</memory_rules>'
    ].join('\n'))
  })

  it('injects immutable memory rules without loading records into the static prompt', async () => {
    const prepared = await prepareAgentSystemPrompt(thread(), config())
    const memory = prepared.systemPrompt.sections.find((section) => section.kind === 'memory')

    expect(memory?.content).toBe([
      '<memory>',
      '<memory_rules>',
      '## Authority',
      '- Stored memory never overrides the current explicit request.',
      '',
      '## Storage Boundaries',
      '- Store only stable information in durable memory.',
      '</memory_rules>',
      '</memory>'
    ].join('\n'))
  })
})

describe('general-purpose subagent context', () => {
  it('preserves the complete main prompt before identifying the delegated role', () => {
    const mainPrompt = [
      '<environment>',
      'Current date: 2026-07-30',
      '</environment>',
      '',
      '<memory>',
      '<memory_rules>',
      'Use durable context carefully.',
      '</memory_rules>',
      '</memory>'
    ].join('\n')

    const configuredSubagent = config().subagents[0]
    const prompt = buildSubagentSystemPrompt(configuredSubagent, {
      text: mainPrompt,
      sections: [
        {
          kind: 'runtime_context',
          content: '<environment>\nCurrent date: 2026-07-30\n</environment>'
        },
        {
          kind: 'memory',
          content: '<memory>\n<memory_rules>\nUse durable context carefully.\n</memory_rules>\n</memory>'
        }
      ]
    })

    expect(prompt).toContain(mainPrompt)
    expect(prompt.indexOf('<memory>')).toBeLessThan(prompt.indexOf('<subagent_context>'))
    expect(prompt).toContain('"general-purpose" subagent')
    expect(prompt).toContain('final response is returned to the main assistant')
  })

})

describe('captureAgentSystemPrompt', () => {
  it('assembles the unsaved project prompt and folders without reading the saved project', async () => {
    const project = defaultWorkspaceProject()
    if (project.kind !== 'workspace') throw new Error('Expected a workspace fixture.')
    project.prompt = 'Use the unsaved project instructions.'
    project.sourceFolders = [testPaths.root]
    project.codingMode = true
    projectStoreMocks.getProject.mockRejectedValue(new Error('Must use the draft.'))
    memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('')
    const database = AgentDatabase.open(':memory:')
    try {
      const prompt = await captureAgentSystemPrompt(thread(project.id), database, previewConfig(), project)
      expect(prompt).toContain(project.prompt)
      expect(prompt).toContain(testPaths.root)
      expect(prompt).toContain('<coding_instruction>')
      expect(projectStoreMocks.getProject).not.toHaveBeenCalled()
    } finally { database.close() }
  })

  it('does not attach live background-call supervision to a non-persistent preview', async () => {
    projectStoreMocks.getProject.mockResolvedValue(defaultWorkspaceProject())
    memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('')
    const snapshot = previewConfig(false)
    snapshot.subagents = []
    const database = AgentDatabase.open(':memory:')
    const previewThread = configuredThread(database, { title: 'Preview with retained call' })
    createUnresolvedManagedCall(database, previewThread)

    try {
      await expect(captureAgentSystemPrompt(previewThread, database, snapshot))
        .resolves.toContain('<assistant_profile>')
    } finally {
      database.close()
    }
  })

  it('assembles automatic recall for the active agent instance', async () => {
    projectStoreMocks.getProject.mockResolvedValue(defaultWorkspaceProject())
    memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('')
    memoryStoreMocks.createMemoryRecallMiddleware.mockClear()
    const provider = previewProvider()
    const defaultModel = resolveProviderModelConfig(provider, provider.models[0])
    const snapshot: AppConfigSnapshot = {
      ...config(),
      providers: [provider],
      defaultModelId: defaultModel.id,
      defaultModel
    }
    const database = AgentDatabase.open(':memory:')
    const previewThread = configuredThread(database, { title: 'Memory middleware preview' })

    try {
      await captureAgentSystemPrompt(previewThread, database, snapshot)

      expect(memoryStoreMocks.createMemoryRecallMiddleware).toHaveBeenCalledTimes(1)
      expect(memoryStoreMocks.createMemoryRecallMiddleware.mock.calls).toEqual([
        [expect.objectContaining({ enabled: true, projectId: previewThread.projectId })]
      ])
    } finally {
      database.close()
    }
  })

  it('does not silently replace a missing thread-bound model with the global default', async () => {
    const provider = previewProvider()
    const defaultModel = resolveProviderModelConfig(provider, provider.models[0])
    const snapshot: AppConfigSnapshot = {
      ...config(),
      providers: [provider],
      defaultModelId: defaultModel.id,
      defaultModel
    }
    const database = AgentDatabase.open(':memory:')
    const previewThread = configuredThread(database, {
      title: 'Stale model binding',
      modelConfigId: 'deleted-model-config'
    })

    try {
      await expect(captureAgentSystemPrompt(previewThread, database, snapshot))
        .rejects.toThrow('deleted-model-config')
    } finally {
      database.close()
    }
  })

  it('uses the Anas prompt without Deep Agents behavior tutorials', async () => {
    projectStoreMocks.getProject.mockResolvedValue(defaultWorkspaceProject())
    memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('')
    const provider = previewProvider()
    const defaultModel = resolveProviderModelConfig(provider, provider.models[0])
    const snapshot: AppConfigSnapshot = {
      ...config(),
      providers: [provider],
      defaultModelId: defaultModel.id,
      defaultModel
    }
    const database = AgentDatabase.open(':memory:')
    const previewThread = configuredThread(database, { title: 'Preview' })

    try {
      const prompt = await captureAgentSystemPrompt(previewThread, database, snapshot)

      expect(prompt).toContain('<assistant_profile>')
      expect(prompt).toContain('<user_profile>')
      expect(prompt).not.toContain('You are a Deep Agent')
      expect(prompt).not.toContain('## `write_todos`')
      expect(prompt).not.toContain('## `task` (subagent spawner)')
      expect(prompt).not.toContain('## Filesystem Tools')
      expect(languageStoreMocks.resolveConfiguredLanguage).toHaveBeenCalledWith('en')
    } finally {
      database.close()
    }
  })

  it('sends exactly the custom prompt in simple chat mode', async () => {
    const skillCatalog = vi.spyOn(skillsStore, 'listSkillSnapshot').mockRejectedValue(new Error('Skill catalog must not be used by simple chat.'))
    const project: Project = {
      id: 'simple-chat-1',
      name: 'Plain chat',
      kind: 'simple_chat',
      pinned: false,
      collapsed: false,
      prompt: 'You are a plain conversational model.',
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z'
    }
    projectStoreMocks.getProject.mockImplementation(async (projectId: string) => (
      projectId === project.id ? project : defaultWorkspaceProject()
    ))
    const provider = previewProvider()
    const defaultModel = resolveProviderModelConfig(provider, provider.models[0])
    const snapshot: AppConfigSnapshot = {
      ...config(),
      providers: [provider],
      defaultModelId: defaultModel.id,
      defaultModel
    }
    const database = AgentDatabase.open(':memory:')
    const previewThread = configuredThread(database, { title: 'Simple chat preview', projectId: project.id })

    try {
      await expect(captureAgentSystemPrompt(previewThread, database, snapshot))
        .resolves.toBe('You are a plain conversational model.')
      expect(skillCatalog).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })
})

describe('captureAgentModelRequest', () => {
  it.each([false, true].flatMap(backgroundTools => [false, true].map(selected => ({ backgroundTools, selected }))))('offers custom PTY tools and input only when selected with background tools ($backgroundTools/$selected)', async ({ backgroundTools, selected }) => {
    const snapshot = previewConfig()
    snapshot.customTools = [false, true].map(interactive => toolPackageFixture({ ...customToolDefaults, interactive,
      id: interactive ? 'interactive' : 'ordinary', name: interactive ? 'ask_custom' : 'read_custom',
      description: 'Custom fixture.', command: 'node fixture.cjs {{args}}', inputSchema: { type: 'object', properties: {} } }))
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: snapshot.customTools })
    projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), advancedSettings: true,
      capabilities: { ...structuredClone(defaultCapabilities), backgroundTools, subagents: false, planning: false,
        toolMode: 'selected', tools: [], customTools: selectedTools(['ordinary', ...(selected ? ['interactive'] : [])]),
        mcp: { defaultMode: 'selected', servers: [] } } })
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = configuredThread(database)
      const preview = JSON.parse(await captureAgentModelRequest(thread, database, snapshot, managedCallContext(database)))
      const names = preview.request.body.tools.map((entry: { name?: string; function?: { name: string } }) => entry.function?.name ?? entry.name)
      expect(names).toContain('read_custom')
      expect(names.includes('ask_custom')).toBe(backgroundTools && selected)
      expect(names.includes('write_call')).toBe(backgroundTools && selected)
      expect(names.some(isCommandShellToolName)).toBe(false)
    } finally { database.close() }
  })
  it.each(['openai_responses', 'openai_chat_completions', 'anthropic_messages'] as const)(
    'orders selected tools and reordered MCP servers in the actual %s request', async (protocol) => {
      const snapshot = previewConfig()
      snapshot.providers[0].protocol = protocol
      snapshot.defaultModel = resolveProviderModelConfig(snapshot.providers[0], snapshot.providers[0].models[0])
      snapshot.customTools = ['second', 'first', 'hidden'].map((id) => toolPackageFixture({ ...customToolDefaults, id, name: `submit_${id}`, description: 'Submit data.', command: 'python /preview-only.py {{args}}', inputSchema: { type: 'object', properties: {} } }))
      vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: snapshot.customTools })
      snapshot.mcpServers = ['beta', 'alpha'].map((id, index) => ({
        id, index, name: id, enabled: true, type: 'stdio', command: 'unused', args: [], env: {}, workingDir: '', timeoutMs: 1000, url: ''
      }))
      projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), advancedSettings: true,
        capabilities: { ...structuredClone(defaultCapabilities), subagents: false, planning: true,
          toolMode: 'selected', tools: ['http_request', 'run_shell', 'read_file'], customTools: selectedTools(['first', 'second']),
          mcp: { defaultMode: 'all', servers: [{ id: 'alpha', mode: 'selected', tools: ['mcp_alpha_only'] }] } } })
      const names = ['mcp_alpha_only', 'mcp_alpha_hidden', 'mcp_beta_second', 'mcp_beta_first']
      vi.spyOn(mcpRuntimeService, 'getCachedMcpRuntime').mockResolvedValue({
        tools: names.map((name) => tool(async () => 'ok', { name, description: name, schema: z.object({}) })),
        loaded: [
          { id: 'alpha', index: 1, name: 'alpha', toolCount: 2, toolNames: names.slice(0, 2) },
          { id: 'beta', index: 0, name: 'beta', toolCount: 2, toolNames: names.slice(2) }
        ], errors: [], ping: vi.fn(), close: vi.fn()
      })
      const database = AgentDatabase.open(':memory:')
      try {
        const owner = configuredThread(database, { title: 'Ordered tools' })
        const preview = JSON.parse(await captureAgentModelRequest(owner, database, snapshot, managedCallContext(database)))
        const actual = preview.request.body.tools.map((entry: { name?: string; function?: { name: string } }) =>
          entry.function?.name ?? entry.name).map((name: string) => isCommandShellToolName(name) ? 'run_shell' : name)
        expect(actual).toEqual([
          'write_todos', 'read_call', 'read_call_output', 'write_call', 'wait_call', 'cancel_call',
          'read_file', 'run_shell', 'http_request', 'submit_second', 'submit_first', 'mcp_beta_second', 'mcp_beta_first', 'mcp_alpha_only'
        ])
      } finally { database.close() }
    }
  )

  it.each([false, true])('binds tools in catalog order for a running agent (child %s)', async (child) => {
    const snapshot = previewConfig()
    snapshot.providers[0].protocol = 'openai_responses'
    snapshot.providers[0].parameters = { tools: [{ type: 'web_search' }] }
    snapshot.defaultModel = resolveProviderModelConfig(snapshot.providers[0], snapshot.providers[0].models[0])
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: snapshot.customTools })
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    projectStoreMocks.getProject.mockResolvedValue(defaultWorkspaceProject())
    const model = new FakeToolCallingModel()
    const bindings = vi.spyOn(model, 'bindTools')
    vi.spyOn(modelFactory, 'createChatModel').mockReturnValue(model as never)
    const database = AgentDatabase.open(':memory:')
    const owner = configuredThread(database, { title: 'Tool ordering' })
    const run = database.createRun(owner.id, 'tool-order-root')
    const call = child ? database.createSubagentCall({
      id: '12929292-9292-8292-8292-929292929292', ownerThreadId: owner.id, parentThreadId: owner.id, parentRunId: run.id,
      childThreadId: '13939393-9393-8393-8393-939393939393', childRunId: '14949494-9494-8494-9494-949494949494',
      config: snapshot.subagents[0], description: 'Verify tool order.', childThread: { title: 'Child', projectId: owner.projectId }
    }) : undefined
    try {
      const instance = await createAgentInstance(call ? database.getThread(call.childThreadId)! : owner, database, {
        requestId: call?.childRunId ?? run.id, subagentCall: call, prepareWorkspace: false,
        managedCalls: managedCallContext(database),
        parentConfiguration: { customTools: [], codingMode: false, capabilities: structuredClone(defaultCapabilities) }
      })
      try {
        await instance.agent.invoke({ messages: [new HumanMessage('Check available tools.')] }, {
          configurable: { thread_id: call?.childThreadId ?? owner.id }
        })
        expect(bindings).toHaveBeenCalled()
        for (const [tools] of bindings.mock.calls) {
          const definitions = tools as Array<{ name?: string; type?: string }>
          const names = definitions.flatMap((entry) => entry.name ? [entry.name] : [])
            .map((name) => isCommandShellToolName(name) ? 'run_shell' : name)
          expect(names).toEqual(orderedToolCatalog.map((entry) => entry.id).filter((id) => names.includes(id)))
          expect(names[0]).toBe('write_todos')
          expect(names).toContain('read_subagent')
          expect(definitions.at(-1)).toEqual({ type: 'web_search' })
        }
      } finally { await instance.dispose() }
    } finally { database.close() }
  })

  it.each([
    { vision: true, selected: false, expected: ['view_image', 'view_multiple_images'] },
    { vision: false, selected: false, expected: [] },
    { vision: true, selected: true, expected: ['view_multiple_images'] }
  ])('advertises image tools according to model vision $vision and selection $selected', async ({ vision, selected, expected }) => {
    const snapshot = previewConfig()
    snapshot.providers[0].models[0].capabilities.vision = vision
    snapshot.defaultModel = resolveProviderModelConfig(snapshot.providers[0], snapshot.providers[0].models[0])
    projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), advancedSettings: true,
      capabilities: { ...structuredClone(defaultCapabilities), ...(selected ? { toolMode: 'selected', tools: ['view_multiple_images'] } : {}) } })
    const database = AgentDatabase.open(':memory:')
    try {
      const owner = configuredThread(database, { title: 'Image tools' })
      const preview = JSON.parse(await captureAgentModelRequest(owner, database, snapshot, managedCallContext(database)))
      const names = preview.request.body.tools.map((entry: { function: { name: string } }) => entry.function.name)
      expect(names.filter((name: string) => ['view_image', 'view_multiple_images'].includes(name))).toEqual(expected)
    } finally { database.close() }
  })

  it.each([
    { mode: 'custom' as const, names: ['researcher', 'disabled-agent'], advanced: true, expected: ['researcher', 'disabled-agent'] },
    { mode: 'custom' as const, names: [], advanced: true, expected: [] },
    { mode: 'default' as const, names: [], advanced: true, expected: ['general-purpose', 'researcher'] },
    { mode: 'custom' as const, names: [], advanced: false, expected: ['general-purpose', 'researcher'] }
  ])('advertises only project-selected subagents ($mode, advanced $advanced, names $names)', async ({ mode, names, advanced, expected }) => {
    const snapshot = previewConfig()
    snapshot.subagents = [snapshot.subagents[0], { ...snapshot.subagents[0], name: 'researcher', description: 'Research only' },
      { ...snapshot.subagents[0], name: 'disabled-agent', enabled: false }]
    projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), advancedSettings: advanced,
      restrictSubagents: false, subagentSelection: { mode, names } })
    const database = AgentDatabase.open(':memory:')
    try {
      const owner = configuredThread(database, { title: 'Selected agents' })
      const preview = JSON.parse(await captureAgentModelRequest(owner, database, snapshot, managedCallContext(database)))
      const tools = preview.request.body.tools.map((entry: { function?: { name: string; description: string }; name: string; description: string }) => entry.function ?? entry)
      const start = tools.find((entry: { name: string }) => entry.name === 'start_subagent')
      if (!expected.length) expect(start).toBeUndefined()
      else for (const name of ['general-purpose', 'researcher', 'disabled-agent']) {
        expect(start.description.includes(`- ${name}:`)).toBe(expected.includes(name))
      }
      expect(tools.map((entry: { name: string }) => entry.name)).toEqual(expect.arrayContaining(['read_subagent', 'wait_subagent', 'cancel_subagent']))
    } finally { database.close() }
  })

  it.each((['openai_responses', 'openai_chat_completions', 'anthropic_messages'] as const)
    .flatMap((protocol) => [true, false].flatMap((backgroundTools) => [true, false].map((codingMode) => ({ protocol, backgroundTools, codingMode })))))(
    'captures the complete $protocol request with background tools $backgroundTools and coding mode $codingMode without network access',
    async ({ protocol, backgroundTools, codingMode }) => {
      projectStoreMocks.getProject.mockResolvedValue(defaultWorkspaceProject())
      memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('Remember the current task.')
      const provider = {
        ...previewProvider(),
        protocol,
        ...(protocol === 'openai_responses'
          ? {
              parameters: { tools: [{ type: 'web_search' }] }
            }
          : {})
      }
      const defaultModel = resolveProviderModelConfig(provider, provider.models[0])
      const snapshot: AppConfigSnapshot = {
        ...config(),
        providers: [provider],
        defaultModelId: defaultModel.id,
        defaultModel
      }
      projectStoreMocks.getProject.mockResolvedValue({ customTools: [], ...defaultWorkspaceProject(), codingMode, capabilities: { ...structuredClone(defaultCapabilities), backgroundTools } })
      const database = AgentDatabase.open(':memory:')
      const previewThread = configuredThread(database, { title: 'Request preview' })
      const networkFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        new Error('Unexpected network access.')
      )

      try {
        const content = await captureAgentModelRequest(
          previewThread,
          database,
          snapshot,
          managedCallContext(database)
        )
        const preview = JSON.parse(content) as {
          simulated_input: string
          request: {
            headers: Record<string, string>
            body: {
              input?: unknown[]
              model: string
              messages?: unknown[]
              tools: unknown[]
            }
          }
        }

        expect(preview.simulated_input).toBe('hello world')
        expect(preview.request.headers[protocol === 'anthropic_messages' ? 'x-api-key' : 'authorization'])
          .toBe(protocol === 'anthropic_messages' ? 'test' : 'Bearer test')
        expect(preview.request.body.model).toBe('preview-model')
        expect(JSON.stringify(preview.request.body.messages ?? preview.request.body.input)).toContain('hello world')
        const requestText = JSON.stringify(preview.request.body)
        expect(requestText.split('<coding_instruction>').length - 1).toBe(codingMode ? 1 : 0)
        const toolDefinitions = preview.request.body.tools.flatMap((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return []
          const definition = value as Record<string, unknown>
          if (typeof definition.name === 'string') return [definition]
          const functionDefinition = definition.function
          return functionDefinition
            && typeof functionDefinition === 'object'
            && !Array.isArray(functionDefinition)
            && typeof (functionDefinition as Record<string, unknown>).name === 'string'
            ? [functionDefinition as Record<string, unknown>]
            : []
        })
        const toolNames = toolDefinitions.map((definition) => definition.name)
        const normalizedNames = toolNames.map((name) => isCommandShellToolName(String(name)) ? 'run_shell' : name)
        expect(normalizedNames).toEqual(orderedToolCatalog.map((entry) => entry.id).filter((id) => normalizedNames.includes(id)))
        expect(toolNames).toEqual(expect.arrayContaining([
          'write_todos',
          'start_subagent',
          'read_subagent',
          'wait_subagent',
          'cancel_subagent'
        ]))
        const readFile = toolDefinitions.find((definition) => definition.name === 'read_file')
        expect(readFile).toBeDefined()
        expect(String(readFile?.description).includes('10 seconds')).toBe(backgroundTools)
        for (const name of ['read_call', 'read_call_output', 'wait_call', 'cancel_call']) {
          expect(toolNames.includes(name)).toBe(backgroundTools)
        }
        expect(toolNames).not.toContain('task')
        if (protocol === 'openai_responses') {
          expect(preview.request.body.tools).toContainEqual(expect.objectContaining({ type: 'web_search' }))
        }
        expect(networkFetch).not.toHaveBeenCalled()
      } finally {
        networkFetch.mockRestore()
        database.close()
      }
    }
  )
})
