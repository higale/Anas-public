import type { DefaultCapabilitySettings } from '@shared/agentCapabilities'
import { useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { TFunction } from 'i18next'
import type { AppConfigSnapshot, AppProfileUpdate, AppSettings, SpeechReplyConfig } from '@shared/types'
import { applyLanguagePreference } from '../../i18n'
import { notice } from '../notice'
import type { SettingsTab } from './settingsTabs'

type CanLeaveSettingsTab = () => boolean | Promise<boolean>

interface UseSettingsControllerOptions {
  setConfig: Dispatch<SetStateAction<AppConfigSnapshot | undefined>>
  t: TFunction
}

export function useSettingsController({ setConfig, t }: UseSettingsControllerOptions) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general')
  const [pendingDefaultCapabilities, setPendingDefaultCapabilities] = useState<DefaultCapabilitySettings>()
  const capabilitiesSavePending = useRef(false)

  async function switchSettingsTab(tab: SettingsTab, canLeave?: CanLeaveSettingsTab): Promise<void> {
    if (tab === settingsTab) return
    if (canLeave && !(await canLeave())) return
    setSettingsTab(tab)
  }

  async function closeSettings(canLeave?: CanLeaveSettingsTab): Promise<void> {
    if (canLeave && !(await canLeave())) return
    setSettingsOpen(false)
  }

  async function saveSettings(settings: Partial<AppSettings>): Promise<void> {
    try {
      const nextConfig = await window.gale.config.updateSettings(settings)
      setConfig(nextConfig)
    } catch {
      notice.error(t('chat.failed_save_settings'))
    }
  }

  async function saveDefaultCapabilities(value: DefaultCapabilitySettings): Promise<void> {
    if (capabilitiesSavePending.current) return
    capabilitiesSavePending.current = true
    setPendingDefaultCapabilities(value)
    try {
      setConfig(await window.gale.config.saveDefaultCapabilities(value))
    } catch {
      notice.error(t('chat.failed_save_settings'))
    } finally {
      capabilitiesSavePending.current = false
      setPendingDefaultCapabilities(undefined)
    }
  }

  async function saveLanguage(language: string): Promise<void> {
    await applyLanguagePreference(language)
    await saveSettings({ language })
  }

  async function saveProfile(profile: AppProfileUpdate): Promise<void> {
    try {
      const nextConfig = await window.gale.config.updateProfile(profile)
      setConfig(nextConfig)
    } catch {
      notice.error(t('chat.failed_save_profile'))
    }
  }

  async function saveSpeechReply(settings: Partial<SpeechReplyConfig>): Promise<void> {
    try {
      const nextConfig = await window.gale.config.updateSpeechReply(settings)
      setConfig(nextConfig)
    } catch {
      notice.error(t('chat.failed_save_speech'))
    }
  }

  return {
    closeSettings,
    pendingDefaultCapabilities,
    saveLanguage,
    saveProfile,
    saveSettings,
    saveDefaultCapabilities,
    saveSpeechReply,
    setSettingsOpen,
    setSettingsTab,
    settingsOpen,
    settingsTab,
    switchSettingsTab
  }
}
