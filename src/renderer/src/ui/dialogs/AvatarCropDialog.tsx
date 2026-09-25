import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import Cropper, {
  getInitialCropFromCroppedAreaPercentages,
  type Area,
  type MediaSize,
  type Point
} from 'react-easy-crop'
import { Crop, FolderOpen, RefreshCcw, RotateCcw, RotateCw, Save, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AvatarCropSaveRequest, AvatarCropSource, AvatarRotation } from '@shared/types'
import { RangeField } from '../RangeField'
import { notice } from '../notice'

const AVATAR_EDITOR_SIZE = 320
const AVATAR_OUTPUT_MAX_SIZE = 1024
const AVATAR_SCALE_MIN = 1
const AVATAR_SCALE_MAX = 5
const AVATAR_SCALE_STEP = 0.01

interface AvatarCropDialogProps {
  source: AvatarCropSource | null
  onCancel: () => void
  onChooseSource: () => Promise<void>
  onSave: (request: AvatarCropSaveRequest) => Promise<void>
}

class AvatarExportError extends Error {}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new AvatarExportError('Canvas did not produce an image.'))
    }, 'image/png')
  })
}

function loadImage(dataUri: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.addEventListener('load', () => resolve(image), { once: true })
    image.addEventListener('error', () => reject(new AvatarExportError('Avatar source could not be decoded.')), {
      once: true
    })
    image.src = dataUri
  })
}

function rotatedSize(width: number, height: number, rotation: AvatarRotation): { height: number; width: number } {
  return rotation === 90 || rotation === 270
    ? { height: width, width: height }
    : { height, width }
}

function cropperMediaSize(image: HTMLImageElement): MediaSize {
  const naturalWidth = image.naturalWidth || image.width
  const naturalHeight = image.naturalHeight || image.height
  const aspect = naturalWidth / naturalHeight
  return aspect < 1
    ? {
        height: AVATAR_EDITOR_SIZE / aspect,
        naturalHeight,
        naturalWidth,
        width: AVATAR_EDITOR_SIZE
      }
    : {
        height: AVATAR_EDITOR_SIZE,
        naturalHeight,
        naturalWidth,
        width: AVATAR_EDITOR_SIZE * aspect
      }
}

async function exportAvatarPng(
  source: AvatarCropSource,
  crop: Area,
  rotation: AvatarRotation
): Promise<Uint8Array> {
  try {
    const image = await loadImage(source.dataUri)
    const naturalWidth = image.naturalWidth || image.width
    const naturalHeight = image.naturalHeight || image.height
    const rotated = rotatedSize(naturalWidth, naturalHeight, rotation)
    if (
      !Number.isSafeInteger(rotated.width)
      || !Number.isSafeInteger(rotated.height)
      || rotated.width <= 0
      || rotated.height <= 0
    ) {
      throw new AvatarExportError('Avatar source dimensions are invalid.')
    }

    const rotatedCanvas = document.createElement('canvas')
    rotatedCanvas.width = rotated.width
    rotatedCanvas.height = rotated.height
    const rotatedContext = rotatedCanvas.getContext('2d')
    if (!rotatedContext) throw new AvatarExportError('Canvas is unavailable.')
    rotatedContext.translate(rotated.width / 2, rotated.height / 2)
    rotatedContext.rotate(rotation * Math.PI / 180)
    rotatedContext.translate(-naturalWidth / 2, -naturalHeight / 2)
    rotatedContext.drawImage(image, 0, 0)

    const naturalSide = Math.min(crop.width, crop.height)
    if (!Number.isFinite(naturalSide) || naturalSide <= 0) {
      throw new AvatarExportError('Avatar crop dimensions are invalid.')
    }
    const outputSide = Math.max(1, Math.min(Math.round(naturalSide), AVATAR_OUTPUT_MAX_SIZE))
    const output = document.createElement('canvas')
    output.width = outputSide
    output.height = outputSide
    const context = output.getContext('2d')
    if (!context) throw new AvatarExportError('Canvas is unavailable.')
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.clearRect(0, 0, outputSide, outputSide)
    context.drawImage(
      rotatedCanvas,
      Math.round(crop.x),
      Math.round(crop.y),
      Math.round(crop.width),
      Math.round(crop.height),
      0,
      0,
      outputSide,
      outputSide
    )

    const blob = await canvasToBlob(output)
    return new Uint8Array(await blob.arrayBuffer())
  } catch (reason) {
    if (reason instanceof AvatarExportError) throw reason
    throw new AvatarExportError('Avatar export failed.', { cause: reason })
  }
}

