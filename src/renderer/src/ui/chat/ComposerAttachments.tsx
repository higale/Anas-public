import type { SelectedAttachment } from '@shared/types'
import { AttachmentGrid } from './AttachmentGrid'

interface ComposerAttachmentsProps {
  attachments: SelectedAttachment[]
  disabled?: boolean
  onRemoveAttachment: (path: string) => void
  onToggleAttachmentContextPolicy: (path: string) => void
}

export function ComposerAttachments({
  attachments,
  disabled,
  onRemoveAttachment,
  onToggleAttachmentContextPolicy
}: ComposerAttachmentsProps) {
  if (attachments.length === 0) return null

  return (
    <AttachmentGrid
      attachments={attachments}
      mode="composer"
      removalDisabled={disabled}
      onRemoveAttachment={onRemoveAttachment}
      onToggleContextPolicy={onToggleAttachmentContextPolicy}
    />
  )
}
