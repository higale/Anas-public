import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckboxField } from '../CheckboxField'
import { CommitTextarea } from '../CommitTextField'
import { UI_TEXTAREA_ROWS_COMPACT } from '../uiConstants'
import { SettingsGroup } from './SettingsGroup'

interface EnvSettingsProps {
  envDraft: string
  envPath?: string
  onAutosizeInput: (event: FormEvent<HTMLTextAreaElement>) => void
  onChange: (value: string) => void
  onOpenEnvFile: () => void | Promise<void>
}

export function EnvSettings({ envDraft, envPath, onAutosizeInput, onChange, onOpenEnvFile }: EnvSettingsProps) {
  const { t } = useTranslation()
  const [wordWrap, setWordWrap] = useState(false)
  const envFileName = envPath?.split(/[\\/]/).pop()

  return (
    <SettingsGroup title={t('settings.env_title')}>
        <div className="ui-stack ui-stack-tight">
          <header className="ui-section-header">
            {envPath ? (
              <button className="inline-file-button ui-link-button" type="button" onClick={() => void onOpenEnvFile()}>
                {envFileName}
              </button>
            ) : (
              <div className="ui-field-hint">{t('settings.env_hint')}</div>
            )}
            <CheckboxField
              checked={wordWrap}
              className="ui-checkbox-field-inline"
              label={t('settings.auto_wrap')}
              onChange={setWordWrap}
            />
          </header>
          <CommitTextarea
            className={wordWrap ? 'ui-autosize-textarea ui-textarea-wrap ui-code-textarea' : 'ui-autosize-textarea ui-textarea-nowrap ui-code-textarea'}
            data-max-height="320"
            value={envDraft}
            onInput={onAutosizeInput}
            onCommit={onChange}
            wrap={wordWrap ? 'soft' : 'off'}
            rows={UI_TEXTAREA_ROWS_COMPACT}
          />
        </div>
    </SettingsGroup>
  )
}
