import type { AgentRun, AgentRuntimeEvent } from '@shared/agentTypes'

function releasedRun(event: AgentRuntimeEvent): AgentRun | undefined {
  return event.type === 'run_completed'
    || event.type === 'run_failed'
    || event.type === 'run_cancelled'
    || event.type === 'run_interrupted'
    || event.type === 'run_recovery_failed'
    ? event.run
    : undefined
}

export async function *appendRunSettledEvent(
  events: AsyncIterable<AgentRuntimeEvent>
): AsyncGenerator<AgentRuntimeEvent> {
  let settledRun: AgentRun | undefined
  for await (const event of events) {
    settledRun = releasedRun(event) ?? settledRun
    yield event
  }
  if (!settledRun) return
  yield {
    type: 'run_settled',
    runId: settledRun.id,
    threadId: settledRun.threadId,
    operation: settledRun.operation,
    status: settledRun.status
  }
}
