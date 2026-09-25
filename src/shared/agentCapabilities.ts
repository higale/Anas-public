import { defaultSubagentSelection, validateSubagentSelection, type SubagentSelection } from './subagentSelection'
import defaults from '../../data/config/capabilities.json'
import projectDefaults from '../../data/config/projects.json'
import { builtinToolCatalog } from './toolRegistry'
import { parseCustomTools, serializeCustomTool, validateCustomTools, type CustomToolDefinition } from './customTools'
import { validateToolSelection, type ToolSelection, type ResolvedToolSelection } from './toolPackages'
import type { AgentFeatures, SkillSummary, SkillSnapshot, WorkspaceProject } from './types'

export interface SkillSelection {
  enabled: boolean
  mode: 'default' | 'custom'
  /** Include the current project's skills in custom subagent selections. */
  project: boolean
  entries: Array<{ id: string; shortcut: boolean; model: boolean }>
}

export interface McpServerToolSelection {
  id: string
  mode: 'all' | 'selected'
  /** Retained when switching to all, restored when switching back to selected. */
  tools: string[]
}

export interface McpSelection {
  defaultMode: 'all' | 'selected'
  servers: McpServerToolSelection[]
}

export interface AgentCapabilities {
  profile: boolean
  environment: boolean
  workspace: boolean
  /** Automatically recall relevant records; memory tools are selected independently. */
  memory: boolean
  applicationEnvironment: boolean
  backgroundTools: boolean
  subagents: boolean
  planning: boolean
  toolMode: 'all' | 'selected' | 'except'
  tools: string[]
  skills: SkillSelection
  customTools: ToolSelection
  mcp: McpSelection
}

export interface ResolvedSkillSelection extends SkillSelection {
  mode: 'custom'
  project: false
}

export interface ResolvedAgentCapabilities extends AgentCapabilities {
  skills: ResolvedSkillSelection
  customTools: ResolvedToolSelection
}

/** Intersection operates on catalog-resolved entries, never editable preferences. */
export function assertResolvedCapabilities(value: AgentCapabilities): asserts value is ResolvedAgentCapabilities {
  if (value.skills.mode !== 'custom' || value.skills.project !== false || value.customTools.project !== false) {
    throw new Error('Resolve capability selections against the current catalogs before intersecting capabilities.')
  }
}

export interface RunConfiguration {
  /** Immutable tool definitions selected for this run. */
  customTools: CustomToolDefinition[]
  /** Workflow only; never participates in capability selection or intersection. */
  codingMode: boolean
  capabilities: AgentCapabilities
  /** Root project policy, retained through every descendant run. */
  subagentLimit?: AgentCapabilities
  /** Effective launch selection captured for this run. */
  subagentSelection?: SubagentSelection
  /** Root project launch range, retained independently of each child's choices. */
  subagentSelectionLimit?: SubagentSelection
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid capability settings.')
  return value as Record<string, unknown>
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Capability settings must use booleans.')
  return value
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error('Capability tool selection must contain non-empty IDs.')
  }
  return [...new Set(value as string[])]
}

export function validateCapabilities(value: unknown): AgentCapabilities {
  const raw = object(value)
  const skills = object(raw.skills)
  const mcp = object(raw.mcp)
  if (mcp.defaultMode !== 'all' && mcp.defaultMode !== 'selected') throw new Error('Invalid default MCP tool mode.')
  if (!Array.isArray(mcp.servers)) throw new Error('Invalid MCP server selections.')
  const servers = mcp.servers.map((value): McpServerToolSelection => {
    const entry = object(value)
    if (typeof entry.id !== 'string' || !entry.id.trim()) throw new Error('Invalid MCP server ID.')
    if (entry.mode !== 'all' && entry.mode !== 'selected') throw new Error('Invalid MCP server tool mode.')
    return { id: entry.id, mode: entry.mode, tools: strings(entry.tools) }
  })
  if (new Set(servers.map((entry) => entry.id)).size !== servers.length) throw new Error('Duplicate MCP server ID.')
  const tools = strings(raw.tools)
  if (tools.some((id) => id.startsWith('mcp:'))) throw new Error('MCP selections must use the per-server MCP policy.')
  if (raw.toolMode !== 'all' && raw.toolMode !== 'selected' && raw.toolMode !== 'except') throw new Error('Invalid capability tool mode.')
  if (skills.mode !== 'default' && skills.mode !== 'custom') throw new Error('Invalid skill selection mode.')
  if (!Array.isArray(skills.entries)) throw new Error('Invalid skill selection entries.')
  const entries = skills.entries.map((value) => {
    const entry = object(value)
    if (typeof entry.id !== 'string' || !entry.id.trim()) throw new Error('Invalid skill ID.')
    return { id: entry.id, shortcut: boolean(entry.shortcut), model: boolean(entry.model) }
  })
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error('Duplicate skill ID.')
  return {
    profile: boolean(raw.profile), environment: boolean(raw.environment), workspace: boolean(raw.workspace), memory: boolean(raw.memory),
    applicationEnvironment: boolean(raw.applicationEnvironment),
    backgroundTools: boolean(raw.backgroundTools),
    subagents: boolean(raw.subagents),
    planning: boolean(raw.planning),
    toolMode: raw.toolMode,
    tools,
    customTools: validateToolSelection(raw.customTools),
    mcp: { defaultMode: mcp.defaultMode, servers },
    skills: { enabled: boolean(skills.enabled), mode: skills.mode, project: boolean(skills.project), entries }
  }
}

