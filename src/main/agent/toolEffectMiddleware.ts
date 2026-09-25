import { createHash } from 'node:crypto'
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { ToolInputParsingException, type StructuredToolInterface } from '@langchain/core/tools'
import {
  getConfig,
  isGraphBubbleUp,
  type Command,
  type ExecutionInfo
} from '@langchain/langgraph'
import {
  createMiddleware,
  type HITLRequest,
  type ToolCallHandler,
  type ToolCallRequest
} from 'langchain'
import type {
  AgentDatabase,
  AgentManagedCallRecord,
  AgentToolEffectKey,
  AgentToolEffectRow
} from './agentDatabase'
import { classifyAgentToolEffect } from './toolEffectClassification'
import { decodeManagedToolResult } from './managedToolResult'
import {
  managedCallHandle,
  managedCallInlineResult
} from './managedCallService'
import {
  agentToolEffectArtifactId,
  runWithCurrentAgentToolEffect,
  type AgentToolEffectArm
} from './toolEffectScope'

const maximumAutomaticRetries = 3

type ToolEffectDatabase = Pick<AgentDatabase,
  | 'prepareToolEffect'
  | 'loadToolEffect'
  | 'discardPreparedToolEffect'
  | 'armToolEffect'
  | 'retryToolEffect'
  | 'storeToolEffectResult'
  | 'deserializeToolEffectResult'
  | 'readManagedToolResult'
  | 'getManagedCall'
  | 'deleteManagedCall'
  | 'fileChanges'
>

export interface CreateAgentToolEffectMiddlewareOptions {
  database: ToolEffectDatabase
  runId?: string
  threadId: string
  checkpointThreadId?: string
  tools: readonly StructuredToolInterface[]
}

type ToolCall = {
  id?: string
  name: string
  args: Record<string, unknown>
}

function jsonValue(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Tool effect values must contain only finite numbers.')
    return value
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('Tool effect values must not contain cycles.')
    seen.add(value)
    const normalized = value.map((item) => item === undefined ? null : jsonValue(item, seen))
    seen.delete(value)
    return normalized
  }
  if (typeof value !== 'object') return null
  if (seen.has(value)) throw new Error('Tool effect values must not contain cycles.')
  seen.add(value)
  const normalized = Object.create(null) as Record<string, unknown>
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key]
    if (item !== undefined) normalized[key] = jsonValue(item, seen)
  }
  seen.delete(value)
  return normalized
}

export function canonicalAgentToolEffectJson(value: unknown): string {
  return JSON.stringify(jsonValue(value, new Set()))
}

function inputHash(argsJson: string): string {
  return createHash('sha256').update(argsJson).digest('hex')
}

function asToolCall(value: unknown): ToolCall {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('LangGraph supplied an invalid tool call.')
  }
  const call = value as Partial<ToolCall>
  if (typeof call.name !== 'string' || !call.name) {
    throw new Error('LangGraph supplied a tool call without a name.')
  }
  if (!call.args || typeof call.args !== 'object' || Array.isArray(call.args)) {
    throw new ToolInputParsingException(`Tool call ${call.name} requires arguments as a JSON object.`)
  }
  return call as ToolCall
}

function latestAiMessage(messages: readonly BaseMessage[]): AIMessage {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (AIMessage.isInstance(messages[index])) return messages[index] as AIMessage
  }
  throw new Error('Effectful tool call has no preceding AI message.')
}

function toolCallIndex(messages: readonly BaseMessage[], current: ToolCall): number {
  const calls = latestAiMessage(messages).tool_calls ?? []
  const referenceIndex = calls.findIndex((call) => call === current)
  if (referenceIndex >= 0) return referenceIndex

  if (current.id) {
    const matchingIds = calls.flatMap((call, index) => call.id === current.id ? [index] : [])
    if (matchingIds.length === 1) return matchingIds[0]
  }

  const argsJson = canonicalAgentToolEffectJson(current.args)
  const matchingValues = calls.flatMap((call, index) =>
    call.name === current.name && canonicalAgentToolEffectJson(call.args) === argsJson ? [index] : []
  )
  if (matchingValues.length === 1) return matchingValues[0]
  throw new Error(`Cannot resolve a stable call index for effectful tool ${current.name}.`)
}

