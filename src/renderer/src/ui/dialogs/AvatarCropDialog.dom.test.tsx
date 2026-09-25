import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AvatarCropSource } from '@shared/types'
import { notice } from '../notice'
import { AvatarCropDialog } from './AvatarCropDialog'

const editorBehavior = vi.hoisted(() => ({
  crop: { x: 0, y: 0 },
  cropSize: 640,
  loadFails: false,
  mediaSize: undefined as object | undefined,
  rotation: 0
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('../notice', () => ({
  notice: { error: vi.fn() }
}))

vi.mock('react-easy-crop', async () => {
  const { useEffect, useRef } = await import('react')
  return {
    getInitialCropFromCroppedAreaPercentages: (_crop: object, mediaSize: object) => {
      editorBehavior.mediaSize = mediaSize
      return {
        crop: { x: 42, y: -18 },
        zoom: 2.5
      }
    },
    default: function MockCropper(props: {
      crop: { x: number; y: number }
      image: string
      maxZoom: number
      mediaProps?: { onError?: () => void }
      onCropAreaChange?: (area: object, pixels: object) => void
      onMediaLoaded?: (mediaSize: object) => void
      onZoomChange?: (zoom: number) => void
      rotation: number
      zoom: number
    }) {
      editorBehavior.crop = props.crop
      editorBehavior.rotation = props.rotation
      const initialPropsRef = useRef(props)
      useEffect(() => {
        const initialProps = initialPropsRef.current
        if (editorBehavior.loadFails) {
          initialProps.mediaProps?.onError?.()
          return
        }
        initialProps.onMediaLoaded?.({ height: 426.67, naturalHeight: 5712, naturalWidth: 4284, width: 320 })
        initialProps.onCropAreaChange?.(
          { height: 80, width: 80, x: 10, y: 10 },
          { height: editorBehavior.cropSize, width: editorBehavior.cropSize, x: 100, y: 100 }
        )
      }, [])
      return (
        <div
          data-testid="avatar-editor"
          onWheel={(event) => {
            event.preventDefault()
            props.onZoomChange?.(Math.min(props.maxZoom, props.zoom + 0.1))
          }}
        />
      )
    }
  }
})

const source: AvatarCropSource = {
  dataUri: 'data:image/png;base64,AA==',
  height: 900,
  mimeType: 'image/png',
  path: '/source/avatar.png',
  width: 1200
}

beforeEach(() => {
  class MockImage {
    height = 1200
    naturalHeight = 1200
    naturalWidth = 900
    width = 900
    private readonly listeners = new Map<string, () => void>()

    addEventListener(type: string, listener: () => void): void {
      this.listeners.set(type, listener)
    }

    set src(_value: string) {
      queueMicrotask(() => this.listeners.get('load')?.())
    }
  }
  vi.stubGlobal('Image', MockImage)
})

afterEach(() => {
  editorBehavior.crop = { x: 0, y: 0 }
  editorBehavior.cropSize = 640
  editorBehavior.loadFails = false
  editorBehavior.mediaSize = undefined
  editorBehavior.rotation = 0
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderDialog(overrides: Partial<{
  onCancel: () => void
  onChooseSource: () => Promise<void>
  onSave: () => Promise<void>
  source: AvatarCropSource
}> = {}) {
  return render(
    <AvatarCropDialog
      source={overrides.source ?? source}
      onCancel={overrides.onCancel ?? vi.fn()}
      onChooseSource={overrides.onChooseSource ?? vi.fn().mockResolvedValue(undefined)}
      onSave={overrides.onSave ?? vi.fn().mockResolvedValue(undefined)}
    />
  )
}

describe('avatar crop dialog', () => {
  it('preserves crop adjustments on backdrop clicks and still allows Escape and Cancel', async () => {
    const user = userEvent.setup()
    const onCancel = vi.fn()
    renderDialog({ onCancel })
    const rotate = screen.getByRole('button', { name: 'settings.avatar_crop_rotate_right' })
    await waitFor(() => expect(rotate).toBeEnabled())
    await user.click(rotate)
    expect(editorBehavior.rotation).toBe(90)
    await user.click(document.querySelector('.ui-backdrop')!)
    expect(onCancel).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeVisible()
    expect(editorBehavior.rotation).toBe(90)
    await user.keyboard('{Escape}')
    expect(onCancel).toHaveBeenCalledTimes(1)
    onCancel.mockClear()
    await user.click(screen.getByRole('button', { name: 'common.cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })

  it('exposes crop controls, file selection, and cancellation', async () => {
    const onCancel = vi.fn()
    const onChooseSource = vi.fn().mockResolvedValue(undefined)
    const onSave = vi.fn()
    renderDialog({ onCancel, onChooseSource, onSave })

    expect(screen.getByRole('dialog', { name: 'settings.avatar_crop_title' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'settings.avatar_crop_preview' })).toBeInTheDocument()
    expect(screen.getByRole('slider', { name: 'settings.avatar_crop_zoom' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'settings.choose_avatar' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'common.save' })).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: 'settings.choose_avatar' }))
    await waitFor(() => expect(onChooseSource).toHaveBeenCalledOnce())
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))

    expect(onCancel).toHaveBeenCalledOnce()
    expect(onSave).not.toHaveBeenCalled()
  })

  it('restores persisted position, zoom, and rotation after media dimensions load', async () => {
    const restoredSource: AvatarCropSource = {
      ...source,
      transform: {
        crop: { height: 60, width: 45, x: 20, y: 10 },
        rotation: 90
      }
    }
    renderDialog({ source: restoredSource })

    await waitFor(() => expect(screen.getByRole('button', { name: 'common.save' })).toBeEnabled())
    await waitFor(() => expect(editorBehavior.crop).toEqual({ x: 42, y: -18 }))
    expect(editorBehavior.mediaSize).toEqual({ height: 426.6666666666667, naturalHeight: 1200, naturalWidth: 900, width: 320 })
    expect((screen.getByRole('slider', { name: 'settings.avatar_crop_zoom' }) as HTMLInputElement).value).toBe('2.5')
    expect(editorBehavior.rotation).toBe(90)
  })

  it('uses the cropper wheel interaction and keeps the slider synchronized', async () => {
    renderDialog()
    const slider = screen.getByRole('slider', { name: 'settings.avatar_crop_zoom' }) as HTMLInputElement
    await waitFor(() => expect(slider).toBeEnabled())

    fireEvent.wheel(screen.getByTestId('avatar-editor'), { deltaY: -100 })

    expect(Number(slider.value)).toBeGreaterThan(1)
  })

  it('stores the original source path, crop metadata, rotation, and bounded PNG cache', async () => {
    const context = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low',
      rotate: vi.fn(),
      translate: vi.fn()
    } as unknown as CanvasRenderingContext2D
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback) {
      callback({ arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer } as Blob)
    })
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderDialog({ onSave })
    const saveButton = screen.getByRole('button', { name: 'common.save' })
    await waitFor(() => expect(saveButton).toBeEnabled())

    fireEvent.click(screen.getByRole('button', { name: 'settings.avatar_crop_rotate_right' }))
    fireEvent.click(saveButton)

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    expect(onSave).toHaveBeenCalledWith({
      pngBytes: Uint8Array.from([1, 2, 3]),
      sourcePath: source.path,
      transform: {
        crop: { height: 80, width: 80, x: 10, y: 10 },
        rotation: 90
      }
    })
    expect(saveButton).toBeEnabled()
  })

  it('caps a larger crop cache at 1024px without upscaling smaller crops', async () => {
    editorBehavior.cropSize = 1600
    const outputSizes: Array<[number, number]> = []
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low',
      rotate: vi.fn(),
      translate: vi.fn()
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (this: HTMLCanvasElement, callback) {
      outputSizes.push([this.width, this.height])
      callback({ arrayBuffer: async () => Uint8Array.from([1]).buffer } as Blob)
    })
    const onSave = vi.fn().mockResolvedValue(undefined)
    renderDialog({ onSave })
    const saveButton = screen.getByRole('button', { name: 'common.save' })
    await waitFor(() => expect(saveButton).toBeEnabled())

    fireEvent.click(saveButton)

    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    expect(outputSizes).toEqual([[1024, 1024]])
  })

  it('keeps file selection available when the current source cannot be loaded', async () => {
    editorBehavior.loadFails = true
    renderDialog()

    expect(await screen.findByRole('alert')).toHaveTextContent('settings.avatar_crop_load_failed')
    expect(screen.getByRole('button', { name: 'common.save' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'settings.choose_avatar' })).toBeEnabled()
  })

  it('keeps the crop open and reports an error when saving fails', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      imageSmoothingEnabled: false,
      imageSmoothingQuality: 'low',
      rotate: vi.fn(),
      translate: vi.fn()
    } as unknown as CanvasRenderingContext2D)
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback({ arrayBuffer: async () => Uint8Array.from([1]).buffer } as Blob)
    })
    const onSave = vi.fn().mockRejectedValue(new Error('save failed'))
    renderDialog({ onSave })
    const saveButton = screen.getByRole('button', { name: 'common.save' })
    await waitFor(() => expect(saveButton).toBeEnabled())

    fireEvent.click(saveButton)

    await waitFor(() => expect(notice.error).toHaveBeenCalledWith('chat.failed_update_avatar'))
    expect(screen.getByRole('dialog', { name: 'settings.avatar_crop_title' })).toBeInTheDocument()
  })
})
