export const agentErrorCodes = {
  threadLocked: 'AGENT_THREAD_LOCKED'
} as const

export class AgentThreadLockedError extends Error {
  readonly code = agentErrorCodes.threadLocked

  constructor(threadId: string, action: string) {
    super(`Thread ${threadId} is busy and cannot ${action} until its active run is resolved.`)
    this.name = 'AgentThreadLockedError'
  }
}
