import { agentModelReplyDisposition } from './agentReplyLifecycle'
import type { AgentBackgroundCleanup } from './backgroundCleanup'
import {
  delegationToolForSubagent,
  visibleToolsForAgent
} from './agentActivity'
import type {
  AgentContextSummary,
  AgentMessage,
  AgentMemoryRecall,
  AgentModelActivity,
  AgentRunActivity,
  AgentSkillInvocation,
  AgentSubagentActivity,
  AgentToolActivity,
  AgentToolCallProgress
} from './agentTypes'

export interface TurnTimelineSummaryItem {
  type: 'summary'
  key: string
  summary: AgentContextSummary
  number: number
}

export interface TurnTimelineMessageItem {
  type: 'message'
  key: string
  message: AgentMessage
  roundUserMessageId?: string
}

export interface TurnTimelineModelItem {
  type: 'model'
  key: string
  model: AgentModelActivity
  round?: number
  showText: boolean
}

export interface TurnTimelineToolItem {
  type: 'tool'
  key: string
  tool: AgentToolActivity
  progress?: AgentToolCallProgress
}

export interface TurnTimelineSubagentItem {
  type: 'subagent'
  key: string
  subagent: AgentSubagentActivity
}

export interface TurnTimelineSkillItem {
  type: 'skill'
  key: string
  invocation: AgentSkillInvocation
}

export interface TurnTimelineMemoryItem {
  type: 'memory'
  key: string
  recall: AgentMemoryRecall
}

export interface TurnTimelineDirectionItem {
  type: 'direction'
  key: string
  message: AgentMessage
}

export interface TurnTimelineErrorItem {
  type: 'error'
  key: string
  message: string
}

export interface TurnTimelineCleanupItem {
  type: 'cleanup'
  key: string
  cleanup: AgentBackgroundCleanup
}

export type TurnTimelineActivityItem =
  | TurnTimelineModelItem
  | TurnTimelineToolItem
  | TurnTimelineSubagentItem
  | TurnTimelineSummaryItem
  | TurnTimelineSkillItem
  | TurnTimelineMemoryItem
  | TurnTimelineDirectionItem

export interface TurnTimelineActivityRange {
  type: 'activity-range'
  key: string
  run: AgentRunActivity
  items: TurnTimelineActivityItem[]
  finalMessageId?: string
  startsExpanded: boolean
  modelCount: number
  toolCount: number
  subagentCount: number
}

export type TurnTimelineEntry =
  | TurnTimelineMessageItem
  | TurnTimelineSummaryItem
  | TurnTimelineActivityRange
  | TurnTimelineErrorItem
  | TurnTimelineCleanupItem

export interface TurnTimeline {
  entries: TurnTimelineEntry[]
}

function finalMessageId(
  run: AgentRunActivity,
  messages: AgentMessage[]
): string | undefined {
  if (run.status !== 'completed') return undefined
  const messageId = [...run.models]
    .filter((model) =>
      !model.subagentId
      && agentModelReplyDisposition(run, model) === 'final'
    )
    .sort((left, right) => left.sequence - right.sequence)
    .at(-1)?.messageId
  return messageId && messages.some((message) =>
    message.id === messageId
    && message.role === 'assistant'
    && message.runId === run.runId
  )
    ? messageId
    : undefined
}

function anchorIndex(run: AgentRunActivity, messages: AgentMessage[]): number {
  let result = -1
  messages.forEach((message, index) => {
    if (
      message.role === 'user'
      && message.runId === run.runId
      && !message.directionAfterToolCallIds?.length
    ) result = index
  })
  return result
}

function finalResponseIndex(run: AgentRunActivity, messages: AgentMessage[]): number {
  const messageId = finalMessageId(run, messages)
  if (!messageId) return -1
  return messages.findIndex((message) => message.id === messageId)
}

function skillInvocationForRun(
  run: AgentRunActivity,
  messages: AgentMessage[]
): AgentSkillInvocation | undefined {
  const optimisticInput = messages.find((message) => message.id === `${run.runId}:input`)
    ?.skillInvocation
  if (optimisticInput) return optimisticInput
  const anchor = anchorIndex(run, messages)
  for (let index = anchor >= 0 ? anchor : messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'user') return message.skillInvocation
  }
  return undefined
}