function requireExecutionInfo(expectedThreadId: string): ExecutionInfo {
  const executionInfo = getConfig().executionInfo
  if (!executionInfo) throw new Error('Effectful tools require LangGraph executionInfo.')
  if (!executionInfo.threadId) throw new Error('Effectful tools require a durable LangGraph thread.')
  if (executionInfo.threadId !== expectedThreadId) {
    throw new Error(`Effectful tool thread mismatch: expected ${expectedThreadId}, got ${executionInfo.threadId}.`)
  }
  if (!executionInfo.checkpointId || !executionInfo.taskId) {
    throw new Error('Effectful tools require durable LangGraph checkpoint and task IDs.')
  }
  if (typeof executionInfo.checkpointNs !== 'string') {
    throw new Error('Effectful tools require a durable LangGraph checkpoint namespace.')
  }
  return executionInfo
}

export function agentToolEffectWriteCheckpointNs(execution: Pick<
  ExecutionInfo,
  'checkpointNs' | 'taskId'
>): string {
  if (typeof execution.checkpointNs !== 'string' || !execution.taskId) {
    throw new Error('Effectful tools require durable LangGraph task namespace identity.')
  }
  const toolNamespace = `tools:${execution.taskId}`
  if (execution.checkpointNs === toolNamespace) return ''
  const nestedSuffix = `|${toolNamespace}`
  if (execution.checkpointNs.endsWith(nestedSuffix)) {
    return execution.checkpointNs.slice(0, -nestedSuffix.length)
  }
  throw new Error(
    `Effectful tool namespace ${execution.checkpointNs} does not end with its task identity ${toolNamespace}.`
  )
}

interface InterruptCursor {
  next(): number
}

function createInterruptCursor(): InterruptCursor {
  let ordinal = 0
  return {
    next: () => {
      ordinal += 1
      return ordinal
    }
  }
}

type RecoveryActionRequest = HITLRequest['actionRequests'][number] & {
  anasRecovery: {
    ordinal: number
    state: 'uncertain'
  }
}

function recoveryTarget(row: AgentToolEffectRow): unknown {
  return JSON.parse(row.targetJson ?? row.argsJson)
}

function recoveryRequest(
  row: AgentToolEffectRow,
  ordinal: number,
  failure?: unknown
): HITLRequest & { actionRequests: RecoveryActionRequest[] } {
  const target = recoveryTarget(row)
  const reason = failure instanceof Error && failure.message
    ? `\nLast observed error: ${failure.message}`
    : ''
  return {
    actionRequests: [{
      name: row.toolName,
      args: {
        ...JSON.parse(row.argsJson) as Record<string, unknown>,
        anas_recovery_target: target
      },
      description: [
        'The application stopped after crossing the external operation boundary.',
        'The operation may already have happened, and retrying may repeat it.',
        `Resolved target: ${JSON.stringify(target, null, 2)}${reason}`,
        'Choose Retry to run the operation again, or Do not retry to keep the current external state.'
      ].join('\n'),
      anasRecovery: { ordinal, state: 'uncertain' }
    }],
    reviewConfigs: [{
      actionName: row.toolName,
      allowedDecisions: ['approve', 'reject']
    }]
  }
}

type RecoveryDecision =
  | { type: 'approve' }
  | { type: 'reject'; message?: string }

function recoveryDecision(value: unknown): RecoveryDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid recovery response: expected a HITL response object.')
  }
  const decisions = (value as { decisions?: unknown }).decisions
  if (!Array.isArray(decisions) || decisions.length !== 1) {
    throw new Error('Invalid recovery response: expected exactly one decision.')
  }
  const decision = decisions[0]
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    throw new Error('Invalid recovery response decision.')
  }
  const type = (decision as { type?: unknown }).type
  if (type === 'approve') return { type }
  if (type === 'reject') {
    const message = (decision as { message?: unknown }).message
    if (message !== undefined && typeof message !== 'string') {
      throw new Error('Invalid recovery rejection message.')
    }
    return { type, ...(message === undefined ? {} : { message }) }
  }
  throw new Error(`Invalid recovery decision type: ${String(type)}.`)
}

