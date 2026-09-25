import { AIMessage, HumanMessage, SystemMessage, mapStoredMessageToChatMessage } from '@langchain/core/messages'
import { createMiddleware, toolStrategy } from 'langchain'
import { z } from 'zod/v3'
import { toJsonSchema } from '@langchain/core/utils/json_schema'
import { codeReviewReportSchema, reviewLocations, type CodeReviewReport, type CodeReviewSnapshot } from '@shared/codeReview'
import type { AgentRunInputIntent } from './agentDatabase'
import { codeReviewPrompt, validateCodeReviewSnapshot } from './codeReview'
import { countMessagesApproximately, type LocalTokenCountingOptions } from './localTokenCounting'
import { ModelSelectionError } from './modelSelection'

export function reviewSnapshotForIntent(intent: AgentRunInputIntent | undefined): CodeReviewSnapshot | undefined {
  const value = intent?.kind === 'user' ? intent.codeReview
    : intent?.kind === 'regeneration' ? mapStoredMessageToChatMessage(intent.message).additional_kwargs.anas_code_review_scope : undefined
  return value === undefined ? undefined : validateCodeReviewSnapshot(value)
}

export function codeReviewResponseFormat(snapshot: CodeReviewSnapshot) {
  return toolStrategy({ ...toJsonSchema(codeReviewReportSchema.extend({ scope_id: z.literal(snapshot.id) })), type: 'object', additionalProperties: false,
    title: 'anas_code_review_report', description: 'Complete the review of the explicitly captured changes.' })
}

export function codeReviewReportText(report: CodeReviewReport, snapshot: CodeReviewSnapshot): string {
  const locations = reviewLocations(snapshot, report)
  return [report.summary, ...report.findings.map((finding, index) => {
    const file = snapshot.files.find((entry) => entry.id === finding.file_id)
    return `[${finding.priority}] ${finding.title}\n${file?.path ?? finding.file_id} (${finding.side}:${finding.start_line}-${finding.end_line})${locations[index].valid ? '' : ` — Unverified location: ${locations[index].reason}`}\n${finding.condition}\n${finding.impact}\n${finding.evidence}`
  }), ...snapshot.limitations, ...report.limitations].join('\n\n')
}

export function createCodeReviewMiddleware(snapshot: CodeReviewSnapshot, runId: string, getInputCapacityTokens: () => number,
  getModelTokenCountingOptions: () => LocalTokenCountingOptions) {
  const format = codeReviewResponseFormat(snapshot)
  return createMiddleware({
    name: 'AnasCodeReviewMiddleware',
    wrapModelCall: async (request, handler) => {
      // Re-project the fixed scope after native summarization. The framework
      // owns context management; a review must not silently lose its only diff.
      const prompt = codeReviewPrompt(snapshot)
      const scopeMessage = new HumanMessage(prompt)
      const tools = [...request.tools, format[0].tool] as unknown as Record<string, unknown>[]
      if (countMessagesApproximately([request.systemMessage ?? new SystemMessage(''), scopeMessage], tools,
        getModelTokenCountingOptions()) > getInputCapacityTokens() * 0.6) {
        throw new ModelSelectionError('The captured review is too large for this model. The run was stopped. Select a smaller review scope or a larger-context model.')
      }
      const hasScope = request.messages.some((message) => HumanMessage.isInstance(message) && message.text === prompt)
      const response = await handler({ ...request, messages: hasScope ? request.messages : [...request.messages, scopeMessage] })
      if (AIMessage.isInstance(response) && !response.tool_calls?.length) {
        throw new Error('The model ended the review without the required structured report. No completed review is available.')
      }
      if (response && typeof response === 'object' && 'structuredResponse' in response && 'messages' in response && Array.isArray(response.messages)) {
        const report = codeReviewReportSchema.parse(response.structuredResponse)
        if (report.scope_id !== snapshot.id) throw new Error('Code review returned a different scope.')
        const messages = response.messages
        if (messages.some((message) => AIMessage.isInstance(message) && message.tool_calls?.some((call) => call.name !== format[0].name))) {
          throw new Error('The review report must be returned separately from investigation tool calls. No completed review is available.')
        }
        const last = messages.at(-1)
        if (!last || !AIMessage.isInstance(last)) throw new Error('Code review response is missing its final framework message.')
        // Decorate the framework-produced final message in the same node update;
        // structuredResponse itself is deliberately not checkpointed upstream.
        messages[messages.length - 1] = new AIMessage({
          ...last, id: `${runId}:review-report`, content: codeReviewReportText(report, snapshot),
          additional_kwargs: { ...last.additional_kwargs, anas_run_id: runId,
            anas_created_at: new Date().toISOString(), anas_code_review: { snapshot, report } }
        })
      }
      return response
    }
  })
}

export function codeReviewPresentation(value: unknown) {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Record<string, unknown>
  const snapshot = validateCodeReviewSnapshot(candidate.snapshot)
  const report = codeReviewReportSchema.parse(candidate.report)
  if (report.scope_id !== snapshot.id) throw new Error('Stored code review report does not match its scope.')
  return { snapshot, report, locations: reviewLocations(snapshot, report) }
}
