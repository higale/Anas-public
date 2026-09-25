import {
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage
} from '@langchain/core/messages'
import { createMiddleware } from 'langchain'
import { StateSchema } from '@langchain/langgraph'
import { z } from 'zod'
import type { AgentManagedCallRecord, AgentManagedCallStatus } from './agentDatabase'

const observationToolNames = new Set(['read_call', 'wait_call'])
const supervisionToolNames = new Set([
  'read_call',
  'read_call_output',
  'wait_call',
  'cancel_call'
])
export const backgroundSupervisionToolNames: ReadonlySet<string> = new Set([
  ...supervisionToolNames,
  'read_subagent',
  'wait_subagent',
  'cancel_subagent'
])
const maximumPromptSummaryChars = 200
const terminalCallStatuses = new Set<AgentManagedCallStatus>([
  'completed',
  'failed',
  'cancelled',
  'uncertain'
])
const observedCallStateKey = '_anasManagedCallObservedTerminal'
type ObservedCallState = Record<string, true>

const observationStateFields = {
  [observedCallStateKey]: z.record(z.string(), z.literal(true)).nullable().optional()
}
const observationStateSchema = new StateSchema(observationStateFields)

interface ObservationRequest {
  name: string
  callId?: string
}

function messagesFromState(state: unknown): BaseMessage[] {
  if (!state || typeof state !== 'object') return []
  const messages = (state as { messages?: unknown }).messages
  return Array.isArray(messages)
    ? messages.filter((message): message is BaseMessage => Boolean(message) && typeof message === 'object')
    : []
}

function callLabel(call: AgentManagedCallRecord): string {
  const summary = call.summary.replaceAll(/\s+/g, ' ').trim().slice(0, maximumPromptSummaryChars)
  return `- ${call.id} (${call.kind}, ${call.status})${summary ? `: ${JSON.stringify(summary)}` : ''}`
}

function supervisionInstruction(calls: readonly AgentManagedCallRecord[]): string {
  return [
    '<background_call_supervision>',
    'Background calls in this conversation still require a terminal status to be observed:',
    ...calls.map(callLabel),
    'Do not finish the run yet. Use wait_call or read_call until every call reaches a terminal status. Use read_call_output only when the call details are needed; reading output is not required for supervision. If a call is no longer needed, call cancel_call and then observe its terminal status.',
    '</background_call_supervision>'
  ].join('\n')
}

function observationRequest(call: { name?: unknown; args?: unknown }): ObservationRequest | undefined {
  if (typeof call.name !== 'string' || !observationToolNames.has(call.name)) return undefined
  if (!call.args || typeof call.args !== 'object' || Array.isArray(call.args)) return undefined
  const callId = (call.args as Record<string, unknown>).call_id
  if (typeof callId === 'string' && callId.length > 0) return { name: call.name, callId }
  return call.name === 'read_call' ? { name: call.name } : undefined
}

function parseRecord(content: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(content) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function terminalCallId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const result = value as Record<string, unknown>
  return result.terminal === true
    && typeof result.call_id === 'string'
    && z.string().uuid().safeParse(result.call_id).success
    && typeof result.status === 'string'
    && terminalCallStatuses.has(result.status as AgentManagedCallStatus)
    && typeof result.output_chars_total === 'number'
    && Number.isSafeInteger(result.output_chars_total)
    && result.output_chars_total >= 0
    ? result.call_id
    : undefined
}

function terminalObservationCallIds(
  request: ObservationRequest,
  message: ToolMessage
): string[] {
  if (
    typeof message.content !== 'string'
    || (message.name !== undefined && message.name !== request.name)
  ) return []
  const result = parseRecord(message.content)
  if (!result || result.ok !== true) return []
  if (request.callId) {
    return terminalCallId(result) === request.callId ? [request.callId] : []
  }
  if (!Array.isArray(result.calls)) return []
  return result.calls.flatMap((call) => {
    const callId = terminalCallId(call)
    return callId ? [callId] : []
  })
}