async function deserializeResult(
  database: ToolEffectDatabase,
  row: AgentToolEffectRow
): Promise<ToolMessage | Command> {
  if (!row.resultType || !row.resultBlob) {
    throw new Error(`Tool effect ${row.callKey} is marked result without serialized output.`)
  }
  return database.deserializeToolEffectResult({
    resultType: row.resultType,
    resultBlob: row.resultBlob
  }, row.threadId)
}

function rejectedToolMessage(row: AgentToolEffectRow, toolCallId: string, message?: string): ToolMessage {
  const target = recoveryTarget(row)
  const base = [
    `The user chose not to retry ${row.toolName}.`,
    'The earlier operation may already have happened; choosing not to retry does not mean it was undone.',
    `Resolved recovery target: ${JSON.stringify(target)}`
  ].join(' ')
  return new ToolMessage({
    content: message ? `${base}\n\nUser feedback: ${message}` : base,
    name: row.toolName,
    tool_call_id: toolCallId,
    status: 'error'
  })
}

async function storeResult(
  database: ToolEffectDatabase,
  key: AgentToolEffectKey,
  result: ToolMessage | Command,
  confirmation?: { kind: 'rejected'; expectedConfirmationCount: number }
): Promise<AgentToolEffectRow> {
  return database.storeToolEffectResult(key, {
    result,
    ...(confirmation ? { confirmation } : {})
  })
}

function managedCallArtifact(
  database: ToolEffectDatabase,
  key: AgentToolEffectKey,
  threadId: string
): AgentManagedCallRecord | undefined {
  const call = database.getManagedCall(
    agentToolEffectArtifactId(key, 'managed-call'),
    threadId
  )
  return call?.runId === key.runId ? call : undefined
}

async function recoverableManagedCallResult(
  database: ToolEffectDatabase,
  key: AgentToolEffectKey,
  threadId: string,
  row: AgentToolEffectRow,
  request: ToolCallRequest
): Promise<ToolMessage | undefined> {
  const call = managedCallArtifact(database, key, threadId)
  if (
    !call
    || ((call.status === 'preparing' || call.status === 'running') && !call.detachedAt)
    || call.status === 'uncertain'
  ) return undefined
  if (!call.detachedAt && call.result && call.outcome?.result_format === 'langchain') {
    return decodeManagedToolResult(database, call.result, threadId)
  }
  return new ToolMessage({
    content: call.detachedAt ? managedCallHandle(call) : managedCallInlineResult(call),
    name: row.toolName,
    tool_call_id: request.toolCall.id ?? row.callKey,
    status: 'success'
  })
}

function cleanupInlineManagedCallArtifact(
  database: ToolEffectDatabase,
  key: AgentToolEffectKey,
  threadId: string
): void {
  const call = managedCallArtifact(database, key, threadId)
  if (
    !call
    || call.detachedAt
    || call.status === 'preparing'
    || call.status === 'running'
    || call.status === 'uncertain'
  ) return
  database.deleteManagedCall(call.id, threadId)
}

async function durableResult(
  database: ToolEffectDatabase,
  key: AgentToolEffectKey,
  threadId: string,
  row: AgentToolEffectRow
): Promise<ToolMessage | Command> {
  const result = await deserializeResult(database, row)
  cleanupInlineManagedCallArtifact(database, key, threadId)
  return result
}

async function recoverManagedCallArtifact(
  options: CreateAgentToolEffectMiddlewareOptions,
  key: AgentToolEffectKey,
  row: AgentToolEffectRow,
  request: ToolCallRequest
): Promise<ToolMessage | undefined> {
  const result = await recoverableManagedCallResult(
    options.database,
    key,
    options.threadId,
    row,
    request
  )
  if (!result) return undefined
  const call = managedCallArtifact(options.database, key, options.threadId)
  // A live handoff still owns its effect journal. Its managed artifact owns
  // the eventual result; a replay only reconnects to the same handle.
  if (call?.status === 'preparing' || call?.status === 'running') return result
  await storeResult(options.database, key, result)
  cleanupInlineManagedCallArtifact(options.database, key, options.threadId)
  return result
}

