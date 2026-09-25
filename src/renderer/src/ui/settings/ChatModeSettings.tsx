import { useTranslation } from 'react-i18next'
import type { AppSettings, NewThreadModelSelection, SpeechReplyConfig } from '@shared/types'
import { CommitTextInput } from '../CommitTextField'
import { clampIntegerInput } from '../numberInput'
import { SearchableOptionPicker } from '../SearchableOptionPicker'
import { SpeechReplySettings } from '../speech/SpeechReplySettings'
import {
  SETTINGS_COUNT_MIN,
  SETTINGS_MAX_MODEL_CALLS,
  SETTINGS_MAX_MODEL_CALLS_DEFAULT
} from '../uiConstants'
import { AttachmentSettings } from './AttachmentSettings'
import { SettingsGroup } from './SettingsGroup'

interface ChatModeSettingsProps {
  settings: AppSettings | undefined
  speechReply?: SpeechReplyConfig
  onChange: (settings: Partial<AppSettings>) => void | Promise<void>
  onSpeechReplyChange: (settings: Partial<SpeechReplyConfig>) => void | Promise<void>
}

export function ChatModeSettings({ settings, speechReply, onChange, onSpeechReplyChange }: ChatModeSettingsProps) {
  const { t } = useTranslation()
  const newThreadModelOptions = [
    { value: 'prompt', label: t('settings.new_thread_model_prompt') },
    { value: 'default', label: t('settings.new_thread_model_default') },
    { value: 'current', label: t('settings.new_thread_model_current') }
  ]
  const maxModelCallsPerRun = settings?.maxModelCallsPerRun ?? SETTINGS_MAX_MODEL_CALLS_DEFAULT

  return (
    <div className="settings-page-groups">
      <SettingsGroup title={t('settings.tabs.general')}>
        <div className="ui-form-row ui-form-row-narrow">
          <span>
            <strong>{t('settings.new_thread_model_selection')}</strong>
            <small>{t('settings.new_thread_model_selection_hint')}</small>
          </span>
          <SearchableOptionPicker
            ariaLabel={t('settings.new_thread_model_selection')}
            emptyLabel={t('settings.no_options')}
            options={newThreadModelOptions}
            searchable={false}
            value={settings?.newThreadModelSelection ?? 'default'}
            onChange={(newThreadModelSelection) => void onChange({
              newThreadModelSelection: newThreadModelSelection as NewThreadModelSelection
            })}
          />
        </div>
        <label className="ui-form-row ui-form-row-narrow">
          <span>
            <strong>{t('settings.max_model_calls_per_run')}</strong>
            <small>{t('settings.max_model_calls_per_run_hint')}</small>
          </span>
          <CommitTextInput
            min={SETTINGS_COUNT_MIN}
            max={SETTINGS_MAX_MODEL_CALLS}
            placeholder={t('settings.max_model_calls_unlimited')}
            type="number"
            value={maxModelCallsPerRun === 0 ? '' : String(maxModelCallsPerRun)}
            normalizeDraft={(value) => value === '0' ? '' : value}
            onDraftChange={(value) => {
              if (value === '' && maxModelCallsPerRun !== 0) void onChange({ maxModelCallsPerRun: 0 })
            }}
            onCommit={(value) => void onChange({
              maxModelCallsPerRun: clampIntegerInput(
                value,
                SETTINGS_COUNT_MIN,
                SETTINGS_MAX_MODEL_CALLS
              )
            })}
          />
        </label>
      </SettingsGroup>
      <SpeechReplySettings value={speechReply} onChange={onSpeechReplyChange} />
      <AttachmentSettings settings={settings} onChange={onChange} />
    </div>
  )
}
