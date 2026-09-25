import { describe, expect, it } from 'vitest'
import { attachmentPromptText } from './attachmentUtils'

describe('attachmentPromptText', () => {
  it('uses the visible attachment prompt for an attachment-only message', () => {
    expect(attachmentPromptText('', 1, '查看附件。')).toBe('查看附件。')
  })

  it('preserves explicit text and does not invent text without attachments', () => {
    expect(attachmentPromptText('Describe this image', 1, 'Review the attachment.'))
      .toBe('Describe this image')
    expect(attachmentPromptText('', 0, 'Review the attachment.')).toBe('')
  })
})
