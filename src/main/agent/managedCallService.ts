import { randomUUID } from 'node:crypto'
import { AsyncResource } from 'node:async_hooks'
import { ToolInputParsingException } from '@langchain/core/tools'
import PQueue from 'p-queue'
import type {
  AgentManagedCallKind,
  AgentManagedCallOutputChunk,
  AgentManagedCallRecord,
  AgentDatabase
} from './agentDatabase'
import {
  armCurrentAgentToolEffect,
  currentAgentToolEffectArtifactId,
  deferCurrentManagedCallResult
} from './toolEffectScope'
import { runtimeLog } from '../runtimeLogger'
import { decodeManagedToolResult, decodeManagedToolResultSync, isManagedToolResultReference, managedToolText } from './managedToolResult'
import { terminalActionSchema, type TerminalAction } from '@shared/terminal'
import type { ShellTerminalControl } from '../ptyShellSupervisor'

const backgroundYieldMs = 10_000
const maximumActiveCalls = 8
const maximumTrackedCalls = 64
const outputChunkChars = 8_192
const outputFlushDelayMs = 50
const progressFlushDelayMs = 250
const maximumOutputReadChars = 10_000
const defaultWaitMs = 30_000
const minimumWaitMs = 10_000
const maximumWaitMs = 300_000
const cancellationSettleMs = 5_000
const maximumSummaryChars = 500
const maximumPendingOutputChars = 128 * 1024
const maximumPendingOutputChunks = 4096

const terminalStatuses = new Set<AgentManagedCallRecord['status']>([
  'completed',
  'failed',
  'cancelled',
  'uncertain'
])

export interface ManagedCallControl {
  setTerminal?(terminal: ShellTerminalControl): void
  readonly signal: AbortSignal
  readonly dispatched?: boolean
  readonly outcome?: Readonly<Record<string, unknown>>
  markRunning(): void
  markLocalCommit(): void
  markUncertain(reason: string): void
  output(stream: AgentManagedCallOutputChunk['stream'], text: string): void
  progress(current: number, unit: string, total?: number): void
  setOutcome(outcome: Record<string, unknown>): void
}

export interface ManagedCallStartOptions {
  kind: AgentManagedCallKind
  threadId: string
  runId: string
  summary: string
  parentSignal?: AbortSignal
  uncertainWhenCancelledAfterDispatch?: boolean
  allowBackground?: boolean
  retainInlineResult?: boolean
  serialGroup?: string
  execute(control: ManagedCallControl): Promise<string>
}

export interface ManagedCallReadOptions {
  callId?: string
  threadId: string
}

export interface ManagedCallWaitOptions {
  callId: string
  threadId: string
  timeoutMs?: number
  signal?: AbortSignal
}

export interface ManagedCallOutputReadOptions {
  callId: string
  threadId: string
  offset: number
  length: number
}

interface ActiveManagedCall {
  terminal?: ShellTerminalControl
  threadId: string
  runId: string
  controller: AbortController
  completion: Promise<string>
  dispatched: boolean
  localCommitStarted: boolean
  cancelRequested: boolean
  cancellationTimedOut?: boolean
  uncertainReason?: string
  outcome?: Record<string, unknown>
  outputFailure?: string
  pendingOutput: Array<Pick<AgentManagedCallOutputChunk, 'stream' | 'text'>>
  pendingOutputChars: number
  pendingProgress?: { current: number; total?: number; unit: string }
  outputFlushTimer?: NodeJS.Timeout
  parentSignal?: AbortSignal
  parentAbort?: () => void
  deferredEffectResult?: boolean
}

interface CompletionRace {
  completed: true
  result: string
}

export interface ManagedCallCancellationResult {
  uncertainCallIds: string[]
  lingeringCallIds: string[]
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  return Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.floor(value as number)))
    : fallback
}

function callFailure(reason: unknown): string {
  return JSON.stringify({ ok: false, error: errorText(reason) })
}

function uncertainInlineResult(call: AgentManagedCallRecord): string {
  return JSON.stringify({
    ok: false,
    outcome_uncertain: true,
    error: call.error ?? 'The tool did not confirm its outcome.',
    message: 'Verify the external state before retrying this operation; it may already have taken effect.'
  })
}

