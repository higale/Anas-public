import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import {
  Command,
  END,
  MessagesAnnotation,
  START,
  StateGraph,
  type ExecutionInfo
} from '@langchain/langgraph'
import {
  createAgent,
  createMiddleware,
  FakeToolCallingModel,
  type ToolCallHandler,
  type ToolCallRequest
} from 'langchain'
import { z } from 'zod/v3'
import { describe, expect, it } from 'vitest'
import { builtinToolCatalog } from '@shared/toolRegistry'
import {
  AgentDatabase,
  type AgentToolEffectKey,
  type AgentToolEffectPreparation,
  type AgentToolEffectRecoveryMode
} from './agentDatabase'
import {
  builtinToolEffectPolicies,
  classifyAgentToolEffect
} from './toolEffectClassification'
import { commandShellMetadata } from '@shared/commandShell'
import {
  agentToolEffectWriteCheckpointNs,
  canonicalAgentToolEffectJson,
  createAgentToolEffectMiddleware
} from './toolEffectMiddleware'
import {
  armCurrentAgentToolEffect,
  agentToolEffectArtifactId,
  currentAgentToolEffectArtifactId,
  canRestartUnpublishedEffectArtifact,
  hasCurrentAgentToolEffectScope
} from './toolEffectScope'
import { ManagedCallService } from './managedCallService'
import { withManagedToolExecution } from './managedToolExecution'
import { encodeManagedToolResult } from './managedToolResult'

function mcpTool(annotations?: Record<string, unknown>): StructuredToolInterface {
  return {
    metadata: { annotations }
  } as unknown as StructuredToolInterface
}

