import type { RefObject } from 'react'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AppConfigSnapshot, McpToolStatus } from '@shared/types'
import { SettingsListActions } from '../settings/SettingsListActions'
import { UI_ICON_SIZE_LARGE } from '../uiConstants'
import { mcpErrorStatus, mcpLoadedStatus, mcpServerRuntimeStatus } from './mcpDraft'

interface McpListPaneProps {
  config: AppConfigSnapshot | undefined
  disabled?: boolean
  editingIndex?: number
  listRef: RefObject<HTMLDivElement | null>
  reloadingFailed: boolean
  runtimeEnabled: boolean
  status: McpToolStatus | undefined
  onAddServer: () => void | Promise<void>
  onDeleteServer: () => void | Promise<void>
  onEditServer: (index: number) => void | Promise<void>
  onMoveServer: (direction: -1 | 1) => void | Promise<void>
  onReloadFailedServers: () => void | Promise<void>
}

export function McpListPane({
  config,
  disabled = false,
  editingIndex,
  listRef,
  reloadingFailed,
  runtimeEnabled,
  status,
  onAddServer,
  onDeleteServer,
  onEditServer,
  onMoveServer,
  onReloadFailedServers
}: McpListPaneProps) {
  const { t } = useTranslation()

  return (
    <div className="ui-list-pane">
      <div className="ui-list-pane-header">
        <SettingsListActions
          leading={(
            <button
              className="ui-icon-button"
              type="button"
              aria-label={t('settings.mcp_reload_failed_servers')}
              data-tooltip={t('settings.mcp_reload_failed_servers_hint')}
              disabled={disabled || !runtimeEnabled || reloadingFailed}
              onClick={() => void onReloadFailedServers()}
            >
              <RefreshCw size={UI_ICON_SIZE_LARGE} />
            </button>
          )}
          addLabel={t('settings.new_mcp_server')}
          canDelete={editingIndex !== undefined}
          canMoveDown={editingIndex !== undefined && !!config && editingIndex < config.mcpServers.length - 1}
          canMoveUp={editingIndex !== undefined && editingIndex > 0}
          deleteLabel={t('settings.delete_mcp_server')}
          disabled={disabled}
          onAdd={onAddServer}
          onDelete={onDeleteServer}
          onMove={onMoveServer}
        />
      </div>
      <div className="ui-scroll-list ui-list" ref={listRef}>
        {config && config.mcpServers.length === 0 && <div className="ui-empty-state ui-empty-state-compact">{t('settings.no_mcp_servers_configured')}</div>}
        {config?.mcpServers.map((server) => {
          const runtimeStatus = runtimeEnabled ? mcpServerRuntimeStatus(status, server) : undefined
          const loaded = runtimeEnabled ? mcpLoadedStatus(status, server) : undefined
          const errorText = runtimeEnabled ? mcpErrorStatus(status, server) : undefined
          const recovering = runtimeStatus?.state === 'recovering'
          const loading = runtimeEnabled && server.enabled && !loaded && !errorText && (!runtimeStatus || runtimeStatus.state === 'idle' || runtimeStatus.state === 'starting')
          const detailText = loaded
            ? t('settings.tools_count', { count: loaded.toolCount })
            : errorText
              ? t('settings.load_failed')
              : recovering
                ? t('settings.mcp_state_recovering')
                : loading
                  ? t('settings.waiting_for_tools')
                : ''
          return (
            <button
              className={server.index === editingIndex ? 'ui-list-item-split ui-list-item ui-list-item-active active' : 'ui-list-item-split ui-list-item'}
              key={`${server.index}-${server.name}`}
              type="button"
              onClick={() => void onEditServer(server.index)}
            >
              <span>
                <strong>{server.name || server.id || t('settings.mcp_server_fallback_name', { index: server.index })}</strong>
                <small className="ui-list-item-meta">
                  {server.type} - {server.id || '-'}{detailText ? ` · ${detailText}` : ''}
                </small>
              </span>
              {errorText ? (
                <em className="ui-list-item-badge ui-badge-danger">{t('settings.error')}</em>
              ) : loaded ? (
                <em className="ui-list-item-badge ui-badge-success">{t('settings.running')}</em>
              ) : recovering ? (
                <em className="ui-list-item-badge ui-badge-warning">{t('settings.mcp_state_recovering')}</em>
              ) : loading ? (
                <em className="ui-list-item-badge ui-badge-warning">{t('settings.pending')}</em>
              ) : null}
            </button>
          )
        })}
      </div>
    </div>
  )
}
