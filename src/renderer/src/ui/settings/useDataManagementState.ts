import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import type { AgentStorageUsageSnapshot, AgentThreadCleanupResult } from '@shared/agentTypes'
import type { AppConfigSnapshot, AppDataStorageUsageSnapshot, DataCleanupRequest, InputHistorySnapshot, StorageUsageValue } from '@shared/types'
import { dataCleanupTargets, defaultDataCleanupSelection } from '../dialogs/AppDialogs'
import type { ConfirmDialogRequest, DataCleanupDialogTarget, DataCleanupSelection, DataCleanupUsage } from '../dialogs/AppDialogs'
import { notice } from '../notice'
import type { SettingsTab } from './settingsTabs'

interface UseDataManagementStateOptions {
  openConfirmDialog: (request: ConfirmDialogRequest) => void
  setConfig: (update: (current: AppConfigSnapshot | undefined) => AppConfigSnapshot | undefined) => void
  setInputHistory: (snapshot: InputHistorySnapshot) => void
  cleanupAgentThreads: () => Promise<AgentThreadCleanupResult>
  settingsOpen: boolean
  settingsTab: SettingsTab
  t: TFunction
}

export function useDataManagementState({
  openConfirmDialog,
  setConfig,
  setInputHistory,
  cleanupAgentThreads,
  settingsOpen,
  settingsTab,
  t
}: UseDataManagementStateOptions) {
  const [dataCleanupOpen, setDataCleanupOpen] = useState(false)
  const [dataCleanupBusy, setDataCleanupBusy] = useState(false)
  const [dataCleanupSelection, setDataCleanupSelection] = useState<DataCleanupSelection>(() => defaultDataCleanupSelection())
  const [developerHttpTraceEnabled, setDeveloperHttpTraceEnabledState] = useState(false)
  const [appStorageUsage, setAppStorageUsage] = useState<AppDataStorageUsageSnapshot>()
  const [agentStorageUsage, setAgentStorageUsage] = useState<AgentStorageUsageSnapshot>()
  const [storageUsageLoading, setStorageUsageLoading] = useState(false)
  const [developerHttpTraceUsage, setDeveloperHttpTraceUsage] = useState<StorageUsageValue>()
  const [developerHttpTraceUsageLoading, setDeveloperHttpTraceUsageLoading] = useState(false)
  const developerHttpTraceUsageTask = useRef<Promise<void> | undefined>(undefined)
  const developerHttpTraceRevisionRef = useRef(0)
  const storageUsageRevisionRef = useRef(0)

  const refreshDeveloperHttpTraceUsage = useCallback((): Promise<void> => {
    if (developerHttpTraceUsageTask.current) return developerHttpTraceUsageTask.current
    setDeveloperHttpTraceUsageLoading(true)
    const task = window.gale.app.getDeveloperHttpTraceUsage()
      .then(setDeveloperHttpTraceUsage)
      .catch(() => setDeveloperHttpTraceUsage(undefined))
      .finally(() => {
        setDeveloperHttpTraceUsageLoading(false)
        developerHttpTraceUsageTask.current = undefined
      })
    developerHttpTraceUsageTask.current = task
    return task
  }, [])

  const refreshStorageUsage = useCallback(async (): Promise<void> => {
    const revision = ++storageUsageRevisionRef.current
    setStorageUsageLoading(true)
    const [appResult, agentResult] = await Promise.allSettled([
      window.gale.app.getDataStorageUsage(),
      window.gale.agent.maintenance.getStorageUsage()
    ])
    if (storageUsageRevisionRef.current !== revision) return
    setAppStorageUsage(appResult.status === 'fulfilled' ? appResult.value : undefined)
    setAgentStorageUsage(agentResult.status === 'fulfilled' ? agentResult.value : undefined)
    setStorageUsageLoading(false)
  }, [])

  const dataCleanupUsage = useMemo<DataCleanupUsage>(() => ({
    ...appStorageUsage?.cleanup,
    ...(agentStorageUsage
      ? {
          agent_unpinned_threads: agentStorageUsage.conversations,
          memories: agentStorageUsage.memories
        }
      : {})
  }), [agentStorageUsage, appStorageUsage])

  useEffect(() => {
    let active = true
    const revision = developerHttpTraceRevisionRef.current
    void window.gale.app.getDeveloperHttpTraceEnabled()
      .then((enabled) => {
        if (active && developerHttpTraceRevisionRef.current === revision) {
          setDeveloperHttpTraceEnabledState(enabled)
        }
      })
      .catch(() => undefined)
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    if (!settingsOpen || settingsTab !== 'general') return
    void refreshStorageUsage()
  }, [refreshStorageUsage, settingsOpen, settingsTab])

  useEffect(() => {
    if (!settingsOpen || settingsTab !== 'dev') return
    void refreshDeveloperHttpTraceUsage()
  }, [refreshDeveloperHttpTraceUsage, settingsOpen, settingsTab])

  async function openDataDirectory(): Promise<void> {
    try {
      await window.gale.app.openDataDir()
    } catch {
      notice.error(t('settings.failed_open_data_dir'))
    }
  }

  async function openLogDirectory(): Promise<void> {
    try {
      await window.gale.app.openLogDir()
    } catch {
      notice.error(t('settings.failed_open_log'))
    }
  }

  async function openRuntimeLogViewer(): Promise<void> {
    try {
      await window.gale.app.openLogViewer()
    } catch {
      notice.error(t('settings.failed_open_log'))
    }
  }

  async function openDeveloperHttpTraceDirectory(): Promise<void> {
    try {
      await window.gale.app.openDeveloperHttpTraceDir()
    } catch {
      notice.error(t('settings.failed_open_developer_http_trace'))
    }
  }

  async function updateDeveloperHttpTraceEnabled(enabled: boolean): Promise<void> {
    const revision = ++developerHttpTraceRevisionRef.current
    try {
      const current = await window.gale.app.setDeveloperHttpTraceEnabled(enabled)
      if (developerHttpTraceRevisionRef.current === revision) {
        setDeveloperHttpTraceEnabledState(current)
      }
    } catch {
      notice.error(t('settings.failed_update_developer_http_trace'))
    }
  }

  async function backupDataDirectory(): Promise<void> {
    try {
      const result = await window.gale.app.backupData()
      if (!result) return
      setConfig((current) => current ? {
        ...current,
        settings: {
          ...current.settings,
          backupDir: result.backupDir
        }
      } : current)
      notice.success(t('settings.backup_completed'))
    } catch {
      notice.error(t('settings.failed_backup'))
    }
  }

  async function restoreDataDirectory(): Promise<void> {
    let sourcePath: string | null
    try {
      sourcePath = await window.gale.app.selectDataRestoreBackup()
    } catch {
      notice.error(t('settings.failed_restore_data'))
      return
    }
    if (!sourcePath) return

    openConfirmDialog({
      title: t('settings.restore_data_title'),
      description: t('settings.restore_data_description'),
      confirmText: t('settings.restore_data_action'),
      variant: 'danger',
      onConfirm: async () => {
        try {
          await window.gale.app.restoreData(sourcePath)
          notice.success(t('settings.restore_completed'))
          window.location.reload()
        } catch {
          notice.error(t('settings.failed_restore_data'))
        }
      }
    })
  }

  function toggleDataCleanupTarget(target: DataCleanupDialogTarget, checked: boolean): void {
    setDataCleanupSelection((current) => ({ ...current, [target]: checked }))
  }

  function toggleAllDataCleanupTargets(checked: boolean): void {
    setDataCleanupSelection(() => {
      const selection = defaultDataCleanupSelection()
      for (const target of dataCleanupTargets) selection[target] = checked
      return selection
    })
  }

  function closeDataCleanupDialog(): void {
    setDataCleanupOpen(false)
    setDataCleanupSelection(defaultDataCleanupSelection())
  }

  async function runDataCleanup(): Promise<void> {
    const request = { ...dataCleanupSelection }
    const selectedCount = dataCleanupTargets.filter((target) => request[target]).length
    if (selectedCount === 0 || dataCleanupBusy) return

    setDataCleanupBusy(true)
    try {
      const appRequest: DataCleanupRequest = {
        input_history: request.input_history,
        cache_folder: request.cache_folder,
        temp_folder: request.temp_folder,
        log_folder: request.log_folder,
        developer_http_trace: request.developer_http_trace
      }
      const shouldCompactAgentDatabase = Boolean(!request.memories && request.agent_unpinned_threads)
      const [appResult, agentResults] = await Promise.all([
        window.gale.app.cleanupData(appRequest),
        Promise.all([
          ...(request.agent_unpinned_threads ? [cleanupAgentThreads()] : [])
        ]),
        request.memories ? window.gale.memory.clear() : Promise.resolve(0)
      ])
      let failed = appResult.items.filter((item) => !item.ok).length
        + agentResults.reduce((total, item) => total + item.failed, 0)
      const skipped = agentResults.reduce((total, item) => total + item.skipped, 0)
      if (shouldCompactAgentDatabase) {
        try {
          await window.gale.agent.maintenance.compactDatabase()
        } catch {
          failed += 1
        }
      }
      if (request.input_history) {
        setInputHistory(await window.gale.inputHistory.get())
      }
      if (failed > 0 || skipped > 0) {
        notice.warning(t('settings.cleanup_completed_with_issues', { failed, skipped }))
      } else {
        notice.success(t('settings.cleanup_completed'))
      }
      closeDataCleanupDialog()
      void refreshStorageUsage()
    } catch {
      notice.error(t('settings.failed_cleanup_data'))
    } finally {
      setDataCleanupBusy(false)
    }
  }

  return {
    backupDataDirectory,
    closeDataCleanupDialog,
    dataCleanupBusy,
    dataCleanupOpen,
    dataCleanupSelection,
    dataCleanupUsage,
    dataDirectoryUsage: appStorageUsage?.dataDirectory,
    developerHttpTraceEnabled,
    developerHttpTraceUsage,
    developerHttpTraceUsageLoading,
    openDataCleanup: () => {
      setDataCleanupOpen(true)
      void refreshStorageUsage()
    },
    openDataDirectory,
    openDeveloperHttpTraceDirectory,
    openLogDirectory,
    openRuntimeLogViewer,
    restoreDataDirectory,
    runDataCleanup,
    storageUsageLoading,
    toggleAllDataCleanupTargets,
    toggleDataCleanupTarget,
    updateDeveloperHttpTraceEnabled
  }
}
