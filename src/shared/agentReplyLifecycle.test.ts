import { describe, expect, it } from 'vitest'
import type { AgentRuntimeEvent, AgentThreadSnapshot } from './agentTypes'
import {
  idleAgentReplyCandidate,
  transitionAgentReplyCandidate
} from './agentReplyLifecycle'

const run = {
  id: 'run-1',
  threadId: 'thread-1',
  operation: 'agent' as const,
  status: 'running' as const,
  createdAt: '',
  updatedAt: ''
}

const userMessage = {
  id: 'run-1:input',
  role: 'user' as const,
  runId: 'run-1',
  content: [{ type: 'text' as const, text: 'Question' }]
}

const model = {
  id: 'model-1',
  sequence: 1,
  status: 'running' as const,
  text: '',
  reasoning: '',
  toolCallIds: []
}

function snapshot(): AgentThreadSnapshot {
  return {
    thread: {
      id: 'thread-1',
      title: 'Thread',
      projectId: 'default-workspace',
      pinned: false,
      accessMode: 'read_only_allowed',
      status: 'idle',
      userTurnCount: 1,
      createdAt: '',
      updatedAt: ''
    },
    messages: [{
      id: 'assistant-1',
      role: 'assistant',
      runId: 'run-1',
      content: [{ type: 'text', text: 'Final' }]
    }],
    todos: [],
    interrupts: [],
    activities: [],
    messageWindow: { startIndex: 0, shown: 1, total: 1, remaining: 0 }
  }
}

function apply(events: AgentRuntimeEvent[]) {
  let state = idleAgentReplyCandidate
  const actions = []
  for (const event of events) {
    const transition = transitionAgentReplyCandidate(state, event)
    state = transition.state
    actions.push(...transition.actions)
  }
  return { state, actions }
}

describe('transitionAgentReplyCandidate', () => {
  it('streams and confirms the final root model without replaying its text', () => {
    const result = apply([{
      type: 'run_started', run, newUserTurn: true, userMessage
    }, {
      type: 'model_started', runId: 'run-1', threadId: 'thread-1', model
    }, {
      type: 'model_delta', runId: 'run-1', threadId: 'thread-1', modelId: 'model-1',
      delta: { type: 'text', text: 'Final' }
    }, {
      type: 'model_completed', runId: 'run-1', threadId: 'thread-1',
      model: { ...model, status: 'completed', text: 'Final' }
    }, {
      type: 'run_completed',
      run: { ...run, status: 'completed' },
      snapshot: snapshot()
    }])

    expect(result.actions.map((action) => action.type)).toEqual([
      'run_started',
      'candidate_started',
      'candidate_delta',
      'candidate_completed',
      'candidate_final'
    ])
    expect(result.actions.at(-1)).toMatchObject({
      type: 'candidate_final',
      message: { id: 'assistant-1' }
    })
    expect(result.state).toEqual(idleAgentReplyCandidate)
  })

  it('marks a tool-calling reply as intermediate and ignores subagent deltas', () => {
    const result = apply([{
      type: 'run_started', run, newUserTurn: true, userMessage
    }, {
      type: 'model_started', runId: 'run-1', threadId: 'thread-1', model
    }, {
      type: 'model_delta', runId: 'run-1', threadId: 'thread-1', modelId: 'child',
      subagentId: 'subagent-1', delta: { type: 'text', text: 'Child' }
    }, {
      type: 'model_completed', runId: 'run-1', threadId: 'thread-1',
      model: { ...model, status: 'completed', toolCallIds: ['tool-1'] }
    }])

    expect(result.actions.map((action) => action.type)).toEqual([
      'run_started',
      'candidate_started',
      'candidate_intermediate'
    ])
  })

  it('abandons an apparently complete candidate when later root work starts', () => {
    const result = apply([{
      type: 'run_started', run, newUserTurn: true, userMessage
    }, {
      type: 'model_started', runId: 'run-1', threadId: 'thread-1', model
    }, {
      type: 'model_completed', runId: 'run-1', threadId: 'thread-1',
      model: { ...model, status: 'completed', text: 'Maybe final' }
    }, {
      type: 'tool_started', runId: 'run-1', threadId: 'thread-1',
      call: { id: 'tool-1', name: 'search', args: {} }, sequence: 2
    }])

    expect(result.actions.at(-1)).toMatchObject({ type: 'candidate_intermediate' })
    expect(result.state).toEqual({ runId: 'run-1', phase: 'idle' })
  })

  it('treats a newly running root subagent as later root work', () => {
    const result = apply([{
      type: 'run_started', run, newUserTurn: true, userMessage
    }, {
      type: 'model_started', runId: 'run-1', threadId: 'thread-1', model
    }, {
      type: 'model_completed', runId: 'run-1', threadId: 'thread-1',
      model: { ...model, status: 'completed', text: 'Maybe final' }
    }, {
      type: 'subagent_updated',
      runId: 'run-1',
      threadId: 'thread-1',
      subagent: {
        id: 'subagent-1',
        name: 'reviewer',
        sequence: 2,
        status: 'running'
      }
    }])

    expect(result.actions.at(-1)).toMatchObject({ type: 'candidate_intermediate' })
    expect(result.state).toEqual({ runId: 'run-1', phase: 'idle' })
  })
})
