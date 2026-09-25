import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppConfigSnapshot, McpServerType, McpToolStatus } from '@shared/types'
import { CheckboxField } from '../CheckboxField'
import { CommitTextInput, CommitTextarea } from '../CommitTextField'
import { SearchableOptionPicker } from '../SearchableOptionPicker'
import { SETTINGS_MCP_TIMEOUT_MIN_MS, SETTINGS_MILLISECONDS_STEP, UI_TEXTAREA_ROWS_COMPACT } from '../uiConstants'
import { mcpErrorStatus, mcpLoadedStatus, mcpServerRuntimeStatus } from './mcpDraft'
import type { McpDraft } from './mcpDraft'

type SelectedMcpServer = AppConfigSnapshot['mcpServers'][number]

interface McpEditorProps {
  disabled?: boolean
  mcpDraft: McpDraft
  runtimeEnabled: boolean
  selectedServer?: SelectedMcpServer
  status: McpToolStatus | undefined
  onAutosizeInput: (event: FormEvent<HTMLTextAreaElement>) => void
  onUpdateDraft: (update: Partial<McpDraft>) => void
}

export function McpEditor({
  disabled = false,
  mcpDraft,
  runtimeEnabled,
  selectedServer,
  status,
  onAutosizeInput,
  onUpdateDraft
}: McpEditorProps) {
  const { t } = useTranslation()
  const [apiKeyFocused, setApiKeyFocused] = useState(false)
  const transportOptions = [
    { value: 'stdio', label: 'stdio' },
    { value: 'http', label: 'HTTP' },
    { value: 'sse', label: 'SSE' }
  ]

  return (
    <div className="ui-editor">
      <div className="settings-mcp-enabled-row ui-row">
        <CheckboxField
          checked={mcpDraft.enabled}
          disabled={disabled}
          label={t('settings.enabled')}
          onChange={(enabled) => onUpdateDraft({ enabled })}
        />
      </div>
      <div className="ui-grid-2">
        <label className="ui-field-stack">
          <span>{t('settings.name')}</span>
          <CommitTextInput value={mcpDraft.name} onCommit={(name) => onUpdateDraft({ name })} disabled={disabled} />
        </label>
        <div className="ui-field-stack">
          <span>{t('settings.transport')}</span>
          <SearchableOptionPicker
            ariaLabel={t('settings.transport')}
            disabled={disabled}
            emptyLabel={t('settings.no_options')}
            options={transportOptions}
            searchable={false}
            value={mcpDraft.type}
            onChange={(type) => onUpdateDraft({ type: type as McpServerType })}
          />
        </div>
      </div>
      <div className="ui-grid-2">
        <label className="ui-field-stack">
          <span>{t('settings.mcp_server_id')}</span>
          <CommitTextInput
            value={mcpDraft.id}
            onCommit={(id) => onUpdateDraft({ id })}
            disabled={disabled}
          />
        </label>
        <label className="ui-field-stack">
          <span>{t('settings.timeout_ms')}</span>
          <CommitTextInput min={SETTINGS_MCP_TIMEOUT_MIN_MS} step={SETTINGS_MILLISECONDS_STEP} type="number" value={String(mcpDraft.timeoutMs)} onCommit={(timeoutMs) => onUpdateDraft({ timeoutMs: Number(timeoutMs) })} disabled={disabled} />
        </label>
      </div>

      {mcpDraft.type === 'stdio' ? (
        <>
          <label className="ui-field-stack">
            <span>{t('settings.command')}</span>
            <CommitTextInput value={mcpDraft.command} onCommit={(command) => onUpdateDraft({ command })} placeholder="npx" disabled={disabled} />
          </label>
          <label className="ui-field-stack">
            <span>{t('settings.arguments')}</span>
            <CommitTextarea
              className="ui-autosize-textarea ui-code-textarea"
              data-max-height="none"
              value={mcpDraft.argsText}
              onInput={onAutosizeInput}
              onCommit={(argsText) => onUpdateDraft({ argsText })}
              placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:\\Users\\user'}
              rows={UI_TEXTAREA_ROWS_COMPACT}
              disabled={disabled}
            />
          </label>
          <label className="ui-field-stack">
            <span>{t('settings.working_directory')}</span>
            <CommitTextInput value={mcpDraft.workingDir} onCommit={(workingDir) => onUpdateDraft({ workingDir })} disabled={disabled} />
          </label>
          <label className="ui-field-stack">
            <span>{t('settings.environment')}</span>
            <CommitTextarea
              className="ui-autosize-textarea ui-code-textarea"
              data-max-height="none"
              value={mcpDraft.envText}
              onInput={onAutosizeInput}
              onCommit={(envText) => onUpdateDraft({ envText })}
              placeholder="KEY=value"
              rows={UI_TEXTAREA_ROWS_COMPACT}
              disabled={disabled}
            />
          </label>
        </>
      ) : (
        <>
          <label className="ui-field-stack">
            <span>{t('settings.url')}</span>
            <CommitTextInput value={mcpDraft.url} onCommit={(url) => onUpdateDraft({ url })} placeholder={mcpDraft.type === 'sse' ? 'https://example.com/sse' : 'https://example.com/mcp'} disabled={disabled} />
          </label>
          <label className="ui-field-stack">
            <span>{t('settings.api_key')}</span>
            <CommitTextInput
              value={mcpDraft.apiKey}
              onBlur={() => setApiKeyFocused(false)}
              onCommit={(apiKey) => onUpdateDraft({ apiKey })}
              onFocus={() => setApiKeyFocused(true)}
              placeholder={t('common.optional')}
              type={apiKeyFocused ? 'text' : 'password'}
              disabled={disabled}
            />
          </label>
        </>
      )}

      {(() => {
        const runtimeStatus = selectedServer && runtimeEnabled ? mcpServerRuntimeStatus(status, selectedServer) : undefined
        const loaded = selectedServer && runtimeEnabled ? mcpLoadedStatus(status, selectedServer) : undefined
        const errorText = selectedServer && runtimeEnabled ? mcpErrorStatus(status, selectedServer) : undefined
        const loading = Boolean(selectedServer && runtimeEnabled && selectedServer.enabled && !loaded && !errorText && (!runtimeStatus || runtimeStatus.state === 'idle' || runtimeStatus.state === 'starting' || runtimeStatus.state === 'recovering'))
        if (!selectedServer || (!loaded && !errorText && !loading && !runtimeStatus)) return null
        return (
          <div className="ui-note">
            {errorText ? (
              <p className="ui-status-danger">{errorText}</p>
            ) : loaded ? (
              <>
                <div>{t('settings.running')} - {t('settings.tools_count', { count: loaded.toolCount })}</div>
                {loaded.toolNames.length > 0 && (
                  <pre className="ui-code-block ui-code-block-subtle ui-code-block-compact ui-code-block-plain">{loaded.toolNames.join('\n')}</pre>
                )}
              </>
            ) : loading ? (
              <div>{runtimeStatus?.state === 'recovering' ? t('settings.mcp_state_recovering') : t('settings.waiting_for_mcp_status')}</div>
            ) : null}
          </div>
        )
      })()}
    </div>
  )
}
