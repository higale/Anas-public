import Database from 'better-sqlite3'
import { HumanMessage } from '@langchain/core/messages'
import { CurrentStateSqliteSaver } from './currentStateSqliteSaver'
import type { ProtocolEvent, StateSnapshot } from '@langchain/langgraph'
import { createDeepAgent } from 'deepagents'
import { createMiddleware, FakeToolCallingModel } from 'langchain'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CompressionTrackingCallbacks } from './compressionTracking'
import type { AgentContextRuntime, ManualContextCompression } from './contextRuntime'
import {
  createManualContextCompressionMiddleware,
  manualContextCompressionInput,
  manualContextCompressionRequestStateKey
} from './manualCompressionMiddleware'
import {
  createAgentRunLifecycleMiddleware,
  type AgentRunLifecycleState
} from './runLifecycleMiddleware'

const temporaryRoots: string[] = []

type StateReader = {
  getState(config: {
    configurable: { thread_id: string }
  }): Promise<StateSnapshot>
}

function temporaryDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), 'anas-manual-compression-graph-'))
  temporaryRoots.push(root)
  return join(root, 'checkpoints.sqlite')
}

function createCompressionAgent(options: {
  callbacks: CompressionTrackingCallbacks
  checkpointer: CurrentStateSqliteSaver
  context: AgentContextRuntime
  modelCall: () => void
  runId: string
}) {
  const modelObserver = createMiddleware({
    name: 'ManualCompressionModelObserver',
    wrapModelCall: async (request, handler) => {
      options.modelCall()
      return handler(request)
    }
  })
  return createDeepAgent({
    model: new FakeToolCallingModel({ toolCalls: [[]] }),
    checkpointer: options.checkpointer,
    middleware: [
      createAgentRunLifecycleMiddleware(options.runId),
      createManualContextCompressionMiddleware({
        context: options.context,
        callbacks: options.callbacks,
        runId: options.runId
      }),
      modelObserver
    ]
  })
}

function compressionResult(): ManualContextCompression {
  const summaryText = 'Condensed history'
  return {
    summaryText,
    modelContent: `Here is a summary of the conversation to date:\n\n${summaryText}`,
    cutoffIndex: 1,
    activatedAfterMessageIndex: 0,
    coveredThroughMessageId: 'manual-source',
    inputTokensBefore: 80,
    inputTokensAfter: 20,
    stateEvent: {
      cutoffIndex: 1,
      filePath: null,
      summaryMessage: new HumanMessage({
        id: 'manual-summary-message',
        content: `Here is a summary of the conversation to date:\n\n${summaryText}`,
        additional_kwargs: { lc_source: 'summarization' }
      })
    }
  }
}

function compressionContext(
  compress: AgentContextRuntime['compress']
): AgentContextRuntime {
  return { compress } as AgentContextRuntime
}

function sourceMessages(): HumanMessage[] {
  return [new HumanMessage({ id: 'manual-source', content: 'Source history' })]
}

function callbacksForSummary(summaryId: string) {
  return {
    onCompressionStart: vi.fn(() => summaryId),
    onCompressionCompleted: vi.fn<
      NonNullable<CompressionTrackingCallbacks['onCompressionCompleted']>
    >(),
    onCompressionFailed: vi.fn<
      NonNullable<CompressionTrackingCallbacks['onCompressionFailed']>
    >()
  }
}

function graphCompressionInput(runId: string): never {
  return manualContextCompressionInput(runId) as never
}

function expectedSummaryEvent(summaryId: string) {
  return {
    cutoffIndex: 1,
    filePath: null,
    summaryMessage: {
      additional_kwargs: {
        anas_summary_id: summaryId
      }
    }
  }
}

function eventRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : undefined
}

