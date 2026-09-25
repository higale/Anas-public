import { describe, expect, it } from 'vitest'
import type { AgentMessage, AgentRunSubmission, AgentThreadSnapshot } from '@shared/agentTypes'
import { projectInitialAgentSubmission } from './agentSubmissionProjection'

function submission(): AgentRunSubmission & { userMessage: AgentMessage } {
  return {
    thread: {
      id: 'thread-1',
      title: 'First message',
      projectId: 'default-workspace',
      pinned: false,
      accessMode: 'read_only_allowed',
      status: 'running',
      userTurnCount: 1,
      createdAt: '2026-08-15T15:00:00.000Z',
      updatedAt: '2026-08-15T15:00:00.000Z'
    },
    run: {
      id: 'run-1',
      threadId: 'thread-1',
      operation: 'agent',
      status: 'running',
      createdAt: '2026-08-15T15:00:00.000Z',
      updatedAt: '2026-08-15T15:00:00.000Z'
    },
    userMessage: {
      id: 'run-1:input',
      role: 'user',
      runId: 'run-1',
      content: [{ type: 'text', text: 'Show immediately' }]
    }
  }
}

describe('initial agent submission projection', () => {
  it('shows the first user message before a checkpoint snapshot exists', () => {
    const projected = projectInitialAgentSubmission({}, submission())

    expect(projected['thread-1']).toMatchObject({
      pendingRun: { id: 'run-1' },
      messages: [{ id: 'run-1:input', role: 'user' }],
      messageWindow: { shown: 1, total: 1, remaining: 0 }
    })
  })

  it('does not replace a snapshot already delivered by a terminal event', () => {
    const authoritative = {
      thread: { ...submission().thread, status: 'idle' },
      messages: [submission().userMessage, {
        id: 'assistant-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'Done' }]
      }],
      todos: [],
      interrupts: [],
      activities: [],
      messageWindow: { startIndex: 0, shown: 2, total: 2, remaining: 0 }
    } satisfies AgentThreadSnapshot
    const current = { 'thread-1': authoritative }

    expect(projectInitialAgentSubmission(current, submission())).toBe(current)
  })

  it('leaves snapshot loading to the fallback path for a durable replay', () => {
    const source = submission()
    const replay: AgentRunSubmission = { thread: source.thread, run: source.run }
    const current = {}

    expect(projectInitialAgentSubmission(current, replay)).toBe(current)
  })
})
