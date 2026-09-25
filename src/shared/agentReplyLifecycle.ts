import type {
  AgentMessage,
  AgentModelActivity,
  AgentRunActivity,
  AgentRuntimeEvent
} from './agentTypes'

export type AgentReplyCandidatePhase = 'idle' | 'streaming' | 'complete'

export interface AgentReplyCandidateState {
  runId?: string
  modelId?: string
  phase: AgentReplyCandidatePhase
}

export type AgentReplyCandidateAction =
  | { type: 'run_started'; runId: string }
  | { type: 'candidate_started'; runId: string; model: AgentModelActivity }
  | { type: 'candidate_delta'; runId: string; modelId: string; text: string }
  | { type: 'candidate_completed'; runId: string; model: AgentModelActivity }
  | { type: 'candidate_intermediate'; runId: string; modelId: string }
  | { type: 'candidate_final'; runId: string; message?: AgentMessage }
  | { type: 'stopped'; runId: string }

export interface AgentReplyCandidateTransition {
  state: AgentReplyCandidateState
  actions: AgentReplyCandidateAction[]
}

export const idleAgentReplyCandidate: AgentReplyCandidateState = { phase: 'idle' }

function runIdForEvent(event: AgentRuntimeEvent): string {
  return 'run' in event ? event.run.id : event.runId
}

function finalMessageForRun(
  messages: AgentMessage[],
  runId: string
): AgentMessage | undefined {
  return [...messages].reverse().find((message) =>
    message.role === 'assistant' && message.runId === runId
  )
}

function abandonCurrentCandidate(
  state: AgentReplyCandidateState
): AgentReplyCandidateAction[] {
  return state.runId && state.modelId
    ? [{ type: 'candidate_intermediate', runId: state.runId, modelId: state.modelId }]
    : []
}

export function transitionAgentReplyCandidate(
  state: AgentReplyCandidateState,
  event: AgentRuntimeEvent
): AgentReplyCandidateTransition {
  if (event.type === 'run_started') {
    if (event.run.operation !== 'agent') return { state, actions: [] }
    return {
      state: { runId: event.run.id, phase: 'idle' },
      actions: [{ type: 'run_started', runId: event.run.id }]
    }
  }

  const eventRunId = runIdForEvent(event)
  if (!state.runId || eventRunId !== state.runId) return { state, actions: [] }

  if (
    event.type === 'run_failed'
    || event.type === 'run_cancelled'
    || event.type === 'run_interrupted'
  ) {
    return {
      state: idleAgentReplyCandidate,
      actions: [
        ...abandonCurrentCandidate(state),
        { type: 'stopped', runId: eventRunId }
      ]
    }
  }

  if (event.type === 'model_started' && !event.model.subagentId) {
    return {
      state: {
        runId: eventRunId,
        modelId: event.model.id,
        phase: 'streaming'
      },
      actions: [
        ...abandonCurrentCandidate(state),
        { type: 'candidate_started', runId: eventRunId, model: event.model }
      ]
    }
  }

  if (
    event.type === 'model_delta'
    && !event.subagentId
    && event.modelId === state.modelId
    && event.delta.type === 'text'
  ) {
    return {
      state,
      actions: [{
        type: 'candidate_delta',
        runId: eventRunId,
        modelId: event.modelId,
        text: event.delta.text
      }]
    }
  }

  if (
    event.type === 'model_completed'
    && !event.model.subagentId
    && event.model.id === state.modelId
  ) {
    if (event.model.toolCallIds.length > 0) {
      return {
        state: { runId: eventRunId, phase: 'idle' },
        actions: [{
          type: 'candidate_intermediate',
          runId: eventRunId,
          modelId: event.model.id
        }]
      }
    }
    return {
      state: { ...state, phase: 'complete' },
      actions: [{ type: 'candidate_completed', runId: eventRunId, model: event.model }]
    }
  }

  const laterRootWork = (
    (event.type === 'tool_started' || event.type === 'tool_approval_requested')
    && !event.subagentId
  ) || (
    event.type === 'subagent_updated'
    && event.subagent.status === 'running'
    && !event.subagent.parentSubagentId
  )
  if (laterRootWork && state.modelId) {
    return {
      state: { runId: eventRunId, phase: 'idle' },
      actions: [{
        type: 'candidate_intermediate',
        runId: eventRunId,
        modelId: state.modelId
      }]
    }
  }

  if (event.type === 'run_completed') {
    return {
      state: idleAgentReplyCandidate,
      actions: [{
        type: 'candidate_final',
        runId: eventRunId,
        message: event.snapshot
          ? finalMessageForRun(event.snapshot.messages, eventRunId)
          : undefined
      }]
    }
  }

  return { state, actions: [] }
}

export type AgentModelReplyDisposition = 'intermediate' | 'final-candidate' | 'final'

export function agentModelReplyDisposition(
  run: AgentRunActivity,
  model: AgentModelActivity
): AgentModelReplyDisposition {
  if (model.subagentId || model.toolCallIds.length > 0) return 'intermediate'
  const laterRootWork = run.models.some((candidate) =>
    !candidate.subagentId && candidate.sequence > model.sequence
  ) || run.tools.some((tool) =>
    !tool.subagentId && tool.sequence > model.sequence
  ) || run.subagents.some((subagent) =>
    !subagent.parentSubagentId && subagent.sequence > model.sequence
  )
  if (laterRootWork) return 'intermediate'
  return run.status === 'completed' && Boolean(model.messageId)
    ? 'final'
    : 'final-candidate'
}
