import { useEffect } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { TFunction } from 'i18next'
import type { AppConfigSnapshot } from '@shared/types'

interface UseAppChromeActionsArgs {
  onOpenHelp: () => Promise<void>
  onOpenSettings: () => void
  setAboutOpen: Dispatch<SetStateAction<boolean>>
  setAppMenuOpen: Dispatch<SetStateAction<boolean>>
  setConfig: Dispatch<SetStateAction<AppConfigSnapshot | undefined>>
  setError: Dispatch<SetStateAction<string | undefined>>
  sidebarVisible: boolean
  t: TFunction
}

export function useAppChromeActions({
  onOpenHelp,
  onOpenSettings,
  setAboutOpen,
  setAppMenuOpen,
  setConfig,
  setError,
  sidebarVisible,
  t
}: UseAppChromeActionsArgs) {
  function openSettingsFromMenu(): void {
    setAppMenuOpen(false)
    onOpenSettings()
  }

  function showAboutFromMenu(): void {
    setAppMenuOpen(false)
    setAboutOpen(true)
  }

  async function openHelpFromMenu(): Promise<void> {
    setAppMenuOpen(false)
    try {
      await onOpenHelp()
    } catch {
      setError(t('chat.failed_open_help'))
    }
  }

  useEffect(() => window.gale.app.onHelpRequested(() => { void openHelpFromMenu() }))

  async function quitFromMenu(): Promise<void> {
    setAppMenuOpen(false)
    try {
      await window.gale.app.quit()
    } catch {
      setError(t('chat.failed_load_app'))
    }
  }

  async function toggleSidebar(): Promise<void> {
    try {
      const nextConfig = await window.gale.config.updateSettings({ sidebarVisible: !sidebarVisible })
      setConfig(nextConfig)
    } catch {
      setError(t('chat.failed_update_sidebar'))
    }
  }

  return {
    openHelpFromMenu,
    openSettingsFromMenu,
    quitFromMenu,
    showAboutFromMenu,
    toggleSidebar
  }
}
