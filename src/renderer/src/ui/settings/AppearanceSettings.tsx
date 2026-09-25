import { useTranslation } from 'react-i18next'
import type { ChatContentWidth, LanguagePackSummary } from '@shared/types'
import { UI_FONT_SIZE_DEFAULT, UI_FONT_SIZE_MAX, UI_FONT_SIZE_MIN, normalizeUiFontSize } from '@shared/uiPreferences'
import { CommitTextInput } from '../CommitTextField'
import { SearchableOptionPicker } from '../SearchableOptionPicker'
import { SettingsGroup } from './SettingsGroup'

export type ThemeMode = 'system' | 'light' | 'dark'

export function normalizeTheme(value?: string): ThemeMode {
  return value === 'light' || value === 'dark' ? value : 'system'
}

export function normalizeChatContentWidth(value?: string): ChatContentWidth {
  return value === 'wide' || value === 'adaptive' ? value : 'narrow'
}

interface AppearanceSettingsProps {
  languageOptions: LanguagePackSummary[]
  languageValue: string
  systemLanguage: string
  themeValue?: string
  fontSizeValue?: number
  chatContentWidthValue?: string
  onSaveLanguage: (language: string) => void | Promise<void>
  onSaveTheme: (theme: ThemeMode) => void | Promise<void>
  onSaveFontSize: (fontSize: number) => void | Promise<void>
  onSaveChatContentWidth: (width: ChatContentWidth) => void | Promise<void>
}

export function AppearanceSettings({
  languageOptions,
  languageValue,
  systemLanguage,
  themeValue,
  fontSizeValue,
  chatContentWidthValue,
  onSaveLanguage,
  onSaveTheme,
  onSaveFontSize,
  onSaveChatContentWidth
}: AppearanceSettingsProps) {
  const { t } = useTranslation()
  const languagePickerOptions = [
    { value: systemLanguage, label: t('settings.language_system') },
    ...languageOptions.map((language) => ({
      value: language.code,
      label: `${language.name} (${language.code})`,
      searchText: `${language.name} ${language.code}`
    }))
  ]
  const themePickerOptions = [
    { value: 'system', label: t('settings.theme_system') },
    { value: 'light', label: t('settings.theme_light') },
    { value: 'dark', label: t('settings.theme_dark') }
  ]
  const chatContentWidthOptions = [
    { value: 'narrow', label: t('settings.chat_content_width_narrow') },
    { value: 'wide', label: t('settings.chat_content_width_wide') },
    { value: 'adaptive', label: t('settings.chat_content_width_adaptive') }
  ]

  return (
    <SettingsGroup title={t('settings.appearance')}>
      <div className="ui-form-row ui-form-row-narrow">
        <span>
          <strong>{t('settings.language')}</strong>
          <small>{t('settings.language_hint')}</small>
        </span>
        <SearchableOptionPicker
          ariaLabel={t('settings.language')}
          emptyLabel={t('settings.no_options')}
          options={languagePickerOptions}
          searchable={false}
          value={languageValue}
          onChange={(language) => void onSaveLanguage(language)}
        />
      </div>
      <div className="ui-form-row ui-form-row-narrow">
        <span>
          <strong>{t('settings.theme')}</strong>
          <small>{t('settings.theme_hint')}</small>
        </span>
        <SearchableOptionPicker
          ariaLabel={t('settings.theme')}
          emptyLabel={t('settings.no_options')}
          options={themePickerOptions}
          searchable={false}
          value={normalizeTheme(themeValue)}
          onChange={(theme) => void onSaveTheme(normalizeTheme(theme))}
        />
      </div>
      <label className="ui-form-row ui-form-row-narrow">
        <span>
          <strong>{t('settings.font_size')}</strong>
          <small>{t('settings.font_size_hint')}</small>
        </span>
        <CommitTextInput
          aria-label={t('settings.font_size')}
          min={UI_FONT_SIZE_MIN}
          max={UI_FONT_SIZE_MAX}
          step={1}
          type="number"
          value={String(fontSizeValue ?? UI_FONT_SIZE_DEFAULT)}
          onCommit={(value) => void onSaveFontSize(normalizeUiFontSize(Number(value)))}
        />
      </label>
      <div className="ui-form-row ui-form-row-narrow">
        <span>
          <strong>{t('settings.chat_content_width')}</strong>
          <small>{t('settings.chat_content_width_hint')}</small>
        </span>
        <SearchableOptionPicker
          ariaLabel={t('settings.chat_content_width')}
          emptyLabel={t('settings.no_options')}
          options={chatContentWidthOptions}
          searchable={false}
          value={normalizeChatContentWidth(chatContentWidthValue)}
          onChange={(width) => void onSaveChatContentWidth(normalizeChatContentWidth(width))}
        />
      </div>
    </SettingsGroup>
  )
}
