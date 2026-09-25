import { defaultCapabilities, } from '@shared/agentCapabilities'
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons'
import { ToolInputParsingException } from '@langchain/core/tools'
import { ChatModelStream } from '@langchain/core/language_models/stream'
import type { ChatModelStreamEvent } from '@langchain/core/language_models/event'
import { Command } from '@langchain/langgraph'
import { uuid6 } from '@langchain/langgraph-checkpoint'
import { createDeepAgent } from 'deepagents'
import { createAgent, createMiddleware, FakeToolCallingModel, tool } from 'langchain'
import { z } from 'zod'
import { createManagedCallSupervisionMiddleware } from './managedCallSupervisionMiddleware'
import { createAgentRunLifecycleMiddleware } from './runLifecycleMiddleware'
import { hasUnresolvedBackgroundTasks } from './backgroundTaskCleanup'
import { backgroundCleanupCompleted, backgroundCleanupStarted, backgroundCleanupUnconfirmed } from '@shared/backgroundCleanup'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuntimeEvent, AgentThread } from '@shared/agentTypes'
import type { SubagentConfig } from '@shared/types'
import {
  AgentDatabase,
  type AgentSubagentCallRecord,
  type StagedContextSummaryDetails
} from './agentDatabase'
import { AgentRuntime as ProductionAgentRuntime, snapshotContextStatus } from './agentRuntime'
import { createSubagentTools, type SubagentProcessSnapshot, type SubagentToolRuntime } from './subagentTools'
import { createToolInputErrorMiddleware } from './toolInputErrors'
import { createAgentToolEffectMiddleware } from './toolEffectMiddleware'
import { toHumanMessage } from './messageMapper'
import { ManagedCallService } from './managedCallService'
import { ModelSelectionError, resolveThreadModelSelection } from './modelSelection'
import * as modelSelection from './modelSelection'
import { defaultModelConfig, modelContextKey } from '@shared/modelConfig'
import type { ResolvedModelConfig } from '@shared/types'
import { ModelRequestChangedError } from './modelRequestValidation'
import {
  currentAgentToolEffectArtifactId,
  runWithCurrentAgentToolEffect
} from './toolEffectScope'

const runtimeLogMock = vi.hoisted(() => vi.fn())

vi.mock('../runtimeLogger', () => ({
  runtimeLog: runtimeLogMock
}))

vi.mock('../projectStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('../projectStore')>(),
  getProject: vi.fn(async (projectId: string) => ({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, advancedSettings: true, prompt: '',
    id: projectId,
    name: projectId === 'default-workspace' ? 'Default Workspace' : 'Test Project',
    kind: 'workspace' as const,
    pinned: false,
    collapsed: false,
    sourceFolders: [process.cwd()],
    createdAt: '2026-08-14T00:00:00.000Z',
    updatedAt: '2026-08-14T00:00:00.000Z'
  }))
}))

function subagentConfig(
  name: string,
  overrides: Partial<SubagentConfig> = {}
): SubagentConfig {
  return {
 capabilities: { ...structuredClone(defaultCapabilities), profile: false, workspace: true, memory: true, toolMode: 'all', tools: [], skills: { enabled: true, mode: 'default', project: false, entries: [] } },
    index: 0,
    name,
    enabled: true,
    builtIn: false,
    description: `Configured ${name} subagent.`,
    systemPrompt: `Act as the ${name} subagent.`,
    ...overrides
  }
}