function normalizedCropArea(area: Area): Area {
  const rounded = (value: number): number => Math.round(value * 1_000_000) / 1_000_000
  return {
    height: rounded(area.height),
    width: rounded(area.width),
    x: rounded(area.x),
    y: rounded(area.y)
  }
}

interface AvatarCropDialogSessionProps extends Omit<AvatarCropDialogProps, 'source'> {
  source: AvatarCropSource
}

function AvatarCropDialogSession({ source, onCancel, onChooseSource, onSave }: AvatarCropDialogSessionProps) {
  const { t } = useTranslation()
  const savingRef = useRef(false)
  const choosingRef = useRef(false)
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 })
  const [cropArea, setCropArea] = useState<Area | null>(null)
  const [cropPixels, setCropPixels] = useState<Area | null>(null)
  const [scale, setScale] = useState(1)
  const [rotation, setRotation] = useState<AvatarRotation>(source.transform?.rotation ?? 0)
  const [transformReady, setTransformReady] = useState(!source.transform)
  const [imageReady, setImageReady] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [choosing, setChoosing] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const transform = source.transform
    if (!transform) return
    let cancelled = false
    loadImage(source.dataUri).then((image) => {
      if (cancelled) return
      const restored = getInitialCropFromCroppedAreaPercentages(
        transform.crop,
        cropperMediaSize(image),
        transform.rotation,
        { height: AVATAR_EDITOR_SIZE, width: AVATAR_EDITOR_SIZE },
        AVATAR_SCALE_MIN,
        AVATAR_SCALE_MAX
      )
      setCrop(restored.crop)
      setScale(restored.zoom)
      setTransformReady(true)
    }).catch(() => {
      if (!cancelled) setLoadFailed(true)
    })
    return () => {
      cancelled = true
    }
  }, [source.dataUri, source.transform])

  function resetEditor(): void {
    setCrop({ x: 0, y: 0 })
    setCropArea(null)
    setCropPixels(null)
    setScale(1)
    setRotation(0)
  }

  async function chooseSource(): Promise<void> {
    if (choosingRef.current || savingRef.current) return
    choosingRef.current = true
    setChoosing(true)
    try {
      await onChooseSource()
    } finally {
      choosingRef.current = false
      setChoosing(false)
    }
  }

  async function saveAvatar(): Promise<void> {
    if (savingRef.current || !imageReady || !cropArea || !cropPixels) return
    savingRef.current = true
    setSaving(true)
    try {
      const pngBytes = await exportAvatarPng(source, cropPixels, rotation)
      await onSave({
        pngBytes,
        sourcePath: source.path,
        transform: {
          crop: normalizedCropArea(cropArea),
          rotation
        }
      })
    } catch (reason) {
      notice.error(reason instanceof AvatarExportError
        ? t('settings.avatar_crop_export_failed')
        : t('chat.failed_update_avatar'))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  const rotate = (change: -90 | 90): void => {
    setRotation((value) => ((value + change + 360) % 360) as AvatarRotation)
  }

  const busy = choosing || saving

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !savingRef.current && !choosingRef.current) onCancel()
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="ui-backdrop" />
        <Dialog.Content
          className="avatar-crop-dialog ui-dialog ui-dialog-medium ui-dialog-centered ui-dialog-scroll ui-popover"
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <header className="ui-dialog-header">
            <div className="ui-dialog-icon">
              <Crop size={18} />
            </div>
            <div>
              <Dialog.Title asChild>
                <h2 className="ui-dialog-title">{t('settings.avatar_crop_title')}</h2>
              </Dialog.Title>
              <Dialog.Description asChild>
                <p className="ui-dialog-description">{t('settings.avatar_crop_description')}</p>
              </Dialog.Description>
            </div>
          </header>

          <div className="avatar-crop-content">
            <div
              aria-label={t('settings.avatar_crop_preview')}
              aria-busy={!imageReady && !loadFailed}
              className="avatar-crop-preview"
              role="group"
            >
              {transformReady && <Cropper
                image={source.dataUri}
                crop={crop}
                zoom={scale}
                rotation={rotation}
                aspect={1}
                cropSize={{ height: AVATAR_EDITOR_SIZE, width: AVATAR_EDITOR_SIZE }}
                disableAutomaticStylesInjection
                maxZoom={AVATAR_SCALE_MAX}
                minZoom={AVATAR_SCALE_MIN}
                objectFit="cover"
                showGrid
                zoomSpeed={0.8}
                cropperProps={{ 'aria-label': t('settings.avatar_crop_preview') }}
                mediaProps={{
                  onError: () => {
                    setImageReady(false)
                    setLoadFailed(true)
                  }
                }}
                style={{ cropAreaStyle: { border: 0, borderRadius: '25%' } }}
                onCropAreaChange={(area, pixels) => {
                  setCropArea(area)
                  setCropPixels(pixels)
                }}
                onCropChange={setCrop}
                onMediaLoaded={() => {
                  setImageReady(true)
                  setLoadFailed(false)
                }}
                onZoomChange={setScale}
              />}
            </div>

            {loadFailed && (
              <p className="avatar-crop-error" role="alert">
                {t('settings.avatar_crop_load_failed')}
              </p>
            )}

            <div className="avatar-crop-controls">
              <RangeField
                className="avatar-crop-zoom"
                disabled={!imageReady || busy}
                label={t('settings.avatar_crop_zoom', { percent: Math.round(scale * 100) })}
                min={AVATAR_SCALE_MIN}
                max={AVATAR_SCALE_MAX}
                step={AVATAR_SCALE_STEP}
                value={scale}
                onChange={setScale}
              />
              <div className="avatar-crop-transform-actions">
                <button
                  aria-label={t('settings.choose_avatar')}
                  className="ui-icon-button"
                  data-tooltip={t('settings.choose_avatar')}
                  disabled={busy}
                  type="button"
                  onClick={() => void chooseSource()}
                >
                  <FolderOpen size={16} />
                </button>
                <button
                  aria-label={t('settings.avatar_crop_rotate_left')}
                  className="ui-icon-button"
                  data-tooltip={t('settings.avatar_crop_rotate_left')}
                  disabled={!imageReady || busy}
                  type="button"
                  onClick={() => rotate(-90)}
                >
                  <RotateCcw size={16} />
                </button>
                <button
                  aria-label={t('settings.avatar_crop_rotate_right')}
                  className="ui-icon-button"
                  data-tooltip={t('settings.avatar_crop_rotate_right')}
                  disabled={!imageReady || busy}
                  type="button"
                  onClick={() => rotate(90)}
                >
                  <RotateCw size={16} />
                </button>
                <button
                  className="ui-button ui-button-compact"
                  disabled={!imageReady || busy}
                  type="button"
                  onClick={resetEditor}
                >
                  <RefreshCcw size={14} />
                  <span>{t('settings.avatar_crop_reset')}</span>
                </button>
              </div>
            </div>
          </div>

          <footer className="ui-dialog-footer">
            <Dialog.Close asChild>
              <button className="ui-button ui-button-compact" disabled={busy} type="button">
                <X size={14} />
                <span>{t('common.cancel')}</span>
              </button>
            </Dialog.Close>
            <button
              aria-busy={saving}
              className="ui-button ui-button-compact ui-button-primary"
              disabled={!imageReady || !cropArea || !cropPixels || busy}
              type="button"
              onClick={() => void saveAvatar()}
            >
              <Save size={14} />
              <span>{saving ? t('settings.avatar_crop_saving') : t('common.save')}</span>
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function AvatarCropDialog(props: AvatarCropDialogProps) {
  if (!props.source) return null
  return <AvatarCropDialogSession key={props.source.dataUri} {...props} source={props.source} />
}
