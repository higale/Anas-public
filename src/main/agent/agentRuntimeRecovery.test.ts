import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import { tool } from '@langchain/core/tools'
import { Command, type StateSnapshot } from '@langchain/langgraph'
import type { CheckpointMetadata } from '@langchain/langgraph-checkpoint'
import { createDeepAgent } from 'deepagents'
import { createMiddleware, FakeToolCallingModel } from 'langchain'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuntimeEvent } from '@shared/agentTypes'
import { AgentDatabase } from './agentDatabase'
import { AgentRuntime } from './agentRuntime'
import { createAgentRunLifecycleMiddleware } from './runLifecycleMiddleware'
import { createProjectRulesMiddleware } from './projectRulesMiddleware'
import {
  createManualContextCompressionMiddleware,
  manualContextCompressionInput
} from './manualCompressionMiddleware'

const runtimeLogMock = vi.hoisted(() => vi.fn())

vi.mock('../runtimeLogger', () => ({ runtimeLog: runtimeLogMock }))

const temporaryRoots: string[] = []

function temporaryDatabase(): { file: string; attachments: string } {
  const root = mkdtempSync(join(tmpdir(), 'anas-runtime-recovery-'))
  temporaryRoots.push(root)
  return {
    file: join(root, 'agent.sqlite'),
    attachments: join(root, 'attachments')
  }
}

async function collect(events: AsyncIterable<AgentRuntimeEvent>): Promise<AgentRuntimeEvent[]> {
  const result: AgentRuntimeEvent[] = []
  for await (const event of events) result.push(event)
  return result
}

