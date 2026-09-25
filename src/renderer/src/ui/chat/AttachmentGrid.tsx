import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, File, FileCode, FileText, Image as ImageIcon, Pin, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AttachmentPreview, FileIconImage, SelectedAttachment } from '@shared/types'
import { NoFocusButton } from '../NoFocusButton'
import { notice } from '../notice'
import { attachmentDisplaySuffix } from './attachmentUtils'
import { loadAttachmentPreview } from './attachmentPreviewLoader'
import { ImageLightbox } from './ImageLightbox'

type AttachmentGridItem = SelectedAttachment
const transparentImageDataUri = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='
interface AttachmentGridProps {
  attachments: AttachmentGridItem[]
  mode: 'composer' | 'message'
  removalDisabled?: boolean
  onRemoveAttachment?: (path: string) => void
  onToggleContextPolicy?: (path: string) => void
}

interface AttachmentPreviewState {
  file: AttachmentGridItem
  src: string
}

interface AttachmentLightboxState {
  index: number
  slides: AttachmentPreviewState[]
}

function isImageAttachment(file: AttachmentGridItem): boolean {
  return file.kind === 'image' || file.mimeType.startsWith('image/')
}

function filePreview(file: AttachmentGridItem, previews: Record<string, AttachmentPreview | null | undefined>): string | undefined {
  if (file.dataUri) return file.dataUri
  const preview = previews[file.path]?.src
  if (preview) return preview
  return isImageAttachment(file) ? file.url : undefined
}

function fileIconFallback(file: AttachmentGridItem) {
  if (file.kind === 'image') return <ImageIcon size={18} />
  if (file.mimeType.includes('json') || file.mimeType.includes('javascript') || file.mimeType.includes('typescript')) return <FileCode size={18} />
  if (file.kind === 'text' || file.mimeType.startsWith('text/')) return <FileText size={18} />
  return <File size={18} />
}

