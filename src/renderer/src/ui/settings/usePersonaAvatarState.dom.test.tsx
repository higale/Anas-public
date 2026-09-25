import type { DragEvent } from 'react'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { TFunction } from 'i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppAvatarImage, AvatarCropSaveRequest, AvatarCropSource } from '@shared/types'
import { notice } from '../notice'
import { usePersonaAvatarState } from './usePersonaAvatarState'

vi.mock('../notice', () => ({
  notice: { error: vi.fn() }
}))

const t = ((key: string) => key) as TFunction
const source: AvatarCropSource = {
  dataUri: 'data:image/png;base64,AA==',
  height: 900,
  mimeType: 'image/png',
  path: '/source/avatar.png',
  width: 1200
}
const avatar: AppAvatarImage = {
  dataUri: 'data:image/png;base64,AQ==',
  mimeType: 'image/png',
  path: '/avatar.png',
  source: 'custom'
}

afterEach(() => {
  vi.mocked(notice.error).mockReset()
  vi.unstubAllGlobals()
})

describe('persona avatar state', () => {
  it('opens and cancels cropping without changing the current avatar', async () => {
    const chooseAvatarSource = vi.fn().mockResolvedValue(source)
    const saveAvatarCrop = vi.fn()
    vi.stubGlobal('gale', {
      files: {
        chooseAvatarSource,
        getAvatar: vi.fn().mockResolvedValue(null),
        onAvatarChanged: vi.fn(() => () => undefined),
        saveAvatarCrop
      }
    })
    const { result } = renderHook(() => usePersonaAvatarState({ t }))
    await waitFor(() => expect(result.current.avatar).toBeNull())

    await act(async () => result.current.choosePersonaAvatar())

    expect(result.current.avatarCropSource).toEqual(source)
    expect(result.current.avatar).toBeNull()
    expect(saveAvatarCrop).not.toHaveBeenCalled()

    act(() => result.current.cancelPersonaAvatarCrop())
    expect(result.current.avatarCropSource).toBeNull()
  })

  it('uses the same crop source flow for drops and updates the avatar only after saving', async () => {
    const readAvatarSourceFromDroppedFiles = vi.fn().mockResolvedValue({ ok: true, source })
    const saveAvatarCrop = vi.fn().mockResolvedValue(avatar)
    vi.stubGlobal('gale', {
      files: {
        getAvatar: vi.fn().mockResolvedValue(null),
        onAvatarChanged: vi.fn(() => () => undefined),
        readAvatarSourceFromDroppedFiles,
        saveAvatarCrop
      }
    })
    const { result } = renderHook(() => usePersonaAvatarState({ t }))
    const droppedFile = new File(['image'], 'avatar.png', { type: 'image/png' })
    const dropEvent = {
      dataTransfer: { files: [droppedFile], types: ['Files'] },
      preventDefault: vi.fn()
    } as unknown as DragEvent<HTMLButtonElement>

    await act(async () => result.current.handleAvatarDrop(dropEvent))

    expect(readAvatarSourceFromDroppedFiles).toHaveBeenCalledWith([droppedFile])
    expect(result.current.avatarCropSource).toEqual(source)
    expect(result.current.avatar).toBeNull()

    const request: AvatarCropSaveRequest = {
      pngBytes: Uint8Array.from([1, 2, 3]),
      sourcePath: source.path,
      transform: { crop: { height: 80, width: 60, x: 20, y: 10 }, rotation: 90 }
    }
    await act(async () => result.current.savePersonaAvatarCrop(request))

    expect(saveAvatarCrop).toHaveBeenCalledWith(request)
    expect(result.current.avatar).toEqual(avatar)
    expect(result.current.avatarCropSource).toBeNull()
  })

  it('localizes unsupported avatar types returned by the main process', async () => {
    const readAvatarSourceFromDroppedFiles = vi.fn().mockResolvedValue({
      ok: false,
      errorCode: 'unsupported_type'
    })
    vi.stubGlobal('gale', {
      files: {
        getAvatar: vi.fn().mockResolvedValue(null),
        onAvatarChanged: vi.fn(() => () => undefined),
        readAvatarSourceFromDroppedFiles
      }
    })
    const { result } = renderHook(() => usePersonaAvatarState({ t }))
    await waitFor(() => expect(result.current.avatar).toBeNull())
    const droppedFile = new File(['text'], 'avatar.txt', { type: 'text/plain' })
    const dropEvent = {
      dataTransfer: { files: [droppedFile], types: ['Files'] },
      preventDefault: vi.fn()
    } as unknown as DragEvent<HTMLButtonElement>

    await act(async () => result.current.handleAvatarDrop(dropEvent))

    expect(notice.error).toHaveBeenCalledWith('settings.avatar_source_unsupported_type')
    expect(result.current.avatarCropSource).toBeNull()
  })

  it('opens the current original source and its persisted transform for editing', async () => {
    const currentSource: AvatarCropSource = {
      ...source,
      transform: { crop: { height: 75, width: 50, x: 25, y: 10 }, rotation: 270 }
    }
    const getAvatarSource = vi.fn().mockResolvedValue(currentSource)
    vi.stubGlobal('gale', {
      files: {
        getAvatar: vi.fn().mockResolvedValue(null),
        onAvatarChanged: vi.fn(() => () => undefined),
        getAvatarSource
      }
    })
    const { result } = renderHook(() => usePersonaAvatarState({ t }))
    await waitFor(() => expect(result.current.avatar).toBeNull())

    await act(async () => result.current.editPersonaAvatar())

    expect(getAvatarSource).toHaveBeenCalledOnce()
    expect(result.current.avatarCropSource).toEqual(currentSource)
  })

  it('updates immediately when the main process broadcasts an avatar change', async () => {
    let listener: ((nextAvatar: AppAvatarImage | null) => void) | undefined
    const unsubscribe = vi.fn()
    vi.stubGlobal('gale', {
      files: {
        getAvatar: vi.fn().mockResolvedValue(null),
        onAvatarChanged: vi.fn((nextListener: (nextAvatar: AppAvatarImage | null) => void) => {
          listener = nextListener
          return unsubscribe
        })
      }
    })

    const { result, unmount } = renderHook(() => usePersonaAvatarState({ t }))
    await waitFor(() => expect(listener).toBeDefined())

    act(() => listener?.(avatar))
    expect(result.current.avatar).toEqual(avatar)

    unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
