import { useTranslation } from 'react-i18next'
import type { AppSettings, AttachmentTextOverflowMode } from '@shared/types'
import { CommitTextInput } from '../CommitTextField'
import { clampIntegerInput } from '../numberInput'
import { SearchableOptionPicker } from '../SearchableOptionPicker'
import { SETTINGS_ATTACHMENT_TEXT_DEFAULT_CHARS, SETTINGS_ATTACHMENT_TEXT_MAX_CHARS, SETTINGS_ATTACHMENT_TEXT_MIN_CHARS, SETTINGS_ATTACHMENT_TEXT_STEP_CHARS } from '../uiConstants'
import { SettingsGroup } from './SettingsGroup'

const attachmentTextOverflowOptions: Array<{ value: AttachmentTextOverflowMode; labelKey: string }> = [
  { value: 'truncate', labelKey: 'settings.attachment_text_overflow_truncate' },
  { value: 'error', labelKey: 'settings.attachment_text_overflow_error' }
]

interface AttachmentSettingsProps {
  settings: AppSettings | undefined
  onChange: (settings: Partial<AppSettings>) => void | Promise<void>
}

export function AttachmentSettings({ settings, onChange }: AttachmentSettingsProps) {
  const { t } = useTranslation()
  const attachmentTextOverflowPickerOptions = attachmentTextOverflowOptions.map((option) => ({
    value: option.value,
    label: t(option.labelKey)
  }))

  return (
    <SettingsGroup title={t('settings.attachments')}>
      <label className="ui-form-row ui-form-row-narrow">
        <span>
          <strong>{t('settings.attachment_text_max_chars')}</strong>
          <small>{t('settings.attachment_text_max_chars_hint')}</small>
        </span>
        <CommitTextInput
          min={SETTINGS_ATTACHMENT_TEXT_MIN_CHARS}
          max={SETTINGS_ATTACHMENT_TEXT_MAX_CHARS}
          step={SETTINGS_ATTACHMENT_TEXT_STEP_CHARS}
          type="number"
          value={String(settings?.attachmentTextMaxChars ?? SETTINGS_ATTACHMENT_TEXT_DEFAULT_CHARS)}
          onCommit={(value) => void onChange({ attachmentTextMaxChars: clampIntegerInput(value, SETTINGS_ATTACHMENT_TEXT_MIN_CHARS, SETTINGS_ATTACHMENT_TEXT_MAX_CHARS) })}
        />
      </label>
      <div className="ui-form-row ui-form-row-narrow">
        <span>
          <strong>{t('settings.attachment_text_overflow')}</strong>
          <small>{t('settings.attachment_text_overflow_hint')}</small>
        </span>
        <SearchableOptionPicker
          ariaLabel={t('settings.attachment_text_overflow')}
          emptyLabel={t('settings.no_options')}
          options={attachmentTextOverflowPickerOptions}
          searchable={false}
          value={settings?.attachmentTextOverflow ?? 'truncate'}
          onChange={(attachmentTextOverflow) => void onChange({ attachmentTextOverflow: attachmentTextOverflow as AttachmentTextOverflowMode })}
        />
      </div>
    </SettingsGroup>
  )
}