export function AttachmentGrid({
  attachments,
  mode,
  removalDisabled = false,
  onRemoveAttachment,
  onToggleContextPolicy
}: AttachmentGridProps) {
  const { t } = useTranslation()
  const [previews, setPreviews] = useState<Record<string, AttachmentPreview | null | undefined>>({})
  const [fileIcons, setFileIcons] = useState<Record<string, FileIconImage | null | undefined>>({})
  const [lightbox, setLightbox] = useState<AttachmentLightboxState | undefined>()
  const originalPreviewRequestsRef = useRef(new Map<string, Promise<AttachmentPreview | null>>())
  const originalPreviewsRef = useRef(new Map<string, AttachmentPreview>())

  const loadOriginalPreview = useCallback(async (file: AttachmentGridItem): Promise<AttachmentPreview | null> => {
    if (file.dataUri) {
      return {
        path: file.path,
        mimeType: file.mimeType,
        src: file.dataUri
      }
    }
    if (!file.path) return null
    const loaded = originalPreviewsRef.current.get(file.path)
    if (loaded) return loaded
    const existing = originalPreviewRequestsRef.current.get(file.path)
    if (existing) return existing
    const request = loadAttachmentPreview(file.path, { mode: 'original' })
      .then((preview) => {
        if (preview) {
          originalPreviewsRef.current.set(file.path, preview)
          setPreviews((current) => ({ ...current, [file.path]: preview }))
        }
        return preview
      })
      .catch(() => null)
      .finally(() => {
        originalPreviewRequestsRef.current.delete(file.path)
      })
    originalPreviewRequestsRef.current.set(file.path, request)
    return request
  }, [])

  useEffect(() => {
    const paths = attachments
      .filter((file) => file.path && isImageAttachment(file) && !filePreview(file, previews) && !(file.path in previews))
      .map((file) => file.path)
    if (paths.length === 0) return

    let cancelled = false
    async function loadPreviews(): Promise<void> {
      const loaded = await Promise.all(paths.map(async (path) => {
        try {
          const preview = await loadAttachmentPreview(path, { mode: 'thumbnail' })
          return [path, preview] as const
        } catch {
          return [path, null] as const
        }
      }))
      if (cancelled) return
      setPreviews((current) => ({
        ...current,
        ...Object.fromEntries(loaded)
      }))
    }

    void loadPreviews()
    return () => {
      cancelled = true
    }
  }, [attachments, previews])

  useEffect(() => {
    const paths = Array.from(new Set(attachments
      .filter((file) => file.path && !isImageAttachment(file) && !(file.path in fileIcons))
      .map((file) => file.path)))
    if (paths.length === 0) return

    let cancelled = false
    async function loadFileIcons(): Promise<void> {
      const loaded = await Promise.all(paths.map(async (path) => {
        try {
          const icon = await window.gale.files.readFileIcon(path, 'normal')
          return [path, icon] as const
        } catch {
          return [path, null] as const
        }
      }))
      if (cancelled) return
      setFileIcons((current) => ({
        ...current,
        ...Object.fromEntries(loaded)
      }))
    }

    void loadFileIcons()
    return () => {
      cancelled = true
    }
  }, [attachments, fileIcons])

  useEffect(() => {
    if (!lightbox) return
    setLightbox((current) => {
      if (!current) return current
      let changed = false
      const slides = current.slides.map((slide) => {
        const src = filePreview(slide.file, previews)
        if (!src || src === slide.src) return slide
        changed = true
        return { ...slide, src }
      })
      return changed ? { ...current, slides } : current
    })
  }, [lightbox, previews])

  const activeLightboxFile = lightbox?.slides[lightbox.index]?.file

  useEffect(() => {
    if (!activeLightboxFile) return
    void loadOriginalPreview(activeLightboxFile)
  }, [activeLightboxFile, loadOriginalPreview])

  const lightboxOpen = Boolean(lightbox)

  if (attachments.length === 0) return null

  async function showItemInFolder(file: AttachmentGridItem): Promise<void> {
    if (!file.path) return
    try {
      await window.gale.files.showItemInFolder(file.path)
    } catch {
      notice.error(t('chat.failed_open_attachment'))
    }
  }

  function buildLightboxSlides(imageAttachments: AttachmentGridItem[], previewOverride?: AttachmentPreview): AttachmentPreviewState[] {
    return imageAttachments.map((file) => ({
      file,
      src: previewOverride?.path === file.path ? previewOverride.src : filePreview(file, previews) ?? transparentImageDataUri,
    }))
  }

  async function openImageAttachment(file: AttachmentGridItem): Promise<void> {
    const imageAttachments = attachments.filter(isImageAttachment)
    const index = Math.max(0, imageAttachments.indexOf(file))
    const currentPreview = filePreview(file, previews)
    if (currentPreview) {
      setLightbox({ index, slides: buildLightboxSlides(imageAttachments) })
      void loadOriginalPreview(file)
      return
    }

    const originalPreview = await loadOriginalPreview(file)
    if (originalPreview) {
      setLightbox({ index, slides: buildLightboxSlides(imageAttachments, originalPreview) })
      return
    }
    await showItemInFolder(file)
  }

  async function openAttachment(file: AttachmentGridItem): Promise<void> {
    if (isImageAttachment(file)) {
      await openImageAttachment(file)
      return
    }
    await showItemInFolder(file)
  }

  return (
    <>
      <div className={`attachment-grid attachment-grid-${mode}`}>
        {attachments.map((file, index) => {
          const preview = filePreview(file, previews)
          const fileIconDataUri = fileIcons[file.path]?.dataUri
          const status = attachmentDisplaySuffix(file, t)
          const removeLabel = file.skippedReason
            ? `${file.name}: ${file.skippedReason}`
            : t('chat.remove_attachment', { kind: file.kind ?? 'file' })
          const openLabel = isImageAttachment(file) ? t('chat.attachment_preview') : t('chat.show_attachment_in_folder')
          return (
            <div
              key={file.path || `${file.name}:${index}`}
              className={preview ? 'attachment-tile image' : `attachment-tile file ${file.skippedReason ? 'skipped' : ''}`}
            >
              <NoFocusButton
                className="attachment-open"
                type="button"
                aria-label={`${openLabel}: ${file.name}`}
                onClick={() => void openAttachment(file)}
              >
                {preview ? (
                  <img src={preview} alt={file.name} decoding="async" loading="lazy" draggable={false} />
                ) : (
                  <>
                    <span className="attachment-file-icon">
                      {fileIconDataUri
                        ? <img src={fileIconDataUri} alt="" decoding="async" loading="lazy" draggable={false} />
                        : fileIconFallback(file)}
                    </span>
                    <span className="attachment-file-text">
                      <strong className="ui-truncate">{file.name}</strong>
                      <small>
                        {file.skippedReason && <AlertTriangle size={12} />}
                        <span className="ui-truncate">{status}</span>
                      </small>
                    </span>
                  </>
                )}
              </NoFocusButton>
              {mode === 'composer' && onRemoveAttachment && (
                <NoFocusButton
                  className={`attachment-remove ${preview ? 'image-remove' : 'file-remove'}`}
                  type="button"
                  aria-label={removeLabel}
                  data-tooltip={removeLabel}
                  disabled={removalDisabled}
                  onClick={() => onRemoveAttachment(file.path)}
                >
                  <X size={13} />
                </NoFocusButton>
              )}
              {mode === 'composer' && onToggleContextPolicy && (
                <NoFocusButton
                  className={`attachment-context-toggle ${file.contextPolicy === 'conversation' ? 'active' : ''}`}
                  type="button"
                  aria-label={file.contextPolicy === 'conversation'
                    ? t('chat.attachment_use_one_turn')
                    : t('chat.attachment_keep_in_conversation')}
                  data-tooltip={file.contextPolicy === 'conversation'
                    ? t('chat.attachment_use_one_turn')
                    : t('chat.attachment_keep_in_conversation')}
                  disabled={removalDisabled}
                  aria-pressed={file.contextPolicy === 'conversation'}
                  onClick={() => onToggleContextPolicy(file.path)}
                >
                  <Pin size={11} />
                </NoFocusButton>
              )}
              {mode === 'message' && file.contextPolicy === 'conversation' && (
                <span
                  className="attachment-context-indicator"
                  aria-label={t('chat.attachment_kept_in_conversation')}
                  data-tooltip={t('chat.attachment_kept_in_conversation')}
                >
                  <Pin size={11} />
                </span>
              )}
            </div>
          )
        })}
      </div>
      <ImageLightbox
        open={lightboxOpen}
        onClose={() => setLightbox(undefined)}
        index={lightbox?.index ?? 0}
        slides={lightbox?.slides.map((slide) => ({
          src: slide.src,
          alt: slide.file.name,
          path: slide.file.path || undefined
        })) ?? []}
        onView={(index) => setLightbox((current) => current ? { ...current, index } : current)}
      />
    </>
  )
}