async function collect(events: AsyncIterable<AgentRuntimeEvent>): Promise<AgentRuntimeEvent[]> {
  const result: AgentRuntimeEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

async function currentApprovalGeneration(
  runtime: ProductionAgentRuntime,
  threadId: string,
  interruptId: string
): Promise<string> {
  const interrupt = (await runtime.getSnapshot(threadId)).interrupts
    .find((candidate) => candidate.id === interruptId)
  if (!interrupt) throw new Error(`Interrupt ${interruptId} was not found in the current snapshot.`)
  return interrupt.approvalGeneration
}

async function putRootCheckpoint(
  target: AgentDatabase,
  threadId: string,
  checkpointId: string,
  values: Record<string, unknown> = {}
): Promise<void> {
  await target.checkpointer.put({
    configurable: { thread_id: threadId, checkpoint_ns: '' }
  }, {
    v: 4,
    id: checkpointId,
    ts: new Date().toISOString(),
    channel_values: values,
    channel_versions: {},
    versions_seen: {}
  }, {
    source: 'update',
    step: 0,
    parents: {}
  })
}

let durableCheckpointSequence = 0

function nextDurableCheckpointId(): string {
  durableCheckpointSequence += 1
  return uuid6(durableCheckpointSequence)
}

async function markRunCompleted(
  target: AgentDatabase,
  threadId: string,
  runId: string,
  values: unknown = {}
): Promise<void> {
  const checkpoint = target.getRunCheckpointState(runId)
  if (
    checkpoint.terminalCheckpointId
    && checkpoint.terminalCheckpointId === checkpoint.lastCommittedCheckpointId
  ) return
  await putRootCheckpoint(
    target,
    threadId,
    nextDurableCheckpointId(),
    {
      ...(values && typeof values === 'object' && !Array.isArray(values) ? values : {}),
      anasRunLifecycle: { runId, status: 'completed' }
    }
  )
}

async function markRunInterrupted(
  target: AgentDatabase,
  threadId: string,
  runId: string,
  interruptId = `${runId}-interrupt`,
  values: unknown = {},
  interruptValue: unknown = { reason: 'test approval' }
): Promise<void> {
  const current = target.getRunCheckpointState(runId)
  if (current.lastCommittedCheckpointId && !current.resumeIntent) {
    const tuple = await target.checkpointer.getTuple({
      configurable: {
        thread_id: threadId,
        checkpoint_ns: '',
        checkpoint_id: current.lastCommittedCheckpointId
      }
    })
    if (tuple?.pendingWrites?.some(([, channel]) => channel === '__interrupt__')) return
  }
  const checkpointId = nextDurableCheckpointId()
  await putRootCheckpoint(
    target,
    threadId,
    checkpointId,
    {
      ...(values && typeof values === 'object' && !Array.isArray(values) ? values : {}),
      anasRunLifecycle: { runId, status: 'running' }
    }
  )
  await target.checkpointer.putWrites({
    configurable: {
      thread_id: threadId,
      checkpoint_ns: '',
      checkpoint_id: checkpointId
    }
  }, [[
    '__interrupt__',
    [{ id: interruptId, value: interruptValue }]
  ]], `${runId}-interrupt-task`)
}

type TestAgentRuntimeConstructor = ConstructorParameters<typeof ProductionAgentRuntime>
type TestAgentInstanceFactory = NonNullable<TestAgentRuntimeConstructor[1]>

function withDurableMockCheckpoints(
  target: AgentDatabase,
  instanceFactory: TestAgentInstanceFactory
): TestAgentInstanceFactory {
  return async (thread, database, context) => {
    const instance = await instanceFactory(thread, database, context)
    const originalStreamEvents = instance.agent.streamEvents.bind(instance.agent)
    instance.agent.streamEvents = async (input, config) => {
      const stream = await originalStreamEvents(input, config)
      const runId = context?.requestId
      if (!runId) return stream
      const targetStream = stream as unknown as {
        interrupted: boolean
        interrupts: Array<{ interruptId: string; payload: unknown }>
        readonly output: Promise<unknown>
        [Symbol.asyncIterator](): AsyncIterator<unknown>
      }
      const output = targetStream.output
      const originalIterator = targetStream[Symbol.asyncIterator].bind(targetStream)
      let settleProtocol!: () => void
      const protocolSettled = new Promise<void>((resolve) => {
        settleProtocol = resolve
      })
      const protocolIterator = async function *() {
        try {
          const source = { [Symbol.asyncIterator]: originalIterator }
          yield * source
        } finally {
          settleProtocol()
        }
      }
      const durableOutput = Promise.resolve(output).then(async (value) => {
        // DeepAgent discovers framework interrupts while its protocol stream
        // is consumed, which can finish after the output promise resolves.
        await protocolSettled
        if (targetStream.interrupted) {
          await markRunInterrupted(
            target,
            thread.id,
            runId,
            targetStream.interrupts[0]?.interruptId,
            value,
            targetStream.interrupts[0]?.payload
          )
        } else {
          await markRunCompleted(target, thread.id, runId, value)
        }
        return value
      })
      return new Proxy(stream, {
        get(streamTarget, property) {
          if (property === 'output') return durableOutput
          if (property === Symbol.asyncIterator) return protocolIterator
          if (property === 'messages') return (async function *() {
            for await (const message of streamTarget.messages) {
              // Lightweight model mocks must expose the native raw-event iterator too.
              yield Symbol.asyncIterator in message ? message : Object.assign(message, {
                [Symbol.asyncIterator]: empty
              })
            }
          })()
          const value = Reflect.get(streamTarget, property, streamTarget)
          return typeof value === 'function' ? value.bind(streamTarget) : value
        }
      })
    }
    return instance
  }
}

// Runtime mocks still obey the production durability contract: resolving a
// mocked framework stream first persists the same completed lifecycle or
// interrupt evidence that the real DeepAgent graph writes before it settles.
class AgentRuntime extends ProductionAgentRuntime {
  constructor(
    database: TestAgentRuntimeConstructor[0],
    instanceFactory?: TestAgentRuntimeConstructor[1],
    temporaryRoot?: TestAgentRuntimeConstructor[2],
    cleanupFileEdits?: TestAgentRuntimeConstructor[3]
  ) {
    super(
      database,
      instanceFactory
        ? withDurableMockCheckpoints(database, instanceFactory)
        : undefined,
      temporaryRoot,
      cleanupFileEdits ?? (async () => {})
    )
  }
}

async function stageAndCommitSummary(
  target: AgentDatabase,
  threadId: string,
  runId: string,
  summaryId: string,
  details: StagedContextSummaryDetails
): Promise<void> {
  target.stageContextSummary(runId, summaryId, details)
  const checkpointId = nextDurableCheckpointId()
  await putRootCheckpoint(target, threadId, checkpointId)
  target.commitContextSummary(runId, summaryId, checkpointId)
}

async function *empty<T>(): AsyncGenerator<T> {}

function mockProtocolStream<T extends object>(stream: T): T & AsyncIterable<never> {
  return Object.assign(stream, { [Symbol.asyncIterator]: empty })
}

function completedStream(
  text: string,
  diagnostics?: {
    usage?: unknown
    responseMetadata?: unknown
    reasoning?: string
    reasoningSummary?: string
    runId?: string
  }
) {
  const assistant = new AIMessage({
    id: 'assistant-1',
    additional_kwargs: diagnostics?.runId
      ? { anas_run_id: diagnostics.runId }
      : {},
    content: diagnostics?.reasoning && diagnostics.reasoningSummary
      ? [
          {
            type: 'reasoning',
            reasoning: diagnostics.reasoning,
            summary: [{ type: 'summary_text', text: diagnostics.reasoningSummary }]
          },
          { type: 'text', text }
        ]
      : text
  })
  Object.assign(assistant, {
    usage_metadata: diagnostics?.usage,
    response_metadata: diagnostics?.responseMetadata
  })
  return mockProtocolStream({
    interrupted: false,
    interrupts: [],
    messages: (async function *() {
      yield {
        text: (async function *() { yield text })(),
        reasoning: diagnostics?.reasoning
          ? (async function *() { yield diagnostics.reasoning as string })()
          : empty<string>(),
        output: Promise.resolve(assistant)
      }
    })(),
    toolCalls: empty(),
    subagents: empty(),
    output: Promise.resolve({
      messages: [
        new HumanMessage({ id: 'human-1', content: 'Hello' }),
        assistant
      ],
      todos: [{ content: 'Answer', status: 'completed' }]
    }),
    abort() {}
  })
}

function todoUpdateStream() {
  const todos = [
    { content: 'Inspect the runtime', status: 'completed' as const },
    { content: 'Build the plan UI', status: 'in_progress' as const }
  ]
  return mockProtocolStream({
    interrupted: false,
    interrupts: [],
    messages: empty(),
    toolCalls: (async function *() {
      yield {
        callId: 'todo-call-1',
        name: 'write_todos',
        input: { todos },
        output: Promise.resolve('Updated todo list'),
        status: Promise.resolve('finished' as const),
        error: Promise.resolve(undefined)
      }
    })(),
    subagents: empty(),
    output: Promise.resolve({
      messages: [new HumanMessage({ id: 'human-todos', content: 'Make a plan' })],
      todos
    }),
    abort() {}
  })
}

function interruptedStream() {
  return mockProtocolStream({
    interrupted: true,
    interrupts: [{
      interruptId: 'approval-1',
      payload: { actionRequests: [{ name: 'execute', args: { command: 'npm test' } }] }
    }],
    messages: empty(),
    toolCalls: empty(),
    subagents: empty(),
    output: Promise.resolve({
      messages: [new HumanMessage({ id: 'human-1', content: 'Run tests' })],
      todos: []
    }),
    abort() {}
  })
}

function duplicatedNestedInterruptStream() {
  const interrupt = {
    interruptId: 'nested-approval',
    payload: {
      actionRequests: [
        { name: 'execute', args: { command: 'dir C:\\' } },
        { name: 'execute', args: { command: 'dir D:\\' } }
      ]
    }
  }
  return mockProtocolStream({
    interrupted: true,
    interrupts: [interrupt, interrupt],
    messages: empty(),
    toolCalls: empty(),
    subagents: empty(),
    output: Promise.resolve({
      messages: [new HumanMessage({ id: 'human-nested', content: 'Inspect disks' })],
      todos: []
    }),
    abort() {}
  })
}

function pendingStream() {
  let resolveOutput!: (value: unknown) => void
  let rejectOutput!: (reason: unknown) => void
  const output = new Promise<unknown>((resolve, reject) => {
    resolveOutput = resolve
    rejectOutput = reject
  })
  return {
    stream: mockProtocolStream({
      interrupted: false,
      interrupts: [],
      messages: empty(),
      toolCalls: empty(),
      subagents: empty(),
      output,
      abort(reason?: unknown) {
        rejectOutput(reason)
      }
    }),
    complete(text: string) {
      resolveOutput({
        messages: [new AIMessage({ id: `assistant-${text}`, content: text })],
        todos: []
      })
    }
  }
}

function partialPendingStream(text: string) {
  let rejectRun!: (reason: unknown) => void
  let rejectMessage!: (reason: unknown) => void
  const output = new Promise<unknown>((_resolve, reject) => {
    rejectRun = reject
  })
  const messageOutput = new Promise<AIMessage>((_resolve, reject) => {
    rejectMessage = reject
  })
  return mockProtocolStream({
    interrupted: false,
    interrupts: [],
    messages: (async function *() {
      yield {
        text: (async function *() { yield text })(),
        reasoning: empty<string>(),
        output: messageOutput
      }
    })(),
    toolCalls: empty(),
    subagents: empty(),
    output,
    abort(reason?: unknown) {
      rejectMessage(reason)
      rejectRun(reason)
    }
  })
}

function modelTaskWithoutMessageStream(interrupted: boolean) {
  return {
    interrupted,
    interrupts: interrupted
      ? [{ interruptId: 'early-model-interrupt', payload: { reason: 'paused' } }]
      : [],
    messages: empty(),
    toolCalls: empty(),
    subagents: empty(),
    output: Promise.resolve({
      messages: [new HumanMessage({ id: 'early-model-human', content: 'Wait' })],
      todos: []
    }),
    async *[Symbol.asyncIterator]() {
      yield {
        type: 'event' as const,
        seq: 0,
        method: 'tasks',
        params: {
          namespace: [],
          timestamp: 0,
          data: {
            id: 'early-model-task',
            name: 'model_request',
            input: { messages: [] },
            interrupts: []
          }
        }
      }
    },
    abort() {}
  }
}

describe('AgentRuntime', () => {
  let database: AgentDatabase | undefined
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    database?.close()
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    ))
    runtimeLogMock.mockReset()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it.each([false, true])('streams only argument counts before model completion and clears progress (failure=%s)', async (fail) => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Streaming tool arguments' })
    let release!: () => void
    const gate = { promise: new Promise<void>((resolve) => { release = resolve }), resolve: () => release() }
    const call = { id: 'patch-call', name: 'apply_patch', args: { patch: '*** Begin Patch\n*** End Patch' } }
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: () => {
          const chat = new ChatModelStream((async function *(): AsyncGenerator<ChatModelStreamEvent> {
            yield { event: 'message-start', id: 'patch-message' }
            if (fail) {
              yield { event: 'content-block-start', index: 1, content: { type: 'text', text: '' } }
              yield { event: 'content-block-delta', index: 1, delta: { type: 'text-delta', text: 'Unfinished response prefix' } }
              yield { event: 'content-block-finish', index: 1, content: { type: 'text', text: 'Unfinished response prefix' } }
            }
            yield { event: 'content-block-start', index: 0, content: { type: 'tool_call_chunk', id: call.id, name: call.name, args: '' } }
            yield { event: 'content-block-delta', index: 0, delta: { type: 'block-delta', fields: { type: 'tool_call_chunk', args: '{"patch":"*** Begin' } } }
            await gate.promise
            if (fail) {
              throw new Error('provider disconnected')
            }
            yield { event: 'content-block-delta', index: 0, delta: { type: 'block-delta', fields: { type: 'tool_call_chunk', args: JSON.stringify(call.args) } } }
            yield { event: 'content-block-finish', index: 0, content: { type: 'tool_call', ...call } }
            yield { event: 'message-finish', reason: 'tool_use' }
          })())
          return mockProtocolStream({
            interrupted: false, interrupts: [],
            messages: (async function *() {
              yield {
                text: chat.text, reasoning: chat.reasoning, output: chat.output,
                [Symbol.asyncIterator]: () => chat[Symbol.asyncIterator]()
              }
            })(),
            toolCalls: empty(), subagents: empty(),
            output: Promise.resolve(chat.output).then((assistant) => ({ messages: [assistant], todos: [] })),
            abort() { gate.resolve() }
          }) as never
        },
        getState: async () => ({}) as never
      },
      dispose: async () => {}
    }))
    const events: AgentRuntimeEvent[] = []
    const collecting = (async () => {
      for await (const event of runtime.startRun({ runId: 'preview-run', threadId: thread.id, text: 'Make a patch' })) events.push(event)
    })()
    try {
      await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
        type: 'model_tool_calls', progress: [expect.objectContaining({ characterCount: '{"patch":"*** Begin'.length })]
      })))
      expect(events.some((event) => event.type === 'model_completed' || event.type === 'tool_started')).toBe(false)
      expect(database.getActivitiesForThread(thread.id)[0].tools).toEqual([])
      const snapshot = await runtime.getSnapshot(thread.id)
      expect(snapshot.activities[0].models[0].toolCallProgress?.[0]).toMatchObject({ callId: call.id, name: call.name })
      expect(snapshot.activities[0].models[0].toolCallProgress?.[0]).not.toHaveProperty('text')
      expect(database.getActivitiesForThread(thread.id)[0].models[0].toolCallProgress).toBeUndefined()
    } finally {
      gate.resolve()
      await collecting
    }
    const updates = events.filter((event) => event.type === 'model_tool_calls')
    for (const event of updates) {
      for (const progress of event.progress) {
        expect(progress).not.toHaveProperty('text')
        expect(progress).not.toHaveProperty('args')
      }
    }
    expect(updates.at(-1)?.progress).toEqual([])
    expect(events.filter((event) => event.type === 'tool_started')).toHaveLength(fail ? 0 : 1)
    if (fail) {
      expect(events).toContainEqual(expect.objectContaining({
        type: 'model_delta', delta: { type: 'text', text: 'Unfinished response prefix' }
      }))
      expect(database.getRunActivity('preview-run')?.models.every((model) => !model.text && !model.reasoning)).toBe(true)
    }
    expect((await runtime.getSnapshot(thread.id)).activities[0].models.every((model) => !model.toolCallProgress?.length)).toBe(true)
  })

  it('emits framework message events and completes with the checkpoint state snapshot', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Runtime' })
    const calls: Array<{ input: unknown; config: unknown }> = []
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: (input, config) => {
          calls.push({ input, config })
          return completedStream('Hello back', {
            usage: { input_tokens: 10, output_tokens: 2 },
            responseMetadata: { model_name: 'test-model', finish_reason: 'stop' }
          }) as never
        },
        getState: async () => ({}) as never
      },
      dispose: async () => {}
    }))

    const events = await collect(runtime.startRun({
      runId: 'run-1',
      threadId: thread.id,
      text: 'Hello'
    }))

    const input = calls[0].input as { messages: HumanMessage[]; todos: unknown[] }
    expect(input.messages).toHaveLength(1)
    expect(input.messages[0]).toBeInstanceOf(HumanMessage)
    expect(input.messages[0].text).toBe('Hello')
    expect(input.todos).toEqual([])
    expect(calls[0].config).toMatchObject({
      configurable: { thread_id: thread.id },
      durability: 'sync',
      version: 'v3'
    })
    expect(events.map((event) => event.type)).toEqual([
      'run_started',
      'model_started',
      'model_delta',
      'model_completed',
      'run_completed'
    ])
    expect(events[0]).toMatchObject({
      type: 'run_started',
      newUserTurn: true,
      userMessage: {
        id: 'run-1:input',
        role: 'user',
        runId: 'run-1',
        content: [{ type: 'text', text: 'Hello' }]
      }
    })
    expect(runtimeLogMock).toHaveBeenCalledWith('debug', 'agent', 'Model response metadata.', {
      runId: 'run-1',
      threadId: thread.id,
      modelId: expect.any(String),
      subagentId: undefined,
      usage: { input_tokens: 10, output_tokens: 2 },
      responseMetadata: { model_name: 'test-model', finish_reason: 'stop' }
    })
    const completed = events.at(-1)
    expect(completed).toMatchObject({
      type: 'run_completed',
      run: { id: 'run-1', status: 'completed' },
      snapshot: {
        thread: { id: thread.id, status: 'idle' },
        messages: [
          { id: 'human-1', role: 'user' },
          { id: 'assistant-1', role: 'assistant' }
        ],
        todos: [{ content: 'Answer', status: 'completed' }]
      }
    })
    const buffers = database as unknown as { transientModels: Map<string, unknown>; transientTools: Map<string, unknown> }
    expect(buffers.transientModels.size + buffers.transientTools.size).toBe(0)
  })

  it('holds queued directions on the active run until the post-tool model boundary consumes them', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-direction-runtime-'))
    temporaryDirectories.push(root)
    const sourcePath = join(root, 'direction.txt')
    await writeFile(sourcePath, 'attachment for the updated direction', 'utf8')
    database = AgentDatabase.open(':memory:', join(root, 'attachments'))
    const thread = database.createThread({ title: 'Direction queue' })
    const pending = pendingStream()
    let takeDirectionMessages: ((afterToolCallIds: string[]) => Promise<HumanMessage[]>) | undefined
    const runtime = new AgentRuntime(database, async (_thread, _database, context) => {
      takeDirectionMessages = context?.takeDirectionMessages as (
        (afterToolCallIds: string[]) => Promise<HumanMessage[]>
      ) | undefined
      return {
        agent: {
          streamEvents: () => pending.stream as never,
          getState: async () => ({ values: {}, tasks: [] }) as never
        },
        dispose: async () => {}
      }
    }, join(root, 'tmp'))
    const eventsPromise = collect(runtime.startRun({
      runId: 'direction-run',
      threadId: thread.id,
      text: 'Start'
    }))
    await vi.waitFor(() => expect(takeDirectionMessages).toBeTypeOf('function'))

    await expect(runtime.steerRun({
      runId: 'direction-run',
      threadId: thread.id,
      queuedInputId: 'invalid-attachment',
      text: 'Invalid attachment',
      attachments: [{
        path: 'relative.txt',
        name: 'relative.txt',
        mimeType: 'text/plain',
        size: 12,
        kind: 'text',
        contextPolicy: 'one_turn'
      }]
    })).rejects.toThrow('absolute file path')

    await expect(runtime.steerRun({
      runId: 'direction-run',
      threadId: thread.id,
      queuedInputId: 'removable-attachment',
      text: 'Remove this direction',
      attachments: [{
        path: sourcePath,
        name: 'direction.txt',
        mimeType: 'text/plain',
        size: 36,
        kind: 'text',
        contextPolicy: 'one_turn'
      }]
    })).resolves.toBe(true)
    await expect(runtime.removeSteer({
      runId: 'direction-run',
      threadId: thread.id,
      queuedInputId: 'removable-attachment'
    })).resolves.toBe(true)

    await expect(runtime.steerRun({
      runId: 'direction-run',
      threadId: thread.id,
      queuedInputId: 'queued-1',
      text: '  Follow this updated direction.  ',
      displayText: '/review updated direction',
      attachments: [{
        path: sourcePath,
        name: 'direction.txt',
        mimeType: 'text/plain',
        size: 36,
        kind: 'text',
        contextPolicy: 'one_turn'
      }]
    })).resolves.toBe(true)
    await rm(sourcePath)
    await expect(runtime.steerRun({
      runId: 'direction-run',
      threadId: thread.id,
      queuedInputId: 'queued-1',
      text: 'Follow this updated direction.'
    })).resolves.toBe(true)

    const directions = await takeDirectionMessages?.(['tool-1']) ?? []
    expect(directions).toHaveLength(1)
    expect(directions[0]).toBeInstanceOf(HumanMessage)
    expect(directions[0].text).toBe('Follow this updated direction.')
    expect(directions[0].id).toBe('direction-run:direction:queued-1')
    expect(directions[0].additional_kwargs).toMatchObject({
      anas_direction_after_tool_call_ids: ['tool-1']
    })
    expect(database.listAttachmentsForMessage(
      thread.id,
      'direction-run:direction:queued-1'
    )).toEqual([
      expect.objectContaining({
        name: 'direction.txt',
        runId: 'direction-run',
        messageId: 'direction-run:direction:queued-1'
      })
    ])

    pending.complete('Finished')
    const events = await eventsPromise
    expect(events).toContainEqual(expect.objectContaining({
      type: 'direction_applied',
      queuedInputId: 'queued-1',
      message: expect.objectContaining({
        id: 'direction-run:direction:queued-1',
        role: 'user',
        content: [{ type: 'text', text: '/review updated direction' }],
        directionAfterToolCallIds: ['tool-1'],
        attachments: [expect.objectContaining({ name: 'direction.txt' })]
      })
    }))
    await expect(runtime.steerRun({
      runId: 'direction-run',
      threadId: thread.id,
      queuedInputId: 'queued-2',
      text: 'Too late'
    })).resolves.toBe(false)
  })

  it('publishes and persists recalled memory before model activity', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Memory recall' })
    const runtime = new AgentRuntime(database, async (_thread, _database, context) => {
      context?.onMemoryRecall?.({
        query: 'How should this project build?',
        promptText: '<relevant_memories>\nnpm run build\n</relevant_memories>',
        memoryCount: 1
      })
      return {
        agent: {
          streamEvents: () => completedStream('Use the build script') as never,
          getState: async () => ({}) as never
        },
        dispose: async () => {}
      }
    })

    const events = await collect(runtime.startRun({
      runId: 'memory-recall-run',
      threadId: thread.id,
      text: 'How should this project build?'
    }))

    expect(events.map((event) => event.type)).toEqual([
      'run_started',
      'memory_recalled',
      'model_started',
      'model_delta',
      'model_completed',
      'run_completed'
    ])
    expect(events[1]).toMatchObject({
      type: 'memory_recalled',
      recall: {
        query: 'How should this project build?',
        promptText: expect.stringContaining('npm run build'),
        memoryCount: 1
      }
    })
    expect(database.getActivitiesForThread(thread.id)[0]).toMatchObject({
      memoryRecalls: [{ promptText: expect.stringContaining('npm run build') }]
    })
  })

  it('reads snapshots and earlier history directly from durable root checkpoint state', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Read-only snapshot' })
    const durableMessage = new HumanMessage({ id: 'durable-message', content: 'Durable history' })
    const checkpointId = nextDurableCheckpointId()
    await putRootCheckpoint(database, thread.id, checkpointId, {
      messages: [durableMessage],
      todos: [{ content: 'Durable todo', status: 'completed' }]
    })
    const rootConfig = {
      configurable: {
        thread_id: thread.id,
        checkpoint_ns: '',
        checkpoint_id: checkpointId
      }
    }
    await database.checkpointer.putWrites(rootConfig, [
      ['messages', [new HumanMessage({ id: 'pending-message', content: 'Not committed' })]],
      ['_summarizationEvent', { summaryId: 'pending-summary' }]
    ], 'pending-snapshot-task')
    await database.checkpointer.putWrites(rootConfig, [
      ['__interrupt__', [{
        id: 'durable-interrupt',
        value: {
          actionRequests: [{ name: 'apply_patch', args: { path: 'relative.txt' } }]
        }
      }]]
    ], 'pending-interrupt-task')
    const instanceFactory = vi.fn(async () => {
      throw new Error('Configured model or MCP is unavailable.')
    })
    const runtime = new AgentRuntime(database, instanceFactory as never)

    const snapshot = await runtime.getSnapshot(thread.id)
    const earlier = await runtime.loadEarlierMessages({
      threadId: thread.id,
      beforeIndex: snapshot.messageWindow.startIndex
    })

    expect(instanceFactory).not.toHaveBeenCalled()
    expect(snapshot.messages.map((message) => message.id)).toEqual(['durable-message'])
    expect(snapshot.todos).toEqual([{ content: 'Durable todo', status: 'completed' }])
    expect(snapshot.interrupts).toEqual([])
    expect(earlier.messages.map((message) => message.id)).toEqual(['durable-message'])
    expect(earlier.interrupts).toEqual(snapshot.interrupts)
  })

  it('projects context status from checkpoint messages without initializing an agent', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Context status snapshot' })
    const values = {
      messages: [new HumanMessage({ id: 'history-message', content: 'Existing history' })],
      todos: []
    }
    await putRootCheckpoint(database, thread.id, nextDurableCheckpointId(), values)
    database.recordContextStatus(thread.id, snapshotContextStatus(values)!)
    const instanceFactory = vi.fn(async () => {
      throw new Error('Snapshot must not initialize an agent.')
    })
    const runtime = new AgentRuntime(database, instanceFactory)

    const snapshot = await runtime.getSnapshot(thread.id)

    expect(instanceFactory).not.toHaveBeenCalled()
    expect(snapshot.contextStatus).toMatchObject({
      modelConfigId: '',
      compressionApplied: false,
      manualCompressionAvailable: true,
      breakdown: { messageTokens: expect.any(Number) }
    })
    expect(snapshot.contextStatus?.estimatedInputTokens).toBeGreaterThan(0)
  })

  it('reprojects current checkpoint context without constructing an agent or persisting a preview', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Live context', modelConfigId: 'model' })
    const model: ResolvedModelConfig = { ...defaultModelConfig, id: 'model', providerId: 'provider',
      providerName: 'Provider', protocol: 'openai_chat_completions', baseUrl: 'https://example.test/v1',
      displayName: 'Model', model: 'model' }
    vi.spyOn(modelSelection, 'createAgentModelResolver').mockReturnValue(async () => model)
    const initial = { messages: [new HumanMessage('Initial history')] }
    const latest = { messages: [new HumanMessage('Updated checkpoint with considerably more history')] }
    await putRootCheckpoint(database, thread.id, nextDurableCheckpointId(), initial)
    const factory = vi.fn<TestAgentInstanceFactory>()
    let first = true
    const project = vi.fn<NonNullable<TestAgentRuntimeConstructor[5]>>(async (_thread, target, values) => {
      if (first) {
        first = false
        await putRootCheckpoint(target, thread.id, nextDurableCheckpointId(), latest)
      }
      return { ...snapshotContextStatus(values)!, modelConfigId: model.id, modelContextKey: modelContextKey(model) }
    })
    const runtime = new ProductionAgentRuntime(database, factory, undefined, async () => {}, undefined, project)
    const status = await runtime.getContextStatus(thread.id)
    expect(status?.estimatedInputTokens).toBe(snapshotContextStatus(latest)?.estimatedInputTokens)
    expect(factory).not.toHaveBeenCalled()
    expect((await runtime.getSnapshot(thread.id)).contextStatus).toBeUndefined()
    expect(project.mock.calls.at(-1)?.[2]).toMatchObject({ messages: [expect.objectContaining({ content: latest.messages[0].content })] })
  })

  it.each([
    ['agent', 'running'], ['agent', 'interrupted'], ['agent', 'completed'], ['agent', 'failed'], ['agent', 'cancelled'],
    ['compression', 'running'], ['compression', 'interrupted'], ['compression', 'completed']
  ] as const)('uses frozen preview configuration only while %s is resumable (%s)', async (operation, runStatus) => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Context preview lifecycle', modelConfigId: 'model' })
    const model: ResolvedModelConfig = { ...defaultModelConfig, id: 'model', providerId: 'provider',
      providerName: 'Provider', protocol: 'openai_chat_completions', baseUrl: 'https://example.test/v1', displayName: 'Model', model: 'model' }
    vi.spyOn(modelSelection, 'createAgentModelResolver').mockReturnValue(async () => model)
    const run = database.createRun(thread.id, 'context-preview-run', operation)
    const configuration = { customTools: [], codingMode: true, capabilities: structuredClone(defaultCapabilities) }
    database.resolveRunConfiguration(run.id, configuration)
    const values = { messages: [new HumanMessage('Retained history')] }
    await putRootCheckpoint(database, thread.id, nextDurableCheckpointId(), values)
    if (runStatus === 'completed') await markRunCompleted(database, thread.id, run.id, values)
    if (runStatus === 'interrupted') await markRunInterrupted(database, thread.id, run.id, undefined, values)
    if (runStatus !== 'running') database.finishRun(run.id, runStatus)
    const project = vi.fn<NonNullable<TestAgentRuntimeConstructor[5]>>(async () => ({
      ...snapshotContextStatus(values)!, modelContextKey: modelContextKey(model)
    }))
    const runtime = new ProductionAgentRuntime(database, undefined, undefined, async () => {}, undefined, project)
    await runtime.getContextStatus(thread.id)
    const continuation = runStatus === 'running' || runStatus === 'interrupted'
    expect(project.mock.calls[0][3]).toMatchObject({
      requestId: continuation ? run.id : undefined,
      configuration: continuation ? configuration : undefined
    })
  })

  it('reprojects when a run completes during a preview without a new checkpoint', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Preview at completion', modelConfigId: 'model' })
    const model: ResolvedModelConfig = { ...defaultModelConfig, id: 'model', providerId: 'provider',
      providerName: 'Provider', protocol: 'openai_chat_completions', baseUrl: 'https://example.test/v1', displayName: 'Model', model: 'model' }
    vi.spyOn(modelSelection, 'createAgentModelResolver').mockReturnValue(async () => model)
    const run = database.createRun(thread.id, 'finishing-preview-run')
    const values = { messages: [new HumanMessage('History')] }
    await markRunCompleted(database, thread.id, run.id, values)
    const project = vi.fn<NonNullable<TestAgentRuntimeConstructor[5]>>(async (_thread, target, _values, context) => {
      if (context?.requestId) target.finishRun(run.id, 'completed')
      return { ...snapshotContextStatus(values)!, modelContextKey: modelContextKey(model),
        estimatedInputTokens: context?.requestId ? 100 : 200 }
    })
    const runtime = new ProductionAgentRuntime(database, undefined, undefined, async () => {}, undefined, project)
    expect((await runtime.getContextStatus(thread.id))?.estimatedInputTokens).toBe(200)
  })

  it('rebuilds interrupted context with saved capabilities while the old instance is still disposing', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Interrupted context rebuild', modelConfigId: 'model' })
    const model: ResolvedModelConfig = { ...defaultModelConfig, id: 'model', providerId: 'provider',
      providerName: 'Provider', protocol: 'openai_chat_completions', baseUrl: 'https://example.test/v1', displayName: 'Model', model: 'model' }
    vi.spyOn(modelSelection, 'createAgentModelResolver').mockReturnValue(async () => model)
    const configuration = { customTools: [], codingMode: true, capabilities: structuredClone(defaultCapabilities) }
    const values = { messages: [new HumanMessage('Existing request')] }
    const previous = { ...snapshotContextStatus(values)!, runId: 'interrupted-preview-run', modelContextKey: modelContextKey(model), estimatedInputTokens: 100 }
    let releaseDisposal!: () => void
    let markDisposing!: () => void
    const disposalGate = new Promise<void>((resolve) => { releaseDisposal = resolve })
    const disposing = new Promise<void>((resolve) => { markDisposing = resolve })
    const project = vi.fn<NonNullable<TestAgentRuntimeConstructor[5]>>(async () => ({ ...previous, estimatedInputTokens: 800 }))
    const factory: TestAgentInstanceFactory = async (_thread, _database, context) => {
      context?.onConfigurationResolved?.(configuration)
      return {
        agent: { streamEvents: () => interruptedStream() as never, getState: async () => ({}) as never },
        context: { status: async () => previous, projectedStatus: async () => previous,
          statusFromMessages: () => previous, compress: vi.fn() },
        dispose: async () => { markDisposing(); await disposalGate }
      }
    }
    const runtime = new ProductionAgentRuntime(database, withDurableMockCheckpoints(database, factory), undefined, async () => {}, undefined, project)
    const events = collect(runtime.startRun({ runId: previous.runId, threadId: thread.id, text: 'Continue' }))
    try {
      await disposing
      expect(database.getRun(previous.runId)?.status).toBe('interrupted')
      expect((await runtime.getContextStatus(thread.id))?.estimatedInputTokens).toBe(800)
      expect(project.mock.calls[0][3]).toMatchObject({ requestId: previous.runId, configuration })
    } finally {
      releaseDisposal()
      await events
      await runtime.shutdown()
    }
  })

  it.each(['failure', 'cancellation', 'invalid-model'] as const)(
    'restores checkpoint token status after a speculative summary ends in %s', async (outcome) => {
      database = AgentDatabase.open(':memory:')
      const thread = database.createThread({ title: 'Discarded summary context' })
      const values = { messages: [new HumanMessage({ id: 'history', content: 'Historical context '.repeat(300) })] }
      await putRootCheckpoint(database, thread.id, nextDurableCheckpointId(), values)
      const durable = snapshotContextStatus(values)!
      const speculative = { ...durable, estimatedInputTokens: 20, currentContextTokens: 20, compressionApplied: true }
      const pending = pendingStream()
      let prepared!: () => void
      const ready = new Promise<void>((resolve) => { prepared = resolve })
      const projectedStatus = vi.fn(async (checkpoint: unknown) => {
        if (outcome === 'invalid-model') throw new ModelSelectionError('Selected model deleted')
        return snapshotContextStatus(checkpoint)!
      })
      const dispose = vi.fn(async () => {})
      const runtime = new AgentRuntime(database, async (_thread, _target, context) => ({
        agent: {
          streamEvents: async () => {
            context?.onContextStatus?.(speculative)
            prepared()
            if (outcome !== 'cancellation') throw new Error('Provider request failed after preparing summary')
            return pending.stream as never
          },
          getState: async () => ({ values, tasks: [] }) as never
        },
        context: { status: projectedStatus, projectedStatus, statusFromMessages: () => durable, compress: vi.fn() },
        dispose
      }))
      const eventsPromise = collect(runtime.startRun({ runId: 'speculative-run', threadId: thread.id, text: 'Continue' }))
      await ready
      if (outcome === 'cancellation') runtime.cancelRun({ runId: 'speculative-run', threadId: thread.id })
      const events = await eventsPromise
      const expected = outcome === 'invalid-model' ? undefined : durable
      expect((await runtime.getSnapshot(thread.id)).contextStatus).toEqual(expected)
      expect(events.filter((event) => event.type === 'context_status_updated').at(-1)).toMatchObject({ status: expected })
      expect(projectedStatus.mock.calls[0]?.[0]).not.toHaveProperty('_summarizationEvent')
      expect(dispose).toHaveBeenCalled()
      expect(events.at(-1)?.type).toBe(outcome === 'cancellation' ? 'run_cancelled' : 'run_failed')
    }
  )

  it('retries a snapshot when its pinned run changes during the saver read', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Pinned snapshot retry' })
    const oldRun = database.createRun(thread.id, 'pinned-old-run')
    await putRootCheckpoint(database, thread.id, nextDurableCheckpointId(), {
      messages: [new AIMessage({
        id: 'pinned-old-answer',
        content: 'Old answer',
        additional_kwargs: { anas_run_id: oldRun.id }
      })],
      anasRunLifecycle: { runId: oldRun.id, status: 'completed' }
    })
    database.finishRun(oldRun.id, 'completed')
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: () => completedStream('unused') as never,
        getState: async () => ({ values: {}, tasks: [] }) as never
      },
      dispose: async () => {}
    }))
    await runtime.getSnapshot(thread.id)

    const originalReadWindow = database.readMessageWindow.bind(database)
    let releaseRead!: () => void
    const readBlocked = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    let captured!: () => void
    const oldTupleCaptured = new Promise<void>((resolve) => {
      captured = resolve
    })
    let blockOnce = true
    database.readMessageWindow = async (...args) => {
      if (blockOnce) {
        blockOnce = false
        const tuple = await originalReadWindow(...args)
        captured()
        await readBlocked
        return tuple
      }
      return originalReadWindow(...args)
    }
    const pendingSnapshot = runtime.getSnapshot(thread.id)
    await oldTupleCaptured

    const newRun = database.createRun(thread.id, 'pinned-new-run')
    await putRootCheckpoint(database, thread.id, nextDurableCheckpointId(), {
      messages: [new AIMessage({
        id: 'pinned-new-answer',
        content: 'New answer',
        additional_kwargs: { anas_run_id: newRun.id }
      })],
      anasRunLifecycle: { runId: newRun.id, status: 'running' }
    })
    releaseRead()

    const snapshot = await pendingSnapshot
    expect(snapshot.thread.status).toBe('running')
    expect(snapshot.pendingRun).toMatchObject({ id: newRun.id, status: 'running' })
    expect(snapshot.messages.map((message) => message.id)).toEqual(['pinned-new-answer'])
  })

  it('retries a snapshot when checkpoint progress changes without a run timestamp change', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Checkpoint fingerprint retry' })
    const run = database.createRun(thread.id, 'checkpoint-fingerprint-run')
    const checkpointId = nextDurableCheckpointId()
    await putRootCheckpoint(database, thread.id, checkpointId, {
      messages: [new HumanMessage({
        id: 'fingerprint-user',
        content: 'Durable baseline',
        additional_kwargs: { anas_run_id: run.id }
      })],
      anasRunLifecycle: { runId: run.id, status: 'running' }
    })
    const runtime = new AgentRuntime(database, async () => {
      throw new Error('Snapshot must not construct an agent.')
    })
    const originalReadWindow = database.readMessageWindow.bind(database)
    let releaseRead!: () => void
    const readBlocked = new Promise<void>((resolve) => {
      releaseRead = resolve
    })
    let captured!: () => void
    const tupleCaptured = new Promise<void>((resolve) => {
      captured = resolve
    })
    let headReads = 0
    database.readMessageWindow = async (...args) => {
      const tuple = await originalReadWindow(...args)
      if (headReads++ === 0) {
        captured()
        await readBlocked
      }
      return tuple
    }

    const pendingSnapshot = runtime.getSnapshot(thread.id)
    await tupleCaptured
    const unchangedRunTimestamp = database.getRun(run.id)?.updatedAt
    await database.checkpointer.putWrites({
      configurable: {
        thread_id: thread.id,
        checkpoint_ns: '',
        checkpoint_id: checkpointId
      }
    }, [['messages', [new AIMessage({
      id: 'pending-fingerprint-answer',
      content: 'Pending only',
      additional_kwargs: { anas_run_id: run.id }
    })]]], 'pending-fingerprint-task')
    expect(database.getRun(run.id)?.updatedAt).toBe(unchangedRunTimestamp)
    releaseRead()

    const snapshot = await pendingSnapshot
    expect(headReads).toBe(2)
    expect(snapshot.messages.map((message) => message.id)).toEqual(['fingerprint-user'])
    expect(database.getRunCheckpointState(run.id).lastWriteCheckpointId).toBe(checkpointId)
  })

  it('selects the newest run by insertion order when timestamps are identical', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-09T00:00:00.000Z'))
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Same timestamp runs' })
    const first = database.createRun(thread.id, 'same-time-run-1')
    await markRunCompleted(database, thread.id, first.id)
    database.finishRun(first.id, 'completed')
    const second = database.createRun(thread.id, 'same-time-run-2')
    await putRootCheckpoint(database, thread.id, nextDurableCheckpointId(), {
      messages: [new HumanMessage({
        id: 'same-time-second-input',
        content: 'Second run',
        additional_kwargs: { anas_run_id: second.id }
      })],
      anasRunLifecycle: { runId: second.id, status: 'running' }
    })
    const runtime = new AgentRuntime(database, async () => {
      throw new Error('Snapshot must not construct an agent.')
    })

    expect(database.getLatestRunForThread(thread.id)?.id).toBe(second.id)
    const snapshot = await runtime.getSnapshot(thread.id)
    expect(snapshot.pendingRun).toMatchObject({ id: second.id, status: 'running' })
  })

  it.each([
    { interrupted: false, expectedStatus: 'completed' as const },
    { interrupted: true, expectedStatus: 'interrupted' as const }
  ])('preserves a $expectedStatus run when its activity snapshot projection fails', async ({
    interrupted,
    expectedStatus
  }) => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Terminal projection failure' })
    const readActivities = database.getActivitiesForRuns.bind(database)
    let failProjection = true
    vi.spyOn(database, 'getActivitiesForRuns').mockImplementation((threadId, ...args) => {
      const status = database?.getLatestRunForThread(threadId)?.status
      if (failProjection && (status === 'completed' || status === 'interrupted')) {
        throw new Error('Injected activity projection failure.')
      }
      return readActivities(threadId, ...args)
    })
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: () => (
          interrupted ? interruptedStream() : completedStream('Durable final answer')
        ) as never,
        getState: async () => ({}) as never
      },
      dispose: async () => {}
    }))

    const events = await collect(runtime.startRun({
      runId: `projection-${expectedStatus}`,
      threadId: thread.id,
      text: 'Keep the terminal result'
    }))

    expect(database.getRun(`projection-${expectedStatus}`)?.status).toBe(expectedStatus)
    const terminal = events.at(-1)
    expect(terminal?.type).toBe(interrupted ? 'run_interrupted' : 'run_completed')
    expect(terminal).not.toHaveProperty('snapshot')
    expect(runtimeLogMock).toHaveBeenCalledWith(
      'warn',
      'agent',
      'Failed to build a terminal run snapshot projection.',
      {
        runId: `projection-${expectedStatus}`,
        error: 'Injected activity projection failure.'
      }
    )
    failProjection = false
    const refreshed = await runtime.getSnapshot(thread.id)
    expect(refreshed.thread.status).toBe(expectedStatus === 'completed' ? 'idle' : 'interrupted')
    if (!interrupted) {
      expect(refreshed.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'assistant-1', role: 'assistant' })
      ]))
    }
  })

  it('fails a brand-new run when runtime assembly rejects before durable progress', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'New run assembly failure' })
    const runtime = new AgentRuntime(database, async () => {
      throw new Error('Main model is unavailable.')
    })

    const events = await collect(runtime.startRun({
      runId: 'new-run-assembly-failure',
      threadId: thread.id,
      text: 'Start a new task'
    }))

    expect(events.at(-1)).toMatchObject({
      type: 'run_failed',
      run: { id: 'new-run-assembly-failure', status: 'failed' },
      error: 'Main model is unavailable.'
    })
    expect(database.getRun('new-run-assembly-failure')?.status).toBe('failed')
  })

  it.each([
    { executionFails: false, expectedStatus: 'completed' as const },
    { executionFails: true, expectedStatus: 'failed' as const }
  ])('closes the event queue and cleans a $expectedStatus run when dispose rejects', async ({
    executionFails,
    expectedStatus
  }) => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Dispose failure' })
    const cleanupFileEdits = vi.fn(async () => {})
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: () => {
          if (executionFails) throw new Error('Injected execution failure.')
          return completedStream('Completed before dispose failed') as never
        },
        getState: async () => ({}) as never
      },
      dispose: async () => {
        throw new Error('Injected dispose failure.')
      }
    }), undefined, cleanupFileEdits)
    const runId = `dispose-${expectedStatus}`

    const events = await collect(runtime.startRun({
      runId,
      threadId: thread.id,
      text: 'Finish the run'
    }))

    expect(events.at(-1)?.type).toBe(
      executionFails ? 'run_failed' : 'run_completed'
    )
    expect(database.getRun(runId)?.status).toBe(expectedStatus)
    expect(cleanupFileEdits).toHaveBeenCalledWith(runId)
    expect(database.listFileEditCleanupRunIds()).toEqual([])
    expect(runtimeLogMock).toHaveBeenCalledWith(
      'warn',
      'agent',
      'Failed to dispose an agent runtime instance.',
      { runId, error: 'Injected dispose failure.' }
    )
    expect(runtimeLogMock).not.toHaveBeenCalledWith(
      'error',
      'agent',
      'An agent runtime task failed unexpectedly.',
      expect.anything()
    )
  })

  it('does not project middleware-injected human messages as model rounds', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Middleware message filtering' })
    const direction = toHumanMessage(
      'Skip the second source.',
      undefined,
      undefined,
      {
        id: 'direction-human',
        runId: 'middleware-message-run',
        directionAfterToolCallIds: ['tool-1']
      }
    )
    const assistant = new AIMessage({
      id: 'real-assistant',
      content: 'Understood.',
      additional_kwargs: { anas_run_id: 'middleware-message-run' }
    })
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: () => mockProtocolStream({
          interrupted: false,
          interrupts: [],
          messages: (async function *() {
            yield {
              node: 'AnasQueuedDirectionMiddleware.before_model',
              text: (async function *() { yield 'Skip the second source.' })(),
              reasoning: empty<string>(),
              output: Promise.resolve(direction)
            }
            yield {
              node: 'model_request',
              text: (async function *() { yield 'Understood.' })(),
              reasoning: empty<string>(),
              output: Promise.resolve(assistant)
            }
          })(),
          toolCalls: empty(),
          subagents: empty(),
          output: Promise.resolve({
            messages: [
              new HumanMessage({ id: 'initial-human', content: 'Find two sources.' }),
              direction,
              assistant
            ],
            todos: []
          }),
          abort() {}
        }) as never,
        getState: async () => ({}) as never
      },
      dispose: async () => {}
    }))

    const events = await collect(runtime.startRun({
      runId: 'middleware-message-run',
      threadId: thread.id,
      text: 'Find two sources.'
    }))
    const modelEvents = events.filter((event) =>
      event.type === 'model_started'
      || event.type === 'model_delta'
      || event.type === 'model_completed'
    )
    expect(modelEvents.map((event) => event.type)).toEqual([
      'model_started',
      'model_delta',
      'model_completed'
    ])
    expect(modelEvents).not.toContainEqual(expect.objectContaining({
      delta: { type: 'text', text: 'Skip the second source.' }
    }))
    expect(database.getActivitiesForThread(thread.id)[0].models).toHaveLength(1)
  })

  it('starts the next model round after a tool finishes and before message output is available', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Early model round' })
    const assistant = new AIMessage({ id: 'early-assistant', content: 'Ready' })
    let releaseModelTask!: () => void
    const modelTaskReady = new Promise<void>((resolve) => {
      releaseModelTask = resolve
    })
    let releaseMessage!: () => void
    const messageReady = new Promise<void>((resolve) => {
      releaseMessage = resolve
    })
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: () => ({
          interrupted: false,
          interrupts: [],
          messages: (async function *() {
            await messageReady
            yield {
              namespace: ['model_request:model-task-1'],
              node: 'model_request',
              text: (async function *() { yield 'Ready' })(),
              reasoning: empty<string>(),
              output: Promise.resolve(assistant)
            }
          })(),
          toolCalls: (async function *() {
            yield {
              callId: 'finished-tool',
              name: 'lookup',
              input: { query: 'status' },
              output: Promise.resolve('Done'),
              status: Promise.resolve('finished' as const),
              error: Promise.resolve(undefined)
            }
          })(),
          subagents: empty(),
          output: messageReady.then(() => ({
            messages: [new HumanMessage({ id: 'early-human', content: 'Wait' }), assistant],
            todos: []
          })),
          async *[Symbol.asyncIterator]() {
            await modelTaskReady
            yield {
              type: 'event' as const,
              seq: 0,
              method: 'tasks',
              params: {
                namespace: [],
                timestamp: 0,
                data: {
                  id: 'model-task-1',
                  name: 'model_request',
                  input: { messages: [] },
                  interrupts: []
                }
              }
            }
          },
          abort() {}
        }) as never,
        getState: async () => ({}) as never
      },
      dispose: async () => {}
    }))

    const events = runtime.startRun({
      runId: 'early-model-run',
      threadId: thread.id,
      text: 'Wait'
    })[Symbol.asyncIterator]()

    expect(await events.next()).toMatchObject({ value: { type: 'run_started' } })
    expect(await events.next()).toMatchObject({ value: { type: 'tool_started' } })
    expect(await events.next()).toMatchObject({ value: { type: 'tool_completed' } })
    releaseModelTask()
    const early = await events.next()
    expect(early).toMatchObject({
      value: {
        type: 'model_started',
        model: {
          status: 'running',
          text: '',
          reasoning: '',
          toolCallIds: []
        }
      }
    })

    releaseMessage()
    const remaining: AgentRuntimeEvent[] = []
    for await (const event of { [Symbol.asyncIterator]: () => events }) remaining.push(event)
    expect(remaining.filter((event) => event.type === 'model_started')).toEqual([])
    expect(remaining).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'model_delta', delta: { type: 'text', text: 'Ready' } }),
      expect.objectContaining({ type: 'model_completed' }),
      expect.objectContaining({ type: 'run_completed' })
    ]))
  })

  it.each([
    { interrupted: false, terminalEvent: 'run_completed' as const },
    { interrupted: true, terminalEvent: 'run_interrupted' as const }
  ])('discards an unclaimed early model round when a run reaches $terminalEvent', async ({
    interrupted,
    terminalEvent
  }) => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Unclaimed model round' })
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: () => modelTaskWithoutMessageStream(interrupted) as never,
        getState: async () => ({}) as never
      },
      dispose: async () => {}
    }))

    const events = await collect(runtime.startRun({
      runId: `unclaimed-model-${terminalEvent}`,
      threadId: thread.id,
      text: 'Wait'
    }))

    expect(events.map((event) => event.type)).toEqual([
      'run_started',
      'model_started',
      terminalEvent
    ])
    const terminal = events.at(-1)
    if (terminal?.type !== 'run_completed' && terminal?.type !== 'run_interrupted') {
      throw new Error(`Expected ${terminalEvent}.`)
    }
    const activity = terminal.snapshot?.activities.find((item) =>
      item.runId === `unclaimed-model-${terminalEvent}`
    )
    expect(activity?.models).toEqual([])
    expect(database?.getActivitiesForThread(thread.id)[0]?.models).toEqual([])
  })

  it('emits main-agent todo updates as soon as write_todos completes', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Todo updates' })
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: () => todoUpdateStream() as never,
        getState: async () => ({}) as never
      },
      dispose: async () => {}
    }))

    const events = await collect(runtime.startRun({
      runId: 'run-todos',
      threadId: thread.id,
      text: 'Make a plan'
    }))
    const completedIndex = events.findIndex((event) => event.type === 'tool_completed')
    const updatedIndex = events.findIndex((event) => event.type === 'todos_updated')
    const runCompletedIndex = events.findIndex((event) => event.type === 'run_completed')

    expect(completedIndex).toBeGreaterThanOrEqual(0)
    expect(updatedIndex).toBeGreaterThan(completedIndex)
    expect(runCompletedIndex).toBeGreaterThan(updatedIndex)
    expect(events[updatedIndex]).toMatchObject({
      type: 'todos_updated',
      runId: 'run-todos',
      threadId: thread.id,
      todos: [
        { content: 'Inspect the runtime', status: 'completed' },
        { content: 'Build the plan UI', status: 'in_progress' }
      ]
    })
  })

  it('routes live output through model activity and completes one transcript response', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Reasoning' })
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: () => completedStream('Final answer', {
          reasoning: 'Internal reasoning',
          reasoningSummary: 'Checked the relevant state.',
          runId: 'reasoning-run'
        }) as never,
        getState: async () => ({}) as never
      },
      dispose: async () => {}
    }))

    const events = await collect(runtime.startRun({
      runId: 'reasoning-run',
      threadId: thread.id,
      text: 'Think first'
    }))

    expect(events.filter((event) => event.type === 'model_delta')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          delta: { type: 'reasoning', text: 'Internal reasoning' }
        }),
        expect.objectContaining({
          delta: { type: 'text', text: 'Final answer' }
        })
      ])
    )
    expect(events).toContainEqual(expect.objectContaining({
      type: 'model_completed',
      model: expect.objectContaining({
        reasoning: 'Internal reasoning',
        reasoningSummary: 'Checked the relevant state.'
      })
    }))
    expect(events.at(-1)).toMatchObject({
      type: 'run_completed',
      snapshot: {
        messages: expect.arrayContaining([
          expect.objectContaining({ id: 'assistant-1', role: 'assistant' })
        ]),
        activities: expect.arrayContaining([
          expect.objectContaining({
            models: expect.arrayContaining([
              expect.objectContaining({
                reasoningSummary: 'Checked the relevant state.'
              })
            ])
          })
        ])
      }
    })
  })

  it('reconciles a rejected root tool call that has no tool execution stream', async () => {
    database = AgentDatabase.open(':memory:')
    const testDatabase = database
    const thread = testDatabase.createThread({ title: 'Rejected root tool' })
    const call = {
      id: 'rejected-write',
      name: 'apply_patch',
      args: { path: '/tmp/rejected.txt', content: 'No write' }
    }
    const assistant = new AIMessage({
      id: 'assistant-write',
      content: '',
      tool_calls: [call],
      additional_kwargs: { anas_run_id: 'rejected-root-run' }
    })
    const rejected = new ToolMessage({
      id: 'rejected-write-result',
      name: call.name,
      tool_call_id: call.id,
      content: 'User rejected the tool call for `apply_patch`.',
      additional_kwargs: { anas_run_id: 'rejected-root-run' }
    })
    const runtime = new AgentRuntime(testDatabase, async () => ({
      agent: {
        streamEvents: () => {
          testDatabase.recordModelActivity('rejected-root-run', {
            id: 'root-model',
            status: 'completed',
            text: '',
            reasoning: 'Prepare the file.',
            toolCallIds: [call.id]
          })
          return mockProtocolStream({
            interrupted: false,
            interrupts: [],
            messages: empty(),
            toolCalls: empty(),
            subagents: empty(),
            output: Promise.resolve({
              messages: [new HumanMessage('Write the file'), assistant, rejected],
              todos: []
            }),
            abort() {}
          }) as never
        },
        getState: async () => ({}) as never
      },
      dispose: async () => {}
    }))

    const events = await collect(runtime.startRun({
      runId: 'rejected-root-run',
      threadId: thread.id,
      text: 'Write the file'
    }))

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool_completed',
        call,
        output: 'User rejected the tool call for `apply_patch`.'
      })
    ]))
    expect(events.at(-1)).toMatchObject({
      type: 'run_completed',
      snapshot: {
        activities: [
          expect.objectContaining({
            tools: [
              expect.objectContaining({
                call,
                status: 'completed',
                output: 'User rejected the tool call for `apply_patch`.'
              })
            ]
          })
        ]
      }
    })
  })

  it('projects a root tool validation error at its checkpoint before the next model round', async () => {
    database = AgentDatabase.open(':memory:')
    const testDatabase = database
    const thread = testDatabase.createThread({ title: 'Live tool validation error' })
    const runId = 'live-tool-validation-run'
    const call = {
      id: 'invalid-wait-call',
      name: 'wait_call',
      args: { call_id: 'background-call', timeout: 600 }
    }
    const assistant = new AIMessage({
      id: 'invalid-wait-assistant',
      content: '',
      tool_calls: [call],
      additional_kwargs: { anas_run_id: runId }
    })
    const validationError = new ToolMessage({
      id: 'invalid-wait-result',
      name: call.name,
      tool_call_id: call.id,
      content: 'Number must be less than or equal to 300 at timeout',
      additional_kwargs: { anas_run_id: runId }
    })
    const values = {
      messages: [new HumanMessage('Wait for it'), assistant, validationError],
      todos: []
    }
    const runtime = new AgentRuntime(testDatabase, async () => ({
      agent: {
        streamEvents: () => {
          testDatabase.recordModelActivity(runId, {
            id: 'validation-model',
            messageId: assistant.id,
            status: 'completed',
            text: '',
            reasoning: '',
            toolCallIds: [call.id]
          })
          const protocolEvents = async function *() {
            await putRootCheckpoint(testDatabase, thread.id, 'validation-checkpoint', values)
            yield {
              type: 'event' as const,
              seq: 1,
              method: 'checkpoints',
              params: {
                namespace: [],
                timestamp: 1,
                data: { id: 'validation-checkpoint', step: 1, source: 'loop' }
              }
            }
            yield {
              type: 'event' as const,
              seq: 2,
              method: 'values',
              params: { namespace: [], timestamp: 2, data: values }
            }
            expect(testDatabase.getActivitiesForThread(thread.id)[0].tools).toEqual([
              expect.objectContaining({
                call,
                status: 'completed',
                output: 'Number must be less than or equal to 300 at timeout'
              })
            ])
            yield {
              type: 'event' as const,
              seq: 3,
              method: 'tasks',
              params: {
                namespace: [],
                timestamp: 3,
                data: {
                  id: 'next-model-task',
                  name: 'model_request',
                  input: { messages: [] },
                  interrupts: []
                }
              }
            }
          }
          return Object.assign({
            interrupted: false,
            interrupts: [],
            messages: empty(),
            toolCalls: empty(),
            subagents: empty(),
            output: Promise.resolve(values),
            abort() {}
          }, { [Symbol.asyncIterator]: protocolEvents }) as never
        },
        getState: async () => ({}) as never
      },
      dispose: async () => {}
    }))

    const events = await collect(runtime.startRun({
      runId,
      threadId: thread.id,
      text: 'Wait for it'
    }))
    const completedIndex = events.findIndex((event) => event.type === 'tool_completed')
    const nextModelIndex = events.findIndex((event) => event.type === 'model_started')

    expect(completedIndex).toBeGreaterThanOrEqual(0)
    expect(nextModelIndex).toBeGreaterThan(completedIndex)
    expect(events.filter((event) => event.type === 'tool_completed')).toEqual([
      expect.objectContaining({
        call,
        output: 'Number must be less than or equal to 300 at timeout'
      })
    ])
  })

  it('does not duplicate completion when a root checkpoint wins the tool-stream race', async () => {
    database = AgentDatabase.open(':memory:')
    const testDatabase = database
    const thread = testDatabase.createThread({ title: 'Tool completion race' })
    const runId = 'tool-completion-race-run'
    const call = {
      id: 'racing-tool-call',
      name: 'lookup',
      args: { query: 'status' }
    }
    const assistant = new AIMessage({
      id: 'racing-tool-assistant',
      content: '',
      tool_calls: [call],
      additional_kwargs: { anas_run_id: runId }
    })
    const result = new ToolMessage({
      id: 'racing-tool-result',
      name: call.name,
      tool_call_id: call.id,
      content: 'Checkpoint result',
      additional_kwargs: { anas_run_id: runId }
    })
    const values = {
      messages: [new HumanMessage('Look it up'), assistant, result],
      todos: []
    }
    let releaseToolOutput!: (value: string) => void
    const toolOutput = new Promise<string>((resolve) => {
      releaseToolOutput = resolve
    })
    const runtime = new AgentRuntime(testDatabase, async () => ({
      agent: {
        streamEvents: () => {
          testDatabase.recordModelActivity(runId, {
            id: 'racing-model',
            messageId: assistant.id,
            status: 'completed',
            text: '',
            reasoning: '',
            toolCallIds: [call.id]
          })
          testDatabase.recordToolActivity(runId, call, 'running')
          const protocolEvents = async function *() {
            await putRootCheckpoint(testDatabase, thread.id, 'racing-checkpoint', values)
            yield {
              type: 'event' as const,
              seq: 1,
              method: 'checkpoints',
              params: {
                namespace: [],
                timestamp: 1,
                data: { id: 'racing-checkpoint', step: 1, source: 'loop' }
              }
            }
            yield {
              type: 'event' as const,
              seq: 2,
              method: 'values',
              params: { namespace: [], timestamp: 2, data: values }
            }
            releaseToolOutput('Tool stream result')
          }
          return Object.assign({
            interrupted: false,
            interrupts: [],
            messages: empty(),
            toolCalls: (async function *() {
              yield {
                callId: call.id,
                name: call.name,
                input: call.args,
                output: toolOutput,
                status: Promise.resolve('finished' as const),
                error: Promise.resolve(undefined)
              }
            })(),
            subagents: empty(),
            output: Promise.resolve(values),
            abort() {}
          }, { [Symbol.asyncIterator]: protocolEvents }) as never
        },
        getState: async () => ({}) as never
      },
      dispose: async () => {}
    }))

    const events = await collect(runtime.startRun({
      runId,
      threadId: thread.id,
      text: 'Look it up'
    }))

    expect(events.filter((event) => event.type === 'tool_completed')).toEqual([
      expect.objectContaining({ call, output: 'Checkpoint result' })
    ])
    expect(testDatabase.getActivitiesForThread(thread.id)[0].tools).toEqual([
      expect.objectContaining({ call, status: 'completed', output: 'Checkpoint result' })
    ])
  })

  it('does not project an unproven nested tool result from root checkpoint history', async () => {
    database = AgentDatabase.open(':memory:')
    const testDatabase = database
    const thread = testDatabase.createThread({ title: 'Rejected child tool' })
    const call = {
      id: 'rejected-child-write',
      name: 'apply_patch',
      args: { path: '/tmp/child.txt', content: 'No write' }
    }
    const assistant = new AIMessage({
      id: 'child-assistant-write',
      content: '',
      tool_calls: [call]
    })
    const rejected = new ToolMessage({
      id: 'rejected-child-result',
      name: call.name,
      tool_call_id: call.id,
      content: 'User rejected the child tool call.'
    })
    const runtime = new AgentRuntime(testDatabase, async () => ({
      agent: {
        streamEvents: () => {
          testDatabase.recordSubagentActivity(
            'rejected-child-run',
            'child-agent',
            'general-purpose',
            'completed',
            undefined,
            'Stopped'
          )
          testDatabase.recordModelActivity('rejected-child-run', {
            id: 'child-model',
            status: 'completed',
            subagentId: 'child-agent',
            text: '',
            reasoning: 'Prepare the child file.',
            toolCallIds: [call.id]
          })
          return mockProtocolStream({
            interrupted: false,
            interrupts: [],
            messages: empty(),
            toolCalls: empty(),
            subagents: empty(),
            output: Promise.resolve({
              messages: [new HumanMessage('Delegate the write'), assistant, rejected],
              todos: []
            }),
            abort() {}
          }) as never
        },
        getState: async () => ({}) as never
      },
      dispose: async () => {}
    }))

    const events = await collect(runtime.startRun({
      runId: 'rejected-child-run',
      threadId: thread.id,
      text: 'Delegate the write'
    }))

    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'tool_completed', call })
    ]))
    expect(events.at(-1)).toMatchObject({
      type: 'run_completed',
      snapshot: {
        activities: [
          expect.objectContaining({
            models: [],
            tools: [],
            subagents: []
          })
        ]
      }
    })
  })

  it('projects an unexecuted tool result when restoring an existing checkpoint', async () => {
    database = AgentDatabase.open(':memory:')
    const testDatabase = database
    const thread = testDatabase.createThread({ title: 'Restore rejected tool' })
    const run = testDatabase.createRun(thread.id, 'restore-rejected-run')
    const call = {
      id: 'restored-rejected-write',
      name: 'apply_patch',
      args: { path: '/tmp/restored.txt', content: 'No write' }
    }
    testDatabase.recordModelActivity(run.id, {
      id: 'restored-model',
      messageId: 'restored-assistant',
      status: 'completed',
      text: '',
      reasoning: 'Prepare the restored file.',
      toolCallIds: [call.id]
    })
    const messages = [
      new HumanMessage('Restore the conversation'),
      new AIMessage({
        id: 'restored-assistant',
        content: '',
        tool_calls: [call],
        additional_kwargs: { anas_run_id: run.id }
      }),
      new ToolMessage({
        id: 'restored-rejection',
        name: call.name,
        tool_call_id: call.id,
        content: 'User rejected the restored tool call.',
        additional_kwargs: { anas_run_id: run.id }
      })
    ]
    await putRootCheckpoint(testDatabase, thread.id, nextDurableCheckpointId(), {
      messages,
      todos: [],
      anasRunLifecycle: { runId: run.id, status: 'completed' }
    })
    testDatabase.finishRun(run.id, 'completed')
    const runtime = new AgentRuntime(testDatabase, async () => ({
      agent: {
        streamEvents: () => completedStream('unused') as never,
        getState: async () => ({
          values: { messages, todos: [] },
          tasks: []
        }) as never
      },
      dispose: async () => {}
    }))

    const snapshot = await runtime.getSnapshot(thread.id)

    expect(snapshot.activities).toEqual([
      expect.objectContaining({
        runId: run.id,
        tools: [
          expect.objectContaining({
            call,
            status: 'completed',
            output: 'User rejected the restored tool call.'
          })
        ]
      })
    ])
    expect(testDatabase.getActivitiesForThread(thread.id)[0].tools).toEqual([
      expect.objectContaining({ call, status: 'completed' })
    ])
  })

  it.each((['backgroundTools', 'codingMode'] as const).flatMap((setting) => [false, true].map((initial) => ({ setting, initial }))))(
    'keeps run $setting=$initial across approval and runtime recreation', async ({ setting, initial }) => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Background setting approval' })
    let globalBackgroundTools = initial
    const resolved: boolean[] = []
    const streams = [interruptedStream(), completedStream('Approved'), completedStream('Next run')]
    const factory: TestAgentInstanceFactory = async (_thread, _database, context) => {
      if (context?.requestId) {
        const enabled = (setting === 'codingMode' ? context.configuration?.codingMode : context.configuration?.capabilities.backgroundTools) ?? globalBackgroundTools
        resolved.push(enabled)
        context.onConfigurationResolved?.({ customTools: [], codingMode: setting === 'codingMode' && enabled,
          capabilities: { ...structuredClone(defaultCapabilities), ...(setting === 'backgroundTools' ? { backgroundTools: enabled } : {}) } })
      }
      return {
        agent: {
          streamEvents: () => streams.shift() as never,
          getState: async () => ({}) as never
        },
        dispose: async () => {}
      }
    }
    const original = new AgentRuntime(database, factory)
    const events = await collect(original.startRun({
      runId: 'background-approval-run', threadId: thread.id, text: 'Request approval.'
    }))
    expect(events.at(-1)?.type).toBe('run_interrupted')
    const first = database.getRunConfiguration('background-approval-run')!
    expect(setting === 'codingMode' ? first.codingMode : first.capabilities.backgroundTools).toBe(initial)

    globalBackgroundTools = !initial
    const resumed = new AgentRuntime(database, factory)
    const completed = await collect(await resumed.resumeRun({
      runId: 'background-approval-run', threadId: thread.id,
      responses: [{
        interruptId: 'approval-1', decisions: [{ type: 'approve' }],
        expectedGeneration: await currentApprovalGeneration(resumed, thread.id, 'approval-1')
      }]
    }))
    expect(completed.at(-1)?.type).toBe('run_completed')
    await collect(resumed.startRun({
      runId: 'background-next-run', threadId: thread.id, text: 'Start a new run.'
    }))
    expect(resolved).toEqual([initial, initial, !initial])
    const next = database.getRunConfiguration('background-next-run')!
    expect(setting === 'codingMode' ? next.codingMode : next.capabilities.backgroundTools).toBe(!initial)
  })

  it('keeps child capabilities independent while the parent is paused', async () => {
    database = AgentDatabase.open(':memory:')
    const owner = database.createThread({ title: 'Paused parent background setting' })
    const parent = database.createRun(owner.id, 'paused-background-parent')
    database.resolveRunConfiguration(parent.id, { customTools: [], codingMode: false, capabilities: { ...structuredClone(defaultCapabilities), backgroundTools: false } })
    const child = database.createSubagentCall({
      id: '11000000-0000-8000-8000-000000000099',
      ownerThreadId: owner.id, parentThreadId: owner.id, parentRunId: parent.id,
      childThreadId: '22000000-0000-8000-8000-000000000099',
      childRunId: '33000000-0000-8000-8000-000000000099',
      config: subagentConfig('reviewer'), description: 'Continue while the parent is paused.',
      childThread: { title: 'Background-setting child', projectId: owner.projectId }
    })
    await markRunInterrupted(database, owner.id, parent.id)
    database.finishRun(parent.id, 'interrupted')
    const resolved: boolean[] = []
    const runtime = new AgentRuntime(database, async (_thread, _database, context) => {
      if (context?.requestId) {
        const enabled = context.configuration?.capabilities.backgroundTools ?? true
        resolved.push(enabled)
        context.onConfigurationResolved?.({ customTools: [], codingMode: false, capabilities: { ...structuredClone(defaultCapabilities), backgroundTools: enabled } })
      }
      return {
        agent: {
          streamEvents: () => completedStream('Child completed', { runId: child.childRunId }) as never,
          getState: async () => ({}) as never
        },
        dispose: async () => {}
      }
    })
    const events = runtime.recoverRun(child.childThreadId)
    if (!events) throw new Error('Expected the child to be recoverable.')
    expect((await collect(events)).at(-1)?.type).toBe('run_completed')
    expect(resolved).toEqual([true])
    expect(database.getRunConfiguration(child.childRunId)?.capabilities.backgroundTools).toBe(true)
    expect(database.getRun(parent.id)?.status).toBe('interrupted')
  })

  it('persists an interrupt and resumes it with a native LangGraph Command', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Approval', projectId: 'locked-project' })
    const inputs: unknown[] = []
    const cleanupFileEdits = vi.fn(async () => {})
    const streams = [interruptedStream(), completedStream('Tests passed')]
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: (input) => {
          inputs.push(input)
          return streams.shift() as never
        },
        getState: async () => ({}) as never
      },
      dispose: async () => {}
    }), undefined, cleanupFileEdits)

    const interrupted = await collect(runtime.startRun({
      runId: 'run-2',
      threadId: thread.id,
      text: 'Run tests'
    }))
    expect(interrupted.at(-1)).toMatchObject({
      type: 'run_interrupted',
      run: { id: 'run-2', status: 'interrupted' },
      interrupts: [{ id: 'approval-1' }],
      snapshot: {
        pendingRun: { id: 'run-2', status: 'interrupted' }
      }
    })
    expect(cleanupFileEdits).not.toHaveBeenCalled()
    expect(database.checkpointer.hasRetainedRun(thread.id)).toBe(true)
    expect(() => runtime.startRun({
      runId: 'run-while-interrupted',
      threadId: thread.id,
      text: 'Start another run'
    })).toThrow('is busy')
    expect(() => runtime.startCompression(thread.id, 'compress-while-interrupted')).toThrow('is busy')
    await expect(runtime.truncateMessages({
      threadId: thread.id,
      messageId: 'human-1'
    })).rejects.toThrow('is busy')
    await expect(runtime.regenerateMessage({
      runId: 'regenerate-while-interrupted',
      threadId: thread.id,
      messageId: 'human-1'
    })).rejects.toThrow('is busy')
    await expect(runtime.deleteThread(thread.id)).rejects.toThrow('is busy')
    expect(database.getLatestRunForThread(thread.id)).toMatchObject({
      id: 'run-2',
      status: 'interrupted'
    })
    await expect(runtime.resumeRun({
      runId: 'missing-run',
      threadId: thread.id,
      responses: []
    })).rejects.toThrow(`Run missing-run does not belong to thread ${thread.id}.`)
    const otherThread = database.createThread({ title: 'Other approval thread' })
    await expect(runtime.resumeRun({
      runId: 'run-2',
      threadId: otherThread.id,
      responses: []
    })).rejects.toThrow(`Run run-2 does not belong to thread ${otherThread.id}.`)
    const resumed = await collect(await runtime.resumeRun({
      runId: 'run-2',
      threadId: thread.id,
      responses: [{
        interruptId: 'approval-1',
        decisions: [{ type: 'approve' }],
        expectedGeneration: await currentApprovalGeneration(runtime, thread.id, 'approval-1')
      }]
    }))
    expect(resumed[0]).toMatchObject({ type: 'run_started', newUserTurn: false })
    expect(inputs[1]).toBeInstanceOf(Command)
    expect(database.getThread(thread.id)?.accessMode).toBe('read_only_allowed')
    expect(resumed.at(-1)).toMatchObject({
      type: 'run_completed',
      run: { id: 'run-2', status: 'completed' }
    })
    expect(cleanupFileEdits).toHaveBeenCalledOnce()
    expect(cleanupFileEdits).toHaveBeenCalledWith('run-2')
    expect(database.checkpointer.hasRetainedRun(thread.id)).toBe(false)
  })

  it('rejects a stale subagent approval generation before mutating the durable run', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Stale subagent approval' })
    const run = database.createRun(thread.id, 'stale-subagent-approval-run')
    const interruptId = 'stale-subagent-approval-interrupt'
    await markRunInterrupted(
      database,
      thread.id,
      run.id,
      interruptId,
      {},
      {
        actionRequests: [{ name: 'pwsh', args: { command: 'Get-Date' } }],
        anasSubagentApproval: { generation: 'current-generation' }
      }
    )
    database.finishRun(run.id, 'interrupted')
    const inputs: unknown[] = []
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: (input) => {
          inputs.push(input)
          return completedStream('Approved current request') as never
        },
        getState: async () => ({}) as never
      },
      dispose: async () => {}
    }))
    const firstGeneration = await currentApprovalGeneration(runtime, thread.id, interruptId)
    const checkpointId = database.getRunCheckpointState(run.id).lastCommittedCheckpointId
    if (!checkpointId) throw new Error('Expected a durable approval checkpoint.')
    await database.checkpointer.putWrites({
      configurable: {
        thread_id: thread.id,
        checkpoint_ns: '',
        checkpoint_id: checkpointId
      }
    }, [['__resume__', [{ decisions: [{ type: 'approve' }] }]]], interruptId)
    const currentGeneration = await currentApprovalGeneration(runtime, thread.id, interruptId)
    expect(currentGeneration).not.toBe(firstGeneration)

    await expect(runtime.resumeRun({
      runId: run.id,
      threadId: thread.id,
      responses: [{
        interruptId,
        decisions: [{ type: 'approve' }],
        expectedGeneration: firstGeneration
      }]
    })).rejects.toThrow('does not match its current approval generation')
    expect(database.getRun(run.id)).toMatchObject({ status: 'interrupted' })
    expect(database.getRunCheckpointState(run.id).resumeIntent).toBeUndefined()
    expect(inputs).toHaveLength(0)

    await collect(await runtime.resumeRun({
      runId: run.id,
      threadId: thread.id,
      responses: [{
        interruptId,
        decisions: [{ type: 'approve' }],
        expectedGeneration: currentGeneration
      }]
    }))
    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toMatchObject({
      resume: {
        [interruptId]: {
          decisions: [{ type: 'approve' }],
          __anas_interrupt_generation: 'current-generation'
        }
      }
    })
  })

  it('serializes concurrent resumes before either can read the durable checkpoint', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Concurrent approval resume' })
    const run = database.createRun(thread.id, 'concurrent-approval-resume-run')
    const interruptId = 'concurrent-approval-resume-interrupt'
    await markRunInterrupted(database, thread.id, run.id, interruptId)
    database.finishRun(run.id, 'interrupted')
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: () => completedStream('Resumed once') as never,
        getState: async () => ({}) as never
      },
      dispose: async () => {}
    }))
    const generation = await currentApprovalGeneration(runtime, thread.id, interruptId)
    const originalGetTuple = database.checkpointer.getTuple.bind(database.checkpointer)
    let releaseTuple!: () => void
    const tupleGate = new Promise<void>((resolve) => { releaseTuple = resolve })
    const getTuple = vi.spyOn(database.checkpointer, 'getTuple')
      .mockImplementationOnce(async (config) => {
        await tupleGate
        return originalGetTuple(config)
      })
      .mockImplementation((config) => originalGetTuple(config))
    const input = {
      runId: run.id,
      threadId: thread.id,
      responses: [{
        interruptId,
        decisions: [{ type: 'approve' as const }],
        expectedGeneration: generation
      }]
    }

    const first = runtime.resumeRun(input)
    await vi.waitFor(() => expect(getTuple).toHaveBeenCalledOnce())
    await expect(runtime.resumeRun(input)).rejects.toThrow('cannot resume its run')
    expect(getTuple).toHaveBeenCalledOnce()

    releaseTuple()
    await collect(await first)
    expect(database.getRun(run.id)).toMatchObject({ status: 'completed' })
  })

  it('projects interrupted terminal state from durable root writes instead of stream hints', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Durable interrupt projection' })
    const runId = 'durable-interrupt-projection-run'
    const durableInterrupt = {
      id: 'durable-root-approval',
      value: { actionRequests: [{ name: 'execute', args: { command: 'npm test' } }] }
    }
    const values = {
      messages: [new HumanMessage({
        id: 'durable-interrupt-user',
        content: 'Run the tests',
        additional_kwargs: { anas_run_id: runId }
      })],
      todos: [],
      anasRunLifecycle: { runId, status: 'running' }
    }
    const runtime = new ProductionAgentRuntime(database, async () => ({
      agent: {
        streamEvents: async () => {
          const checkpointId = nextDurableCheckpointId()
          await putRootCheckpoint(database!, thread.id, checkpointId, values)
          await database!.checkpointer.putWrites({
            configurable: {
              thread_id: thread.id,
              checkpoint_ns: '',
              checkpoint_id: checkpointId
            }
          }, [['__interrupt__', [durableInterrupt]]], 'durable-interrupt-task')
          return mockProtocolStream({
            interrupted: true,
            interrupts: [{ interruptId: 'stale-stream-approval', payload: { stale: true } }],
            messages: empty(),
            toolCalls: empty(),
            subagents: empty(),
            output: Promise.resolve(values),
            abort() {}
          }) as never
        },
        getState: async () => ({ values, tasks: [] }) as never
      },
      dispose: async () => {}
    }), undefined, async () => {})

    const events = await collect(runtime.startRun({
      runId,
      threadId: thread.id,
      text: 'Run the tests'
    }))
    expect(events.at(-1)).toMatchObject({
      type: 'run_interrupted',
      interrupts: [durableInterrupt],
      snapshot: { interrupts: [durableInterrupt] }
    })
  })

  it('projects resolved path previews without changing framework action arguments', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Relative path approval' })
    const primaryFolder = resolve('workspace', 'primary')
    const relativePath = join('..', 'outside.txt')
    const actionRequests = [{
      name: 'delete_file',
      args: { path: relativePath }
    }, {
      name: 'pwsh',
      args: { command: 'npm test' }
    }]
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: () => mockProtocolStream({
          interrupted: true,
          interrupts: [{
            interruptId: 'relative-path-approval',
            payload: { actionRequests }
          }],
          messages: empty(),
          toolCalls: empty(),
          subagents: empty(),
          output: Promise.resolve({
            messages: [new HumanMessage('Write outside the workspace')],
            todos: []
          }),
          abort() {}
        }) as never,
        getState: async () => ({}) as never
      },
      workspace: { primaryFolder },
      dispose: async () => {}
    }))

    const events = await collect(runtime.startRun({
      runId: 'relative-path-run',
      threadId: thread.id,
      text: 'Write outside the workspace'
    }))
    const interrupted = events.at(-1)

    expect(interrupted).toMatchObject({
      type: 'run_interrupted',
      interrupts: [{
        value: { actionRequests },
        pathPreviews: [{
          actionIndex: 0,
          locator: ['path'],
          absolutePath: resolve(primaryFolder, relativePath),
          source: 'relative'
        }, {
          actionIndex: 1,
          locator: ['working_dir'],
          absolutePath: primaryFolder,
          source: 'default'
        }]
      }]
    })
  })

  it('emits an approval activity as soon as the framework task interrupts', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Live approval activity' })
    const call = { id: 'live-tool', name: 'execute', args: { command: 'npm test' } }
    const assistant = new AIMessage({
      id: 'live-assistant',
      content: '',
      tool_calls: [call]
    })
    const approval = {
      id: 'live-approval',
      value: { actionRequests: [{ name: call.name, args: call.args }] }
    }
    let release!: () => void
    const streamFinished = new Promise<void>((resolve) => {
      release = resolve
    })
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: () => ({
          interrupted: true,
          interrupts: [{ interruptId: approval.id, payload: approval.value }],
          messages: empty(),
          toolCalls: empty(),
          subagents: empty(),
          output: streamFinished.then(() => ({
            messages: [new HumanMessage('Run tests'), assistant],
            todos: []
          })),
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'event' as const,
              seq: 0,
              method: 'tasks',
              params: {
                namespace: [],
                timestamp: 0,
                data: {
                  id: 'approval-task',
                  name: 'HumanInTheLoopMiddleware.after_model',
                  input: { messages: [assistant] },
                  interrupts: []
                }
              }
            }
            yield {
              type: 'event' as const,
              seq: 1,
              method: 'tasks',
              params: {
                namespace: [],
                timestamp: 1,
                data: {
                  id: 'approval-task',
                  name: 'HumanInTheLoopMiddleware.after_model',
                  result: {},
                  interrupts: [approval]
                }
              }
            }
            await streamFinished
          },
          abort() {}
        }) as never,
        getState: async () => ({}) as never
      },
      dispose: async () => {}
    }))

    const events = runtime.startRun({
      runId: 'live-approval-run',
      threadId: thread.id,
      text: 'Run tests'
    })[Symbol.asyncIterator]()
    expect(await events.next()).toMatchObject({ value: { type: 'run_started' } })
    expect(await events.next()).toMatchObject({
      value: {
        type: 'tool_started',
        call
      }
    })
    expect(await events.next()).toMatchObject({
      value: {
        type: 'tool_approval_requested',
        call,
        approval: {
          status: 'pending_approval',
          interruptId: approval.id,
          actionIndex: 0
        }
      }
    })

    release()
    const remaining: AgentRuntimeEvent[] = []
    for await (const event of { [Symbol.asyncIterator]: () => events }) remaining.push(event)
    expect(remaining.at(-1)).toMatchObject({ type: 'run_interrupted' })
  })

  it('cleans unpinned threads while protecting pinned and active conversations', async () => {
    database = AgentDatabase.open(':memory:')
    const unpinned = database.createThread({ title: 'Remove unpinned' })
    const pinned = database.updateThread(
      database.createThread({ title: 'Keep pinned' }).id,
      { pinned: true }
    )
    const active = database.createThread({ title: 'Keep active' })
    database.createRun(active.id, 'active-cleanup-run')
    const runtime = new AgentRuntime(database)

    const unpinnedResult = await runtime.cleanupThreads()
    expect(unpinnedResult).toMatchObject({
      deleted: 1,
      skipped: 1,
      failed: 0,
      deletedThreadIds: [unpinned.id],
      skippedThreadIds: [active.id]
    })
    expect(database.getThread(unpinned.id)).toBeNull()
    expect(database.getThread(active.id)).not.toBeNull()
    expect(database.getThread(pinned.id)).not.toBeNull()
  })

  it('cleans hidden subagent state together with an unpinned owner', async () => {
    database = AgentDatabase.open(':memory:')
    const owner = database.createThread({ title: 'Remove owner and hidden child' })
    const parentRun = database.createRun(owner.id, 'cleanup-subagent-parent-run')
    const call = database.createSubagentCall({
      id: '14000000-0000-8000-8000-000000000001',
      ownerThreadId: owner.id,
      parentThreadId: owner.id,
      parentRunId: parentRun.id,
      childThreadId: '15000000-0000-8000-8000-000000000001',
      childRunId: '16000000-0000-8000-8000-000000000001',
      config: subagentConfig('reviewer'),
      description: 'Finish before cleanup.',
      childThread: { title: 'Hidden reviewer' }
    })
    await putRootCheckpoint(database, call.childThreadId, 'cleanup-child-checkpoint', {
      anasRunLifecycle: { runId: call.childRunId, status: 'running' }
    })
    expect(database.cancelRecoverableRun(call.childRunId)).toBe(true)
    database.finishSubagentCall({
      subagentId: call.id,
      ownerThreadId: owner.id,
      status: 'cancelled'
    })
    database.finishRun(parentRun.id, 'cancelled')
    const runtime = new AgentRuntime(database)

    await expect(runtime.cleanupThreads()).resolves.toMatchObject({
      deleted: 1,
      skipped: 0,
      deletedThreadIds: [owner.id]
    })
    expect(database.getThread(owner.id)).toBeNull()
    expect(database.getThread(call.childThreadId)).toBeNull()
    await expect(database.checkpointer.getTuple({
      configurable: { thread_id: call.childThreadId, checkpoint_ns: '' }
    })).resolves.toBeUndefined()
  })

  it.each(['initial', 'terminal', 'all'] as const)('releases the run and cancels work when %s cleanup report writes fail', async (failure) => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread()
    const oldRun = database.createRun(thread.id, 'report-failure-old-run')
    database.finishRun(oldRun.id, 'failed')
    const dispose = vi.fn(async () => {})
    const runtime = new AgentRuntime(database, async (_thread, _db, context) => ({
      agent: { streamEvents: () => completedStream('Final reply', { runId: context?.requestId }) as never, getState: async () => ({ values: {}, tasks: [] }) as never }, dispose
    }))
    const service = (runtime as unknown as { managedCalls: ManagedCallService }).managedCalls
    let aborted = false
    vi.useFakeTimers()
    const starting = service.start({ kind: 'shell', threadId: thread.id, runId: oldRun.id,
      summary: 'Old active call', execute: async (control) => {
        control.markRunning()
        await new Promise<void>((resolve) => control.signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }))
        return 'Stopped'
      } })
    await vi.advanceTimersByTimeAsync(10_000)
    const { call_id: callId } = JSON.parse(await starting)
    vi.useRealTimers()
    const persistCleanup = database.updateRunBackgroundCleanup.bind(database)
    const storage = vi.spyOn(database, 'updateRunBackgroundCleanup')
    const fail = () => { throw new Error('SQLite disk full') }
    if (failure === 'all') storage.mockImplementation(fail)
    else if (failure === 'terminal') storage.mockImplementation((runId, cleanup) => {
      if (cleanup.status !== 'running') return fail()
      return persistCleanup(runId, cleanup)
    })
    else storage.mockImplementationOnce(fail)
    try {
      const events = await collect(runtime.startRun({ threadId: thread.id, runId: 'report-failure-run', text: 'Finish' }))
      expect(aborted).toBe(true)
      expect(dispose).toHaveBeenCalled()
      expect(database.getManagedCall(callId, thread.id)).toMatchObject({ status: 'cancelled', result: 'Stopped' })
      expect(hasUnresolvedBackgroundTasks(database, thread.id)).toBe(false)
      const completed = events.at(-1)
      expect(completed).toMatchObject({ type: 'run_completed', run: { status: 'completed',
        backgroundCleanup: { status: failure === 'initial' ? 'completed' : 'unconfirmed' } } })
      if (completed?.type !== 'run_completed') throw new Error('Missing completion')
      expect(completed.snapshot?.settlingRun).toBeUndefined()
      expect(completed.snapshot?.activities.find((activity) => activity.runId === completed.run.id)?.backgroundCleanup)
        .toEqual(completed.run.backgroundCleanup)
      expect(events.some((event) => event.type === 'run_cleanup' && event.reply)).toBe(true)
      storage.mockRestore()
      const reopened = await runtime.getSnapshot(thread.id)
      expect(reopened.settlingRun).toBeUndefined()
      expect(reopened.activities.some((activity) => activity.backgroundCleanup?.status === 'running')).toBe(false)
      if (failure === 'terminal') expect(reopened.activities.find((activity) => activity.runId === 'report-failure-run')?.backgroundCleanup?.status).toBe('unconfirmed')
      const next = await collect(runtime.startRun({ threadId: thread.id, runId: 'report-failure-next', text: 'Continue' }))
      expect(next.at(-1)?.type).toBe('run_completed')
    } finally { storage.mockRestore(); await runtime.shutdown() }
  })

  it.each([false, true])('preserves the final answer and reports cleanup of old calls and descendants (remote uncertainty: %s)', async (uncertain) => {
    database = AgentDatabase.open(':memory:')
    const owner = database.createThread({ title: 'Automatic background cleanup' })
    const oldRun = database.createRun(owner.id, 'cleanup-old-run')
    const child = database.createSubagentCall({
      id: 'cleanup-child', ownerThreadId: owner.id, parentThreadId: owner.id, parentRunId: oldRun.id,
      childThreadId: 'cleanup-child-thread', childRunId: 'cleanup-child-run',
      config: subagentConfig('child'), description: 'Child task', childThread: { title: 'Child' }
    })
    const grandchild = database.createSubagentCall({
      id: 'cleanup-grandchild', ownerThreadId: owner.id, parentThreadId: child.childThreadId,
      parentRunId: child.childRunId, parentSubagentId: child.id,
      childThreadId: 'cleanup-grandchild-thread', childRunId: 'cleanup-grandchild-run',
      config: subagentConfig('grandchild'), description: 'Grandchild task', childThread: { title: 'Grandchild' }
    })
    database.createManagedCall({ id: 'cleanup-old-call', threadId: owner.id, runId: oldRun.id, kind: 'shell', summary: 'Old failed search' })
    database.markManagedCallDetached('cleanup-old-call', owner.id)
    database.finishManagedCall({ callId: 'cleanup-old-call', threadId: owner.id, status: 'failed', result: 'Preserved old result' })
    database.finishRun(oldRun.id, 'failed', 'Earlier failure')
    const other = database.createThread({ title: 'Unrelated conversation' })
    const otherRun = database.createRun(other.id, 'other-run')
    database.createManagedCall({ id: 'other-call', threadId: other.id, runId: otherRun.id, kind: 'http', summary: 'Keep separate' })
    database.markManagedCallDetached('other-call', other.id)
    database.finishManagedCall({ callId: 'other-call', threadId: other.id, status: 'completed', result: 'Separate result' })
    database.finishRun(otherRun.id, 'failed', 'Unrelated')
    let modelCalls = 0
    const runtime = new ProductionAgentRuntime(database, async (thread, db, context = {}) => ({
      agent: createDeepAgent({
        model: new FakeToolCallingModel({ toolCalls: [[]] }),
        checkpointer: db.checkpointer,
        tools: [tool(async () => 'unused', { name: 'read_call', description: 'Read status', schema: z.object({}) })],
        middleware: [
          createAgentRunLifecycleMiddleware(context.requestId),
          createManagedCallSupervisionMiddleware({
            unresolvedCalls: () => context.managedCalls!.unresolvedForThread(thread.id),
          }),
          createMiddleware({ name: 'KeepOriginalAnswer', wrapModelCall: async (request, handler) => {
            modelCalls += 1
            const response = await handler(request)
            response.id = `${context.requestId}-answer`
            response.additional_kwargs = { anas_run_id: context.requestId }
            response.content = 'Original final answer.'
            return response
          } })
        ]
      }) as never,
      dispose: async () => {}
    }))
    const service = (runtime as unknown as { managedCalls: ManagedCallService }).managedCalls
    let releaseCall!: () => void
    let cancellationRequested = false
    vi.useFakeTimers()
    const starting = service.start({
      threadId: grandchild.childThreadId, runId: grandchild.childRunId, kind: 'shell', summary: 'Live descendant call',
      uncertainWhenCancelledAfterDispatch: uncertain,
      execute: async (control) => {
        control.markRunning()
        control.output('stdout', 'Preserved live output')
        await new Promise<void>((resolve) => {
          releaseCall = resolve
          control.signal.addEventListener('abort', () => { cancellationRequested = true }, { once: true })
        })
        return 'Stopped'
      }
    })
    await vi.advanceTimersByTimeAsync(10_000)
    const liveId = (JSON.parse(await starting) as { call_id: string }).call_id
    vi.useRealTimers()
    const seen: AgentRuntimeEvent[] = []
    const execution = (async () => {
      for await (const event of runtime.startRun({ threadId: owner.id, runId: 'cleanup-current-run', text: 'Finish' })) seen.push(event)
    })()
    await vi.waitFor(() => expect(seen.some((event) => event.type === 'run_cleanup'
      && event.cleanup.report.includes(backgroundCleanupStarted))).toBe(true))
    const publishedReply = seen.findIndex((event) => event.type === 'run_cleanup' && event.reply?.content
      .some((block) => block.type === 'text' && block.text === 'Original final answer.'))
    expect(publishedReply).toBeGreaterThanOrEqual(0)
    expect(publishedReply).toBeLessThan(seen.findIndex((event) => event.type === 'run_cleanup'
      && event.cleanup.report.includes(backgroundCleanupStarted)))
    expect(cancellationRequested).toBe(true)
    expect(seen.some((event) => event.type === 'run_failed' || event.type === 'run_completed')).toBe(false)
    expect(database.getRun('cleanup-current-run')?.status).toBe('completed')
    expect(database.getRun('cleanup-current-run')?.error).toBeUndefined()
    expect(database.getRun('cleanup-current-run')?.backgroundCleanup?.report).toContain(backgroundCleanupStarted)
    const cleaningSnapshot = await runtime.getSnapshot(owner.id)
    expect(cleaningSnapshot.pendingRun).toBeUndefined()
    expect(cleaningSnapshot.settlingRun).toMatchObject({ id: 'cleanup-current-run', status: 'completed', backgroundCleanup: { status: 'running' } })
    releaseCall()
    await Promise.all([execution, starting])
    expect(modelCalls).toBe(1)
    expect(seen.at(-1)).toMatchObject({ type: 'run_completed', run: { status: 'completed', backgroundCleanup: { status: uncertain ? 'unconfirmed' : 'completed', report: expect.stringContaining(uncertain ? backgroundCleanupUnconfirmed : backgroundCleanupCompleted) } } })
    const snapshot = await runtime.getSnapshot(owner.id)
    expect(snapshot.messages.some((message) => message.content.some((block) => block.type === 'text' && block.text === 'Original final answer.'))).toBe(true)
    expect(snapshot.thread.status).toBe('idle')
    expect(snapshot.settlingRun).toBeUndefined()
    expect(snapshot.activities.find((activity) => activity.runId === 'cleanup-current-run')).toMatchObject({
      status: 'completed', backgroundCleanup: { status: uncertain ? 'unconfirmed' : 'completed' }
    })
    const error = database.getRun('cleanup-current-run')!.backgroundCleanup!.report
    for (const id of ['cleanup-old-call', child.id, grandchild.id]) expect(error).toContain(id)
    expect(service.activeCallIds()).toEqual([])
    expect(hasUnresolvedBackgroundTasks(database, owner.id)).toBe(false)
    expect(database.listUnresolvedManagedCallsForThread(other.id)).toHaveLength(1)
    expect(database.getManagedCall('cleanup-old-call', owner.id)?.result).toBe('Preserved old result')
    expect(service.readOutput({ callId: liveId, threadId: grandchild.childThreadId, offset: 0, length: 100 })).toContain('Preserved live output')
    expect(database.getSubagentCall(grandchild.id, owner.id)?.status).toBe('cancelled')
    const next = await collect(runtime.startRun({ threadId: owner.id, runId: 'cleanup-next-run', text: 'New task' }))
    expect(next.at(-1)?.type).toBe('run_completed')
    expect(modelCalls).toBe(2)
    await runtime.shutdown()
  })

  it('keeps conversations whose detached background result is still unresolved', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Keep unresolved background call' })
    const run = database.createRun(thread.id, 'unresolved-cleanup-run')
    database.createManagedCall({
      id: '11111111-1111-8111-8111-111111111111',
      threadId: thread.id,
      runId: run.id,
      kind: 'http',
      summary: 'remote request with an unknown outcome'
    })
    database.markManagedCallRunning('11111111-1111-8111-8111-111111111111', thread.id)
    database.markManagedCallDetached('11111111-1111-8111-8111-111111111111', thread.id)
    database.finishManagedCall({
      callId: '11111111-1111-8111-8111-111111111111',
      threadId: thread.id,
      status: 'uncertain',
      error: 'The remote outcome is unknown.'
    })
    await markRunCompleted(database, thread.id, run.id, { messages: [] })
    database.finishRun(run.id, 'completed')
    const runtime = new AgentRuntime(database)

    await expect(runtime.cleanupThreads()).resolves.toMatchObject({
      deleted: 0,
      skipped: 1,
      skippedThreadIds: [thread.id]
    })
    expect(database.getThread(thread.id)).toMatchObject({ id: thread.id })
  })

  it('keeps a terminal run active until disposal finishes for starts and cleanup', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Terminal active barrier' })
    let releaseDispose!: () => void
    const disposeBlocked = new Promise<void>((resolve) => {
      releaseDispose = resolve
    })
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: () => completedStream('Finished but not disposed') as never,
        getState: async () => ({ values: {}, tasks: [] }) as never
      },
      dispose: () => disposeBlocked
    }))
    const events = runtime.startRun({
      runId: 'terminal-active-run',
      threadId: thread.id,
      text: 'Finish the run'
    })
    await vi.waitFor(() => expect(database?.getRun('terminal-active-run')?.status).toBe('completed'))

    expect(database.checkpointer.hasRetainedRun(thread.id)).toBe(true)
    expect(database.getThread(thread.id)?.status).toBe('idle')
    expect(() => runtime.startRun({
      runId: 'overlapping-run',
      threadId: thread.id,
      text: 'Start too early'
    })).toThrow('cannot start another run')
    const cleanup = await runtime.cleanupThreads()
    expect(cleanup).toMatchObject({
      deleted: 0,
      skipped: 1,
      skippedThreadIds: [thread.id]
    })

    releaseDispose()
    const completedEvents = await collect(events)
    expect(completedEvents.at(-1)).toMatchObject({
      type: 'run_completed',
      run: { id: 'terminal-active-run', status: 'completed' }
    })
    expect(database.checkpointer.hasRetainedRun(thread.id)).toBe(false)
  })

  it.each([
    ['completed', 'model'], ['completed', 'preset'],
    ['failed', 'model'], ['failed', 'preset'],
    ['cancelled', 'model'], ['cancelled', 'preset']
  ] as const)('preserves a %s run selection changed during disposal (%s)', async (outcome, selection) => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ modelConfigId: 'model-a', modelParameterPresetId: 'original' })
    let releaseDispose!: () => void
    let markDisposing!: () => void
    let markStreaming!: () => void
    const disposalGate = new Promise<void>((resolve) => { releaseDispose = resolve })
    const disposing = new Promise<void>((resolve) => { markDisposing = resolve })
    const streaming = new Promise<void>((resolve) => { markStreaming = resolve })
    const pending = pendingStream()
    const runtime = new AgentRuntime(database, async (_thread, db, context) => ({
      agent: outcome === 'completed' ? createAgent({
        model: new FakeToolCallingModel({ toolCalls: [[]] }),
        tools: [],
        checkpointer: db.checkpointer,
        middleware: [createAgentRunLifecycleMiddleware(context?.requestId)]
      }) as never : {
        streamEvents: () => {
          if (outcome === 'failed') throw new Error('Provider request failed')
          markStreaming()
          return pending.stream as never
        },
        getState: async () => ({}) as never
      },
      dispose: async () => { markDisposing(); await disposalGate }
    }))
    const runId = `selection-during-disposal-${outcome}-${selection}`
    const events = collect(runtime.startRun({ runId, threadId: thread.id, text: 'Hello' }))
    try {
      if (outcome === 'cancelled') {
        await streaming
        runtime.cancelRun({ runId, threadId: thread.id })
      }
      await disposing
      const updated = database.updateThread(thread.id, selection === 'model'
        ? { modelConfigId: 'model-b', modelParameterPresetId: null }
        : { modelParameterPresetId: 'replacement' })
      releaseDispose()
      const completedEvents = await events
      const terminal = [...completedEvents].reverse().find((event) => event.type === `run_${outcome}`)
      expect(terminal?.type).toBe(`run_${outcome}`)
      if (terminal?.type === 'run_completed') expect(terminal.snapshot?.thread).toEqual(updated)
      expect((await runtime.getSnapshot(thread.id)).thread).toEqual(updated)
    } finally {
      releaseDispose()
      await events
      await runtime.shutdown()
    }
  })

  it('does not resume an interrupted run before its prior execution is disposed', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Interrupted active barrier' })
    let releaseDispose!: () => void
    const disposeBlocked = new Promise<void>((resolve) => {
      releaseDispose = resolve
    })
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: () => interruptedStream() as never,
        getState: async () => ({ values: {}, tasks: [] }) as never
      },
      dispose: () => disposeBlocked
    }))
    const iterator = runtime.startRun({
      runId: 'interrupted-active-run',
      threadId: thread.id,
      text: 'Pause for approval'
    })[Symbol.asyncIterator]()
    let terminal: AgentRuntimeEvent | undefined
    while (terminal?.type !== 'run_interrupted') {
      const next = await iterator.next()
      if (next.done) throw new Error('Expected an interrupted event before disposal.')
      terminal = next.value
    }

    await expect(runtime.resumeRun({
      runId: 'interrupted-active-run',
      threadId: thread.id,
      responses: [{
        interruptId: 'approval-1',
        decisions: [{ type: 'approve' }],
        expectedGeneration: terminal.interrupts[0].approvalGeneration
      }]
    })).rejects.toThrow('cannot resume its run')
    expect(database.getRun('interrupted-active-run')?.status).toBe('interrupted')

    releaseDispose()
    expect((await iterator.next()).done).toBe(true)
  })

  it('applies access-mode changes to the next run without mutating the active run snapshot', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({
      title: 'Revoke full access',
      accessMode: 'full_access'
    })
    const pending = pendingStream()
    const accessModeSnapshots: string[] = []
    let invocation = 0
    const runtime = new AgentRuntime(database, async (runtimeThread) => {
      accessModeSnapshots.push(runtimeThread.accessMode)
      return {
        agent: {
          streamEvents: () => {
            invocation += 1
            return invocation === 1
              ? pending.stream as never
              : completedStream('Approval requested again') as never
          },
          getState: async () => ({}) as never
        },
        dispose: async () => {}
      }
    })

    const activeEvents = collect(runtime.startRun({
      runId: 'active-before-revoke',
      threadId: thread.id,
      text: 'Use current access'
    }))
    await Promise.resolve()
    expect(accessModeSnapshots).toEqual(['full_access'])

    expect(database.setAccessMode(thread.id, 'strict_approval').accessMode).toBe('strict_approval')
    expect(accessModeSnapshots).toEqual(['full_access'])
    pending.complete('Current run completed')
    await activeEvents

    await collect(runtime.startRun({
      runId: 'next-after-revoke',
      threadId: thread.id,
      text: 'Request access again'
    }))
    expect(accessModeSnapshots).toEqual(['full_access', 'strict_approval'])
  })

  it('deduplicates a nested subagent interrupt before collecting human decisions', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Nested approval' })
    const inputs: unknown[] = []
    const streams = [duplicatedNestedInterruptStream(), completedStream('Disks inspected')]
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: (input) => {
          inputs.push(input)
          return streams.shift() as never
        },
        getState: async () => ({}) as never
      },
      dispose: async () => {}
    }))

    const interrupted = await collect(runtime.startRun({
      runId: 'run-nested',
      threadId: thread.id,
      text: 'Inspect disks'
    }))
    expect(interrupted.at(-1)).toMatchObject({
      type: 'run_interrupted',
      interrupts: [{
        id: 'nested-approval',
        value: {
          actionRequests: [
            { args: { command: 'dir C:\\' } },
            { args: { command: 'dir D:\\' } }
          ]
        }
      }]
    })

    await collect(await runtime.resumeRun({
      runId: 'run-nested',
      threadId: thread.id,
      responses: [{
        interruptId: 'nested-approval',
        decisions: [{ type: 'approve' }, { type: 'approve' }],
        expectedGeneration: await currentApprovalGeneration(
          runtime,
          thread.id,
          'nested-approval'
        )
      }]
    }))
    expect(inputs[1]).toMatchObject({
      resume: {
        'nested-approval': {
          decisions: [{ type: 'approve' }, { type: 'approve' }]
        }
      }
    })
  })

  it('resumes independent parallel interrupts by their LangGraph IDs', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Parallel approval' })
    const inputs: unknown[] = []
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: (input) => {
          inputs.push(input)
          return completedStream('Parallel actions reviewed') as never
        },
        getState: async () => ({}) as never
      },
      dispose: async () => {}
    }))
    const run = database.createRun(thread.id, 'run-parallel')
    await markRunInterrupted(database, thread.id, run.id, 'child-one')
    const parallelCheckpointId = database.getRunCheckpointState(run.id)
      .lastCommittedCheckpointId
    if (!parallelCheckpointId) throw new Error('Expected a durable parallel interrupt checkpoint.')
    await database.checkpointer.putWrites({
      configurable: {
        thread_id: thread.id,
        checkpoint_ns: '',
        checkpoint_id: parallelCheckpointId
      }
    }, [[
      '__interrupt__',
      [{ id: 'child-two', value: { branch: 'right' } }]
    ]], `${run.id}-interrupt-task-two`)
    database.finishRun(run.id, 'interrupted')

    await collect(await runtime.resumeRun({
      runId: run.id,
      threadId: thread.id,
      responses: [
        {
          interruptId: 'child-one',
          decisions: [{ type: 'approve' }],
          expectedGeneration: await currentApprovalGeneration(runtime, thread.id, 'child-one')
        },
        {
          interruptId: 'child-two',
          decisions: [{ type: 'reject', message: 'Do not run this.' }],
          expectedGeneration: await currentApprovalGeneration(runtime, thread.id, 'child-two')
        }
      ]
    }))

    expect(inputs[0]).toMatchObject({
      resume: {
        'child-one': {
          decisions: [{ type: 'approve' }]
        },
        'child-two': {
          decisions: [{ type: 'reject', message: 'Do not run this.' }]
        }
      }
    })
  })

  it('resumes identical propagated interrupt copies as one logical approval', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Propagated parallel approval' })
    const inputs: unknown[] = []
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: (input) => {
          inputs.push(input)
          return completedStream('Propagated action reviewed') as never
        },
        getState: async () => ({}) as never
      },
      dispose: async () => {}
    }))
    const run = database.createRun(thread.id, 'run-propagated-parallel')
    const value = {
      actionRequests: [{
        name: 'pwsh',
        args: { command: 'publish' },
        anasRecovery: { ordinal: 1, state: 'uncertain' }
      }]
    }
    await markRunInterrupted(
      database,
      thread.id,
      run.id,
      'shared-effect-recovery',
      {},
      value
    )
    const checkpointId = database.getRunCheckpointState(run.id)
      .lastCommittedCheckpointId
    if (!checkpointId) throw new Error('Expected a durable propagated interrupt checkpoint.')
    await database.checkpointer.putWrites({
      configurable: {
        thread_id: thread.id,
        checkpoint_ns: '',
        checkpoint_id: checkpointId
      }
    }, [[
      '__interrupt__',
      [{ id: 'shared-effect-recovery', value }]
    ]], `${run.id}-blocked-sibling`)
    database.finishRun(run.id, 'interrupted')

    await collect(await runtime.resumeRun({
      runId: run.id,
      threadId: thread.id,
      responses: [{
        interruptId: 'shared-effect-recovery',
        decisions: [{ type: 'approve' }],
        expectedGeneration: await currentApprovalGeneration(
          runtime,
          thread.id,
          'shared-effect-recovery'
        )
      }]
    }))

    expect(inputs[0]).toMatchObject({
      resume: {
        'shared-effect-recovery': {
          decisions: [{ type: 'approve' }]
        }
      }
    })
  })

  it('deduplicates nested interrupts when restoring an interrupted thread', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Restored approval' })
    const run = database.createRun(thread.id, 'run-restored')
    const interrupt = {
      id: 'restored-approval',
      value: {
        actionRequests: [
          { name: 'execute', args: { command: 'dir C:\\' } },
          { name: 'execute', args: { command: 'dir D:\\' } }
        ]
      }
    }
    await markRunInterrupted(
      database,
      thread.id,
      run.id,
      interrupt.id,
      { messages: [], todos: [] },
      interrupt.value
    )
    const checkpointId = database.getRunCheckpointState(run.id).lastCommittedCheckpointId
    if (!checkpointId) throw new Error('Expected a durable interrupt checkpoint.')
    await database.checkpointer.putWrites({
      configurable: {
        thread_id: thread.id,
        checkpoint_ns: '',
        checkpoint_id: checkpointId
      }
    }, [['__interrupt__', interrupt]], 'duplicate-child-interrupt')
    database.finishRun(run.id, 'interrupted')
    const instanceFactory = vi.fn(async () => {
      throw new Error('Snapshot must not construct an agent.')
    })
    const runtime = new AgentRuntime(database, instanceFactory as never)

    const snapshot = await runtime.getSnapshot(thread.id)

    expect(snapshot.interrupts).toEqual([expect.objectContaining(interrupt)])
    expect(instanceFactory).not.toHaveBeenCalled()
  })

  it('does not project an acknowledged interrupt while its resume command is in flight', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Resume projection' })
    const run = database.createRun(thread.id, 'resume-projection-run')
    await markRunInterrupted(
      database,
      thread.id,
      run.id,
      'resume-projection-interrupt'
    )
    database.finishRun(run.id, 'interrupted')
    database.resumeRun(run.id, [{
      interruptId: 'resume-projection-interrupt',
      response: { decisions: [{ type: 'approve' }] }
    }])
    const runtime = new AgentRuntime(database, async () => {
      throw new Error('Snapshot must not construct an agent.')
    })

    const snapshot = await runtime.getSnapshot(thread.id)

    expect(snapshot.pendingRun).toMatchObject({ id: run.id, status: 'running' })
    expect(snapshot.interrupts).toEqual([])
  })

  it('returns the latest 100 messages and expands history in 100-message pages', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Long history' })
    const summaryRun = database.createRun(thread.id, 'history-summary-run')
    const summary = database.recordContextSummaryStarted(summaryRun.id, 'history-summary')
    await stageAndCommitSummary(database, thread.id, summaryRun.id, summary.id, {
      summaryText: 'Earlier decisions',
      modelContent: 'Earlier decisions',
      cutoffIndex: 140,
      activatedAfterMessageIndex: 150,
      coveredThroughMessageId: 'message-139',
      firstPreservedMessageId: 'message-140'
    })
    await markRunCompleted(database, thread.id, summaryRun.id)
    database.finishRun(summaryRun.id, 'completed')
    const messages = Array.from({ length: 225 }, (_, index) =>
      new HumanMessage({
        id: `message-${index}`,
        content: `Message ${index}`,
        additional_kwargs: index === 150
          ? { anas_run_id: summaryRun.id }
          : {}
      })
    )
    await putRootCheckpoint(database, thread.id, nextDurableCheckpointId(), {
      messages,
      todos: [],
      anasRunLifecycle: { runId: summaryRun.id, status: 'completed' }
    })
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: () => completedStream('unused') as never,
        getState: async () => ({
          values: { messages, todos: [] },
          tasks: []
        }) as never
      },
      dispose: async () => {}
    }))

    const initial = await runtime.getSnapshot(thread.id)
    expect(initial.messages.map((message) => message.id)).toEqual(
      messages.slice(125).map((message) => message.id)
    )
    expect(initial.messageWindow).toEqual({
      startIndex: 125,
      shown: 100,
      total: 225,
      remaining: 125
    })

    const firstPage = await runtime.loadEarlierMessages({
      threadId: thread.id,
      beforeIndex: initial.messageWindow.startIndex
    })
    expect(firstPage.messages).toHaveLength(200)
    expect(firstPage.messageWindow).toEqual({
      startIndex: 25,
      shown: 200,
      total: 225,
      remaining: 25
    })
    expect(firstPage.activities).toEqual([
      expect.objectContaining({
        runId: summaryRun.id,
        summaries: [
          expect.objectContaining({
            coveredThroughMessageId: 'message-139',
            firstPreservedMessageId: 'message-140'
          })
        ]
      })
    ])

    const secondPage = await runtime.loadEarlierMessages({
      threadId: thread.id,
      beforeIndex: firstPage.messageWindow.startIndex
    })
    expect(secondPage.messageWindow).toMatchObject({
      startIndex: 0,
      shown: 225,
      remaining: 0
    })
  })

  it('loads an earlier activity page using only its committed message evidence', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Activity pages' })
    const otherThread = database.createThread({ title: 'Other activity owner' })
    const run = database.createRun(thread.id, 'activity-pages-run')
    database.recordModelActivity(run.id, {
      id: 'uncommitted-model', status: 'completed', text: 'Not committed', reasoning: '', toolCallIds: []
    })
    const messages = Array.from({ length: 105 }, (_, index) => {
      const message = new AIMessage({
        id: `activity-message-${index}`, content: `Completed response ${index}`,
        additional_kwargs: { anas_run_id: run.id }
      })
      database!.recordModelActivity(run.id, {
        id: `activity-model-${index}`, messageId: message.id,
        status: 'completed', text: message.text, reasoning: '', toolCallIds: []
      })
      return message
    })
    await putRootCheckpoint(database, thread.id, nextDurableCheckpointId(), { messages })
    const runtime = new AgentRuntime(database, async () => {
      throw new Error('Activity paging must not construct an agent.')
    })
    const latest = database.getRunActivityWindow(run.id)
    expect(latest.models).toHaveLength(100)
    const cursor = latest.activityWindow!.startSequence!
    const wholeRunRead = vi.spyOn(database, 'readRunMessages').mockImplementation(() => {
      throw new Error('Activity paging must not read the whole run.')
    })
    const evidenceRead = vi.spyOn(database, 'readActivityMessages')

    const earlier = runtime.loadEarlierActivities({ threadId: thread.id, runId: run.id, beforeSequence: cursor })

    expect(earlier.models.map((model) => model.messageId)).toEqual(messages.slice(0, 5).map((message) => message.id))
    expect(earlier.activityWindow).toMatchObject({ hasEarlier: false, totalCount: 106 })
    expect(evidenceRead.mock.results.flatMap((result) => (result.value as AIMessage[]).map((message) => message.id)))
      .toEqual(messages.slice(0, 5).map((message) => message.id))
    expect(wholeRunRead).not.toHaveBeenCalled()
    expect(() => runtime.loadEarlierActivities({ threadId: otherThread.id, runId: run.id, beforeSequence: cursor }))
      .toThrow('was not found in thread')
    expect(() => runtime.loadEarlierActivities({ threadId: thread.id, runId: 'missing-run', beforeSequence: cursor }))
      .toThrow('was not found in thread')
    expect(() => runtime.loadEarlierActivities({ threadId: thread.id, runId: run.id, beforeSequence: -1 }))
      .toThrow('cursor is invalid')
  })

  it('projects only the user turn and final root response from checkpoint messages', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Conversation projection' })
    const run = database.createRun(thread.id, 'projection-run')
    database.recordModelActivity(run.id, {
      id: 'projection-model-1',
      messageId: 'projection-intermediate',
      status: 'completed',
      text: 'I will search first.',
      reasoning: '',
      toolCallIds: ['projection-tool']
    })
    database.recordToolActivity(run.id, {
      id: 'projection-tool',
      name: 'search',
      args: { query: 'latest news' }
    }, 'completed', undefined, 'Search result')
    database.recordModelActivity(run.id, {
      id: 'projection-model-2',
      messageId: 'projection-final',
      status: 'completed',
      text: 'Final answer',
      reasoning: '',
      toolCallIds: []
    })
    const messages = [
      new HumanMessage({
        id: 'projection-user',
        content: 'Research this',
        additional_kwargs: { anas_run_id: run.id }
      }),
      new AIMessage({
        id: 'projection-intermediate',
        content: 'I will search first.',
        tool_calls: [{
          id: 'projection-tool',
          name: 'search',
          args: { query: 'latest news' }
        }],
        additional_kwargs: { anas_run_id: run.id }
      }),
      new ToolMessage({
        id: 'projection-result',
        tool_call_id: 'projection-tool',
        content: 'Search result'
      }),
      new AIMessage({
        id: 'projection-final',
        content: 'Final answer',
        additional_kwargs: {
          anas_run_id: run.id,
          anas_created_at: '2026-08-09T01:02:03.000Z'
        }
      })
    ]
    await putRootCheckpoint(database, thread.id, nextDurableCheckpointId(), {
      messages,
      todos: [],
      anasRunLifecycle: { runId: run.id, status: 'completed' }
    })
    database.finishRun(run.id, 'completed')
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: () => completedStream('unused') as never,
        getState: async () => ({ values: { messages, todos: [] }, tasks: [] }) as never
      },
      dispose: async () => {}
    }))

    const snapshot = await runtime.getSnapshot(thread.id)

    expect(snapshot.messages.map((message) => message.id)).toEqual([
      'projection-user',
      'projection-final'
    ])
    expect(snapshot.messages[1]).toMatchObject({
      role: 'assistant',
      runId: run.id,
      createdAt: '2026-08-09T01:02:03.000Z',
      content: [{ type: 'text', text: 'Final answer' }]
    })
    expect(snapshot.activities[0]).toMatchObject({
      runId: run.id,
      models: [
        expect.objectContaining({ text: 'I will search first.' }),
        expect.objectContaining({ text: 'Final answer' })
      ],
      tools: [expect.objectContaining({ call: expect.objectContaining({ id: 'projection-tool' }) })]
    })
  })

  it('projects a checkpoint final response while its run is still running and activity is missing', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Checkpoint crash recovery' })
    const run = database.createRun(thread.id, 'checkpoint-crash-run')
    const messages = [
      new HumanMessage({
        id: 'checkpoint-user',
        content: 'Finish before the process crashes',
        additional_kwargs: {
          anas_run_id: run.id,
          anas_created_at: '2026-08-09T02:00:00.000Z'
        }
      }),
      new AIMessage({
        id: 'checkpoint-tool-call',
        content: 'Checking first',
        tool_calls: [{ id: 'checkpoint-tool', name: 'search', args: { query: 'state' } }],
        additional_kwargs: { anas_run_id: run.id }
      }),
      new ToolMessage({
        id: 'checkpoint-tool-result',
        tool_call_id: 'checkpoint-tool',
        content: 'result',
        additional_kwargs: { anas_run_id: run.id }
      }),
      new AIMessage({
        id: 'checkpoint-final',
        content: 'Durable final answer',
        additional_kwargs: {
          anas_run_id: run.id,
          anas_created_at: '2026-08-09T02:00:01.000Z'
        }
      })
    ]
    await putRootCheckpoint(database, thread.id, nextDurableCheckpointId(), {
      messages,
      todos: [],
      anasRunLifecycle: { runId: run.id, status: 'running' }
    })
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: () => completedStream('unused') as never,
        getState: async () => ({ values: { messages, todos: [] }, tasks: [] }) as never
      },
      dispose: async () => {}
    }))

    const snapshot = await runtime.getSnapshot(thread.id)

    expect(database.getRun(run.id)?.status).toBe('running')
    expect(snapshot.pendingRun).toMatchObject({
      id: run.id,
      status: 'running'
    })
    expect(snapshot.messages.map((message) => message.id)).toEqual([
      'checkpoint-user',
      'checkpoint-final'
    ])
    expect(snapshot.messages[1]).toMatchObject({
      role: 'assistant',
      runId: run.id,
      createdAt: '2026-08-09T02:00:01.000Z',
      content: [{ type: 'text', text: 'Durable final answer' }]
    })
    expect(snapshot.activities).toEqual([
      expect.objectContaining({
        runId: run.id,
        status: 'running',
        models: [
          expect.objectContaining({ messageId: 'checkpoint-tool-call', status: 'completed' }),
          expect.objectContaining({ messageId: 'checkpoint-final', status: 'completed' })
        ],
        tools: [expect.objectContaining({
          call: expect.objectContaining({ id: 'checkpoint-tool' }),
          status: 'completed',
          output: 'result'
        })]
      })
    ])
  })

  it('keeps committed child relationships visible before the root tool result and reads only complete child messages', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Independent child evidence' })
    const run = database.createRun(thread.id, 'child-evidence-parent')
    const child = database.createSubagentCall({
      id: '71000000-0000-8000-8000-000000000001', ownerThreadId: thread.id,
      parentThreadId: thread.id, parentRunId: run.id,
      childThreadId: '72000000-0000-8000-8000-000000000001',
      childRunId: '73000000-0000-8000-8000-000000000001',
      config: subagentConfig('reviewer'), description: 'Inspect complete child messages.',
      childThread: { title: 'Child evidence' }
    })
    await putRootCheckpoint(database, thread.id, 'child-evidence-root', {
      anasRunLifecycle: { runId: run.id, status: 'running' }
    })
    database.recordProjectedModelActivity(child.id, thread.id, {
      id: 'child-evidence-model', subagentId: child.id, status: 'running',
      text: 'Incomplete prefix', reasoning: '', toolCallIds: []
    })
    const runtime = new AgentRuntime(database)
    const before = await runtime.getSnapshot(thread.id)
    expect(before.activities[0]?.subagents).toEqual([
      expect.objectContaining({ id: child.id, status: 'running' })
    ])
    expect(before.activities[0]?.models).toEqual([])
    database.recordProjectedModelActivity(child.id, thread.id, {
      id: 'child-evidence-model', messageId: 'child-evidence-message', subagentId: child.id,
      status: 'completed', text: 'Complete child answer', reasoning: '', toolCallIds: []
    })
    await putRootCheckpoint(database, child.childThreadId, 'child-evidence-complete', {
      messages: [new AIMessage({ id: 'child-evidence-message', content: 'Complete child answer',
        additional_kwargs: { anas_run_id: child.childRunId } })],
      anasRunLifecycle: { runId: child.childRunId, status: 'running' }
    })
    const after = await runtime.getSnapshot(thread.id)
    expect(after.activities[0]?.subagents).toEqual(before.activities[0]?.subagents)
    expect(after.activities[0]?.models).toEqual([
      expect.objectContaining({ id: 'child-evidence-model', text: 'Complete child answer' })
    ])
    const nested = database.createSubagentCall({
      id: '74000000-0000-8000-8000-000000000001', ownerThreadId: thread.id,
      parentThreadId: child.childThreadId, parentRunId: child.childRunId, parentSubagentId: child.id,
      childThreadId: '75000000-0000-8000-8000-000000000001', childRunId: '76000000-0000-8000-8000-000000000001',
      config: subagentConfig('reviewer'), description: 'Publish one nested event.', childThread: { title: 'Nested evidence' }
    })
    await putRootCheckpoint(database, nested.childThreadId, 'nested-evidence-complete', {
      messages: [new AIMessage({ id: 'nested-evidence-message', content: 'Nested answer', additional_kwargs: { anas_run_id: nested.childRunId } })],
      anasRunLifecycle: { runId: nested.childRunId, status: 'running' }
    })
    const projectedModel = database.recordProjectedModelActivity(nested.id, thread.id, {
      id: 'nested-evidence-model', messageId: 'nested-evidence-message', subagentId: nested.id,
      status: 'completed', text: 'Nested answer', reasoning: '', toolCallIds: []
    })
    const readBody = vi.spyOn(database.checkpointer, 'getMessageRecordById')
    const project = runtime as unknown as {
      projectSubagentEvent(call: AgentSubagentCallRecord, event: AgentRuntimeEvent): Promise<AgentRuntimeEvent | undefined>
    }
    expect(await project.projectSubagentEvent(child, {
      type: 'model_completed', runId: child.childRunId, threadId: child.childThreadId, model: projectedModel
    })).toMatchObject({ type: 'model_completed', runId: run.id, model: { text: 'Nested answer' } })
    expect(readBody.mock.results.length).toBeGreaterThan(0)
    expect(readBody.mock.results.every((result) => result.type === 'return' && result.value?.messageId === 'nested-evidence-message')).toBe(true)
  })

  it('does not project DB-ahead root tool completion without a durable ToolMessage', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Durable activity projection' })
    const run = database.createRun(thread.id, 'durable-activity-run')
    database.recordModelActivity(run.id, {
      id: 'durable-model',
      messageId: 'durable-call-message',
      status: 'completed',
      text: 'Calling the tool',
      reasoning: '',
      toolCallIds: ['db-ahead-tool']
    })
    database.recordToolActivity(run.id, {
      id: 'db-ahead-tool',
      name: 'lookup',
      args: { query: 'value' }
    }, 'completed', undefined, 'DB-ahead output')
    database.recordSubagentActivity(
      run.id,
      'db-ahead-tool',
      'general-purpose',
      'completed',
      undefined,
      'DB-ahead result'
    )
    database.recordModelActivity(run.id, {
      id: 'db-ahead-nested-model',
      status: 'completed',
      subagentId: 'db-ahead-tool',
      text: 'Nested DB-ahead model',
      reasoning: '',
      toolCallIds: ['db-ahead-nested-tool']
    })
    database.recordToolActivity(run.id, {
      id: 'db-ahead-nested-tool',
      name: 'read_file',
      args: { path: 'nested.txt' }
    }, 'completed', 'db-ahead-tool', 'Nested DB-ahead output')
    database.recordSubagentActivity(
      run.id,
      'db-ahead-child',
      'general-purpose',
      'completed',
      'db-ahead-tool',
      'Nested DB-ahead child result'
    )
    database.recordModelActivity(run.id, {
      id: 'db-only-root-model',
      messageId: 'db-only-root-message',
      status: 'completed',
      text: 'Never reached a checkpoint',
      reasoning: '',
      toolCallIds: ['db-only-root-tool']
    })
    database.recordToolActivity(run.id, {
      id: 'db-only-root-tool',
      name: 'start_subagent',
      args: { agent: 'general-purpose', description: 'Not durable' }
    }, 'completed', undefined, 'Speculative output')
    database.recordSubagentActivity(
      run.id,
      'db-only-root-tool',
      'general-purpose',
      'completed',
      undefined,
      'Speculative child result'
    )
    const messages = [
      new HumanMessage({
        id: 'durable-user',
        content: 'Look this up',
        additional_kwargs: { anas_run_id: run.id }
      }),
      new AIMessage({
        id: 'durable-call-message',
        content: 'Calling the tool',
        tool_calls: [{
          id: 'db-ahead-tool',
          name: 'lookup',
          args: { query: 'value' }
        }],
        additional_kwargs: { anas_run_id: run.id }
      })
    ]
    const checkpointId = nextDurableCheckpointId()
    let snapshotCheckpointId = checkpointId
    await putRootCheckpoint(database, thread.id, checkpointId, {
      messages,
      anasRunLifecycle: { runId: run.id, status: 'running' }
    })
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: () => completedStream('unused') as never,
        getState: async () => ({
          values: { messages },
          tasks: [],
          config: { configurable: { checkpoint_id: snapshotCheckpointId } }
        }) as never
      },
      dispose: async () => {}
    }))

    const recoverable = await runtime.getSnapshot(thread.id)
    expect(recoverable.activities[0]).toMatchObject({
      status: 'running',
      models: [expect.objectContaining({
        messageId: 'durable-call-message',
        status: 'completed'
      })],
      tools: [expect.objectContaining({
        call: expect.objectContaining({ id: 'db-ahead-tool' }),
        status: 'running',
        output: undefined,
        completedAt: undefined
      })],
      subagents: []
    })
    expect(recoverable.activities[0].models.some(
      (model) => model.id === 'db-ahead-nested-model'
    )).toBe(false)
    expect(recoverable.activities[0].tools.some(
      (tool) => tool.call.id === 'db-ahead-nested-tool'
    )).toBe(false)
    expect(recoverable.activities[0].subagents.some(
      (subagent) => subagent.id === 'db-ahead-child'
    )).toBe(false)
    expect(recoverable.activities[0].models.some(
      (model) => model.id === 'db-only-root-model'
    )).toBe(false)
    expect(recoverable.activities[0].tools.some(
      (tool) => tool.call.id === 'db-only-root-tool'
    )).toBe(false)
    expect(recoverable.activities[0].subagents.some(
      (subagent) => subagent.id === 'db-only-root-tool'
    )).toBe(false)

    database.finishRun(run.id, 'failed', 'Tool result was not durable.')
    const failed = await runtime.getSnapshot(thread.id)
    expect(failed.activities[0]).toMatchObject({
      status: 'failed',
      models: [expect.objectContaining({ messageId: 'durable-call-message' })],
      tools: [],
      subagents: []
    })

    const nextRun = database.createRun(thread.id, 'next-activity-run')
    snapshotCheckpointId = nextDurableCheckpointId()
    await putRootCheckpoint(database, thread.id, snapshotCheckpointId, {
      messages,
      anasRunLifecycle: { runId: nextRun.id, status: 'completed' }
    })
    database.finishRun(nextRun.id, 'completed')
    const afterNextRun = await runtime.getSnapshot(thread.id)
    expect(afterNextRun.activities.find((activity) => activity.runId === run.id)).toMatchObject({
      tools: [],
      subagents: []
    })
  })

  it('does not reuse an older ToolMessage when a later run reuses the tool-call ID', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Reused tool call id' })
    const call = { id: 'shared-call-id', name: 'lookup', args: { query: 'value' } }
    const oldRun = database.createRun(thread.id, 'old-shared-call-run')
    const oldMessages = [
      new HumanMessage({
        id: 'old-shared-user',
        content: 'Old lookup',
        additional_kwargs: { anas_run_id: oldRun.id }
      }),
      new AIMessage({
        id: 'old-shared-assistant',
        content: '',
        tool_calls: [call],
        additional_kwargs: { anas_run_id: oldRun.id }
      }),
      new ToolMessage({
        id: 'old-shared-result',
        tool_call_id: call.id,
        content: 'old output',
        additional_kwargs: { anas_run_id: oldRun.id }
      })
    ]
    await putRootCheckpoint(database, thread.id, nextDurableCheckpointId(), {
      messages: oldMessages,
      anasRunLifecycle: { runId: oldRun.id, status: 'completed' }
    })
    database.finishRun(oldRun.id, 'completed')
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: () => completedStream('unused') as never,
        getState: async () => ({ values: {}, tasks: [] }) as never
      },
      dispose: async () => {}
    }))
    await runtime.getSnapshot(thread.id)

    const currentRun = database.createRun(thread.id, 'current-shared-call-run')
    database.recordModelActivity(currentRun.id, {
      id: 'current-shared-model',
      messageId: 'current-shared-assistant',
      status: 'completed',
      text: '',
      reasoning: '',
      toolCallIds: [call.id]
    })
    database.recordToolActivity(
      currentRun.id,
      call,
      'completed',
      undefined,
      'incorrect DB-ahead output'
    )
    const currentMessages = [
      ...oldMessages,
      new HumanMessage({
        id: 'current-shared-user',
        content: 'New lookup',
        additional_kwargs: { anas_run_id: currentRun.id }
      }),
      new AIMessage({
        id: 'current-shared-assistant',
        content: '',
        tool_calls: [call],
        additional_kwargs: { anas_run_id: currentRun.id }
      })
    ]
    await putRootCheckpoint(database, thread.id, nextDurableCheckpointId(), {
      messages: currentMessages,
      anasRunLifecycle: { runId: currentRun.id, status: 'running' }
    })

    const missingCurrentResult = await runtime.getSnapshot(thread.id)
    expect(missingCurrentResult.activities.find(
      (activity) => activity.runId === currentRun.id
    )?.tools).toEqual([
      expect.objectContaining({
        call,
        status: 'running',
        output: undefined,
        completedAt: undefined
      })
    ])

    const currentResult = new ToolMessage({
      id: 'current-shared-result',
      tool_call_id: call.id,
      content: 'current output',
      additional_kwargs: { anas_run_id: currentRun.id }
    })
    const terminalMessages = [...currentMessages, currentResult]
    await putRootCheckpoint(database, thread.id, nextDurableCheckpointId(), {
      messages: terminalMessages,
      anasRunLifecycle: { runId: currentRun.id, status: 'completed' }
    })
    database.finishRun(currentRun.id, 'completed')
    const completed = await runtime.getSnapshot(thread.id)
    expect(completed.activities.find(
      (activity) => activity.runId === currentRun.id
    )?.tools).toEqual([
      expect.objectContaining({
        call,
        status: 'completed',
        output: 'current output'
      })
    ])
    expect(database.getActivitiesForThread(thread.id).find(
      (activity) => activity.runId === currentRun.id
    )?.tools[0].output).toBe('current output')
  })

  it('recovers one durable agent run with null input and does not restart completed graph work', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Automatic recovery' })
    const run = database.createRun(thread.id, 'recoverable-run')
    vi.spyOn(database, 'listRecoverableRuns').mockReturnValue([run])
    const inputs: unknown[] = []
    const executedTasks: string[] = []
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: (input) => {
          inputs.push(input)
          if (input !== null) executedTasks.push('already-completed-task')
          executedTasks.push('pending-task')
          return completedStream('Recovered answer') as never
        },
        getState: async () => ({}) as never
      },
      dispose: async () => {}
    }))

    const recovery = runtime.recoverRun(thread.id)
    expect(recovery).toBeDefined()
    expect(runtime.recoverRun(thread.id)).toBeUndefined()
    const events = await collect(recovery as AsyncIterable<AgentRuntimeEvent>)

    expect(inputs).toEqual([null])
    expect(executedTasks).toEqual(['pending-task'])
    expect(events[0]).toMatchObject({
      type: 'run_started',
      run: { id: run.id, status: 'running' },
      newUserTurn: false
    })
    expect(events.at(-1)).toMatchObject({
      type: 'run_completed',
      run: { id: run.id, status: 'completed' }
    })
    expect(database.getRun(run.id)?.status).toBe('completed')
  })

  it.each([
    new ModelSelectionError('The selected model no longer exists. Select another model and send again.'),
    new ModelRequestChangedError()
  ].flatMap((failure) => [false, true].map((wrapped) => ({ failure, wrapped }))))('ends a recoverable run on $failure.name (framework wrapper: $wrapped) and preserves its checkpoint history', async ({ failure, wrapped }) => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Invalid live model', modelConfigId: 'removed' })
    const run = database.createRun(thread.id, 'invalid-live-model-run')
    await putRootCheckpoint(database, thread.id, nextDurableCheckpointId(), {
      messages: [new HumanMessage({ id: 'saved-user', content: 'Keep this question.', additional_kwargs: { anas_run_id: run.id } })],
      anasRunLifecycle: { runId: run.id, status: 'running' }
    })
    const runtime = new AgentRuntime(database, async () => {
      if (wrapped) {
        await createAgent({ model: new FakeToolCallingModel(), middleware: [createMiddleware({
          name: 'InvalidCurrentModel', wrapModelCall: () => { throw failure }
        })] }).invoke({ messages: [new HumanMessage('Validate model')] })
      }
      throw failure
    })
    const recovery = runtime.recoverRun(thread.id)
    if (!recovery) throw new Error('Expected a recovery attempt.')
    const events = await collect(recovery)
    expect(events.at(-1)).toMatchObject({ type: 'run_failed', run: { id: run.id, status: 'failed' }, error: failure.message })
    expect(events.some((event) => event.type === 'run_recovery_failed')).toBe(false)
    expect(database.getThread(thread.id)?.status).toBe('failed')
    expect(database.listRecoverableRuns()).toEqual([])
    expect((await runtime.getSnapshot(thread.id)).messages).toEqual([
      expect.objectContaining({ id: 'saved-user', content: [{ type: 'text', text: 'Keep this question.' }] })
    ])
  })

  it('starts a fresh run after a model configuration failure without repeating a checkpointed tool', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Change model after tool', modelConfigId: 'initial-model' })
    const execute = vi.fn(async () => {
      database!.updateThread(thread.id, { modelConfigId: 'deleted-model' })
      return 'The external operation has completed.'
    })
    const completedTool = tool(execute, { name: 'complete_operation', description: 'Complete one operation.', schema: z.object({}) })
    const runtime = new ProductionAgentRuntime(database, async (_thread, target, context = {}) => ({
      agent: createDeepAgent({
        model: new FakeToolCallingModel({ toolCalls: context.requestId === 'invalid-model-after-tool'
          ? [[{ id: 'completed-operation', name: completedTool.name, args: {} }], []]
          : [[]] }),
        tools: [completedTool],
        checkpointer: target.checkpointer,
        middleware: [
          createAgentRunLifecycleMiddleware(context.requestId),
          createMiddleware({
            name: 'ValidateCurrentModel',
            wrapModelCall: (request, handler) => {
              if (target.getThread(thread.id)?.modelConfigId === 'deleted-model') {
                throw new ModelSelectionError('The selected model no longer exists. Select another model and send again.')
              }
              return handler(request)
            }
          })
        ]
      }) as never,
      dispose: async () => {}
    }), undefined, async () => {})

    const failed = await collect(runtime.startRun({
      runId: 'invalid-model-after-tool', threadId: thread.id, text: 'Complete the operation.'
    }))
    expect(failed.at(-1)).toMatchObject({ type: 'run_failed', run: { status: 'failed' }, error: expect.stringContaining('selected model no longer exists') })
    expect(execute).toHaveBeenCalledOnce()
    expect(database.listRecoverableRuns()).toEqual([])
    const before = await database.checkpointer.getTuple({ configurable: { thread_id: thread.id, checkpoint_ns: '' } })
    const completedMessages = (before?.checkpoint.channel_values.messages as unknown[]).filter(ToolMessage.isInstance)
    expect(completedMessages).toHaveLength(1)
    expect(completedMessages[0]).toMatchObject({ tool_call_id: 'completed-operation', content: 'The external operation has completed.' })

    database.updateThread(thread.id, { modelConfigId: 'restored-model' })
    const continued = await collect(runtime.startRun({
      runId: 'after-model-corrected', threadId: thread.id, text: 'Continue using the completed result.'
    }))
    expect(continued.at(-1)).toMatchObject({ type: 'run_completed', run: { id: 'after-model-corrected', status: 'completed' } })
    expect(execute).toHaveBeenCalledOnce()
    expect(database.getRun('invalid-model-after-tool')).toMatchObject({ status: 'failed' })
    const after = await database.checkpointer.getTuple({ configurable: { thread_id: thread.id, checkpoint_ns: '' } })
    const messages = after?.checkpoint.channel_values.messages as unknown[]
    expect(messages.filter(ToolMessage.isInstance)).toHaveLength(1)
    expect(messages.filter(HumanMessage.isInstance).map((message) => message.text)).toEqual([
      'Complete the operation.', 'Continue using the completed result.'
    ])
  })

  it('re-delivers a durable fresh user input without counting a second user turn', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Recover fresh input' })
    const run = database.createRun(
      thread.id,
      'recover-fresh-user-input',
      'agent',
      [],
      {
        kind: 'user',
        text: 'Durable question',
        displayText: 'Visible question'
      }
    )
    const inputs: unknown[] = []
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: (input) => {
          inputs.push(input)
          return completedStream('Recovered fresh answer') as never
        },
        getState: async () => ({}) as never
      },
      dispose: async () => {}
    }))

    const recovery = runtime.recoverRun(thread.id)
    if (!recovery) throw new Error('Expected a durable fresh-input recovery.')
    const events = await collect(recovery)

    expect(inputs).toHaveLength(1)
    const graphInput = inputs[0] as { messages?: unknown[]; todos?: unknown[] }
    expect(graphInput.todos).toEqual([])
    expect(graphInput.messages).toHaveLength(1)
    expect(HumanMessage.isInstance(graphInput.messages?.[0])).toBe(true)
    expect((graphInput.messages?.[0] as HumanMessage).text).toBe('Durable question')
    expect(events[0]).toMatchObject({
      type: 'run_started',
      run: { id: run.id },
      newUserTurn: false,
      userMessage: {
        id: `${run.id}:input`,
        role: 'user',
        content: [{ type: 'text', text: 'Visible question' }]
      }
    })
    expect(database.getRunInputIntent(run.id)).toBeUndefined()
    expect(database.getRun(run.id)?.status).toBe('completed')
  })

  it.each([false, true])('keeps durable coding mode %s when runtime assembly fails and recovery is retried', async (codingMode) => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Retry runtime assembly' })
    const run = database.createRun(thread.id, 'retry-runtime-assembly-run')
    database.resolveRunConfiguration(run.id, { customTools: [], codingMode, capabilities: structuredClone(defaultCapabilities) })
    await putRootCheckpoint(database, thread.id, nextDurableCheckpointId(), {
      anasRunLifecycle: { runId: run.id, status: 'running' }
    })
    let configured = false
    const streamEvents = vi.fn(() => completedStream('Recovered after configuration') as never)
    const recoveredModes: boolean[] = []
    const runtime = new AgentRuntime(database, async (_thread, _database, context) => {
      recoveredModes.push(context?.configuration?.codingMode ?? !codingMode)
      if (!configured) throw new Error('Main model is not configured.')
      return {
        agent: {
          streamEvents,
          getState: async () => ({ values: {}, tasks: [] }) as never
        },
        dispose: async () => {}
      }
    })

    const first = runtime.recoverRun(thread.id)
    if (!first) throw new Error('Expected a durable run recovery attempt.')
    const firstEvents = await collect(first)
    expect(streamEvents).not.toHaveBeenCalled()
    expect(firstEvents.at(-1)).toMatchObject({
      type: 'run_recovery_failed',
      run: { id: run.id, status: 'running' },
      error: 'Main model is not configured.'
    })
    expect(database.getRun(run.id)?.status).toBe('running')
    expect(database.listRecoverableRuns().map((candidate) => candidate.id)).toEqual([run.id])

    configured = true
    const retry = runtime.recoverRun(thread.id)
    if (!retry) throw new Error('Expected the configured recovery retry.')
    const retriedEvents = await collect(retry)
    expect(streamEvents).toHaveBeenCalledOnce()
    expect(recoveredModes).toEqual([codingMode, codingMode])
    expect(retriedEvents.at(-1)).toMatchObject({
      type: 'run_completed',
      run: { id: run.id, status: 'completed' }
    })
  })

  it('finishes a cancellation requested after recovery failure while disposal is pending', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Cancel during recovery disposal' })
    const run = database.createRun(
      thread.id,
      '00000000-0000-4000-8000-000000000081'
    )
    const childCall = database.createSubagentCall({
      id: '00000000-0000-4000-8000-000000000083',
      ownerThreadId: thread.id,
      parentThreadId: thread.id,
      parentRunId: run.id,
      childThreadId: '00000000-0000-4000-8000-000000000084',
      childRunId: '00000000-0000-4000-8000-000000000085',
      config: subagentConfig('reviewer'),
      description: 'Remain alive until late parent cancellation is settled.',
      childThread: { title: 'Late cancellation child' }
    })
    const retainedOperationId = '00000000-0000-4000-8000-000000000082'
    const retainedEffect = {
      runId: run.id,
      threadId: thread.id,
      checkpointId: 'cancel-recovery-effect-checkpoint',
      checkpointNs: 'tools:cancel-recovery-effect-task',
      writeCheckpointNs: '',
      taskId: 'cancel-recovery-effect-task',
      callKey: 'cancel-recovery-effect-call',
      inputHash: 'cancel-recovery-effect-input',
      callIndex: 0,
      toolCallId: 'cancel-recovery-tool-call',
      toolName: 'apply_patch',
      argsJson: JSON.stringify({ path: '/project/recoverable.txt' }),
      recoveryMode: 'idempotent' as const
    }
    database.prepareToolEffect(retainedEffect)
    database.armToolEffect(retainedEffect, {
      effectKind: 'file_patch',
      targetJson: JSON.stringify({
        path: '/project/recoverable.txt',
        requestId: run.id,
        operationId: retainedOperationId
      }),
      recoveryMode: 'idempotent'
    })
    await putRootCheckpoint(database, thread.id, nextDurableCheckpointId(), {
      anasRunLifecycle: { runId: run.id, status: 'running' }
    })
    await putRootCheckpoint(database, childCall.childThreadId, nextDurableCheckpointId(), {
      anasRunLifecycle: { runId: childCall.childRunId, status: 'running' }
    })
    let releaseDispose!: () => void
    const disposeBlocked = new Promise<void>((resolve) => {
      releaseDispose = resolve
    })
    const cleanupFileEdits = vi.fn(async () => {})
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: () => {
          throw new Error('Injected retryable stream setup failure.')
        },
        getState: async () => ({ values: {}, tasks: [] }) as never
      },
      dispose: () => disposeBlocked
    }), undefined, cleanupFileEdits)
    const managedCallCancellation = vi.spyOn(
      (runtime as unknown as { managedCalls: ManagedCallService }).managedCalls,
      'cancelRun'
    )
    const recovery = runtime.recoverRun(thread.id)
    if (!recovery) throw new Error('Expected a durable recovery attempt.')
    const iterator = recovery[Symbol.asyncIterator]()
    const events: AgentRuntimeEvent[] = []
    while (events.at(-1)?.type !== 'run_recovery_failed') {
      const next = await iterator.next()
      if (next.done) throw new Error('Expected a retryable recovery failure event.')
      events.push(next.value)
    }

    expect(runtime.cancelRun({ threadId: thread.id, runId: run.id })).toBe('requested')
    expect(database.getRunCheckpointState(run.id).cancellationRequested).toBe(true)
    releaseDispose()
    while (true) {
      const next = await iterator.next()
      if (next.done) break
      events.push(next.value)
    }

    expect(events.map((event) => event.type)).toEqual([
      'run_started',
      'run_recovery_failed',
      'run_cancelled'
    ])
    expect(events.at(-1)).toMatchObject({
      type: 'run_cancelled',
      run: { id: run.id, status: 'cancelled' }
    })
    expect(database.getRun(run.id)?.status).toBe('cancelled')
    expect(database.getRun(childCall.childRunId)?.status).toBe('cancelled')
    expect(database.getSubagentCall(childCall.id, thread.id)).toMatchObject({
      status: 'cancelled'
    })
    expect(managedCallCancellation).toHaveBeenCalledWith(
      run.id,
      'Agent run stopped before its background work was resolved.'
    )
    expect(database.listRecoverableRuns()).toEqual([])
    expect(database.listFileEditCleanupRunIds()).toEqual([])
    expect(cleanupFileEdits).toHaveBeenCalledTimes(2)
    expect(cleanupFileEdits).toHaveBeenCalledWith(run.id, [retainedOperationId])
    expect(cleanupFileEdits).toHaveBeenCalledWith(childCall.childRunId)
  })

  it('defers file edit cleanup until a cancelled local commit actually releases its executor', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Lingering file edit cleanup' })
    const run = database.createRun(thread.id, 'lingering-file-edit-run')
    let releaseCommit!: () => void
    const commitFinished = new Promise<void>((resolve) => { releaseCommit = resolve })
    let releaseCleanup!: () => void
    const cleanupFinished = new Promise<void>((resolve) => { releaseCleanup = resolve })
    const cleanupFileEdits = vi.fn(async () => { await cleanupFinished })
    const runtime = new AgentRuntime(database, async () => {
      throw new Error('This test does not invoke the graph.')
    }, undefined, cleanupFileEdits)
    const internal = runtime as unknown as {
      managedCalls: ManagedCallService
      drainPendingFileEditCleanup(): Promise<void>
    }
    const started = internal.managedCalls.start({
      kind: 'builtin', threadId: thread.id, runId: run.id, summary: 'Commit a file edit',
      uncertainWhenCancelledAfterDispatch: true,
      execute: async (control) => {
        control.markRunning()
        control.markLocalCommit()
        await commitFinished
        control.setOutcome({ ok: true, local_commit_completed: true })
        return 'committed'
      }
    })
    await vi.advanceTimersByTimeAsync(10_001)
    await started
    const cancellation = internal.managedCalls.cancelRun(run.id)
    await vi.advanceTimersByTimeAsync(5_001)
    expect((await cancellation).lingeringCallIds).toHaveLength(1)
    database.finishRun(run.id, 'cancelled')

    await internal.drainPendingFileEditCleanup()
    await internal.drainPendingFileEditCleanup()
    expect(cleanupFileEdits).not.toHaveBeenCalled()
    expect(database.listFileEditCleanupRunIds()).toContain(run.id)

    releaseCommit()
    await internal.managedCalls.waitForRunIdle(run.id)
    await vi.waitFor(() => expect(cleanupFileEdits).toHaveBeenCalledOnce())
    expect(database.listFileEditCleanupRunIds()).toContain(run.id)
    const repeatedDrain = internal.drainPendingFileEditCleanup()
    expect(cleanupFileEdits).toHaveBeenCalledOnce()
    releaseCleanup()
    await repeatedDrain
    expect(database.listFileEditCleanupRunIds()).not.toContain(run.id)
    await runtime.shutdown()
  })

  it('can cancel an inactive durable run after recovery assembly fails', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Cancel inactive recovery' })
    const run = database.createRun(thread.id, 'cancel-inactive-recovery-run')
    await putRootCheckpoint(database, thread.id, nextDurableCheckpointId(), {
      anasRunLifecycle: { runId: run.id, status: 'running' }
    })
    const cleanupFileEdits = vi.fn(async () => {})
    const runtime = new AgentRuntime(database, async () => {
      throw new Error('Skill configuration is unavailable.')
    }, undefined, cleanupFileEdits)
    const recovery = runtime.recoverRun(thread.id)
    if (!recovery) throw new Error('Expected a durable recovery attempt.')
    await collect(recovery)

    expect(runtime.cancelRun({ threadId: thread.id, runId: run.id })).toBe('cancelled')
    await runtime.shutdown()
    expect(database.getRun(run.id)?.status).toBe('cancelled')
    expect(database.listRecoverableRuns()).toEqual([])
    expect(cleanupFileEdits).toHaveBeenCalledWith(run.id)
  })

  it('does not start a continuation until DB-ahead activity reconciliation succeeds', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Fail closed activity recovery' })
    const run = database.createRun(thread.id, 'fail-closed-reconcile-run')
    await putRootCheckpoint(database, thread.id, nextDurableCheckpointId(), {
      anasRunLifecycle: { runId: run.id, status: 'running' }
    })
    database.recordToolActivity(
      run.id,
      { id: 'db-ahead-tool', name: 'execute', args: { command: 'echo stale' } },
      'completed',
      undefined,
      'stale output'
    )
    const originalReconcile = database.reconcileRootActivities.bind(database)
    const reconcile = vi.spyOn(database, 'reconcileRootActivities')
      .mockImplementationOnce(() => {
        throw new Error('Injected activity reconciliation failure.')
      })
      .mockImplementationOnce(() => {
        throw new Error('Injected recovery snapshot reconciliation failure.')
      })
      .mockImplementation((...args) => originalReconcile(...args))
    const streamEvents = vi.fn(() => completedStream('Recovered after reconciliation') as never)
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents,
        getState: async () => ({ values: {}, tasks: [] }) as never
      },
      dispose: async () => {}
    }))

    const first = runtime.recoverRun(thread.id)
    if (!first) throw new Error('Expected the first recovery attempt.')
    const firstEvents = await collect(first)
    expect(streamEvents).not.toHaveBeenCalled()
    const recoveryFailure = firstEvents.at(-1)
    expect(recoveryFailure).toMatchObject({
      type: 'run_recovery_failed',
      run: { id: run.id, status: 'running' }
    })
    expect(recoveryFailure).not.toHaveProperty('snapshot')
    expect(reconcile).toHaveBeenCalledTimes(2)

    const retry = runtime.recoverRun(thread.id)
    if (!retry) throw new Error('Expected the reconciled recovery retry.')
    const retriedEvents = await collect(retry)
    expect(streamEvents).toHaveBeenCalledOnce()
    expect(retriedEvents.at(-1)).toMatchObject({
      type: 'run_completed',
      run: { id: run.id, status: 'completed' }
    })
    expect(database.getActivitiesForThread(thread.id)[0]?.tools ?? []).toEqual([])
  })

  it('projects a recovered framework interrupt without starting a second recovery', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Recovered interrupt' })
    const run = database.createRun(thread.id, 'recovered-interrupt-run')
    vi.spyOn(database, 'listRecoverableRuns').mockReturnValue([run])
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: () => interruptedStream() as never,
        getState: async () => ({}) as never
      },
      dispose: async () => {}
    }))

    const recovery = runtime.recoverRun(thread.id)
    expect(recovery).toBeDefined()
    expect(runtime.recoverRun(thread.id)).toBeUndefined()
    const events = await collect(recovery as AsyncIterable<AgentRuntimeEvent>)

    expect(events.at(-1)).toMatchObject({
      type: 'run_interrupted',
      run: { id: run.id, status: 'interrupted' },
      interrupts: [{ id: 'approval-1' }]
    })
    expect(database.getThread(thread.id)?.status).toBe('interrupted')
  })

  it('records a failed recovery on the original run', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Failed recovery' })
    const run = database.createRun(thread.id, 'failed-recovery-run')
    vi.spyOn(database, 'listRecoverableRuns').mockReturnValue([run])
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: () => {
          throw new Error('Pending graph task failed after restart.')
        },
        getState: async () => ({}) as never
      },
      dispose: async () => {}
    }))

    const recovery = runtime.recoverRun(thread.id)
    expect(recovery).toBeDefined()
    const events = await collect(recovery as AsyncIterable<AgentRuntimeEvent>)

    expect(events.map((event) => event.type)).toEqual(['run_started', 'run_failed'])
    expect(events.at(-1)).toMatchObject({
      type: 'run_failed',
      run: { id: run.id, status: 'failed' },
      error: 'Pending graph task failed after restart.'
    })
  })

  it('runs different threads concurrently while rejecting a second run on the same thread', async () => {
    database = AgentDatabase.open(':memory:')
    const firstThread = database.createThread({ title: 'First' })
    const secondThread = database.createThread({ title: 'Second' })
    const streams = new Map([
      [firstThread.id, pendingStream()],
      [secondThread.id, pendingStream()]
    ])
    const startedThreads: string[] = []
    const runtime = new AgentRuntime(database, async (thread) => {
      startedThreads.push(thread.id)
      return {
        agent: {
          streamEvents: () => streams.get(thread.id)?.stream as never,
          getState: async () => ({}) as never
        },
        dispose: async () => {}
      }
    })

    const firstEvents = collect(runtime.startRun({
      runId: 'run-first',
      threadId: firstThread.id,
      text: 'First'
    }))
    const secondEvents = collect(runtime.startRun({
      runId: 'run-second',
      threadId: secondThread.id,
      text: 'Second'
    }))

    await Promise.resolve()
    expect(startedThreads).toEqual(expect.arrayContaining([firstThread.id, secondThread.id]))
    expect(() => runtime.startRun({
      runId: 'run-duplicate',
      threadId: firstThread.id,
      text: 'Duplicate'
    })).toThrow('is busy')

    streams.get(firstThread.id)?.complete('First done')
    streams.get(secondThread.id)?.complete('Second done')
    expect((await firstEvents).at(-1)).toMatchObject({ type: 'run_completed' })
    expect((await secondEvents).at(-1)).toMatchObject({ type: 'run_completed' })
  })

  it('returns the durable first submission instead of creating a second new thread or run', async () => {
    database = AgentDatabase.open(':memory:')
    const createInstance = vi.fn(async () => ({
      agent: {
        streamEvents: () => completedStream('Submitted once') as never,
        getState: async () => ({ values: {}, tasks: [] }) as never
      },
      dispose: async () => {}
    }))
    const runtime = new AgentRuntime(database, createInstance)
    const first = await runtime.submitRunWithAttachments({
      submissionId: 'submission-once',
      runId: 'submission-run-1',
      threadId: 'submission-thread-1',
      newThread: { title: 'Submitted once', projectId: 'default-workspace' },
      text: 'Create one thread'
    })
    if (!first.events) throw new Error('The first submission did not start its event stream.')
    const activeDuplicate = await runtime.submitRunWithAttachments({
      submissionId: 'submission-once',
      runId: 'submission-run-active-duplicate',
      threadId: 'submission-thread-active-duplicate',
      newThread: { title: 'Must not exist while active', projectId: 'default-workspace' },
      text: 'Active duplicate request'
    })
    expect(activeDuplicate.userMessage).toEqual(first.userMessage)
    await collect(first.events)

    const duplicate = await runtime.submitRunWithAttachments({
      submissionId: 'submission-once',
      runId: 'submission-run-duplicate',
      threadId: 'submission-thread-duplicate',
      newThread: { title: 'Must not exist', projectId: 'default-workspace' },
      text: 'Duplicate request'
    })

    expect(duplicate.events).toBeUndefined()
    expect(duplicate.thread.id).toBe(first.thread.id)
    expect(duplicate.run.id).toBe(first.run.id)
    expect(first.userMessage).toMatchObject({
      id: 'submission-run-1:input',
      role: 'user',
      content: [{ type: 'text', text: 'Create one thread' }]
    })
    expect(duplicate.userMessage).toBeUndefined()
    expect(database.getThread('submission-thread-duplicate')).toBeNull()
    expect(database.getRun('submission-run-duplicate')).toBeNull()
    expect(database.getThread('submission-thread-active-duplicate')).toBeNull()
    expect(database.getRun('submission-run-active-duplicate')).toBeNull()
    expect(database.listThreads()).toHaveLength(1)
    expect(createInstance).toHaveBeenCalledOnce()
  })

  it('blocks a run while the same thread checkpoint is being changed', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Checkpoint mutation' })
    let releaseState: ((value: unknown) => void) | undefined
    const state = new Promise<unknown>((resolve) => {
      releaseState = resolve
    })
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: () => completedStream('Unexpected') as never,
        getState: async () => state as never
      },
      dispose: async () => {}
    }))

    const mutation = runtime.truncateMessages({
      threadId: thread.id,
      messageId: 'missing-message'
    })
    await Promise.resolve()

    expect(() => runtime.startRun({
      runId: 'run-during-mutation',
      threadId: thread.id,
      text: 'Do not interleave'
    })).toThrow('is busy')

    releaseState?.({ values: { messages: [] } })
    await expect(mutation).rejects.toThrow('was not found')
    expect(database.getThread(thread.id)?.status).toBe('idle')
  })

  it('settles affected background calls before replacing checkpoint history', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Managed call history boundary' })
    const retainedRun = database.createRun(thread.id, 'managed-history-retained')
    const retainedMessages = [
      new HumanMessage({
        id: 'managed-history-user-1',
        content: 'Keep this turn',
        additional_kwargs: { anas_run_id: retainedRun.id }
      }),
      new AIMessage({
        id: 'managed-history-assistant-1',
        content: 'Kept',
        additional_kwargs: { anas_run_id: retainedRun.id }
      })
    ]
    await markRunCompleted(database, thread.id, retainedRun.id, { messages: retainedMessages })
    database.finishRun(retainedRun.id, 'completed')
    database.createManagedCall({
      id: 'retained-completed-managed-call',
      threadId: thread.id,
      runId: retainedRun.id,
      kind: 'shell',
      summary: 'completed call observed only by the later turn'
    })
    database.markManagedCallDetached('retained-completed-managed-call', thread.id)
    database.finishManagedCall({
      callId: 'retained-completed-managed-call',
      threadId: thread.id,
      status: 'completed',
      result: 'retained result'
    })
    const removedRun = database.createRun(thread.id, 'managed-history-removed')
    database.resolveManagedCall('retained-completed-managed-call', thread.id, removedRun.id)
    expect(database.listUnresolvedManagedCalls(retainedRun.id)).toEqual([])
    const messages = [
      ...retainedMessages,
      new HumanMessage({
        id: 'managed-history-user-2',
        content: 'Remove this turn',
        additional_kwargs: { anas_run_id: removedRun.id }
      }),
      new AIMessage({
        id: 'managed-history-assistant-2',
        content: 'Removed',
        additional_kwargs: { anas_run_id: removedRun.id }
      })
    ]
    await markRunCompleted(database, thread.id, removedRun.id, { messages })
    database.finishRun(removedRun.id, 'completed')
    database.createManagedCall({
      id: 'persisted-uncertain-managed-call',
      threadId: thread.id,
      runId: removedRun.id,
      kind: 'http',
      summary: 'request with an unknown external outcome'
    })
    database.markManagedCallDetached('persisted-uncertain-managed-call', thread.id)
    database.finishManagedCall({
      callId: 'persisted-uncertain-managed-call',
      threadId: thread.id,
      status: 'uncertain',
      error: 'The result remained uncertain after the process restarted.'
    })
    database.createManagedCall({
      id: 'persisted-completed-managed-call',
      threadId: thread.id,
      runId: removedRun.id,
      kind: 'shell',
      summary: 'completed call whose result was not observed'
    })
    database.markManagedCallDetached('persisted-completed-managed-call', thread.id)
    database.finishManagedCall({
      callId: 'persisted-completed-managed-call',
      threadId: thread.id,
      status: 'completed',
      result: 'done'
    })
    const hiddenRun = database.createRun(thread.id, 'managed-history-hidden-run')
    await markRunCompleted(database, thread.id, hiddenRun.id, { messages })
    database.finishRun(hiddenRun.id, 'completed')
    database.createManagedCall({
      id: 'hidden-run-managed-call',
      threadId: thread.id,
      runId: hiddenRun.id,
      kind: 'shell',
      summary: 'call owned by a suffix run absent from projected messages'
    })
    database.markManagedCallDetached('hidden-run-managed-call', thread.id)
    database.finishManagedCall({
      callId: 'hidden-run-managed-call',
      threadId: thread.id,
      status: 'completed',
      result: 'hidden result'
    })
    const cancelRuns = vi.spyOn(ManagedCallService.prototype, 'cancelRuns')
      .mockResolvedValueOnce({
        uncertainCallIds: ['persisted-uncertain-managed-call'],
        lingeringCallIds: ['persisted-uncertain-managed-call']
      })
      .mockResolvedValue({ uncertainCallIds: ['persisted-uncertain-managed-call'], lingeringCallIds: [] })
    const hasActiveForRun = vi.spyOn(ManagedCallService.prototype, 'hasActiveForRun')
      .mockReturnValue(false)
    const runtime = new AgentRuntime(database, async () => {
      throw new Error('History truncation must not initialize an agent runtime.')
    })

    await expect(runtime.truncateMessages({
      threadId: thread.id,
      messageId: 'managed-history-user-2'
    })).rejects.toThrow('background work is still executing')
    expect(database.getRun(removedRun.id)).toMatchObject({ id: removedRun.id })

    hasActiveForRun.mockImplementation((runId) => runId === hiddenRun.id)
    await expect(runtime.truncateMessages({
      threadId: thread.id,
      messageId: 'managed-history-user-2'
    })).rejects.toThrow('background work is still executing')
    expect(database.getRun(removedRun.id)).toMatchObject({ id: removedRun.id })
    expect(database.getManagedCall('persisted-uncertain-managed-call', thread.id)?.status).toBe('uncertain')
    hasActiveForRun.mockReturnValue(false)

    const snapshot = await runtime.truncateMessages({
      threadId: thread.id,
      messageId: 'managed-history-user-2'
    })

    expect(cancelRuns).toHaveBeenCalledWith(
      [removedRun.id, hiddenRun.id],
      'The conversation history containing this background call is being replaced.'
    )
    expect(cancelRuns).toHaveBeenCalledTimes(3)
    expect(snapshot.messages.map((message) => message.id)).toEqual([
      'managed-history-user-1',
      'managed-history-assistant-1'
    ])
    expect(database.getRun(removedRun.id)).toBeNull()
    expect(database.listUnresolvedManagedCalls(retainedRun.id).map((call) => call.id)).toEqual([
      'retained-completed-managed-call'
    ])
    expect(database.getManagedCall('persisted-uncertain-managed-call', thread.id)).toBeUndefined()
    expect(database.getManagedCall('persisted-completed-managed-call', thread.id)).toBeUndefined()
    expect(database.getManagedCall('hidden-run-managed-call', thread.id)).toBeUndefined()
  })

  it('preserves a conversation when background cancellation is uncertain or still executing', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Lingering managed call' })
    const cancelThread = vi.spyOn(ManagedCallService.prototype, 'cancelThread')
      .mockResolvedValueOnce({
        uncertainCallIds: ['uncertain-managed-call'],
        lingeringCallIds: []
      })
      .mockResolvedValueOnce({
        uncertainCallIds: [],
        lingeringCallIds: ['lingering-managed-call']
      })
    const hasActiveForThread = vi.spyOn(ManagedCallService.prototype, 'hasActiveForThread')
      .mockReturnValue(false)
    const runtime = new AgentRuntime(database, async () => {
      throw new Error('Conversation deletion must not initialize an agent runtime.')
    })

    await expect(runtime.deleteThread(thread.id)).rejects.toThrow('is busy')
    await expect(runtime.deleteThread(thread.id)).rejects.toThrow('is busy')

    expect(cancelThread).toHaveBeenCalledTimes(2)
    expect(cancelThread).toHaveBeenNthCalledWith(1, thread.id)
    expect(cancelThread).toHaveBeenNthCalledWith(2, thread.id)
    expect(hasActiveForThread).toHaveBeenCalledTimes(2)
    expect(database.getThread(thread.id)).toMatchObject({ id: thread.id })
  })

  it('keeps retained messages and resets derived plans when later rounds are deleted', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Restore retained plan' })
    const todos = [{ content: 'Finish the planned work', status: 'completed' as const }]
    const planCall = {
      id: 'retained-plan-call',
      name: 'write_todos',
      args: { todos }
    }
    const plannedMessages = [
        new HumanMessage({
          id: 'planned-user',
          content: 'Complete the task',
          additional_kwargs: { anas_run_id: 'planned-run' }
        }),
        new AIMessage({
          id: 'planned-tool-call',
          content: '',
          tool_calls: [planCall],
          additional_kwargs: { anas_run_id: 'planned-run' }
        }),
        new ToolMessage({
          id: 'planned-tool-result',
          name: planCall.name,
          tool_call_id: planCall.id,
          content: 'Updated todo list',
          additional_kwargs: { anas_run_id: 'planned-run' }
        }),
        new AIMessage({
          id: 'planned-answer',
          content: 'Finished',
          additional_kwargs: { anas_run_id: 'planned-run' }
        })
    ]
    const plannedRun = database.createRun(thread.id, 'planned-run')
    await markRunCompleted(database, thread.id, plannedRun.id, {
      messages: plannedMessages,
      todos
    })
    database.finishRun(plannedRun.id, 'completed')
    const deletedRun = database.createRun(thread.id, 'deleted-run')
    await markRunCompleted(database, thread.id, deletedRun.id, {
      messages: [
        ...plannedMessages,
        new HumanMessage({
          id: 'deleted-user',
          content: 'Follow-up',
          additional_kwargs: { anas_run_id: deletedRun.id }
        }),
        new AIMessage({
          id: 'deleted-answer',
          content: 'Follow-up answer',
          additional_kwargs: { anas_run_id: deletedRun.id }
        })
      ],
      todos: []
    })
    database.finishRun(deletedRun.id, 'completed')
    const runtime = new AgentRuntime(database, async () => {
      throw new Error('History truncation must not initialize an agent runtime.')
    })

    const snapshot = await runtime.truncateMessages({
      threadId: thread.id,
      messageId: 'deleted-user'
    })

    expect(snapshot.todos).toEqual([])
    expect(snapshot.messages.map((message) => message.id)).toEqual(['planned-user', 'planned-answer'])
  })

  it('cancels a running framework stream and records cancellation', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Cancel' })
    const pending = partialPendingStream('Partial response')
    const cleanupFileEdits = vi.fn(async () => {})
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: () => pending as never,
        getState: async () => ({ values: { messages: [] }, tasks: [] }) as never
      },
      dispose: async () => {}
    }), undefined, cleanupFileEdits)

    const eventsPromise = collect(runtime.startRun({
      runId: 'run-cancel',
      threadId: thread.id,
      text: 'Keep working'
    }))
    await vi.waitFor(() => {
      expect(database?.getActivitiesForThread(thread.id)[0]?.models).toEqual([
        expect.objectContaining({ status: 'running' })
      ])
    })
    expect(() => runtime.cancelRun({
      runId: 'missing-run',
      threadId: thread.id
    })).toThrow(`Run missing-run does not belong to thread ${thread.id}.`)
    const otherThread = database.createThread({ title: 'Other cancellation thread' })
    expect(() => runtime.cancelRun({
      runId: 'run-cancel',
      threadId: otherThread.id
    })).toThrow(`Run run-cancel does not belong to thread ${otherThread.id}.`)
    expect(runtime.cancelRun({ runId: 'run-cancel', threadId: thread.id })).toBe('requested')

    const events = await eventsPromise
    expect(events).toContainEqual(expect.objectContaining({
      type: 'model_delta',
      delta: { type: 'text', text: 'Partial response' }
    }))
    expect(events.at(-1)).toMatchObject({
      type: 'run_cancelled',
      run: { id: 'run-cancel', status: 'cancelled' }
    })
    expect(cleanupFileEdits).toHaveBeenCalledOnce()
    expect(cleanupFileEdits).toHaveBeenCalledWith('run-cancel')
    expect(database.getThread(thread.id)?.status).toBe('idle')
    expect(database.getRunCheckpointState('run-cancel').cancellationRequested).toBe(true)
    expect(database.getActivitiesForThread(thread.id)[0]?.models).toEqual([])
    const snapshot = await runtime.getSnapshot(thread.id)
    expect(snapshot.messages).toEqual([])
    expect(snapshot.activities[0]?.models).toEqual([])
  })

  it('keeps uncommitted activity only for a live stream in this process', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Live activity projection' })
    const pending = partialPendingStream('Live partial response')
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: () => pending as never,
        getState: async () => ({ values: {}, tasks: [] }) as never
      },
      dispose: async () => {}
    }))
    const events = collect(runtime.startRun({
      runId: 'live-activity-run',
      threadId: thread.id,
      text: 'Stream a response'
    }))
    await vi.waitFor(() => expect(
      database?.getActivitiesForThread(thread.id)[0]?.models.length
    ).toBe(1))

    const snapshot = await runtime.getSnapshot(thread.id)
    expect(snapshot.activities[0]?.models).toEqual([
      expect.objectContaining({ status: 'running' })
    ])

    expect(runtime.cancelRun({
      runId: 'live-activity-run',
      threadId: thread.id
    })).toBe('requested')
    await events
  })

  it('does not let a late cancellation override a durable terminal checkpoint', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Terminal cancellation race' })
    const pending = pendingStream()
    const streamEvents = vi.fn(() => pending.stream as never)
    let summaryId: string | undefined
    const runtime = new AgentRuntime(database, async (_thread, _target, context) => {
      summaryId = context?.onCompressionStart?.()
      if (!summaryId) throw new Error('Expected a staged summary for the cancellation race.')
      context?.onCompressionCompleted?.(summaryId, 'Durable summary', {
        modelContent: 'Durable summary model content',
        cutoffIndex: 1,
        activatedAfterMessageIndex: 0,
        coveredThroughMessageId: 'terminal-cancel-user',
        firstPreservedMessageId: 'terminal-cancel-final',
        inputTokensBefore: 80,
        inputTokensAfter: 30,
        messages: []
      })
      return {
        agent: {
          streamEvents,
          getState: async () => ({ values: { messages: [] }, tasks: [] }) as never
        },
        dispose: async () => {}
      }
    })
    const eventsPromise = collect(runtime.startRun({
      runId: 'terminal-cancel-race-run',
      threadId: thread.id,
      text: 'Finish durably before cancellation'
    }))
    await vi.waitFor(() => expect(streamEvents).toHaveBeenCalledOnce())

    const finalMessages = [
      new HumanMessage({
        id: 'terminal-cancel-user',
        content: 'Finish durably before cancellation',
        additional_kwargs: { anas_run_id: 'terminal-cancel-race-run' }
      }),
      new AIMessage({
        id: 'terminal-cancel-final',
        content: 'Durable final answer',
        additional_kwargs: { anas_run_id: 'terminal-cancel-race-run' }
      })
    ]
    await putRootCheckpoint(
      database,
      thread.id,
      nextDurableCheckpointId(),
      {
        messages: finalMessages,
        anasRunLifecycle: { runId: 'terminal-cancel-race-run', status: 'completed' },
        _summarizationEvent: {
          cutoffIndex: 1,
          summaryMessage: new HumanMessage({
            content: 'Durable summary model content',
            additional_kwargs: {
              anas_summary_id: summaryId,
              lc_source: 'summarization'
            }
          }),
          filePath: null
        }
      }
    )
    expect(runtime.cancelRun({
      runId: 'terminal-cancel-race-run',
      threadId: thread.id
    })).toBe('unchanged')
    pending.complete('Durable answer')

    const events = await eventsPromise
    expect(events.at(-1)).toMatchObject({
      type: 'run_completed',
      run: { id: 'terminal-cancel-race-run', status: 'completed' },
      snapshot: {
        messages: [
          expect.objectContaining({ id: 'terminal-cancel-user' }),
          expect.objectContaining({
            id: 'terminal-cancel-final',
            content: [{ type: 'text', text: 'Durable final answer' }]
          })
        ]
      }
    })
    expect(database.getRunCheckpointState('terminal-cancel-race-run')).toMatchObject({
      terminalCheckpointId: expect.any(String),
      cancellationRequested: false
    })
    expect(database.contextSummariesThroughRun(
      thread.id,
      'terminal-cancel-race-run'
    )).toEqual([
      expect.objectContaining({
        id: summaryId,
        status: 'completed',
        committedCheckpointId: expect.any(String)
      })
    ])
  })

  it('persists shutdown cancellation intent before aborting the framework stream', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Shutdown cancellation' })
    const pending = pendingStream()
    const streamEvents = vi.fn(() => pending.stream as never)
    const requestCancellation = vi.spyOn(database, 'requestRunCancellation')
    const abort = vi.spyOn(pending.stream, 'abort')
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents,
        getState: async () => ({ values: { messages: [] }, tasks: [] }) as never
      },
      dispose: async () => {}
    }))
    const eventsPromise = collect(runtime.startRun({
      runId: 'shutdown-run',
      threadId: thread.id,
      text: 'Keep working until shutdown'
    }))
    await vi.waitFor(() => expect(streamEvents).toHaveBeenCalledOnce())

    await runtime.shutdown()
    const events = await eventsPromise

    expect(requestCancellation).toHaveBeenCalledWith('shutdown-run')
    expect(abort).toHaveBeenCalledOnce()
    expect(requestCancellation.mock.invocationCallOrder[0]).toBeLessThan(
      abort.mock.invocationCallOrder[0]
    )
    expect(events.at(-1)).toMatchObject({
      type: 'run_cancelled',
      run: { id: 'shutdown-run', status: 'cancelled' }
    })
  })

  it('regenerates with the nearest summary that was already active for the target message', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Regenerate' })
    const messages = [
      new HumanMessage({
        id: 'user-1',
        content: 'One',
        additional_kwargs: { anas_run_id: 'history-run-1' }
      }),
      new AIMessage({
        id: 'assistant-1',
        content: 'First',
        additional_kwargs: { anas_run_id: 'history-run-1' }
      }),
      new HumanMessage({
        id: 'user-2',
        content: 'Two',
        additional_kwargs: { anas_run_id: 'history-run-2' }
      }),
      new AIMessage({
        id: 'assistant-2',
        content: 'Second',
        additional_kwargs: { anas_run_id: 'history-run-2' }
      }),
      new HumanMessage({
        id: 'user-3',
        content: [
          { type: 'text', text: 'Old expanded skill instructions' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } }
        ],
        additional_kwargs: {
          anas_run_id: 'history-run-3',
          anas_display_text: '/bailian-image kitten'
        }
      }),
      new AIMessage({
        id: 'assistant-3',
        content: 'Third',
        additional_kwargs: { anas_run_id: 'history-run-3' }
      })
    ]
    const firstRun = database.createRun(thread.id, 'history-run-1')
    const firstSummary = database.recordContextSummaryStarted(firstRun.id, 'history-summary-1')
    await stageAndCommitSummary(database, thread.id, firstRun.id, firstSummary.id, {
      summaryText: 'First summary',
      modelContent: 'Here is a summary of the conversation to date:\n\nFirst summary',
      cutoffIndex: 1,
      activatedAfterMessageIndex: 1
    })
    await markRunCompleted(database, thread.id, firstRun.id, {
      messages: messages.slice(0, 2),
      todos: [],
      _summarizationEvent: {
        cutoffIndex: 1,
        summaryMessage: new HumanMessage({
          content: 'Here is a summary of the conversation to date:\n\nFirst summary',
          additional_kwargs: { anas_summary_id: firstSummary.id, lc_source: 'summarization' }
        }),
        filePath: null
      }
    })
    database.finishRun(firstRun.id, 'completed')
    const secondRun = database.createRun(thread.id, 'history-run-2')
    const secondSummary = database.recordContextSummaryStarted(secondRun.id, 'history-summary-2')
    await stageAndCommitSummary(database, thread.id, secondRun.id, secondSummary.id, {
      summaryText: 'Second summary',
      modelContent: 'Here is a summary of the conversation to date:\n\nSecond summary',
      cutoffIndex: 3,
      activatedAfterMessageIndex: 3
    })
    await markRunCompleted(database, thread.id, secondRun.id, {
      messages: messages.slice(0, 4),
      todos: [],
      _summarizationEvent: {
        cutoffIndex: 3,
        summaryMessage: new HumanMessage({
          content: 'Here is a summary of the conversation to date:\n\nSecond summary',
          additional_kwargs: { anas_summary_id: secondSummary.id, lc_source: 'summarization' }
        }),
        filePath: null
      }
    })
    database.finishRun(secondRun.id, 'completed')
    const targetRun = database.createRun(thread.id, 'history-run-3')
    await markRunCompleted(database, thread.id, targetRun.id, {
      messages,
      todos: []
    })
    database.finishRun(targetRun.id, 'completed')
    const streamInputs: unknown[] = []
    const cancelRuns = vi.spyOn(ManagedCallService.prototype, 'cancelRuns')
      .mockResolvedValue({ uncertainCallIds: [], lingeringCallIds: [] })
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: (input) => {
          streamInputs.push(input)
          return completedStream('Regenerated') as never
        },
      },
      dispose: async () => {}
    }))

    const regeneration = await runtime.regenerateMessage({
      runId: 'regenerated-run',
      threadId: thread.id,
      messageId: 'user-3',
      skillPromptText: 'Current expanded skill instructions'
    })
    const regenerationEvents = await collect(regeneration.events)

    expect(regenerationEvents[0]).toMatchObject({
      type: 'run_started',
      newUserTurn: false
    })

    expect(streamInputs).toEqual([{
      messages: [expect.objectContaining({
        id: 'user-3',
        content: [
          { type: 'text', text: 'Current expanded skill instructions' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } }
        ],
        additional_kwargs: expect.objectContaining({ anas_run_id: 'regenerated-run' })
      })],
      todos: []
    }])
    expect(database.contextSummariesThroughRun(thread.id, 'history-run-2')).toEqual([
      expect.objectContaining({ id: 'history-summary-1' }),
      expect.objectContaining({ id: 'history-summary-2' })
    ])
    expect(database.getRun('history-run-3')).toBeNull()
    expect(database.getRun('regenerated-run')).toMatchObject({ status: 'completed' })
    expect(cancelRuns).toHaveBeenCalledWith(
      ['history-run-3'],
      'The conversation history containing this background call is being replaced.'
    )
  })

  it('discards a summary whose compressed prefix contains the user turn being regenerated', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Activation boundary' })
    const messages = [
      new HumanMessage({
        id: 'boundary-user-1',
        content: 'One',
        additional_kwargs: { anas_run_id: 'boundary-run-1' }
      }),
      new AIMessage({
        id: 'boundary-assistant-1',
        content: 'First',
        additional_kwargs: { anas_run_id: 'boundary-run-1' }
      }),
      new HumanMessage({
        id: 'boundary-user-2',
        content: 'Two',
        additional_kwargs: { anas_run_id: 'boundary-run-2' }
      }),
      new AIMessage({
        id: 'boundary-assistant-2',
        content: 'Second',
        additional_kwargs: { anas_run_id: 'boundary-run-2' }
      })
    ]
    const firstRun = database.createRun(thread.id, 'boundary-run-1')
    const firstSummary = database.recordContextSummaryStarted(firstRun.id, 'boundary-summary-1')
    await stageAndCommitSummary(database, thread.id, firstRun.id, firstSummary.id, {
      summaryText: 'Earlier summary',
      modelContent: 'Here is a summary of the conversation to date:\n\nEarlier summary',
      cutoffIndex: 1,
      activatedAfterMessageIndex: 1
    })
    await markRunCompleted(database, thread.id, firstRun.id, {
      messages: messages.slice(0, 2),
      todos: [],
      _summarizationEvent: {
        cutoffIndex: 1,
        summaryMessage: new HumanMessage({
          content: 'Here is a summary of the conversation to date:\n\nEarlier summary',
          additional_kwargs: { anas_summary_id: firstSummary.id, lc_source: 'summarization' }
        }),
        filePath: null
      }
    })
    database.finishRun(firstRun.id, 'completed')
    const targetRun = database.createRun(thread.id, 'boundary-run-2')
    const targetSummary = database.recordContextSummaryStarted(targetRun.id, 'boundary-summary-2')
    await stageAndCommitSummary(database, thread.id, targetRun.id, targetSummary.id, {
      summaryText: 'Target summary',
      modelContent: 'Here is a summary of the conversation to date:\n\nTarget summary',
      cutoffIndex: 3,
      activatedAfterMessageIndex: 2
    })
    await markRunCompleted(database, thread.id, targetRun.id, {
      messages,
      todos: [],
      _summarizationEvent: {
        cutoffIndex: 3,
        summaryMessage: new HumanMessage({
          content: 'Here is a summary of the conversation to date:\n\nTarget summary',
          additional_kwargs: { anas_summary_id: targetSummary.id, lc_source: 'summarization' }
        }),
        filePath: null
      }
    })
    database.finishRun(targetRun.id, 'completed')

    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: () => completedStream('Regenerated') as never
      },
      dispose: async () => {}
    }))

    const regeneration = await runtime.regenerateMessage({
      runId: 'boundary-regenerated',
      threadId: thread.id,
      messageId: 'boundary-user-2'
    })
    await collect(regeneration.events)

    expect(database.contextSummariesThroughRun(thread.id, firstRun.id)).toEqual([
      expect.objectContaining({ id: firstSummary.id })
    ])
    expect(database.getRun(targetRun.id)).toBeNull()
    expect(database.getActivitiesForThread(thread.id).flatMap(
      (activity) => activity.summaries ?? []
    )).not.toContainEqual(expect.objectContaining({ id: targetSummary.id }))
  })

  it('deletes a same-run automatic summary and keeps the earlier manual compression', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Delete after summary boundary' })
    const messages = [
      new HumanMessage({
        id: 'delete-user-1',
        content: 'One',
        additional_kwargs: { anas_run_id: 'delete-boundary-run-1' }
      }),
      new AIMessage({
        id: 'delete-assistant-1',
        content: 'First',
        additional_kwargs: { anas_run_id: 'delete-boundary-run-1' }
      }),
      new HumanMessage({
        id: 'delete-user-2',
        content: 'Two',
        additional_kwargs: { anas_run_id: 'delete-boundary-run-2' }
      }),
      new AIMessage({
        id: 'delete-assistant-2',
        content: 'Second',
        additional_kwargs: { anas_run_id: 'delete-boundary-run-2' }
      })
    ]
    const firstRun = database.createRun(thread.id, 'delete-boundary-run-1')
    database.recordModelActivity(firstRun.id, {
      id: 'delete-model-1',
      messageId: 'delete-assistant-1',
      status: 'completed',
      text: 'First',
      reasoning: '',
      toolCallIds: []
    })
    await markRunCompleted(database, thread.id, firstRun.id, {
      messages: messages.slice(0, 2),
      todos: []
    })
    database.finishRun(firstRun.id, 'completed')
    const manualRun = database.createRun(
      thread.id,
      'delete-boundary-manual-compression',
      'compression'
    )
    const manualSummary = database.recordContextSummaryStarted(
      manualRun.id,
      'delete-boundary-manual-summary'
    )
    await stageAndCommitSummary(database, thread.id, manualRun.id, manualSummary.id, {
      summaryText: 'Earlier manual summary',
      modelContent: 'Here is a summary of the conversation to date:\n\nEarlier manual summary',
      cutoffIndex: 1,
      activatedAfterMessageIndex: 1,
      coveredThroughMessageId: 'delete-user-1',
      firstPreservedMessageId: 'delete-assistant-1'
    })
    await markRunCompleted(database, thread.id, manualRun.id, {
      messages: messages.slice(0, 2),
      todos: [],
      _summarizationEvent: {
        cutoffIndex: 1,
        summaryMessage: new HumanMessage({
          content: 'Here is a summary of the conversation to date:\n\nEarlier manual summary',
          additional_kwargs: { anas_summary_id: manualSummary.id, lc_source: 'summarization' }
        }),
        filePath: null
      }
    })
    database.finishRun(manualRun.id, 'completed')
    const targetRun = database.createRun(thread.id, 'delete-boundary-run-2')
    const summary = database.recordContextSummaryStarted(targetRun.id, 'delete-boundary-summary')
    await stageAndCommitSummary(database, thread.id, targetRun.id, summary.id, {
      summaryText: 'Preserved earlier context',
      modelContent: 'Here is a summary of the conversation to date:\n\nPreserved earlier context',
      cutoffIndex: 2,
      activatedAfterMessageIndex: 2,
      coveredThroughMessageId: 'delete-assistant-1',
      firstPreservedMessageId: 'delete-user-2'
    })
    await markRunCompleted(database, thread.id, targetRun.id, {
      messages,
      todos: [],
      _summarizationEvent: {
        cutoffIndex: 2,
        summaryMessage: new HumanMessage({
          content: 'Here is a summary of the conversation to date:\n\nPreserved earlier context',
          additional_kwargs: { anas_summary_id: summary.id, lc_source: 'summarization' }
        }),
        filePath: null
      }
    })
    database.finishRun(targetRun.id, 'completed')
    expect(database.contextSummariesThroughRun(thread.id, targetRun.id)).toEqual([
      expect.objectContaining({
        id: manualSummary.id,
        cutoffIndex: 1
      }),
      expect.objectContaining({
        id: summary.id,
        cutoffIndex: 2
      })
    ])
    const instanceFactory = vi.fn(async () => {
      throw new Error('History truncation must not initialize an agent instance.')
    })
    const runtime = new AgentRuntime(database, instanceFactory)

    const snapshot = await runtime.truncateMessages({
      threadId: thread.id,
      messageId: 'delete-user-2'
    })

    expect(snapshot.messages.map((message) => message.id)).toEqual([
      'delete-user-1',
      'delete-assistant-1'
    ])
    expect(snapshot.todos).toEqual([])
    expect(database.getRun(targetRun.id)).toBeNull()
    expect(database.getRun(manualRun.id)).toMatchObject({
      id: manualRun.id,
      operation: 'compression',
      status: 'completed'
    })
    expect(database.contextSummariesThroughRun(thread.id, manualRun.id)).toEqual([
      expect.objectContaining({
        id: manualSummary.id,
        cutoffIndex: 1
      })
    ])
    expect(database.getActivitiesForThread(thread.id).find(
      (activity) => activity.runId === manualRun.id
    )?.summaries).toEqual([
      expect.objectContaining({ id: manualSummary.id })
    ])
    expect(snapshot.activities.map((activity) => activity.runId)).toContain(manualRun.id)
    expect(snapshot.activities.flatMap((activity) => activity.summaries ?? []))
      .toEqual([
        expect.objectContaining({ id: manualSummary.id })
      ])
    expect(instanceFactory).not.toHaveBeenCalled()
  })

  it('commits the authoritative summary without deleting another active staged summary', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Recover summary projection' })
    const run = database.createRun(thread.id, 'recover-summary-run')
    const modelContent = 'Here is a summary of the conversation to date:\n\nSame summary'
    for (const id of ['stale-summary', 'durable-summary']) {
      database.recordContextSummaryStarted(run.id, id)
      database.stageContextSummary(run.id, id, {
        summaryText: 'Same summary',
        modelContent,
        cutoffIndex: 1,
        activatedAfterMessageIndex: 0
      })
    }
    const messages = [
      new HumanMessage({ id: 'recover-user', content: 'Long context' }),
      new AIMessage({ id: 'recover-assistant', content: 'Answer' })
    ]
    const values = {
      messages,
      todos: [],
      _summarizationEvent: {
        cutoffIndex: 1,
        summaryMessage: new HumanMessage({
          content: modelContent,
          additional_kwargs: {
            lc_source: 'summarization',
            anas_summary_id: 'durable-summary'
          }
        }),
        filePath: null
      }
    }
    await putRootCheckpoint(database, thread.id, 'durable-summary-checkpoint', values)
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: () => completedStream('unused') as never,
        getState: async () => ({
          config: {
            configurable: {
              thread_id: thread.id,
              checkpoint_ns: '',
              checkpoint_id: 'durable-summary-checkpoint'
            }
          },
          values,
          tasks: []
        }) as never
      },
      dispose: async () => {}
    }))

    await runtime.getSnapshot(thread.id)

    expect(database.contextSummariesThroughRun(thread.id, run.id)).toEqual([
      expect.objectContaining({
        id: 'durable-summary',
        committedCheckpointId: 'durable-summary-checkpoint',
        status: 'completed'
      })
    ])
    expect(database.getActivitiesForThread(thread.id)[0].summaries).toEqual([
      expect.objectContaining({ id: 'stale-summary', status: 'running' }),
      expect.objectContaining({ id: 'durable-summary', status: 'completed' })
    ])
  })

  it('does not commit a staged summary that exists only in pending checkpoint writes', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Pending summary write' })
    const run = database.createRun(thread.id, 'pending-summary-run')
    const summaryId = 'pending-only-summary'
    const modelContent = 'Here is a summary of the conversation to date:\n\nPending summary'
    database.recordContextSummaryStarted(run.id, summaryId)
    database.stageContextSummary(run.id, summaryId, {
      summaryText: 'Pending summary',
      modelContent,
      cutoffIndex: 1,
      activatedAfterMessageIndex: 0
    })
    const messages = [
      new HumanMessage({ id: 'pending-user', content: 'Long context' }),
      new AIMessage({ id: 'pending-assistant', content: 'Answer' })
    ]
    const durableValues = { messages, todos: [] }
    const pendingEvent = {
      cutoffIndex: 1,
      summaryMessage: new HumanMessage({
        content: modelContent,
        additional_kwargs: {
          lc_source: 'summarization',
          anas_summary_id: summaryId
        }
      }),
      filePath: null
    }
    const checkpointId = 'before-pending-summary-checkpoint'
    await putRootCheckpoint(database, thread.id, checkpointId, durableValues)
    await database.checkpointer.putWrites({
      configurable: {
        thread_id: thread.id,
        checkpoint_ns: '',
        checkpoint_id: checkpointId
      }
    }, [['_summarizationEvent', pendingEvent]], 'pending-summary-task')
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: () => completedStream('unused') as never,
        getState: async () => ({
          config: {
            configurable: {
              thread_id: thread.id,
              checkpoint_ns: '',
              checkpoint_id: checkpointId
            }
          },
          values: { ...durableValues, _summarizationEvent: pendingEvent },
          tasks: []
        }) as never
      },
      dispose: async () => {}
    }))

    await runtime.getSnapshot(thread.id)

    expect(database.contextSummariesThroughRun(thread.id, run.id)).toEqual([])
    expect(database.getActivitiesForThread(thread.id)[0].summaries).toEqual([
      expect.objectContaining({ id: summaryId, status: 'running' })
    ])
  })

  it('projects automatic compression from the tracked model and checkpoint state', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Automatic compression' })
    const messages = [
      new HumanMessage({
        id: 'automatic-user',
        content: 'Long context',
        additional_kwargs: { anas_run_id: 'automatic-compression-run' }
      }),
      new AIMessage({
        id: 'automatic-assistant',
        content: 'Current answer',
        additional_kwargs: { anas_run_id: 'automatic-compression-run' }
      })
    ]
    const checkpointValues = {
      messages,
      todos: [],
      _summarizationEvent: {
        cutoffIndex: 1,
        summaryMessage: new HumanMessage({
          content: 'Here is a summary of the conversation to date:\n\nAutomatic summary',
          additional_kwargs: { lc_source: 'summarization' }
        }),
        filePath: null
      }
    }
    await putRootCheckpoint(database, thread.id, 'automatic-earlier-checkpoint')
    await putRootCheckpoint(database, thread.id, 'automatic-compression-checkpoint')
    const runtime = new AgentRuntime(database, async (_thread, _database, context) => ({
      agent: {
        streamEvents: () => {
          database!.recordModelActivity('automatic-compression-run', {
            id: 'automatic-model',
            messageId: 'automatic-assistant',
            status: 'completed',
            text: 'Current answer',
            reasoning: '',
            toolCallIds: []
          })
          const summaryId = context?.onCompressionStart?.()
          if (!summaryId) throw new Error('Compression tracking was not installed.')
          checkpointValues._summarizationEvent.summaryMessage.additional_kwargs = {
            lc_source: 'summarization',
            anas_summary_id: summaryId
          }
          context?.onCompressionCompleted?.(summaryId, 'Automatic summary', {
            modelContent: 'Here is a summary of the conversation to date:\n\nAutomatic summary',
            cutoffIndex: 1,
            activatedAfterMessageIndex: 0,
            coveredThroughMessageId: 'automatic-user',
            firstPreservedMessageId: 'automatic-assistant',
            inputTokensBefore: 40,
            inputTokensAfter: 20,
            messages
          })
          expect(database!.contextSummariesThroughRun(
            thread.id,
            'automatic-compression-run'
          )).toEqual([])
          expect(database!.getActivitiesForThread(thread.id)[0].summaries).toEqual([
            expect.objectContaining({ id: summaryId, status: 'running' })
          ])
          const protocolEvents = async function *() {
            yield {
              type: 'event' as const,
              seq: 1,
              method: 'checkpoints',
              params: {
                namespace: [],
                timestamp: 1,
                data: { id: 'automatic-earlier-checkpoint', step: 1, source: 'loop' }
              }
            }
            yield {
              type: 'event' as const,
              seq: 2,
              method: 'values',
              params: {
                namespace: [],
                timestamp: 2,
                data: { messages, todos: [] }
              }
            }
            expect(database!.getActivitiesForThread(thread.id)[0].summaries).toEqual([
              expect.objectContaining({ id: summaryId, status: 'running' })
            ])
            await putRootCheckpoint(database!, thread.id, 'automatic-compression-checkpoint', checkpointValues)
            yield {
              type: 'event' as const,
              seq: 3,
              method: 'checkpoints',
              params: {
                namespace: [],
                timestamp: 3,
                data: { id: 'automatic-compression-checkpoint', step: 2, source: 'loop' }
              }
            }
            yield {
              type: 'event' as const,
              seq: 4,
              method: 'values',
              params: {
                namespace: [],
                timestamp: 4,
                data: checkpointValues
              }
            }
          }
          return Object.assign({
            interrupted: false,
            interrupts: [],
            messages: empty(),
            toolCalls: empty(),
            subagents: empty(),
            output: Promise.resolve({ messages, todos: [] }),
            abort() {}
          }, { [Symbol.asyncIterator]: protocolEvents }) as never
        },
        getState: async () => ({
          config: {
            configurable: {
              thread_id: thread.id,
              checkpoint_ns: '',
              checkpoint_id: 'automatic-compression-checkpoint'
            }
          },
          values: checkpointValues,
          tasks: []
        }) as never
      },
      dispose: async () => {}
    }))

    const events = await collect(runtime.startRun({
      runId: 'automatic-compression-run',
      threadId: thread.id,
      text: 'Continue'
    }))

    expect(events.map((event) => event.type)).toEqual([
      'run_started',
      'context_compression_started',
      'context_compression_completed',
      'run_completed'
    ])
    expect(events[2]).toMatchObject({
      type: 'context_compression_completed',
      summary: {
        firstPreservedMessageId: 'automatic-assistant',
        firstPreservedActivitySequence: 0
      }
    })
    expect(database.contextSummariesThroughRun(thread.id, 'automatic-compression-run')).toEqual([
      expect.objectContaining({
        status: 'completed',
        summaryText: 'Automatic summary',
        activatedAfterMessageIndex: 0
      })
    ])
    expect(events.at(-1)).toMatchObject({
      snapshot: {
        activities: [
          expect.objectContaining({
            runId: 'automatic-compression-run',
            summaries: [
              expect.objectContaining({
                summaryText: 'Automatic summary',
                activatedAfterMessageIndex: 0,
                firstPreservedActivitySequence: 0
              })
            ]
          })
        ]
      }
    })
  })

  it('keeps only automatic summaries confirmed by the checkpoint when a run fails', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Failed after compression' })
    const messages = [
      new HumanMessage({ id: 'failure-user', content: 'Long context' }),
      new AIMessage({ id: 'failure-assistant', content: 'Current answer' })
    ]
    const firstModelContent =
      'Here is a summary of the conversation to date:\n\nCommitted summary'
    let committedSummaryId: string | undefined
    await putRootCheckpoint(database, thread.id, 'failed-compression-checkpoint')
    const cleanupFileEdits = vi.fn(async () => {})
    const runtime = new AgentRuntime(database, async (_thread, _database, context) => ({
      agent: {
        streamEvents: async () => {
          const firstId = context?.onCompressionStart?.()
          if (!firstId) throw new Error('Compression tracking was not installed.')
          committedSummaryId = firstId
          context?.onCompressionCompleted?.(firstId, 'Committed summary', {
            modelContent: firstModelContent,
            cutoffIndex: 1,
            activatedAfterMessageIndex: 0,
            coveredThroughMessageId: 'failure-user',
            firstPreservedMessageId: 'failure-assistant',
            inputTokensBefore: 40,
            inputTokensAfter: 20,
            messages
          })
          const secondId = context?.onCompressionStart?.()
          if (!secondId) throw new Error('Compression tracking was not installed.')
          context?.onCompressionCompleted?.(secondId, 'Uncommitted summary', {
            modelContent: 'Here is a summary of the conversation to date:\n\nUncommitted summary',
            cutoffIndex: 2,
            activatedAfterMessageIndex: 1,
            coveredThroughMessageId: 'failure-assistant',
            inputTokensBefore: 40,
            inputTokensAfter: 10,
            messages
          })
          await putRootCheckpoint(
            database!,
            thread.id,
            'failed-compression-checkpoint',
            {
              messages,
              _summarizationEvent: {
                cutoffIndex: 1,
                summaryMessage: new HumanMessage({
                  content: firstModelContent,
                  additional_kwargs: {
                    lc_source: 'summarization',
                    anas_summary_id: committedSummaryId
                  }
                }),
                filePath: null
              }
            }
          )
          return mockProtocolStream({
            interrupted: false,
            interrupts: [],
            messages: empty(),
            toolCalls: empty(),
            subagents: empty(),
            output: Promise.reject(new Error('Checkpoint write failed.')),
            abort() {}
          }) as never
        },
        getState: async () => ({
          values: {
            messages,
            _summarizationEvent: {
              cutoffIndex: 1,
              summaryMessage: new HumanMessage({
                content: firstModelContent,
                additional_kwargs: {
                  lc_source: 'summarization',
                  anas_summary_id: committedSummaryId
                }
              }),
              filePath: null
            }
          },
          config: {
            configurable: {
              thread_id: thread.id,
              checkpoint_ns: '',
              checkpoint_id: 'failed-compression-checkpoint'
            }
          },
          tasks: []
        }) as never
      },
      dispose: async () => {}
    }), undefined, cleanupFileEdits)

    const events = await collect(runtime.startRun({
      runId: 'failed-after-compression-run',
      threadId: thread.id,
      text: 'Continue'
    }))

    expect(events.at(-1)).toMatchObject({
      type: 'run_failed',
      error: 'Checkpoint write failed.'
    })
    expect(cleanupFileEdits).toHaveBeenCalledOnce()
    expect(cleanupFileEdits).toHaveBeenCalledWith('failed-after-compression-run')
    expect(database.contextSummariesThroughRun(
      thread.id,
      'failed-after-compression-run'
    )).toEqual([
      expect.objectContaining({
        summaryText: 'Committed summary',
        cutoffIndex: 1
      })
    ])
  })

  it('runs manual compression without adding a conversation message', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Manual compression' })
    const historyRun = database.createRun(thread.id, 'manual-history-run')
    database.recordModelActivity(historyRun.id, {
      id: 'manual-history-model',
      messageId: 'manual-assistant',
      status: 'completed',
      text: 'Long answer',
      reasoning: '',
      toolCallIds: []
    })
    await markRunCompleted(database, thread.id, historyRun.id)
    database.finishRun(historyRun.id, 'completed')
    const messages = [
      new HumanMessage({
        id: 'manual-user',
        content: 'Long context',
        additional_kwargs: { anas_run_id: historyRun.id }
      }),
      new AIMessage({
        id: 'manual-assistant',
        content: 'Long answer',
        additional_kwargs: { anas_run_id: historyRun.id }
      })
    ]
    let checkpointValues: Record<string, unknown> = { messages, todos: [] }
    let checkpointId: string | undefined
    let compressionInput: unknown
    const contextStatus = {
      modelConfigId: 'model-test',
      estimatedInputTokens: 40,
      currentContextTokens: 40,
      maxContextTokens: 100,
      maxOutputTokens: 10,
      inputCapacityTokens: 90,
      compressionEnabled: true,
      compressionThreshold: 0.8,
      compressionThresholdTokens: 70,
      compressionApplied: true,
      manualCompressionAvailable: true,
      breakdown: {
        profileTokens: 0,
        systemInstructionTokens: 5,
        runtimeContextTokens: 0,
        workspaceTokens: 0,
        memoryTokens: 0,
        skillTokens: 0,
        toolDefinitionTokens: 5,
        messageTokens: 30,
        attachmentTokens: 0
      }
    }
    const runtime = new AgentRuntime(database, async (_thread, _target, context) => ({
      agent: {
        streamEvents: async (input) => {
          compressionInput = input
          const summaryId = context?.onCompressionStart?.()
          if (!summaryId) throw new Error('Expected durable compression tracking.')
          const modelContent = 'Here is a summary of the conversation to date:\n\nManual summary'
          const stateEvent = {
            cutoffIndex: 1,
            summaryMessage: new HumanMessage({
              content: modelContent,
              additional_kwargs: {
                lc_source: 'summarization',
                anas_summary_id: summaryId
              }
            }),
            filePath: null
          }
          context?.onCompressionCompleted?.(summaryId, 'Manual summary', {
            modelContent,
            cutoffIndex: 1,
            activatedAfterMessageIndex: 1,
            coveredThroughMessageId: 'manual-user',
            firstPreservedMessageId: 'manual-assistant',
            inputTokensBefore: 80,
            inputTokensAfter: 40,
            messages
          })
          checkpointValues = {
            messages,
            todos: [],
            _summarizationEvent: stateEvent,
            anasManualContextCompressionRequest: null,
            anasRunLifecycle: {
              runId: 'manual-compression-run',
              status: 'completed'
            }
          }
          checkpointId = 'manual-compression-checkpoint'
          await putRootCheckpoint(database!, thread.id, checkpointId, checkpointValues)
          return mockProtocolStream({
            interrupted: false,
            interrupts: [],
            messages: empty(),
            toolCalls: empty(),
            subagents: empty(),
            output: Promise.resolve(checkpointValues),
            abort() {}
          }) as never
        },
        getState: async () => ({
          config: {
            configurable: {
              thread_id: thread.id,
              checkpoint_ns: '',
              checkpoint_id: checkpointId
            }
          },
          values: checkpointValues,
          tasks: []
        }) as never,
        updateState: vi.fn()
      },
      context: {
        status: async () => contextStatus,
        projectedStatus: async () => contextStatus,
        statusFromMessages: () => contextStatus,
        compress: vi.fn()
      },
      dispose: async () => {}
    }))

    const events = await collect(runtime.startCompression(thread.id, 'manual-compression-run'))

    expect(events.map((event) => event.type)).toEqual([
      'run_started',
      'context_compression_started',
      'context_compression_completed',
      'context_status_updated',
      'run_completed'
    ])
    expect(events[0]).toMatchObject({
      run: { id: 'manual-compression-run', operation: 'compression' }
    })
    expect(compressionInput).toEqual({
      messages: [],
      anasManualContextCompressionRequest: {
        runId: 'manual-compression-run'
      }
    })
    expect(events.some((event) => event.type === 'model_started')).toBe(false)
    expect(events.at(-1)).toMatchObject({
      snapshot: {
        messages: [
          { id: 'manual-user' },
          { id: 'manual-assistant' }
        ],
        contextStatus
      }
    })
    expect(database.contextSummariesThroughRun(thread.id, 'manual-compression-run')).toEqual([
      expect.objectContaining({
        summaryText: 'Manual summary',
        activatedAfterMessageIndex: 1
      })
    ])
  })

  it('preserves a staged summary while a concurrent snapshot reads an active compression', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Concurrent compression snapshot' })
    const messages = [
      new HumanMessage({ id: 'concurrent-user', content: 'Long context' }),
      new AIMessage({ id: 'concurrent-assistant', content: 'Long answer' })
    ]
    let checkpointId = 'concurrent-compression-base'
    let checkpointValues: Record<string, unknown> = { messages, todos: [] }
    await putRootCheckpoint(database, thread.id, checkpointId, checkpointValues)
    let summaryId: string | undefined
    let markCompressionStarted!: () => void
    const compressionStarted = new Promise<void>((resolve) => {
      markCompressionStarted = resolve
    })
    let releaseCompression!: () => void
    const compressionReleased = new Promise<void>((resolve) => {
      releaseCompression = resolve
    })
    const runtime = new AgentRuntime(database, async (_thread, _target, context) => ({
      agent: {
        streamEvents: async () => {
          summaryId = context?.onCompressionStart?.()
          if (!summaryId) throw new Error('Expected durable compression tracking.')
          markCompressionStarted()
          await compressionReleased
          const modelContent = 'Here is a summary of the conversation to date:\n\nConcurrent summary'
          context?.onCompressionCompleted?.(summaryId, 'Concurrent summary', {
            modelContent,
            cutoffIndex: 1,
            activatedAfterMessageIndex: 1,
            coveredThroughMessageId: 'concurrent-user',
            firstPreservedMessageId: 'concurrent-assistant',
            inputTokensBefore: 80,
            inputTokensAfter: 30,
            messages
          })
          checkpointValues = {
            messages,
            todos: [],
            _summarizationEvent: {
              cutoffIndex: 1,
              summaryMessage: new HumanMessage({
                content: modelContent,
                additional_kwargs: {
                  lc_source: 'summarization',
                  anas_summary_id: summaryId
                }
              }),
              filePath: null
            },
            anasManualContextCompressionRequest: null,
            anasRunLifecycle: {
              runId: 'concurrent-compression-run',
              status: 'completed'
            }
          }
          checkpointId = 'concurrent-compression-terminal'
          await putRootCheckpoint(database!, thread.id, checkpointId, checkpointValues)
          return mockProtocolStream({
            interrupted: false,
            interrupts: [],
            messages: empty(),
            toolCalls: empty(),
            subagents: empty(),
            output: Promise.resolve(checkpointValues),
            abort() {}
          }) as never
        },
        getState: async () => ({
          config: {
            configurable: {
              thread_id: thread.id,
              checkpoint_ns: '',
              checkpoint_id: checkpointId
            }
          },
          values: checkpointValues,
          tasks: []
        }) as never
      },
      dispose: async () => {}
    }))

    const eventsPromise = collect(runtime.startCompression(
      thread.id,
      'concurrent-compression-run'
    ))
    await compressionStarted
    expect(database.getRunActivity('concurrent-compression-run')?.summaries).toEqual([
      expect.objectContaining({ id: summaryId, status: 'running' })
    ])

    await runtime.getSnapshot(thread.id)

    expect(database.getRunActivity('concurrent-compression-run')?.summaries).toEqual([
      expect.objectContaining({ id: summaryId, status: 'running' })
    ])
    releaseCompression()
    const events = await eventsPromise
    expect(events.at(-1)).toMatchObject({
      type: 'run_completed',
      run: { status: 'completed' }
    })
    expect(database.contextSummariesThroughRun(
      thread.id,
      'concurrent-compression-run'
    )).toEqual([
      expect.objectContaining({ id: summaryId, status: 'completed' })
    ])
  })

  it('cancels manual compression without retaining a partial summary', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Cancel compression' })
    const messages = [
      new HumanMessage({ id: 'cancel-user', content: 'Long context' }),
      new AIMessage({ id: 'cancel-assistant', content: 'Long answer' })
    ]
    const compress = vi.fn((_values: unknown, signal: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    )
    const runtime = new AgentRuntime(database, async (_thread, _target, context) => ({
      agent: {
        streamEvents: async () => {
          const summaryId = context?.onCompressionStart?.()
          if (!summaryId) throw new Error('Expected durable compression tracking.')
          try {
            await compress({ messages }, context?.signal as AbortSignal)
          } catch (error) {
            context?.onCompressionFailed?.(summaryId)
            throw error
          }
          throw new Error('Cancelled compression unexpectedly completed.')
        },
        getState: async () => ({
          values: { messages, todos: [] },
          tasks: []
        }) as never,
        updateState: vi.fn()
      },
      context: {
        status: vi.fn(),
        projectedStatus: vi.fn(),
        statusFromMessages: vi.fn(),
        compress
      },
      dispose: async () => {}
    }))

    const eventsPromise = collect(runtime.startCompression(thread.id, 'cancel-compression-run'))
    await vi.waitFor(() => expect(compress).toHaveBeenCalledOnce())
    expect(runtime.cancelRun({
      runId: 'cancel-compression-run',
      threadId: thread.id
    })).toBe('requested')
    const events = await eventsPromise

    expect(events[0]).toMatchObject({ type: 'run_started', newUserTurn: false })
    expect(events.map((event) => event.type)).toEqual([
      'run_started',
      'context_compression_started',
      'context_compression_discarded',
      'run_cancelled'
    ])
    expect(database.contextSummariesThroughRun(thread.id, 'cancel-compression-run')).toEqual([])
  })

  it('removes a generated summary when checkpoint persistence fails', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Failed compression' })
    const messages = [
      new HumanMessage({ id: 'failed-user', content: 'Long context' }),
      new AIMessage({ id: 'failed-assistant', content: 'Long answer' })
    ]
    const runtime = new AgentRuntime(database, async (_thread, _target, context) => ({
      agent: {
        streamEvents: async () => {
          const summaryId = context?.onCompressionStart?.()
          if (!summaryId) throw new Error('Expected durable compression tracking.')
          context?.onCompressionCompleted?.(summaryId, 'Generated summary', {
            modelContent: 'Here is a summary of the conversation to date:\n\nGenerated summary',
            cutoffIndex: 1,
            activatedAfterMessageIndex: 1,
            coveredThroughMessageId: 'failed-user',
            firstPreservedMessageId: 'failed-assistant',
            inputTokensBefore: 80,
            inputTokensAfter: 40,
            messages
          })
          throw new Error('Checkpoint write failed.')
        },
        getState: async () => ({
          values: { messages, todos: [] },
          tasks: []
        }) as never,
        updateState: vi.fn()
      },
      context: {
        status: vi.fn(),
        projectedStatus: vi.fn(),
        statusFromMessages: vi.fn(),
        compress: vi.fn()
      },
      dispose: async () => {}
    }))

    const events = await collect(runtime.startCompression(thread.id, 'failed-compression-run'))

    expect(events.map((event) => event.type)).toEqual([
      'run_started',
      'context_compression_started',
      'run_failed'
    ])
    expect(events.at(-1)).toMatchObject({
      error: 'Checkpoint write failed.'
    })
    expect(database.contextSummariesThroughRun(thread.id, 'failed-compression-run')).toEqual([])
  })

  it('keeps a manual run completed when projection fails after its terminal checkpoint', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Post-checkpoint compression failure' })
    const messages = [
      new HumanMessage({ id: 'post-put-user', content: 'Long context' }),
      new AIMessage({ id: 'post-put-assistant', content: 'Long answer' })
    ]
    let values: Record<string, unknown> = { messages, todos: [] }
    let checkpointId: string | undefined
    const modelContent = 'Here is a summary of the conversation to date:\n\nDurable summary'
    const runtime = new AgentRuntime(database, async (_thread, _target, context) => ({
      agent: {
        streamEvents: async () => {
          const summaryId = context?.onCompressionStart?.()
          if (!summaryId) throw new Error('Expected durable compression tracking.')
          context?.onCompressionCompleted?.(summaryId, 'Durable summary', {
            modelContent,
            cutoffIndex: 1,
            activatedAfterMessageIndex: 0,
            coveredThroughMessageId: 'post-put-user',
            firstPreservedMessageId: 'post-put-assistant',
            inputTokensBefore: 80,
            inputTokensAfter: 40,
            messages
          })
          values = {
            messages,
            todos: [],
            _summarizationEvent: {
              cutoffIndex: 1,
              summaryMessage: new HumanMessage({
                content: modelContent,
                additional_kwargs: {
                  lc_source: 'summarization',
                  anas_summary_id: summaryId
                }
              }),
              filePath: null
            },
            anasManualContextCompressionRequest: null,
            anasRunLifecycle: {
              runId: 'post-put-compression-run',
              status: 'completed'
            }
          }
          checkpointId = 'post-put-summary-checkpoint'
          await putRootCheckpoint(database!, thread.id, checkpointId, values)
          throw new Error('Failed after durable checkpoint put.')
        },
        getState: async () => ({
          config: {
            configurable: {
              thread_id: thread.id,
              checkpoint_ns: '',
              checkpoint_id: checkpointId
            }
          },
          values,
          tasks: []
        }) as never,
        updateState: vi.fn()
      },
      context: {
        status: vi.fn(),
        projectedStatus: vi.fn(),
        statusFromMessages: vi.fn(),
        compress: vi.fn()
      },
      dispose: async () => {}
    }))

    const events = await collect(runtime.startCompression(
      thread.id,
      'post-put-compression-run'
    ))

    expect(events.at(-1)).toMatchObject({
      type: 'run_completed',
      run: { status: 'completed' },
      snapshot: {
        messages: [
          { id: 'post-put-user' },
          { id: 'post-put-assistant' }
        ]
      }
    })
    expect(database.contextSummariesThroughRun(
      thread.id,
      'post-put-compression-run'
    )).toEqual([
      expect.objectContaining({
        summaryText: 'Durable summary',
        committedCheckpointId: 'post-put-summary-checkpoint',
        status: 'completed'
      })
    ])
  })

  it.each(['completed', 'failed'] as const)('regenerates a %s run with a real Deep Agents graph', async (originalStatus) => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Framework regeneration' })
    const originalRun = database.createRun(thread.id, 'framework-original-run')
    if (originalStatus === 'completed') await markRunCompleted(database, thread.id, originalRun.id)
    database.finishRun(originalRun.id, originalStatus, originalStatus === 'failed' ? 'Provider returned HTTP 400.' : undefined)
    if (originalStatus === 'failed') {
      for (const id of ['uncertain-search-1', 'uncertain-search-2']) {
        database.createManagedCall({ id, threadId: thread.id, runId: originalRun.id, kind: 'mcp', summary: 'Search news' })
        database.markManagedCallRunning(id, thread.id)
        database.markManagedCallDetached(id, thread.id)
        database.finishManagedCall({ callId: id, threadId: thread.id, status: 'uncertain', error: 'Run stopped before search completed.' })
      }
    }
    const model = new FakeToolCallingModel({ toolCalls: [[]] })
    const seedAgent = createDeepAgent({
      model,
      checkpointer: database.checkpointer
    })
    const createInstance = async () => ({
      agent: createDeepAgent({
        model,
        checkpointer: database?.checkpointer
      }) as never,
      dispose: async () => {}
    })
    await seedAgent.updateState({
      configurable: { thread_id: thread.id }
    }, {
      messages: [new HumanMessage({
        id: 'framework-user',
        content: 'Answer this again.',
        additional_kwargs: { anas_run_id: originalRun.id }
      })]
    })
    const runtime = new AgentRuntime(database, createInstance)

    const regeneration = await runtime.regenerateMessage({
      runId: 'framework-regenerated-run',
      threadId: thread.id,
      messageId: 'framework-user'
    })
    const events = await collect(regeneration.events)

    expect(database.getRun(originalRun.id)).toBeNull()
    expect(database.getManagedCall('uncertain-search-1', thread.id)).toBeUndefined()
    expect(database.getManagedCall('uncertain-search-2', thread.id)).toBeUndefined()
    expect(events.at(-1)).toMatchObject({
      type: 'run_completed',
      run: { id: 'framework-regenerated-run', status: 'completed' },
      snapshot: {
        messages: [
          {
            id: 'framework-user',
            role: 'user',
            runId: 'framework-regenerated-run'
          },
          { role: 'assistant' }
        ]
      }
    })
  })

  it.each([true, false])('runs a selected subagent with global default enabled %s and persists its result', async (enabled) => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Async subagent owner', modelConfigId: 'initial-model', modelParameterPresetId: 'initial-preset' })
    let childRunnableConfig: unknown
    let childToolEffectArtifactId: string | undefined
    let releaseParent!: () => void
    const parentCanFinish = new Promise<void>((resolve) => {
      releaseParent = resolve
    })
    const runtime = new AgentRuntime(database, async (_thread, _database, context) => ({
      agent: {
        streamEvents: async () => {
          if (context?.subagentCall) {
            childRunnableConfig = AsyncLocalStorageProviderSingleton.getRunnableConfig()
            childToolEffectArtifactId = currentAgentToolEffectArtifactId('child-leak-check')
            return completedStream('Independent child result', {
              runId: context.requestId
            }) as never
          }
          await AsyncLocalStorageProviderSingleton.runWithConfig({
            configurable: { parent_scope: 'parent-tool-task' },
            tags: ['parent-tool-task']
          }, () => runWithCurrentAgentToolEffect({
            effectKey: {
              runId: context?.requestId ?? 'missing-parent-run',
              checkpointId: 'parent-checkpoint',
              checkpointNs: 'tools:parent-tool-task',
              taskId: 'parent-tool-task',
              callKey: 'parent-call',
              inputHash: 'parent-input'
            },
            arm: () => {}
          }, () => context?.subagents?.start({
            agentName: 'reviewer',
            config: subagentConfig('reviewer', { enabled, subagentSelection: { mode: 'custom', names: [] } })
          }, 'Review independently.', {
            subagentId: '11111111-1111-8111-8111-111111111111',
            childThreadId: '22222222-2222-8222-8222-222222222222',
            childRunId: '33333333-3333-8333-8333-333333333333'
          }, () => {})))
          await parentCanFinish
          return completedStream('Parent result', { runId: context?.requestId }) as never
        }
      },
      dispose: async () => {}
    }))

    const parentEvents = collect(runtime.startRun({
      threadId: thread.id,
      runId: 'async-subagent-parent-run',
      text: 'Delegate the review.'
    }))

    await vi.waitFor(() => expect(database?.listSubagentCalls(thread.id)).toEqual([
      expect.objectContaining({ status: 'completed' })
    ]))
    const childModels = database.getActivitiesForThread(
      '22222222-2222-8222-8222-222222222222'
    )[0]?.models
    const projectedModels = database.getActivitiesForThread(thread.id)[0]?.models
    database.updateThread(thread.id, { modelConfigId: 'next-model', modelParameterPresetId: 'next-preset' })
    expect(resolveThreadModelSelection('22222222-2222-8222-8222-222222222222', database)).toEqual({
      modelConfigId: 'next-model', modelParameterPresetId: 'next-preset'
    })
    releaseParent()
    await parentEvents

    expect(database.listThreads().map((candidate) => candidate.id)).toEqual([thread.id])
    expect(database.listSubagentCalls(thread.id)).toEqual([
      expect.objectContaining({
        id: '11111111-1111-8111-8111-111111111111',
        childThreadId: '22222222-2222-8222-8222-222222222222',
        childRunId: '33333333-3333-8333-8333-333333333333',
        status: 'completed',
        result: 'Independent child result'
      })
    ])
    expect((childRunnableConfig as { configurable?: Record<string, unknown> } | undefined)
      ?.configurable?.parent_scope).toBeUndefined()
    expect(childToolEffectArtifactId).toBeUndefined()
    expect(childModels).toContainEqual(expect.objectContaining({
        status: 'completed',
        text: 'Independent child result'
      }))
    expect(projectedModels).toContainEqual(
      expect.objectContaining({
        subagentId: '11111111-1111-8111-8111-111111111111',
        status: 'completed',
        text: 'Independent child result'
      })
    )
  })

  it('reports only the selected child own work in its process snapshot', async () => {
    database = AgentDatabase.open(':memory:')
    const owner = database.createThread({ title: 'Authoritative child process snapshot' })
    const rootRun = database.createRun(owner.id, 'authoritative-child-root-run')
    const selected = database.createSubagentCall({
      id: '14100000-0000-8000-8000-000000000001',
      ownerThreadId: owner.id,
      parentThreadId: owner.id,
      parentRunId: rootRun.id,
      childThreadId: '24100000-0000-8000-8000-000000000001',
      childRunId: '34100000-0000-8000-8000-000000000001',
      config: subagentConfig('selected'),
      description: 'Run direct work and supervise a descendant.',
      childThread: { title: 'Selected child', projectId: owner.projectId }
    })
    const descendant = database.createSubagentCall({
      id: '15100000-0000-8000-8000-000000000001',
      ownerThreadId: owner.id,
      parentThreadId: selected.childThreadId,
      parentRunId: selected.childRunId,
      parentSubagentId: selected.id,
      childThreadId: '25100000-0000-8000-8000-000000000001',
      childRunId: '35100000-0000-8000-8000-000000000001',
      config: subagentConfig('descendant'),
      description: 'Run work projected into the selected child timeline.',
      childThread: { title: 'Descendant child', projectId: owner.projectId }
    })
    database.recordModelActivity(selected.childRunId, {
      id: 'selected-own-model',
      status: 'completed',
      text: 'Selected child own response',
      reasoning: 'Selected child own reasoning',
      toolCallIds: ['selected-own-tool']
    })
    database.recordToolActivity(selected.childRunId, {
      id: 'selected-own-tool',
      name: 'read_file',
      args: { path: 'selected.txt' }
    }, 'completed', undefined, 'selected output')
    database.recordProjectedModelActivity(descendant.id, owner.id, {
      id: 'descendant-model',
      subagentId: descendant.id,
      status: 'completed',
      text: 'Descendant response',
      reasoning: 'Descendant reasoning',
      toolCallIds: ['descendant-tool']
    })
    database.recordProjectedToolActivity(descendant.id, owner.id, {
      id: 'descendant-tool',
      name: 'pwsh',
      args: { command: 'Start-Sleep 30' }
    }, 'running', descendant.id)
    database.finishSubagentCall({
      subagentId: selected.id,
      ownerThreadId: owner.id,
      status: 'completed',
      result: 'Selected child completed.'
    })

    const runtime = new AgentRuntime(database)
    const internal = runtime as unknown as {
      subagentRuntimeForRun(
        thread: AgentThread,
        runId: string,
        queue: { push(event: AgentRuntimeEvent): boolean }
      ): SubagentToolRuntime
      projectSubagentEvent(
        call: AgentSubagentCallRecord,
        event: AgentRuntimeEvent
      ): Promise<AgentRuntimeEvent | undefined>
    }
    const approvalCall = {
      id: 'descendant-approval-tool',
      name: 'apply_patch',
      args: { path: 'review.txt', content: 'result' }
    }
    const approval = {
      status: 'pending_approval' as const,
      interruptId: 'descendant-approval-interrupt',
      actionIndex: 0
    }
    await internal.projectSubagentEvent(descendant, {
      type: 'tool_approval_requested',
      runId: descendant.childRunId,
      threadId: descendant.childThreadId,
      call: approvalCall,
      approval,
      sequence: 1
    })
    for (const activity of [
      database.getActivitiesForThread(selected.childThreadId)[0],
      database.getActivitiesForThread(owner.id)[0]
    ]) {
      expect(activity?.tools).toContainEqual(expect.objectContaining({
        call: approvalCall,
        subagentId: descendant.id,
        approval
      }))
    }
    const childRuntime = internal.subagentRuntimeForRun(
      owner,
      rootRun.id,
      { push: () => true }
    )

    await expect(childRuntime.read(selected.id)).resolves.toMatchObject({
      call: { id: selected.id, status: 'completed' },
      modelRounds: 1,
      toolCalls: 1,
      activeTools: [],
      latestText: 'Selected child own response',
      latestReasoning: 'Selected child own reasoning'
    })
    await runtime.shutdown()
  })

  it('settles projected work when a child terminal event closes its canonical call', async () => {
    database = AgentDatabase.open(':memory:')
    const owner = database.createThread({ title: 'Child terminal projection settlement' })
    const parentRun = database.createRun(owner.id, 'child-terminal-projection-parent')
    const call = database.createSubagentCall({
      id: '18100000-0000-8000-8000-000000000001',
      ownerThreadId: owner.id,
      parentThreadId: owner.id,
      parentRunId: parentRun.id,
      childThreadId: '28100000-0000-8000-8000-000000000001',
      childRunId: '38100000-0000-8000-8000-000000000001',
      config: subagentConfig('reviewer'),
      description: 'Fail after starting projected work.',
      childThread: { title: 'Terminal projection child', projectId: owner.projectId }
    })
    database.recordProjectedModelActivity(call.id, owner.id, {
      id: 'terminal-event-model',
      subagentId: call.id,
      status: 'running',
      text: 'Partial response',
      reasoning: '',
      toolCallIds: ['terminal-event-tool']
    })
    database.recordProjectedToolApproval(call.id, owner.id, {
      id: 'terminal-event-tool',
      name: 'apply_patch',
      args: { path: 'terminal.txt', content: 'partial' }
    }, {
      status: 'pending_approval',
      interruptId: 'terminal-event-approval',
      actionIndex: 0
    }, call.id)
    const childRun = database.finishRun(call.childRunId, 'failed', 'Child terminal failure.')
    const runtime = new AgentRuntime(database)
    const internal = runtime as unknown as {
      projectSubagentEvent(
        call: AgentSubagentCallRecord,
        event: AgentRuntimeEvent
      ): Promise<AgentRuntimeEvent | undefined>
    }

    await expect(internal.projectSubagentEvent(call, {
      type: 'run_failed',
      run: childRun,
      error: 'Child terminal failure.'
    })).resolves.toMatchObject({
      type: 'subagent_updated',
      subagent: { id: call.id, status: 'failed', error: 'Child terminal failure.' }
    })
    const activity = database.getActivitiesForThread(owner.id)[0]
    expect(activity.models.find((model) => model.id === 'terminal-event-model'))
      .toMatchObject({ status: 'completed', text: '', completedAt: expect.any(String) })
    const tool = activity.tools.find((item) => item.call.id === 'terminal-event-tool')
    expect(tool).toMatchObject({ status: 'completed', completedAt: expect.any(String) })
    expect(tool).not.toHaveProperty('approval')
    await expect(internal.projectSubagentEvent(call, {
      type: 'run_failed',
      run: childRun,
      error: 'Child terminal failure.'
    })).resolves.toBeUndefined()
    await runtime.shutdown()
  })

  it('replays a committed subagent start from its stored definition after live config changes', async () => {
    database = AgentDatabase.open(':memory:')
    const owner = database.createThread({ title: 'Durable subagent start replay' })
    const rootRun = database.createRun(owner.id, 'durable-start-replay-root-run')
    const original = subagentConfig('reviewer', {
 capabilities: { ...structuredClone(defaultCapabilities), profile: false, toolMode: 'selected', tools: ['read_file'], skills: { enabled: true, mode: 'custom', project: false, entries: [] } },
      systemPrompt: 'Original durable reviewer prompt.',
    })
    const call = database.createSubagentCall({
      id: '16100000-0000-8000-8000-000000000001',
      ownerThreadId: owner.id,
      parentThreadId: owner.id,
      parentRunId: rootRun.id,
      childThreadId: '26100000-0000-8000-8000-000000000001',
      childRunId: '36100000-0000-8000-8000-000000000001',
      config: original,
      description: 'Replay this launch after its ToolMessage was lost.',
      childThread: { title: 'Durable replay child', projectId: owner.projectId }
    })
    const runtime = new AgentRuntime(database)
    const internal = runtime as unknown as {
      subagentRuntimeForRun(
        thread: AgentThread,
        runId: string,
        queue: { push(event: AgentRuntimeEvent): boolean }
      ): SubagentToolRuntime
    }
    const childRuntime = internal.subagentRuntimeForRun(owner, rootRun.id, { push: () => true })
    const identity = {
      subagentId: call.id,
      childThreadId: call.childThreadId,
      childRunId: call.childRunId
    }

    await expect(childRuntime.start(
      { agentName: 'reviewer' },
      call.description,
      identity,
      vi.fn()
    )).resolves.toMatchObject({ call: { id: call.id, config: original } })
    await expect(childRuntime.start(
      {
        agentName: 'reviewer',
        config: subagentConfig('reviewer', {
          systemPrompt: 'Edited live prompt.',
          capabilities: { ...structuredClone(defaultCapabilities), toolMode: 'selected', tools: ['http_request'] }
        })
      },
      call.description,
      identity,
      vi.fn()
    )).resolves.toMatchObject({ call: { id: call.id, config: original } })
    const armNew = vi.fn()
    await expect(childRuntime.start(
      { agentName: 'deleted-agent' },
      'This is not a durable replay.',
      {
        subagentId: '17100000-0000-8000-8000-000000000001',
        childThreadId: '27100000-0000-8000-8000-000000000001',
        childRunId: '37100000-0000-8000-8000-000000000001'
      },
      armNew
    )).rejects.toThrow('Configured subagent deleted-agent is unavailable.')
    expect(armNew).not.toHaveBeenCalled()
    expect(database.getSubagentCall(call.id, owner.id)?.config).toEqual(original)
    await runtime.shutdown()
  })

  it('reconciles a stale subagent mapping from the durable child run status', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Recovered async subagent owner' })
    let observed: SubagentProcessSnapshot | undefined
    const runtime = new AgentRuntime(database, async (_thread, _database, context) => ({
      agent: {
        streamEvents: async () => {
          database?.createSubagentCall({
            id: '44444444-4444-8444-8444-444444444444',
            ownerThreadId: thread.id,
            parentThreadId: thread.id,
            parentRunId: context?.requestId ?? '',
            childThreadId: '55555555-5555-8555-8555-555555555555',
            childRunId: '66666666-6666-8666-8666-666666666666',
            config: subagentConfig('reviewer'),
            description: 'Recover this child.',
            childThread: {
              title: 'Recover this child.',
              projectId: thread.projectId,
              accessMode: thread.accessMode
            }
          })
          database?.finishRun(
            '66666666-6666-8666-8666-666666666666',
            'failed',
            'Recovered child failure.'
          )
          observed = await context?.subagents?.read(
            '44444444-4444-8444-8444-444444444444'
          ) as SubagentProcessSnapshot | undefined
          return completedStream('Parent observed recovery.', { runId: context?.requestId }) as never
        }
      },
      dispose: async () => {}
    }))

    await collect(runtime.startRun({
      threadId: thread.id,
      runId: 'reconcile-async-subagent-run',
      text: 'Recover the review.'
    }))

    expect(observed?.call).toMatchObject({
      id: '44444444-4444-8444-8444-444444444444',
      status: 'failed',
      error: 'Recovered child failure.'
    })
    expect(database.getSubagentCall(
      '44444444-4444-8444-8444-444444444444',
      thread.id
    )).toMatchObject({ status: 'failed', error: 'Recovered child failure.' })
  })

  it('reconciles a terminal child mapping even when no executor or forwarder remains', async () => {
    database = AgentDatabase.open(':memory:')
    const owner = database.createThread({ title: 'Stale terminal child settlement' })
    const parentRun = database.createRun(owner.id, 'stale-terminal-parent-run')
    const call = database.createSubagentCall({
      id: '45454545-4545-8545-8545-454545454545',
      ownerThreadId: owner.id,
      parentThreadId: owner.id,
      parentRunId: parentRun.id,
      childThreadId: '56565656-5656-8656-8656-565656565657',
      childRunId: '67676767-6767-8767-8767-676767676768',
      config: subagentConfig('reviewer'),
      description: 'Reconcile after the child event forwarder disappeared.',
      childThread: { title: 'Stale terminal child' }
    })
    await markRunCompleted(database, call.childThreadId, call.childRunId, {
      messages: [new AIMessage({
        id: 'stale-terminal-result',
        content: 'Durable child result',
        additional_kwargs: { anas_run_id: call.childRunId }
      })]
    })
    database.finishRun(call.childRunId, 'completed')
    const runtime = new AgentRuntime(database)
    const internal = runtime as unknown as {
      cancelSubagentCalls(listCalls: () => AgentSubagentCallRecord[]): Promise<void>
    }

    await internal.cancelSubagentCalls(() => database!.listSubagentCalls(owner.id))

    expect(database.getSubagentCall(call.id, owner.id)).toMatchObject({
      status: 'completed',
      result: 'Durable child result'
    })
  })

  it('drains an inactive child forwarder before root cleanup cancels its interrupted run', async () => {
    database = AgentDatabase.open(':memory:')
    const owner = database.createThread({ title: 'Inactive forwarding child owner' })
    const parentRun = database.createRun(owner.id, 'inactive-forwarding-parent-run')
    const call = database.createSubagentCall({
      id: '46464646-4646-8646-8646-464646464646',
      ownerThreadId: owner.id,
      parentThreadId: owner.id,
      parentRunId: parentRun.id,
      childThreadId: '56565656-5656-8656-8656-565656565658',
      childRunId: '67676767-6767-8767-8767-676767676769',
      config: subagentConfig('reviewer'),
      description: 'Drain queued child events before cancelling the interrupted child.',
      childThread: { title: 'Inactive forwarding child', projectId: owner.projectId }
    })
    await markRunInterrupted(
      database,
      call.childThreadId,
      call.childRunId,
      'inactive-forwarding-interrupt'
    )
    const interruptedRun = database.finishRun(call.childRunId, 'interrupted')
    const published: AgentRuntimeEvent[] = []
    const runtime = new ProductionAgentRuntime(
      database,
      undefined,
      undefined,
      undefined,
      (event) => { published.push(event) }
    )
    const internal = runtime as unknown as {
      subagentRuntimeForRun(
        thread: AgentThread,
        runId: string,
        queue: { push(event: AgentRuntimeEvent): boolean }
      ): SubagentToolRuntime
      trackSubagentEvents(
        call: AgentSubagentCallRecord,
        events: AsyncIterable<AgentRuntimeEvent>,
        queue: { push(event: AgentRuntimeEvent): boolean }
      ): void
    }
    let releaseForwarder!: () => void
    const forwarderGate = new Promise<void>((resolve) => {
      releaseForwarder = resolve
    })
    let forwarderStarted!: () => void
    const forwarderStart = new Promise<void>((resolve) => {
      forwarderStarted = resolve
    })
    const approvalCall = {
      id: 'inactive-forwarding-tool',
      name: 'apply_patch',
      args: { path: 'queued.txt', content: 'partial' }
    }
    async function* delayedChildEvents(): AsyncIterable<AgentRuntimeEvent> {
      forwarderStarted()
      await forwarderGate
      yield {
        type: 'model_started',
        runId: call.childRunId,
        threadId: call.childThreadId,
        model: {
          id: 'inactive-forwarding-model',
          sequence: 0,
          status: 'running',
          text: '',
          reasoning: '',
          toolCallIds: [approvalCall.id]
        }
      }
      yield {
        type: 'tool_approval_requested',
        runId: call.childRunId,
        threadId: call.childThreadId,
        call: approvalCall,
        sequence: 1,
        approval: {
          status: 'pending_approval',
          interruptId: 'inactive-forwarding-approval',
          actionIndex: 0
        }
      }
      yield {
        type: 'run_interrupted',
        run: interruptedRun,
        interrupts: []
      }
    }
    const closedParentQueue = { push: (_event: AgentRuntimeEvent) => false }
    internal.trackSubagentEvents(call, delayedChildEvents(), closedParentQueue)
    await forwarderStart
    const parentSubagents = internal.subagentRuntimeForRun(
      owner,
      parentRun.id,
      closedParentQueue
    )
    let cleanupFinished = false
    const cleanup = parentSubagents.cancelRun('Root run is settling.').then(() => {
      cleanupFinished = true
    })

    try {
      await Promise.resolve()
      expect(cleanupFinished).toBe(false)
      expect(database.getSubagentCall(call.id, owner.id)?.status).toBe('running')

      releaseForwarder()
      await cleanup

      expect(database.getSubagentCall(call.id, owner.id)?.status).toBe('cancelled')
      const activity = database.getActivitiesForThread(owner.id)
        .find((candidate) => candidate.runId === parentRun.id)
      expect(activity?.models.find((model) => model.id === 'inactive-forwarding-model'))
        .toMatchObject({
          status: 'completed',
          text: '',
          completedAt: expect.any(String)
        })
      const tool = activity?.tools.find((item) => item.call.id === approvalCall.id)
      expect(tool).toMatchObject({ status: 'completed', completedAt: expect.any(String) })
      expect(tool).not.toHaveProperty('approval')
      expect(activity?.models.some((model) => (
        model.subagentId === call.id && model.status === 'running'
      ))).toBe(false)
      expect(activity?.tools.some((item) => (
        item.subagentId === call.id && item.status === 'running'
      ))).toBe(false)

      const updates = published.filter((event) => (
        event.type === 'subagent_updated' && event.subagent.id === call.id
      ))
      expect(updates.filter((event) => (
        event.type === 'subagent_updated' && event.subagent.status === 'interrupted'
      ))).toHaveLength(1)
      expect(updates.filter((event) => (
        event.type === 'subagent_updated' && event.subagent.status === 'cancelled'
      ))).toHaveLength(1)
    } finally {
      releaseForwarder()
      await runtime.shutdown()
    }
  })

  it('publishes one terminal update when concurrent reads reconcile a stale completed child', async () => {
    database = AgentDatabase.open(':memory:')
    const owner = database.createThread({ title: 'Concurrent stale child reconciliation' })
    const parentRun = database.createRun(owner.id, 'concurrent-stale-child-parent-run')
    const call = database.createSubagentCall({
      id: '47474747-4747-8747-8747-474747474747',
      ownerThreadId: owner.id,
      parentThreadId: owner.id,
      parentRunId: parentRun.id,
      childThreadId: '57575757-5757-8757-8757-575757575757',
      childRunId: '68686868-6868-8868-8868-686868686868',
      config: subagentConfig('reviewer'),
      description: 'Reconcile exactly once after a completed child forwarder disappeared.',
      childThread: { title: 'Concurrent stale child' }
    })
    await markRunCompleted(database, call.childThreadId, call.childRunId, {
      messages: [new AIMessage({
        id: 'concurrent-stale-terminal-result',
        content: 'Durable concurrent child result',
        additional_kwargs: { anas_run_id: call.childRunId }
      })]
    })
    database.finishRun(call.childRunId, 'completed')

    const runtime = new AgentRuntime(database)
    const pushed: AgentRuntimeEvent[] = []
    const internal = runtime as unknown as {
      subagentRuntimeForRun(
        thread: AgentThread,
        runId: string,
        queue: { push(event: AgentRuntimeEvent): boolean }
      ): SubagentToolRuntime
      readSnapshot(threadId: string): Promise<Awaited<ReturnType<ProductionAgentRuntime['getSnapshot']>>>
    }
    const originalReadSnapshot = internal.readSnapshot.bind(runtime)
    let concurrentReads = 0
    let releaseReads!: () => void
    const bothReadsStarted = new Promise<void>((resolve) => {
      releaseReads = resolve
    })
    vi.spyOn(internal, 'readSnapshot').mockImplementation(async (threadId) => {
      concurrentReads += 1
      if (concurrentReads === 2) releaseReads()
      await bothReadsStarted
      return originalReadSnapshot(threadId)
    })
    const childRuntime = internal.subagentRuntimeForRun(
      owner,
      parentRun.id,
      { push: (event) => { pushed.push(event); return true } }
    )

    const snapshots = await Promise.all([
      childRuntime.read(call.id),
      childRuntime.read(call.id)
    ])

    expect(snapshots).toEqual([
      expect.objectContaining({ call: expect.objectContaining({ status: 'completed' }) }),
      expect.objectContaining({ call: expect.objectContaining({ status: 'completed' }) })
    ])
    expect(pushed.filter((event) => (
      event.type === 'subagent_updated'
      && event.subagent.id === call.id
      && event.subagent.status === 'completed'
    ))).toHaveLength(1)
    await runtime.shutdown()
  })

  it('keeps an unreadable completed child observable and lets cancellation settle it', async () => {
    database = AgentDatabase.open(':memory:')
    const owner = database.createThread({ title: 'Unreadable completed child' })
    const parentRun = database.createRun(owner.id, 'unreadable-child-parent-run')
    const call = database.createSubagentCall({
      id: '49494949-4949-8949-8949-494949494949',
      ownerThreadId: owner.id,
      parentThreadId: owner.id,
      parentRunId: parentRun.id,
      childThreadId: '59595959-5959-8959-8959-595959595959',
      childRunId: '69696969-6969-8969-8969-696969696969',
      config: subagentConfig('reviewer'),
      description: 'Allow supervision to escape an unreadable completed result.',
      childThread: { title: 'Unreadable completed result' }
    })
    await markRunCompleted(database, call.childThreadId, call.childRunId)
    database.finishRun(call.childRunId, 'completed')

    const runtime = new AgentRuntime(database)
    const pushed: AgentRuntimeEvent[] = []
    const internal = runtime as unknown as {
      subagentRuntimeForRun(
        thread: AgentThread,
        runId: string,
        queue: { push(event: AgentRuntimeEvent): boolean }
      ): SubagentToolRuntime
      readSnapshot(threadId: string): Promise<Awaited<ReturnType<ProductionAgentRuntime['getSnapshot']>>>
    }
    vi.spyOn(internal, 'readSnapshot').mockRejectedValue(new Error('Injected snapshot read failure.'))
    const childRuntime = internal.subagentRuntimeForRun(
      owner,
      parentRun.id,
      { push: (event) => { pushed.push(event); return true } }
    )

    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const observed = await Promise.race([
        childRuntime.wait(call.id, 10_000),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Subagent wait hid the recovery error.')), 500)
        })
      ])
      expect(observed).toMatchObject({
        call: {
          id: call.id,
          status: 'running',
          error: 'Subagent completed, but its final result could not be read: Injected snapshot read failure.'
        }
      })
    } finally {
      if (timeout) clearTimeout(timeout)
    }
    await expect(childRuntime.cancel(call.id, () => {})).resolves.toMatchObject({
      call: { id: call.id, status: 'completed' }
    })
    expect(database.getSubagentCall(call.id, owner.id)).toMatchObject({
      status: 'completed'
    })
    expect(database.getSubagentCall(call.id, owner.id)?.result).toBeUndefined()
    expect(pushed.filter((event) => (
      event.type === 'subagent_updated'
      && event.subagent.id === call.id
      && event.subagent.status === 'running'
      && event.subagent.error?.includes('Injected snapshot read failure.')
    ))).toHaveLength(1)
    expect(pushed.filter((event) => (
      event.type === 'subagent_updated'
      && event.subagent.id === call.id
      && event.subagent.status === 'completed'
    ))).toHaveLength(1)
    await runtime.shutdown()
  })

  it('projects one cancellation update for an inactive recoverable child', async () => {
    database = AgentDatabase.open(':memory:')
    const owner = database.createThread({ title: 'Inactive child cancellation' })
    const parentRun = database.createRun(owner.id, 'inactive-child-parent-run')
    const call = database.createSubagentCall({
      id: '81818181-8181-8181-8181-818181818181',
      ownerThreadId: owner.id,
      parentThreadId: owner.id,
      parentRunId: parentRun.id,
      childThreadId: '82828282-8282-8282-8282-828282828282',
      childRunId: '83838383-8383-8383-8383-838383838383',
      config: subagentConfig('reviewer'),
      description: 'Cancel without a live executor.',
      childThread: { title: 'Inactive recoverable child', projectId: owner.projectId }
    })
    await putRootCheckpoint(database, call.childThreadId, nextDurableCheckpointId(), {
      anasRunLifecycle: { runId: call.childRunId, status: 'running' }
    })
    const runtime = new AgentRuntime(database)
    const pushed: AgentRuntimeEvent[] = []
    const internal = runtime as unknown as {
      subagentRuntimeForRun(
        thread: AgentThread,
        runId: string,
        queue: { push(event: AgentRuntimeEvent): boolean }
      ): SubagentToolRuntime
    }
    const childRuntime = internal.subagentRuntimeForRun(
      owner,
      parentRun.id,
      { push: (event) => { pushed.push(event); return true } }
    )

    await expect(childRuntime.cancel(call.id, () => {})).resolves.toMatchObject({
      call: { id: call.id, status: 'cancelled' }
    })

    expect(pushed.filter((event) => (
      event.type === 'subagent_updated'
      && event.subagent.id === call.id
      && event.subagent.status === 'cancelled'
    ))).toHaveLength(1)
    await runtime.shutdown()
  })

  it('projects nested inactive cancellation updates through a closed parent queue exactly once', async () => {
    database = AgentDatabase.open(':memory:')
    const owner = database.createThread({ title: 'Nested inactive child cancellation' })
    const rootRun = database.createRun(owner.id, 'nested-inactive-root-run')
    const child = database.createSubagentCall({
      id: '84848484-8484-8484-8484-848484848484',
      ownerThreadId: owner.id,
      parentThreadId: owner.id,
      parentRunId: rootRun.id,
      childThreadId: '85858585-8585-8585-8585-858585858585',
      childRunId: '86868686-8686-8686-8686-868686868686',
      config: subagentConfig('reviewer'),
      description: 'Own an inactive nested child.',
      childThread: { title: 'Inactive child', projectId: owner.projectId }
    })
    const grandchild = database.createSubagentCall({
      id: '87878787-8787-8787-8787-878787878787',
      ownerThreadId: owner.id,
      parentThreadId: child.childThreadId,
      parentRunId: child.childRunId,
      parentSubagentId: child.id,
      childThreadId: '88888888-8888-8888-8888-888888888888',
      childRunId: '89898989-8989-8989-8989-898989898989',
      config: subagentConfig('researcher'),
      description: 'Remain visible when the ancestor is cancelled.',
      childThread: { title: 'Inactive grandchild', projectId: owner.projectId }
    })
    database.recordSubagentActivity(
      rootRun.id,
      grandchild.id,
      grandchild.agentName,
      'running',
      child.id
    )
    await putRootCheckpoint(database, child.childThreadId, nextDurableCheckpointId(), {
      anasRunLifecycle: { runId: child.childRunId, status: 'running' }
    })
    await putRootCheckpoint(database, grandchild.childThreadId, nextDurableCheckpointId(), {
      anasRunLifecycle: { runId: grandchild.childRunId, status: 'running' }
    })

    const published: AgentRuntimeEvent[] = []
    const runtime = new ProductionAgentRuntime(
      database,
      undefined,
      undefined,
      undefined,
      (event) => { published.push(event) }
    )
    const internal = runtime as unknown as {
      subagentRuntimeForRun(
        thread: AgentThread,
        runId: string,
        queue: { push(event: AgentRuntimeEvent): boolean }
      ): SubagentToolRuntime
    }
    const rootRuntime = internal.subagentRuntimeForRun(
      owner,
      rootRun.id,
      { push: () => false }
    )

    await expect(rootRuntime.cancel(child.id, () => {})).resolves.toMatchObject({
      call: { id: child.id, status: 'cancelled' }
    })

    const cancelledIds = published.flatMap((event) => (
      event.type === 'subagent_updated' && event.subagent.status === 'cancelled'
        ? [event.subagent.id]
        : []
    ))
    expect(cancelledIds.filter((id) => id === child.id)).toHaveLength(1)
    expect(cancelledIds.filter((id) => id === grandchild.id)).toHaveLength(1)
    expect(database.getActivitiesForThread(owner.id)[0]?.subagents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: child.id, status: 'cancelled' }),
        expect.objectContaining({ id: grandchild.id, status: 'cancelled' })
      ])
    )
    await runtime.shutdown()
  })

  it('projects one reconciled terminal descendant update through a closed parent queue', async () => {
    database = AgentDatabase.open(':memory:')
    const owner = database.createThread({ title: 'Stale terminal descendant reconciliation' })
    const rootRun = database.createRun(owner.id, 'stale-descendant-root-run')
    const child = database.createSubagentCall({
      id: '90909090-9090-8090-8090-909090909091',
      ownerThreadId: owner.id,
      parentThreadId: owner.id,
      parentRunId: rootRun.id,
      childThreadId: '91919191-9191-8191-8191-919191919191',
      childRunId: '92929292-9292-8292-8292-929292929292',
      config: subagentConfig('reviewer'),
      description: 'Own a descendant whose terminal event was lost.',
      childThread: { title: 'Recoverable parent child', projectId: owner.projectId }
    })
    const grandchild = database.createSubagentCall({
      id: '93939393-9393-8393-8393-939393939393',
      ownerThreadId: owner.id,
      parentThreadId: child.childThreadId,
      parentRunId: child.childRunId,
      parentSubagentId: child.id,
      childThreadId: '94949494-9494-8494-8494-949494949494',
      childRunId: '95959595-9595-8595-8595-959595959595',
      config: subagentConfig('researcher'),
      description: 'Finish before its canonical call is reconciled.',
      childThread: { title: 'Stale terminal grandchild', projectId: owner.projectId }
    })
    database.recordSubagentActivity(
      rootRun.id,
      grandchild.id,
      grandchild.agentName,
      'running',
      child.id
    )
    await putRootCheckpoint(database, child.childThreadId, nextDurableCheckpointId(), {
      anasRunLifecycle: { runId: child.childRunId, status: 'running' }
    })
    database.finishRun(grandchild.childRunId, 'failed', 'Recovered descendant failure.')

    const published: AgentRuntimeEvent[] = []
    const runtime = new ProductionAgentRuntime(
      database,
      undefined,
      undefined,
      undefined,
      (event) => { published.push(event) }
    )
    const internal = runtime as unknown as {
      subagentRuntimeForRun(
        thread: AgentThread,
        runId: string,
        queue: { push(event: AgentRuntimeEvent): boolean }
      ): SubagentToolRuntime
    }
    const rootRuntime = internal.subagentRuntimeForRun(
      owner,
      rootRun.id,
      { push: () => false }
    )

    await rootRuntime.cancel(child.id, () => {})

    const grandchildUpdates = published.filter((event) => (
      event.type === 'subagent_updated' && event.subagent.id === grandchild.id
    ))
    expect(grandchildUpdates).toHaveLength(1)
    expect(grandchildUpdates[0]).toMatchObject({
      type: 'subagent_updated',
      runId: rootRun.id,
      threadId: owner.id,
      subagent: {
        id: grandchild.id,
        parentSubagentId: child.id,
        status: 'failed',
        error: 'Recovered descendant failure.'
      }
    })
    expect(database.getActivitiesForThread(owner.id)[0]?.subagents).toContainEqual(
      expect.objectContaining({
        id: grandchild.id,
        parentSubagentId: child.id,
        status: 'failed',
        error: 'Recovered descendant failure.'
      })
    )
    await runtime.shutdown()
  })

  it('waits for terminal child background settlement before crossing a mutation barrier', async () => {
    database = AgentDatabase.open(':memory:')
    const owner = database.createThread({ title: 'Terminal child settlement barrier' })
    const parentRun = database.createRun(owner.id, 'terminal-child-settlement-parent')
    const call = database.createSubagentCall({
      id: '71717171-7171-8171-8171-717171717171',
      ownerThreadId: owner.id,
      parentThreadId: owner.id,
      parentRunId: parentRun.id,
      childThreadId: '72727272-7272-8272-8272-727272727272',
      childRunId: '73737373-7373-8373-8373-737373737373',
      config: subagentConfig('reviewer'),
      description: 'Finish cancellation cleanup before history mutation.',
      childThread: { title: 'Terminal child pending cleanup' }
    })
    database.finishRun(call.childRunId, 'cancelled')
    database.finishSubagentCall({
      subagentId: call.id,
      ownerThreadId: owner.id,
      status: 'cancelled'
    })
    const runtime = new AgentRuntime(database)
    let releaseSettlement!: () => void
    const pendingSettlement = new Promise<void>((resolve) => {
      releaseSettlement = resolve
    })
    const internal = runtime as unknown as {
      runBackgroundSettlementTasks: Map<string, Promise<void>>
      cancelSubagentCalls(listCalls: () => AgentSubagentCallRecord[]): Promise<void>
    }
    internal.runBackgroundSettlementTasks.set(call.childRunId, pendingSettlement)
    void pendingSettlement.then(() => {
      internal.runBackgroundSettlementTasks.delete(call.childRunId)
    })
    let crossedBarrier = false
    const barrier = internal.cancelSubagentCalls(
      () => database!.listSubagentCalls(owner.id)
    ).then(() => {
      crossedBarrier = true
    })

    await Promise.resolve()
    expect(crossedBarrier).toBe(false)
    releaseSettlement()
    await barrier
    expect(crossedBarrier).toBe(true)
  })

  it('starts managed-call cancellation without waiting for subagents to stop', async () => {
    database = AgentDatabase.open(':memory:')
    const runtime = new AgentRuntime(database)
    let releaseSubagents!: () => void
    const subagentSettlement = new Promise<void>((resolve) => {
      releaseSubagents = resolve
    })
    const cancelManagedCalls = vi.spyOn(
      (runtime as unknown as { managedCalls: ManagedCallService }).managedCalls,
      'cancelRun'
    ).mockResolvedValue({ uncertainCallIds: [], lingeringCallIds: [] })
    const internal = runtime as unknown as {
      settleRunBackgroundWork(
        runId: string,
        reason: string,
        subagentRuntime: SubagentToolRuntime
      ): Promise<void>
    }
    const settlement = internal.settleRunBackgroundWork(
      'parallel-background-settlement-run',
      'Cancel independent background work.',
      {
        start: vi.fn(),
        read: vi.fn(),
        wait: vi.fn(),
        cancel: vi.fn(),
        resume: vi.fn(),
        unresolvedForRun: vi.fn(() => []),
        resolveObserved: vi.fn(),
        cancelRun: vi.fn(() => subagentSettlement)
      } as SubagentToolRuntime
    )

    await vi.waitFor(() => expect(cancelManagedCalls).toHaveBeenCalledWith(
      'parallel-background-settlement-run',
      'Cancel independent background work.'
    ))
    releaseSubagents()
    await settlement
  })

  it('returns invalid subagent names and targets to the model without launching or cancelling work', async () => {
    database = AgentDatabase.open(':memory:')
    const owner = database.createThread({ title: 'Correct subagent arguments' })
    const run = database.createRun(owner.id, 'subagent-input-errors')
    const runtime = new ProductionAgentRuntime(database)
    const internal = runtime as unknown as {
      subagentRuntimeForRun(thread: AgentThread, runId: string, queue: { push(event: AgentRuntimeEvent): void }): SubagentToolRuntime
    }
    const queue = { push: vi.fn() }
    const service = internal.subagentRuntimeForRun(owner, run.id, queue)
    const tools = createSubagentTools({ runtime: service, subagents: [subagentConfig('reviewer')] })
    const subagentId = '11111111-1111-4111-8111-111111111111'
    const invalidCalls = [
      { id: 'unknown-name', name: 'start_subagent', args: { agent: 'missing-agent', description: 'Review.' } },
      ...['read_subagent', 'wait_subagent', 'cancel_subagent'].map(name => ({ id: name, name, args: { subagent_id: subagentId } }))
    ]
    const agent = createAgent({
      model: new FakeToolCallingModel({ toolCalls: [invalidCalls, [{ id: 'corrected', name: 'read_subagent', args: {} }], []] }),
      tools, checkpointer: database.checkpointer,
      middleware: [createToolInputErrorMiddleware(), createAgentToolEffectMiddleware({ database, runId: run.id, threadId: owner.id, tools })]
    })
    const result = await agent.invoke({ messages: [new HumanMessage('Inspect available child agents.')] }, {
      configurable: { thread_id: owner.id }, durability: 'sync'
    })
    const responses = result.messages.filter(ToolMessage.isInstance)
    expect(responses).toHaveLength(5)
    for (const call of invalidCalls) {
      expect(responses.find(message => message.tool_call_id === call.id)).toMatchObject({ status: 'error', content: expect.stringContaining('Correct the arguments') })
    }
    expect(responses[0].content).toContain('missing-agent')
    expect(responses[4]).toMatchObject({ tool_call_id: 'corrected', status: 'success' })
    expect(JSON.parse(responses[4].content as string)).toEqual({ ok: true, subagents: [] })
    expect(result).not.toHaveProperty('__interrupt__')
    expect(database.listSubagentCalls(owner.id)).toEqual([])
    expect(queue.push).not.toHaveBeenCalled()
    const checkpoint = await database.checkpointer.getTuple({ configurable: { thread_id: owner.id } })
    const messages = checkpoint!.checkpoint.channel_values.messages as unknown[]
    expect(messages.filter(ToolMessage.isInstance).map(message => message.tool_call_id)).toEqual(responses.map(message => message.tool_call_id))
  })

  it('limits each subagent runtime to the direct children created by its own run', async () => {
    database = AgentDatabase.open(':memory:')
    const owner = database.createThread({ title: 'Nested subagent ownership' })
    const rootRun = database.createRun(owner.id, 'root-owner-run')
    const first = database.createSubagentCall({
      id: '11111111-1111-8111-8111-111111111111',
      ownerThreadId: owner.id,
      parentThreadId: owner.id,
      parentRunId: rootRun.id,
      childThreadId: '22222222-2222-8222-8222-222222222222',
      childRunId: '33333333-3333-8333-8333-333333333333',
      config: subagentConfig('first'),
      description: 'Create a nested reviewer.',
      childThread: { title: 'First child', projectId: owner.projectId }
    })
    const nested = database.createSubagentCall({
      id: '44444444-4444-8444-8444-444444444444',
      ownerThreadId: owner.id,
      parentThreadId: first.childThreadId,
      parentRunId: first.childRunId,
      parentSubagentId: first.id,
      childThreadId: '55555555-5555-8555-8555-555555555555',
      childRunId: '66666666-6666-8666-8666-666666666666',
      config: subagentConfig('nested'),
      description: 'Review the nested work.',
      childThread: { title: 'Nested child', projectId: owner.projectId }
    })
    const sibling = database.createSubagentCall({
      id: '77777777-7777-8777-8777-777777777777',
      ownerThreadId: owner.id,
      parentThreadId: owner.id,
      parentRunId: rootRun.id,
      childThreadId: '88888888-8888-8888-8888-888888888888',
      childRunId: '99999999-9999-8999-8999-999999999999',
      config: subagentConfig('sibling'),
      description: 'Work beside the first child.',
      childThread: { title: 'Sibling child', projectId: owner.projectId }
    })
    await markRunCompleted(database, nested.childThreadId, nested.childRunId)
    database.finishRun(nested.childRunId, 'completed')
    database.finishSubagentCall({
      subagentId: nested.id,
      ownerThreadId: owner.id,
      status: 'completed',
      result: 'Nested review complete.'
    })
    const runtime = new AgentRuntime(database, async () => ({
      agent: { streamEvents: async () => completedStream('unused') as never },
      dispose: async () => {}
    }))
    const internal = runtime as unknown as {
      subagentRuntimeForRun(
        thread: AgentThread,
        runId: string,
        queue: { push(event: AgentRuntimeEvent): void },
        executingSubagent: AgentSubagentCallRecord
      ): SubagentToolRuntime
    }
    const childRuntime = internal.subagentRuntimeForRun(
      database.getThread(first.childThreadId)!,
      first.childRunId,
      { push: vi.fn() },
      first
    )

    await expect(childRuntime.read()).resolves.toEqual([
      expect.objectContaining({
        call: expect.objectContaining({
          id: nested.id,
          status: 'completed',
          result: 'Nested review complete.'
        })
      })
    ])
    await expect(childRuntime.read(first.id)).rejects.toThrow('was not found in this run')
    await expect(childRuntime.read(sibling.id)).rejects.toThrow('was not found in this run')
    const arm = vi.fn()
    await expect(childRuntime.cancel(sibling.id, arm)).rejects.toThrow(
      'was not found in this run'
    )
    await expect(childRuntime.start({
      agentName: sibling.agentName,
      config: sibling.config
    }, sibling.description, {
      subagentId: sibling.id,
      childThreadId: sibling.childThreadId,
      childRunId: sibling.childRunId
    }, arm)).rejects.toThrow('was not found in this run')
    expect(arm).not.toHaveBeenCalled()

    // A valid target disappearing during execution is a state failure, not a
    // reason to ask the model to correct an already validated identifier.
    const lookup = vi.spyOn(database, 'getSubagentCall').mockReturnValueOnce(nested).mockReturnValueOnce(undefined)
    const failed = childRuntime.read(nested.id)
    await expect(failed).rejects.toThrow('was not found in this run')
    await expect(failed).rejects.not.toBeInstanceOf(ToolInputParsingException)
    lookup.mockRestore()
  })

  it('advances a subagent approval generation from the durable synthetic resume history', async () => {
    database = AgentDatabase.open(':memory:')
    const owner = database.createThread({ title: 'Subagent approval generation' })
    const parentRun = database.createRun(owner.id, 'approval-generation-parent')
    const call = database.createSubagentCall({
      id: '13131313-1313-8313-8313-131313131313',
      ownerThreadId: owner.id,
      parentThreadId: owner.id,
      parentRunId: parentRun.id,
      childThreadId: '24242424-2424-8424-8424-242424242424',
      childRunId: '35353535-3535-8535-8535-353535353535',
      config: subagentConfig('reviewer'),
      description: 'Request the same durable approval twice.',
      childThread: { title: 'Approval child', projectId: owner.projectId }
    })
    const checkpointId = nextDurableCheckpointId()
    const interruptId = '46464646-4646-8646-8646-464646464646'
    const interruptValue = {
      actionRequests: [{ name: 'pwsh', args: { command: 'Get-Date' } }],
      reviewConfigs: []
    }
    await putRootCheckpoint(database, call.childThreadId, checkpointId, {
      anasRunLifecycle: { runId: call.childRunId, status: 'running' }
    })
    const checkpointConfig = {
      configurable: {
        thread_id: call.childThreadId,
        checkpoint_ns: '',
        checkpoint_id: checkpointId
      }
    }
    await database.checkpointer.putWrites(
      checkpointConfig,
      [['__interrupt__', [{ id: interruptId, value: interruptValue }]]],
      'nested-root-carrier-task'
    )
    database.finishRun(call.childRunId, 'interrupted')
    database.markSubagentCallInterrupted(call.id, owner.id)
    const runtime = new AgentRuntime(database)
    const internal = runtime as unknown as {
      subagentRuntimeForRun(
        thread: AgentThread,
        runId: string,
        queue: { push(event: AgentRuntimeEvent): void }
      ): SubagentToolRuntime
    }
    const childRuntime = internal.subagentRuntimeForRun(
      owner,
      parentRun.id,
      { push: vi.fn() }
    )

    const first = await childRuntime.read(call.id) as SubagentProcessSnapshot
    await database.checkpointer.putWrites(
      checkpointConfig,
      [['__resume__', [{ decisions: [{ type: 'approve' }] }]]],
      interruptId
    )
    const second = await childRuntime.read(call.id) as SubagentProcessSnapshot
    const tuple = await database.checkpointer.getTuple(checkpointConfig)

    expect(tuple?.checkpoint.id).toBe(checkpointId)
    expect(first.interrupts.map(({ approvalGeneration: _generation, ...interrupt }) => interrupt))
      .toEqual(second.interrupts.map(({ approvalGeneration: _generation, ...interrupt }) => interrupt))
    expect(first.approvalGeneration).toEqual(expect.any(String))
    expect(second.approvalGeneration).toEqual(expect.any(String))
    expect(second.approvalGeneration).not.toBe(first.approvalGeneration)
    await runtime.shutdown()
  })

  it('returns promptly when a recovered child stops before its waiter is registered', async () => {
    database = AgentDatabase.open(':memory:')
    const owner = database.createThread({ title: 'Recovered child wait race' })
    const parentRun = database.createRun(owner.id, 'recovered-child-parent')
    const call = database.createSubagentCall({
      id: '12121212-1212-8212-8212-121212121212',
      ownerThreadId: owner.id,
      parentThreadId: owner.id,
      parentRunId: parentRun.id,
      childThreadId: '34343434-3434-8434-8434-343434343434',
      childRunId: '56565656-5656-8656-8656-565656565656',
      config: subagentConfig('reviewer'),
      description: 'Resume and fail during setup.',
      childThread: { title: 'Recovered child', projectId: owner.projectId }
    })
    await putRootCheckpoint(database, call.childThreadId, nextDurableCheckpointId(), {
      anasRunLifecycle: { runId: call.childRunId, status: 'running' }
    })
    let configured = false
    const retriedChild = pendingStream()
    const runtime = new AgentRuntime(database, async () => {
      if (!configured) throw new Error('Recovered child model is unavailable.')
      return {
        agent: {
          streamEvents: async () => retriedChild.stream as never,
          getState: async () => ({ values: {}, tasks: [] }) as never
        },
        dispose: async () => {}
      }
    })
    const internal = runtime as unknown as {
      subagentRuntimeForRun(
        thread: AgentThread,
        runId: string,
        queue: { push(event: AgentRuntimeEvent): void }
      ): SubagentToolRuntime
    }
    const childRuntime = internal.subagentRuntimeForRun(
      owner,
      parentRun.id,
      { push: vi.fn() }
    )
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const observed = await Promise.race([
        childRuntime.wait(call.id, 10_000),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Subagent wait did not observe recovery stop.')), 500)
        })
      ])
      expect(observed.call).toMatchObject({
        id: call.id,
        status: 'running',
        error: 'Recovered child model is unavailable.'
      })
      configured = true
      const retrying = await childRuntime.read(call.id) as SubagentProcessSnapshot
      expect(retrying.call).toMatchObject({ id: call.id, status: 'running' })
      expect(retrying.call.error).toBeUndefined()
      retriedChild.complete('Recovered child result')
      await vi.waitFor(() => expect(database?.getSubagentCall(call.id, owner.id))
        .toMatchObject({ status: 'completed', result: 'Recovered child result' }))
      await runtime.shutdown()
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  })

  it('returns promptly when a recovery error is published before its waiter is registered', async () => {
    database = AgentDatabase.open(':memory:')
    const owner = database.createThread({ title: 'Recovered child notification race' })
    const parentRun = database.createRun(owner.id, 'recovery-notification-parent')
    const call = database.createSubagentCall({
      id: '23232323-2323-8323-8323-232323232323',
      ownerThreadId: owner.id,
      parentThreadId: owner.id,
      parentRunId: parentRun.id,
      childThreadId: '45454545-4545-8545-8545-454545454546',
      childRunId: '67676767-6767-8767-8767-676767676768',
      config: subagentConfig('reviewer'),
      description: 'Publish a recovery error during waiter registration.',
      childThread: { title: 'Recovery notification child', projectId: owner.projectId }
    })
    const runtime = new AgentRuntime(database)
    const internal = runtime as unknown as {
      subagentRuntimeForRun(
        thread: AgentThread,
        runId: string,
        queue: { push(event: AgentRuntimeEvent): void }
      ): SubagentToolRuntime
      notifySubagent(subagentId: string): void
    }
    const childRuntime = internal.subagentRuntimeForRun(
      owner,
      parentRun.id,
      { push: vi.fn() }
    )
    const originalActivity = database.getRunProcessActivity.bind(database)
    let injected = false
    vi.spyOn(database, 'getRunProcessActivity').mockImplementation((runId) => {
      const activities = originalActivity(runId)
      if (runId === call.childRunId && !injected) {
        injected = true
        const transition = database?.recordSubagentRecoveryFailure(
          call.id,
          owner.id,
          'Recovery failed before waiter registration.'
        )
        if (!transition) throw new Error('Expected a recovery failure transition.')
        internal.notifySubagent(call.id)
      }
      return activities
    })

    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const observed = await Promise.race([
        childRuntime.wait(call.id, 10_000),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Subagent wait missed the recovery update.')), 500)
        })
      ])
      expect(observed.call).toMatchObject({
        id: call.id,
        status: 'running',
        error: 'Recovery failed before waiter registration.'
      })
      await runtime.shutdown()
    } finally {
      if (timeout) clearTimeout(timeout)
    }
  })

  it('waits for a child terminal projection while its completed executor is still disposing', async () => {
    database = AgentDatabase.open(':memory:')
    const owner = database.createThread({ title: 'Child disposal wait barrier' })
    const parentStream = pendingStream()
    const childId = '67676767-6767-8767-8767-676767676767'
    const childThreadId = '78787878-7878-8878-8878-787878787879'
    const childRunId = '89898989-8989-8998-8998-898989898989'
    let childRuntime!: SubagentToolRuntime
    let childStarted!: () => void
    const childStart = new Promise<void>((resolve) => {
      childStarted = resolve
    })
    let releaseChildDispose!: () => void
    const childDispose = new Promise<void>((resolve) => {
      releaseChildDispose = resolve
    })
    const runtime = new AgentRuntime(database, async (_thread, _database, context) => {
      if (context?.subagentCall) {
        return {
          agent: {
            streamEvents: async () => completedStream('Completed child result') as never,
            getState: async () => ({ values: {}, tasks: [] }) as never
          },
          dispose: () => childDispose
        }
      }
      return {
        agent: {
          streamEvents: async () => {
            if (!context?.subagents) throw new Error('Expected a subagent runtime.')
            childRuntime = context.subagents
            await childRuntime.start({
              agentName: 'reviewer',
              config: subagentConfig('reviewer')
            }, 'Complete, then block disposal.', {
              subagentId: childId,
              childThreadId,
              childRunId
            }, () => {})
            childStarted()
            return parentStream.stream as never
          },
          getState: async () => ({ values: {}, tasks: [] }) as never
        },
        dispose: async () => {}
      }
    })
    const parentEvents = collect(runtime.startRun({
      threadId: owner.id,
      runId: 'child-disposal-wait-parent-run',
      text: 'Delegate, then keep working.'
    }))
    await childStart
    await vi.waitFor(() => expect(database?.getRun(childRunId)).toMatchObject({
      status: 'completed'
    }))
    expect(database.getSubagentCall(childId, owner.id)).toMatchObject({ status: 'running' })

    let waitSettled = false
    const waiting = childRuntime.wait(childId, 10_000).then((snapshot) => {
      waitSettled = true
      return snapshot
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(waitSettled).toBe(false)

    releaseChildDispose()
    await expect(waiting).resolves.toMatchObject({
      call: {
        id: childId,
        status: 'completed',
        result: 'Completed child result'
      }
    })
    parentStream.complete('Parent result')
    await parentEvents
    await runtime.shutdown()
  })

  it('preserves background work when a parent run stops in a retryable state', async () => {
    database = AgentDatabase.open(':memory:')
    const owner = database.createThread({ title: 'Retryable parent background work' })
    const child = pendingStream()
    const runtime = new AgentRuntime(database, async (_thread, _database, context) => ({
      agent: {
        streamEvents: async () => {
          if (context?.subagentCall) return child.stream as never
          await context?.subagents?.start({
            agentName: 'reviewer',
            config: subagentConfig('reviewer')
          }, 'Keep working across recovery.', {
            subagentId: '78787878-7878-8878-8878-787878787878',
            childThreadId: '90909090-9090-8090-8090-909090909090',
            childRunId: 'abababab-abab-8bab-abab-abababababab'
          }, () => {})
          await putRootCheckpoint(database!, owner.id, nextDurableCheckpointId(), {
            anasRunLifecycle: { runId: context?.requestId, status: 'running' }
          })
          throw new Error('Retryable parent runtime failure.')
        },
        getState: async () => ({ values: {}, tasks: [] }) as never
      },
      dispose: async () => {}
    }))
    const managedCallCancellation = vi.spyOn(
      (runtime as unknown as { managedCalls: ManagedCallService }).managedCalls,
      'cancelRun'
    )

    const events = await collect(runtime.startRun({
      threadId: owner.id,
      runId: 'retryable-parent-run',
      text: 'Delegate and continue.'
    }))

    expect(events.at(-1)).toMatchObject({
      type: 'run_recovery_failed',
      run: { id: 'retryable-parent-run', status: 'running' }
    })
    expect(database.getSubagentCall(
      '78787878-7878-8878-8878-787878787878',
      owner.id
    )).toMatchObject({ status: 'running' })
    expect(managedCallCancellation).not.toHaveBeenCalled()

    expect(runtime.cancelRun({
      threadId: owner.id,
      runId: 'retryable-parent-run'
    })).toBe('cancelled')
    await vi.waitFor(() => expect(database?.getSubagentCall(
      '78787878-7878-8878-8878-787878787878',
      owner.id
    )).toMatchObject({ status: 'cancelled' }))
    await vi.waitFor(() => expect(managedCallCancellation).toHaveBeenCalledWith(
      'retryable-parent-run',
      'Agent run was cancelled before its background work was resolved.'
    ))
    await runtime.shutdown()
  })

  it('cancels an active child when its parent run fails', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Failed async subagent owner' })
    let childCancelled!: () => void
    const childCancellation = new Promise<void>((resolve) => {
      childCancelled = resolve
    })
    const runtime = new AgentRuntime(database, async (_thread, _database, context) => ({
      agent: {
        streamEvents: async () => {
          if (context?.subagentCall) {
            await new Promise<void>((resolve) => {
              context.signal?.addEventListener('abort', () => {
                childCancelled()
                resolve()
              }, { once: true })
            })
            throw context.signal?.reason ?? new Error('Child cancelled.')
          }
          await context?.subagents?.start({
            agentName: 'reviewer',
            config: subagentConfig('reviewer')
          }, 'Keep working.', {
            subagentId: '77777777-7777-8777-8777-777777777777',
            childThreadId: '88888888-8888-8888-8888-888888888888',
            childRunId: '99999999-9999-8999-8999-999999999999'
          }, () => {})
          throw new Error('Parent failed.')
        }
      },
      dispose: async () => {}
    }))

    await collect(runtime.startRun({
      threadId: thread.id,
      runId: 'failed-async-subagent-parent-run',
      text: 'Delegate and fail.'
    }))
    await childCancellation

    expect(database.getSubagentCall(
      '77777777-7777-8777-8777-777777777777',
      thread.id
    )).toMatchObject({ status: 'cancelled' })
  })

  it('keeps an active child running while its parent waits for approval', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Interrupted async subagent owner' })
    let childCancelled!: () => void
    const childCancellation = new Promise<void>((resolve) => {
      childCancelled = resolve
    })
    const runtime = new AgentRuntime(database, async (_thread, _database, context) => ({
      agent: {
        streamEvents: async () => {
          if (context?.subagentCall) {
            await new Promise<void>((resolve) => {
              context.signal?.addEventListener('abort', () => {
                childCancelled()
                resolve()
              }, { once: true })
            })
            throw context.signal?.reason ?? new Error('Child cancelled.')
          }
          await context?.subagents?.start({
            agentName: 'reviewer',
            config: subagentConfig('reviewer')
          }, 'Keep working.', {
            subagentId: 'aaaaaaaa-aaaa-8aaa-aaaa-aaaaaaaaaaaa',
            childThreadId: 'bbbbbbbb-bbbb-8bbb-bbbb-bbbbbbbbbbbb',
            childRunId: 'cccccccc-cccc-8ccc-cccc-cccccccccccc'
          }, () => {})
          return interruptedStream() as never
        }
      },
      dispose: async () => {}
    }))

    await collect(runtime.startRun({
      threadId: thread.id,
      runId: 'interrupted-async-subagent-parent-run',
      text: 'Delegate, then request approval.'
    }))

    expect(database.getSubagentCall(
      'aaaaaaaa-aaaa-8aaa-aaaa-aaaaaaaaaaaa',
      thread.id
    )).toMatchObject({ status: 'running' })
    expect(runtime.cancelRun({
      threadId: thread.id,
      runId: 'interrupted-async-subagent-parent-run'
    })).toBe('cancelled')
    await childCancellation
    await vi.waitFor(() => expect(database?.getSubagentCall(
      'aaaaaaaa-aaaa-8aaa-aaaa-aaaaaaaaaaaa',
      thread.id
    )).toMatchObject({ status: 'cancelled' }))
  })
})
