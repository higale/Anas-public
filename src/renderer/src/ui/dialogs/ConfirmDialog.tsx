import * as AlertDialog from '@radix-ui/react-alert-dialog'
import { Check, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ConfirmDialogRequest } from './dialogTypes'

export function ConfirmDialog({ request, onClose }: { request?: ConfirmDialogRequest; onClose: () => void }) {
  const { t } = useTranslation()
  const variant = request?.variant ?? 'default'
  return (
    <AlertDialog.Root open={Boolean(request)} onOpenChange={(open) => { if (!open) onClose() }}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="ui-backdrop" />
        <AlertDialog.Content className="ui-dialog ui-dialog-compact ui-dialog-centered ui-popover">
          <header className="ui-dialog-header">
            <div className={variant === 'danger' ? 'ui-dialog-icon ui-dialog-icon-danger' : 'ui-dialog-icon'}>
              {variant === 'danger' ? <Trash2 size={18} /> : <Check size={18} />}
            </div>
            <div>
              <AlertDialog.Title asChild>
                <h2 className="ui-dialog-title">{request?.title}</h2>
              </AlertDialog.Title>
              <AlertDialog.Description asChild>
                <p className="ui-dialog-description">{request?.description}</p>
              </AlertDialog.Description>
            </div>
          </header>
          <footer className="ui-dialog-footer">
            <AlertDialog.Cancel asChild>
              <button className="ui-button ui-button-compact" type="button">
                <X size={14} />
                <span>{t('common.cancel')}</span>
              </button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                className={variant === 'danger' ? 'ui-button ui-button-compact ui-button-danger' : 'ui-button ui-button-compact ui-button-primary'}
                type="button"
                onClick={() => {
                  const onConfirm = request?.onConfirm
                  onClose()
                  void onConfirm?.()
                }}
              >
                {variant === 'danger' ? <Trash2 size={14} /> : <Check size={14} />}
                <span>{request?.confirmText ?? t('common.confirm')}</span>
              </button>
            </AlertDialog.Action>
          </footer>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  )
}
