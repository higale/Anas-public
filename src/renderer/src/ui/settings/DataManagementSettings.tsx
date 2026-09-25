import { DatabaseBackup, FolderOpen, RotateCcw, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StorageUsageValue } from '@shared/types'
import { StorageUsageText } from '../StorageUsageText'
import { UI_ICON_SIZE_MEDIUM } from '../uiConstants'
import { SettingsGroup } from './SettingsGroup'

interface DataManagementSettingsProps {
  backupDir?: string
  dataDirectoryUsage?: StorageUsageValue
  storageUsageLoading: boolean
  onBackupDataDirectory: () => void | Promise<void>
  onOpenDataCleanup: () => void
  onOpenDataDirectory: () => void | Promise<void>
  onRestoreDataDirectory: () => void | Promise<void>
}

export function DataManagementSettings({
  backupDir,
  dataDirectoryUsage,
  storageUsageLoading,
  onBackupDataDirectory,
  onOpenDataCleanup,
  onOpenDataDirectory,
  onRestoreDataDirectory
}: DataManagementSettingsProps) {
  const { t } = useTranslation()

  return (
    <SettingsGroup title={t('settings.data')}>
      <div className="ui-section-header settings-action-row">
        <div>
          <div className="ui-field-label">{t('settings.data_directory')}</div>
          <div className="ui-field-hint">{t('settings.data_directory_hint')}</div>
        </div>
        <div className="ui-row">
          <StorageUsageText loading={storageUsageLoading} usage={dataDirectoryUsage} />
          <div className="ui-action-column">
            <button className="ui-button ui-button-compact" type="button" onClick={() => void onOpenDataDirectory()}>
              <FolderOpen size={UI_ICON_SIZE_MEDIUM} />
              <span>{t('common.open')}</span>
            </button>
          </div>
        </div>
      </div>
      <div className="ui-section-header settings-action-row">
        <div>
          <div className="ui-field-label">{t('settings.backup_data')}</div>
          <div className="ui-field-hint">
            {`${t('settings.backup_data_hint')}${backupDir ? t('settings.backup_data_last_folder', { folder: backupDir }) : ''}`}
          </div>
        </div>
        <div className="ui-action-column">
          <button className="ui-button ui-button-compact" type="button" onClick={() => void onBackupDataDirectory()}>
            <DatabaseBackup size={UI_ICON_SIZE_MEDIUM} />
            <span>{t('settings.backup_data_action')}</span>
          </button>
          <button className="ui-button ui-button-compact ui-button-danger" type="button" onClick={() => void onRestoreDataDirectory()}>
            <RotateCcw size={UI_ICON_SIZE_MEDIUM} />
            <span>{t('settings.restore_data_action')}</span>
          </button>
        </div>
      </div>
      <div className="ui-section-header settings-action-row">
        <div>
          <div className="ui-field-label">{t('settings.cleanup_data')}</div>
          <div className="ui-field-hint">{t('settings.cleanup_data_hint')}</div>
        </div>
        <div className="ui-action-column">
          <button
            className="ui-button ui-button-compact ui-button-danger"
            type="button"
            onClick={onOpenDataCleanup}
          >
            <Trash2 size={UI_ICON_SIZE_MEDIUM} />
            <span>{t('settings.cleanup_data_action')}</span>
          </button>
        </div>
      </div>
    </SettingsGroup>
  )
}
