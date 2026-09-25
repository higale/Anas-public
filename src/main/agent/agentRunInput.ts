import { randomUUID } from 'node:crypto'
import type {
  AgentMessageRegenerateInput,
  AgentRunInput,
  AgentRunSubmissionInput,
  AgentThreadCreate
} from '@shared/agentTypes'
import { DEFAULT_WORKSPACE_PROJECT_ID } from '@shared/types'
import type { CodeReviewSnapshot } from '@shared/codeReview'

export interface AgentRunExecutionInput extends AgentRunInput {
  runId: string
  codeReview?: CodeReviewSnapshot
}

export interface AgentMessageRegenerateExecutionInput extends AgentMessageRegenerateInput {
  runId: string
}

export interface AgentRunSubmissionExecutionInput extends AgentRunInput {
  submissionId: string
  runId: string
  codeReview?: CodeReviewSnapshot
  newThread?: AgentThreadCreate & { projectId: string }
}

export function normalizeAgentRunSubmissionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error('Agent run submission requestId must be a UUIDv4.')
  }
  return value.toLowerCase()
}

export function createAgentRunSubmissionExecutionInput(
  input: AgentRunSubmissionInput
): AgentRunSubmissionExecutionInput {
  const hasThreadId = typeof input.threadId === 'string' && input.threadId.trim().length > 0
  const hasNewThread = input.newThread !== undefined
  if (hasThreadId === hasNewThread) {
    throw new Error('Agent run submission must target exactly one existing or new thread.')
  }
  const newThread = input.newThread
    ? {
        ...input.newThread,
        projectId: input.newThread.projectId?.trim() || DEFAULT_WORKSPACE_PROJECT_ID
      }
    : undefined
  return {
    submissionId: normalizeAgentRunSubmissionId(input.requestId),
    runId: randomUUID(),
    threadId: hasThreadId ? input.threadId!.trim() : randomUUID(),
    ...(newThread ? { newThread } : {}),
    text: input.text,
    ...(input.displayText === undefined ? {} : { displayText: input.displayText }),
    ...(input.content === undefined ? {} : { content: input.content }),
    ...(input.attachments === undefined ? {} : { attachments: input.attachments })
  }
}

export function createAgentMessageRegenerateExecutionInput(
  input: AgentMessageRegenerateInput
): AgentMessageRegenerateExecutionInput {
  return { ...input, runId: randomUUID() }
}
