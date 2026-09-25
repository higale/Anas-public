import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ThreadSidebarFooter } from './ThreadSidebar'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

describe('ThreadSidebarFooter accessibility', () => {
  it('uses Radix menu semantics without joining sequential keyboard focus', () => {
    const html = renderToStaticMarkup(createElement(ThreadSidebarFooter, {
      appMenuOpen: false,
      onAppMenuOpenChange: vi.fn(),
      onOpenHelp: vi.fn(),
      onOpenSettings: vi.fn(),
      onQuit: vi.fn(),
      onShowAbout: vi.fn()
    }))

    expect(html).toContain('<button')
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).toContain('aria-expanded="false"')
    expect(html).toContain('data-state="closed"')
    expect(html).toContain('tabindex="-1"')
  })
})
