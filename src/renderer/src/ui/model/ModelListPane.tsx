import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { ChevronRight, Plus } from 'lucide-react'
import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { modelTemplateTree } from '@shared/modelTemplates'
import type { ModelTemplateTreeNode } from '@shared/modelTemplates'
import type { AppConfigSnapshot } from '@shared/types'
import { DropdownMenuContent, DropdownMenuRoot, DropdownMenuSubContent, DropdownMenuTrigger } from '../DropdownMenuShell'
import { SettingsListActions } from '../settings/SettingsListActions'
import { UI_ICON_SIZE_LARGE } from '../uiConstants'
import { ProviderProtocolIcon } from './ProviderProtocolIcon'
import { providerProtocolLabel } from './providerProtocol'

interface ModelListPaneProps {
  config: AppConfigSnapshot | undefined
  editingModelIndex?: number
  listRef: RefObject<HTMLDivElement | null>
  onCreateModel: (templateId?: string) => void | Promise<void>
  onDeleteModel: () => void | Promise<void>
  onEditModel: (index: number) => void | Promise<void>
  onMoveModel: (direction: -1 | 1) => void | Promise<void>
}

interface ModelTemplateMenuNodesProps {
  nodes: ModelTemplateTreeNode[]
  onCreateModel: (templateId: string) => void | Promise<void>
}

function ModelTemplateMenuNodes({ nodes, onCreateModel }: ModelTemplateMenuNodesProps) {
  return nodes.map((node) => {
    if (node.type === 'template') {
      return (
        <DropdownMenu.Item
          className="model-template-option ui-menu-item ui-menu-item-row"
          key={node.template.templateId}
          onSelect={() => void onCreateModel(node.template.templateId)}
          textValue={node.label}
        >
          <span>{node.label}</span>
        </DropdownMenu.Item>
      )
    }
    return (
      <DropdownMenu.Sub key={node.id}>
        <DropdownMenu.SubTrigger className="model-template-group ui-menu-item ui-menu-item-row">
          <span>{node.label}</span>
          <ChevronRight aria-hidden="true" className="model-template-chevron" size={14} />
        </DropdownMenu.SubTrigger>
        <DropdownMenu.Portal>
          <DropdownMenuSubContent
            alignOffset={-8}
            className="model-template-submenu ui-menu ui-menu-list"
            collisionPadding={10}
            sideOffset={4}
          >
            <ModelTemplateMenuNodes nodes={node.children} onCreateModel={onCreateModel} />
          </DropdownMenuSubContent>
        </DropdownMenu.Portal>
      </DropdownMenu.Sub>
    )
  })
}

export function ModelListPane({
  config,
  editingModelIndex,
  listRef,
  onCreateModel,
  onDeleteModel,
  onEditModel,
  onMoveModel
}: ModelListPaneProps) {
  const { t } = useTranslation()

  return (
    <div className="ui-list-pane">
      <div className="ui-list-pane-header">
        <SettingsListActions
          addLabel={t('settings.new_provider')}
          addControl={(
            <DropdownMenuRoot>
              <DropdownMenuTrigger asChild>
                <button className="ui-icon-button" type="button" aria-label={t('settings.new_provider')} data-tooltip={t('settings.new_provider')}>
                  <Plus size={UI_ICON_SIZE_LARGE} />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenu.Portal>
                <DropdownMenuContent
                  align="start"
                  className="model-template-menu ui-menu ui-menu-list"
                  collisionPadding={10}
                  side="bottom"
                  sideOffset={5}
                >
                  <DropdownMenu.Item className="model-template-blank ui-menu-item ui-menu-item-row" onSelect={() => void onCreateModel()}>
                    <Plus size={14} />
                    {t('settings.blank_provider')}
                  </DropdownMenu.Item>
                  <DropdownMenu.Separator className="ui-menu-separator" />
                  <ModelTemplateMenuNodes nodes={modelTemplateTree} onCreateModel={onCreateModel} />
                </DropdownMenuContent>
              </DropdownMenu.Portal>
            </DropdownMenuRoot>
          )}
          canDelete={editingModelIndex !== undefined}
          canMoveDown={editingModelIndex !== undefined && !!config && editingModelIndex < config.providers.length - 1}
          canMoveUp={editingModelIndex !== undefined && editingModelIndex > 0}
          deleteLabel={t('settings.delete_provider')}
          onAdd={() => onCreateModel()}
          onDelete={onDeleteModel}
          onMove={onMoveModel}
        />
      </div>
      <div className="ui-scroll-list ui-list" ref={listRef}>
        {config && config.providers.length === 0 && <div className="ui-empty-state ui-empty-state-compact">{t('settings.no_providers_configured')}</div>}
        {config?.providers.map((provider) => (
          <button
            className={provider.index === editingModelIndex ? 'ui-list-item-split ui-list-item ui-list-item-active active' : 'ui-list-item-split ui-list-item'}
            data-model-index={provider.index}
            key={provider.id}
            type="button"
            onClick={() => void onEditModel(provider.index)}
          >
            <span className="model-list-item-main">
              <span className="provider-protocol-badge">
                <ProviderProtocolIcon
                  provider={provider.protocol}
                  brandColor={Boolean(provider.baseUrl.trim() && provider.models.some((model) => model.model.trim()))}
                  label={providerProtocolLabel(provider.protocol)}
                />
              </span>
              <span className="ui-copy-stack">
                <strong>{provider.name || t('settings.provider_fallback_name', { index: provider.index })}</strong>
                <small className="ui-list-item-meta">{providerProtocolLabel(provider.protocol)}</small>
              </span>
            </span>
            <span className="model-list-item-badges ui-list-item-meta">{provider.models.length}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
