import { PopoverContent } from '../PopoverContent'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { ListTree } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { helpDocuments, resolveHelpLink } from '@shared/helpDocuments'
import { MarkdownText } from '../chat/MarkdownText'
import { UI_ICON_SIZE_MEDIUM } from '../uiConstants'
import { usePanelRef, usePanelScroll, usePanelState } from './PanelViewState'
import type { WorkspacePanel } from './useWorkspacePanels'

type DocumentPanel = Extract<WorkspacePanel, { kind: 'document' }>
type Heading = { id: string; text: string; level: number; element: HTMLElement }

function DocumentOutline({ headings, active, popup, onSelect }: {
  headings: Heading[]; active: string; popup: boolean; onSelect(heading: Heading): void
}) {
  const { t } = useTranslation()
  const ref = useRef<HTMLElement>(null)
  const [ready, setReady] = useState(!popup)
  const onScroll = usePanelScroll(ref, ready, true, 'contentsScrollTop')
  useLayoutEffect(() => {
    if (!popup) return
    const root = ref.current!
    // Radix measures available space after mounting. Restoring into the initially
    // unconstrained list would clamp its saved scroll position to zero.
    const observer = new ResizeObserver(() => {
      const available = getComputedStyle(root).getPropertyValue('--radix-popover-content-available-height')
      if (!available.trim() || root.clientHeight === 0) return
      setReady(true)
      observer.disconnect()
    })
    observer.observe(root)
    return () => observer.disconnect()
  }, [popup])
  const baseLevel = Math.min(...headings.map((heading) => heading.level))
  return <nav className="ui-document-outline" ref={ref} onScroll={onScroll} aria-label={t('chat.document_contents')}>
    <ul>
      {headings.map((heading) => <li key={heading.id}>
        <a className={`ui-list-item${active === heading.id ? ' ui-list-item-active' : ''}`}
          href={`#${heading.id.slice('document-'.length)}`}
          aria-current={active === heading.id ? 'location' : undefined}
          style={{ paddingInlineStart: `${0.75 + (heading.level - baseLevel) * 0.85}em` }}
          onClick={(event) => { event.preventDefault(); onSelect(heading) }}>
          {heading.text}
        </a>
      </li>)}
    </ul>
  </nav>
}

