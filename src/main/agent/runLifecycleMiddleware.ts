import { createMiddleware } from 'langchain'
import { z } from 'zod'

export const agentRunLifecycleStateKey = 'anasRunLifecycle'

export interface AgentRunLifecycleState {
  runId: string
  status: 'running' | 'completed'
}

const lifecycleStateSchema = z.object({
  [agentRunLifecycleStateKey]: z.object({
    runId: z.string(),
    status: z.enum(['running', 'completed'])
  }).optional()
})

export function runningAgentRunLifecycle(runId: string): AgentRunLifecycleState {
  return { runId, status: 'running' }
}

export function completedAgentRunLifecycle(runId: string): AgentRunLifecycleState {
  return { runId, status: 'completed' }
}

export function createAgentRunLifecycleMiddleware(
  runId?: string,
  beforeComplete?: () => void | Promise<void>
) {
  return createMiddleware({
    name: 'AnasRunLifecycleMiddleware',
    stateSchema: lifecycleStateSchema,
    beforeAgent: () => runId
      ? { [agentRunLifecycleStateKey]: runningAgentRunLifecycle(runId) }
      : undefined,
    // afterAgent hooks execute in reverse middleware order. AgentFactory keeps
    // this middleware first so the completed value is the final root update.
    afterAgent: async () => {
      if (!runId) return undefined
      await beforeComplete?.()
      return { [agentRunLifecycleStateKey]: completedAgentRunLifecycle(runId) }
    }
  })
}
