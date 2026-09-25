import { ArrowDown, ArrowUp, Minus, Plus } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { UI_ICON_SIZE_LARGE } from '../uiConstants'

interface SettingsListActionsProps {
  addLabel: string
  canDelete: boolean
  canMoveDown: boolean
  canMoveUp: boolean
  deleteLabel: string
  disabled?: boolean
  addControl?: ReactNode
  additionalActions?: ReactNode
  leading?: ReactNode
  onAdd: () => void | Promise<void>
  onDelete: () => void | Promise<void>
  onMove?: (direction: -1 | 1) => void | Promise<void>
}

export function SettingsListActions({
  addLabel,
  canDelete,
  canMoveDown,
  canMoveUp,
  deleteLabel,
  disabled = false,
  addControl,
  additionalActions,
  leading,
  onAdd,
  onDelete,
  onMove
}: SettingsListActionsProps) {
  const { t } = useTranslation()

  return (
    <div className={leading ? 'ui-toolbar ui-toolbar-between' : 'ui-toolbar'}>
      {leading}
      <div className="ui-toolbar">
        {additionalActions}
        {addControl ?? (
          <button className="ui-icon-button" type="button" aria-label={addLabel} data-tooltip={addLabel} disabled={disabled} onClick={() => void onAdd()}>
            <Plus size={UI_ICON_SIZE_LARGE} />
          </button>
        )}
        <button
          className="ui-icon-button"
          type="button"
          aria-label={deleteLabel}
          data-tooltip={deleteLabel}
          disabled={disabled || !canDelete}
          onClick={() => void onDelete()}
        >
          <Minus size={UI_ICON_SIZE_LARGE} />
        </button>
        {onMove && (
          <>
            <button
              className="ui-icon-button"
              type="button"
              aria-label={t('common.move_up')}
              data-tooltip={t('common.move_up')}
              disabled={disabled || !canMoveUp}
              onClick={() => void onMove(-1)}
            >
              <ArrowUp size={UI_ICON_SIZE_LARGE} />
            </button>
            <button
              className="ui-icon-button"
              type="button"
              aria-label={t('common.move_down')}
              data-tooltip={t('common.move_down')}
              disabled={disabled || !canMoveDown}
              onClick={() => void onMove(1)}
            >
              <ArrowDown size={UI_ICON_SIZE_LARGE} />
            </button>
          </>
        )}
      </div>
    </div>
  )
}
