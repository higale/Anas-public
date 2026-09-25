import { useEffect, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import type { AppConfigSnapshot } from '@shared/types'
import type { ConfirmDialogRequest } from '../dialogs/AppDialogs'
import { notice } from '../notice'
import { scrollListToBottom } from '../chat/scrollUtils'
import { useQueuedAutosave } from '../useQueuedAutosave'
import {
  createSubagentDraft,
  subagentSavePayload,
  subagentToDraft,
  validateSubagentForEnable,
  validateSubagentName,
  type SubagentDraft
} from './subagentDraft'

interface UseSubagentSettingsStateOptions {
  config: AppConfigSnapshot | undefined
  openConfirmDialog: (request: ConfirmDialogRequest) => void
  setConfig: (config: AppConfigSnapshot) => void
  t: TFunction
}

export function useSubagentSettingsState({
  config,
  openConfirmDialog,
  setConfig,
  t
}: UseSubagentSettingsStateOptions) {
  const [editingIndex, setEditingIndex] = useState<number | undefined>()
  const [draft, setDraft] = useState<SubagentDraft>(() => createSubagentDraft(config, t))
  const [creating, setCreating] = useState(false)
  const draftRef = useRef(draft)
  const listRef = useRef<HTMLDivElement | null>(null)
  const autosave = useQueuedAutosave()
  const noticeId = 'settings-subagent'

  useEffect(() => {
    if (!config) return
    const selected = editingIndex === undefined
      ? undefined
      : config.subagents.find((subagent) => subagent.index === editingIndex)
    if (selected) {
      if (draftRef.current.index !== selected.index) {
        const next = subagentToDraft(selected)
        draftRef.current = next
        setDraft(next)
      }
      return
    }
    if (creating) return
    const first = config.subagents[0]
    if (first) {
      setEditingIndex(first.index)
    } else {
      const next = createSubagentDraft(config, t)
      draftRef.current = next
      setDraft(next)
      setEditingIndex(undefined)
    }
  }, [config, creating, editingIndex, t])

  async function saveImmediately(nextDraft: SubagentDraft): Promise<void> {
    const revision = autosave.revise(nextDraft.index === undefined
      ? 'subagent:new'
      : `subagent:${nextDraft.index}`)
    await autosave.enqueue(revision, async (request) => {
      try {
        const nextConfig = await window.gale.config.saveSubagent(
          subagentSavePayload(nextDraft)
        )
        if (!request.isCurrent()) return
        setConfig(nextConfig)
        if (nextDraft.index === undefined) {
          const created = nextConfig.subagents.at(-1)
          if (created) {
            setEditingIndex(created.index)
            const savedDraft = subagentToDraft(created)
            draftRef.current = savedDraft
            setDraft(savedDraft)
            window.requestAnimationFrame(() => scrollListToBottom(listRef.current))
          }
        }
        setCreating(false)
      } catch {
        if (!request.isCurrent()) return
        notice.error(
          t('settings.subagent_failed_save'),
          { id: noticeId }
        )
      }
    })
  }

  function updateDraft(update: Partial<SubagentDraft>): void {
    const next = {
      ...draftRef.current,
      ...update
    }
    const nameError = validateSubagentName(next, config?.subagents, t)
    if (nameError) {
      notice.error(nameError, { id: noticeId })
      return
    }
    if (update.enabled === true) {
      const enableError = validateSubagentForEnable(next, t)
      if (enableError) {
        notice.error(enableError, { id: noticeId })
        return
      }
    }
    draftRef.current = next
    setDraft(next)
    void saveImmediately(next)
  }

  async function addSubagent(): Promise<void> {
    const next = createSubagentDraft(config, t)
    draftRef.current = next
    setCreating(true)
    setEditingIndex(undefined)
    setDraft(next)
    await saveImmediately(next)
  }

  function editSubagent(index: number): void {
    const selected = config?.subagents.find((subagent) => subagent.index === index)
    if (!selected) return
    const next = subagentToDraft(selected)
    draftRef.current = next
    setCreating(false)
    setEditingIndex(index)
    setDraft(next)
  }

  function deleteSubagent(): void {
    const selected = config?.subagents.find((subagent) => subagent.index === editingIndex)
    if (!selected || selected.builtIn) return
    openConfirmDialog({
      title: t('settings.subagent_delete_title', { name: selected.name }),
      description: t('settings.cannot_be_undone'),
      confirmText: t('common.delete'),
      variant: 'danger',
      onConfirm: async () => {
        try {
          await autosave.waitForIdle()
          const nextConfig = await window.gale.config.deleteSubagent(selected.index)
          setConfig(nextConfig)
          const next = nextConfig.subagents[Math.min(selected.index, nextConfig.subagents.length - 1)]
          setEditingIndex(next?.index)
          setCreating(false)
        } catch {
          notice.error(
            t('settings.subagent_failed_delete'),
            { id: noticeId }
          )
        }
      }
    })
  }

  async function moveSubagent(direction: -1 | 1): Promise<void> {
    if (editingIndex === undefined) return
    const index = editingIndex
    try {
      await autosave.waitForIdle()
      const nextConfig = await window.gale.config.moveSubagent(index, direction)
      const nextIndex = index + direction
      setConfig(nextConfig)
      setEditingIndex(nextConfig.subagents[nextIndex]?.index ?? index)
      setCreating(false)
    } catch {
      notice.error(
        t('settings.subagent_failed_move'),
        { id: noticeId }
      )
    }
  }

  function restoreSubagent(): void {
    const selected = config?.subagents.find((subagent) => subagent.index === editingIndex)
    if (!selected?.builtIn) return
    openConfirmDialog({
      title: t('settings.subagent_restore_title', { name: selected.name }),
      description: t('settings.subagent_restore_description'),
      confirmText: t('settings.restore_default'),
      onConfirm: async () => {
        try {
          await autosave.waitForIdle()
          const nextConfig = await window.gale.config.restoreSubagent(selected.index)
          setConfig(nextConfig)
          const restored = nextConfig.subagents[selected.index]
          if (restored) {
            const next = subagentToDraft(restored)
            draftRef.current = next
            setDraft(next)
          }
        } catch {
          notice.error(
            t('settings.subagent_failed_restore'),
            { id: noticeId }
          )
        }
      }
    })
  }

  return {
    addSubagent,
    deleteSubagent,
    draft,
    editSubagent,
    editingIndex,
    listRef,
    moveSubagent,
    restoreSubagent,
    updateDraft
  }
}
