import * as Dialog from '@radix-ui/react-dialog'
import { Braces, ClipboardCopy, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  builtinToolCatalog,
  toolGroupOrder,
  frameworkToolCatalog,
  orderedToolCatalog,
  runtimeToolSelectionId
} from '@shared/toolRegistry'
import type { McpServerConfigDetail, McpToolStatus, RuntimeToolDefinition, RuntimeToolStatus } from '@shared/types'
import { notice } from '../notice'
import { UI_ICON_SIZE_SMALL } from '../uiConstants'
import { CustomToolsGroup } from './CustomToolsGroup'
import type { AppConfigSnapshot } from '@shared/types'
import type { ToolPackage } from '@shared/toolPackages'

interface ToolsSettingsProps {
  customTools: ToolPackage[]
  onConfigChange(config: AppConfigSnapshot): void
  mcpServers: McpServerConfigDetail[]
  mcpStatus: McpToolStatus | undefined
  runtimeToolStatus: RuntimeToolStatus | undefined
}

interface McpToolDisplayGroup {
  id: string
  name: string
  tools: RuntimeToolDefinition[]
}

export function mcpToolDisplayGroups(
  status: McpToolStatus | undefined,
  configuredServers: McpServerConfigDetail[]
): McpToolDisplayGroup[] {
  const definitions = new Map<string, RuntimeToolDefinition[]>()
  for (const tool of status?.tools ?? []) {
    definitions.set(tool.name, [...(definitions.get(tool.name) ?? []), tool])
  }
  const refs = configuredServers.length > 0
    ? configuredServers
    : (status?.servers ?? [])
  const groups: McpToolDisplayGroup[] = refs.map((server) => {
    const loaded = status?.loaded.find((item) =>
      item.id === server.id && item.index === server.index
    )
    const tools = (loaded?.toolNames ?? []).map((name) => {
      const matches = definitions.get(name) ?? []
      const definition = matches.shift()
      definitions.set(name, matches)
      return definition ?? emptyToolDefinition(name)
    })
    return {
      id: `${server.id}:${server.index}`,
      name: server.name,
      tools
    }
  })
  const otherTools = [...definitions.values()].flat()
  if (otherTools.length > 0) {
    groups.push({
      id: 'other',
      name: '',
      tools: otherTools
    })
  }
  return groups
}

function emptyToolDefinition(name: string, description = ''): RuntimeToolDefinition {
  return { name, description, parameters: [] }
}

export function toolDefinitionText(tool: RuntimeToolDefinition): string {
  return JSON.stringify({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema ?? {
      type: 'object',
      properties: Object.fromEntries(tool.parameters.map((parameter) => [
        parameter.name,
        {
          description: parameter.description,
          ...(parameter.schema && typeof parameter.schema === 'object'
            ? parameter.schema as Record<string, unknown>
            : {})
        }
      ]))
    }
  }, null, 2)
}