export function parseCapabilities(value: unknown): AgentCapabilities {
  const raw = object(value)
  const mcp = object(raw.mcp)
  return validateCapabilities({ ...raw, customTools: raw.custom_tools, mcp: { ...mcp, defaultMode: mcp.default_mode }, applicationEnvironment: raw.application_environment, backgroundTools: raw.background_tools, toolMode: raw.tool_mode })
}

export function serializeCapabilities(value: AgentCapabilities) {
  const { applicationEnvironment, backgroundTools, toolMode, customTools, mcp, ...rest } = validateCapabilities(value)
  return { ...rest, custom_tools: customTools, mcp: { default_mode: mcp.defaultMode, servers: mcp.servers }, application_environment: applicationEnvironment, background_tools: backgroundTools, tool_mode: toolMode }
}

export const defaultCapabilities = parseCapabilities(defaults)
export const defaultProjectSettings = { advancedSettings: projectDefaults.advanced_settings, codingMode: projectDefaults.coding_mode, prompt: projectDefaults.prompt }

export interface DefaultCapabilitySettings {
  capabilities: AgentCapabilities
  restrictSubagents: boolean
  subagentSelection: SubagentSelection
}

export function validateDefaultCapabilitySettings(value: unknown): DefaultCapabilitySettings {
  const raw = object(value)
  return {
    capabilities: validateCapabilities(raw.capabilities),
    restrictSubagents: boolean(raw.restrictSubagents),
    subagentSelection: validateSubagentSelection(raw.subagentSelection)
  }
}

export function parseDefaultCapabilitySettings(value: unknown): DefaultCapabilitySettings {
  const raw = object(value)
  return validateDefaultCapabilitySettings({ capabilities: parseCapabilities(raw),
    restrictSubagents: raw.restrict_subagents, subagentSelection: raw.subagent_selection })
}

export function serializeDefaultCapabilitySettings(value: DefaultCapabilitySettings) {
  const validated = validateDefaultCapabilitySettings(value)
  return { ...serializeCapabilities(validated.capabilities), restrict_subagents: validated.restrictSubagents,
    subagent_selection: validated.subagentSelection }
}

export const defaultCapabilitySettings = parseDefaultCapabilitySettings(defaults)

export function effectiveProjectCapabilitySettings(project: WorkspaceProject, defaults: DefaultCapabilitySettings): DefaultCapabilitySettings {
  return project.advancedSettings
    ? { capabilities: project.capabilities, restrictSubagents: project.restrictSubagents,
      subagentSelection: project.subagentSelection ?? defaultSubagentSelection }
    : defaults
}

export function effectiveProjectCapabilities(project: WorkspaceProject, defaults: DefaultCapabilitySettings): AgentCapabilities {
  return effectiveProjectCapabilitySettings(project, defaults).capabilities
}
export function validateRunConfiguration(value: unknown): RunConfiguration {
  const raw = object(value)
  const capabilities = validateCapabilities(raw.capabilities)
  const subagentLimit = raw.subagentLimit === undefined ? undefined : validateCapabilities(raw.subagentLimit)
  if (typeof raw.codingMode !== 'boolean') throw new Error('Invalid run coding mode.')
  return { codingMode: raw.codingMode, capabilities, customTools: validateCustomTools(raw.customTools), ...(subagentLimit ? { subagentLimit } : {}),
    ...(raw.subagentSelectionLimit === undefined ? {} : { subagentSelectionLimit: validateSubagentSelection(raw.subagentSelectionLimit) }),
    ...(raw.subagentSelection === undefined ? {} : { subagentSelection: validateSubagentSelection(raw.subagentSelection) }) }
}

export function serializeRunConfiguration(value: RunConfiguration) {
  const config = validateRunConfiguration(value)
  return {
    coding_mode: config.codingMode,
    custom_tools: config.customTools.map(serializeCustomTool),
    capabilities: serializeCapabilities(config.capabilities),
    ...(config.subagentSelection ? { subagent_selection: config.subagentSelection } : {}),
    ...(config.subagentSelectionLimit ? { subagent_selection_limit: config.subagentSelectionLimit } : {}),
    ...(config.subagentLimit ? { subagent_limit: serializeCapabilities(config.subagentLimit) } : {})
  }
}