function callSummary(kind: AgentManagedCallKind, value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim().slice(0, maximumSummaryChars) || `${kind} call`
}

function isTerminal(call: AgentManagedCallRecord): boolean {
  return terminalStatuses.has(call.status)
}

function resultOutputChars(call: AgentManagedCallRecord): number {
  const count = call.outcome?.result_output_chars
  if (!call.result || call.outcome?.result_format !== 'langchain'
    || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return 0
  try { return isManagedToolResultReference(JSON.parse(call.result)) ? count : 0 } catch { return 0 }
}

function totalOutputChars(call: AgentManagedCallRecord): number {
  return call.outputChars + resultOutputChars(call)
}

export function managedCallHandle(call: AgentManagedCallRecord): string {
  return JSON.stringify({
    ok: true,
    status: call.status,
    call_id: call.id,
    kind: call.kind,
    summary: call.summary,
    output_chars_total: totalOutputChars(call),
    message: isTerminal(call)
      ? 'The background operation has ended. Use read_call for its outcome and read_call_output only when output details are needed.'
      : call.status === 'preparing'
        ? 'The operation is queued or preparing and has not been dispatched. It will start automatically when ready; do not submit it again. Use wait_call or read_call for status, or cancel_call to stop it.'
        : 'The operation is still running. Use wait_call or read_call for status, read_call_output only when output details are needed, and cancel_call only when it should stop.'
  })
}

export function managedCallInlineResult(call: AgentManagedCallRecord): string {
  return call.result ?? callFailure(call.error ?? `Background call ended as ${call.status}.`)
}

function callCancellationResult(
  call: AgentManagedCallRecord,
  changed: boolean,
  executorLingering: boolean,
  outcomeUncertain = call.status === 'uncertain'
): string {
  const message = executorLingering
    ? 'Cancellation stopped waiting after 5 seconds. The executor is still running; output and its final result will continue to be recorded. Use wait_call or read_call for its confirmed outcome.'
    : call.status === 'uncertain'
      ? 'The call is recorded as uncertain because its external outcome could not be confirmed.'
      : call.status === 'cancelled'
        ? 'The call was cancelled.'
        : 'The call had already ended.'
  return JSON.stringify({
    ok: true,
    call_id: call.id,
    status: call.status,
    output_chars_total: totalOutputChars(call),
    changed,
    executor_lingering: executorLingering,
    outcome_uncertain: outcomeUncertain,
    message
  })
}

export class ManagedCallService {
  private readonly active = new Map<string, ActiveManagedCall>()
  private readonly waiters = new Map<string, Set<() => void>>()
  private readonly idleWaiters = new Set<() => void>()
  private shuttingDown = false
  private readonly executionQueue = new PQueue({ concurrency: maximumActiveCalls })
  private readonly serialGroups = new Map<string, PQueue>()

  constructor(private readonly database: AgentDatabase) {}

  async start(options: ManagedCallStartOptions): Promise<string> {
    if (this.shuttingDown) return callFailure('Background call service is shutting down.')

    const stableCallId = currentAgentToolEffectArtifactId('managed-call')
    const callId = stableCallId ?? randomUUID()
    const existing = this.database.getManagedCall(callId, options.threadId)
    const activeExisting = this.active.get(callId)
    if (existing && activeExisting) return this.detach(existing)
    const retryExisting = Boolean(
      stableCallId
      && existing
      && (
        existing.status === 'uncertain'
        || (existing.status === 'failed' && !existing.dispatchedAt)
      )
    )
    if (existing) {
      if (!retryExisting && !existing.detachedAt && isTerminal(existing)) return managedCallInlineResult(existing)
      if (!retryExisting) return this.detach(existing)
    }
    if (this.active.size >= maximumTrackedCalls) {
      return callFailure(`The tool queue is full (${maximumTrackedCalls} active or waiting calls). Wait for existing calls before submitting more.`)
    }
    if (retryExisting) this.database.deleteManagedCall(callId, options.threadId)
    const startedAt = Date.now()
    const call = this.database.createManagedCall({
      id: callId,
      threadId: options.threadId,
      runId: options.runId,
      kind: options.kind,
      summary: callSummary(options.kind, options.summary)
    })
    const controller = new AbortController()
    const active: ActiveManagedCall = {
      threadId: options.threadId,
      runId: options.runId,
      controller,
      completion: Promise.resolve(''),
      dispatched: false,
      localCommitStarted: false,
      cancelRequested: false,
      pendingOutput: [],
      pendingOutputChars: 0,
      parentSignal: options.parentSignal
    }
    const parentAbort = (): void => {
      active.cancelRequested = true
      controller.abort(options.parentSignal?.reason ?? new Error('Run cancelled.'))
    }
    active.parentAbort = parentAbort
    if (options.parentSignal?.aborted) parentAbort()
    else options.parentSignal?.addEventListener('abort', parentAbort, { once: true })

    const control: ManagedCallControl = {
      setTerminal: (terminal) => {
        if ((options.kind !== 'shell' && options.kind !== 'custom') || !active.dispatched || active.cancelRequested || this.active.get(callId) !== active) throw new Error('The call cannot accept terminal control.')
        if (active.terminal) throw new Error('The call already owns a terminal instance.')
        active.terminal = terminal
        active.outcome = { ...active.outcome, terminal_id: terminal.id, terminal_mode: 'pty' }
      },
      signal: controller.signal,
      get dispatched() { return active.dispatched },
      get outcome() { return active.outcome },
      markRunning: () => {
        if (active.dispatched) return
        if (active.cancelRequested || controller.signal.aborted) {
          throw new Error('Background call was cancelled before dispatch.')
        }
        if (this.shuttingDown) {
          throw new Error('Background call service is shutting down; dispatch was denied.')
        }
        if (this.active.get(callId) !== active) {
          throw new Error('Background call no longer owns its dispatch slot.')
        }
        const current = this.database.getManagedCall(callId, options.threadId)
        if (!current) throw new Error('Background call no longer has a durable record.')
        if (isTerminal(current)) {
          throw new Error(`Background call already ended as ${current.status}; dispatch was denied.`)
        }
        this.database.markManagedCallRunning(callId, options.threadId)
        active.dispatched = true
      },
      markLocalCommit: () => {
        if (!active.dispatched) throw new Error('A local commit must be dispatched before it starts.')
        active.localCommitStarted = true
      },
      markUncertain: (reason) => {
        active.uncertainReason ??= reason.trim() || 'The external outcome is unknown.'
      },
      output: (stream, text) => {
        if (active.outputFailure) throw new Error(active.outputFailure)
        if (!text) return
        for (let offset = 0; offset < text.length; offset += outputChunkChars) {
          const textChunk = text.slice(offset, offset + outputChunkChars)
          active.pendingOutput.push({ stream, text: textChunk })
          active.pendingOutputChars += textChunk.length
          // Bound pending memory independently of timer/event-loop scheduling.
          // SQLite commits synchronously; the terminal/pipe read then naturally
          // backpressures while disk catches up, without dropping any output.
          if (active.pendingOutputChars >= maximumPendingOutputChars || active.pendingOutput.length >= maximumPendingOutputChunks) {
            this.flushOutput(callId, active, options.kind)
            if (active.outputFailure) throw new Error(active.outputFailure)
          }
        }
        this.scheduleFlush(callId, active, options.kind, outputFlushDelayMs)
      },
      progress: (current, unit, total) => {
        if (active.outputFailure) throw new Error(active.outputFailure)
        if (!Number.isFinite(current) || current < 0) {
          throw new Error('Call progress must be a non-negative finite number.')
        }
        if (total !== undefined && (!Number.isFinite(total) || total < 0)) {
          throw new Error('Call progress total must be a non-negative finite number.')
        }
        active.pendingProgress = { current, unit, ...(total === undefined ? {} : { total }) }
        this.scheduleFlush(callId, active, options.kind, progressFlushDelayMs)
      },
      setOutcome: (outcome) => {
        active.outcome = { ...active.outcome, ...outcome }
      }
    }

    this.active.set(callId, active)
    active.completion = (async () => {
      let result: string
      let failure: string | undefined
      try {
        result = await this.executeQueued(controller.signal, options.serialGroup, () => options.execute(control))
      } catch (reason) {
        failure = errorText(reason)
        result = callFailure(failure)
        runtimeLog('warn', 'managed-call', 'Background call failed.', {
          callId,
          kind: options.kind,
          error: failure
        })
      }
      this.flushOutput(callId, active, options.kind)
      const status = active.uncertainReason
        ? 'uncertain'
        : active.outcome?.local_commit_completed === true
          ? active.outcome?.ok === false ? 'failed' : 'completed'
        : active.cancelRequested
          ? options.uncertainWhenCancelledAfterDispatch && active.dispatched
            ? 'uncertain'
            : 'cancelled'
          : failure
            ? 'failed'
            : active.outcome?.ok === false
              ? 'failed'
              : 'completed'
      const cancellationWarning = status === 'uncertain'
        ? active.uncertainReason
          ?? 'Cancellation occurred after dispatch; the remote side may have applied the request.'
        : undefined
      const outcomeError = active.outcome?.ok === false && typeof active.outcome.error === 'string'
        ? active.outcome.error
        : undefined
      const terminalError = failure ?? cancellationWarning ?? outcomeError
      try {
        const ownsCall = this.active.get(callId) === active
        const current = ownsCall
          ? this.database.getManagedCall(callId, options.threadId)
          : undefined
        if (ownsCall && current && !isTerminal(current)) {
          this.database.finishManagedCall({
            callId,
            threadId: options.threadId,
            status,
            result,
            ...(active.outcome ? { outcome: active.outcome } : {}),
            ...(terminalError ? { error: terminalError } : {})
          })
        }
      } catch (reason) {
        const persistenceFailure = `Could not persist the background call terminal result: ${errorText(reason)}`
        active.uncertainReason ??= persistenceFailure
        runtimeLog('error', 'managed-call', 'Could not persist the background call terminal result.', {
          callId,
          kind: options.kind,
          error: errorText(reason)
        })
        try {
          const current = this.active.get(callId) === active
            ? this.database.getManagedCall(callId, options.threadId)
            : undefined
          if (current && !isTerminal(current)) {
            this.database.finishManagedCall({
              callId,
              threadId: options.threadId,
              status: 'uncertain',
              error: persistenceFailure
            })
          }
        } catch (fallbackReason) {
          runtimeLog('error', 'managed-call', 'Could not persist fallback uncertainty for the background call.', {
            callId,
            kind: options.kind,
            error: errorText(fallbackReason)
          })
          throw new Error(`${persistenceFailure}; fallback failed: ${errorText(fallbackReason)}`)
        }
      } finally {
        options.parentSignal?.removeEventListener('abort', parentAbort)
        if (this.active.get(callId) === active) this.active.delete(callId)
        for (const notify of [...this.idleWaiters]) notify()
        this.notify(callId)
      }
      return result
    })()

    const remaining = Math.max(0, backgroundYieldMs - (Date.now() - startedAt))
    const raced = options.allowBackground === false
      ? { completed: true as const, result: await active.completion }
      : await Promise.race<CompletionRace | undefined>([
      active.completion.then((result) => ({ completed: true, result })),
      new Promise<undefined>((resolve) => {
        const timer = setTimeout(() => resolve(undefined), remaining)
        timer.unref()
      })
    ])
    if (raced?.completed) {
      const completed = this.database.getManagedCall(callId, options.threadId)
      if (completed?.status === 'uncertain') {
        return options.allowBackground === false ? uncertainInlineResult(completed) : this.detach(completed)
      }
      // Effect-scoped calls are the durable hand-off between the executor and
      // the outer tool-effect journal. Keep their terminal result with the
      // owning run so a crash before that journal commits can replay this call
      // without executing the external operation again.
      if (!stableCallId || options.retainInlineResult === false) this.database.deleteManagedCall(callId, options.threadId)
      return raced.result
    }

    this.flushCurrentCall(callId, options.threadId)
    const current = this.database.getManagedCall(callId, options.threadId)
    if (current && isTerminal(current)) {
      if (current.status === 'uncertain') {
        return options.allowBackground === false ? uncertainInlineResult(current) : this.detach(current)
      }
      if (!stableCallId || options.retainInlineResult === false) this.database.deleteManagedCall(callId, options.threadId)
      return managedCallInlineResult(current)
    }
    return this.detach(current ?? call)
  }

  read(options: ManagedCallReadOptions): string {
    if (options.callId) {
      this.flushCurrentCall(options.callId, options.threadId)
      return JSON.stringify(this.snapshot(options.callId, options.threadId))
    }
    for (const [callId, active] of this.active) {
      if (active.threadId === options.threadId) this.flushCurrentCall(callId, options.threadId)
    }
    const calls = this.database.listUnresolvedManagedCallsForThread(options.threadId)
    return JSON.stringify({
      ok: true,
      count: calls.length,
      calls: calls.map((call) => this.callStatus(call))
    })
  }

  async readResult(callId: string, threadId: string) {
    const call = this.database.getManagedCall(callId, threadId)
    if (!call?.result || call.outcome?.result_format !== 'langchain') return undefined
    return decodeManagedToolResult(this.database, call.result, threadId)
  }

  private async inQueue(queue: PQueue, signal: AbortSignal, execute: () => Promise<string>): Promise<string> {
    signal.throwIfAborted()
    // The queue drains in the previous job's async context. Preserve this call's
    // framework config, authorization and effect journal across admission.
    const invoke = AsyncResource.bind(execute)
    const admission = new AbortController()
    const abort = () => admission.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    try {
      return await queue.add(async () => {
        // Queue cancellation only removes waiting jobs. Once started, the real
        // executor must settle before its slot is released, even after abort.
        signal.removeEventListener('abort', abort)
        await Promise.resolve()
        signal.throwIfAborted()
        return invoke()
      }, { signal: admission.signal })
    } finally { signal.removeEventListener('abort', abort) }
  }

  private executeQueued(signal: AbortSignal, serialGroup: string | undefined, execute: () => Promise<string>): Promise<string> {
    const enter = () => this.inQueue(this.executionQueue, signal, execute)
    if (!serialGroup) return enter()
    let queue = this.serialGroups.get(serialGroup)
    if (!queue) {
      queue = new PQueue({ concurrency: 1 })
      this.serialGroups.set(serialGroup, queue)
    }
    // Do not consume global slots while waiting for a conflicting mutation.
    return this.inQueue(queue, signal, enter)
  }

  readOutput(options: ManagedCallOutputReadOptions): string {
    this.flushCurrentCall(options.callId, options.threadId)
    const length = boundedInteger(options.length, 0, 0, maximumOutputReadChars)
    const call = this.database.getManagedCall(options.callId, options.threadId)
    if (!call) {
      return callFailure(`Background call ${options.callId} was not found in this conversation.`)
    }
    const requestedOffset = boundedInteger(options.offset, 0, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
    const totalChars = totalOutputChars(call)
    const startOffset = requestedOffset < 0 ? Math.max(0, totalChars + requestedOffset) : Math.min(totalChars, requestedOffset)
    const endOffset = Math.min(totalChars, startOffset + length)
    const streamed = this.database.readManagedCallOutputRange(
      call.id,
      call.threadId,
      startOffset,
      Math.max(0, Math.min(endOffset, call.outputChars) - startOffset)
    )
    const output = streamed.chunks.map((chunk) => ({
      stream: chunk.stream, start: chunk.startOffset, end: chunk.endOffset, text: chunk.text
    }))
    if (endOffset > startOffset && endOffset > call.outputChars && resultOutputChars(call) > 0) {
      const message = decodeManagedToolResultSync(this.database, call.result!, call.threadId)
      const text = managedToolText(message)
      const start = Math.max(startOffset, call.outputChars)
      output.push({ stream: 'stdout', start, end: endOffset,
        text: text.slice(start - call.outputChars, endOffset - call.outputChars) })
    }
    return JSON.stringify({
      ok: true,
      call_id: call.id,
      status: call.status,
      output_chars_total: totalChars,
      output_start: startOffset,
      output_end: endOffset,
      has_before: startOffset > 0,
      has_after: endOffset < totalChars,
      output
    })
  }

  async wait(options: ManagedCallWaitOptions): Promise<string> {
    const initial = this.snapshot(options.callId, options.threadId)
    if (initial.status !== 'running' && initial.status !== 'preparing') {
      return JSON.stringify(initial)
    }

    const timeoutMs = boundedInteger(
      options.timeoutMs,
      defaultWaitMs,
      minimumWaitMs,
      maximumWaitMs
    )
    if (options.signal?.aborted) return JSON.stringify(initial)
    await new Promise<void>((resolve) => {
      const listeners = this.waiters.get(options.callId) ?? new Set<() => void>()
      const timer = setTimeout(() => finish(), timeoutMs)
      const finish = (): void => {
        clearTimeout(timer)
        listeners.delete(finish)
        if (listeners.size === 0) this.waiters.delete(options.callId)
        options.signal?.removeEventListener('abort', finish)
        resolve()
      }
      listeners.add(finish)
      this.waiters.set(options.callId, listeners)
      options.signal?.addEventListener('abort', finish, { once: true })
      timer.unref()
      if (options.signal?.aborted) {
        finish()
        return
      }
      const current = this.snapshot(options.callId, options.threadId)
      if (current.status !== 'running' && current.status !== 'preparing') finish()
    })
    this.flushCurrentCall(options.callId, options.threadId)
    return JSON.stringify(this.snapshot(options.callId, options.threadId))
  }

  async cancel(callId: string, threadId: string): Promise<string> {
    const call = this.database.getManagedCall(callId, threadId)
    if (!call) return callFailure(`Background call ${callId} was not found in this conversation.`)
    const active = this.active.get(callId)
    if (isTerminal(call)) {
      return callCancellationResult(call, false, active !== undefined)
    }
    armCurrentAgentToolEffect({
      kind: 'managed_call_cancel',
      target: { callId, threadId },
      recoveryMode: 'idempotent'
    })
    if (!active) {
      const updated = this.database.finishManagedCall({
        callId,
        threadId,
        status: call.status === 'preparing' ? 'cancelled' : 'uncertain',
        error: call.status === 'preparing'
          ? 'The call was cancelled before dispatch.'
          : 'The call executor is unavailable; the external outcome is unknown.'
      })
      this.notify(callId)
      return callCancellationResult(updated, true, false)
    }
    const changed = !active.cancelRequested
    const cancellation = await this.cancelMatching(
      (candidate) => candidate === active,
      'Background call cancellation was requested by the agent.'
    )
    const updated = this.database.getManagedCall(callId, threadId)
    if (!updated) {
      return callFailure(`Background call ${callId} ended, but its durable result is no longer available.`)
    }
    return callCancellationResult(
      updated,
      changed,
      cancellation.lingeringCallIds.includes(callId),
      cancellation.uncertainCallIds.includes(callId)
    )
  }

  async writeTerminal(callId: string, threadId: string, terminalId: string, input: TerminalAction): Promise<string> {
    const action = terminalActionSchema.parse(input)
    if (this.shuttingDown) throw new Error('Agent runtime is shutting down.')
    const call = this.database.getManagedCall(callId, threadId)
    const active = this.active.get(callId)
    if (!call || isTerminal(call) || !active || active.threadId !== threadId || active.cancelRequested
      || !active.terminal || active.terminal.id !== terminalId) {
      throw new ToolInputParsingException('This live terminal instance is unavailable. Read the call status; do not resend input to a replacement process.')
    }
    active.controller.signal.throwIfAborted()
    this.flushCurrentCall(callId, threadId)
    if (active.outputFailure) throw new Error(active.outputFailure)
    armCurrentAgentToolEffect({ kind: 'terminal_input', target: { callId, threadId, terminalId, action },
      recoveryMode: action.type === 'resize' ? 'idempotent' : 'confirm' })
    await active.terminal.apply(action)
    return JSON.stringify({ ok: true, call_id: callId, terminal_id: terminalId, size: active.terminal.size,
      message: 'Terminal input accepted, not proof of command completion. Read authoritative call status and output before continuing.' })
  }

  async shutdown(): Promise<ManagedCallCancellationResult> {
    this.shuttingDown = true
    return this.cancelMatching(() => true, 'Application is shutting down.')
  }

  resumeAfterShutdownTimeout(): void {
    this.shuttingDown = false
  }

  activeCallIds(): string[] {
    return [...this.active.keys()]
  }

  waitForIdle(): Promise<void> {
    if (this.active.size === 0) return Promise.resolve()
    return new Promise((resolve) => {
      const done = (): void => {
        if (this.active.size > 0) return
        this.idleWaiters.delete(done)
        resolve()
      }
      this.idleWaiters.add(done)
      if (this.active.size === 0) done()
    })
  }

  hasActiveForThread(threadId: string): boolean {
    return [...this.active.values()].some((call) => call.threadId === threadId)
  }

  hasActiveForRun(runId: string): boolean {
    return [...this.active.values()].some((call) => call.runId === runId)
  }

  waitForRunIdle(runId: string): Promise<void> {
    if (!this.hasActiveForRun(runId)) return Promise.resolve()
    return new Promise((resolve) => {
      const done = (): void => {
        if (this.hasActiveForRun(runId)) return
        this.idleWaiters.delete(done)
        resolve()
      }
      this.idleWaiters.add(done)
      done()
    })
  }

  unresolvedForRun(runId: string): AgentManagedCallRecord[] {
    return this.database.listUnresolvedManagedCalls(runId)
  }

  unresolvedForThread(threadId: string, limit?: number): AgentManagedCallRecord[] {
    return this.database.listUnresolvedManagedCallsForThread(threadId, limit)
  }

  resolveObservedCall(callId: string, threadId: string, observingRunId: string): void {
    this.database.resolveManagedCall(callId, threadId, observingRunId)
  }

  async cancelThread(threadId: string): Promise<ManagedCallCancellationResult> {
    const result = await this.cancelMatching(
      (call) => call.threadId === threadId,
      'Conversation is being deleted.'
    )
    return this.withPersistentUncertain(
      result,
      this.database.listUnresolvedManagedCallsForThread(threadId)
    )
  }

  async cancelThreads(threadIds: readonly string[], reason: string): Promise<ManagedCallCancellationResult> {
    const selected = new Set(threadIds)
    const result = await this.cancelMatching((call) => selected.has(call.threadId), reason)
    return this.withPersistentUncertain(result,
      threadIds.flatMap((threadId) => this.database.listUnresolvedManagedCallsForThread(threadId)))
  }

  async cancelRun(
    runId: string,
    reason = 'Agent run ended while a background call was still active.'
  ): Promise<ManagedCallCancellationResult> {
    const result = await this.cancelMatching((call) => call.runId === runId, reason)
    return this.withPersistentUncertain(
      result,
      this.database.listUnresolvedManagedCalls(runId)
    )
  }

  async cancelRuns(
    runIds: ReadonlySet<string> | readonly string[],
    reason = 'Conversation history no longer contains the background call run.'
  ): Promise<ManagedCallCancellationResult> {
    const selected = new Set(runIds)
    const result = await this.cancelMatching((call) => selected.has(call.runId), reason)
    return this.withPersistentUncertain(
      result,
      [...selected].flatMap((runId) => this.database.listUnresolvedManagedCalls(runId))
    )
  }

  private snapshot(callId: string, threadId: string): Record<string, unknown> & {
    status: AgentManagedCallRecord['status']
  } {
    const call = this.database.getManagedCall(callId, threadId)
    if (!call) {
      return {
        ok: false,
        status: 'failed',
        error: `Background call ${callId} was not found in this conversation.`
      }
    }
    return this.callStatus(call)
  }

  private callStatus(call: AgentManagedCallRecord): Record<string, unknown> & {
    status: AgentManagedCallRecord['status']
  } {
    const active = this.active.get(call.id)
    const terminal = active?.terminal
    return {
      ok: true,
      call_id: call.id,
      kind: call.kind,
      summary: call.summary,
      status: call.status,
      terminal: isTerminal(call),
      ...(active?.cancelRequested ? { cancellation_requested: true } : {}),
      ...(terminal && !isTerminal(call) ? {
        pty: { terminal_id: terminal.id, ...terminal.size,
          input_available: !active?.cancelRequested && !this.shuttingDown }
      } : {}),
      output_chars_total: totalOutputChars(call),
      ...(call.progressCurrent === undefined
        ? {}
        : {
            progress: {
              current: call.progressCurrent,
              ...(call.progressTotal === undefined ? {} : { total: call.progressTotal }),
              ...(call.progressUnit === undefined ? {} : { unit: call.progressUnit })
            }
          }),
      ...(call.outcome ? { outcome: call.outcome } : {}),
      ...(call.error ? { error: call.error } : {}),
      created_at: call.createdAt,
      updated_at: call.updatedAt
    }
  }

  private notify(callId: string): void {
    for (const notify of this.waiters.get(callId) ?? []) notify()
  }

  private async cancelMatching(
    matches: (call: ActiveManagedCall) => boolean,
    message: string
  ): Promise<ManagedCallCancellationResult> {
    const calls = [...this.active.entries()].filter(([, call]) => matches(call))
    for (const [, call] of calls) {
      call.cancelRequested = true
      call.controller.abort(new Error(message))
    }
    if (calls.length === 0) return { uncertainCallIds: [], lingeringCallIds: [] }

    const pending = calls.filter(([callId, call]) => {
      const current = this.database.getManagedCall(callId, call.threadId)
      return current !== undefined && !isTerminal(current) && !call.cancellationTimedOut
    })
    let timer: NodeJS.Timeout | undefined
    const timedOut = pending.length > 0
      ? await Promise.race([
          Promise.allSettled(pending.map(([, call]) => call.completion)).then(() => false),
          new Promise<true>((resolve) => {
            timer = setTimeout(() => resolve(true), cancellationSettleMs)
            timer.unref()
          })
        ])
      : false
    if (timer) clearTimeout(timer)

    if (timedOut) {
      for (const [callId, call] of calls) {
        // A deadline ends the cancellation wait, not the executor. Keep the
        // record live so late output and the actual outcome can still commit.
        // Cleanup handoff independently removes it from model supervision.
        call.cancellationTimedOut = true
        this.notify(callId)
      }
    }

    return {
      uncertainCallIds: calls.flatMap(([callId, call]) => (
        this.database.getManagedCall(callId, call.threadId)?.status === 'uncertain'
          || (this.active.get(callId) === call && call.dispatched && !call.localCommitStarted)
          ? [callId]
          : []
      )),
      lingeringCallIds: calls.flatMap(([callId, call]) => (
        this.active.get(callId) === call ? [callId] : []
      ))
    }
  }

  private detach(call: AgentManagedCallRecord): string {
    const detached = this.database.markManagedCallDetached(call.id, call.threadId)
    const active = this.active.get(call.id)
    if (active && (!active.dispatched || active.deferredEffectResult)) {
      active.deferredEffectResult = deferCurrentManagedCallResult(detached) || active.deferredEffectResult
    }
    return managedCallHandle(detached)
  }

  private withPersistentUncertain(
    result: ManagedCallCancellationResult,
    calls: readonly AgentManagedCallRecord[]
  ): ManagedCallCancellationResult {
    return {
      ...result,
      uncertainCallIds: [...new Set([
        ...result.uncertainCallIds,
        ...calls.filter((call) => call.status === 'uncertain').map((call) => call.id)
      ])]
    }
  }

  private flushCurrentCall(callId: string, threadId: string): void {
    const active = this.active.get(callId)
    if (!active || active.threadId !== threadId) return
    const call = this.database.getManagedCall(callId, threadId)
    if (call) this.flushOutput(callId, active, call.kind)
  }

  private flushOutput(
    callId: string,
    call: ActiveManagedCall,
    kind: AgentManagedCallKind
  ): void {
    if (call.outputFlushTimer) {
      clearTimeout(call.outputFlushTimer)
      call.outputFlushTimer = undefined
    }
    const pending = call.pendingOutput.splice(0)
    call.pendingOutputChars = 0
    const progress = call.pendingProgress
    call.pendingProgress = undefined
    if (pending.length === 0 && !progress) return
    try {
      if (pending.length > 0) {
        this.database.appendManagedCallOutputBatch({
          callId,
          threadId: call.threadId,
          chunks: pending
        })
      }
      if (progress) {
        this.database.updateManagedCallProgress({
          callId,
          threadId: call.threadId,
          ...progress
        })
      }
    } catch (reason) {
      const failure = `Could not persist complete background call output: ${errorText(reason)}`
      call.outputFailure = failure
      call.uncertainReason ??= failure
      call.controller.abort(new Error(failure))
      runtimeLog('error', 'managed-call', 'Could not persist complete background call output.', {
        callId,
        kind,
        error: errorText(reason)
      })
    }
  }

  private scheduleFlush(
    callId: string,
    call: ActiveManagedCall,
    kind: AgentManagedCallKind,
    delayMs: number
  ): void {
    if (call.outputFlushTimer) return
    call.outputFlushTimer = setTimeout(() => {
      call.outputFlushTimer = undefined
      this.flushOutput(callId, call, kind)
    }, delayMs)
    call.outputFlushTimer.unref()
  }
}