describe('AgentRuntime checkpoint recovery', () => {
  let database: AgentDatabase | undefined

  afterEach(() => {
    database?.close()
    database = undefined
    runtimeLogMock.mockReset()
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('finishes a durable rule-budget failure and does not offer it for recovery after reopening', async () => {
    const location = temporaryDatabase()
    const root = realpathSync(join(location.file, '..'))
    mkdirSync(join(root, 'child'))
    writeFileSync(join(root, 'AGENTS.md'), 'ROOT RULE')
    writeFileSync(join(root, 'child/AGENTS.md'), 'LARGE '.repeat(1200))
    database = AgentDatabase.open(location.file, location.attachments)
    const thread = database.createThread({ title: 'Terminal rule budget' })
    const writes = vi.fn(async () => 'previous real result')
    const runtime = new AgentRuntime(database, async (_thread, _database, context) => {
      const rules = createProjectRulesMiddleware({ runId: context?.requestId, folders: [root], primaryFolder: root, getInputCapacityTokens: () => 1500, getModelTokenCountingOptions: () => ({ protocol: 'openai_chat_completions' }), accessMode: () => 'full_access' })
      const agent = createDeepAgent({
        model: new FakeToolCallingModel({ toolCalls: [
          [{ id: 'first', name: 'delete_file', args: { path: join(root, 'a') } }],
          [{ id: 'large', name: 'delete_file', args: { path: join(root, 'child/b') } }], []
        ] }),
        systemPrompt: { base: 'BASE' },
        checkpointer: database!.checkpointer,
        middleware: [
          createMiddleware({ name: 'FilesystemMiddleware', tools: [tool(writes, { name: 'delete_file', description: 'Write', schema: z.object({ path: z.string() }) })] }),
          createMiddleware({ name: 'subAgentMiddleware' }),
          createMiddleware({ name: 'SummarizationMiddleware' }),
          createAgentRunLifecycleMiddleware(context?.requestId),
          rules.middleware, rules.guard,
          createMiddleware({ name: 'QuietFake', wrapModelCall: async (request, handler) => {
            const response = await handler(request)
            response.content = ''
            return response
          } })
        ]
      })
      return { agent: agent as never, dispose: async () => {} }
    }, undefined, async () => {})
    const events = await collect(runtime.startRun({ runId: 'terminal-rules', threadId: thread.id, text: 'Edit files' }))
    expect(events.at(-1)).toMatchObject({ type: 'run_failed', run: { status: 'failed' } })
    expect(database.getRun('terminal-rules')?.error).toContain('indivisible')
    expect(writes).toHaveBeenCalledOnce()
    expect(database.listRecoverableRuns()).toEqual([])
    await runtime.shutdown()
    database.close()
    writeFileSync(join(root, 'child/AGENTS.md'), 'FIXED')
    database = AgentDatabase.open(location.file, location.attachments)
    expect(database.getRun('terminal-rules')?.status).toBe('failed')
    expect(database.listRecoverableRuns()).toEqual([])
  })

  it.each(['checkpoint', 'pending-write'] as const)('recognizes a terminal rule failure saved as a %s before the process stopped', async (storage) => {
    const location = temporaryDatabase()
    database = AgentDatabase.open(location.file, location.attachments)
    const thread = database.createThread({ title: 'Stopped after rule preflight' })
    const run = database.createRun(thread.id, 'stopped-rules')
    const fatal = { runId: run.id, fatalError: 'Project rules exceed the request budget.' }
    const config = await database.checkpointer.put({ configurable: { thread_id: thread.id, checkpoint_ns: '' } }, {
      v: 4, id: 'rules-preflight', ts: new Date().toISOString(),
      channel_values: storage === 'checkpoint' ? { anasProjectRules: fatal } : {},
      channel_versions: {}, versions_seen: {}
    }, { source: 'loop', step: 1, parents: {} })
    if (storage === 'pending-write') await database.checkpointer.putWrites(config, [['anasProjectRules', fatal]], 'rules-preflight-task')
    expect(database.classifyRunningRun(run.id)).toBe('error')
    database.close()
    database = AgentDatabase.open(location.file, location.attachments)
    expect(database.getRun(run.id)).toMatchObject({ status: 'failed', error: fatal.fatalError })
    expect(database.listRecoverableRuns()).toEqual([])
  })

  it('continues a pending Deep Agent node without repeating its durable tool result', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Real checkpoint recovery' })
    const run = database.createRun(thread.id, 'real-recovery-run')
    const executeLookup = vi.fn(async () => 'repeated result')
    const lookup = tool(executeLookup, {
      name: 'durable_lookup',
      description: 'Returns a lookup result.',
      schema: z.object({ query: z.string() })
    })
    const model = new FakeToolCallingModel({ toolCalls: [[]] })
    const agent = createDeepAgent({
      model,
      tools: [lookup],
      checkpointer: database.checkpointer,
      middleware: [createAgentRunLifecycleMiddleware(run.id)]
    })
    const config = { configurable: { thread_id: thread.id } }
    await agent.updateState(config, {
      messages: [
        new HumanMessage({ id: 'recovery-user', content: 'Look up the durable value.' }),
        new AIMessage({
          id: 'recovery-tool-call',
          content: '',
          tool_calls: [{
            id: 'durable-tool-call',
            name: 'durable_lookup',
            args: { query: 'value' }
          }]
        }),
        new ToolMessage({
          id: 'durable-tool-result',
          name: 'durable_lookup',
          tool_call_id: 'durable-tool-call',
          content: 'durable result'
        })
      ]
    }, 'tools')

    const durableState = await agent.getState(config) as StateSnapshot
    expect(durableState.next).toContain('model_request')
    expect(database.listRecoverableRuns().map((candidate) => candidate.id)).toEqual([run.id])

    const cleanupFileEdits = vi.fn(async () => {})
    const runtime = new AgentRuntime(database, async () => ({
      agent: agent as never,
      dispose: async () => {}
    }), undefined, cleanupFileEdits)
    const recovery = runtime.recoverRun(thread.id)
    if (!recovery) throw new Error('Expected the durable run to be recoverable.')
    const events = await collect(recovery)

    expect(executeLookup).not.toHaveBeenCalled()
    expect(events.at(-1)).toMatchObject({
      type: 'run_completed',
      run: { id: run.id, status: 'completed' }
    })
    expect(cleanupFileEdits).toHaveBeenCalledWith(run.id)
    expect(database.listFileEditCleanupRunIds()).toEqual([])
    const completedState = await agent.getState(config) as StateSnapshot
    expect(completedState.next).toEqual([])
    expect(completedState.values.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'durable-tool-result' }),
      expect.objectContaining({ type: 'ai' })
    ]))
  })

  it('resets a DB-ahead completed tool when its ToolMessage write was not durable', async () => {
    const location = temporaryDatabase()
    database = AgentDatabase.open(location.file, location.attachments)
    const thread = database.createThread({ title: 'Activity write recovery' })
    const run = database.createRun(thread.id, 'activity-write-recovery-run')
    let projectAhead = true
    const executions = vi.fn(async ({ query }: { query: string }) => {
      const output = `result:${query}`
      if (projectAhead) {
        database!.recordToolActivity(run.id, {
          id: 'activity-tool-call',
          name: 'recoverable_lookup',
          args: { query }
        }, 'completed', undefined, output)
      }
      return output
    })
    const lookup = tool(executions, {
      name: 'recoverable_lookup',
      description: 'Returns a recoverable lookup result.',
      schema: z.object({ query: z.string() })
    })
    const model = new FakeToolCallingModel({
      toolCalls: [[{
        id: 'activity-tool-call',
        name: 'recoverable_lookup',
        args: { query: 'value' }
      }], []]
    })
    const metadata = createMiddleware({
      name: 'ActivityRecoveryMessageMetadata',
      wrapModelCall: async (request, handler) => {
        const response = await handler(request)
        response.additional_kwargs = {
          ...response.additional_kwargs,
          anas_run_id: run.id
        }
        return response
      }
    })
    const firstAgent = createDeepAgent({
      model,
      tools: [lookup],
      checkpointer: database.checkpointer,
      middleware: [createAgentRunLifecycleMiddleware(run.id), metadata]
    })
    const originalPutWrites = database.checkpointer.putWrites.bind(database.checkpointer)
    const originalPut = database.checkpointer.put.bind(database.checkpointer)
    let injected = false
    let stopBeforeRootCheckpoint = false
    database.checkpointer.putWrites = async (checkpointConfig, writes, taskId) => {
      const containsToolResult = writes.some(([channel, value]) =>
        channel === 'messages'
        && (
          ToolMessage.isInstance(value)
          || (Array.isArray(value) && value.some((item) => ToolMessage.isInstance(item)))
        )
      )
      if (containsToolResult) {
        injected = true
        stopBeforeRootCheckpoint = true
        throw new Error('Simulated crash before the tool result write became durable.')
      }
      return originalPutWrites(checkpointConfig, writes, taskId)
    }
    database.checkpointer.put = async (checkpointConfig, nextCheckpoint, metadata) => {
      if (stopBeforeRootCheckpoint) {
        throw new Error('Simulated stopped process cannot advance the root checkpoint.')
      }
      return originalPut(checkpointConfig, nextCheckpoint, metadata)
    }
    const config = {
      configurable: { thread_id: thread.id },
      durability: 'sync' as const
    }
    await expect(firstAgent.invoke({
      messages: [new HumanMessage({
        id: 'activity-recovery-user',
        content: 'Look up the value.',
        additional_kwargs: { anas_run_id: run.id }
      })]
    }, config)).rejects.toThrow('Simulated crash before the tool result write became durable.')
    expect(injected).toBe(true)
    expect(executions).toHaveBeenCalledOnce()
    expect(database.getActivitiesForThread(thread.id)[0].tools).toEqual([
      expect.objectContaining({
        call: expect.objectContaining({ id: 'activity-tool-call' }),
        status: 'completed',
        output: 'result:value'
      })
    ])
    const failedTuple = await database.checkpointer.getTuple(config)
    expect(failedTuple?.checkpoint.channel_values.messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: '0', type: 'ai' })
    ]))
    expect((failedTuple?.checkpoint.channel_values.messages as unknown[]).filter((message) =>
      ToolMessage.isInstance(message)
    )).toEqual([])
    expect(failedTuple?.pendingWrites?.some(([, channel, value]) =>
      channel === 'messages'
      && (
        ToolMessage.isInstance(value)
        || (Array.isArray(value) && value.some((item) => ToolMessage.isInstance(item)))
      )
    )).toBe(false)
    database.close()

    database = AgentDatabase.open(location.file, location.attachments)
    projectAhead = false
    let recoveryAgent: ReturnType<typeof createDeepAgent> | undefined
    const runtime = new AgentRuntime(database, async () => {
      recoveryAgent = createDeepAgent({
        model,
        tools: [lookup],
        checkpointer: database!.checkpointer,
        middleware: [createAgentRunLifecycleMiddleware(run.id), metadata]
      })
      return { agent: recoveryAgent as never, dispose: async () => {} }
    }, undefined, async () => {})

    const beforeRecovery = await runtime.getSnapshot(thread.id)
    expect(beforeRecovery.activities[0]).toMatchObject({
      runId: run.id,
      status: 'running',
      tools: [expect.objectContaining({
        call: expect.objectContaining({ id: 'activity-tool-call' }),
        status: 'running',
        output: undefined,
        completedAt: undefined
      })]
    })
    const recovery = runtime.recoverRun(thread.id)
    if (!recovery) throw new Error('Expected the tool activity run to be recoverable.')
    const events = await collect(recovery)

    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool_started',
        call: expect.objectContaining({ id: 'activity-tool-call' })
      }),
      expect.objectContaining({
        type: 'tool_completed',
        call: expect.objectContaining({ id: 'activity-tool-call' }),
        output: 'result:value'
      }),
      expect.objectContaining({
        type: 'run_completed',
        run: expect.objectContaining({ id: run.id, status: 'completed' })
      })
    ]))
    expect(executions).toHaveBeenCalledTimes(2)
    const completed = database.getActivitiesForThread(thread.id)[0]
    expect(completed.tools).toEqual([
      expect.objectContaining({
        call: expect.objectContaining({ id: 'activity-tool-call' }),
        status: 'completed',
        output: 'result:value',
        completedAt: expect.any(String)
      })
    ])
    expect(database.getRun(run.id)?.status).toBe('completed')
  })

  it('re-delivers the complete durable resume command after a process restart', async () => {
    database = AgentDatabase.open(':memory:')
    const thread = database.createThread({ title: 'Resume intent recovery' })
    const run = database.createRun(thread.id, 'resume-intent-recovery-run')
    const checkpointId = 'resume-intent-interrupt-checkpoint'
    await database.checkpointer.put({
      configurable: { thread_id: thread.id, checkpoint_ns: '' }
    }, {
      v: 4,
      id: checkpointId,
      ts: new Date().toISOString(),
      channel_values: {
        anasRunLifecycle: { runId: run.id, status: 'running' as const }
      },
      channel_versions: {},
      versions_seen: {}
    }, {
      source: 'loop',
      step: 1,
      parents: {}
    })
    await database.checkpointer.putWrites({
      configurable: {
        thread_id: thread.id,
        checkpoint_ns: '',
        checkpoint_id: checkpointId
      }
    }, [[
      '__interrupt__',
      [
        { id: 'approval-left', value: { branch: 'left' } },
        { id: 'approval-right', value: { branch: 'right' } }
      ]
    ]], 'parallel-interrupt-task')
    database.finishRun(run.id, 'interrupted')
    const resumeIntent = {
      'approval-left': { decisions: [{ type: 'approve' }] },
      'approval-right': {
        decisions: [{ type: 'reject', message: 'Skip the right branch.' }]
      }
    }
    database.resumeRun(run.id, [
      {
        interruptId: 'approval-left',
        response: resumeIntent['approval-left']
      },
      {
        interruptId: 'approval-right',
        response: resumeIntent['approval-right']
      }
    ])

    const inputs: unknown[] = []
    let attempt = 0
    const runtime = new AgentRuntime(database, async () => ({
      agent: {
        streamEvents: async (input) => {
          inputs.push(input)
          attempt += 1
          if (attempt === 2) {
            await database!.checkpointer.put({
              configurable: { thread_id: thread.id, checkpoint_ns: '' }
            }, {
              v: 4,
              id: 'resume-intent-terminal-checkpoint',
              ts: new Date().toISOString(),
              channel_values: {
                anasRunLifecycle: { runId: run.id, status: 'completed' as const }
              },
              channel_versions: {},
              versions_seen: {}
            }, {
              source: 'loop',
              step: 2,
              parents: {}
            })
          }
          return Object.assign({
            interrupted: false,
            interrupts: [],
            messages: (async function *() {})(),
            toolCalls: (async function *() {})(),
            subagents: (async function *() {})(),
            output: attempt === 1
              ? Promise.reject(new Error('Stop after capturing recovery input.'))
              : Promise.resolve({
                  anasRunLifecycle: { runId: run.id, status: 'completed' as const }
                }),
            abort() {}
          }, {
            async *[Symbol.asyncIterator]() {}
          }) as never
        },
        getState: async () => ({ values: {}, tasks: [] }) as never
      },
      dispose: async () => {}
    }), undefined, async () => {})
    const recovery = runtime.recoverRun(thread.id)
    if (!recovery) throw new Error('Expected the persisted resume intent to be recoverable.')
    const events = await collect(recovery)

    expect(inputs).toHaveLength(1)
    expect(inputs[0]).toBeInstanceOf(Command)
    expect(inputs[0]).toMatchObject({ resume: resumeIntent })
    expect(events.at(-1)).toMatchObject({
      type: 'run_recovery_failed',
      run: { id: run.id, status: 'running' }
    })
    expect(database.getRun(run.id)?.status).toBe('running')
    expect(database.listRecoverableRuns().map((candidate) => candidate.id)).toEqual([run.id])
    expect(database.getRunCheckpointState(run.id).resumeIntent).toEqual(resumeIntent)

    const retry = runtime.recoverRun(thread.id)
    if (!retry) throw new Error('Expected the durable resume intent to remain retryable.')
    const retriedEvents = await collect(retry)
    expect(inputs).toHaveLength(2)
    expect(inputs[1]).toBeInstanceOf(Command)
    expect(inputs[1]).toMatchObject({ resume: resumeIntent })
    expect(retriedEvents.at(-1)).toMatchObject({
      type: 'run_completed',
      run: { id: run.id, status: 'completed' }
    })
    expect(database.getRunCheckpointState(run.id).resumeIntent).toBeUndefined()
  })

  it('recovers a durable manual-compression graph node without regenerating its summary', async () => {
    const location = temporaryDatabase()
    database = AgentDatabase.open(location.file, location.attachments)
    const thread = database.createThread({ title: 'Compression write recovery' })
    const runId = randomUUID()
    const model = new FakeToolCallingModel({ toolCalls: [[]] })
    const modelCall = vi.fn()
    const modelObserver = createMiddleware({
      name: 'CompressionRecoveryModelObserver',
      wrapModelCall: async (request, handler) => {
        modelCall()
        return handler(request)
      }
    })
    const messages = [new HumanMessage({ id: 'compression-history', content: 'Long history' })]
    const config = {
      configurable: { thread_id: thread.id },
      durability: 'sync' as const
    }
    const seedAgent = createDeepAgent({
      model,
      checkpointer: database.checkpointer
    })
    await seedAgent.updateState(config, { messages })
    const run = database.createRun(thread.id, runId, 'compression')
    const modelContent = 'Here is a summary of the conversation to date:\n\nRecovered summary'
    const compress = vi.fn(async () => ({
      summaryText: 'Recovered summary',
      modelContent,
      cutoffIndex: 1,
      activatedAfterMessageIndex: 0,
      coveredThroughMessageId: 'compression-history',
      inputTokensBefore: 80,
      inputTokensAfter: 30,
      stateEvent: {
        cutoffIndex: 1,
        summaryMessage: new HumanMessage({
          content: modelContent,
          additional_kwargs: { lc_source: 'summarization' }
        }),
        filePath: null
      }
    }))
    const contextRuntime = {
      status: async () => contextRuntime.statusFromMessages(),
      projectedStatus: async () => contextRuntime.statusFromMessages(),
      statusFromMessages: () => ({
        modelConfigId: 'model-test',
        estimatedInputTokens: 30,
        currentContextTokens: 30,
        maxContextTokens: 100,
        maxOutputTokens: 10,
        inputCapacityTokens: 90,
        compressionEnabled: true,
        compressionThreshold: 0.8,
        compressionThresholdTokens: 70,
        compressionApplied: true,
        manualCompressionAvailable: false,
        breakdown: {
          profileTokens: 0,
          systemInstructionTokens: 0,
          runtimeContextTokens: 0,
          workspaceTokens: 0,
          memoryTokens: 0,
          skillTokens: 0,
          toolDefinitionTokens: 0,
          messageTokens: 30,
          attachmentTokens: 0
        }
      }),
      compress
    }
    let summaryId: string | undefined
    const callbacks = {
      onCompressionStart: () => {
        const summary = database!.recordContextSummaryStarted(run.id)
        summaryId = summary.id
        return summary.id
      },
      onCompressionCompleted: (id: string, summaryText: string) => {
        database!.stageContextSummary(run.id, id, {
          summaryText,
          modelContent,
          cutoffIndex: 1,
          activatedAfterMessageIndex: 0,
          coveredThroughMessageId: 'compression-history',
          inputTokensBefore: 80,
          inputTokensAfter: 30
        })
      },
      onCompressionFailed: (id: string) => database!.deleteContextSummary(run.id, id)
    }
    const compressionAgent = createDeepAgent({
      model,
      checkpointer: database.checkpointer,
      middleware: [
        createAgentRunLifecycleMiddleware(run.id),
        createManualContextCompressionMiddleware({
          context: contextRuntime,
          callbacks,
          runId: run.id
        }),
        modelObserver
      ]
    })
    const originalPutWrites = database.checkpointer.putWrites.bind(database.checkpointer)
    const originalPut = database.checkpointer.put.bind(database.checkpointer)
    let compressionWritesPersisted = false
    let injected = false
    database.checkpointer.putWrites = async (checkpointConfig, writes, taskId) => {
      const result = await originalPutWrites(checkpointConfig, writes, taskId)
      if (writes.some(([channel]) => channel === '_summarizationEvent')) {
        compressionWritesPersisted = true
      }
      return result
    }
    database.checkpointer.put = async (checkpointConfig, checkpoint, metadata) => {
      if (compressionWritesPersisted && !injected) {
        injected = true
        throw new Error('Simulated checkpoint put failure.')
      }
      return originalPut(checkpointConfig, checkpoint, metadata)
    }
    await expect(compressionAgent.invoke(
      manualContextCompressionInput(run.id) as never,
      config
    )).rejects.toThrow('Simulated checkpoint put failure.')
    expect(injected).toBe(true)
    expect(summaryId).toEqual(expect.any(String))
    expect(compress).toHaveBeenCalledOnce()
    expect(modelCall).not.toHaveBeenCalled()
    expect(database.getRunCheckpointState(run.id)).toMatchObject({
      lastCommittedCheckpointId: expect.any(String),
      lastWriteCheckpointId: expect.any(String),
      terminalCheckpointId: undefined
    })
    const failedTuple = await database.checkpointer.getTuple(config)
    const persistedSummary = failedTuple?.checkpoint.channel_values._summarizationEvent
      ?? failedTuple?.pendingWrites?.find(([, channel]) => channel === '_summarizationEvent')?.[2]
    expect(persistedSummary).toMatchObject({
      cutoffIndex: 1,
      summaryMessage: expect.objectContaining({ content: modelContent })
    })
    expect(database.listRecoverableRuns().map((candidate) => candidate.id)).toEqual([run.id])
    database.close()

    database = AgentDatabase.open(location.file, location.attachments)
    const cleanupFileEdits = vi.fn(async () => {})
    let recoveryAgent: ReturnType<typeof createDeepAgent> | undefined
    const runtime = new AgentRuntime(database, async (_thread, _target, context) => {
      if (!context?.requestId) throw new Error('Recovery requires the original run ID.')
      const runContext = context
      recoveryAgent = createDeepAgent({
        model,
        checkpointer: database!.checkpointer,
        middleware: [
          createAgentRunLifecycleMiddleware(runContext.requestId),
          createManualContextCompressionMiddleware({
            context: contextRuntime,
            callbacks: runContext,
            runId: runContext.requestId
          }),
          modelObserver
        ]
      })
      return {
        agent: recoveryAgent as never,
        context: contextRuntime,
        dispose: async () => {}
      }
    }, undefined, cleanupFileEdits)
    const recovery = runtime.recoverRun(thread.id)
    if (!recovery) throw new Error('Expected the compression run to be recoverable.')
    const events = await collect(recovery)

    expect(compress).toHaveBeenCalledOnce()
    expect(modelCall).not.toHaveBeenCalled()
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'context_compression_completed',
        summary: expect.objectContaining({ id: summaryId, status: 'completed' })
      }),
      expect.objectContaining({
        type: 'run_completed',
        run: expect.objectContaining({
          id: run.id,
          operation: 'compression',
          status: 'completed'
        })
      })
    ]))
    expect(database.contextSummariesThroughRun(thread.id, run.id)).toEqual([
      expect.objectContaining({
        id: summaryId,
        status: 'completed',
        committedCheckpointId: expect.any(String)
      })
    ])
    expect(database.getRunCheckpointState(run.id)).toMatchObject({
      terminalCheckpointId: expect.any(String)
    })
    const recoveredState = await recoveryAgent!.getState(config) as StateSnapshot
    expect(recoveredState.next).toEqual([])
    expect(cleanupFileEdits).toHaveBeenCalledWith(run.id)
    expect(database.listFileEditCleanupRunIds()).toEqual([])
  })

  it('drains cleanup queued by terminal-checkpoint startup recovery', async () => {
    const location = temporaryDatabase()
    database = AgentDatabase.open(location.file, location.attachments)
    const thread = database.createThread({ title: 'Recovered terminal cleanup' })
    const run = database.createRun(thread.id, randomUUID())
    const checkpoint = {
      v: 4,
      id: 'terminal-cleanup-checkpoint',
      ts: new Date().toISOString(),
      channel_values: {
        anasRunLifecycle: { runId: run.id, status: 'completed' as const }
      },
      channel_versions: {},
      versions_seen: {}
    }
    const metadata: CheckpointMetadata = { source: 'loop', step: 1, parents: {} }
    await database.checkpointer.put({
      configurable: { thread_id: thread.id, checkpoint_ns: '' }
    }, checkpoint, metadata)
    database.close()

    database = AgentDatabase.open(location.file, location.attachments)
    expect(database.getRun(run.id)?.status).toBe('completed')
    expect(database.listFileEditCleanupRunIds()).toEqual([run.id])
    const cleanupFileEdits = vi.fn(async () => {})
    const runtime = new AgentRuntime(database, async () => {
      throw new Error('Terminal cleanup must not instantiate an agent.')
    }, undefined, cleanupFileEdits)

    await runtime.shutdown()

    expect(cleanupFileEdits).toHaveBeenCalledOnce()
    expect(cleanupFileEdits).toHaveBeenCalledWith(run.id)
    expect(database.listFileEditCleanupRunIds()).toEqual([])
  })

  it('retains failed cleanup after run metadata deletion and retries it on restart', async () => {
    const location = temporaryDatabase()
    database = AgentDatabase.open(location.file, location.attachments)
    const thread = database.createThread({ title: 'Durable cleanup retry' })
    const run = database.createRun(thread.id, randomUUID())
    await database.checkpointer.put({
      configurable: { thread_id: thread.id, checkpoint_ns: '' }
    }, {
      v: 4,
      id: 'cleanup-retry-terminal',
      ts: new Date().toISOString(),
      channel_values: {
        anasRunLifecycle: { runId: run.id, status: 'completed' as const }
      },
      channel_versions: {},
      versions_seen: {}
    }, {
      source: 'loop',
      step: 1,
      parents: {}
    })
    database.finishRun(run.id, 'completed')
    await database.deleteThread(thread.id)
    expect(database.getRun(run.id)).toBeNull()
    expect(database.listFileEditCleanupRunIds()).toEqual([run.id])
    const failedCleanup = vi.fn(async () => {
      throw new Error('File system is temporarily unavailable.')
    })
    const firstRuntime = new AgentRuntime(database, async () => {
      throw new Error('Cleanup retry must not instantiate an agent.')
    }, undefined, failedCleanup)

    await firstRuntime.shutdown()

    expect(database.listFileEditCleanupRunIds()).toEqual([run.id])
    expect(runtimeLogMock).toHaveBeenCalledWith(
      'warn',
      'agent',
      'Failed to clean file edit records.',
      { runId: run.id, error: 'File system is temporarily unavailable.' }
    )
    database.close()

    database = AgentDatabase.open(location.file, location.attachments)
    const successfulCleanup = vi.fn(async () => {})
    const secondRuntime = new AgentRuntime(database, async () => {
      throw new Error('Cleanup retry must not instantiate an agent.')
    }, undefined, successfulCleanup)
    await secondRuntime.shutdown()

    expect(successfulCleanup).toHaveBeenCalledWith(run.id)
    expect(database.listFileEditCleanupRunIds()).toEqual([])
  })
})
