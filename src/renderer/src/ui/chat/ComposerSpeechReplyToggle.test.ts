import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ComposerSpeechReplyToggle } from './ComposerSpeechReplyToggle'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

describe('ComposerSpeechReplyToggle', () => {
  it('shows distinct enabled and disabled speech states', () => {
    const disabled = renderToStaticMarkup(createElement(ComposerSpeechReplyToggle, {
      disabled: false,
      enabled: false,
      onChange: () => {}
    }))
    const enabled = renderToStaticMarkup(createElement(ComposerSpeechReplyToggle, {
      disabled: false,
      enabled: true,
      onChange: () => {}
    }))

    expect(disabled).toContain('aria-pressed="false"')
    expect(disabled).toContain('aria-label="speech.auto_reply"')
    expect(disabled).toContain('lucide-volume-x')
    expect(enabled).toContain('aria-pressed="true"')
    expect(enabled).toContain('aria-label="speech.auto_reply"')
    expect(enabled).toContain('lucide-volume-2')
  })
})