async function collectEvents(events: AsyncIterable<ProtocolEvent>): Promise<ProtocolEvent[]> {
  const collected: ProtocolEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

describe('graph-native manual compression recovery', () => {
  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('jumps from beforeAgent to afterAgent without a model call and emits the terminal v3 pair', async () => {
    const connection = new Database(':memory:')
    try {
      const checkpointer = new CurrentStateSqliteSaver(connection)
      const summaryId = 'summary-success'
      const compress = vi.fn(async () => compressionResult())
      const callbacks = callbacksForSummary(summaryId)
      const modelCall = vi.fn()
      const runId = 'manual-compression-success'
      const agent = createCompressionAgent({
        callbacks,
        checkpointer,
        context: compressionContext(compress),
        modelCall,
        runId
      })
      const config = {
        version: 'v3' as const,
        configurable: { thread_id: 'manual-compression-success-thread' },
        durability: 'sync' as const
      }
      await agent.updateState(config, { messages: sourceMessages() })

      const stream = await agent.streamEvents(graphCompressionInput(runId), config)
      const [events] = await Promise.all([collectEvents(stream), stream.output])
      const state = await (agent as unknown as StateReader).getState(config)

      expect(compress).toHaveBeenCalledOnce()
      expect(callbacks.onCompressionStart).toHaveBeenCalledOnce()
      expect(callbacks.onCompressionCompleted).toHaveBeenCalledOnce()
      expect(callbacks.onCompressionFailed).not.toHaveBeenCalled()
      expect(callbacks.onCompressionCompleted).toHaveBeenCalledWith(
        summaryId,
        'Condensed history',
        expect.objectContaining({
          modelContent: 'Here is a summary of the conversation to date:\n\nCondensed history',
          messages: expect.arrayContaining([
            expect.objectContaining({ id: 'manual-source' })
          ])
        })
      )
      expect(modelCall).not.toHaveBeenCalled()
      expect(state.values).toMatchObject({
        _summarizationEvent: expectedSummaryEvent(summaryId),
        anasRunLifecycle: { runId, status: 'completed' }
      })
      expect(state.values[manualContextCompressionRequestStateKey]).toBeNull()
      expect(state.next).toEqual([])
      expect(state.tasks).toEqual([])

      const terminalCheckpointId = state.config.configurable?.checkpoint_id
      const rootEvents = events.filter((event) => event.params.namespace.length === 0)
      const checkpointIndex = rootEvents.findIndex((event) =>
        event.method === 'checkpoints'
        && eventRecord(event.params.data)?.id === terminalCheckpointId
      )
      expect(checkpointIndex).toBeGreaterThanOrEqual(0)
      const terminalValues = rootEvents.slice(checkpointIndex + 1).find((event) =>
        event.method === 'values'
      )
      expect(terminalValues?.params.data).toMatchObject({
        anasRunLifecycle: { runId, status: 'completed' }
      })
    } finally {
      connection.close()
    }
  })

  it('continues committed compression after reopen without repeating generation', async () => {
    const file = temporaryDatabase()
    const threadId = 'manual-compression-recovery-thread'
    const runId = 'manual-compression-recovery'
    const summaryId = 'summary-recovery'
    const config = {
      configurable: { thread_id: threadId },
      durability: 'sync' as const
    }
    const compress = vi.fn(async () => compressionResult())
    const callbacks = callbacksForSummary(summaryId)
    const modelCall = vi.fn()

    const firstConnection = new Database(file)
    const firstSaver = new CurrentStateSqliteSaver(firstConnection)
    const originalPutWrites = firstSaver.putWrites.bind(firstSaver)
    const originalPut = firstSaver.put.bind(firstSaver)
    let compressionWritesPersisted = false
    let injected = false
    firstSaver.putWrites = async (checkpointConfig, writes, taskId) => {
      const result = await originalPutWrites(checkpointConfig, writes, taskId)
      if (writes.some(([channel]) => channel === '_summarizationEvent')) {
        compressionWritesPersisted = true
      }
      return result
    }
    firstSaver.put = async (checkpointConfig, checkpoint, metadata) => {
      if (compressionWritesPersisted && !injected) {
        injected = true
        throw new Error('Injected checkpoint put failure after compression writes.')
      }
      return originalPut(checkpointConfig, checkpoint, metadata)
    }
    const firstAgent = createCompressionAgent({
      callbacks,
      checkpointer: firstSaver,
      context: compressionContext(compress),
      modelCall,
      runId
    })
    await firstAgent.updateState(config, { messages: sourceMessages() })

    await expect(firstAgent.invoke(graphCompressionInput(runId), config)).rejects.toThrow(
      'Injected checkpoint put failure after compression writes.'
    )
    expect(injected).toBe(true)
    expect(compress).toHaveBeenCalledOnce()
    expect(callbacks.onCompressionStart).toHaveBeenCalledOnce()
    expect(callbacks.onCompressionCompleted).toHaveBeenCalledOnce()
    expect(callbacks.onCompressionFailed).not.toHaveBeenCalled()
    expect(modelCall).not.toHaveBeenCalled()
    const failedTuple = await firstSaver.getTuple(config)
    const committedSummary = failedTuple?.checkpoint.channel_values._summarizationEvent
      ?? failedTuple?.pendingWrites?.find(([, channel]) => channel === '_summarizationEvent')?.[2]
    expect(committedSummary).toMatchObject(expectedSummaryEvent(summaryId))
    firstConnection.close()

    const recoveryConnection = new Database(file)
    try {
      const recoverySaver = new CurrentStateSqliteSaver(recoveryConnection)
      const recoveryAgent = createCompressionAgent({
        callbacks,
        checkpointer: recoverySaver,
        context: compressionContext(compress),
        modelCall,
        runId
      })

      await recoveryAgent.invoke(null, config)
      const state = await (recoveryAgent as unknown as StateReader).getState(config)

      expect(compress).toHaveBeenCalledOnce()
      expect(callbacks.onCompressionStart).toHaveBeenCalledOnce()
      expect(callbacks.onCompressionCompleted).toHaveBeenCalledOnce()
      expect(callbacks.onCompressionFailed).not.toHaveBeenCalled()
      expect(modelCall).not.toHaveBeenCalled()
      expect(state.values).toMatchObject({
        _summarizationEvent: expectedSummaryEvent(summaryId),
        anasRunLifecycle: {
          runId,
          status: 'completed'
        } satisfies AgentRunLifecycleState
      })
      expect(state.values[manualContextCompressionRequestStateKey]).toBeNull()
      expect(state.next).toEqual([])
      expect(state.tasks).toEqual([])
      const terminalTuple = await recoverySaver.getTuple(config)
      expect(terminalTuple?.pendingWrites ?? []).toEqual([])
    } finally {
      recoveryConnection.close()
    }
  })

  it('clears a stale compression request and continues the current agent run', async () => {
    const connection = new Database(':memory:')
    try {
      const checkpointer = new CurrentStateSqliteSaver(connection)
      const runId = 'current-agent-run'
      const compress = vi.fn(async () => compressionResult())
      const callbacks = callbacksForSummary('unused-summary')
      const modelCall = vi.fn()
      const agent = createCompressionAgent({
        callbacks,
        checkpointer,
        context: compressionContext(compress),
        modelCall,
        runId
      })
      const config = {
        configurable: { thread_id: 'stale-compression-request-thread' },
        durability: 'sync' as const
      }
      await agent.updateState(config, { messages: sourceMessages() })

      await agent.invoke(graphCompressionInput('stale-compression-run'), config)
      const state = await (agent as unknown as StateReader).getState(config)

      expect(compress).not.toHaveBeenCalled()
      expect(callbacks.onCompressionStart).not.toHaveBeenCalled()
      expect(callbacks.onCompressionCompleted).not.toHaveBeenCalled()
      expect(callbacks.onCompressionFailed).not.toHaveBeenCalled()
      expect(modelCall).toHaveBeenCalledOnce()
      expect(state.values[manualContextCompressionRequestStateKey]).toBeNull()
      expect(state.values).toMatchObject({
        anasRunLifecycle: { runId, status: 'completed' }
      })
      expect(state.next).toEqual([])
      expect(state.tasks).toEqual([])
    } finally {
      connection.close()
    }
  })
})
