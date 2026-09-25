import { ToolMessage } from '@langchain/core/messages'
import type { AgentDatabase } from './agentDatabase'

interface ManagedToolResultReference {
  type: 'message_record'
  thread_id: string
  record_id: string
}

export function isManagedToolResultReference(value: unknown): value is ManagedToolResultReference {
  if (!value || typeof value !== 'object') return false
  const reference = value as Partial<ManagedToolResultReference>
  return reference.type === 'message_record'
    && typeof reference.thread_id === 'string' && reference.thread_id.length > 0
    && typeof reference.record_id === 'string' && /^[A-Za-z0-9_-]{43}$/.test(reference.record_id)
}

function referenceForThread(value: string, threadId: string): ManagedToolResultReference {
  const reference: unknown = JSON.parse(value)
  if (!isManagedToolResultReference(reference) || reference.thread_id !== threadId) {
    throw new Error('Invalid persisted tool result reference for this conversation.')
  }
  return reference
}

export async function encodeManagedToolResult(
  database: Pick<AgentDatabase, 'persistManagedToolResult'>,
  message: ToolMessage,
  context: { threadId: string; runId: string }
): Promise<string> {
  const recordId = await database.persistManagedToolResult(context.threadId, context.runId, message)
  return JSON.stringify({ type: 'message_record', thread_id: context.threadId, record_id: recordId })
}

export async function decodeManagedToolResult(
  database: Pick<AgentDatabase, 'readManagedToolResult'>, value: string, threadId: string
): Promise<ToolMessage> {
  const reference = referenceForThread(value, threadId)
  return database.readManagedToolResult(threadId, reference.record_id)
}

export function decodeManagedToolResultSync(
  database: Pick<AgentDatabase, 'readManagedToolResultSync'>, value: string, threadId: string
): ToolMessage {
  const reference = referenceForThread(value, threadId)
  return database.readManagedToolResultSync(threadId, reference.record_id)
}

export function managedToolText(message: ToolMessage): string {
  if (typeof message.content === 'string') return message.content
  return message.content.flatMap((block) => (
    typeof block === 'string' ? [block] : block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
  )).join('\n')
}
