import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HelpDocumentId } from '@shared/helpDocuments'
import { HelpDocumentPanel } from './HelpDocumentPanel'
import { PanelViewState } from './PanelViewState'
import type { WorkspacePanel } from './useWorkspacePanels'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const readHelp = vi.fn(), external = vi.fn()
const english = '# Guide\n\n[中文](./USER_GUIDE.zh-CN.md#记忆)\n\n[Web](https://example.com/)\n\n[Section](#tools)\n\n## Tools\n\nSome **text**\n\n## Tools'
const request: Extract<WorkspacePanel, { kind: 'document' }> = { kind: 'document', documentId: 'USER_GUIDE.en.md' }
beforeEach(() => {
  readHelp.mockReset().mockResolvedValue(english)
  external.mockReset().mockResolvedValue('')
  Object.defineProperty(window, 'gale', { configurable: true, value: { app: { readHelp, openExternalUrl: external } } })
})

describe('Help document panel', () => {
  it('renders headings and routes relative documents, anchors and external links', async () => {
    const open = vi.fn()
    const user = userEvent.setup()
    render(<HelpDocumentPanel request={request} onOpen={open} />)
    await screen.findByRole('heading', { name: 'Guide' })
    expect(screen.getAllByRole('heading', { name: 'Tools' }).map((element) => element.id)).toEqual(['document-tools', 'document-tools-1'])
    await user.click(screen.getByRole('link', { name: '中文' }))
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ documentId: 'USER_GUIDE.zh-CN.md', anchor: '记忆' }))
    await user.click(screen.getByRole('link', { name: 'Section' }))
    expect(open).toHaveBeenLastCalledWith(expect.objectContaining({ documentId: 'USER_GUIDE.en.md', anchor: 'tools' }))
    await user.click(screen.getByRole('link', { name: 'Web' }))
    expect(external).toHaveBeenCalledWith('https://example.com/')
  })

  it('waits for content before navigating, then preserves the reading position when remounted', async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
    const state = new Map<string, unknown>()
    const anchorRequest = { ...request, anchor: 'tools', navigationId: 'jump' }
    const panel = () => <PanelViewState state={state}><HelpDocumentPanel request={anchorRequest} onOpen={vi.fn()} /></PanelViewState>
    const view = render(panel())
    await waitFor(() => expect(scroll).toHaveBeenCalled())
    const root = document.querySelector('.ui-document-panel')!
    fireEvent.scroll(root, { target: { scrollTop: 450 } })
    view.unmount()
    scroll.mockClear()
    render(panel())
    await screen.findByRole('heading', { name: 'Guide' })
    expect(document.querySelector('.ui-document-panel')!.scrollTop).toBe(450)
    expect(scroll).not.toHaveBeenCalled()
  })

  it('builds the contents from actual headings and closes the narrow popup after a jump', async () => {
    readHelp.mockResolvedValue('# **Guide**\n\n## 中文\n\n## 中文\n\n```md\n# Not a heading\n```')
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView')
    const user = userEvent.setup()
    render(<PanelViewState state={new Map()}><HelpDocumentPanel request={request} onOpen={vi.fn()} /></PanelViewState>)
    await screen.findByRole('heading', { name: 'Guide' })
    const toggle = screen.getByRole('button', { name: 'chat.document_contents' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    const outline = screen.getByRole('navigation', { name: 'chat.document_contents' })
    const links = within(outline).getAllByRole('link')
    expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
      ['Guide', '#guide'], ['中文', '#中文'], ['中文', '#中文-1']
    ])
    await user.click(links[2])
    expect(scroll.mock.instances.at(-1)).toBe(screen.getAllByRole('heading', { name: '中文' })[1])
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    await user.keyboard('{Escape}')
    expect(toggle).toHaveFocus()
  })

  it('tracks the visible chapter and preserves the desktop contents preference and scroll', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000)
    try {
      const state = new Map<string, unknown>()
      const panel = () => <PanelViewState state={state}><HelpDocumentPanel request={request} onOpen={vi.fn()} /></PanelViewState>
      const view = render(panel())
      await screen.findByRole('heading', { name: 'Guide' })
      const root = document.querySelector<HTMLElement>('.ui-document-panel')!
      const headings = screen.getAllByRole('heading')
      headings.forEach((heading, index) => vi.spyOn(heading, 'getBoundingClientRect').mockImplementation(() => ({ top: index * 300 - root.scrollTop }) as DOMRect))
      const outline = screen.getByRole('navigation')
      fireEvent.scroll(root, { target: { scrollTop: 350 } })
      await waitFor(() => expect(within(outline).getAllByRole('link')[1]).toHaveAttribute('aria-current', 'location'))
      fireEvent.scroll(outline, { target: { scrollTop: 75 } })
      await userEvent.click(screen.getByRole('button', { name: 'chat.document_contents' }))
      expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
      view.unmount()
      render(panel())
      await screen.findByRole('heading', { name: 'Guide' })
      expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
      expect(document.querySelector('.ui-document-panel')!.scrollTop).toBe(350)
      await userEvent.click(screen.getByRole('button', { name: 'chat.document_contents' }))
      expect(screen.getByRole('navigation').scrollTop).toBe(75)
    } finally { width.mockRestore() }
  })

  it('keeps documents without headings readable without an empty contents menu', async () => {
    readHelp.mockResolvedValue('Plain text')
    render(<HelpDocumentPanel request={request} onOpen={vi.fn()} />)
    await screen.findByText('Plain text')
    expect(screen.getByRole('button', { name: 'chat.document_contents' })).toBeDisabled()
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
  })

  it('discards an obsolete read when switching documents', async () => {
    let finish!: (value: string) => void
    readHelp.mockImplementation((id: HelpDocumentId) => id === 'USER_GUIDE.en.md'
      ? new Promise<string>((resolve) => { finish = resolve }) : Promise.resolve('# 中文'))
    const view = render(<HelpDocumentPanel key="en" request={request} onOpen={vi.fn()} />)
    view.rerender(<HelpDocumentPanel key="zh" request={{ kind: 'document', documentId: 'USER_GUIDE.zh-CN.md' }} onOpen={vi.fn()} />)
    await screen.findByRole('heading', { name: '中文' })
    finish('# Stale')
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Stale' })).not.toBeInTheDocument())
  })

  it('shows a readable failure and supports retrying', async () => {
    readHelp.mockRejectedValueOnce(new Error('missing'))
    render(<HelpDocumentPanel request={request} onOpen={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('chat.failed_open_help')
    await userEvent.click(screen.getByRole('button', { name: 'common.retry' }))
    await screen.findByRole('heading', { name: 'Guide' })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
