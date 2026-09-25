import { useEffect, useState } from 'react'
import type { TFunction } from 'i18next'
import type { EnvFileSnapshot } from '@shared/types'
import { notice } from '../notice'
import { useQueuedAutosave } from '../useQueuedAutosave'
import type { SettingsTab } from './settingsTabs'

interface UseEnvSettingsStateOptions {
  settingsOpen: boolean
  settingsTab: SettingsTab
  t: TFunction
}

export function useEnvSettingsState({ settingsOpen, settingsTab, t }: UseEnvSettingsStateOptions) {
  const [envFile, setEnvFile] = useState<EnvFileSnapshot | undefined>()
  const [envDraft, setEnvDraft] = useState('')
  const envAutosave = useQueuedAutosave()
  const envNoticeId = 'settings-env-status'

  useEffect(() => {
    if (!settingsOpen || settingsTab !== 'environment') return
    let cancelled = false

    async function loadEnvFile(): Promise<void> {
      try {
        const snapshot = await window.gale.app.readEnvFile()
        if (cancelled) return
        setEnvFile(snapshot)
        setEnvDraft(snapshot.content)
      } catch {
        if (!cancelled) notice.error(t('chat.failed_load_env'), { id: envNoticeId })
      }
    }

    void loadEnvFile()
    return () => {
      cancelled = true
    }
  }, [settingsOpen, settingsTab, t])

  function updateEnvDraft(value: string): void {
    setEnvDraft(value)
    notice.info(t('settings.env_saving'), { id: envNoticeId, duration: 600000 })
    const revision = envAutosave.revise('env')
    void envAutosave.enqueue(revision, async (request) => {
      try {
        const snapshot = await window.gale.app.saveEnvFile(value)
        if (!request.isCurrent()) return
        setEnvFile(snapshot)
        setEnvDraft(snapshot.content)
        notice.success(t('settings.env_saved'), { id: envNoticeId })
      } catch {
        if (!request.isCurrent()) return
        notice.error(t('settings.failed_save_env'), { id: envNoticeId })
      }
    })
  }

  async function openEnvFile(): Promise<void> {
    if (!envFile?.path) return
    try {
      await window.gale.app.showItemInFolder(envFile.path)
    } catch {
      notice.error(t('settings.failed_open_env'), { id: envNoticeId })
    }
  }

  return {
    envDraft,
    envPath: envFile?.path,
    openEnvFile,
    updateEnvDraft
  }
}
