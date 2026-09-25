import type { BaseMessage } from '@langchain/core/messages'
import { createMiddleware } from 'langchain'
import { z } from 'zod'
import type { CompressionTrackingCallbacks } from './compressionTracking'
import type { AgentContextRuntime } from './contextRuntime'
import { agentContextStateSchema } from './contextStateSchema'

export const manualContextCompressionRequestStateKey =
  'anasManualContextCompressionRequest'

export interface ManualContextCompressionRequest {
  runId: string
}

const manualCompressionStateSchema = agentContextStateSchema.extend({
  [manualContextCompressionRequestStateKey]: z.object({
    runId: z.string()
  }).nullable().optional()
})

function stateMessages(state: unknown): BaseMessage[] {
  if (!state || typeof state !== 'object') return []
  const messages = (state as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return []
  return messages.filter((message): message is BaseMessage =>
    Boolean(message)
    && typeof message === 'object'
    && 'content' in message
  )
}

export function manualContextCompressionInput(
  runId: string
): Record<string, unknown> {
  return {
    messages: [],
    [manualContextCompressionRequestStateKey]: { runId }
  }
}

export function createManualContextCompressionMiddleware(options: {
  context: AgentContextRuntime
  callbacks: CompressionTrackingCallbacks
  runId?: string
}) {
  return createMiddleware({
    name: 'AnasManualContextCompressionMiddleware',
    stateSchema: manualCompressionStateSchema,
    beforeAgent: {
      canJumpTo: ['end'],
      hook: async (state, runtime) => {
        const request = state[manualContextCompressionRequestStateKey]
        if (!request) return undefined

        // A failed or cancelled compression can leave its input checkpoint as
        // the thread head. It belongs only to the run that created it.
        if (!options.runId || request.runId !== options.runId) {
          return { [manualContextCompressionRequestStateKey]: null }
        }
        if (!runtime.signal) {
          throw new Error('Manual context compression requires a cancellable graph runtime.')
        }

        const summaryId = options.callbacks.onCompressionStart?.()
        if (!summaryId) {
          throw new Error('Manual context compression requires durable summary tracking.')
        }
        try {
          const compression = await options.context.compress(state, runtime.signal)
          compression.stateEvent.summaryMessage.additional_kwargs = {
            ...compression.stateEvent.summaryMessage.additional_kwargs,
            anas_summary_id: summaryId
          }
          options.callbacks.onCompressionCompleted?.(
            summaryId,
            compression.summaryText,
            {
              modelContent: compression.modelContent,
              cutoffIndex: compression.cutoffIndex,
              activatedAfterMessageIndex: compression.activatedAfterMessageIndex,
              coveredThroughMessageId: compression.coveredThroughMessageId,
              firstPreservedMessageId: compression.firstPreservedMessageId,
              inputTokensBefore: compression.inputTokensBefore,
              inputTokensAfter: compression.inputTokensAfter,
              messages: stateMessages(state)
            }
          )
          return {
            _summarizationEvent: compression.stateEvent,
            [manualContextCompressionRequestStateKey]: null,
            jumpTo: 'end' as const
          }
        } catch (error) {
          options.callbacks.onCompressionFailed?.(summaryId)
          throw error
        }
      }
    }
  })
}