export function parseRunConfiguration(value: unknown): RunConfiguration {
  const raw = object(value)
  return validateRunConfiguration({
    codingMode: raw.coding_mode,
    customTools: parseCustomTools(raw.custom_tools),
    capabilities: parseCapabilities(raw.capabilities),
    ...(raw.subagent_selection === undefined ? {} : { subagentSelection: raw.subagent_selection }),
    ...(raw.subagent_selection_limit === undefined ? {} : { subagentSelectionLimit: raw.subagent_selection_limit }),
    ...(raw.subagent_limit === undefined ? {} : { subagentLimit: parseCapabilities(raw.subagent_limit) })
  })
}
export const defaultRestrictSubagents = defaults.restrict_subagents

export function toolSelected(capabilities: AgentCapabilities, id: string): boolean {
  if (capabilities.toolMode === 'all') return true
  return capabilities.toolMode === 'except' ? !capabilities.tools.includes(id) : capabilities.tools.includes(id)
}

export function setToolSelection(capabilities: AgentCapabilities, ids: string[], checked: boolean): AgentCapabilities {
  const mode = capabilities.toolMode === 'selected' ? 'selected' : 'except'
  const current = capabilities.toolMode === 'all' ? [] : capabilities.tools
  const retained = current.filter((id) => !ids.includes(id))
  const tools = checked === (mode === 'selected') ? [...retained, ...ids] : retained
  return { ...capabilities, toolMode: mode === 'except' && tools.length === 0 ? 'all' : mode, tools }
}

export function toolAllowed(capabilities: AgentCapabilities, id: string): boolean {
  if (builtinToolCatalog.some((tool) => tool.id === id && tool.feature === 'backgroundTools')) {
    // The group grants supervision; the runtime decides whether an enabled
    // Shell or custom tool can create a terminal for write_call.
    return capabilities.backgroundTools
  }
  return toolSelected(capabilities, id)
}

export function mcpServerSelection(selection: McpSelection, id: string): McpServerToolSelection {
  return selection.servers.find((server) => server.id === id) ?? { id, mode: selection.defaultMode, tools: [] }
}

export function removeEmptyMissingMcpSelections(value: AgentCapabilities, configuredIds: ReadonlySet<string>): AgentCapabilities {
  const servers = value.mcp.servers.filter((server) => configuredIds.has(server.id) || server.mode === 'all' || server.tools.length > 0)
  return servers.length === value.mcp.servers.length ? value : { ...value, mcp: { ...value.mcp, servers } }
}

function withMcpServerSelection(value: AgentCapabilities, server: McpServerToolSelection): AgentCapabilities {
  const exists = value.mcp.servers.some((entry) => entry.id === server.id)
  const servers = exists ? value.mcp.servers.map((entry) => entry.id === server.id ? server : entry) : [...value.mcp.servers, server]
  return { ...value, mcp: { ...value.mcp, servers } }
}

export function setMcpServerMode(value: AgentCapabilities, id: string, mode: McpServerToolSelection['mode']): AgentCapabilities {
  return withMcpServerSelection(value, { ...mcpServerSelection(value.mcp, id), mode })
}

export function setMcpToolSelection(value: AgentCapabilities, id: string, name: string, checked: boolean): AgentCapabilities {
  const server = mcpServerSelection(value.mcp, id)
  const retained = server.tools.filter((tool) => tool !== name)
  return withMcpServerSelection(value, { ...server, mode: 'selected', tools: checked ? [...retained, name] : retained })
}

export function mcpToolAllowed(value: AgentCapabilities, id: string, name: string): boolean {
  const server = mcpServerSelection(value.mcp, id)
  return server.mode === 'all' || server.tools.includes(name)
}

function intersectMcpSelections(value: McpSelection, limit: McpSelection): McpSelection {
  const ids = new Set([...value.servers, ...limit.servers].map((server) => server.id))
  return {
    defaultMode: value.defaultMode === 'all' && limit.defaultMode === 'all' ? 'all' : 'selected',
    servers: [...ids].map((id) => {
      const own = mcpServerSelection(value, id)
      const ceiling = mcpServerSelection(limit, id)
      if (own.mode === 'all' && ceiling.mode === 'all') return { id, mode: 'all', tools: [] }
      const selected = own.mode === 'selected' ? own : ceiling
      const other = selected === own ? ceiling : own
      return { id, mode: 'selected', tools: selected.tools.filter((tool) => other.mode === 'all' || other.tools.includes(tool)) }
    })
  }
}

