import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  ToolMessage
} from '@langchain/core/messages'
import type { AgentContentBlock, AgentMessage, AgentToolCall } from '@shared/agentTypes'
import { parseSlashSkillInput } from '@shared/skillShortcuts'
import { codeReviewPresentation } from './codeReviewMiddleware'

const displayTextKey = 'anas_display_text'
const runIdKey = 'anas_run_id'
const createdAtKey = 'anas_created_at'
const directionAfterToolCallIdsKey = 'anas_direction_after_tool_call_ids'
const skillContextKey = 'anas_skill_context'

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((item): item is string => typeof item === 'string' && Boolean(item))
  return strings.length > 0 ? strings : undefined
}

function byteData(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  return undefined
}

function reasoningSummary(value: Record<string, unknown>): string | undefined {
  if (!Array.isArray(value.summary)) return undefined
  const text = value.summary.flatMap((part) => {
    const item = asRecord(part)
    return typeof item.text === 'string' && item.text.trim() ? [item.text] : []
  }).join('\n').trim()
  return text || undefined
}

function contentBlock(block: unknown): AgentContentBlock | undefined {
  const value = asRecord(block)
  switch (value.type) {
    case 'text':
      return typeof value.text === 'string' ? { type: 'text', text: value.text } : undefined
    case 'reasoning': {
      const summary = reasoningSummary(value)
      return typeof value.reasoning === 'string'
        ? {
            type: 'reasoning',
            text: value.reasoning,
            ...(summary ? { summary } : {})
          }
        : undefined
    }
    case 'image':
      return {
        type: 'image',
        mimeType: stringValue(value.mimeType),
        data: byteData(value.data),
        url: stringValue(value.url)
      }
    case 'file':
      return {
        type: 'file',
        name: stringValue(asRecord(value.metadata).filename)
          ?? stringValue(asRecord(value.metadata).name)
          ?? 'file',
        mimeType: stringValue(value.mimeType),
        data: byteData(value.data),
        url: stringValue(value.url)
      }
    case 'text-plain':
      return typeof value.text === 'string' ? { type: 'text', text: value.text } : undefined
    case 'tool_call':
    case 'tool_call_chunk':
      return undefined
    case 'non_standard':
      return { type: 'json', value: value.value }
    default:
      return { type: 'json', value: block }
  }
}

function role(message: BaseMessage): AgentMessage['role'] {
  switch (message.type) {
    case 'human': return 'user'
    case 'ai': return 'assistant'
    case 'tool': return 'tool'
    default: return 'system'
  }
}

function toolCalls(message: BaseMessage): AgentToolCall[] | undefined {
  if (!AIMessage.isInstance(message) || !message.tool_calls?.length) return undefined
  return message.tool_calls.map((call) => ({
    id: call.id ?? `${message.id ?? 'message'}:${call.name}`,
    name: call.name,
    args: call.args
  }))
}

export function toAgentMessage(message: BaseMessage, fallbackId: string): AgentMessage {
  let blocks = message.contentBlocks
    .map(contentBlock)
    .filter((block): block is AgentContentBlock => Boolean(block))
  const promptText = blocks.find(
    (block): block is Extract<AgentContentBlock, { type: 'text' }> => block.type === 'text'
  )?.text ?? message.text
  const displayText = role(message) === 'user' && message.additional_kwargs.anas_code_review_scope === undefined
    ? stringValue(message.additional_kwargs[displayTextKey])
    : undefined
  const skillShortcut = displayText ? parseSlashSkillInput(displayText) : undefined
  if (displayText) {
    const firstText = blocks.findIndex((block) => block.type === 'text')
    if (firstText >= 0) {
      blocks = blocks.map((block, index) =>
        index === firstText ? { type: 'text', text: displayText } : block
      )
    } else {
      blocks = [{ type: 'text', text: displayText }, ...blocks]
    }
  }
  const mapped: AgentMessage = {
    id: message.id ?? fallbackId,
    role: role(message),
    content: blocks.length || !message.text ? blocks : [{ type: 'text', text: message.text }],
    name: message.name,
    toolCalls: toolCalls(message)
  }
  const runId = stringValue(message.additional_kwargs[runIdKey])
  const createdAt = stringValue(message.additional_kwargs[createdAtKey])
  const directionAfterToolCallIds = stringArray(
    message.additional_kwargs[directionAfterToolCallIdsKey]
  )
  if (runId) mapped.runId = runId
  if (createdAt) mapped.createdAt = createdAt
  if (directionAfterToolCallIds) mapped.directionAfterToolCallIds = directionAfterToolCallIds
  if (skillShortcut && promptText) {
    mapped.skillInvocation = {
      ...skillShortcut,
      promptText
    }
  }
  if (ToolMessage.isInstance(message)) mapped.toolCallId = message.tool_call_id
  if (AIMessage.isInstance(message) && message.additional_kwargs.anas_code_review !== undefined) {
    mapped.codeReview = codeReviewPresentation(message.additional_kwargs.anas_code_review)
  }
  return mapped
}

