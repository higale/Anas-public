import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Checkbox } from '../Checkbox'
import { CheckboxField } from '../CheckboxField'
import { StorageUsageText } from '../StorageUsageText'
import { dataCleanupTargets } from './dialogTypes'
import type { DataCleanupDialogTarget, DataCleanupSelection, DataCleanupUsage } from './dialogTypes'

export function DataCleanupDialog({ open, selection, busy, storageUsageLoading, usage, onToggle, onToggleAll, onClose, onRun }: {
  open: boolean
  selection: DataCleanupSelection
  busy: boolean
  storageUsageLoading: boolean
  usage: DataCleanupUsage
  onToggle: (target: DataCleanupDialogTarget, checked: boolean) => void
  onToggleAll: (checked: boolean) => void
  onClose: () => void
  onRun: () => void
}) {
  const { t } = useTranslation()
  const selectedCount = dataCleanupTargets.filter((target) => selection[target]).length
  const allSelected = selectedCount === dataCleanupTargets.length
  return (
    <AlertDialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen && !busy) onClose() }}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="ui-backdrop" />
        <AlertDialog.Content className="ui-dialog ui-dialog-compact ui-dialog-medium ui-dialog-centered ui-popover">
          <header className="ui-dialog-header">
            <div className="ui-dialog-icon ui-dialog-icon-danger">
              <Trash2 size={18} />
            </div>
            <div>
              <AlertDialog.Title asChild>
                <h2 className="ui-dialog-title">{t('settings.cleanup_data_title')}</h2>
              </AlertDialog.Title>
              <AlertDialog.Description asChild>
                <p className="ui-dialog-description">{t('settings.cleanup_data_description')}</p>
              </AlertDialog.Description>
            </div>
          </header>
          <div className="ui-stack ui-stack-tight">
            {dataCleanupTargets.map((target) => (
              <label className="data-cleanup-option ui-check-card ui-list-item" key={target}>
                <Checkbox
                  checked={selection[target]}
                  disabled={busy}
                  onChange={(checked) => onToggle(target, checked)}
                />
                <span>
                  <div className="ui-field-heading">
                    <strong>{t(`settings.cleanup_${target}`)}</strong>
                    <StorageUsageText loading={storageUsageLoading} usage={usage[target]} />
                  </div>
                  <small>{t(`settings.cleanup_${target}_hint`)}</small>
                </span>
              </label>
            ))}
          </div>
          <footer className="ui-dialog-footer data-cleanup-dialog-footer">
            <CheckboxField
              checked={allSelected}
              className="ui-checkbox-field-inline"
              disabled={busy}
              label={t('menu.select_all')}
              onChange={onToggleAll}
            />
            <div className="data-cleanup-dialog-actions">
              <AlertDialog.Cancel asChild>
                <button className="ui-button ui-button-compact" type="button" disabled={busy}>
                  <X size={14} />
                  <span>{t('common.cancel')}</span>
                </button>
              </AlertDialog.Cancel>
              <button className="ui-button ui-button-compact ui-button-danger" type="button" disabled={busy || selectedCount === 0} onClick={onRun}>
                <Trash2 size={14} />
                <span>{busy ? t('common.loading') : t('settings.cleanup_selected')}</span>
              </button>
            </div>
          </footer>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