export function HelpDocumentPanel({ request, onOpen }: {
  request: DocumentPanel
  onOpen(panel: DocumentPanel): void
}) {
  const { t } = useTranslation()
  const [content, setContent] = usePanelState<string | undefined>('content', undefined)
  const [contentsOpen, setContentsOpen] = usePanelState('contentsOpen', true)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [headings, setHeadings] = useState<Heading[]>()
  const [active, setActive] = useState('')
  const [narrow, setNarrow] = useState(true)
  const [popupOpen, setPopupOpen] = useState(false)
  const shellRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const navigation = usePanelRef<string | undefined>('navigation', undefined)
  const ready = headings !== undefined
  const saveScroll = usePanelScroll(scrollRef, ready)
  const updateCurrent = useRef<() => void>(() => {})
  const onScroll = useCallback(() => { saveScroll(); updateCurrent.current() }, [saveScroll])

  useEffect(() => {
    if (content !== undefined) return
    let cancelled = false
    setFailed(false)
    void window.gale.app.readHelp(request.documentId).then((text) => {
      if (!cancelled) setContent(text)
    }).catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [request.documentId, attempt, content, setContent])

  useLayoutEffect(() => {
    const shell = shellRef.current!
    const measure = () => {
      // Observe the toolbar too: its height changes with the application's font size.
      const next = shell.clientWidth === 0 || shell.clientWidth < 48 * parseFloat(getComputedStyle(shell).fontSize)
      setNarrow(next)
      setPopupOpen(false)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(shell)
    observer.observe(toolbarRef.current!)
    measure()
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const root = scrollRef.current
    if (content === undefined || !root) return
    // Use rendered headings so IDs and labels exactly match the Markdown renderer.
    const items = Array.from(root.querySelectorAll<HTMLElement>('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]'))
      .map((element) => ({ id: element.id, text: element.textContent ?? '', level: Number(element.tagName[1]), element }))
    setHeadings(items)
    let frame = 0
    const update = () => {
      frame = 0
      const top = root.getBoundingClientRect().top + 24
      let current: Heading | undefined = items[0]
      for (const item of items) {
        if (item.element.getBoundingClientRect().top > top) break
        current = item
      }
      if (root.scrollHeight > root.clientHeight && root.scrollTop + root.clientHeight >= root.scrollHeight - 2) current = items.at(-1)
      setActive(current?.id ?? '')
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update) }
    updateCurrent.current = schedule
    const observer = new ResizeObserver(schedule)
    observer.observe(root)
    if (root.firstElementChild) observer.observe(root.firstElementChild)
    schedule()
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      updateCurrent.current = () => {}
    }
  }, [content])

  useLayoutEffect(() => {
    if (!ready || !request.navigationId || navigation.current === request.navigationId) return
    const root = scrollRef.current
    if (!root) return
    if (request.anchor) {
      const heading = Array.from(root.querySelectorAll<HTMLElement>('[id]'))
        .find((element) => element.id === `document-${request.anchor}`)
      heading?.scrollIntoView({ block: 'start' })
    } else root.scrollTop = 0
    navigation.current = request.navigationId
    onScroll()
  }, [ready, request.anchor, request.navigationId, navigation, onScroll])

  const navigate = useCallback(async (href: string): Promise<void> => {
    const target = resolveHelpLink(href, request.documentId)
    if (target) onOpen({ kind: 'document', ...target, navigationId: crypto.randomUUID() })
    else await window.gale.app.openExternalUrl(href)
  }, [request.documentId, onOpen])
  // Updating the highlighted chapter must not reparse the entire document on scroll.
  const markdown = useMemo(() => content === undefined ? null : <MarkdownText text={content} onNavigate={navigate} />, [content, navigate])
  const outline = <DocumentOutline headings={headings ?? []} active={active} popup={narrow} onSelect={(heading) => {
    heading.element.scrollIntoView({ block: 'start' })
    setActive(heading.id)
    setPopupOpen(false)
    onScroll()
  }} />
  const toggle = <button type="button" className="ui-button ui-button-compact"
    aria-expanded={narrow ? popupOpen : contentsOpen} disabled={!headings?.length}
    onClick={narrow ? undefined : () => setContentsOpen((value) => !value)}>
    <ListTree size={UI_ICON_SIZE_MEDIUM} aria-hidden="true" />{t('chat.document_contents')}
  </button>

  return <div className="ui-document-reader" ref={shellRef}>
    <div className="ui-document-toolbar" ref={toolbarRef}>
      {narrow ? <Popover.Root open={popupOpen} onOpenChange={setPopupOpen}>
        <Popover.Trigger asChild>{toggle}</Popover.Trigger>
        <Popover.Portal container={shellRef.current}>
          <PopoverContent className="ui-popover ui-document-contents-popover" align="start" sideOffset={5} collisionPadding={10}
            aria-label={t('chat.document_contents')} ref={popoverRef} onOpenAutoFocus={(event) => {
              event.preventDefault()
              const root = popoverRef.current
              const link = root?.querySelector<HTMLAnchorElement>('a[aria-current="location"]') ?? root?.querySelector<HTMLAnchorElement>('a')
              link?.focus({ preventScroll: true })
            }}>
            {outline}
          </PopoverContent>
        </Popover.Portal>
      </Popover.Root> : toggle}
    </div>
    <div className="ui-document-body">
      {!narrow && contentsOpen && !!headings?.length && outline}
      <div className="ui-document-panel" ref={scrollRef} onScroll={onScroll}
        aria-label={helpDocuments[request.documentId]} aria-busy={content === undefined && !failed}>
        {content !== undefined ? markdown
          : failed ? <div role="alert">
            <p>{t('chat.failed_open_help')}</p>
            <button type="button" className="ui-button" onClick={() => setAttempt((value) => value + 1)}>{t('common.retry')}</button>
          </div> : <p className="ui-detail-panel-empty">{t('common.loading')}</p>}
      </div>
    </div>
  </div>
}
