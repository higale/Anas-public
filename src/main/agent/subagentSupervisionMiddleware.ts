import { AIMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { StateSchema } from '@langchain/langgraph'
import { createMiddleware } from 'langchain'
import { z } from 'zod'
import type { AgentSubagentCallRecord } from './agentDatabase'
import { backgroundSupervisionToolNames } from './managedCallSupervisionMiddleware'

const observationTools = new Set(['read_subagent', 'wait_subagent'])
const supervisionTools = new Set(['read_subagent', 'wait_subagent', 'cancel_subagent'])
const observedStateKey = '_anasSubagentObservedTerminal'

type ObservedState = Record<string, true>

const observationStateSchema = new StateSchema({
  [observedStateKey]: z.record(z.string(), z.literal(true)).nullable().optional()
})

function messagesFromState(state: unknown): BaseMessage[] {
  if (!state || typeof state !== 'object') return []
  const messages = (state as { messages?: unknown }).messages
  return Array.isArray(messages)
    ? messages.filter((message): message is BaseMessage => Boolean(message) && typeof message === 'object')
    : []
}

function observedFromState(state: unknown): ObservedState {
  if (!state || typeof state !== 'object') return {}
  const parsed = z.record(z.string(), z.literal(true)).safeParse(
    (state as Record<string, unknown>)[observedStateKey]
  )
  return parsed.success ? parsed.data : {}
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const parsed = JSON.parse(value) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function observedSubagentIds(
  messages: readonly BaseMessage[],
  eligibleIds: ReadonlySet<string>,
  initial: ObservedState
): ObservedState {
  const requests = new Map<string, { name: string; subagentId?: string }>()
  const observed = new Set(Object.keys(initial).filter((id) => eligibleIds.has(id)))
  for (const message of messages) {
    if (AIMessage.isInstance(message)) {
      for (const call of message.tool_calls ?? []) {
        if (typeof call.id !== 'string' || !observationTools.has(call.name)) continue
        if (!call.args || typeof call.args !== 'object' || Array.isArray(call.args)) continue
        const subagentId = (call.args as Record<string, unknown>).subagent_id
        if (typeof subagentId === 'string' && !eligibleIds.has(subagentId)) continue
        requests.set(call.id, {
          name: call.name,
          ...(typeof subagentId === 'string' ? { subagentId } : {})
        })
      }
      continue
    }
    if (!ToolMessage.isInstance(message)) continue
    const request = requests.get(message.tool_call_id)
    if (!request || (message.name !== undefined && message.name !== request.name)) continue
    requests.delete(message.tool_call_id)
    const result = parseRecord(message.content)
    if (!result || result.ok !== true) continue
    const candidates = request.subagentId
      ? [result]
      : Array.isArray(result.subagents) ? result.subagents : []
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
      const record = candidate as Record<string, unknown>
      if (
        record.terminal === true
        && typeof record.subagent_id === 'string'
        && (!request.subagentId || record.subagent_id === request.subagentId)
      ) {
        if (eligibleIds.has(record.subagent_id)) observed.add(record.subagent_id)
      }
    }
  }
  return Object.fromEntries([...observed].map((id) => [id, true]))
}

function sameObserved(left: ObservedState, right: ObservedState): boolean {
  const leftIds = Object.keys(left)
  const rightIds = Object.keys(right)
  return leftIds.length === rightIds.length && leftIds.every((id) => right[id] === true)
}

function prompt(calls: readonly AgentSubagentCallRecord[]): string {
  return [
    '<subagent_supervision>',
    'Background subagents still require a terminal status to be observed:',
    ...calls.map((call) => `- ${call.id} (${call.agentName}, ${call.status}): ${JSON.stringify(call.description.slice(0, 200))}`),
    'Do not finish the run yet. Use wait_subagent or read_subagent until every subagent reaches a terminal status. Cancel a subagent that is no longer needed, then observe its terminal status.',
    '</subagent_supervision>'
  ].join('\n')
}

export function createSubagentSupervisionMiddleware(options: {
  unresolved(limit?: number): readonly AgentSubagentCallRecord[] | Promise<readonly AgentSubagentCallRecord[]>
  resolve(subagentId: string): void | Promise<void>
}) {
  return createMiddleware({
    name: 'AnasSubagentSupervisionMiddleware',
    stateSchema: observationStateSchema,
    beforeModel: async (state) => {
      let unresolved = await options.unresolved()
      const previous = observedFromState(state)
      const unresolvedIds = new Set(unresolved.map((call) => call.id))
      const observed = observedSubagentIds(messagesFromState(state), unresolvedIds, previous)
      const newlyObserved = Object.keys(observed)
      if (newlyObserved.length > 0) {
        await Promise.all(newlyObserved.map((id) => options.resolve(id)))
        unresolved = await options.unresolved()
      }
      const remainingIds = new Set(unresolved.map((call) => call.id))
      const retained = Object.fromEntries(
        Object.keys(observed)
          .filter((id) => remainingIds.has(id))
          .map((id) => [id, true])
      ) as ObservedState
      if (sameObserved(previous, retained)) return undefined
      return {
        [observedStateKey]: Object.keys(retained).length > 0 ? retained : null
      }
    },
    wrapModelCall: async (request, handler) => {
      const unresolved = await options.unresolved()
      if (unresolved.length === 0) return handler(request)
      const availableSupervisionTools = request.tools.filter((candidate) => (
        'name' in candidate
        && typeof candidate.name === 'string'
        && backgroundSupervisionToolNames.has(candidate.name)
      ))
      if (!availableSupervisionTools.some((candidate) => (
        'name' in candidate
        && typeof candidate.name === 'string'
        && supervisionTools.has(candidate.name)
      ))) {
        throw new Error('Subagent supervision tools are unavailable for this model request.')
      }
      return handler({
        ...request,
        systemMessage: new SystemMessage(`${request.systemMessage.text}\n\n${prompt(unresolved)}`)
      })
    }
  })
}
