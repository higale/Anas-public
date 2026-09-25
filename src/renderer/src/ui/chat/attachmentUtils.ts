import type { TFunction } from 'i18next'
import type { AgentAttachmentInput } from '@shared/agentTypes'
import type { SelectedAttachment } from '@shared/types'
import { formatBytes } from '../formatBytes'

export function attachmentDisplaySuffix(file: SelectedAttachment, t: TFunction): string {
  if (file.kind === 'image') return 'image'
  if (file.skippedReason) return t('chat.skipped')
  if (file.kind === 'binary') return t('chat.attachment_not_sent_to_model')
  if (file.truncated) return t('chat.truncated')
  return formatBytes(file.size)
}

export function attachmentPromptText(
  text: string,
  attachmentCount: number,
  fallbackPrompt: string
): string {
  return text || (attachmentCount > 0 ? fallbackPrompt : '')
}

export function selectedAttachmentInput(attachment: SelectedAttachment): AgentAttachmentInput {
  return {
    path: attachment.path,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    kind: attachment.kind,
    textTruncated: attachment.truncated,
    contextPolicy: attachment.contextPolicy
  }
}
