import { DragEvent, useEffect, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import type { AppAvatarImage, AvatarCropSaveRequest, AvatarCropSource } from '@shared/types'
import { dataTransferHasFiles } from '../dragDrop'
import { notice } from '../notice'

interface UsePersonaAvatarStateOptions {
  t: TFunction
}

export function usePersonaAvatarState({ t }: UsePersonaAvatarStateOptions) {
  const [avatar, setAvatar] = useState<AppAvatarImage | null>(null)
  const [avatarCropSource, setAvatarCropSource] = useState<AvatarCropSource | null>(null)
  const [avatarDragActive, setAvatarDragActive] = useState(false)
  const avatarDragDepthRef = useRef(0)

  useEffect(() => {
    let cancelled = false

    async function loadAvatar(): Promise<void> {
      try {
        const avatarSnapshot = await window.gale.files.getAvatar()
        if (!cancelled) setAvatar(avatarSnapshot)
      } catch {
        if (!cancelled) notice.error(t('chat.failed_load_app'))
      }
    }

    void loadAvatar()
    return () => {
      cancelled = true
    }
  }, [t])

  useEffect(() => window.gale.files.onAvatarChanged(setAvatar), [])

  async function choosePersonaAvatar(): Promise<void> {
    try {
      const source = await window.gale.files.chooseAvatarSource()
      if (source) setAvatarCropSource(source)
    } catch {
      notice.error(t('chat.failed_update_avatar'))
    }
  }

  async function editPersonaAvatar(): Promise<void> {
    try {
      const source = await window.gale.files.getAvatarSource()
      if (source) setAvatarCropSource(source)
      else await choosePersonaAvatar()
    } catch {
      notice.error(t('chat.failed_update_avatar'))
    }
  }

  function cancelPersonaAvatarCrop(): void {
    setAvatarCropSource(null)
  }

  async function applyPersonaAvatarUpdate(action: () => Promise<AppAvatarImage | null>): Promise<void> {
    const nextAvatar = await action()
    setAvatar(nextAvatar)
    setAvatarCropSource(null)
  }

  function savePersonaAvatarCrop(request: AvatarCropSaveRequest): Promise<void> {
    return applyPersonaAvatarUpdate(() => window.gale.files.saveAvatarCrop(request))
  }

  async function clearPersonaAvatar(): Promise<void> {
    try {
      const nextAvatar = await window.gale.files.clearAvatar()
      setAvatar(nextAvatar)
    } catch {
      notice.error(t('chat.failed_reset_avatar'))
    }
  }

  function handleAvatarDragEnter(event: DragEvent<HTMLButtonElement>): void {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    avatarDragDepthRef.current += 1
    setAvatarDragActive(true)
  }

  function handleAvatarDragOver(event: DragEvent<HTMLButtonElement>): void {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setAvatarDragActive(true)
  }

  function handleAvatarDragLeave(event: DragEvent<HTMLButtonElement>): void {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    avatarDragDepthRef.current = Math.max(0, avatarDragDepthRef.current - 1)
    if (avatarDragDepthRef.current === 0) setAvatarDragActive(false)
  }

  async function handleAvatarDrop(event: DragEvent<HTMLButtonElement>): Promise<void> {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    avatarDragDepthRef.current = 0
    setAvatarDragActive(false)
    const droppedFiles = Array.from(event.dataTransfer.files)
    if (droppedFiles.length === 0) return
    try {
      const result = await window.gale.files.readAvatarSourceFromDroppedFiles(droppedFiles)
      if (!result.ok) {
        notice.error(t(result.errorCode === 'unsupported_type'
          ? 'settings.avatar_source_unsupported_type'
          : 'settings.avatar_crop_load_failed'))
        return
      }
      setAvatarCropSource(result.source)
    } catch {
      notice.error(t('settings.avatar_crop_load_failed'))
    }
  }

  return {
    avatar,
    avatarCropSource,
    avatarDragActive,
    cancelPersonaAvatarCrop,
    choosePersonaAvatar,
    clearPersonaAvatar,
    editPersonaAvatar,
    handleAvatarDragEnter,
    handleAvatarDragLeave,
    handleAvatarDragOver,
    handleAvatarDrop,
    savePersonaAvatarCrop
  }
}