function observedCallsFromState(state: unknown): ObservedCallState {
  if (!state || typeof state !== 'object') return {}
  const parsed = z.record(z.string(), z.literal(true)).safeParse(
    (state as Record<string, unknown>)[observedCallStateKey]
  )
  return parsed.success ? parsed.data : {}
}

function updatedObservedCalls(
  messages: readonly BaseMessage[],
  eligibleCallIds: ReadonlySet<string> | undefined,
  initial: ObservedCallState
): ObservedCallState {
  const calls = new Map<string, ObservationRequest>()
  const observed = new Set(Object.keys(initial).filter((callId) => (
    !eligibleCallIds || eligibleCallIds.has(callId)
  )))
  for (const message of messages) {
    if (AIMessage.isInstance(message)) {
      for (const call of message.tool_calls ?? []) {
        if (typeof call.id !== 'string' || call.id.length === 0) continue
        const request = observationRequest(call)
        if (request && (
          !request.callId || !eligibleCallIds || eligibleCallIds.has(request.callId)
        )) {
          calls.set(call.id, request)
        }
      }
      continue
    }
    if (!ToolMessage.isInstance(message)) continue
    const request = calls.get(message.tool_call_id)
    if (!request) continue
    calls.delete(message.tool_call_id)
    for (const callId of terminalObservationCallIds(request, message)) {
      if (!eligibleCallIds || eligibleCallIds.has(callId)) observed.add(callId)
    }
  }
  return Object.fromEntries([...observed].map((callId) => [callId, true]))
}

function sameObservedCalls(left: ObservedCallState, right: ObservedCallState): boolean {
  const leftIds = Object.keys(left)
  const rightIds = Object.keys(right)
  return leftIds.length === rightIds.length && leftIds.every((callId) => right[callId] === true)
}

export function createManagedCallSupervisionMiddleware(options: {
  unresolvedCalls(limit?: number):
    | readonly AgentManagedCallRecord[]
    | Promise<readonly AgentManagedCallRecord[]>
  resolveObservedCall?(callId: string): void | Promise<void>
}) {
  return createMiddleware({
    name: 'AnasManagedCallSupervisionMiddleware',
    stateSchema: observationStateSchema,
    beforeModel: async (state) => {
      let unresolved = await options.unresolvedCalls()
      const previous = observedCallsFromState(state)
      const unresolvedIds = new Set(unresolved.map((call) => call.id))
      const observed = updatedObservedCalls(messagesFromState(state), unresolvedIds, previous)
      if (options.resolveObservedCall && unresolved.length > 0) {
        const observedIds = Object.keys(observed)
        if (observedIds.length > 0) {
          await Promise.all(observedIds.map((callId) => options.resolveObservedCall?.(callId)))
          unresolved = await options.unresolvedCalls()
        }
      }
      const remainingIds = new Set(unresolved.map((call) => call.id))
      const retainedObserved = Object.fromEntries(
        Object.keys(observed)
          .filter((callId) => remainingIds.has(callId))
          .map((callId) => [callId, true])
      ) as ObservedCallState
      const update: Record<string, unknown> = {}
      if (!sameObservedCalls(previous, retainedObserved)) {
        update[observedCallStateKey] = Object.keys(retainedObserved).length > 0
          ? retainedObserved
          : null
      }
      return Object.keys(update).length > 0 ? update : undefined
    },
    wrapModelCall: async (request, handler) => {
      const unresolved = await options.unresolvedCalls()
      if (unresolved.length === 0) return handler(request)
      const availableSupervisionTools = request.tools.filter((candidate) => (
        'name' in candidate
        && typeof candidate.name === 'string'
        && backgroundSupervisionToolNames.has(candidate.name)
      ))
      if (!availableSupervisionTools.some((candidate) => (
        'name' in candidate
        && typeof candidate.name === 'string'
        && supervisionToolNames.has(candidate.name)
      ))) {
        throw new Error('Background call supervision tools are unavailable for this model request.')
      }
      // Leave tool selection to the model; the runtime owns final cleanup.
      return handler({
        ...request,
        systemMessage: new SystemMessage(
          `${request.systemMessage.text}\n\n${supervisionInstruction(unresolved)}`
        )
      })
    }
  })
}