function observeEffectPreparations(
  database: AgentDatabase,
  preparations: AgentToolEffectPreparation[]
): AgentDatabase {
  return new Proxy(database, {
    get(target, property) {
      if (property === 'prepareToolEffect') {
        return (input: AgentToolEffectPreparation) => {
          preparations.push(input)
          return target.prepareToolEffect(input)
        }
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

function interrupts(output: unknown): Array<{
  id: string
  value: {
    actionRequests: Array<{
      name: string
      anasRecovery: { ordinal: number; state: string }
    }>
  }
}> {
  return (output as { __interrupt__?: never[] }).__interrupt__ ?? []
}

function outputText(output: unknown): string {
  const messages = (output as { messages?: Array<{ content?: unknown }> } | undefined)?.messages
  return (messages ?? []).map((message) =>
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
  ).join('\n')
}

type DirectToolCall = {
  id?: string
  name: string
  args: Record<string, unknown>
}

function effectExecution(
  threadId: string,
  checkpointId: string,
  taskId: string
): ExecutionInfo {
  return {
    threadId,
    checkpointId,
    checkpointNs: `tools:${taskId}`,
    taskId
  } as ExecutionInfo
}

function prepareDirectEffect(
  database: AgentDatabase,
  runId: string,
  threadId: string,
  execution: ExecutionInfo,
  call: DirectToolCall,
  callIndex: number,
  recoveryMode: AgentToolEffectRecoveryMode = 'confirm'
): AgentToolEffectKey {
  const argsJson = canonicalAgentToolEffectJson(call.args)
  const key: AgentToolEffectKey = {
    runId,
    checkpointId: execution.checkpointId,
    checkpointNs: execution.checkpointNs,
    taskId: execution.taskId,
    callKey: call.id ? `id:${call.id}` : `index:${callIndex}`,
    inputHash: createHash('sha256').update(argsJson).digest('hex')
  }
  database.prepareToolEffect({
    ...key,
    threadId,
    writeCheckpointNs: agentToolEffectWriteCheckpointNs(execution),
    callIndex,
    ...(call.id ? { toolCallId: call.id } : {}),
    toolName: call.name,
    argsJson,
    recoveryMode
  })
  return key
}

async function invokeDirectMiddleware(
  middleware: ReturnType<typeof createAgentToolEffectMiddleware>,
  execution: ExecutionInfo,
  request: ToolCallRequest,
  handler: ToolCallHandler
) {
  const wrapToolCall = middleware.wrapToolCall
  if (!wrapToolCall) throw new Error('Expected tool effect middleware wrapper.')
  return AsyncLocalStorageProviderSingleton.runWithConfig(
    { executionInfo: execution },
    () => wrapToolCall(request, handler)
  )
}

describe('agent tool effect classification', () => {
  it('keeps the builtin catalog exhaustive and excludes previews', () => {
    expect(Object.keys(builtinToolEffectPolicies).sort()).toEqual(
      builtinToolCatalog.map((entry) => entry.id).filter((name) => name !== 'run_shell').sort()
    )
    expect(classifyAgentToolEffect('read_file', { path: 'a' })).toBeUndefined()
    expect(classifyAgentToolEffect('write_call', { action: { type: 'text', text: 'yes\r' } })).toEqual({ recoveryMode: 'confirm' })
    expect(classifyAgentToolEffect('write_call', { action: { type: 'resize', columns: 100, rows: 30 } })).toEqual({ recoveryMode: 'idempotent' })
    expect(classifyAgentToolEffect('apply_patch', { dry_run: true })).toBeUndefined()
    expect(classifyAgentToolEffect('restore_file_edit', { dry_run: true })).toBeUndefined()
    expect(classifyAgentToolEffect('apply_patch', { dry_run: false })).toEqual({
      recoveryMode: 'confirm'
    })
  })

  it('classifies a concretely named command shell by stable tool metadata', () => {
    const shell = tool(async () => 'ok', {
      name: 'pwsh',
      description: 'Run PowerShell.',
      metadata: commandShellMetadata(),
      schema: z.object({ command: z.string() })
    })

    expect(classifyAgentToolEffect('pwsh', { command: 'Get-Date' }, shell))
      .toEqual({ recoveryMode: 'confirm' })
  })

  it('uses HTTP and MCP idempotency hints without treating missing MCP annotations as read-only', () => {
    expect(classifyAgentToolEffect('http_request', { url: 'https://example.test' }))
      .toBeUndefined()
    expect(classifyAgentToolEffect('http_request', {
      url: 'https://example.test',
      method: 'POST'
    })).toEqual({ recoveryMode: 'confirm' })
    expect(classifyAgentToolEffect('http_request', {
      url: 'https://example.test',
      method: 'POST',
      headers: { 'Idempotency-Key': 'request-1' }
    })).toEqual({ recoveryMode: 'idempotent' })

    expect(classifyAgentToolEffect('mcp_alpha_ping', {}, mcpTool()))
      .toEqual({ recoveryMode: 'confirm' })
    expect(classifyAgentToolEffect('mcp_alpha_read', {}, mcpTool({ readOnlyHint: true })))
      .toBeUndefined()
    expect(classifyAgentToolEffect('mcp_alpha_put', {}, mcpTool({ idempotentHint: true })))
      .toEqual({ recoveryMode: 'idempotent' })
  })

  it('rejects cyclic objects and arrays before they can become unstable keys', () => {
    const object: Record<string, unknown> = {}
    object.self = object
    const array: unknown[] = []
    array.push(array)
    expect(() => canonicalAgentToolEffectJson(object)).toThrow('must not contain cycles')
    expect(() => canonicalAgentToolEffectJson(array)).toThrow('must not contain cycles')
  })

  it('preserves prototype-named own properties in canonical identities', () => {
    const input = JSON.parse(
      '{"__proto__":{"resource":"A"},"constructor":"B","prototype":"C"}'
    ) as Record<string, unknown>
    const canonical = canonicalAgentToolEffectJson(input)
    expect(canonical).toBe(
      '{"__proto__":{"resource":"A"},"constructor":"B","prototype":"C"}'
    )
    expect(canonical).not.toBe(canonicalAgentToolEffectJson({}))
  })

  it('derives only the exact SqliteSaver parent write namespace', () => {
    expect(agentToolEffectWriteCheckpointNs({
      checkpointNs: 'tools:root-task',
      taskId: 'root-task'
    })).toBe('')
    expect(agentToolEffectWriteCheckpointNs({
      checkpointNs: 'child_agent:parent-task|tools:child-task',
      taskId: 'child-task'
    })).toBe('child_agent:parent-task')
    expect(() => agentToolEffectWriteCheckpointNs({
      checkpointNs: 'child_agent:parent-task|tools:different-task',
      taskId: 'child-task'
    })).toThrow('does not end with its task identity')
  })
})

describe('agent tool effect middleware', () => {
  it('derives stable version 8 artifact IDs from the durable effect key and purpose', async () => {
    expect(currentAgentToolEffectArtifactId('output')).toBeUndefined()
    const root = mkdtempSync(join(tmpdir(), 'anas-effect-artifact-id-'))
    const databaseFile = join(root, 'agent.sqlite')
    const attachmentsDirectory = join(root, 'attachments')
    let openDatabase: AgentDatabase | undefined
    try {
      openDatabase = AgentDatabase.open(databaseFile, attachmentsDirectory)
      const thread = openDatabase.createThread()
      const run = openDatabase.createRun(
        thread.id,
        'artifact-id-run',
        'agent',
        [],
        { kind: 'user', text: 'Derive the artifact identity.' }
      )
      const effect = tool(async () => 'unused', {
        name: 'pwsh',
        description: 'Artifact identity effect.',
        metadata: commandShellMetadata(),
        schema: z.object({ resource: z.string() })
      })
      const ai = new AIMessage({
        content: '',
        tool_calls: [{
          id: 'artifact-call-a',
          name: effect.name,
          args: { resource: 'A' }
        }]
      })
      const call = ai.tool_calls![0] as DirectToolCall
      const execution = effectExecution(
        thread.id,
        'artifact-checkpoint-a',
        'artifact-task-a'
      )
      const simulatedRestart = new Error('restart after the effect boundary')
      const request = {
        toolCall: call,
        tool: effect,
        state: { messages: [ai] },
        runtime: { interrupt: () => { throw simulatedRestart } }
      } as unknown as ToolCallRequest
      const firstMiddleware = createAgentToolEffectMiddleware({
        database: openDatabase,
        runId: run.id,
        threadId: thread.id,
        tools: [effect]
      })
      let firstId: string | undefined
      let repeatedId: string | undefined
      let otherPurposeId: string | undefined

      await expect(invokeDirectMiddleware(
        firstMiddleware,
        execution,
        request,
        async () => {
          firstId = currentAgentToolEffectArtifactId('output')
          repeatedId = currentAgentToolEffectArtifactId('output')
          otherPurposeId = currentAgentToolEffectArtifactId('preview')
          const fileId = currentAgentToolEffectArtifactId('file-edit')!
          expect(canRestartUnpublishedEffectArtifact(run.id, fileId, 'file-edit')).toBe(true)
          expect(canRestartUnpublishedEffectArtifact('other-run', fileId, 'file-edit')).toBe(false)
          for (const purpose of ['file_edit', 'file_restore']) {
            const patchId = currentAgentToolEffectArtifactId(purpose)!
            expect(canRestartUnpublishedEffectArtifact(run.id, patchId, purpose)).toBe(true)
            expect(canRestartUnpublishedEffectArtifact(run.id, patchId, 'other-purpose')).toBe(false)
          }
          armCurrentAgentToolEffect({
            kind: 'test_artifact',
            target: { resource: 'A' }
          })
          expect(canRestartUnpublishedEffectArtifact(run.id, fileId, 'file-edit')).toBe(false)
          expect(canRestartUnpublishedEffectArtifact(run.id, currentAgentToolEffectArtifactId('file_edit')!, 'file_edit')).toBe(false)
          throw new Error('result lost after external operation')
        }
      )).rejects.toBe(simulatedRestart)
      expect(firstId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      )
      expect(repeatedId).toBe(firstId)
      expect(otherPurposeId).not.toBe(firstId)

      openDatabase.close()
      openDatabase = undefined
      openDatabase = AgentDatabase.open(databaseFile, attachmentsDirectory)
      let restartedId: string | undefined
      const restartedRequest = {
        ...request,
        runtime: {
          interrupt: () => ({ decisions: [{ type: 'approve' }] })
        }
      } as unknown as ToolCallRequest
      const restartedMiddleware = createAgentToolEffectMiddleware({
        database: openDatabase,
        runId: run.id,
        threadId: thread.id,
        tools: [effect]
      })
      await invokeDirectMiddleware(restartedMiddleware, execution, restartedRequest, async () => {
        restartedId = currentAgentToolEffectArtifactId('output')
        expect(canRestartUnpublishedEffectArtifact(run.id, currentAgentToolEffectArtifactId('file-edit')!, 'file-edit')).toBe(false)
        expect(canRestartUnpublishedEffectArtifact(run.id, currentAgentToolEffectArtifactId('file_restore')!, 'file_restore')).toBe(false)
        armCurrentAgentToolEffect({
          kind: 'test_artifact',
          target: { resource: 'A' }
        })
        return new ToolMessage({ content: 'completed', tool_call_id: call.id! })
      })
      expect(restartedId).toBe(firstId)

      const otherAi = new AIMessage({
        content: '',
        tool_calls: [{
          id: 'artifact-call-b',
          name: effect.name,
          args: { resource: 'A' }
        }]
      })
      const otherCall = otherAi.tool_calls![0] as DirectToolCall
      const otherRequest = {
        toolCall: otherCall,
        tool: effect,
        state: { messages: [otherAi] },
        runtime: { interrupt: () => { throw new Error('unexpected recovery') } }
      } as unknown as ToolCallRequest
      let otherKeyId: string | undefined
      await invokeDirectMiddleware(
        restartedMiddleware,
        effectExecution(thread.id, 'artifact-checkpoint-b', 'artifact-task-b'),
        otherRequest,
        async () => {
          otherKeyId = currentAgentToolEffectArtifactId('output')
          armCurrentAgentToolEffect({
            kind: 'test_artifact',
            target: { resource: 'A' }
          })
          return new ToolMessage({ content: 'completed', tool_call_id: otherCall.id! })
        }
      )
      expect(otherKeyId).not.toBe(firstId)
      expect(currentAgentToolEffectArtifactId('output')).toBeUndefined()
    } finally {
      openDatabase?.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('recovers a completed fast shell artifact before confirm recovery after a crash', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-managed-effect-recovery-'))
    const databaseFile = join(root, 'agent.sqlite')
    const attachmentsDirectory = join(root, 'attachments')
    let database: AgentDatabase | undefined
    try {
      database = AgentDatabase.open(databaseFile, attachmentsDirectory)
      const thread = database.createThread()
      const run = database.createRun(
        thread.id,
        'managed-effect-recovery-run',
        'agent',
        [],
        { kind: 'user', text: 'Recover the completed shell result.' }
      )
      const execution = effectExecution(
        thread.id,
        'managed-effect-recovery-checkpoint',
        'managed-effect-recovery-task'
      )
      const effect = tool(async () => 'must not run', {
        name: 'pwsh',
        description: 'Recover one completed shell operation.',
        metadata: commandShellMetadata(),
        schema: z.object({ command: z.string() })
      })
      const ai = new AIMessage({
        content: '',
        tool_calls: [{
          id: 'managed-effect-recovery-call',
          name: effect.name,
          args: { command: 'Get-Date' }
        }]
      })
      const call = ai.tool_calls![0] as DirectToolCall
      const key = prepareDirectEffect(database, run.id, thread.id, execution, call, 0)
      database.armToolEffect(key, {
        effectKind: 'process_spawn',
        targetJson: '{"command":"Get-Date"}'
      })
      const callId = agentToolEffectArtifactId(key, 'managed-call')
      database.createManagedCall({
        id: callId,
        threadId: thread.id,
        runId: run.id,
        kind: 'shell',
        summary: 'Get-Date'
      })
      database.markManagedCallRunning(callId, thread.id)
      database.finishManagedCall({
        callId,
        threadId: thread.id,
        status: 'completed',
        result: await encodeManagedToolResult(database, new ToolMessage({
          content: 'durable fast shell result',
          name: effect.name,
          tool_call_id: call.id!,
          status: 'success',
          artifact: { durable: true }
        }), { threadId: thread.id, runId: run.id }),
        outcome: { result_format: 'langchain' }
      })
      database.close()
      database = undefined

      database = AgentDatabase.open(databaseFile, attachmentsDirectory)
      const middleware = createAgentToolEffectMiddleware({
        database,
        runId: run.id,
        threadId: thread.id,
        tools: [effect]
      })
      let interruptCalls = 0
      let handlerCalls = 0
      const request = {
        toolCall: call,
        tool: effect,
        state: { messages: [ai] },
        runtime: {
          interrupt: () => {
            interruptCalls += 1
            throw new Error('Completed managed artifacts must not request recovery approval.')
          }
        }
      } as unknown as ToolCallRequest

      const result = await invokeDirectMiddleware(middleware, execution, request, async () => {
        handlerCalls += 1
        return new ToolMessage({ content: 'wrong', tool_call_id: call.id! })
      })

      expect(interruptCalls).toBe(0)
      expect(handlerCalls).toBe(0)
      if (!ToolMessage.isInstance(result)) throw new Error('Expected a recovered ToolMessage.')
      expect(result).toMatchObject({
        content: 'durable fast shell result',
        artifact: { durable: true },
        name: effect.name,
        tool_call_id: call.id,
        status: 'success'
      })
      expect(database.loadToolEffect(key)).toMatchObject({ state: 'result' })
      expect(database.getManagedCall(callId, thread.id)).toBeUndefined()
    } finally {
      database?.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each([
    { state: 'prepared', status: 'cancelled' },
    { state: 'intent', status: 'completed' }
  ] as const)('recovers a queued $state journal from its $status managed artifact without executing again', async ({ state, status }) => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, `queued-${state}-run`)
      const execution = effectExecution(thread.id, 'queued-checkpoint', 'queued-task')
      let executions = 0
      const native = tool(async () => { executions++; return 'duplicate' }, {
        name: 'mcp_write', description: 'Write', schema: z.object({})
      })
      const service = new ManagedCallService(database)
      const managed = withManagedToolExecution(native, { database, service, threadId: thread.id, runId: run.id, allowBackground: true })
      const ai = new AIMessage({ content: '', tool_calls: [{ id: 'queued', name: native.name, args: {} }] })
      const call = ai.tool_calls![0] as DirectToolCall
      const key = prepareDirectEffect(database, run.id, thread.id, execution, call, 0)
      if (state === 'intent') database.armToolEffect(key, { effectKind: 'mcp_call', targetJson: '{}' })
      const callId = agentToolEffectArtifactId(key, 'managed-call')
      database.createManagedCall({ id: callId, threadId: thread.id, runId: run.id, kind: 'mcp', summary: 'Write' })
      database.markManagedCallDetached(callId, thread.id)
      if (state === 'intent') database.markManagedCallRunning(callId, thread.id)
      database.finishManagedCall({ callId, threadId: thread.id, status, result: 'confirmed result' })
      const middleware = createAgentToolEffectMiddleware({ database, runId: run.id, threadId: thread.id, tools: [managed] })
      const request = { toolCall: call, tool: managed, state: { messages: [ai] },
        runtime: { interrupt: () => { throw new Error('Unexpected recovery approval') } }
      } as unknown as ToolCallRequest
      const result = await invokeDirectMiddleware(middleware, execution, request,
        async () => managed.invoke({ type: 'tool_call', ...call }) as Promise<ToolMessage>)
      expect(executions).toBe(0)
      expect(ToolMessage.isInstance(result) && JSON.parse(String(result.content))).toMatchObject({ call_id: callId, status })
      expect(database.loadToolEffect(key)?.state).toBe('result')
    } finally { database.close() }
  })

  it.each(['missing', 'not-detached', 'preparing', 'wrong-owner', 'registered', 'approved-retry'] as const)(
    'allows an interrupted run to arm only its registered background executor: %s', async scenario => {
      const database = AgentDatabase.open(':memory:')
      try {
        const thread = database.createThread()
        const run = database.createRun(thread.id, `interrupted-${scenario}`)
        const execution = effectExecution(thread.id, 'effect-checkpoint', 'effect-task')
        const call = { id: 'effect', name: 'mcp_write', args: {} }
        const key = prepareDirectEffect(database, run.id, thread.id, execution, call, 0)
        const effect = { effectKind: 'mcp_call', targetJson: '{}' }
        if (scenario === 'approved-retry') {
          database.armToolEffect(key, effect)
          database.retryToolEffect(key, { kind: 'approved', expectedConfirmationCount: 0 })
        }
        if (scenario !== 'missing') {
          const ownerThread = scenario === 'wrong-owner' ? database.createThread() : thread
          const ownerRun = scenario === 'wrong-owner' ? database.createRun(ownerThread.id, 'other-owner') : run
          const callId = agentToolEffectArtifactId(key, 'managed-call')
          database.createManagedCall({ id: callId, threadId: ownerThread.id, runId: ownerRun.id, kind: 'mcp', summary: 'Write' })
          if (scenario !== 'preparing') database.markManagedCallRunning(callId, ownerThread.id)
          if (scenario !== 'not-detached') database.markManagedCallDetached(callId, ownerThread.id)
        }
        const config = { configurable: { thread_id: thread.id, checkpoint_ns: '', checkpoint_id: 'interrupted-checkpoint' } }
        await database.checkpointer.put(config, { v: 4, id: 'interrupted-checkpoint', ts: new Date().toISOString(),
          channel_values: { anasRunLifecycle: { runId: run.id, status: 'running' } }, channel_versions: {}, versions_seen: {}
        }, { source: 'update', step: 0, parents: {} })
        await database.checkpointer.putWrites(config, [['__interrupt__', [{ id: 'ask', value: {} }]]], 'ask-task')
        database.finishRun(run.id, 'interrupted')
        if (scenario === 'registered' || scenario === 'approved-retry') {
          expect(database.armToolEffect(key, effect)).toMatchObject({ state: 'intent', effectAttempt: scenario === 'registered' ? 1 : 2 })
          expect(() => database.retryToolEffect(key, { kind: 'approved', expectedConfirmationCount: scenario === 'registered' ? 0 : 1 })).toThrow('is not running')
        } else {
          expect(() => database.armToolEffect(key, effect)).toThrow('is not running')
        }
        expect(() => prepareDirectEffect(database, run.id, thread.id, execution, { ...call, id: 'new' }, 1)).toThrow('is not running')
      } finally { database.close() }
    }
  )

  it.each([
    { status: 'completed' as const, expected: 'handle' as const },
    { status: 'running' as const, expected: 'live' as const },
    { status: 'uncertain' as const, expected: 'recovery' as const }
  ])('keeps a detached $status artifact in the supervision flow', async ({ status, expected }) => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, `managed-detached-${status}-run`)
      const execution = effectExecution(
        thread.id,
        `managed-detached-${status}-checkpoint`,
        `managed-detached-${status}-task`
      )
      const effect = tool(async () => 'must not run', {
        name: 'pwsh',
        description: 'Recover one detached shell operation.',
        metadata: commandShellMetadata(),
        schema: z.object({ command: z.string() })
      })
      const ai = new AIMessage({
        content: '',
        tool_calls: [{
          id: `managed-detached-${status}-call`,
          name: effect.name,
          args: { command: 'Get-Date' }
        }]
      })
      const call = ai.tool_calls![0] as DirectToolCall
      const key = prepareDirectEffect(database, run.id, thread.id, execution, call, 0)
      database.armToolEffect(key, {
        effectKind: 'process_spawn',
        targetJson: '{"command":"Get-Date"}'
      })
      const callId = agentToolEffectArtifactId(key, 'managed-call')
      database.createManagedCall({
        id: callId,
        threadId: thread.id,
        runId: run.id,
        kind: 'shell',
        summary: 'Get-Date'
      })
      database.markManagedCallRunning(callId, thread.id)
      database.markManagedCallDetached(callId, thread.id)
      if (status !== 'running') database.finishManagedCall({
        callId,
        threadId: thread.id,
        status,
        ...(status === 'completed'
          ? { result: 'detached shell result' }
          : { error: 'The shell outcome is unknown.' })
      })
      const middleware = createAgentToolEffectMiddleware({
        database,
        runId: run.id,
        threadId: thread.id,
        tools: [effect]
      })
      const stopped = new Error('expected uncertain-effect recovery')
      let interruptCalls = 0
      let handlerCalls = 0
      const request = {
        toolCall: call,
        tool: effect,
        state: { messages: [ai] },
        runtime: {
          interrupt: () => {
            interruptCalls += 1
            throw stopped
          }
        }
      } as unknown as ToolCallRequest
      const invoke = () => invokeDirectMiddleware(middleware, execution, request, async () => {
        handlerCalls += 1
        return new ToolMessage({ content: 'wrong', tool_call_id: call.id! })
      })

      if (expected === 'recovery') {
        await expect(invoke()).rejects.toBe(stopped)
        expect(interruptCalls).toBe(1)
        expect(database.loadToolEffect(key)).toMatchObject({ state: 'intent' })
      } else {
        const result = await invoke()
        expect(interruptCalls).toBe(0)
        if (!ToolMessage.isInstance(result)) throw new Error('Expected a managed call handle.')
        expect(JSON.parse(result.content as string)).toMatchObject({
          call_id: callId,
          status
        })
        expect(database.loadToolEffect(key)).toMatchObject({ state: expected === 'live' ? 'intent' : 'result' })
      }
      expect(handlerCalls).toBe(0)
      expect(database.getManagedCall(callId, thread.id)).toMatchObject({
        id: callId,
        status,
        detachedAt: expect.any(String)
      })
    } finally {
      database.close()
    }
  })

  it('removes an inline managed artifact immediately after its normal journal result commits', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'managed-effect-cleanup-run')
      const execution = effectExecution(
        thread.id,
        'managed-effect-cleanup-checkpoint',
        'managed-effect-cleanup-task'
      )
      const effect = tool(async () => 'unused', {
        name: 'pwsh',
        description: 'Run one fast shell operation.',
        metadata: commandShellMetadata(),
        schema: z.object({ command: z.string() })
      })
      const ai = new AIMessage({
        content: '',
        tool_calls: [{
          id: 'managed-effect-cleanup-call',
          name: effect.name,
          args: { command: 'Get-Date' }
        }]
      })
      const call = ai.tool_calls![0] as DirectToolCall
      const key = prepareDirectEffect(database, run.id, thread.id, execution, call, 0)
      const middleware = createAgentToolEffectMiddleware({
        database,
        runId: run.id,
        threadId: thread.id,
        tools: [effect]
      })
      const service = new ManagedCallService(database)
      let callId: string | undefined
      const request = {
        toolCall: call,
        tool: effect,
        state: { messages: [ai] },
        runtime: { interrupt: () => { throw new Error('Unexpected recovery approval.') } }
      } as unknown as ToolCallRequest

      const result = await invokeDirectMiddleware(middleware, execution, request, async () => {
        const content = await service.start({
          kind: 'shell',
          threadId: thread.id,
          runId: run.id,
          summary: 'Get-Date',
          execute: async (control) => {
            callId = currentAgentToolEffectArtifactId('managed-call')
            armCurrentAgentToolEffect({
              kind: 'process_spawn',
              target: { command: 'Get-Date' }
            })
            control.markRunning()
            return 'normal fast shell result'
          }
        })
        return new ToolMessage({
          content,
          name: effect.name,
          tool_call_id: call.id!
        })
      })

      expect(callId).toBe(agentToolEffectArtifactId(key, 'managed-call'))
      if (!ToolMessage.isInstance(result)) throw new Error('Expected a ToolMessage result.')
      expect(result.content).toBe('normal fast shell result')
      expect(database.loadToolEffect(key)).toMatchObject({ state: 'result' })
      expect(database.getManagedCall(callId!, thread.id)).toBeUndefined()
    } finally {
      database.close()
    }
  })

  it.each(['first', 'second'])('handles asynchronous preflight before the %s parallel effect', async (delayed) => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, `async-preflight-${delayed}`)
      const effects: string[] = []
      const preparations: AgentToolEffectPreparation[] = []
      const tools = ['save_to_memory', 'apply_patch'].map((name, index) => tool(async () => {
        armCurrentAgentToolEffect({ kind: 'fixture', target: { name } })
        effects.push(name)
        await new Promise((resolve) => setTimeout(resolve, 80))
        return `completed ${index}`
      }, { name, description: 'Independent fixture effect.', schema: z.object({}) }))
      const agent = createAgent({
        model: new FakeToolCallingModel({ toolCalls: [[
          { id: 'first', name: tools[0].name, args: {} },
          { id: 'second', name: tools[1].name, args: {} }
        ], []] }),
        tools, checkpointer: database.checkpointer,
        middleware: [
          createMiddleware({ name: 'AsyncPathPreflightFixture', wrapToolCall: async (request, handler) => {
            if (request.toolCall.id === delayed) await new Promise((resolve) => setTimeout(resolve, 30))
            return handler(request)
          } }),
          createAgentToolEffectMiddleware({ database: observeEffectPreparations(database, preparations),
            runId: run.id, threadId: thread.id, tools })
        ]
      })
      const result = await agent.invoke({ messages: [new HumanMessage('Perform both independent effects.')] }, {
        configurable: { thread_id: thread.id }, durability: 'sync'
      })
      expect(interrupts(result)).toEqual([])
      expect(effects.sort()).toEqual(tools.map((tool) => tool.name).sort())
      expect(new Set(preparations.map((entry) => entry.taskId)).size).toBe(2)
      const persisted = await database.checkpointer.getTuple({ configurable: { thread_id: thread.id, checkpoint_ns: '' } })
      const messages = persisted!.checkpoint.channel_values.messages as unknown[]
      expect(messages.filter(ToolMessage.isInstance).map((message) => message.tool_call_id).sort())
        .toEqual(['first', 'second'])
      expect(preparations.every((entry) => database.loadToolEffect(entry) === undefined)).toBe(true)
    } finally {
      database.close()
    }
  })

  it('lets native parallel tasks interrupt and resume independently without replaying completed siblings', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'parallel-effect-run')
      const effects: string[] = []
      const preparations: AgentToolEffectPreparation[] = []
      const journalDatabase = observeEffectPreparations(database, preparations)
      let firstAttempts = 0
      let secondAttempts = 0

      const first = tool(async () => {
        armCurrentAgentToolEffect({
          kind: 'test_process',
          target: { tool: 'first' }
        })
        firstAttempts += 1
        effects.push(`first:${firstAttempts}`)
        if (firstAttempts === 1) throw new Error('result was lost after the first effect')
        return 'first completed'
      }, {
        name: 'pwsh',
        description: 'First effect.',
        metadata: commandShellMetadata(),
        schema: z.object({})
      })
      const second = tool(async () => {
        armCurrentAgentToolEffect({
          kind: 'test_process',
          target: { tool: 'second' }
        })
        secondAttempts += 1
        effects.push(`second:${secondAttempts}`)
        if (secondAttempts === 1) throw new Error('result was lost after the second effect')
        return 'second completed'
      }, {
        name: 'save_to_memory',
        description: 'Second effect.',
        schema: z.object({})
      })
      const model = new FakeToolCallingModel({
        toolCalls: [[
          { id: 'first-call', name: first.name, args: {} },
          { id: 'second-call', name: second.name, args: {} }
        ], []]
      })
      const agent = createAgent({
        model,
        tools: [first, second],
        checkpointer: database.checkpointer,
        middleware: [createAgentToolEffectMiddleware({
          database: journalDatabase,
          runId: run.id,
          threadId: thread.id,
          tools: [first, second]
        })]
      })
      const config = {
        configurable: { thread_id: thread.id },
        durability: 'sync' as const
      }

      const stopped = await agent.invoke({
        messages: [new HumanMessage('Run both effects.')]
      }, config)
      const pending = interrupts(stopped)
      expect(firstAttempts).toBe(1)
      expect(secondAttempts).toBe(1)
      expect(new Set(pending.map((entry) => entry.id)).size).toBe(2)
      expect(new Set(preparations.map((entry) => entry.taskId)).size).toBe(2)
      expect(preparations.every((entry) => entry.writeCheckpointNs === '')).toBe(true)
      expect(pending.map((entry) => entry.value.actionRequests[0].name).sort()).toEqual(['pwsh', 'save_to_memory'])
      for (const entry of pending) expect(entry.value.actionRequests[0].anasRecovery).toEqual({ ordinal: 1, state: 'uncertain' })
      const firstPending = pending.find((entry) => entry.value.actionRequests[0].name === first.name)!
      const originalSecondPending = pending.find((entry) => entry.value.actionRequests[0].name === second.name)!

      const secondStopped = await agent.invoke(new Command({
        resume: {
          [firstPending.id]: { decisions: [{ type: 'approve' }] }
        }
      }), config)
      const secondPending = interrupts(secondStopped)
      expect(firstAttempts).toBe(2)
      expect(secondAttempts).toBe(1)
      expect(secondPending).toHaveLength(1)
      expect(secondPending[0].id).toBe(originalSecondPending.id)
      expect(secondPending[0].value.actionRequests[0]).toMatchObject({
        name: 'save_to_memory',
        anasRecovery: { ordinal: 1, state: 'uncertain' }
      })

      const completed = await agent.invoke(new Command({
        resume: {
          [secondPending[0].id]: { decisions: [{ type: 'approve' }] }
        }
      }), config)
      expect(interrupts(completed)).toEqual([])
      expect(effects.sort()).toEqual(['first:1', 'first:2', 'second:1', 'second:2'])
    } finally {
      database.close()
    }
  })

  it('does not let an older ToolMessage with a reused call ID hide the latest effect', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'reused-call-id-run')
      let effects = 0
      const effect = tool(async () => {
        armCurrentAgentToolEffect({ kind: 'test_process', target: { tool: 'current' } })
        effects += 1
        return 'completed'
      }, {
        name: 'pwsh',
        description: 'Current effect.',
        metadata: commandShellMetadata(),
        schema: z.object({})
      })
      const model = new FakeToolCallingModel({
        toolCalls: [[{ id: 'reused-id', name: effect.name, args: {} }], []]
      })
      const agent = createAgent({
        model,
        tools: [effect],
        checkpointer: database.checkpointer,
        middleware: [createAgentToolEffectMiddleware({
          database,
          runId: run.id,
          threadId: thread.id,
          tools: [effect]
        })]
      })

      await agent.invoke({
        messages: [
          new AIMessage({
            content: '',
            tool_calls: [{ id: 'reused-id', name: 'old_read', args: {} }]
          }),
          new ToolMessage({ content: 'old result', tool_call_id: 'reused-id' }),
          new HumanMessage('Run the new effect.')
        ]
      }, {
        configurable: { thread_id: thread.id },
        durability: 'sync'
      })

      expect(effects).toBe(1)
    } finally {
      database.close()
    }
  })

  it('recovers a durable confirm intent after MCP metadata changes to read-only', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'metadata-intent-run')
      const execution = effectExecution(thread.id, 'metadata-intent-checkpoint', 'intent-task')
      const effect = tool(async () => 'must not run', {
        name: 'mcp_alpha_mutate',
        description: 'Metadata drift intent.',
        schema: z.object({})
      })
      effect.metadata = { annotations: { readOnlyHint: true } }
      const ai = new AIMessage({
        content: '',
        tool_calls: [{ id: 'intent-call', name: effect.name, args: {} }]
      })
      const call = ai.tool_calls![0] as DirectToolCall
      const key = prepareDirectEffect(database, run.id, thread.id, execution, call, 0)
      database.armToolEffect(key, {
        effectKind: 'mcp_tool_call',
        targetJson: '{"resource":"A"}'
      })
      const middleware = createAgentToolEffectMiddleware({
        database,
        runId: run.id,
        threadId: thread.id,
        tools: [effect]
      })
      const stopped = new Error('expected fresh recovery interrupt')
      let recovery: unknown
      let handlerCalls = 0
      const request = {
        toolCall: call,
        tool: effect,
        state: { messages: [ai] },
        runtime: {
          interrupt: (value: unknown) => {
            recovery = value
            throw stopped
          }
        }
      } as unknown as ToolCallRequest
      const handler: ToolCallHandler = async () => {
        handlerCalls += 1
        return new ToolMessage({ content: 'wrong', tool_call_id: call.id! })
      }

      await expect(invokeDirectMiddleware(
        middleware,
        execution,
        request,
        handler
      )).rejects.toBe(stopped)
      expect(handlerCalls).toBe(0)
      expect(recovery).toMatchObject({
        actionRequests: [{
          name: effect.name,
          anasRecovery: { ordinal: 1, state: 'uncertain' }
        }]
      })
    } finally {
      database.close()
    }
  })

  it('replays and returns a durable result after MCP metadata changes to read-only', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'metadata-result-run')
      const execution = effectExecution(thread.id, 'metadata-result-checkpoint', 'result-task')
      const effect = tool(async () => 'must not run', {
        name: 'mcp_alpha_mutate',
        description: 'Metadata drift result.',
        schema: z.object({})
      })
      effect.metadata = { annotations: { readOnlyHint: true } }
      const ai = new AIMessage({
        content: '',
        tool_calls: [{ id: 'result-call', name: effect.name, args: {} }]
      })
      const call = ai.tool_calls![0] as DirectToolCall
      const key = prepareDirectEffect(database, run.id, thread.id, execution, call, 0)
      database.armToolEffect(key, {
        effectKind: 'mcp_tool_call',
        targetJson: '{"resource":"A"}'
      })
      const durableResult = new ToolMessage({
        content: 'durable rejection result',
        name: effect.name,
        tool_call_id: call.id!,
        status: 'error'
      })
      await database.storeToolEffectResult(key, {
        result: durableResult,
        confirmation: { kind: 'rejected', expectedConfirmationCount: 0 }
      })
      const middleware = createAgentToolEffectMiddleware({
        database,
        runId: run.id,
        threadId: thread.id,
        tools: [effect]
      })
      let interruptCalls = 0
      let handlerCalls = 0
      const request = {
        toolCall: call,
        tool: effect,
        state: { messages: [ai] },
        runtime: {
          interrupt: () => {
            interruptCalls += 1
            return { decisions: [{ type: 'reject' }] }
          }
        }
      } as unknown as ToolCallRequest
      const handler: ToolCallHandler = async () => {
        handlerCalls += 1
        return new ToolMessage({ content: 'wrong', tool_call_id: call.id! })
      }

      const result = await invokeDirectMiddleware(
        middleware,
        execution,
        request,
        handler
      )
      expect(handlerCalls).toBe(0)
      expect(interruptCalls).toBe(1)
      if (!ToolMessage.isInstance(result)) throw new Error('Expected a cached ToolMessage result.')
      expect(result.content).toBe('durable rejection result')
    } finally {
      database.close()
    }
  })

  it.each([
    {
      initialMode: 'idempotent' as const,
      annotations: {},
      expectedMode: 'confirm' as const
    },
    {
      initialMode: 'confirm' as const,
      annotations: { idempotentHint: true },
      expectedMode: 'idempotent' as const
    }
  ])('uses current $expectedMode metadata for a $initialMode prepared0 row', async ({
    initialMode,
    annotations,
    expectedMode
  }) => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(
        thread.id,
        `prepared-mode-${initialMode}-to-${expectedMode}`
      )
      const execution = effectExecution(
        thread.id,
        `prepared-mode-${expectedMode}-checkpoint`,
        `prepared-mode-${expectedMode}-task`
      )
      const effect = tool(async () => 'unused', {
        name: 'mcp_alpha_mutate',
        description: 'Prepared mode drift.',
        schema: z.object({})
      })
      effect.metadata = { annotations }
      const ai = new AIMessage({
        content: '',
        tool_calls: [{ id: 'prepared-mode-call', name: effect.name, args: {} }]
      })
      const call = ai.tool_calls![0] as DirectToolCall
      const key = prepareDirectEffect(
        database,
        run.id,
        thread.id,
        execution,
        call,
        0,
        initialMode
      )
      const middleware = createAgentToolEffectMiddleware({
        database,
        runId: run.id,
        threadId: thread.id,
        tools: [effect]
      })
      let handlerCalls = 0
      const request = {
        toolCall: call,
        tool: effect,
        state: { messages: [ai] },
        runtime: { interrupt: () => { throw new Error('unexpected recovery') } }
      } as unknown as ToolCallRequest

      await invokeDirectMiddleware(middleware, execution, request, async () => {
        handlerCalls += 1
        armCurrentAgentToolEffect({
          kind: 'mcp_tool_call',
          target: { resource: 'A' }
        })
        return new ToolMessage({ content: 'completed', tool_call_id: call.id! })
      })

      expect(handlerCalls).toBe(1)
      expect(database.loadToolEffect(key)).toMatchObject({
        state: 'result',
        effectAttempt: 1,
        recoveryMode: expectedMode
      })
    } finally {
      database.close()
    }
  })

  it('discards a prepared0 row before trusting current read-only metadata', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'prepared-read-only-run')
      const execution = effectExecution(
        thread.id,
        'prepared-read-only-checkpoint',
        'prepared-read-only-task'
      )
      const effect = tool(async () => 'unused', {
        name: 'mcp_alpha_read',
        description: 'Prepared row became read-only.',
        schema: z.object({})
      })
      effect.metadata = { annotations: { readOnlyHint: true } }
      const ai = new AIMessage({
        content: '',
        tool_calls: [{ id: 'prepared-read-call', name: effect.name, args: {} }]
      })
      const call = ai.tool_calls![0] as DirectToolCall
      const key = prepareDirectEffect(
        database,
        run.id,
        thread.id,
        execution,
        call,
        0
      )
      const middleware = createAgentToolEffectMiddleware({
        database,
        runId: run.id,
        threadId: thread.id,
        tools: [effect]
      })
      let handlerCalls = 0
      let effectScopeSeen = false
      const request = {
        toolCall: call,
        tool: effect,
        state: { messages: [ai] },
        runtime: { interrupt: () => { throw new Error('unexpected recovery') } }
      } as unknown as ToolCallRequest

      const result = await invokeDirectMiddleware(middleware, execution, request, async () => {
        handlerCalls += 1
        effectScopeSeen = hasCurrentAgentToolEffectScope()
        armCurrentAgentToolEffect({ kind: 'must_be_noop', target: { resource: 'A' } })
        return new ToolMessage({ content: 'read completed', tool_call_id: call.id! })
      })

      expect(handlerCalls).toBe(1)
      expect(effectScopeSeen).toBe(true)
      expect(database.loadToolEffect(key)).toBeUndefined()
      if (!ToolMessage.isInstance(result)) throw new Error('Expected a read ToolMessage.')
      expect(result.content).toBe('read completed')
    } finally {
      database.close()
    }
  })

  it('keeps parallel recovery decisions isolated when both MCP annotations drift', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'metadata-parallel-run')
      const checkpointId = 'metadata-parallel-checkpoint'
      const leftExecution = effectExecution(thread.id, checkpointId, 'left-task')
      const rightExecution = effectExecution(thread.id, checkpointId, 'right-task')
      const left = tool(async () => 'must not run', {
        name: 'mcp_alpha_left',
        description: 'Metadata drift left.',
        schema: z.object({})
      })
      const right = tool(async () => 'must not run', {
        name: 'mcp_alpha_right',
        description: 'Metadata drift right.',
        schema: z.object({})
      })
      left.metadata = { annotations: { readOnlyHint: true } }
      right.metadata = { annotations: { readOnlyHint: true } }
      const ai = new AIMessage({
        content: '',
        tool_calls: [
          { id: 'left-call', name: left.name, args: {} },
          { id: 'right-call', name: right.name, args: {} }
        ]
      })
      const leftCall = ai.tool_calls![0] as DirectToolCall
      const rightCall = ai.tool_calls![1] as DirectToolCall
      const leftKey = prepareDirectEffect(
        database,
        run.id,
        thread.id,
        leftExecution,
        leftCall,
        0
      )
      const rightKey = prepareDirectEffect(
        database,
        run.id,
        thread.id,
        rightExecution,
        rightCall,
        1
      )
      database.armToolEffect(leftKey, {
        effectKind: 'mcp_tool_call',
        targetJson: '{"resource":"left"}'
      })
      database.armToolEffect(rightKey, {
        effectKind: 'mcp_tool_call',
        targetJson: '{"resource":"right"}'
      })
      database.retryToolEffect(rightKey, {
        kind: 'approved',
        expectedConfirmationCount: 0
      })
      const middleware = createAgentToolEffectMiddleware({
        database,
        runId: run.id,
        threadId: thread.id,
        tools: [left, right]
      })
      const stopped = new Error('left recovery interrupted')
      let leftHandlerCalls = 0
      let rightHandlerCalls = 0
      let rightConfirmationReplays = 0
      const leftRequest = {
        toolCall: leftCall,
        tool: left,
        state: { messages: [ai] },
        runtime: { interrupt: () => { throw stopped } }
      } as unknown as ToolCallRequest
      const rightRequest = {
        toolCall: rightCall,
        tool: right,
        state: { messages: [ai] },
        runtime: { interrupt: () => { rightConfirmationReplays += 1; return { decisions: [{ type: 'approve' }] } } }
      } as unknown as ToolCallRequest

      const outcomes = await Promise.allSettled([
        invokeDirectMiddleware(middleware, leftExecution, leftRequest, async () => {
          leftHandlerCalls += 1
          return new ToolMessage({ content: 'wrong', tool_call_id: leftCall.id! })
        }),
        invokeDirectMiddleware(middleware, rightExecution, rightRequest, async () => {
          rightHandlerCalls += 1
          armCurrentAgentToolEffect({ kind: 'mcp_tool_call', target: { resource: 'right' } })
          return new ToolMessage({ content: 'right completed', tool_call_id: rightCall.id! })
        })
      ])

      expect(leftHandlerCalls).toBe(0)
      expect(rightHandlerCalls).toBe(1)
      expect(rightConfirmationReplays).toBe(1)
      expect(outcomes[0]).toEqual({ status: 'rejected', reason: stopped })
      expect(outcomes[1].status).toBe('fulfilled')
      if (outcomes[1].status !== 'fulfilled' || !ToolMessage.isInstance(outcomes[1].value)) throw new Error('Expected the independently confirmed tool result.')
      expect(outcomes[1].value.content).toBe('right completed')
      expect(database.loadToolEffect(leftKey)?.state).toBe('intent')
      expect(database.loadToolEffect(rightKey)?.state).toBe('result')
    } finally {
      database.close()
    }
  })

  it('uses the real nested subgraph parent namespace for durable result cleanup', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'nested-effect-run')
      const preparations: AgentToolEffectPreparation[] = []
      const journalDatabase = observeEffectPreparations(database, preparations)
      const effect = tool(async () => {
        armCurrentAgentToolEffect({
          kind: 'test_process',
          target: { tool: 'nested' }
        })
        return 'nested completed'
      }, {
        name: 'pwsh',
        description: 'Nested effect.',
        metadata: commandShellMetadata(),
        schema: z.object({})
      })
      const child = createAgent({
        model: new FakeToolCallingModel({
          toolCalls: [[{ id: 'nested-call', name: effect.name, args: {} }], []]
        }),
        tools: [effect],
        middleware: [createAgentToolEffectMiddleware({
          database: journalDatabase,
          runId: run.id,
          threadId: thread.id,
          tools: [effect]
        })]
      })
      const parent = new StateGraph(MessagesAnnotation)
        .addNode('child_agent', child.graph)
        .addEdge(START, 'child_agent')
        .addEdge('child_agent', END)
        .compile({ checkpointer: database.checkpointer })

      await parent.invoke({
        messages: [new HumanMessage('Run the nested effect.')]
      }, {
        configurable: { thread_id: thread.id },
        durability: 'sync'
      })

      expect(preparations).toHaveLength(1)
      expect(preparations[0].checkpointNs).toMatch(/^child_agent:[^|]+\|tools:/)
      expect(preparations[0].writeCheckpointNs).toMatch(/^child_agent:/)
      expect(preparations[0].checkpointNs).toBe(
        `${preparations[0].writeCheckpointNs}|tools:${preparations[0].taskId}`
      )
    } finally {
      database.close()
    }
  })

  it('keeps uncertainty facts when a rejection also includes user feedback', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'rejected-effect-run')
      let effects = 0
      const effect = tool(async () => {
        armCurrentAgentToolEffect({ kind: 'test_process', target: { resource: 'A' } })
        effects += 1
        throw new Error('result lost after external operation')
      }, {
        name: 'pwsh',
        description: 'Rejected recovery effect.',
        metadata: commandShellMetadata(),
        schema: z.object({})
      })
      const agent = createAgent({
        model: new FakeToolCallingModel({
          toolCalls: [[{ id: 'rejected-call', name: effect.name, args: {} }], []]
        }),
        tools: [effect],
        checkpointer: database.checkpointer,
        middleware: [createAgentToolEffectMiddleware({
          database,
          runId: run.id,
          threadId: thread.id,
          tools: [effect]
        })]
      })
      const config = {
        configurable: { thread_id: thread.id },
        durability: 'sync' as const
      }

      const stopped = await agent.invoke({
        messages: [new HumanMessage('Run the rejected recovery test.')]
      }, config)
      const pending = interrupts(stopped)
      expect(pending).toHaveLength(1)
      const completed = await agent.invoke(new Command({
        resume: {
          [pending[0].id]: {
            decisions: [{ type: 'reject', message: 'Leave the external state alone.' }]
          }
        }
      }), config)

      expect(effects).toBe(1)
      expect(outputText(completed)).toContain('The earlier operation may already have happened')
      expect(outputText(completed)).toContain(
        'choosing not to retry does not mean it was undone'
      )
      expect(outputText(completed)).toContain('Leave the external state alone.')
    } finally {
      database.close()
    }
  })

  it.each([
    { recoveryMode: 'confirm' as const, drift: false },
    { recoveryMode: 'confirm' as const, drift: true },
    { recoveryMode: 'idempotent' as const, drift: false },
    { recoveryMode: 'idempotent' as const, drift: true }
  ])('allows only an exact $recoveryMode retry when drift=$drift', async ({
    recoveryMode,
    drift
  }) => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(
        thread.id,
        `descriptor-${recoveryMode}-${drift ? 'drift' : 'stable'}`
      )
      let target = 'resolved-before-effect'
      let effects = 0
      const effect = tool(async () => {
        armCurrentAgentToolEffect({
          kind: 'test_process',
          target: { target },
          recoveryMode,
          ...(recoveryMode === 'idempotent'
            ? { idempotencyFingerprint: 'a'.repeat(64) }
            : {})
        })
        effects += 1
        if (effects === 1) {
          if (drift) target = 'resolved-after-retry'
          throw new Error('the first result was lost')
        }
        return 'completed after exact retry'
      }, {
        name: 'pwsh',
        description: 'Descriptor retry effect.',
        metadata: commandShellMetadata(),
        schema: z.object({})
      })
      const agent = createAgent({
        model: new FakeToolCallingModel({
          toolCalls: [[{ id: 'descriptor-call', name: effect.name, args: {} }], []]
        }),
        tools: [effect],
        checkpointer: database.checkpointer,
        middleware: [createAgentToolEffectMiddleware({
          database,
          runId: run.id,
          threadId: thread.id,
          tools: [effect]
        })]
      })
      const config = {
        configurable: { thread_id: thread.id },
        durability: 'sync' as const
      }

      let output: unknown
      let failure: unknown
      try {
        const initial = await agent.invoke({
          messages: [new HumanMessage('Run the descriptor test.')]
        }, config)
        if (recoveryMode === 'confirm') {
          const pending = interrupts(initial)
          expect(pending).toHaveLength(1)
          output = await agent.invoke(new Command({
            resume: {
              [pending[0].id]: { decisions: [{ type: 'approve' }] }
            }
          }), config)
        } else {
          output = initial
        }
      } catch (error) {
        failure = error
      }

      if (drift) {
        expect(effects).toBe(1)
        const evidence = failure instanceof Error ? failure.message : outputText(output)
        expect(evidence).toContain('resolved to a different effect boundary during retry')
      } else {
        expect(failure).toBeUndefined()
        expect(interrupts(output)).toEqual([])
        expect(effects).toBe(2)
        expect(outputText(output)).toContain('completed after exact retry')
      }
    } finally {
      database.close()
    }
  })
})
