import { useEffect, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import type {
  MemoryItem,
  MemoryKind,
  MemorySaveRequest,
  MemoryScope,
  MemorySearchResult
} from '@shared/types'
import type { ConfirmDialogRequest } from '../dialogs/AppDialogs'
import { notice } from '../notice'
import type { SettingsTab } from './settingsTabs'

export interface MemoryDraft {
  id?: string
  scope: MemoryScope
  projectId?: string
  kind: MemoryKind
  content: string
  keywordsText: string
  importance: number
}

interface UseMemorySettingsStateOptions {
  openConfirmDialog: (request: ConfirmDialogRequest) => void
  settingsOpen: boolean
  settingsTab: SettingsTab
  t: TFunction
}

function draftFromMemory(memory: MemoryItem): MemoryDraft {
  return {
    id: memory.id,
    scope: memory.scope,
    projectId: memory.projectId,
    kind: memory.kind,
    content: memory.content,
    keywordsText: memory.keywords.join(', '),
    importance: memory.importance
  }
}

function newMemoryDraft(): MemoryDraft {
  return {
    scope: 'global',
    kind: 'fact',
    content: '',
    keywordsText: '',
    importance: 3
  }
}

function saveRequest(draft: MemoryDraft): MemorySaveRequest {
  return {
    ...(draft.id ? { id: draft.id } : {}),
    scope: draft.scope,
    ...(draft.scope === 'project' ? { projectId: draft.projectId } : {}),
    kind: draft.kind,
    content: draft.content,
    keywords: draft.keywordsText.split(/[,，\n]/).map((keyword) => keyword.trim()).filter(Boolean),
    importance: draft.importance
  }
}

export function useMemorySettingsState({
  openConfirmDialog,
  settingsOpen,
  settingsTab,
  t
}: UseMemorySettingsStateOptions) {
  const [result, setResult] = useState<MemorySearchResult>({ items: [], total: 0 })
  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<'all' | MemoryScope>('all')
  const [kind, setKind] = useState<'all' | MemoryKind>('all')
  const [selectedId, setSelectedId] = useState<string | undefined>()
  const [draft, setDraft] = useState<MemoryDraft | undefined>()
  const [saving, setSaving] = useState(false)
  const memoryListRef = useRef<HTMLDivElement | null>(null)
  const searchRevision = useRef(0)
  const editorRevision = useRef(0)
  const draftDirty = useRef(false)
  const draftRef = useRef<MemoryDraft | undefined>(undefined)
  const selectedIdRef = useRef<string | undefined>(undefined)

  function replaceEditor(nextDraft: MemoryDraft | undefined, nextId: string | undefined, dirty: boolean): void {
    editorRevision.current += 1
    draftDirty.current = dirty
    draftRef.current = nextDraft
    selectedIdRef.current = nextId
    setDraft(nextDraft)
    setSelectedId(nextId)
  }

  async function loadMemories(preferredId?: string): Promise<void> {
    const revision = ++searchRevision.current
    const editorRevisionAtStart = editorRevision.current
    try {
      const next = await window.gale.memory.search({ query, scope, kind, limit: 500 })
      if (revision !== searchRevision.current) return
      setResult(next)
      if (draftDirty.current || editorRevision.current !== editorRevisionAtStart) return
      const nextId = preferredId
        ?? (selectedIdRef.current && next.items.some((item) => item.id === selectedIdRef.current)
          ? selectedIdRef.current
          : next.items[0]?.id)
      if (!nextId) {
        replaceEditor(undefined, undefined, false)
        return
      }
      const selected = next.items.find((item) => item.id === nextId)
      if (!selected) return
      replaceEditor(draftFromMemory(selected), selected.id, false)
    } catch {
      if (revision === searchRevision.current) notice.error(t('chat.failed_load_memory'))
    }
  }

  useEffect(() => {
    if (!settingsOpen || settingsTab !== 'memory') return
    const timer = window.setTimeout(() => void loadMemories(), 150)
    return () => window.clearTimeout(timer)
  }, [settingsOpen, settingsTab, query, scope, kind])

  function selectMemory(id: string): void {
    const memory = result.items.find((item) => item.id === id)
    if (!memory) return
    replaceEditor(draftFromMemory(memory), id, false)
  }

  function startNewMemory(): void {
    replaceEditor(newMemoryDraft(), undefined, true)
  }

  function updateMemoryDraft(patch: Partial<MemoryDraft>): void {
    const current = draftRef.current
    if (!current) return
    replaceEditor({ ...current, ...patch }, selectedIdRef.current, true)
  }

  async function saveMemory(): Promise<void> {
    const pendingDraft = draftRef.current
    if (!pendingDraft || saving) return
    const editorRevisionAtStart = editorRevision.current
    setSaving(true)
    try {
      const memory = await window.gale.memory.save(saveRequest(pendingDraft))
      if (editorRevision.current === editorRevisionAtStart) {
        replaceEditor(draftFromMemory(memory), memory.id, false)
      }
      await loadMemories(memory.id)
      notice.success(t('settings.memory_saved'))
    } catch {
      notice.error(t('settings.failed_save_memory'))
    } finally {
      setSaving(false)
    }
  }

  function deleteMemory(): void {
    const currentDraft = draftRef.current
    if (!currentDraft?.id) {
      replaceEditor(undefined, undefined, false)
      return
    }
    const id = currentDraft.id
    const editorRevisionAtStart = editorRevision.current
    openConfirmDialog({
      title: t('settings.delete_memory_title'),
      description: t('settings.cannot_be_undone'),
      confirmText: t('common.delete'),
      variant: 'danger',
      onConfirm: async () => {
        try {
          await window.gale.memory.delete(id)
          if (editorRevision.current === editorRevisionAtStart) {
            replaceEditor(undefined, undefined, false)
          }
          await loadMemories()
          notice.success(t('settings.memory_deleted'))
        } catch {
          notice.error(t('settings.failed_delete_memory'))
        }
      }
    })
  }

  return {
    draft,
    kind,
    memoryListRef,
    query,
    result,
    saving,
    scope,
    selectedId,
    deleteMemory,
    saveMemory,
    selectMemory,
    setKind,
    setQuery,
    setScope,
    startNewMemory,
    updateMemoryDraft
  }
}

export type MemorySettingsState = ReturnType<typeof useMemorySettingsState>
