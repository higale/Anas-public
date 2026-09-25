export const backgroundTasksPendingError = 'The model returned a final answer while background tasks remain unresolved.'
export const backgroundCleanupStarted = 'Cleaning up unresolved background tasks.'
export const backgroundCallsCancelling = 'Cancelling active background calls.'
export const backgroundSubagentsCancelling = 'Cancelling active background subagents.'
export const backgroundCleanupCompleted = 'Background cleanup completed.'
export const backgroundCleanupUnconfirmed = 'Background cleanup finished with unconfirmed outcomes.'

export interface AgentBackgroundCleanup {
  status: 'running' | 'completed' | 'unconfirmed'
  report: string
}
