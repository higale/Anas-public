import { useTranslation } from 'react-i18next'
import type { StorageUsageValue } from '@shared/types'
import { CheckboxField } from '../CheckboxField'
import { StorageUsageText } from '../StorageUsageText'
import { SettingsGroup } from './SettingsGroup'

interface DeveloperHttpTraceSettingsProps {
  enabled: boolean
  storageUsageLoading: boolean
  usage?: StorageUsageValue
  onChange: (enabled: boolean) => void | Promise<void>
  onOpenDirectory: () => void | Promise<void>
}

export function DeveloperHttpTraceSettings({
  enabled,
  storageUsageLoading,
  usage,
  onChange,
  onOpenDirectory
}: DeveloperHttpTraceSettingsProps) {
  const { t } = useTranslation()

  return (
    <SettingsGroup title={t('settings.developer_diagnostics')}>
      <div className="ui-form-row ui-form-row-fit-control">
        <span>
          <strong>{t('settings.developer_http_trace')}</strong>
          <small>{t('settings.developer_http_trace_hint')}</small>
        </span>
        <CheckboxField
          className="ui-form-row-control-end"
          checked={enabled}
          label={t('settings.developer_http_trace_enabled')}
          onChange={(nextEnabled) => void onChange(nextEnabled)}
        />
      </div>
      <div className="ui-section-header settings-action-row">
        <div>
          <div className="ui-field-label">{t('settings.developer_http_trace_files')}</div>
          <div className="ui-field-hint">{t('settings.developer_http_trace_files_hint')}</div>
        </div>
        <div className="ui-row">
          <StorageUsageText loading={storageUsageLoading} usage={usage} />
          <button
            className="ui-button ui-button-compact"
            type="button"
            onClick={() => void onOpenDirectory()}
          >
            {t('settings.open_developer_http_trace_folder')}
          </button>
        </div>
      </div>
    </SettingsGroup>
  )
}