function toLangChainContent(block: AgentContentBlock): unknown {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'image': {
      const url = block.url
        ?? (block.data
          ? `data:${block.mimeType ?? 'image/png'};base64,${block.data}`
          : undefined)
      if (!url) return { type: 'text', text: '[Image unavailable]' }
      return {
        type: 'image_url',
        image_url: {
          url,
          detail: 'auto'
        }
      }
    }
    case 'file':
      if (!block.url) return { type: 'text', text: `[Attached file: ${block.name}]` }
      return {
        type: 'file_url',
        file_url: { url: block.url },
        mime_type: block.mimeType
      }
    case 'reasoning':
      return { type: 'text', text: block.text }
    case 'json':
      return { type: 'text', text: JSON.stringify(block.value) }
  }
}

export function toHumanMessage(
  text: string,
  content: AgentContentBlock[] | undefined,
  displayText?: string,
  metadata?: {
    id?: string
    runId?: string
    createdAt?: string
    directionAfterToolCallIds?: string[]
  }
): HumanMessage {
  const blocks: unknown[] = []
  if (text) blocks.push({ type: 'text', text })
  for (const block of content ?? []) {
    if (block.type === 'text' && block.text === text) continue
    blocks.push(toLangChainContent(block))
  }
  const additional_kwargs = {
    ...(displayText && displayText !== text ? { [displayTextKey]: displayText } : {}),
    ...(metadata?.runId ? { [runIdKey]: metadata.runId } : {}),
    ...(metadata?.createdAt ? { [createdAtKey]: metadata.createdAt } : {}),
    ...(metadata?.directionAfterToolCallIds?.length
      ? { [directionAfterToolCallIdsKey]: metadata.directionAfterToolCallIds }
      : {})
  }
  return new HumanMessage({
    id: metadata?.id,
    content: blocks.length === 1 && text && (!content || content.length === 0)
      ? text
      : blocks as never,
    additional_kwargs
  })
}

/** Project one persisted Skill invocation into Codex-style user and Skill messages. */
export function projectSkillMessages(messages: BaseMessage[]): BaseMessage[] {
  return messages.flatMap((message): BaseMessage[] => {
    if (!HumanMessage.isInstance(message) || message.additional_kwargs.anas_code_review_scope !== undefined) return [message]
    const displayText = stringValue(message.additional_kwargs[displayTextKey])
    if (!displayText || !parseSlashSkillInput(displayText)) return [message]
    const content = typeof message.content === 'string'
      ? [{ type: 'text' as const, text: message.content }]
      : message.content
    const first = content[0]
    if (!first || typeof first !== 'object' || first.type !== 'text' || typeof first.text !== 'string') return [message]
    // The exact shortcut prefix determines the boundary; never parse tags in user text or SKILL.md.
    const prefix = `${displayText}\n\n`
    if (!first.text.startsWith(`${prefix}<skill>\n`)) return [message]
    const { [displayTextKey]: _displayText, ...metadata } = message.additional_kwargs
    return [
      new HumanMessage({
        id: message.id,
        name: message.name,
        content: content.length === 1 ? displayText : [{ type: 'text', text: displayText }, ...content.slice(1)],
        additional_kwargs: metadata,
        response_metadata: message.response_metadata
      }),
      new HumanMessage({
        id: message.id ? `${message.id}:skill` : undefined,
        content: first.text.slice(prefix.length),
        additional_kwargs: { [skillContextKey]: true }
      })
    ]
  })
}

/** Keep request-only Skill context with the user input it supplements. */
export function latestUserInputMessages(messages: BaseMessage[]): BaseMessage[] {
  let end = messages.length - 1
  while (end >= 0 && !HumanMessage.isInstance(messages[end])) end--
  if (end < 0) return []
  let start = end
  while (start > 0 && messages[start].additional_kwargs[skillContextKey] === true
    && HumanMessage.isInstance(messages[start - 1])) start--
  return messages.slice(start, end + 1)
}
