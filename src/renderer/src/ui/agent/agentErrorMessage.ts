import {
  backgroundCallsCancelling, backgroundCleanupCompleted, backgroundCleanupStarted, backgroundCleanupUnconfirmed,
  backgroundSubagentsCancelling, backgroundTasksPendingError
} from '@shared/backgroundCleanup'

interface AgentErrorTranslator {
  (key: string, options?: { count: number }): string
}

const runModelCallLimitPattern = /^Model call limits exceeded: run level call limit reached with (\d+) model calls$/i

export function agentActionError(summary: string, error: unknown): string {
  const detail = error instanceof Error ? error.message.trim() : typeof error === 'string' ? error.trim() : ''
  return detail && detail !== summary ? `${summary}\n${detail}` : summary
}

export function localizeAgentError(message: string, t: AgentErrorTranslator): string {
  const cleanupMessages: Record<string, string> = {
    [backgroundTasksPendingError]: 'agent.background_tasks_unresolved',
    [backgroundCleanupStarted]: 'agent.background_cleanup_started',
    [backgroundCleanupCompleted]: 'agent.background_cleanup_completed',
    [backgroundCleanupUnconfirmed]: 'agent.background_cleanup_unconfirmed',
    [backgroundSubagentsCancelling]: 'agent.background_subagents_cancelling',
    [backgroundCallsCancelling]: 'agent.background_calls_cancelling'
  }
  if (message.startsWith(backgroundTasksPendingError)) {
    return message.split('\n').map((line) => {
      if (cleanupMessages[line]) return t(cleanupMessages[line])
      if (line.startsWith('Cleanup error: ')) return `${t('agent.background_cleanup_error')}: ${line.slice(15)}`
      return line.replace(/^(call_id|subagent_id)=([^:]+): (completed|failed|cancelled|uncertain|unconfirmed)/,
        (_match, kind: string, id: string, status: string) => `${kind}=${id}: ${t(`agent.background_cleanup_${status === 'completed' || status === 'unconfirmed' ? `${status}_status` : status}`)}`)
    }).join('\n')
  }
  if (message.includes('Model returned an invalid tool call.')) return t('agent.invalid_model_tool_call')
  const modelCallLimit = message.match(runModelCallLimitPattern)
  if (!modelCallLimit) return message

  return t('agent.model_call_limit_reached_with_count', {
    count: Number(modelCallLimit[1])
  })
}
