import { describe, expect, it } from 'vitest'
import type {
  AgentMessageRegenerateInput,
  AgentRunSubmissionInput
} from '@shared/agentTypes'
import { DEFAULT_WORKSPACE_PROJECT_ID } from '@shared/types'
import {
  createAgentMessageRegenerateExecutionInput,
  createAgentRunSubmissionExecutionInput,
  normalizeAgentRunSubmissionId
} from './agentRunInput'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

describe('main-process run input', () => {
  it('assigns a new run ID instead of accepting an extra renderer field for regeneration', () => {
    const input = {
      threadId: 'thread-1',
      messageId: 'message-1',
      runId: 'renderer-controlled'
    } satisfies AgentMessageRegenerateInput & { runId: string }

    const execution = createAgentMessageRegenerateExecutionInput(input)

    expect(execution).toMatchObject({ threadId: 'thread-1', messageId: 'message-1' })
    expect(execution.runId).toMatch(uuidPattern)
    expect(execution.runId).not.toBe(input.runId)
  })

  it('keeps the submission id separate while assigning main-process run and thread IDs', () => {
    const requestId = '718b5ec8-dbb4-4bd2-8dd0-d9073f14185d'
    const execution = createAgentRunSubmissionExecutionInput({
      requestId,
      newThread: { title: 'Atomic submission', projectId: 'project-1', modelConfigId: 'model-config-1' },
      text: 'Start once'
    })

    expect(execution).toMatchObject({
      submissionId: requestId,
      newThread: {
        title: 'Atomic submission',
        projectId: 'project-1',
        modelConfigId: 'model-config-1'
      },
      text: 'Start once'
    })
    expect(execution.runId).toMatch(uuidPattern)
    expect(execution.threadId).toMatch(uuidPattern)
    expect(execution.runId).not.toBe(requestId)
    expect(execution.threadId).not.toBe(requestId)
  })

  it('uses the default workspace when a new thread has no selected project', () => {
    const requestId = '718b5ec8-dbb4-4bd2-8dd0-d9073f14185d'

    expect(createAgentRunSubmissionExecutionInput({
      requestId,
      newThread: {},
      text: 'No project selected'
    }).newThread?.projectId).toBe(DEFAULT_WORKSPACE_PROJECT_ID)
    expect(createAgentRunSubmissionExecutionInput({
      requestId,
      newThread: { projectId: '   ' },
      text: 'Blank project selection'
    }).newThread?.projectId).toBe(DEFAULT_WORKSPACE_PROJECT_ID)
  })

  it('rejects invalid or ambiguous submission identities and targets', () => {
    expect(() => normalizeAgentRunSubmissionId('renderer-controlled')).toThrow('UUIDv4')
    expect(() => createAgentRunSubmissionExecutionInput({
      requestId: '718b5ec8-dbb4-4bd2-8dd0-d9073f14185d',
      text: 'Missing target'
    } as unknown as AgentRunSubmissionInput)).toThrow('exactly one')
    expect(() => createAgentRunSubmissionExecutionInput({
      requestId: '718b5ec8-dbb4-4bd2-8dd0-d9073f14185d',
      threadId: 'thread-1',
      newThread: { projectId: 'default-workspace' },
      text: 'Ambiguous target'
    } as unknown as AgentRunSubmissionInput)).toThrow('exactly one')
  })
})
