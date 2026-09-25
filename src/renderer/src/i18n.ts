import i18next from 'i18next'
import type { Resource } from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { LanguagePackSummary, LanguageResourcesSnapshot } from '@shared/types'
import bundledEnglish from '../../../data/lang/en.json'
import bundledChinese from '../../../data/lang/zh-CN.json'

const fallbackLng = 'en'
export const systemLanguagePreference = 'system'
let languageSnapshot: LanguageResourcesSnapshot = {
  langDir: '',
  languages: [],
  resources: {}
}

export function getLanguageOptions(): LanguagePackSummary[] {
  return languageSnapshot.languages
}

function normalizeResources(resources: Record<string, unknown>): Resource {
  return Object.fromEntries(
    Object.entries(resources).map(([code, translation]) => [code, { translation }])
  ) as Resource
}

function availableLanguageCodes(): string[] {
  return languageSnapshot.languages.map((language) => language.code)
}

function matchLanguage(code: string, available: string[]): string | undefined {
  const normalized = code.trim()
  if (!normalized) return undefined
  const exact = available.find((item) => item.toLowerCase() === normalized.toLowerCase())
  if (exact) return exact
  const base = normalized.split('-')[0]?.toLowerCase()
  return available.find((item) => item.split('-')[0]?.toLowerCase() === base)
}

export function resolveLanguagePreference(preference?: string): string {
  const available = availableLanguageCodes()
  if (preference && preference !== systemLanguagePreference) {
    return matchLanguage(preference, available) ?? fallbackLng
  }
  const systemLanguages = navigator.languages.length > 0 ? navigator.languages : [navigator.language]
  for (const systemLanguage of systemLanguages) {
    const matched = matchLanguage(systemLanguage, available)
    if (matched) return matched
  }
  return fallbackLng
}

export async function applyLanguagePreference(preference?: string): Promise<string> {
  const language = resolveLanguagePreference(preference)
  await i18next.changeLanguage(language)
  document.documentElement.lang = language
  return language
}

export async function initializeI18n(recovery = false): Promise<LanguageResourcesSnapshot> {
  // Recovery must not depend on user configuration, language files, or IPC
  // operations blocked while application data writers are stopped.
  const bundledSnapshot: LanguageResourcesSnapshot = {
    langDir: '', languages: [
      { code: 'en', name: 'English', builtIn: true }, { code: 'zh-CN', name: '简体中文', builtIn: true }
    ], resources: { en: bundledEnglish, 'zh-CN': bundledChinese }
  }
  const [snapshot, config] = recovery ? [bundledSnapshot, undefined] : await Promise.all([
    window.gale.app.getLanguageResources().catch(() => bundledSnapshot),
    window.gale.config.get().catch(() => undefined)
  ])
  languageSnapshot = snapshot
  await i18next
    .use(initReactI18next)
    .init({
      resources: normalizeResources(snapshot.resources),
      lng: resolveLanguagePreference(config?.settings.language),
      fallbackLng,
      interpolation: {
        escapeValue: false
      },
      returnEmptyString: false
    })
  document.documentElement.lang = i18next.language
  return snapshot
}

export default i18next