export function ToolsSettings({ customTools, onConfigChange, mcpServers, mcpStatus, runtimeToolStatus }: ToolsSettingsProps) {
  const { t } = useTranslation()
  const [selectedGroup, setSelectedGroup] = useState<string>(toolGroupOrder.find(group => orderedToolCatalog.some(tool => (tool.feature ?? tool.id) === group)) ?? 'customTools')
  const [selectedToolKey, setSelectedToolKey] = useState<string>()
  const renderGroupTitle = (label: string) => (
    <strong className="settings-tool-group-title">{label}</strong>
  )
  const runtimeToolByName = useMemo(
    () => new Map((runtimeToolStatus?.tools ?? []).map((tool) => [runtimeToolSelectionId(tool), tool])),
    [runtimeToolStatus]
  )
  const mcpGroups = useMemo(
    () => mcpToolDisplayGroups(mcpStatus, mcpServers),
    [mcpServers, mcpStatus]
  )
  const toolDefinitions = useMemo(() => new Map([
    ...builtinToolCatalog.map((tool): [string, RuntimeToolDefinition] => [
      `runtime:${tool.id}`, runtimeToolByName.get(tool.id) ?? emptyToolDefinition(tool.id)
    ]),
    ...frameworkToolCatalog.map((tool): [string, RuntimeToolDefinition] => [
      `runtime:${tool.id}`, runtimeToolByName.get(tool.id) ?? emptyToolDefinition(tool.id, t(`settings.framework_tool_${tool.id}_hint`))
    ]),
    ...mcpGroups.flatMap((group) => group.tools.map((tool, index): [string, RuntimeToolDefinition] => [
      `mcp:${group.id}:${tool.name}:${index}`, tool
    ]))
  ]), [runtimeToolByName, mcpGroups, t])
  const selectedTool = selectedToolKey ? toolDefinitions.get(selectedToolKey) : undefined
  const selectedToolText = selectedTool ? toolDefinitionText(selectedTool) : ''
  function renderToolRow(key: string) {
    const tool = toolDefinitions.get(key)!
    return (
      <button
        aria-label={`${tool.name}: ${t('settings.tools_view_details')}`}
        className="settings-tool-catalog-row"
        key={key}
        type="button"
        onClick={() => setSelectedToolKey(key)}
      >
        <code className="settings-tool-catalog-name ui-tool-name">{tool.name}</code>
      </button>
    )
  }

  async function copyToolDefinition(): Promise<void> {
    try {
      await navigator.clipboard.writeText(selectedToolText)
      notice.success(t('chat.message_copied'))
    } catch {
      notice.error(t('chat.failed_copy_message'))
    }
  }

  return (
    <>
      <nav className="ui-scroll-list" aria-label={t('settings.tools_page')}>
        {toolGroupOrder.filter(group => group === 'mcp' || group === 'customTools' || orderedToolCatalog.some(tool => (tool.feature ?? tool.id) === group)).map(group => {
          const count = group === 'customTools' ? customTools.length
            : group === 'mcp' ? mcpGroups.reduce((total, server) => total + server.tools.length, 0)
              : orderedToolCatalog.filter(tool => (tool.feature ?? tool.id) === group).length
          return <button key={group} type="button" className={`ui-list-item ui-list-item-split${selectedGroup === group ? " active" : ""}`} aria-pressed={selectedGroup === group} onClick={() => { setSelectedGroup(group); setSelectedToolKey(undefined) }}>
            <strong>{group === 'customTools' ? t('custom_tools.title') : group === 'mcp' ? t('settings.mcp') : t(`settings.capability_${group}`)}</strong>
            <em>{count}</em>
          </button>
        })}
      </nav>
      <div className="ui-editor">
        {selectedGroup === 'customTools' ? <CustomToolsGroup tools={customTools} onConfigChange={onConfigChange} />
          : selectedGroup === 'mcp' ? <div className="ui-form-section settings-tool-group">
            {renderGroupTitle(t('settings.mcp'))}
            <div className="settings-mcp-tool-groups">
              {mcpGroups.map(group => <section className="settings-mcp-tool-group" key={group.id}>
                <div className="settings-mcp-tool-group-header ui-row"><strong>{group.id === 'other' ? t('settings.tools_mcp_other') : group.name}</strong>
                  <small>{t('settings.tools_count', { count: group.tools.length })}</small></div>
                <div className="settings-tool-catalog">
                  {group.tools.map((tool, index) => renderToolRow(`mcp:${group.id}:${tool.name}:${index}`))}
                  {!group.tools.length && <div className="ui-field-hint">{t('settings.tools_mcp_server_empty')}</div>}
                </div>
              </section>)}
              {!mcpGroups.length && <div className="ui-field-hint">{t('settings.tools_mcp_empty')}</div>}
            </div>
          </div> : <div className="ui-form-section">
            {renderGroupTitle(t(`settings.capability_${selectedGroup}`))}
            <small className="ui-field-hint">{t('settings.tools_page_hint')}</small>
            <div className="settings-tool-catalog">{orderedToolCatalog.filter(tool => (tool.feature ?? tool.id) === selectedGroup).map(tool => renderToolRow(`runtime:${tool.id}`))}</div>
          </div>}
      </div>

      <Dialog.Root open={selectedTool !== undefined} onOpenChange={(open) => { if (!open) setSelectedToolKey(undefined) }}>
        <Dialog.Portal>
          <Dialog.Overlay className="ui-backdrop" />
          <Dialog.Content className="ui-dialog ui-dialog-wide ui-dialog-centered ui-popover settings-code-preview-dialog">
            <header className="ui-dialog-header">
              <div className="ui-dialog-icon">
                <Braces size={18} />
              </div>
              <div>
                <Dialog.Title asChild>
                  <h2 className="ui-dialog-title">{selectedTool?.name ?? ''}</h2>
                </Dialog.Title>
                <Dialog.Description asChild>
                  <p className="ui-dialog-description">{t('settings.tool_definition_hint')}</p>
                </Dialog.Description>
              </div>
            </header>

            <div className="settings-code-preview-content">
              <pre className="ui-code-block settings-code-preview-code">{selectedToolText}</pre>
            </div>

            <footer className="ui-dialog-footer">
              <button
                className="ui-button ui-button-compact"
                type="button"
                disabled={!selectedToolText}
                onClick={() => void copyToolDefinition()}
              >
                <ClipboardCopy size={UI_ICON_SIZE_SMALL} />
                <span>{t('common.copy')}</span>
              </button>
              <Dialog.Close asChild>
                <button className="ui-button ui-button-compact" type="button">
                  <X size={UI_ICON_SIZE_SMALL} />
                  <span>{t('common.close')}</span>
                </button>
              </Dialog.Close>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  )
}
