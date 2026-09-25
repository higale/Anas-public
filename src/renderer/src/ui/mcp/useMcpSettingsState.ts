import { useEffect, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import type { AppConfigSnapshot, McpToolStatus } from '@shared/types'
import type { ConfirmDialogRequest } from '../dialogs/AppDialogs'
import { notice } from '../notice'
import { useQueuedAutosave } from '../useQueuedAutosave'
import {
  buildMcpPayload,
  emptyMcpDraft,
  mcpDetailToDraft,
  nextMcpServerId,
  validateMcpDraftId,
  validateMcpDraftIdUnique,
  validateMcpDraftForEnable
} from './mcpDraft'
import type { McpDraft } from './mcpDraft'

interface UseMcpSettingsStateOptions {
  config: AppConfigSnapshot | undefined
  openConfirmDialog: (request: ConfirmDialogRequest) => void
  setConfig: (config: AppConfigSnapshot) => void
  t: TFunction
}

export function useMcpSettingsState({ config, openConfirmDialog, setConfig, t }: UseMcpSettingsStateOptions) {
  const [mcpStatus, setMcpStatus] = useState<McpToolStatus | undefined>()
  const [editingMcpIndex, setEditingMcpIndex] = useState<number | undefined>()
  const [mcpDraft, setMcpDraft] = useState<McpDraft>(() => emptyMcpDraft(t))
  const [creatingMcpServer, setCreatingMcpServer] = useState(false)
  const [mcpReloadingFailed, setMcpReloadingFailed] = useState(false)
  const mcpDraftRef = useRef<McpDraft>(emptyMcpDraft(t))
  const mcpAutosave = useQueuedAutosave()
  const mcpNoticeId = 'settings-mcp-status'

  const mcpRuntimeEnabled = Boolean(config)

  useEffect(() => {
    let cancelled = false
    void window.gale.mcp.status()
      .then((status) => {
        if (!cancelled && status) setMcpStatus(status)
      })
      .catch(() => undefined)
    const unsubscribe = window.gale.mcp.onStatus((status) => {
      setMcpStatus(status)
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (!config) return

    if (editingMcpIndex !== undefined && config.mcpServers.some((server) => server.index === editingMcpIndex)) {
      if (mcpDraftRef.current.index !== editingMcpIndex) {
        const server = config.mcpServers.find((item) => item.index === editingMcpIndex)
        const draft = server ? mcpDetailToDraft(server) : emptyMcpDraft(t)
        mcpDraftRef.current = draft
        setMcpDraft(draft)
      }
      return
    }

    if (creatingMcpServer) {
      return
    }

    if (config.mcpServers.length > 0) {
      setEditingMcpIndex(config.mcpServers[0].index)
    } else {
      setEditingMcpIndex(undefined)
      const draft = emptyMcpDraft(t)
      mcpDraftRef.current = draft
      setMcpDraft(draft)
    }
  }, [config, creatingMcpServer, editingMcpIndex, t])

  async function saveMcpDraftImmediately(draft: McpDraft): Promise<void> {
    const revision = mcpAutosave.revise(draft.index === undefined
      ? `mcp:new:${draft.id}`
      : `mcp:${draft.index}`)
    await mcpAutosave.enqueue(revision, async (request) => {
      try {
        const nextConfig = await window.gale.config.saveMcpServer(buildMcpPayload(draft))
        if (!request.isCurrent()) return
        setConfig(nextConfig)
        if (draft.index === undefined) {
          const nextIndex = nextConfig.mcpServers[nextConfig.mcpServers.length - 1]?.index
          setEditingMcpIndex(nextIndex)
        }
        setCreatingMcpServer(false)
      } catch {
        if (!request.isCurrent()) return
        notice.error(t('settings.failed_save_mcp'), { id: mcpNoticeId })
      }
    })
  }

  function updateMcpDraft(update: Partial<McpDraft>): void {
    const current = mcpDraftRef.current
    const stopRunningServerForEdit = mcpRuntimeEnabled && current.enabled && update.enabled === undefined
    const nextDraft = {
      ...current,
      ...update,
      ...(stopRunningServerForEdit ? { enabled: false } : {})
    }
    const invalidIdError = validateMcpDraftId(nextDraft, t)
    if (invalidIdError) {
      notice.error(invalidIdError, { id: mcpNoticeId })
      return
    }
    const idError = validateMcpDraftIdUnique(nextDraft, config?.mcpServers, t)
    if (idError) {
      notice.error(idError, { id: mcpNoticeId })
      return
    }
    if (update.enabled === true) {
      const error = validateMcpDraftForEnable(nextDraft, t)
      if (error) {
        notice.error(error, { id: mcpNoticeId })
        return
      }
    }
    if (stopRunningServerForEdit) {
      notice.info(t('settings.mcp_server_stopped_for_edit'), { id: mcpNoticeId })
    }
    mcpDraftRef.current = nextDraft
    setMcpDraft(nextDraft)
    void saveMcpDraftImmediately(nextDraft)
  }

  async function addMcpServer(): Promise<void> {
    const draft = {
      ...emptyMcpDraft(t),
      id: nextMcpServerId(config?.mcpServers)
    }
    mcpDraftRef.current = draft
    setCreatingMcpServer(true)
    setEditingMcpIndex(undefined)
    setMcpDraft(draft)
    await saveMcpDraftImmediately(draft)
  }

  async function editMcpServer(index: number): Promise<void> {
    setCreatingMcpServer(false)
    setEditingMcpIndex(index)
  }

  async function deleteEditingMcpServer(): Promise<void> {
    if (editingMcpIndex === undefined) return
    const index = editingMcpIndex
    const name = config?.mcpServers.find((server) => server.index === index)?.name ?? t('settings.this_mcp_server')
    openConfirmDialog({
      title: t('settings.delete_mcp_title', { name }),
      description: t('settings.cannot_be_undone'),
      confirmText: t('common.delete'),
      variant: 'danger',
      onConfirm: async () => {
        try {
          const nextConfig = await window.gale.config.deleteMcpServer(index)
          setConfig(nextConfig)
          setCreatingMcpServer(false)
          setEditingMcpIndex(nextConfig.mcpServers[Math.min(index, nextConfig.mcpServers.length - 1)]?.index)
        } catch {
          notice.error(t('settings.failed_delete_mcp'), { id: mcpNoticeId })
        }
      }
    })
  }

  async function moveEditingMcpServer(direction: -1 | 1): Promise<void> {
    if (editingMcpIndex === undefined) return
    try {
      const nextConfig = await window.gale.config.moveMcpServer(editingMcpIndex, direction)
      const nextIndex = editingMcpIndex + direction
      setConfig(nextConfig)
      setCreatingMcpServer(false)
      setEditingMcpIndex(nextConfig.mcpServers[nextIndex]?.index ?? editingMcpIndex)
    } catch {
      notice.error(t('settings.failed_move_mcp'), { id: mcpNoticeId })
    }
  }

  async function reloadFailedMcpServers(): Promise<void> {
    if (mcpReloadingFailed) return
    setMcpReloadingFailed(true)
    try {
      const result = await window.gale.mcp.reloadFailed()
      if (result.alreadyRunning) {
        notice.info(t('settings.mcp_maintenance_already_running'), { id: mcpNoticeId })
      } else if (result.scheduled) {
        notice.success(t('settings.mcp_maintenance_scheduled'), { id: mcpNoticeId })
      } else if (result.reason === 'disabled') {
        notice.info(t('settings.mcp_maintenance_disabled'), { id: mcpNoticeId })
      } else if (result.reason === 'no_servers') {
        notice.info(t('settings.mcp_maintenance_no_servers'), { id: mcpNoticeId })
      } else {
        notice.info(t('settings.mcp_maintenance_not_scheduled'), { id: mcpNoticeId })
      }
    } catch {
      notice.error(t('settings.failed_load_mcp'), { id: mcpNoticeId })
    } finally {
      setMcpReloadingFailed(false)
    }
  }

  return {
    addMcpServer,
    deleteEditingMcpServer,
    editMcpServer,
    editingMcpIndex,
    mcpDraft,
    mcpReloadingFailed,
    mcpRuntimeEnabled,
    mcpStatus,
    moveEditingMcpServer,
    reloadFailedMcpServers,
    updateMcpDraft
  }
}
