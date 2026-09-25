import { setAllCustomTools, withToolShadows } from '@shared/toolPackages'
import { SubagentSelectionEditor, type SubagentSelectionProps } from './SubagentSelectionEditor'
import { useId, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ChevronRight, Folder, Plug } from 'lucide-react'
import { builtinToolCatalog, runtimeToolSelectionId } from '@shared/toolRegistry'
import { mcpServerSelection, removeEmptyMissingMcpSelections, setMcpServerMode, setMcpToolSelection, resolveSkillSelection, setToolSelection, toolAllowed, toolSelected, type AgentCapabilities } from '@shared/agentCapabilities'
import type { McpServerConfigDetail, McpToolStatus, RuntimeToolStatus, SkillSnapshot } from '@shared/types'
import { CheckboxField } from './CheckboxField'
import { SearchableOptionPicker } from './SearchableOptionPicker'
import { SettingsStatusIndicator } from './settings/SettingsStatusIndicator'
import { skillSourceGroups } from './skillSourceGroups'
import { UI_ICON_SIZE_MEDIUM } from './uiConstants'

const capabilityGroupOrder = [
  'profile', 'environment', 'workspace', 'applicationEnvironment',
  'backgroundTools', 'planning', 'commandExecution', 'networkAccess',
  'configuration', 'request_user_input', 'fileRead', 'fileWrite', 'memory', 'customTools', 'subagents'
]

interface Props {
  customTools?: readonly import('@shared/toolPackages').ToolPackage[]
  value: AgentCapabilities
  skills?: SkillSnapshot
  mcpStatus?: McpToolStatus
  mcpServers?: readonly Pick<McpServerConfigDetail, 'id' | 'name' | 'enabled'>[]
  runtimeToolStatus?: RuntimeToolStatus
  subagentSelection?: SubagentSelectionProps
  subagent?: boolean
  disabled?: boolean
  toolbarEnd?: ReactNode
  onChange(value: AgentCapabilities): void
  onEnableAll?(capabilities: AgentCapabilities): void
}

