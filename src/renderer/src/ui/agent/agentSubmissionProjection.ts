import type { AgentRunSubmission, AgentThreadSnapshot } from '@shared/agentTypes'

export function projectInitialAgentSubmission(
  current: Record<string, AgentThreadSnapshot>,
  submission: AgentRunSubmission
): Record<string, AgentThreadSnapshot> {
  const threadId = submission.thread.id
  if (current[threadId] || !submission.userMessage) return current
  return {
    ...current,
    [threadId]: {
      thread: submission.thread,
      pendingRun: submission.run,
      messages: [submission.userMessage],
      todos: [],
      interrupts: [],
      activities: [],
      messageWindow: {
        startIndex: 0,
        shown: 1,
        total: 1,
        remaining: 0
      }
    }
  }
}
