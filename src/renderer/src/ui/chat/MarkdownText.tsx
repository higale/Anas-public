import { createContext, useContext, useEffect, useRef, useState, type ComponentProps, type ImgHTMLAttributes, type MouseEvent, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import { useTranslation } from 'react-i18next'
import remarkGfm from 'remark-gfm'
import rehypeSlug from 'rehype-slug'
import { NoFocusButton } from '../NoFocusButton'
import { notice } from '../notice'
import { loadAttachmentPreview } from './attachmentPreviewLoader'
import { normalizeLocalImagePath } from './markdownImagePaths'
import { localFilePathFromHref, remarkLocalFileLinks } from './localFileLinks'
import { ImageLightbox } from './ImageLightbox'

type MarkdownPreProps = ComponentProps<'pre'> & { node?: unknown }
type MarkdownAnchorProps = ComponentProps<'a'> & { node?: unknown }
type MarkdownImageProps = ImgHTMLAttributes<HTMLImageElement> & { node?: unknown }

const MarkdownWorkspaceProjectContext = createContext<string | undefined>(undefined)
const MarkdownNavigationContext = createContext<((href: string) => void | Promise<void>) | undefined>(undefined)

export function MarkdownWorkspaceProjectProvider({
  children,
  projectId
}: {
  children: ReactNode
  projectId?: string
}) {
  return (
    <MarkdownWorkspaceProjectContext.Provider value={projectId}>
      {children}
    </MarkdownWorkspaceProjectContext.Provider>
  )
}

function textFromNode(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textFromNode).join('')
  if (node && typeof node === 'object' && 'props' in node) {
    const props = node.props as { children?: ReactNode }
    return textFromNode(props.children)
  }
  return ''
}

