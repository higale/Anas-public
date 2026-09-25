import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderOpen, X, ZoomIn, ZoomOut } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import Lightbox from 'yet-another-react-lightbox'
import LightboxZoom from 'yet-another-react-lightbox/plugins/zoom'
import 'yet-another-react-lightbox/styles.css'
import { NoFocusButton } from '../NoFocusButton'
import { notice } from '../notice'

const zoomStateEpsilon = 0.0001

interface ImageZoomRef {
  zoom: number
  minZoom: number
  maxZoom: number
  offsetX: number
  offsetY: number
  disabled: boolean
  zoomIn: () => void
  zoomOut: () => void
  changeZoom: (targetZoom: number, rapid?: boolean, dx?: number, dy?: number) => void
}

interface ImageZoomControlsState {
  zoom: number
  minZoom: number
  maxZoom: number
  disabled: boolean
}

const defaultZoomControlsState: ImageZoomControlsState = {
  zoom: 1,
  minZoom: 1,
  maxZoom: 1,
  disabled: true
}

export interface ImageLightboxSlide {
  src: string
  alt: string
  path?: string
}

interface ImageZoomControlsBridgeProps {
  zoom: ImageZoomRef
  onChange: (state: ImageZoomControlsState) => void
}

function ImageZoomControlsBridge({ zoom, onChange }: ImageZoomControlsBridgeProps) {
  useEffect(() => {
    onChange({
      zoom: zoom.zoom,
      minZoom: zoom.minZoom,
      maxZoom: zoom.maxZoom,
      disabled: zoom.disabled
    })
  }, [zoom.zoom, zoom.minZoom, zoom.maxZoom, zoom.disabled, onChange])

  return null
}

export function ImageLightbox({
  index = 0,
  open,
  slides,
  onClose,
  onView
}: {
  index?: number
  open: boolean
  slides: ImageLightboxSlide[]
  onClose(): void
  onView?(index: number): void
}) {
  const { t } = useTranslation()
  const zoomRef = useRef<ImageZoomRef | null>(null)
  const [zoomControls, setZoomControls] = useState<ImageZoomControlsState>(defaultZoomControlsState)
  const updateZoomControls = useCallback((next: ImageZoomControlsState) => {
    setZoomControls((current) => (
      current.zoom === next.zoom
      && current.minZoom === next.minZoom
      && current.maxZoom === next.maxZoom
      && current.disabled === next.disabled
        ? current
        : next
    ))
  }, [])

  useEffect(() => {
    if (!open) setZoomControls(defaultZoomControlsState)
  }, [open])

  const activeSlide = slides[index]
  const zoomInDisabled = zoomControls.disabled || zoomControls.zoom >= zoomControls.maxZoom - zoomStateEpsilon
  const zoomOutDisabled = zoomControls.disabled || zoomControls.zoom <= zoomControls.minZoom + zoomStateEpsilon
  const actualSizeDisabled = zoomControls.disabled || zoomControls.zoom >= zoomControls.maxZoom - zoomStateEpsilon

  async function showItemInFolder(): Promise<void> {
    if (!activeSlide?.path) return
    try {
      await window.gale.files.showItemInFolder(activeSlide.path)
    } catch {
      notice.error(t('chat.failed_open_attachment'))
    }
  }

  return (
    <Lightbox
      open={open}
      close={onClose}
      index={index}
      slides={slides.map((slide) => ({
        src: slide.src,
        alt: slide.alt,
        imageFit: 'contain' as const
      }))}
      plugins={[LightboxZoom]}
      zoom={{ ref: zoomRef }}
      carousel={{ finite: true, imageFit: 'contain', preload: 1 }}
      controller={{ closeOnBackdropClick: true }}
      labels={{ Close: t('common.close'), Lightbox: t('chat.attachment_preview') }}
      render={{
        buttonZoom: (zoom) => <ImageZoomControlsBridge zoom={zoom} onChange={updateZoomControls} />,
        controls: () => (
          <div className="attachment-lightbox-topbar">
            <div className="attachment-lightbox-toolbar" role="toolbar" aria-label={t('chat.attachment_preview')}>
              <NoFocusButton
                className="yarl__button"
                type="button"
                aria-label={t('menu.zoom_in')}
                disabled={zoomInDisabled}
                onClick={() => {
                  const zoom = zoomRef.current
                  if (zoom && !zoomInDisabled) zoom.zoomIn()
                }}
              >
                <ZoomIn size={21} />
              </NoFocusButton>
              <NoFocusButton
                className="yarl__button"
                type="button"
                aria-label={t('menu.zoom_out')}
                disabled={zoomOutDisabled}
                onClick={() => {
                  const zoom = zoomRef.current
                  if (zoom && !zoomOutDisabled) zoom.zoomOut()
                }}
              >
                <ZoomOut size={21} />
              </NoFocusButton>
              <NoFocusButton
                className="yarl__button attachment-lightbox-actual-size-button"
                type="button"
                aria-label="1:1"
                disabled={actualSizeDisabled}
                onClick={() => {
                  const zoom = zoomRef.current
                  if (zoom && !actualSizeDisabled) zoom.changeZoom(zoom.maxZoom)
                }}
              >
                <span className="attachment-lightbox-actual-size-label">1:1</span>
              </NoFocusButton>
              {activeSlide?.path && (
                <NoFocusButton
                  className="yarl__button attachment-lightbox-folder-button"
                  type="button"
                  aria-label={t('chat.show_attachment_in_folder')}
                  onClick={() => void showItemInFolder()}
                >
                  <FolderOpen size={20} />
                </NoFocusButton>
              )}
              <NoFocusButton
                className="yarl__button"
                type="button"
                aria-label={t('common.close')}
                onClick={onClose}
              >
                <X size={22} />
              </NoFocusButton>
            </div>
          </div>
        )
      }}
      on={{
        view: ({ index: nextIndex }) => onView?.(nextIndex)
      }}
      toolbar={{ buttons: [] }}
      className="attachment-lightbox"
    />
  )
}
