import { interrupt } from '@langchain/langgraph'
import { randomUUID } from 'node:crypto'
import { tool, ToolInputParsingException, type StructuredToolInterface } from '@langchain/core/tools'
import { z } from 'zod/v3'
import type {
  AgentInterrupt,
  AgentInterruptResponse
} from '@shared/agentTypes'
import type { SubagentConfig } from '@shared/types'
import type { AgentSubagentCallRecord } from './agentDatabase'
import { armCurrentAgentToolEffect, currentAgentToolEffectArtifactId } from './toolEffectScope'
import {
  subagentApprovalGenerationFromResponse,
  subagentApprovalInterruptMetadata
} from './approvalGeneration'

export interface SubagentStartIdentity {
  subagentId: string
  childThreadId: string
  childRunId: string
}

export interface SubagentProcessSnapshot {
  call: AgentSubagentCallRecord
  modelRounds: number
  toolCalls: number
  activeTools: Array<{ name: string; summary?: string }>
  latestText?: string
  latestReasoning?: string
  interrupts: AgentInterrupt[]
  approvalGeneration?: string
}

export interface SubagentToolRuntime {
  start(
    request: { agentName: string; config?: SubagentConfig },
    description: string,
    identity: SubagentStartIdentity,
    armEffect: () => void
  ): Promise<SubagentProcessSnapshot>
  read(subagentId?: string): Promise<SubagentProcessSnapshot | SubagentProcessSnapshot[]>
  wait(subagentId: string, timeoutMs: number, signal?: AbortSignal): Promise<SubagentProcessSnapshot>
  cancel(subagentId: string, armEffect: () => void): Promise<SubagentProcessSnapshot>
  resume(subagentId: string, responses: AgentInterruptResponse[]): Promise<void>
  unresolvedForRun(limit?: number): AgentSubagentCallRecord[]
  resolveObserved(subagentId: string): void
  cancelRun(reason: string): Promise<void>
}

function terminal(status: AgentSubagentCallRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function serializedSnapshot(snapshot: SubagentProcessSnapshot): Record<string, unknown> {
  const call = snapshot.call
  return {
    ok: true,
    subagent_id: call.id,
    agent_name: call.agentName,
    description: call.description,
    status: call.status,
    terminal: terminal(call.status),
    model_rounds: snapshot.modelRounds,
    tool_calls: snapshot.toolCalls,
    active_tools: snapshot.activeTools,
    ...(snapshot.latestText ? { latest_text: snapshot.latestText } : {}),
    ...(snapshot.latestReasoning ? { latest_reasoning: snapshot.latestReasoning } : {}),
    ...(call.result === undefined ? {} : { result: call.result }),
    ...(call.error === undefined ? {} : { error: call.error }),
    ...(snapshot.interrupts.length === 0
      ? {}
      : { waiting_for_approval: true, approval_count: snapshot.interrupts.length }),
    created_at: call.createdAt,
    updated_at: call.updatedAt
  }
}

function parseApprovalResponse(value: unknown): AgentInterruptResponse['decisions'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Subagent approval response must be an object.')
  }
  const decisions = (value as { decisions?: unknown }).decisions
  if (!Array.isArray(decisions) || decisions.length === 0) {
    throw new Error('Subagent approval response must contain decisions.')
  }
  return decisions.map((decision) => {
    if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
      throw new Error('Subagent approval decision is invalid.')
    }
    const type = (decision as { type?: unknown }).type
    if (type === 'approve') return { type } as const
    if (type === 'reject') {
      const message = (decision as { message?: unknown }).message
      if (message !== undefined && typeof message !== 'string') {
        throw new Error('Subagent rejection message must be a string.')
      }
      return { type, ...(message === undefined ? {} : { message }) } as const
    }
    throw new Error(`Unsupported subagent approval decision: ${String(type)}.`)
  })
}

async function resumeInterruptedSubagent(
  runtime: SubagentToolRuntime,
  snapshot: SubagentProcessSnapshot
): Promise<boolean> {
  if (snapshot.call.status !== 'interrupted' || snapshot.interrupts.length === 0) return false
  if (!snapshot.approvalGeneration) {
    throw new Error(`Subagent ${snapshot.call.id} has no durable approval generation.`)
  }
  const approvalGeneration = snapshot.approvalGeneration
  const pending = snapshot.interrupts.map((item) => {
    if (!item.value || typeof item.value !== 'object' || Array.isArray(item.value)) {
      throw new Error(`Subagent interrupt ${item.id} has no approval request.`)
    }
    const value = item.value as { actionRequests?: unknown; reviewConfigs?: unknown }
    if (!Array.isArray(value.actionRequests) || value.actionRequests.length === 0) {
      throw new Error(`Subagent interrupt ${item.id} has no approval actions.`)
    }
    return {
      interruptId: item.id,
      actionRequests: value.actionRequests,
      reviewConfigs: Array.isArray(value.reviewConfigs) ? value.reviewConfigs : []
    }
  })
  const actionRequests = pending.flatMap((item) => item.actionRequests)
  const request = {
    actionRequests,
    reviewConfigs: pending.flatMap((item) => item.reviewConfigs),
    ...subagentApprovalInterruptMetadata(approvalGeneration)
  }
  let response: unknown
  do {
    response = interrupt(request)
  } while (
    subagentApprovalGenerationFromResponse(response) !== approvalGeneration
  )
  const decisions = parseApprovalResponse(response)
  if (decisions.length !== actionRequests.length) {
    throw new Error(
      `Subagent approval returned ${decisions.length} decisions for ${actionRequests.length} actions.`
    )
  }
  let offset = 0
  const responses = pending.map((item) => {
    const nextOffset = offset + item.actionRequests.length
    const response = {
      interruptId: item.interruptId,
      decisions: decisions.slice(offset, nextOffset),
      expectedGeneration: approvalGeneration
    }
    offset = nextOffset
    return response
  })
  await runtime.resume(snapshot.call.id, responses)
  return true
}

