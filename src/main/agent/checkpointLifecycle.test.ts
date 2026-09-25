import { defaultCapabilities, } from '@shared/agentCapabilities'
import Database from 'better-sqlite3'
import { CurrentStateSqliteSaver } from './currentStateSqliteSaver'
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint'
import { AIMessage, HumanMessage, RemoveMessage, ToolMessage } from '@langchain/core/messages'
import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import { createDeepAgent } from 'deepagents'
import {
  createMiddleware,
  FakeToolCallingModel,
  modelCallLimitMiddleware,
  tool,
  todoListMiddleware
} from 'langchain'
import { z } from 'zod'
import { describe, expect, it, vi } from 'vitest'
import {
  AgentDatabase,
  type AgentManagedCallRecord,
  type AgentSubagentCallRecord
} from './agentDatabase'
import {
  agentRunLifecycleStateKey,
  createAgentRunLifecycleMiddleware,
  type AgentRunLifecycleState
} from './runLifecycleMiddleware'
import { createManagedCallSupervisionMiddleware } from './managedCallSupervisionMiddleware'
import { createSubagentSupervisionMiddleware } from './subagentSupervisionMiddleware'
import { createChatModel } from './modelFactory'

type StateReader = {
  getState(config: {
    configurable: { thread_id: string; checkpoint_id?: string }
  }): Promise<{
    values: Record<string, unknown>
    next: readonly string[]
    tasks: ReadonlyArray<{ name: string }>
  }>
}

type CheckpointObservation = {
  id: string
  lifecycle?: AgentRunLifecycleState
  messageTypes: string[]
}

function observeCheckpoint(checkpoint: Checkpoint): CheckpointObservation {
  const messages = checkpoint.channel_values.messages
  const lifecycle = checkpoint.channel_values[agentRunLifecycleStateKey]
  return {
    id: checkpoint.id,
    lifecycle: lifecycle && typeof lifecycle === 'object'
      ? lifecycle as AgentRunLifecycleState
      : undefined,
    messageTypes: Array.isArray(messages)
      ? messages.map((message) => (
          message && typeof message === 'object' && 'type' in message
            ? String(message.type)
            : typeof message
        ))
      : []
  }
}

function createLifecycleTestAgent(
  checkpointer: CurrentStateSqliteSaver,
  runId: string,
  beforeComplete?: () => void | Promise<void>
): ReturnType<typeof createDeepAgent> {
  const trailingLifecycle = createMiddleware({
    name: 'TrailingLifecycleMiddleware',
    stateSchema: z.object({ trailingLifecycleCompleted: z.boolean().optional() }),
    afterAgent: () => ({ trailingLifecycleCompleted: true })
  })
  return createDeepAgent({
    model: new FakeToolCallingModel({ toolCalls: [[]] }),
    checkpointer,
    middleware: [
      // This mirrors AgentFactory's ordering invariant: lifecycle first, then
      // middleware with their own after-model/after-agent nodes.
      createAgentRunLifecycleMiddleware(runId, beforeComplete),
      todoListMiddleware({ systemPrompt: '' }),
      modelCallLimitMiddleware({ runLimit: 10, exitBehavior: 'error' }),
      trailingLifecycle
    ]
  })
}

function createManagedCallRecord(options: {
  id: string
  threadId: string
  runId: string
  status?: AgentManagedCallRecord['status']
}): AgentManagedCallRecord {
  return {
    id: options.id,
    threadId: options.threadId,
    runId: options.runId,
    kind: 'http',
    summary: 'download release metadata',
    status: options.status ?? 'completed',
    outputChars: 0,
    detachedAt: '2026-09-03T00:00:00.000Z',
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:01.000Z'
  }
}

const callObservationSchema = z.object({
  call_id: z.string()
})
const callWaitSchema = callObservationSchema.extend({
  timeout: z.number().min(10).max(300).optional()
})

