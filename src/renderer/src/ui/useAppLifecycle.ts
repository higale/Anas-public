import { useCallback, useEffect, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { TFunction } from 'i18next'
import { applyLanguagePreference, getLanguageOptions, systemLanguagePreference } from '../i18n'
import { normalizeTheme } from './settings/AppearanceSettings'
import type { AppBuildInfo, AppConfigSnapshot, InputHistorySnapshot, LanguagePackSummary, Project } from '@shared/types'
import { normalizeUiFontSize } from '@shared/uiPreferences'
import {
  createInitialAppLoadSnapshot,
  InitialAppLoader,
  type InitialAppLoadSnapshot,
  type InitialAppResource
} from './initialAppLoad'

interface UseAppLifecycleOptions {
  config: AppConfigSnapshot | undefined
  setAboutOpen: Dispatch<SetStateAction<boolean>>
  setAppBuildInfo: Dispatch<SetStateAction<AppBuildInfo | undefined>>
  setAppIcon: Dispatch<SetStateAction<string | undefined>>
  setAppMenuOpen: Dispatch<SetStateAction<boolean>>
  setConfig: Dispatch<SetStateAction<AppConfigSnapshot | undefined>>
  setInputHistory: Dispatch<SetStateAction<InputHistorySnapshot>>
  setLanguageOptions: Dispatch<SetStateAction<LanguagePackSummary[]>>
  setProjects: Dispatch<SetStateAction<Project[]>>
  setResolvedTheme: Dispatch<SetStateAction<'light' | 'dark'>>
  t: TFunction
}

interface AppLifecycleState {
  initialLoad: InitialAppLoadSnapshot
  retryInitialResource(resource: InitialAppResource): void
}

export function useAppLifecycle({
  config,
  setAboutOpen,
  setAppBuildInfo,
  setAppIcon,
  setAppMenuOpen,
  setConfig,
  setInputHistory,
  setLanguageOptions,
  setProjects,
  setResolvedTheme,
  t
}: UseAppLifecycleOptions): AppLifecycleState {
  const [initialLoad, setInitialLoad] = useState(createInitialAppLoadSnapshot)
  const initialLoaderRef = useRef<InitialAppLoader | null>(null)

  useEffect(() => {
    const loader = new InitialAppLoader({
      loaders: {
        projects: () => window.gale.projects.list(),
        config: () => window.gale.config.get(),
        inputHistory: () => window.gale.inputHistory.get(),
        buildInfo: () => window.gale.app.getBuildInfo(),
        icon: () => window.gale.app.getIcon()
      },
      consumers: {
        projects: setProjects,
        config: (appConfig) => {
          setConfig(appConfig)
          void applyLanguagePreference(appConfig.settings.language)
          setLanguageOptions(getLanguageOptions())
        },
        inputHistory: setInputHistory,
        buildInfo: setAppBuildInfo,
        icon: setAppIcon
      },
      onChange: setInitialLoad,
      fallbackError: t('chat.failed_load_app')
    })
    initialLoaderRef.current = loader
    loader.start()
    return () => {
      if (initialLoaderRef.current === loader) {
        initialLoaderRef.current = null
      }
      loader.dispose()
    }
  }, [])

  const retryInitialResource = useCallback((resource: InitialAppResource): void => {
    void initialLoaderRef.current?.retry(resource)
  }, [])

  useEffect(() => window.gale.config.onChanged((nextConfig) => {
    setConfig(nextConfig)
    void applyLanguagePreference(nextConfig.settings.language)
    setLanguageOptions(getLanguageOptions())
  }), [setConfig, setLanguageOptions])

  useEffect(() => {
    return window.gale.app.onAboutRequested(() => {
      setAppMenuOpen(false)
      setAboutOpen(true)
    })
  }, [])

  useEffect(() => {
    const theme = normalizeTheme(config?.settings.theme)
    const media = window.matchMedia('(prefers-color-scheme: dark)')

    function applyTheme(): void {
      const resolved = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme
      document.documentElement.dataset.theme = resolved
      document.documentElement.dataset.themeMode = theme
      setResolvedTheme(resolved)
    }

    applyTheme()
    if (theme !== 'system') return

    media.addEventListener('change', applyTheme)
    return () => media.removeEventListener('change', applyTheme)
  }, [config?.settings.theme, setResolvedTheme])

  useEffect(() => {
    const fontSize = normalizeUiFontSize(config?.settings.fontSize)
    document.documentElement.style.setProperty('--font-size-base', `${fontSize}px`)
  }, [config?.settings.fontSize])

  useEffect(() => {
    if (config?.settings.language !== systemLanguagePreference) return
    const handleLanguageChange = (): void => {
      void applyLanguagePreference(systemLanguagePreference)
    }
    window.addEventListener('languagechange', handleLanguageChange)
    return () => window.removeEventListener('languagechange', handleLanguageChange)
  }, [config?.settings.language])

  return { initialLoad, retryInitialResource }
}