export function createSubagentTools(options: {
  runtime?: SubagentToolRuntime
  subagents: readonly SubagentConfig[]
  signal?: AbortSignal
  includeStartForRecovery?: boolean
}): StructuredToolInterface[] {
  const names = options.subagents.map((subagent) => subagent.name)
  const choices = options.subagents
    .map((subagent) => `- ${subagent.name}: ${subagent.description}`)
    .join('\n') || '- No subagents are currently configured for new launches.'
  const requireRuntime = (): SubagentToolRuntime => {
    if (!options.runtime) throw new Error('Subagent runtime is unavailable.')
    return options.runtime
  }
  const activeWaits = new Set<string>()
  const startTool = names.length > 0 || options.includeStartForRecovery
    ? [tool(async (input) => {
      const configured = options.subagents.find(
        (subagent) => subagent.name === input.agent
      )
      const identity = {
        subagentId: currentAgentToolEffectArtifactId('subagent') ?? randomUUID(),
        childThreadId: currentAgentToolEffectArtifactId('subagent-thread') ?? randomUUID(),
        childRunId: currentAgentToolEffectArtifactId('subagent-run') ?? randomUUID()
      }
      const snapshot = await requireRuntime().start(
        {
          agentName: input.agent,
          ...(configured ? { config: configured } : {})
        },
        input.description,
        identity,
        () => armCurrentAgentToolEffect({
          kind: 'subagent-start',
          target: identity,
          recoveryMode: 'idempotent'
        })
      )
      return JSON.stringify(serializedSnapshot(snapshot))
    }, {
      name: 'start_subagent',
      description: `Start one configured subagent in an independent background run and return its subagent_id immediately. Use wait_subagent when its result is required. Run subagents in parallel only for independent work; do not assign overlapping writes to the same files. Available subagents:\n${choices}`,
      schema: z.object({
        agent: z.string().trim().regex(
          /^[a-z0-9]+(?:-[a-z0-9]+)*$/
        ).max(64).describe(
          `Configured subagent to start. Currently available: ${names.join(', ') || 'none'}.`
        ),
        description: z.string().trim().min(1).describe('Complete, self-contained instruction for the subagent.')
      })
    })]
    : []
  return [
    ...startTool,
    tool(async (input) => {
      const result = await requireRuntime().read(input.subagent_id)
      return JSON.stringify(Array.isArray(result)
        ? { ok: true, subagents: result.map(serializedSnapshot) }
        : serializedSnapshot(result))
    }, {
      name: 'read_subagent',
      description: 'Read current subagent status and structured process details without waiting. Pass subagent_id for one direct child, or omit it to list every subagent in the current run that still requires attention, including terminal results not yet observed.',
      schema: z.object({
        subagent_id: z.string().uuid().optional().describe('Exact subagent ID. Omit to list all subagents in this conversation.')
      })
    }),
    tool(async (input) => {
      const runtime = requireRuntime()
      if (activeWaits.has(input.subagent_id)) {
        throw new ToolInputParsingException(`Subagent ${input.subagent_id} already has an active wait. Wait for that call to return, or use read_subagent to inspect status.`)
      }
      activeWaits.add(input.subagent_id)
      try {
        let snapshot = await runtime.wait(
          input.subagent_id,
          (input.timeout ?? 30) * 1_000,
          options.signal
        )
        if (await resumeInterruptedSubagent(runtime, snapshot)) {
          snapshot = await runtime.wait(
            input.subagent_id,
            (input.timeout ?? 30) * 1_000,
            options.signal
          )
        }
        return JSON.stringify(serializedSnapshot(snapshot))
      } finally {
        activeWaits.delete(input.subagent_id)
      }
    }, {
      name: 'wait_subagent',
      description: 'Wait until a subagent changes state, completes, fails, needs approval, or the requested timeout expires. Approval is surfaced to the user and resumes the same subagent run.',
      schema: z.object({
        subagent_id: z.string().uuid().describe('Exact subagent ID.'),
        timeout: z.number().int().min(10).max(300).optional().describe('Maximum wait in seconds. Default 30; range 10 through 300.')
      })
    }),
    tool(async (input) => {
      const runtime = requireRuntime()
      return JSON.stringify(serializedSnapshot(
        await runtime.cancel(input.subagent_id, () => armCurrentAgentToolEffect({
          kind: 'subagent-cancel',
          target: { subagentId: input.subagent_id },
          recoveryMode: 'idempotent'
        }))
      ))
    }, {
      name: 'cancel_subagent',
      description: 'Cancel one exact background subagent owned by the current conversation. Cancellation is idempotent.',
      schema: z.object({
        subagent_id: z.string().uuid().describe('Exact subagent ID to cancel.')
      })
    })
  ]
}