function interruptForRecovery(
  request: ToolCallRequest,
  row: AgentToolEffectRow,
  cursor: InterruptCursor,
  failure?: unknown
): RecoveryDecision {
  const ordinal = cursor.next()
  const interrupt = request.runtime.interrupt
  if (!interrupt) throw new Error('Effect recovery requires a LangGraph interrupt runtime.')
  return recoveryDecision(interrupt(recoveryRequest(row, ordinal, failure)))
}

function replayConfirmedInterrupts(
  request: ToolCallRequest,
  row: AgentToolEffectRow,
  cursor: InterruptCursor
): void {
  for (let index = 0; index < row.confirmationCount; index += 1) {
    interruptForRecovery(request, row, cursor)
  }
}

async function recoverIntent(
  database: ToolEffectDatabase,
  key: AgentToolEffectKey,
  request: ToolCallRequest,
  row: AgentToolEffectRow,
  cursor: InterruptCursor,
  failure?: unknown
): Promise<AgentToolEffectRow> {
  if (row.recoveryMode === 'idempotent' && row.automaticRetryCount < maximumAutomaticRetries) {
    return database.retryToolEffect(key, {
      kind: 'automatic',
      expectedAutomaticRetryCount: row.automaticRetryCount
    })
  }

  if (row.recoveryMode === 'idempotent') {
    const exhausted = new ToolMessage({
      content: `Automatic recovery stopped after ${maximumAutomaticRetries} attempts. The external operation may have completed, but no result was received.`,
      name: row.toolName,
      tool_call_id: request.toolCall.id ?? row.callKey,
      status: 'error'
    })
    return storeResult(database, key, exhausted)
  }

  const decision = interruptForRecovery(request, row, cursor, failure)
  if (decision.type === 'approve') {
    return database.retryToolEffect(key, {
      kind: 'approved',
      expectedConfirmationCount: row.confirmationCount
    })
  }

  const rejected = rejectedToolMessage(
    row,
    request.toolCall.id ?? row.callKey,
    decision.message
  )
  return storeResult(database, key, rejected, {
    kind: 'rejected',
    expectedConfirmationCount: row.confirmationCount
  })
}

async function invokeJournaledTool(
  options: CreateAgentToolEffectMiddlewareOptions,
  key: AgentToolEffectKey,
  request: ToolCallRequest,
  handler: ToolCallHandler,
  initialRow: AgentToolEffectRow,
  initialArmRecoveryMode?: AgentToolEffectRow['recoveryMode']
): Promise<ToolMessage | Command> {
  let row = initialRow
  const cursor = createInterruptCursor()
  replayConfirmedInterrupts(request, row, cursor)

  if (row.state === 'result') {
    return durableResult(options.database, key, options.threadId, row)
  }
  if (row.state === 'intent') {
    const recovered = await recoverManagedCallArtifact(options, key, row, request)
    if (recovered) return recovered
    row = await recoverIntent(options.database, key, request, row, cursor)
    if (row.state === 'result') {
      return durableResult(options.database, key, options.threadId, row)
    }
  }

  while (row.state === 'prepared') {
    let armed = false
    let deferredManagedResult = false
    const scope = {
      effectKey: key,
      deferManagedCallResult: (call: AgentManagedCallRecord): void => {
        if (call.id !== agentToolEffectArtifactId(key, 'managed-call') || call.runId !== key.runId || call.threadId !== options.threadId) {
          throw new Error('Deferred managed call does not belong to this tool effect.')
        }
        deferredManagedResult = true
        // Do not store a handoff as the journal result before dispatch: that
        // would prevent arming the effect. The managed-call artifact persists
        // its actual outcome, including after this run ends or interrupts, and
        // recovery can promote that artifact into a journal result if needed.
      },
      persistFileChange: (record: import('../filePatchRecord').FilePatchEditRecord, observed: boolean) => {
        options.database.fileChanges.persist(record, observed || record.requestId !== key.runId)
      },
      isUnarmed: (): boolean => {
        const durable = options.database.loadToolEffect(key)
        return durable?.state === 'prepared' && durable.effectAttempt === 0
      },
      previousEffect: () => {
        const durable = options.database.loadToolEffect(key)
        return durable?.effectKind && durable.targetJson && durable.effectAttempt > 0
          ? { kind: durable.effectKind, target: JSON.parse(durable.targetJson) as unknown } : undefined
      },
      arm: (effect: AgentToolEffectArm): void => {
        if (armed) return
        const effectKind = effect.kind.trim()
        if (!effectKind) throw new Error('Tool effect kind must not be empty.')
        const recoveryMode = effect.recoveryMode
          ?? (row.effectAttempt === 0 ? initialArmRecoveryMode : undefined)
        row = options.database.armToolEffect(key, {
          effectKind,
          targetJson: canonicalAgentToolEffectJson(effect.target),
          ...(recoveryMode ? { recoveryMode } : {}),
          ...(effect.idempotencyFingerprint
            ? { idempotencyFingerprint: effect.idempotencyFingerprint }
            : {})
        })
        armed = true
      }
    }

    try {
      const result = await runWithCurrentAgentToolEffect(scope, () => handler(request))
      if (deferredManagedResult) return result
      row = await storeResult(options.database, key, result)
      cleanupInlineManagedCallArtifact(options.database, key, options.threadId)
      return result
    } catch (error) {
      if (isGraphBubbleUp(error)) throw error

      const durable = options.database.loadToolEffect(key)
      if (!durable) throw new Error(`Tool effect journal entry ${row.callKey} disappeared.`)
      row = durable
      if (row.state === 'result') {
        return durableResult(options.database, key, options.threadId, row)
      }
      if (!armed || row.state !== 'intent') throw error

      const recovered = await recoverManagedCallArtifact(options, key, row, request)
      if (recovered) return recovered
      row = await recoverIntent(options.database, key, request, row, cursor, error)
      if (row.state === 'result') {
        return durableResult(options.database, key, options.threadId, row)
      }
    }
  }

  return durableResult(options.database, key, options.threadId, row)
}