function MarkdownCodeBlock({ children, node: _node, ...props }: MarkdownPreProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const resetTimerRef = useRef<number | undefined>(undefined)
  const code = textFromNode(children).replace(/\n$/, '')

  useEffect(() => {
    return () => {
      if (resetTimerRef.current !== undefined) window.clearTimeout(resetTimerRef.current)
    }
  }, [])

  async function copyCode(): Promise<void> {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      notice.success(t('chat.message_copied'))
      if (resetTimerRef.current !== undefined) window.clearTimeout(resetTimerRef.current)
      resetTimerRef.current = window.setTimeout(() => setCopied(false), 1400)
    } catch {
      notice.error(t('chat.failed_copy_message'))
    }
  }

  return (
    <div className="markdown-code-block">
      <pre {...props}>{children}</pre>
      <NoFocusButton
        className="markdown-code-copy ui-tool-button ui-tool-button-small"
        type="button"
        aria-label={t('common.copy')}
        data-tooltip={copied ? t('chat.message_copied') : t('common.copy')}
        onClick={(event) => {
          event.stopPropagation()
          void copyCode()
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
      </NoFocusButton>
    </div>
  )
}

function MarkdownLink({ children, href, node: _node, onClick, onMouseDown, ...props }: MarkdownAnchorProps) {
  const { t } = useTranslation()
  const navigate = useContext(MarkdownNavigationContext)
  const localPath = localFilePathFromHref(href)

  async function openLink(url: string): Promise<void> {
    try {
      if (navigate) await navigate(url)
      else if (localPath) await window.gale.files.showItemInFolder(localPath)
      else await window.gale.app.openExternalUrl(url)
    } catch {
      notice.error(t('chat.failed_open_link'))
    }
  }

  function handleClick(event: MouseEvent<HTMLAnchorElement>): void {
    onClick?.(event)
    if (event.defaultPrevented || !href) return
    event.preventDefault()
    void openLink(href)
  }

  return (
    <a
      {...props}
      className={props.className ? `ui-text-link ${props.className}` : 'ui-text-link'}
      href={href}
      rel="noreferrer"
      tabIndex={navigate ? undefined : -1}
      data-tooltip={!navigate && localPath ? t('chat.show_in_folder') : undefined}
      onMouseDown={(event) => {
        onMouseDown?.(event)
        if (!navigate) event.preventDefault()
      }}
      onClick={handleClick}
    >
      {children}
    </a>
  )
}

function MarkdownImage({ src, alt, node: _node, onError, ...props }: MarkdownImageProps) {
  const { t } = useTranslation()
  const projectId = useContext(MarkdownWorkspaceProjectContext)
  const localPath = normalizeLocalImagePath(src)
  const [thumbnail, setThumbnail] = useState<string | null>(null)
  const [original, setOriginal] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [visible, setVisible] = useState(false)
  const previewRootRef = useRef<HTMLSpanElement>(null)
  const sourceVersionRef = useRef(0)

  useEffect(() => {
    const element = previewRootRef.current
    if (!element || typeof IntersectionObserver === 'undefined') {
      setVisible(true)
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      setVisible(true)
      observer.disconnect()
    }, { rootMargin: '600px 0px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [src])

  useEffect(() => {
    sourceVersionRef.current += 1
    let canceled = false
    setThumbnail(null)
    setOriginal(null)
    setFailure(null)
    setLightboxOpen(false)
    if (!localPath || !visible) return () => {
      canceled = true
      sourceVersionRef.current += 1
    }
    loadAttachmentPreview(localPath, { mode: 'thumbnail', projectId })
      .then((result) => {
        if (canceled) return
        if (result?.src) {
          setThumbnail(result.src)
        } else {
          setFailure(t('chat.image_preview_failed'))
        }
      })
      .catch(() => {
        if (!canceled) setFailure(t('chat.image_preview_failed'))
      })
    return () => {
      canceled = true
      sourceVersionRef.current += 1
    }
  }, [localPath, projectId, src, t, visible])

  const preview = visible ? (localPath ? thumbnail : src ?? null) : null
  const lightboxSource = original ?? preview

  async function openImage(): Promise<void> {
    if (!lightboxSource) return
    setLightboxOpen(true)
    if (!localPath || original) return
    const sourceVersion = sourceVersionRef.current
    const result = await loadAttachmentPreview(localPath, { mode: 'original', projectId }).catch(() => {
      notice.error(t('chat.image_preview_failed'))
      return null
    })
    if (result?.src && sourceVersionRef.current === sourceVersion) setOriginal(result.src)
  }

  if (preview && !failure) {
    return (
      <span ref={previewRootRef} className="markdown-image-frame">
        <NoFocusButton className="markdown-image-thumbnail" type="button" onClick={() => void openImage()} aria-label={alt ?? localPath ?? src}>
          <img
            {...props}
            src={preview}
            alt={alt ?? ''}
            decoding="async"
            loading="lazy"
            onError={(event) => {
              onError?.(event)
              setFailure(t('chat.image_preview_failed'))
            }}
          />
        </NoFocusButton>
        <ImageLightbox
          open={lightboxOpen}
          onClose={() => setLightboxOpen(false)}
          slides={lightboxSource ? [{
            src: lightboxSource,
            alt: alt ?? '',
            path: localPath ?? undefined
          }] : []}
        />
      </span>
    )
  }

  return (
    <span ref={previewRootRef} className={failure ? 'markdown-image-placeholder failed' : 'markdown-image-placeholder'}>
      {failure
        ? `${alt || localPath || src || t('chat.image_preview_failed')}: ${failure}`
        : visible ? t('common.loading') : t('chat.image_preview_waiting')}
    </span>
  )
}

export function MarkdownText({ text, compact = false, onNavigate }: {
  text: string
  compact?: boolean
  onNavigate?: (href: string) => void | Promise<void>
}) {
  return (
    <MarkdownNavigationContext.Provider value={onNavigate}>
    <div
      className={compact ? 'markdown-body compact' : 'markdown-body'}
      data-native-context-menu="text"
    >
      <ReactMarkdown
        remarkPlugins={onNavigate ? [remarkGfm] : [remarkGfm, remarkLocalFileLinks]}
        rehypePlugins={onNavigate ? [[rehypeSlug, { prefix: 'document-' }]] : []}
        urlTransform={(url, key) => {
          if (key === 'href' && localFilePathFromHref(url)) return url
          return key === 'src' && normalizeLocalImagePath(url) ? url : defaultUrlTransform(url)
        }}
        components={{
          a: MarkdownLink,
          img: MarkdownImage,
          pre: MarkdownCodeBlock
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
    </MarkdownNavigationContext.Provider>
  )
}