/** A runtime projection only, never a second persisted collection of switches. */
export function capabilityFeatures(value: AgentCapabilities): AgentFeatures {
  const groupEnabled = (feature: keyof AgentFeatures) => builtinToolCatalog.some((tool) => tool.feature === feature && toolAllowed(value, tool.id))
  return {
    configuration: toolAllowed(value, 'update_config'),
    profile: value.profile,
    environment: value.environment,
    applicationEnvironment: value.applicationEnvironment,
    workspaceContext: value.workspace,
    memory: value.memory || groupEnabled('memory'),
    skills: value.skills.enabled,
    subagents: value.subagents,
    planning: value.planning,
    backgroundTools: value.backgroundTools,
    commandExecution: toolAllowed(value, 'run_shell'),
    networkAccess: toolAllowed(value, 'http_request'),
    fileRead: groupEnabled('fileRead'),
    fileWrite: groupEnabled('fileWrite'),
    mcp: value.mcp.defaultMode === 'all' || value.mcp.servers.some((server) => server.mode === 'all' || server.tools.length > 0)
  }
}

export function resolveSkillSelection(selection: SkillSelection, skills: readonly SkillSummary[], uniqueModels = false, subagent = false): ResolvedSkillSelection {
  const modelNames = new Set<string>()
  return {
    enabled: selection.enabled,
    mode: 'custom',
    project: false,
    entries: skills.filter((skill) => !skill.loadError).map((skill) => {
      const chosen = selection.mode === 'default'
        ? { shortcut: skill.userAvailable, model: skill.modelAvailable }
        : subagent && skill.source === 'project'
          ? { shortcut: false, model: selection.project }
          : selection.entries.find((entry) => entry.id === skill.id)
      const name = skill.name.toLowerCase()
      const model = selection.enabled && Boolean(chosen?.model) && (!uniqueModels || !modelNames.has(name))
      if (model) modelNames.add(name)
      return { id: skill.id, shortcut: selection.enabled && Boolean(chosen?.shortcut), model }
    })
  }
}

export function projectSkillSnapshot(snapshot: SkillSnapshot | undefined, selection: SkillSelection): SkillSnapshot | undefined {
  if (!snapshot) return undefined
  const resolved = resolveSkillSelection(selection, snapshot.skills)
  const entries = new Map(resolved.entries.map((entry) => [entry.id, entry]))
  const shortcutNames = new Set<string>()
  const modelRoots = new Map<string, string>()
  return { ...snapshot, skills: snapshot.skills.map((skill) => {
    const entry = entries.get(skill.id)
    const name = skill.name.toLowerCase()
    const result = { ...skill, userAvailable: Boolean(entry?.shortcut), modelAvailable: Boolean(entry?.model) }
    delete result.shortcut
    delete result.userShadowedBy
    delete result.modelShadowedBy
    if (result.userAvailable) {
      result.shortcut = `/${skill.name}${shortcutNames.has(name) ? `@${skill.shortcutAlias}` : ''}`
      shortcutNames.add(name)
    }
    if (result.modelAvailable) {
      const winningRoot = modelRoots.get(name)
      if (winningRoot !== undefined) result.modelShadowedBy = winningRoot
      else modelRoots.set(name, skill.rootName)
    }
    return result
  }) }
}

export function intersectCapabilities(value: ResolvedAgentCapabilities, limit: ResolvedAgentCapabilities): ResolvedAgentCapabilities {
  assertResolvedCapabilities(value)
  assertResolvedCapabilities(limit)
  const selected = value.toolMode === 'selected' ? value : limit.toolMode === 'selected' ? limit : undefined
  const other = selected === value ? limit : value
  const tools = selected
    ? selected.tools.filter((id) => toolSelected(other, id))
    : [...new Set([...(value.toolMode === 'except' ? value.tools : []), ...(limit.toolMode === 'except' ? limit.tools : [])])]
  return {
    ...value,
    profile: value.profile && limit.profile,
    environment: value.environment && limit.environment,
    workspace: value.workspace && limit.workspace,
    memory: value.memory && limit.memory,
    applicationEnvironment: value.applicationEnvironment && limit.applicationEnvironment,
    backgroundTools: value.backgroundTools && limit.backgroundTools,
    subagents: value.subagents && limit.subagents,
    planning: value.planning && limit.planning,
    toolMode: selected ? 'selected' : tools.length ? 'except' : 'all',
    tools: [...tools],
    mcp: intersectMcpSelections(value.mcp, limit.mcp),
    customTools: { project: false, entries: value.customTools.entries.filter((id) => limit.customTools.entries.includes(id)) },
    skills: {
      enabled: value.skills.enabled && limit.skills.enabled,
      mode: 'custom',
      project: false,
      entries: value.skills.entries.map((entry) => ({
        ...entry,
        shortcut: false,
        model: entry.model && limit.skills.enabled && limit.skills.entries.some((allowed) => allowed.id === entry.id && allowed.model)
      }))
    }
  }
}
