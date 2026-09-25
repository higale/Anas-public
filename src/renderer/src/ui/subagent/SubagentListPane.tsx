import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppConfigSnapshot } from '@shared/types'
import { SettingsListActions } from '../settings/SettingsListActions'

interface SubagentListPaneProps {
  config: AppConfigSnapshot | undefined
  editingIndex?: number
  listRef: RefObject<HTMLDivElement | null>
  onAdd: () => void | Promise<void>
  onDelete: () => void | Promise<void>
  onEdit: (index: number) => void
  onMove: (direction: -1 | 1) => void | Promise<void>
}

export function SubagentListPane({
  config,
  editingIndex,
  listRef,
  onAdd,
  onDelete,
  onEdit,
  onMove
}: SubagentListPaneProps) {
  const { t } = useTranslation()
  const selected = config?.subagents.find((subagent) => subagent.index === editingIndex)
  return (
    <div className="ui-list-pane">
      <div className="ui-list-pane-header">
        <SettingsListActions
          addLabel={t('settings.subagent_new')}
          canDelete={Boolean(selected && !selected.builtIn)}
          canMoveDown={editingIndex !== undefined && !!config && editingIndex < config.subagents.length - 1}
          canMoveUp={editingIndex !== undefined && editingIndex > 0}
          deleteLabel={t('settings.subagent_delete')}
          onAdd={onAdd}
          onDelete={onDelete}
          onMove={onMove}
        />
      </div>
      <div className="ui-scroll-list ui-list" ref={listRef}>
        {config?.subagents.length === 0 && (
          <div className="ui-empty-state ui-empty-state-compact">
            {t('settings.subagent_empty')}
          </div>
        )}
        {config?.subagents.map((subagent) => (
          <button
            className={subagent.index === editingIndex
              ? 'ui-list-item-split ui-list-item ui-list-item-active active'
              : 'ui-list-item-split ui-list-item'}
            key={`${subagent.index}:${subagent.name}`}
            type="button"
            onClick={() => onEdit(subagent.index)}
          >
            <span>
              <strong>{subagent.name}</strong>
              <small className="ui-list-item-meta">
                {subagent.enabled
                  ? t('settings.subagent_default_enabled')
                  : t('settings.subagent_default_disabled')}
              </small>
            </span>
            {subagent.builtIn && (
              <em className="ui-list-item-badge ui-badge-info">
                {t('settings.subagent_builtin')}
              </em>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