export function CapabilityEditor({ customTools = [], value: storedValue, skills, mcpStatus, mcpServers = [], runtimeToolStatus, subagentSelection, subagent = false, disabled = false, toolbarEnd, onChange: onValueChange, onEnableAll }: Props) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const mcpListId = useId()
  const [collapsedMcpIds, setCollapsedMcpIds] = useState<Set<string>>(() => new Set())
  const ordinaryTools = builtinToolCatalog.filter((tool) => tool.feature !== 'backgroundTools')
  const servers = new Map(mcpServers.map((server) => [server.id, server]))
  const runtimeServers = new Map(mcpStatus?.servers.map((server) => [server.id, server]))
  for (const server of runtimeServers.values()) {
    if (!servers.has(server.id)) servers.set(server.id, { id: server.id, name: server.name, enabled: true })
  }
  const configuredIds = new Set(servers.keys())
  const value = removeEmptyMissingMcpSelections(storedValue, configuredIds)
  function onChange(next: AgentCapabilities): void {
    onValueChange(removeEmptyMissingMcpSelections(next, configuredIds))
  }
  for (const server of value.mcp.servers) {
    if (!servers.has(server.id)) servers.set(server.id, { id: server.id, name: server.id, enabled: false })
  }
  const mcpGroups = [...servers.values()].map((server) => {
    const runtime = runtimeServers.get(server.id)
    const liveNames = new Set(runtime?.toolNames)
    const unavailable = !server.enabled || runtime?.state !== 'ready'
    return {
      id: server.id, name: server.name, enabled: server.enabled, unavailable,
      selection: mcpServerSelection(value.mcp, server.id),
      tools: [...new Set([...liveNames, ...mcpServerSelection(value.mcp, server.id).tools])].map((name) => ({
        name, unavailable: unavailable || !liveNames.has(name)
      }))
    }
  })
  const catalogToolIds = new Set<string>(builtinToolCatalog.map((tool) => tool.id))
  const missingTools = value.tools.filter((id) => !catalogToolIds.has(id))
  const customToolItems = withToolShadows(customTools.filter(tool => !subagent || tool.source !== 'project'),
    value.customTools.entries.filter(id => value.backgroundTools || !customTools.find(tool => tool.id === id)?.definition?.interactive))
  type CapabilityFlag = 'profile' | 'environment' | 'workspace' | 'memory' | 'applicationEnvironment' | 'backgroundTools' | 'subagents' | 'planning'
  const groups: Array<{ id: string; name: string; flag?: CapabilityFlag; tools: Array<{ id: string; name: string; unavailable?: boolean; requiresBackground?: boolean; shadowedBy?: string; ariaLabel?: string }> }> = [
    ...(['profile', 'environment', 'workspace', 'applicationEnvironment', 'backgroundTools', 'subagents', 'planning'] as const).filter((flag) => flag !== 'subagents' || !subagentSelection).map((flag) => ({
      id: flag, name: t(`settings.capability_${flag === 'workspace' ? 'workspaceContext' : flag}`), flag, tools: []
    })),
    ...(['commandExecution', 'networkAccess', 'fileRead', 'fileWrite', 'configuration', 'memory'] as const).map((feature) => ({
      id: feature, name: t(`settings.capability_${feature}`),
      ...(feature === 'memory' ? { flag: 'memory' as const } : {}),
      tools: ordinaryTools.filter((tool) => tool.feature === feature).map((tool) => ({
        id: tool.id,
        name: runtimeToolStatus?.tools.find((entry) => runtimeToolSelectionId(entry) === tool.id)?.name ?? tool.id
      }))
    })),
    ...ordinaryTools.filter((tool) => tool.feature === undefined).map((tool) => ({
      id: tool.id, name: t(`settings.capability_${tool.id}`, { defaultValue: tool.id }),
      tools: [{ id: tool.id, name: tool.id }]
    })),
    { id: 'customTools', name: t('custom_tools.title'), tools: [
      ...customToolItems.map((tool) => ({ id: tool.id, name: tool.name, unavailable: Boolean(tool.error),
        ariaLabel: `${tool.rootName} ${tool.name}`, shadowedBy: tool.shadowedBy, requiresBackground: tool.definition?.interactive && !value.backgroundTools })),
      ...value.customTools.entries.filter((id) => !customTools.some((tool) => tool.id === id)).map((id) => ({ id, name: id, unavailable: true }))
    ] },
    ...(missingTools.length ? [{ id: 'missing-tools', name: t('capabilities.other_tools'), tools: missingTools.map((id) => ({ id, name: id, unavailable: true })) }] : [])
  ]
  const isDirectToggle = (group: typeof groups[number]) => (group.tools.length === 1 && group.id !== 'missing-tools' && group.id !== 'customTools') || (!group.tools.length && Boolean(group.flag))
  const groupOrder = new Map<string, number>(capabilityGroupOrder.map((id, index) => [id, index]))
  const orderedGroups = [...groups].sort((a, b) => (groupOrder.get(a.id) ?? groupOrder.size) - (groupOrder.get(b.id) ?? groupOrder.size))
  function setTools(ids: string[], checked: boolean) {
    onChange(setToolSelection(value, ids, checked))
  }
  function selectGroupTools(group: typeof groups[number], ids: string[], checked: boolean): AgentCapabilities {
    if (group.id !== 'customTools') return setToolSelection(value, ids, checked)
    const retained = value.customTools.entries.filter((id) => !ids.includes(id))
    return { ...value, customTools: { ...value.customTools, entries: checked ? [...retained, ...ids] : retained } }
  }
  const visibleSkills = (skills?.skills ?? []).filter((skill) => !subagent || skill.source !== 'project')
  const effectiveSkills = resolveSkillSelection(value.skills, visibleSkills)
  const selectedSkills = new Map((value.skills.mode === 'custom' ? value.skills.entries : effectiveSkills.entries).map((entry) => [entry.id, entry]))
  const skillRootIds = new Set(skills?.roots.map((root) => root.id))
  const missingSkills = [
    ...visibleSkills.filter((skill) => !skillRootIds.has(skill.rootId)).map((skill) => ({ ...skill, unavailable: true })),
    ...value.skills.entries.filter((entry) => !skills?.skills.some((skill) => skill.id === entry.id)).map((entry) => ({ id: entry.id, name: entry.id, description: entry.id, unavailable: true }))
  ]
  const matchesSkillQuery = (skill: { name: string }) => skill.name.toLowerCase().includes(query.toLowerCase())
  const projectSkillsSelected = subagent && value.skills.enabled && value.skills.mode === 'custom' && value.skills.project
  const selectedSkillCount = effectiveSkills.entries.filter((entry) => entry.model || (!subagent && entry.shortcut)).length
  const skillWarning = (effectiveSkills.entries.some((entry) => entry.model || (!subagent && entry.shortcut))
    || projectSkillsSelected)
    && !['run_shell', 'read_file', 'read_multiple_files'].some((id) => toolAllowed(value, id))
  function setSkill(id: string, key: 'shortcut' | 'model', enabled: boolean) {
    const entries = value.skills.entries.filter((entry) => entry.id !== id)
    const current = value.skills.entries.find((entry) => entry.id === id) ?? { id, shortcut: false, model: false }
    onChange({ ...value, skills: { ...value.skills, entries: [...entries, { ...current, [key]: enabled }] } })
  }
  function renderSkill(skill: { id: string; name: string; description: string; unavailable: boolean }) {
    return <div className="ui-capability-skill" key={skill.id}>
      <span className="ui-row"><code className="ui-truncate" data-tooltip={skill.description}>{skill.name}</code>{skill.unavailable && <span className="ui-badge">{t('capabilities.inactive')}</span>}</span>
      {!subagent && <CheckboxField className="ui-checkbox-field-inline" checked={selectedSkills.get(skill.id)?.shortcut ?? false} label={t('capabilities.shortcut')} aria-label={`${skill.name} ${t('capabilities.shortcut')}`} onChange={(checked) => setSkill(skill.id, 'shortcut', checked)} />}
      <CheckboxField className="ui-checkbox-field-inline" checked={selectedSkills.get(skill.id)?.model ?? false} label={subagent ? '' : t('capabilities.model')} aria-label={`${skill.name} ${t('capabilities.model')}`} onChange={(checked) => setSkill(skill.id, 'model', checked)} />
    </div>
  }
  return (
    <fieldset className="ui-page-section ui-surface-flat" aria-label={t('settings.capabilities')} disabled={disabled}>
      <div className="ui-capability-editor">
        <div className="ui-toolbar ui-toolbar-between">
          {subagent && <strong className="ui-section-title">{t('settings.capabilities')}</strong>}
          <div className="ui-toolbar">
            <button type="button" className="ui-button ui-button-compact" onClick={() => {
              const enabled: AgentCapabilities = { ...value, profile: true, environment: true, workspace: true, memory: true, applicationEnvironment: true, backgroundTools: true, subagents: true, planning: true, toolMode: 'all', tools: [], customTools: setAllCustomTools(value.customTools, customTools, subagent, true), mcp: { defaultMode: 'all', servers: value.mcp.servers.map((server) => ({ ...server, mode: 'all' })) }, skills: { ...value.skills, enabled: true, mode: 'default' } }
              if (onEnableAll) onEnableAll(enabled)
              else onChange(enabled)
            }}>{t('settings.capabilities_enable_all')}</button>
            <button type="button" className="ui-button ui-button-compact" onClick={() => onChange({ ...value, profile: false, environment: false, workspace: false, memory: false, applicationEnvironment: false, backgroundTools: false, subagents: false, planning: false, toolMode: 'selected', tools: [], customTools: setAllCustomTools(value.customTools, customTools, subagent, false), mcp: { defaultMode: 'selected', servers: [] }, skills: { ...value.skills, enabled: false } })}>{t('settings.capabilities_disable_all')}</button>
          </div>
          {toolbarEnd}
        </div>
        <div className="ui-grid-auto">
          {orderedGroups.map((group) => {
            if (isDirectToggle(group)) return <CheckboxField className="ui-checkbox-field-inline" key={group.id}
              checked={group.flag ? value[group.flag] : group.tools.some((tool) => toolAllowed(value, tool.id))}
              aria-label={group.name} label={<span className="ui-row">{group.name}{group.tools[0]?.unavailable && <span className="ui-badge">{t('capabilities.inactive')}</span>}</span>}
              tooltip={group.flag === 'applicationEnvironment' ? t('capabilities.environment_hint') : undefined}
              onChange={(checked) => group.flag ? onChange({ ...value, [group.flag]: checked }) : setTools(group.tools.map((tool) => tool.id), checked)} />
            const projectTools = group.id === 'customTools' && subagent
            const total = group.tools.length + (group.flag ? 1 : 0) + (projectTools ? 1 : 0)
            const count = group.tools.filter((tool) => group.id === 'customTools' ? value.customTools.entries.includes(tool.id) : toolAllowed(value, tool.id)).length + (group.flag && value[group.flag] ? 1 : 0) + (projectTools && value.customTools.project ? 1 : 0)
            const toggle = (checked: boolean) => onChange({
              ...(group.id === 'customTools' ? { ...value, customTools: setAllCustomTools(value.customTools, customTools, subagent, checked) } : selectGroupTools(group, group.tools.map((tool) => tool.id), checked)),
              ...(group.flag ? { [group.flag]: checked } : {})
            })
            return <div className="ui-capability-group" key={group.id}>
              <CheckboxField className="ui-checkbox-field-inline" checked={count === total && count > 0} indeterminate={count > 0 && count < total}
                aria-label={group.name} label="" disabled={total === 0} onChange={toggle} />
              <details>
                <summary>{group.name} <small>{count}/{total}</small></summary>
                <fieldset className="ui-capability-list ui-capability-tools ui-grid-auto">
                  {projectTools && <CheckboxField className="ui-checkbox-field-inline" checked={value.customTools.project} label={t('custom_tools.project_tools')}
                    onChange={project => onChange({ ...value, customTools: { ...value.customTools, project } })} />}
                  {group.flag && <CheckboxField className="ui-checkbox-field-inline" checked={value[group.flag]}
                    label={t('settings.capability_memory_recall')} onChange={(checked) => onChange({ ...value, [group.flag!]: checked })} />}
                  {group.tools.map((tool) => <CheckboxField className="ui-checkbox-field-inline" key={tool.id} checked={group.id === 'customTools' ? value.customTools.entries.includes(tool.id) : toolSelected(value, tool.id)} aria-label={tool.ariaLabel ?? tool.name} label={<span className="ui-row"><code className="ui-tool-name">{tool.name}</code>{tool.unavailable && <span className="ui-badge">{t('capabilities.inactive')}</span>}{tool.shadowedBy && <span className="ui-badge" data-tooltip={t('custom_tools.shadowed_by', { source: tool.shadowedBy })}>{t('custom_tools.shadowed')}</span>}{tool.requiresBackground && <span className="ui-badge">{t('custom_tools.requires_background')}</span>}</span>}
                    onChange={(checked) => onChange(selectGroupTools(group, [tool.id], checked))} />)}
                  {group.id === 'customTools' && !group.tools.length && <small className="ui-field-hint">{t('custom_tools.empty')}</small>}
                </fieldset>
              </details>
            </div>
          })}
        </div>
        {mcpGroups.length > 0 && <div className="ui-form-section ui-form-section-divided">
          {mcpGroups.map((group) => {
            const expanded = group.unavailable || !collapsedMcpIds.has(group.id)
            const contentId = `${mcpListId}-${group.id}`
            const heading = <>
              <Plug className="ui-muted" size={UI_ICON_SIZE_MEDIUM} aria-hidden="true" />
              <span className="ui-truncate">{group.name}</span>
              {group.unavailable && <span className="ui-badge">{t('capabilities.inactive')}</span>}
            </>
            return <div className="ui-form-section" key={group.id} data-mcp-server-id={group.id}>
              <div className="ui-row-between">
                {group.unavailable || group.selection.mode === 'all' ? <div className="ui-row">{heading}</div> : <button className="ui-disclosure-trigger ui-row" type="button" aria-label={group.name}
                  aria-expanded={expanded} aria-controls={contentId} onClick={() => setCollapsedMcpIds((current) => {
                    const next = new Set(current)
                    if (next.has(group.id)) next.delete(group.id)
                    else next.add(group.id)
                    return next
                  })}>
                  {heading}
                  <ChevronRight className="ui-disclosure-chevron" size={13} aria-hidden="true" />
                </button>}
                <CheckboxField className="ui-checkbox-field-inline" label={t('capabilities.use_all_tools')} aria-label={`${group.name} ${t('capabilities.use_all_tools')}`}
                  checked={group.selection.mode === 'all'} onChange={(checked) => onChange(setMcpServerMode(value, group.id, checked ? 'all' : 'selected'))} />
              </div>
              {group.selection.mode === 'selected' && (group.enabled || group.tools.length > 0) && <div id={contentId} hidden={!expanded}>
                <div className="ui-capability-list ui-capability-tools ui-grid-auto">
                  {!group.tools.length && <small>{t('capabilities.no_known_mcp_tools')}</small>}
                  {group.tools.map((tool) => <CheckboxField className="ui-checkbox-field-inline" key={tool.name} aria-label={`${group.name} ${tool.name}`}
                    label={<span className="ui-row"><code className="ui-tool-name">{tool.name}</code>{!group.unavailable && tool.unavailable && <span className="ui-badge">{t('capabilities.inactive')}</span>}</span>}
                    checked={group.selection.tools.includes(tool.name)} onChange={(checked) => onChange(setMcpToolSelection(value, group.id, tool.name, checked))} />)}
                </div>
              </div>}
            </div>
          })}
        </div>}
        {subagentSelection && <SubagentSelectionEditor {...subagentSelection} enabled={value.subagents} disabled={disabled}
          onEnable={(subagents) => onChange({ ...value, subagents })} />}
        <div className="ui-form-section ui-form-section-divided">
          <div className="ui-form-row ui-form-row-inline">
            <div className="ui-row">
              <CheckboxField className="ui-checkbox-field-inline" checked={value.skills.enabled} label={t('settings.capability_skills')}
                onChange={(enabled) => onChange({ ...value, skills: { ...value.skills, enabled } })} />
              <small>{selectedSkillCount}{projectSkillsSelected && <> + {t('settings.skill_group_project')}</>}</small>
              {skillWarning && <SettingsStatusIndicator label={t('settings.subagent_skills_require_file_read')} hint={t('settings.subagent_skills_require_file_read')} />}
            </div>
            <SearchableOptionPicker
              className="compact"
              ariaLabel={t('capabilities.skill_selection')}
              disabled={disabled || !value.skills.enabled}
              emptyLabel={t('settings.no_options')}
              searchable={false}
              value={value.skills.mode}
              options={[
                { value: 'default', label: t('capabilities.default') },
                { value: 'custom', label: t('capabilities.custom') }
              ]}
              onChange={(mode) => onChange({ ...value, skills: { ...value.skills, mode: mode as 'default' | 'custom' } })}
            />
          </div>
          <fieldset disabled={!value.skills.enabled} className="ui-capability-editor">
            {value.skills.mode === 'custom' && <>
              <input className="ui-input" type="search" aria-label={t('capabilities.search_skills')} placeholder={t('capabilities.search_skills')} value={query} onChange={(event) => setQuery(event.target.value)} />
              <div className="ui-capability-list">
                {skillSourceGroups(skills?.roots ?? [], t).map((group) => {
                  if (subagent && group.id === 'project') return <div className="ui-capability-skill" key={group.id}>
                    <span className="ui-row"><Folder size={UI_ICON_SIZE_MEDIUM} aria-hidden="true" /><span>{t('capabilities.project_skills')}</span></span>
                    <CheckboxField
                      className="ui-checkbox-field-inline"
                      checked={value.skills.project}
                      label=""
                      aria-label={t('capabilities.project_skills')}
                      tooltip={t('capabilities.project_skills_hint')}
                      onChange={(project) => onChange({ ...value, skills: { ...value.skills, project } })}
                    />
                  </div>
                  const rootIds = new Set(group.roots.map((root) => root.id))
                  const items = (skills?.skills ?? []).filter((skill) => rootIds.has(skill.rootId) && matchesSkillQuery(skill))
                  if (!items.length) return null
                  return <div className="ui-form-section" key={group.id}>
                    <strong className="ui-row"><Folder size={UI_ICON_SIZE_MEDIUM} aria-hidden="true" /><span>{group.label} <small>{items.filter((skill) => selectedSkills.get(skill.id)?.model || (!subagent && selectedSkills.get(skill.id)?.shortcut)).length}/{items.length}</small></span></strong>
                    {group.roots.map((root) => {
                      const rootItems = items.filter((skill) => skill.rootId === root.id)
                      if (!rootItems.length) return null
                      return <div className="ui-form-section" key={root.id}>
                        {group.roots.length > 1 && <strong className="ui-row"><Folder size={UI_ICON_SIZE_MEDIUM} aria-hidden="true" /><span>{root.name}</span></strong>}
                        {rootItems.map((skill) => renderSkill({ ...skill, unavailable: Boolean(skill.loadError) }))}
                      </div>
                    })}
                  </div>
                })}
                {missingSkills.some(matchesSkillQuery) && <div className="ui-form-section">
                  <strong>{t('capabilities.other_skills')}</strong>
                  {missingSkills.filter(matchesSkillQuery).map(renderSkill)}
                </div>}
                {!skills && <small>{t('capabilities.loading')}</small>}
              </div>
            </>}
          </fieldset>
        </div>
      </div>
    </fieldset>
  )
}