export function projectRunActivityItems(
  run: AgentRunActivity,
  summaryNumbers: ReadonlyMap<string, number>,
  messages: AgentMessage[],
  agentId?: string
): TurnTimelineActivityItem[] {
  const items: Array<TurnTimelineActivityItem & { sequence: number; priority: number }> = []
  const models = run.models
    .filter((model) => model.subagentId === agentId)
    .sort((left, right) => left.sequence - right.sequence)
  // Provider call IDs may arrive after the first argument chunk. Use the tool's
  // position in its model response for both the progress and executed card.
  const modelToolKey = (model: AgentModelActivity, index: number) =>
    `model-tool:${agentId ?? 'root'}:${model.id}:${index}`
  const toolKeys = new Map<string, string>()
  for (const model of models) {
    model.toolCallProgress?.forEach((progress, index) => {
      if (progress.callId) toolKeys.set(progress.callId, modelToolKey(model, index))
    })
    model.toolCallIds.forEach((callId, index) => toolKeys.set(callId, modelToolKey(model, index)))
  }
  models.forEach((model) => {
    // A checkpoint message owns its visible body even if later supervision or
    // cleanup fails the run. Activity retains reasoning and uncommitted text.
    const messageVisible = !agentId && messages.some((message) =>
      message.id === model.messageId
      && message.role === 'assistant'
      && message.runId === run.runId
    )
    if (messageVisible && !model.reasoning) return
    if (!model.reasoning && !model.text && model.toolCallIds.length === 0 && model.status !== 'running') {
      return
    }
    items.push({
      type: 'model',
      key: `model:${agentId ?? 'root'}:${model.id}`,
      model,
      round: model.round,
      showText: !messageVisible,
      sequence: model.sequence,
      priority: 1
    })
  })
  visibleToolsForAgent(run, agentId)
    .forEach((tool) => items.push({
      type: 'tool',
      key: toolKeys.get(tool.call.id) ?? `tool:${agentId ?? 'root'}:${tool.call.id}`,
      tool,
      sequence: tool.sequence,
      priority: 2
    }))
  // Drafts belong to the model round, not the executed-tool history.
  // Suppress them as soon as the real call arrives, including hidden delegation calls.
  if (agentId
    ? run.subagents.some((subagent) => subagent.id === agentId && subagent.status === 'running')
    : run.status === 'running') {
    for (const model of models) {
      for (const [index, progress] of (model.toolCallProgress ?? []).entries()) {
        if (run.tools.some((tool) => tool.subagentId === agentId && tool.call.id === progress.callId)) continue
        const callId = progress.callId ?? `${model.id}:draft:${progress.index}`
        items.push({
          type: 'tool',
          key: modelToolKey(model, index),
          tool: {
            call: { id: callId, name: progress.name, args: undefined },
            sequence: model.sequence,
            status: 'running',
            subagentId: agentId
          },
          progress,
          sequence: model.sequence,
          priority: 2
        })
      }
    }
  }
  run.subagents
    .filter((subagent) => subagent.parentSubagentId === agentId)
    .forEach((subagent) => items.push({
      type: 'subagent',
      key: `subagent:${subagent.id}`,
      subagent,
      sequence: delegationToolForSubagent(run, subagent)?.sequence ?? subagent.sequence,
      priority: 3
    }))
  if (!agentId) {
    for (const recall of run.memoryRecalls ?? []) {
      items.push({
        type: 'memory',
        key: `memory:${recall.id}`,
        recall,
        sequence: recall.sequence,
        priority: 0
      })
    }
    for (const summary of run.summaries ?? []) {
      if (summary.firstPreservedActivitySequence === undefined) continue
      items.push({
        type: 'summary',
        key: `summary:${summary.id}`,
        summary,
        number: summaryNumbers.get(summary.id) ?? 1,
        sequence: summary.firstPreservedActivitySequence,
        priority: 0
      })
    }
    const invocation = skillInvocationForRun(run, messages)
    if (invocation) {
      items.push({
        type: 'skill',
        key: `skill:${run.runId}`,
        invocation,
        sequence: Number.NEGATIVE_INFINITY,
        priority: 0
      })
    }
    const fallbackDirectionSequence = Math.max(
      -1,
      ...run.models.map((model) => model.sequence),
      ...run.tools.map((tool) => tool.sequence),
      ...run.subagents.map((subagent) => subagent.sequence),
      ...(run.memoryRecalls ?? []).map((recall) => recall.sequence),
      ...(run.summaries ?? []).map((summary) => summary.sequence)
    )
    for (const message of messages) {
      if (message.runId !== run.runId || !message.directionAfterToolCallIds?.length) continue
      const toolIds = new Set(message.directionAfterToolCallIds)
      const matchingSequences = run.tools
        .filter((tool) => toolIds.has(tool.call.id))
        .map((tool) => tool.sequence)
      items.push({
        type: 'direction',
        key: `direction:${message.id}`,
        message,
        sequence: matchingSequences.length > 0
          ? Math.max(...matchingSequences)
          : fallbackDirectionSequence,
        priority: 4
      })
    }
  }
  return items
    .sort((left, right) => left.sequence - right.sequence || left.priority - right.priority)
    .map(({ sequence: _sequence, priority: _priority, ...item }) => item)
}

