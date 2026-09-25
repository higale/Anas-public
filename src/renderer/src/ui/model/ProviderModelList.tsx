import { Pencil } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ModelProviderConfigDetail } from '@shared/types'
import { NoFocusButton } from '../NoFocusButton'
import { SettingsListActions } from '../settings/SettingsListActions'
import { UI_ICON_SIZE_LARGE } from '../uiConstants'
import { ModelListUrlPopover } from './ModelListUrlPopover'
import type { ModelListSettingsUpdate } from './ModelListUrlPopover'

interface ProviderModelListProps {
  provider: ModelProviderConfigDetail
  selectedIndex?: number
  onAdd(): void | Promise<void>
  onDelete(): void | Promise<void>
  onEdit(index: number): void | Promise<void>
  onMove(direction: -1 | 1): void | Promise<void>
  onModelListSettingsChange(update: ModelListSettingsUpdate): void
  onSelect(index: number): void | Promise<void>
}

export function ProviderModelList({
  provider,
  selectedIndex,
  onAdd,
  onDelete,
  onEdit,
  onMove,
  onModelListSettingsChange,
  onSelect
}: ProviderModelListProps) {
  const { t } = useTranslation()

  return (
    <div className="provider-model-list ui-field-stack">
      <SettingsListActions
        addLabel={t('settings.add_provider_model')}
        canDelete={selectedIndex !== undefined}
        canMoveDown={selectedIndex !== undefined && selectedIndex < provider.models.length - 1}
        canMoveUp={selectedIndex !== undefined && selectedIndex > 0}
        deleteLabel={t('settings.delete_model')}
        onAdd={onAdd}
        onDelete={onDelete}
        onMove={onMove}
        leading={(
          <span className="provider-model-list-heading">
            <strong>{t('settings.provider_models')}</strong>
            <ModelListUrlPopover
              baseUrl={provider.baseUrl}
              modelListAuth={provider.modelListAuth}
              modelListUrl={provider.modelListUrl}
              protocol={provider.protocol}
              onChange={onModelListSettingsChange}
            />
          </span>
        )}
      />
      <div className="provider-model-options ui-list ui-list-compact ui-list-framed" role="listbox" aria-label={t('settings.provider_models')}>
        {provider.models.length === 0 && (
          <div className="ui-empty-state ui-empty-state-compact">{t('settings.no_models_configured')}</div>
        )}
        {provider.models.map((model) => {
          const name = model.displayName.trim() || model.model || t('settings.no_model_id')
          const selected = model.index === selectedIndex
          return (
            <div
              className={selected
                ? 'provider-model-item ui-list-item ui-list-item-compact ui-list-item-row ui-list-item-action-host ui-list-item-active active'
                : 'provider-model-item ui-list-item ui-list-item-compact ui-list-item-row ui-list-item-action-host'}
              key={model.id}
            >
              <button
                aria-selected={selected}
                className="provider-model-select ui-list-item-main"
                onClick={() => void onSelect(model.index)}
                onDoubleClick={() => void onEdit(model.index)}
                role="option"
                type="button"
              >
                <span className="ui-truncate">{name}</span>
              </button>
              <div className="ui-list-item-action-wrap">
                <NoFocusButton
                  aria-label={`${t('settings.edit_model')}: ${name}`}
                  className="ui-list-item-action ui-tool-button"
                  data-tooltip={t('settings.edit_model')}
                  onClick={() => void onEdit(model.index)}
                  type="button"
                >
                  <Pencil size={UI_ICON_SIZE_LARGE} />
                </NoFocusButton>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
