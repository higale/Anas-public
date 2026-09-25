import { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import type { Callbacks } from '@langchain/core/callbacks/manager'
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import type { AgentServerTokenUsage } from '@shared/agentTypes'
import { latestServerTokenUsage } from '../main/agent/serverTokenUsage'
import { fingerprint } from './codingResults'

interface MessageEvidence {
  id: string | null
  type: string
  contentFingerprint: string
  toolCalls: Array<{ id: string | null; name: string; argsFingerprint: string }>
  toolResultFor: string | null
}

interface ModelCallEvidence {
  callbackRunId: string
  requestId: string | null
  role: string | null
  status: 'running' | 'completed' | 'failed'
  elapsedMs: number
  inputCount: number
  inputs: MessageEvidence[]
  outputCount: number
  outputs: MessageEvidence[]
  messagesTruncated: boolean
  usage: AgentServerTokenUsage | null
  error?: string
}

export interface CodingModelTrace {
  source: 'langchain-callbacks'
  callsTruncated: boolean
  calls: ModelCallEvidence[]
}

export interface CodingTokenUsage {
  source: 'langchain-usage-metadata'
  coverage: 'complete' | 'partial' | 'unavailable'
  observedCalls: number
  callsWithUsage: number
  totals: { inputTokens: number; outputTokens: number; totalTokens: number } | null
}

function messageEvidence(message: BaseMessage): MessageEvidence {
  return {
    id: message.id ?? null, type: message.type,
    contentFingerprint: fingerprint(message.content),
    toolCalls: AIMessage.isInstance(message) ? (message.tool_calls ?? []).map((call) => ({
      id: call.id ?? null, name: call.name, argsFingerprint: fingerprint(call.args)
    })) : [],
    toolResultFor: ToolMessage.isInstance(message) ? message.tool_call_id : null
  }
}

/** Observes native calls without replacing models, requests or checkpoint state. */
export class CodingModelTraceCollector {
  private readonly calls = new Map<string, { start: number; evidence: ModelCallEvidence }>()
  private callsTruncated = false

  constructor(private readonly limits = { calls: 128, messages: 256 }) {
    if (!Number.isInteger(limits.calls) || limits.calls < 1 || !Number.isInteger(limits.messages) || limits.messages < 1) {
      throw new Error('Model trace limits must be positive integers.')
    }
  }

  callbacks(context: { requestId?: string; requestRole?: string } = {}, existing?: Callbacks): Callbacks {
    const handler = BaseCallbackHandler.fromMethods({
      handleChatModelStart: (_model, batches, runId) => {
        if (this.calls.has(runId)) return
        if (this.calls.size >= this.limits.calls) {
          this.callsTruncated = true
          return
        }
        const inputs = batches.flat()
        this.calls.set(runId, { start: performance.now(), evidence: {
          callbackRunId: runId, requestId: context.requestId ?? null, role: context.requestRole ?? null,
          status: 'running', elapsedMs: 0,
          inputCount: inputs.length, inputs: inputs.slice(-this.limits.messages).map(messageEvidence),
          outputCount: 0, outputs: [], messagesTruncated: inputs.length > this.limits.messages, usage: null
        } })
      },
      handleLLMEnd: (result, runId) => {
        const call = this.calls.get(runId)
        if (!call || call.evidence.status !== 'running') return
        const outputs = result.generations.flat().flatMap((generation) => 'message' in generation
          ? [generation.message as BaseMessage] : [])
        Object.assign(call.evidence, {
          status: 'completed', elapsedMs: Math.round(performance.now() - call.start),
          outputCount: outputs.length, outputs: outputs.slice(0, this.limits.messages).map(messageEvidence),
          messagesTruncated: call.evidence.messagesTruncated || outputs.length > this.limits.messages,
          // Multiple candidates can share provider usage; don't count it twice.
          usage: outputs.length === 1 ? latestServerTokenUsage(outputs) ?? null : null
        })
      },
      handleLLMError: (error: unknown, runId) => {
        const call = this.calls.get(runId)
        if (!call || call.evidence.status !== 'running') return
        Object.assign(call.evidence, {
          status: 'failed', elapsedMs: Math.round(performance.now() - call.start),
          error: (error instanceof Error ? error.message : String(error)).slice(0, 2000)
        })
      }
    })
    handler.awaitHandlers = true
    // A failed observer must fail the evaluation instead of silently losing evidence.
    handler.raiseError = true
    return Array.isArray(existing) ? [...existing, handler]
      : existing ? existing.copy([handler]) : [handler]
  }

  snapshot(): { trace: CodingModelTrace; tokens: CodingTokenUsage } {
    const calls = structuredClone([...this.calls.values()].map(({ evidence }) => evidence))
    const usages = calls.flatMap((call) => call.usage ? [call.usage] : [])
    const totals = usages.length ? usages.reduce((sum, usage) => ({
      inputTokens: sum.inputTokens + usage.inputTokens,
      outputTokens: sum.outputTokens + usage.outputTokens,
      totalTokens: sum.totalTokens + usage.totalTokens
    }), { inputTokens: 0, outputTokens: 0, totalTokens: 0 }) : null
    return {
      trace: { source: 'langchain-callbacks', callsTruncated: this.callsTruncated, calls },
      tokens: {
        source: 'langchain-usage-metadata',
        coverage: usages.length === 0 ? 'unavailable'
          : !this.callsTruncated && usages.length === calls.length ? 'complete' : 'partial',
        observedCalls: calls.length, callsWithUsage: usages.length, totals
      }
    }
  }
}