function projectRange(
  run: AgentRunActivity,
  summaryNumbers: ReadonlyMap<string, number>,
  messages: AgentMessage[]
): TurnTimelineActivityRange | undefined {
  if (
    run.operation === 'compression'
    && run.status !== 'failed'
    && run.status !== 'interrupted'
  ) return undefined
  const items = projectRunActivityItems(run, summaryNumbers, messages)
  const finalId = finalMessageId(run, messages)
  if (items.length === 0 && finalId && !run.activityWindow?.hasEarlier) return undefined
  return {
    type: 'activity-range',
    key: `range:${run.runId}`,
    run,
    items,
    finalMessageId: finalId,
    startsExpanded: run.status !== 'completed' || !finalId,
    modelCount: run.models.filter((model) => !model.subagentId).length,
    toolCount: visibleToolsForAgent(run).length,
    subagentCount: run.subagents.filter((subagent) => !subagent.parentSubagentId).length
  }
}

function appendToMap<T>(map: Map<number, T[]>, index: number, value: T): void {
  map.set(index, [...(map.get(index) ?? []), value])
}

export function projectTurnTimeline(
  messages: AgentMessage[],
  activities: AgentRunActivity[],
  liveRun?: AgentRunActivity
): TurnTimeline {
  const visibleRuns = [
    ...activities.filter((activity) => activity.runId !== liveRun?.runId),
    ...(liveRun ? [liveRun] : [])
  ]
  const summaries = visibleRuns.flatMap((run) => run.summaries ?? [])
  const summaryNumbers = new Map(summaries.map((summary, index) => [summary.id, index + 1]))
  const beforeMessage = new Map<number, TurnTimelineEntry[]>()
  const afterMessage = new Map<number, TurnTimelineEntry[]>()
  const trailing: TurnTimelineEntry[] = []

  for (const run of visibleRuns) {
    for (const summary of run.summaries ?? []) {
      if (summary.firstPreservedActivitySequence !== undefined) continue
      const entry: TurnTimelineSummaryItem = {
        type: 'summary',
        key: `summary:${summary.id}`,
        summary,
        number: summaryNumbers.get(summary.id) ?? 1
      }
      if (summary.status === 'completed' && summary.coveredThroughMessageId) {
        const index = messages.findIndex((message) => message.id === summary.coveredThroughMessageId)
        if (index >= 0) {
          appendToMap(afterMessage, index, entry)
          continue
        }
      }
      if (summary.status === 'completed' && summary.firstPreservedMessageId) {
        const index = messages.findIndex((message) => message.id === summary.firstPreservedMessageId)
        if (index >= 0) {
          appendToMap(beforeMessage, index, entry)
          continue
        }
      }
      trailing.push(entry)
    }

    const range = projectRange(run, summaryNumbers, messages)
    if (range) {
      const finalIndex = finalResponseIndex(run, messages)
      const anchor = anchorIndex(run, messages)
      if (finalIndex >= 0) appendToMap(beforeMessage, finalIndex, range)
      else if (anchor >= 0) appendToMap(afterMessage, anchor, range)
      else trailing.push(range)
    }
    const reports: Array<TurnTimelineErrorItem | TurnTimelineCleanupItem> = []
    if (run.error) reports.push({ type: 'error', key: `error:${run.runId}`, message: run.error })
    if (run.backgroundCleanup) reports.push({ type: 'cleanup', key: `cleanup:${run.runId}`, cleanup: run.backgroundCleanup })
    // Runtime reports follow this turn's messages, independently of its activities.
    const lastMessage = messages.map((message) => message.runId).lastIndexOf(run.runId)
    for (const report of reports) {
      if (lastMessage >= 0) appendToMap(afterMessage, lastMessage, report)
      else trailing.push(report)
    }
  }

  const entries: TurnTimelineEntry[] = []
  let currentUserMessageId: string | undefined
  messages.forEach((message, index) => {
    entries.push(...(beforeMessage.get(index) ?? []))
    if (!message.directionAfterToolCallIds?.length) {
      if (message.role === 'user') currentUserMessageId = message.id
      entries.push({
        type: 'message',
        key: `message:${message.id}`,
        message,
        roundUserMessageId: message.role === 'user' ? message.id : currentUserMessageId
      })
    }
    entries.push(...(afterMessage.get(index) ?? []))
  })
  entries.push(...trailing)
  return { entries }
}