describe('Deep Agent checkpoint lifecycle boundaries', () => {
  it('atomically projects the real terminal checkpoint into the owning run', async () => {
    const database = AgentDatabase.open(':memory:', '.')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'database-lifecycle-run')
      const agent = createLifecycleTestAgent(database.checkpointer, run.id)

      await agent.invoke({
        messages: [new HumanMessage({ id: 'database-human', content: 'Hello' })]
      }, {
        configurable: { thread_id: thread.id },
        durability: 'sync'
      })

      const checkpoint = database.getRunCheckpointState(run.id)
      expect(checkpoint.terminalCheckpointId).toBe(checkpoint.lastCommittedCheckpointId)
      expect(database.finishRun(run.id, 'completed').status).toBe('completed')
      expect(database.listFileEditCleanupRunIds()).toEqual([run.id])
    } finally {
      database.close()
    }
  })

  it('commits the completed lifecycle only in the terminal root checkpoint', async () => {
    const connection = new Database(':memory:')
    try {
      const checkpointer = new CurrentStateSqliteSaver(connection)
      const observations: CheckpointObservation[] = []
      const put = checkpointer.put.bind(checkpointer)
      checkpointer.put = async (
        config,
        checkpoint,
        metadata: CheckpointMetadata
      ) => {
        observations.push(observeCheckpoint(checkpoint))
        return put(config, checkpoint, metadata)
      }
      const agent = createLifecycleTestAgent(checkpointer, 'run-1')

      await agent.invoke({
        messages: [new HumanMessage({ id: 'human-1', content: 'Hello' })]
      }, {
        configurable: { thread_id: 'thread-1' },
        durability: 'sync'
      })

      const completed = observations.filter(
        (item) => item.lifecycle?.runId === 'run-1' && item.lifecycle.status === 'completed'
      )
      expect(completed).toHaveLength(1)
      expect(completed[0].id).toBe(observations.at(-1)?.id)
      const terminal = await (agent as unknown as StateReader).getState({
        configurable: { thread_id: 'thread-1', checkpoint_id: completed[0].id }
      })
      expect(terminal.next).toEqual([])
      expect(terminal.tasks).toEqual([])

      const stagedFinalReply = observations.find((item) =>
        item.lifecycle?.runId === 'run-1'
        && item.lifecycle.status === 'running'
        && item.messageTypes.includes('ai')
      )
      expect(stagedFinalReply).toBeDefined()
      const staged = await checkpointer.getTuple({
        configurable: {
          thread_id: 'thread-1',
          checkpoint_id: stagedFinalReply?.id
        }
      })
      expect(staged).toBeUndefined()
    } finally {
      connection.close()
    }
  })

  it('keeps a synced final AI message staged when the process stops before afterAgent', async () => {
    const connection = new Database(':memory:')
    try {
      const checkpointer = new CurrentStateSqliteSaver(connection)
      const put = checkpointer.put.bind(checkpointer)
      let injected = false
      checkpointer.put = async (
        config,
        checkpoint,
        metadata: CheckpointMetadata
      ) => {
        const result = await put(config, checkpoint, metadata)
        const observation = observeCheckpoint(checkpoint)
        if (
          !injected
          && observation.lifecycle?.status === 'running'
          && observation.messageTypes.includes('ai')
        ) {
          injected = true
          throw new Error('Injected process stop after a synced checkpoint.')
        }
        return result
      }
      const agent = createLifecycleTestAgent(checkpointer, 'run-crashed')

      await expect(agent.invoke({
        messages: [new HumanMessage({ id: 'human-crashed', content: 'Hello' })]
      }, {
        configurable: { thread_id: 'thread-crashed' },
        durability: 'sync'
      })).rejects.toThrow('Injected process stop')

      const persisted = await checkpointer.getTuple({
        configurable: { thread_id: 'thread-crashed' }
      })
      expect(injected).toBe(true)
      expect(observeCheckpoint(persisted?.checkpoint as Checkpoint)).toMatchObject({
        lifecycle: { runId: 'run-crashed', status: 'running' },
        messageTypes: expect.arrayContaining(['ai'])
      })
      const staged = await (agent as unknown as StateReader).getState({
        configurable: { thread_id: 'thread-crashed' }
      })
      expect(staged.next.length).toBeGreaterThan(0)
      expect(staged.tasks.length).toBeGreaterThan(0)
    } finally {
      connection.close()
    }
  })

  it('does not commit the completed lifecycle before attached work settles', async () => {
    const connection = new Database(':memory:')
    try {
      const checkpointer = new CurrentStateSqliteSaver(connection)
      const observations: CheckpointObservation[] = []
      const put = checkpointer.put.bind(checkpointer)
      checkpointer.put = async (
        config,
        checkpoint,
        metadata: CheckpointMetadata
      ) => {
        observations.push(observeCheckpoint(checkpoint))
        return put(config, checkpoint, metadata)
      }
      const beforeComplete = vi.fn(async () => {
        throw new Error('Attached background call has an uncertain outcome.')
      })
      const agent = createLifecycleTestAgent(
        checkpointer,
        'run-with-attached-task',
        beforeComplete
      )

      await expect(agent.invoke({
        messages: [new HumanMessage({ id: 'human-with-attached-task', content: 'Hello' })]
      }, {
        configurable: { thread_id: 'thread-with-attached-task' },
        durability: 'sync'
      })).rejects.toThrow('uncertain outcome')

      expect(beforeComplete).toHaveBeenCalledOnce()
      expect(observations.some(
        (item) => item.lifecycle?.runId === 'run-with-attached-task'
          && item.lifecycle.status === 'completed'
      )).toBe(false)
      const persisted = await checkpointer.getTuple({
        configurable: { thread_id: 'thread-with-attached-task' }
      })
      expect(observeCheckpoint(persisted?.checkpoint as Checkpoint)).toMatchObject({
        lifecycle: { runId: 'run-with-attached-task', status: 'running' },
        messageTypes: expect.arrayContaining(['ai'])
      })
    } finally {
      connection.close()
    }
  })

  it('requires supervision tools before a final answer without persisting the instruction', async () => {
    const connection = new Database(':memory:')
    try {
      const checkpointer = new CurrentStateSqliteSaver(connection)
      const threadId = 'thread-supervision'
      const runId = 'run-supervision'
      const callId = '11111111-1111-8111-8111-111111111111'
      const call = createManagedCallRecord({ id: callId, threadId, runId })
      let resolved = false
      const unresolvedCalls = vi.fn(() => resolved ? [] : [call])
      const resolveObservedCall = vi.fn(() => {
        resolved = true
      })
      const capturedRequests: Array<{
        systemPrompt: string
        toolChoice: unknown
        toolNames: string[]
      }> = []
      const captureSupervisionPrompt = createMiddleware({
        name: 'CaptureSupervisionPrompt',
        wrapModelCall: async (request, handler) => {
          capturedRequests.push({
            systemPrompt: request.systemMessage.text,
            toolChoice: request.toolChoice,
            toolNames: request.tools.flatMap((candidate) => (
              'name' in candidate && typeof candidate.name === 'string'
                ? [candidate.name]
                : []
            ))
          })
          const response = await handler(request)
          response.content = 'model response'
          return response
        }
      })
      const readCall = tool(async () => JSON.stringify({
        ok: true,
        call_id: callId,
        status: 'completed',
        terminal: true,
        output_chars_total: 4
      }), {
        name: 'read_call',
        description: 'Read one background call.',
        schema: callObservationSchema
      })
      const executeUnrelatedTool = vi.fn(async () => 'unrelated')
      const unrelatedTool = tool(executeUnrelatedTool, {
        name: 'unrelated_tool',
        description: 'An unrelated tool.',
        schema: z.object({})
      })
      const agent = createDeepAgent({
        model: new FakeToolCallingModel({
          toolCalls: [[{
            id: 'continue-during-supervision',
            name: 'unrelated_tool',
            args: {}
          }], [{
            id: 'read-during-supervision',
            name: 'read_call',
            args: { call_id: callId }
          }], []]
        }),
        systemPrompt: 'Base system prompt.',
        tools: [readCall, unrelatedTool],
        checkpointer,
        middleware: [
          createAgentRunLifecycleMiddleware(runId),
          createManagedCallSupervisionMiddleware({
            unresolvedCalls,
            resolveObservedCall
          }),
          captureSupervisionPrompt
        ]
      })

      const output = await agent.invoke({
        messages: [new HumanMessage({ id: 'human-supervision', content: 'Run the build' })]
      }, {
        configurable: { thread_id: threadId },
        durability: 'sync'
      }) as { messages: Array<{ type: string; tool_calls?: unknown[] }> }

      expect(resolveObservedCall).toHaveBeenCalledOnce()
      expect(executeUnrelatedTool).toHaveBeenCalledOnce()
      expect(output.messages.filter(
        (message) => message.type === 'ai' && (message.tool_calls?.length ?? 0) === 0
      )).toHaveLength(1)
      expect(capturedRequests[0]).toMatchObject({
        toolChoice: undefined,
        toolNames: expect.arrayContaining(['read_call', 'unrelated_tool'])
      })
      expect(capturedRequests[0].systemPrompt).toContain('<background_call_supervision>')
      expect(capturedRequests[0].systemPrompt).toContain(callId)
      expect(capturedRequests[1]).toMatchObject({
        toolChoice: undefined,
        toolNames: expect.arrayContaining(['read_call', 'unrelated_tool'])
      })
      expect(capturedRequests[2]).toMatchObject({
        toolChoice: undefined,
        toolNames: expect.arrayContaining(['read_call', 'unrelated_tool'])
      })
      const persisted = await checkpointer.getTuple({
        configurable: { thread_id: threadId }
      })
      expect(observeCheckpoint(persisted?.checkpoint as Checkpoint)).toMatchObject({
        lifecycle: { runId, status: 'completed' }
      })
      const persistedMessages = persisted?.checkpoint.channel_values.messages
      expect(Array.isArray(persistedMessages)).toBe(true)
      expect((persistedMessages as Array<{ content?: unknown }>).some((message) =>
        typeof message.content === 'string'
        && message.content.includes('<background_call_supervision>')
      )).toBe(false)
    } finally {
      connection.close()
    }
  })

  it('includes all pending calls and subagents on each request and drops observed entries', async () => {
    const ids = Array.from({ length: 7 }, (_, index) => `11111111-1111-4111-8111-${String(index).padStart(12, '0')}`)
    const calls = ids.map((id) => createManagedCallRecord({ id, threadId: 'owner', runId: 'run' }))
    const subagents: AgentSubagentCallRecord[] = ids.map((id, index) => ({
      id: `subagent-${id}`, ownerThreadId: 'owner', parentThreadId: 'owner', parentRunId: 'run',
      childThreadId: `child-${index}`, childRunId: `child-run-${index}`, agentName: 'reviewer',
      config: { index: 0, name: 'reviewer', enabled: true, builtIn: false, description: 'Review.',
        systemPrompt: 'Review.', capabilities: structuredClone(defaultCapabilities) },
      description: `Review task ${index}`, status: 'completed', createdAt: '', updatedAt: ''
    }))
    const observed = new Set<string>()
    const prompts: string[] = []
    const readCall = tool(async () => JSON.stringify({ ok: true, call_id: ids[0],
      status: 'completed', terminal: true, output_chars_total: 0 }), {
      name: 'read_call', description: 'Read call.', schema: z.object({ call_id: z.string() })
    })
    const readSubagent = tool(async () => JSON.stringify({ ok: true, subagent_id: subagents[0].id,
      status: 'completed', terminal: true }), {
      name: 'read_subagent', description: 'Read subagent.', schema: z.object({ subagent_id: z.string() })
    })
    const agent = createDeepAgent({
      model: new FakeToolCallingModel({ toolCalls: [[
        { id: 'read-first-call', name: 'read_call', args: { call_id: ids[0] } },
        { id: 'read-first-subagent', name: 'read_subagent', args: { subagent_id: subagents[0].id } }
      ], []] }),
      tools: [readCall, readSubagent],
      middleware: [
        createManagedCallSupervisionMiddleware({
          unresolvedCalls: (limit) => calls.filter((call) => !observed.has(call.id)).slice(0, limit),
          resolveObservedCall: (id) => { observed.add(id) }
        }),
        createSubagentSupervisionMiddleware({
          unresolved: (limit) => subagents.filter((call) => !observed.has(call.id)).slice(0, limit),
          resolve: (id) => { observed.add(id) }
        }),
        createMiddleware({ name: 'CaptureFullSupervision', wrapModelCall: (request, handler) => {
          prompts.push(request.systemMessage.text)
          return handler(request)
        } })
      ]
    })
    await agent.invoke({ messages: [new HumanMessage('Check pending work.')] })
    expect(prompts).toHaveLength(2)
    for (const { id } of [...calls, ...subagents]) expect(prompts[0]).toContain(`- ${id} (`)
    for (const { id } of [...calls.slice(1), ...subagents.slice(1)]) expect(prompts[1]).toContain(`- ${id} (`)
    expect(prompts[1]).not.toContain(`- ${ids[0]} (`)
    expect(prompts[1]).not.toContain(`- ${subagents[0].id} (`)
  })

  it.each([false, true])('composes managed-call and subagent supervision with a thinking provider (streaming: %s)', async (streaming) => {
    const connection = new Database(':memory:')
    try {
      const checkpointer = new CurrentStateSqliteSaver(connection)
      const threadId = 'thread-combined-supervision'
      const runId = 'run-combined-supervision'
      const callId = '21212121-2121-8121-8121-212121212121'
      const subagentId = '43434343-4343-8343-8343-434343434343'
      const call = createManagedCallRecord({ id: callId, threadId, runId })
      const subagent: AgentSubagentCallRecord = {
        id: subagentId,
        ownerThreadId: threadId,
        parentThreadId: threadId,
        parentRunId: runId,
        childThreadId: '65656565-6565-8565-8565-656565656565',
        childRunId: '87878787-8787-8787-8787-878787878787',
        agentName: 'reviewer',
        config: {
 capabilities: { ...structuredClone(defaultCapabilities), profile: false, workspace: true, memory: true, toolMode: 'all', tools: [], skills: { enabled: true, mode: 'default', project: false, entries: [] } },
          index: 0,
          name: 'reviewer',
          enabled: true,
          builtIn: false,
          description: 'Review code.',
          systemPrompt: 'Review the delegated code.',
        },
        description: 'Review the implementation.',
        status: 'completed',
        result: 'No findings.',
        createdAt: '2026-09-04T00:00:00.000Z',
        updatedAt: '2026-09-04T00:00:01.000Z'
      }
      let callResolved = false
      let subagentResolved = false
      const capturedRequests: Array<{
        systemPrompt: string
        toolChoice: unknown
        toolNames: string[]
      }> = []
      const captureSupervision = createMiddleware({
        name: 'CaptureCombinedSupervision',
        wrapModelCall: async (request, handler) => {
          capturedRequests.push({
            systemPrompt: request.systemMessage.text,
            toolChoice: request.toolChoice,
            toolNames: request.tools.flatMap((candidate) => (
              'name' in candidate && typeof candidate.name === 'string'
                ? [candidate.name]
                : []
            ))
          })
          return handler(request)
        }
      })
      const readCall = tool(async () => JSON.stringify({
        ok: true,
        call_id: callId,
        status: 'completed',
        terminal: true,
        output_chars_total: 4
      }), {
        name: 'read_call',
        description: 'Read one background call.',
        schema: callObservationSchema
      })
      const readSubagent = tool(async () => JSON.stringify({
        ok: true,
        subagents: [{
          subagent_id: subagentId,
          status: 'completed',
          terminal: true,
          result: 'No findings.'
        }]
      }), {
        name: 'read_subagent',
        description: 'Read one background subagent.',
        schema: z.object({ subagent_id: z.string().optional() })
      })
      const unrelatedTool = tool(async () => 'unrelated', {
        name: 'unrelated_tool',
        description: 'An unrelated tool.',
        schema: z.object({})
      })
      const providerRequests: Array<Record<string, unknown>> = []
      const providerFetch: typeof fetch = async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>
        providerRequests.push(request)
        if (request.tool_choice === 'required' || typeof request.tool_choice === 'object') {
          return Response.json({ error: {
            code: 'invalid_parameter_error', type: 'invalid_request_error',
            message: 'The tool_choice parameter does not support being set to required or object in thinking mode'
          } }, { status: 400 })
        }
        const first = providerRequests.length === 1
        const calls = first ? [{
          id: 'read-combined-call', type: 'function',
          function: { name: 'read_call', arguments: JSON.stringify({ call_id: callId }) }
        }, {
          id: 'read-combined-subagent', type: 'function',
          function: { name: 'read_subagent', arguments: '{}' }
        }] : []
        const content = first ? '' : 'Both operations completed.'
        const message = {
          role: 'assistant', content, reasoning_content: 'Check the background work before finishing.',
          ...(first ? { tool_calls: calls } : {})
        }
        const response = {
          id: `chat-supervision-${providerRequests.length}`, created: 1, model: 'thinking-model',
          usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
        }
        if (request.stream) {
          const chunk = (delta: Record<string, unknown>, finishReason: string | null) => JSON.stringify({
            ...response, object: 'chat.completion.chunk',
            choices: [{ index: 0, delta, finish_reason: finishReason }]
          })
          return new Response([
            chunk({ ...message, ...(first ? { tool_calls: calls.map((call, index) => ({ ...call, index })) } : {}) }, null),
            chunk({}, first ? 'tool_calls' : 'stop'), '[DONE]'
          ].map((data) => `data: ${data}\n\n`).join(''), {
            headers: { 'content-type': 'text/event-stream' }
          })
        }
        return Response.json({ ...response, object: 'chat.completion', choices: [{
          index: 0, message, finish_reason: first ? 'tool_calls' : 'stop'
        }] })
      }
      const agent = createDeepAgent({
        model: createChatModel({
          id: 'thinking-model', displayName: 'Thinking model', model: 'thinking-model',
          providerId: 'thinking-provider', providerName: 'Thinking provider',
          protocol: 'openai_chat_completions', baseUrl: 'https://example.invalid/v1',
          apiKey: 'test-key', parameters: { enable_thinking: true }, parameterPresetMode: 'none',
          capabilities: { vision: false, toolUse: true }, stream: streaming,
          maxContextTokens: 128_000, maxOutputTokens: 16_000,
          contextCompressionThreshold: 0.8, contextCompressionEnabled: false
        }, { providerFetch }),
        systemPrompt: 'Base system prompt.',
        tools: [readCall, readSubagent, unrelatedTool],
        checkpointer,
        middleware: [
          createAgentRunLifecycleMiddleware(runId),
          createSubagentSupervisionMiddleware({
            unresolved: () => subagentResolved ? [] : [subagent],
            resolve: () => {
              subagentResolved = true
            }
          }),
          createManagedCallSupervisionMiddleware({
            unresolvedCalls: () => callResolved ? [] : [call],
            resolveObservedCall: () => {
              callResolved = true
            }
          }),
          captureSupervision
        ]
      })

      const input = {
        messages: [new HumanMessage('Supervise both background operations.')]
      }
      const config = {
        configurable: { thread_id: threadId },
        durability: 'sync' as const
      }
      if (streaming) {
        const stream = await agent.streamEvents(input, { ...config, version: 'v3' })
        await stream.output
      } else {
        await agent.invoke(input, config)
      }

      expect(callResolved).toBe(true)
      expect(subagentResolved).toBe(true)
      expect(providerRequests).toHaveLength(2)
      for (const request of providerRequests) {
        expect(request.enable_thinking).toBe(true)
        expect(request.tool_choice).toBeUndefined()
        expect(request.stream).toBe(streaming)
      }
      expect(capturedRequests[0]).toMatchObject({
        toolChoice: undefined,
        toolNames: expect.arrayContaining(['read_call', 'read_subagent', 'unrelated_tool'])
      })
      expect(capturedRequests[0].systemPrompt).toContain('<background_call_supervision>')
      expect(capturedRequests[0].systemPrompt).toContain('<subagent_supervision>')
      expect(capturedRequests[0].systemPrompt).not.toContain('delegate that supervision')
      expect(capturedRequests[1]).toMatchObject({
        toolChoice: undefined,
        toolNames: expect.arrayContaining(['read_call', 'read_subagent', 'unrelated_tool'])
      })
    } finally {
      connection.close()
    }
  })

  it('resolves a call only after its terminal status message is durable', async () => {
    const connection = new Database(':memory:')
    try {
      const checkpointer = new CurrentStateSqliteSaver(connection)
      const threadId = 'thread-observed-call'
      const runId = 'run-observed-call'
      const callId = '22222222-2222-8222-8222-222222222222'
      let resolved = false
      let bothToolMessagesWereDurable = false
      const receivedInputs: Array<Record<string, unknown>> = []
      const call = createManagedCallRecord({ id: callId, threadId, runId })
      const resolveObservedCall = vi.fn(async (observedCallId: string) => {
        const persisted = await checkpointer.getTuple({
          configurable: { thread_id: threadId }
        })
        const messages = persisted?.checkpoint.channel_values.messages
        bothToolMessagesWereDurable = Array.isArray(messages)
          && ['read-call-page-1', 'read-call-page-2'].every((toolCallId) =>
            messages.some((message) =>
              ToolMessage.isInstance(message)
              && message.name === 'read_call'
              && message.tool_call_id === toolCallId
            )
          )
        expect(observedCallId).toBe(callId)
        resolved = true
      })
      const readCall = tool(async (input) => {
        receivedInputs.push({ ...input })
        if (receivedInputs.length === 1) {
          expect(resolveObservedCall).not.toHaveBeenCalled()
          return JSON.stringify({
            ok: true,
            call_id: callId,
            status: 'running',
            terminal: false,
            output_chars_total: 12
          })
        }
        expect(resolveObservedCall).not.toHaveBeenCalled()
        return JSON.stringify({
          ok: true,
          call_id: callId,
          status: 'completed',
          terminal: true,
          output_chars_total: 25
        })
      }, {
        name: 'read_call',
        description: 'Read one background call.',
        schema: callObservationSchema
      })
      const agent = createDeepAgent({
        model: new FakeToolCallingModel({
          toolCalls: [[{
            id: 'read-call-page-1',
            name: 'read_call',
            args: { call_id: callId }
          }], [{
            id: 'read-call-page-2',
            name: 'read_call',
            args: { call_id: callId }
          }], []]
        }),
        tools: [readCall],
        checkpointer,
        middleware: [
          createAgentRunLifecycleMiddleware(runId),
          createManagedCallSupervisionMiddleware({
            unresolvedCalls: () => resolved ? [] : [call],
            resolveObservedCall
          })
        ]
      })

      await agent.invoke({
        messages: [new HumanMessage({ id: 'human-observed-call', content: 'Read the result' })]
      }, {
        configurable: { thread_id: threadId },
        durability: 'sync'
      })

      expect(resolveObservedCall).toHaveBeenCalledOnce()
      expect(receivedInputs).toEqual([
        { call_id: callId },
        { call_id: callId }
      ])
      expect(bothToolMessagesWereDurable).toBe(true)
      const persisted = await checkpointer.getTuple({
        configurable: { thread_id: threadId }
      })
      expect(observeCheckpoint(persisted?.checkpoint as Checkpoint)).toMatchObject({
        lifecycle: { runId, status: 'completed' }
      })
    } finally {
      connection.close()
    }
  })

  it('keeps simultaneous terminal observations isolated by call and tool-call IDs', async () => {
    const connection = new Database(':memory:')
    try {
      const checkpointer = new CurrentStateSqliteSaver(connection)
      const threadId = 'thread-simultaneous-call-waits'
      const runId = 'run-simultaneous-call-waits'
      const firstCallId = '66666666-6666-8666-8666-666666666666'
      const secondCallId = '77777777-7777-8777-8777-777777777777'
      const calls = [firstCallId, secondCallId].map((id) => createManagedCallRecord({
        id,
        threadId,
        runId,
        status: 'running'
      }))
      const resolved = new Set<string>()
      const receivedInputs: Array<Record<string, unknown>> = []
      const callsByCall = new Map<string, number>()
      const waitCall = tool(async (input) => {
        receivedInputs.push({ ...input })
        const count = (callsByCall.get(input.call_id) ?? 0) + 1
        callsByCall.set(input.call_id, count)
        if (count === 1) {
          return JSON.stringify({
            ok: true,
            call_id: input.call_id,
            status: 'running',
            terminal: false,
            output_chars_total: input.call_id === firstCallId ? 17 : 40
          })
        }
        return JSON.stringify({
          ok: true,
          call_id: input.call_id,
          status: 'completed',
          terminal: true,
          output_chars_total: input.call_id === firstCallId ? 17 : 40
        })
      }, {
        name: 'wait_call',
        description: 'Wait for one background call.',
        schema: callWaitSchema
      })
      const agent = createDeepAgent({
        model: new FakeToolCallingModel({
          toolCalls: [[{
            id: 'wait-first-page-a',
            name: 'wait_call',
            args: { call_id: firstCallId, timeout: 30 }
          }, {
            id: 'wait-first-page-b',
            name: 'wait_call',
            args: { call_id: secondCallId, timeout: 30 }
          }], [{
            id: 'wait-second-page-b',
            name: 'wait_call',
            args: { call_id: secondCallId, timeout: 30 }
          }, {
            id: 'wait-second-page-a',
            name: 'wait_call',
            args: { call_id: firstCallId, timeout: 30 }
          }], []]
        }),
        tools: [waitCall],
        checkpointer,
        middleware: [
          createAgentRunLifecycleMiddleware(runId),
          createManagedCallSupervisionMiddleware({
            unresolvedCalls: () => calls.filter((call) => !resolved.has(call.id)),
            resolveObservedCall: (callId) => {
              resolved.add(callId)
            }
          })
        ]
      })

      await agent.invoke({
        messages: [new HumanMessage('Wait for both calls.')]
      }, {
        configurable: { thread_id: threadId },
        durability: 'sync'
      })

      expect(resolved).toEqual(new Set([firstCallId, secondCallId]))
      expect(receivedInputs).toHaveLength(4)
      expect(receivedInputs).toEqual(expect.arrayContaining([
        { call_id: firstCallId, timeout: 30 },
        { call_id: secondCallId, timeout: 30 },
        { call_id: firstCallId, timeout: 30 },
        { call_id: secondCallId, timeout: 30 }
      ]))
    } finally {
      connection.close()
    }
  })

  it('resolves every terminal call returned by read_call without an ID', async () => {
    const connection = new Database(':memory:')
    try {
      const checkpointer = new CurrentStateSqliteSaver(connection)
      const threadId = 'thread-bulk-call-read'
      const runId = 'run-bulk-call-read'
      const callIds = [
        '12121212-1212-8121-8121-121212121212',
        '34343434-3434-8343-8343-343434343434',
        '56565656-5656-8565-8565-565656565656',
        '78787878-7878-8787-8787-787878787878',
        '90909090-9090-8909-8909-909090909090',
        'abababab-abab-8bab-8bab-abababababab'
      ]
      const calls = callIds.map((id) => createManagedCallRecord({ id, threadId, runId }))
      const resolved = new Set<string>()
      const receivedInputs: Array<Record<string, unknown>> = []
      const readCall = tool(async (input) => {
        receivedInputs.push({ ...input })
        return JSON.stringify({
          ok: true,
          count: calls.length,
          calls: calls.map((call) => ({
            ok: true,
            call_id: call.id,
            status: call.status,
            terminal: true,
            output_chars_total: call.outputChars
          }))
        })
      }, {
        name: 'read_call',
        description: 'Read all background calls that still require attention.',
        schema: z.object({ call_id: z.string().optional() })
      })
      const agent = createDeepAgent({
        model: new FakeToolCallingModel({
          toolCalls: [[{
            id: 'read-all-terminal-calls',
            name: 'read_call',
            args: {}
          }], []]
        }),
        tools: [readCall],
        checkpointer,
        middleware: [
          createAgentRunLifecycleMiddleware(runId),
          createManagedCallSupervisionMiddleware({
            unresolvedCalls: (limit) => calls
              .filter((call) => !resolved.has(call.id))
              .slice(0, limit),
            resolveObservedCall: (callId) => {
              resolved.add(callId)
            }
          })
        ]
      })

      await agent.invoke({
        messages: [new HumanMessage('Read every completed call.')]
      }, {
        configurable: { thread_id: threadId },
        durability: 'sync'
      })

      expect(receivedInputs).toEqual([{}])
      expect(resolved).toEqual(new Set(callIds))
    } finally {
      connection.close()
    }
  })

  it('resolves a durable terminal observation before later message compaction', async () => {
    const connection = new Database(':memory:')
    try {
      const checkpointer = new CurrentStateSqliteSaver(connection)
      const threadId = 'thread-observed-call-after-summary'
      const runId = 'run-observed-call-after-summary'
      const callId = '55555555-5555-8555-8555-555555555555'
      const call = createManagedCallRecord({ id: callId, threadId, runId })
      let resolved = false
      let compacted = false
      const resolveObservedCall = vi.fn(() => {
        resolved = true
      })
      const readCall = tool(async () => JSON.stringify({
        ok: true,
        call_id: callId,
        status: 'completed',
        terminal: true,
        output_chars_total: 25
      }), {
        name: 'read_call',
        description: 'Read one background call.',
        schema: callObservationSchema
      })
      const summarizeFirstPage = createMiddleware({
        name: 'SummarizeFirstManagedCallPage',
        beforeModel: (state) => {
          if (compacted) return undefined
          const firstToolMessage = state.messages.find((message) => (
            ToolMessage.isInstance(message)
            && message.tool_call_id === 'read-call-before-summary'
          ))
          if (!firstToolMessage) return undefined
          const firstCallMessage = state.messages.find((message) => (
            AIMessage.isInstance(message)
            && message.tool_calls?.some((call) => call.id === 'read-call-before-summary')
          ))
          if (!firstCallMessage?.id || !firstToolMessage.id) {
            throw new Error('Expected observation messages to have durable IDs.')
          }
          compacted = true
          return {
            messages: [
              new RemoveMessage({ id: firstCallMessage.id }),
              new RemoveMessage({ id: firstToolMessage.id })
            ]
          }
        }
      })
      const agent = createDeepAgent({
        model: new FakeToolCallingModel({
          toolCalls: [[{
            id: 'read-call-before-summary',
            name: 'read_call',
            args: { call_id: callId }
          }], [{
            id: 'read-call-after-summary',
            name: 'read_call',
            args: { call_id: callId }
          }], []]
        }),
        tools: [readCall],
        checkpointer,
        middleware: [
          createAgentRunLifecycleMiddleware(runId),
          createManagedCallSupervisionMiddleware({
            unresolvedCalls: () => resolved ? [] : [call],
            resolveObservedCall
          }),
          summarizeFirstPage
        ]
      })

      await agent.invoke({
        messages: [new HumanMessage({
          id: 'human-observed-call-after-summary',
          content: 'Read the paged result despite compression.'
        })]
      }, {
        configurable: { thread_id: threadId },
        durability: 'sync'
      })

      expect(compacted).toBe(true)
      expect(resolveObservedCall).toHaveBeenCalledOnce()
      const persisted = await checkpointer.getTuple({
        configurable: { thread_id: threadId }
      })
      expect(observeCheckpoint(persisted?.checkpoint as Checkpoint)).toMatchObject({
        lifecycle: { runId, status: 'completed' }
      })
    } finally {
      connection.close()
    }
  })

  it.each([
    { label: 'terminal flag', terminal: false, outputChars: 0 },
    { label: 'output total', terminal: true, outputChars: undefined }
  ])('does not resolve a call with an invalid $label', async ({ label, terminal, outputChars }) => {
    const connection = new Database(':memory:')
    try {
      const checkpointer = new CurrentStateSqliteSaver(connection)
      const threadId = `thread-invalid-${label.replaceAll(' ', '-')}`
      const runId = `run-invalid-${label.replaceAll(' ', '-')}`
      const callId = '33333333-3333-8333-8333-333333333333'
      const call = createManagedCallRecord({ id: callId, threadId, runId })
      const resolveObservedCall = vi.fn()
      const readCall = tool(async () => JSON.stringify({
        ok: true,
        call_id: callId,
        status: 'completed',
        terminal,
        output_chars_total: outputChars
      }), {
        name: 'read_call',
        description: 'Read one background call.',
        schema: callObservationSchema
      })
      const agent = createDeepAgent({
        model: new FakeToolCallingModel({
          toolCalls: [[{
            id: `read-invalid-${label.replaceAll(' ', '-')}`,
            name: 'read_call',
            args: { call_id: callId }
          }], [], []]
        }),
        tools: [readCall],
        checkpointer,
        middleware: [
          createAgentRunLifecycleMiddleware(runId),
          createManagedCallSupervisionMiddleware({
            unresolvedCalls: () => [call],
            resolveObservedCall
          })
        ]
      })

      await expect(agent.invoke({
        messages: [new HumanMessage('Return an invalid terminal observation.')]
      }, {
        configurable: { thread_id: threadId },
        durability: 'sync'
      })).resolves.toMatchObject({ [agentRunLifecycleStateKey]: { status: 'completed' } })

      expect(resolveObservedCall).not.toHaveBeenCalled()
    } finally {
      connection.close()
    }
  })

  it('checkpoints a final answer once while leaving omitted calls for runtime cleanup', async () => {
    const connection = new Database(':memory:')
    try {
      const checkpointer = new CurrentStateSqliteSaver(connection)
      const threadId = 'thread-repeated-final'
      const runId = 'run-repeated-final'
      const call = createManagedCallRecord({
        id: '44444444-4444-8444-8444-444444444444',
        threadId,
        runId,
        status: 'running'
      })
      const readCall = tool(async () => 'unreachable', {
        name: 'read_call',
        description: 'Read one background call.',
        schema: callObservationSchema
      })
      let modelCalls = 0
      const countModelCalls = createMiddleware({
        name: 'CountInvalidSupervisionModelCalls',
        wrapModelCall: async (request, handler) => {
          modelCalls += 1
          const response = await handler(request)
          response.content = [
            { type: 'reasoning', reasoning: 'Original reasoning.' },
            { type: 'text', text: 'Original final answer.' }
          ]
          return response
        }
      })
      const agent = createDeepAgent({
        model: new FakeToolCallingModel({ toolCalls: [[]] }),
        tools: [readCall],
        checkpointer,
        middleware: [
          createAgentRunLifecycleMiddleware(runId),
          createManagedCallSupervisionMiddleware({
            unresolvedCalls: () => [call]
          }),
          countModelCalls
        ]
      })

      await expect(agent.invoke({
        messages: [new HumanMessage('Finish without reading the call.')]
      }, {
        configurable: { thread_id: threadId },
        durability: 'sync'
      })).resolves.toMatchObject({ [agentRunLifecycleStateKey]: { status: 'completed' } })
      expect(modelCalls).toBe(1)
      const persisted = await checkpointer.getTuple({ configurable: { thread_id: threadId } })
      const messages = persisted!.checkpoint.channel_values.messages as AIMessage[]
      expect(messages.at(-1)?.content).toEqual([
        { type: 'reasoning', reasoning: 'Original reasoning.' },
        { type: 'text', text: 'Original final answer.' }
      ])
    } finally {
      connection.close()
    }
  })

  it('continues pending framework work with null input without replaying completed nodes', async () => {
    const connection = new Database(':memory:')
    try {
      const checkpointer = new CurrentStateSqliteSaver(connection)
      const State = Annotation.Root({
        trace: Annotation<string[]>({
          reducer: (current, update) => [...current, ...update],
          default: () => []
        })
      })
      let firstCalls = 0
      let pendingCalls = 0
      const graph = new StateGraph(State)
        .addNode('first', () => {
          firstCalls += 1
          return { trace: ['first-executed'] }
        })
        .addNode('pending', () => {
          pendingCalls += 1
          return { trace: ['pending-executed'] }
        })
        .addEdge(START, 'first')
        .addEdge('first', 'pending')
        .addEdge('pending', END)
        .compile({ checkpointer })
      const config = {
        configurable: { thread_id: 'recoverable-state-graph' },
        durability: 'sync' as const
      }

      await graph.updateState(config, { trace: ['first-committed'] }, 'first')
      const staged = await graph.getState(config)
      expect(staged.next).toEqual(['pending'])

      const output = await graph.invoke(null, config)

      expect(firstCalls).toBe(0)
      expect(pendingCalls).toBe(1)
      expect(output.trace).toEqual(['first-committed', 'pending-executed'])
    } finally {
      connection.close()
    }
  })
})