export function createAgentToolEffectMiddleware(options: CreateAgentToolEffectMiddlewareOptions) {
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]))
  return createMiddleware({
    name: 'AnasToolEffectJournalMiddleware',
    wrapToolCall: async (request, handler) => {
      const call = asToolCall(request.toolCall)
      if (!options.runId) {
        const classification = classifyAgentToolEffect(
          call.name,
          call.args,
          tools.get(call.name)
        )
        if (!classification) return handler(request)
        throw new Error('Effectful tools require an active product run ID.')
      }

      const execution = requireExecutionInfo(options.checkpointThreadId ?? options.threadId)
      const messages = request.state.messages
      const callIndex = toolCallIndex(messages, call)
      const argsJson = canonicalAgentToolEffectJson(call.args)
      const writeCheckpointNs = agentToolEffectWriteCheckpointNs(execution)
      const key: AgentToolEffectKey = {
        runId: options.runId,
        checkpointId: execution.checkpointId,
        checkpointNs: execution.checkpointNs,
        taskId: execution.taskId,
        callKey: call.id ? `id:${call.id}` : `index:${callIndex}`,
        inputHash: inputHash(argsJson)
      }
      const existing = options.database.loadToolEffect(key)
      const classification = classifyAgentToolEffect(
        call.name,
        call.args,
        tools.get(call.name)
      )
      const currentClassificationIsAuthoritative = !existing
        || (existing.state === 'prepared' && existing.effectAttempt === 0)
      if (currentClassificationIsAuthoritative && !classification) {
        if (existing) options.database.discardPreparedToolEffect(key)
        return runWithCurrentAgentToolEffect({ effectKey: key, arm: () => undefined }, () => handler(request))
      }
      const recoveryMode = currentClassificationIsAuthoritative
        ? classification!.recoveryMode
        : existing!.recoveryMode
      const row = options.database.prepareToolEffect({
        ...key,
        threadId: options.threadId,
        writeCheckpointNs,
        callIndex,
        ...(call.id ? { toolCallId: call.id } : {}),
        toolName: call.name,
        argsJson,
        recoveryMode
      })
      return invokeJournaledTool(
        options,
        key,
        request,
        handler,
        row,
        currentClassificationIsAuthoritative ? recoveryMode : undefined
      )
    }
  })
}
