import type { CustomToolDefinition } from './customTools'

export interface ToolSelection {
  project: boolean
  entries: string[]
}

export interface ResolvedToolSelection extends ToolSelection { project: false }

export interface ToolRoot {
  id: string
  name: string
  path: string
  source: 'user' | 'project'
  error?: string
}

export interface ToolPackage {
  id: string
  name: string
  description: string
  rootId: string
  rootName: string
  source: ToolRoot['source']
  directory: string
  definition?: CustomToolDefinition
  error?: string
  shadowedBy?: string
}

export interface ToolSnapshot { roots: ToolRoot[]; tools: ToolPackage[] }
export interface ToolImportError {
  code: 'invalid_directory' | 'invalid_tool' | 'already_exists' | 'duplicate_id' | 'too_large' | 'too_many_tools' | 'failed'
  name?: string
  detail?: string
}
export interface ToolSettings {
  order: string[]
}

export function validateToolSelection(value: unknown): ToolSelection {
  const v = value as ToolSelection | undefined
  if (!v || typeof v.project !== 'boolean' || !Array.isArray(v.entries)
    || v.entries.some(id => typeof id !== 'string' || !id.trim())) throw new Error('Invalid custom tool selection.')
  return { project: v.project, entries: [...new Set(v.entries)] }
}

export function normalizeToolSettings(value: unknown): ToolSettings {
  const v = value as ToolSettings | undefined
  if (!v || !Array.isArray(v.order) || v.order.length > 10000 || v.order.some(x => typeof x !== 'string' || !x)) throw new Error('Invalid tool settings.')
  return { order: [...new Set(v.order)] }
}

export function setAllCustomTools(selection: ToolSelection, tools: readonly ToolPackage[], subagent: boolean, checked: boolean): ToolSelection {
  return { project: subagent && checked, entries: checked
    ? [...new Set([...selection.entries, ...tools.filter(tool => !subagent || tool.source !== 'project').map(tool => tool.id)])] : [] }
}

/** Catalog order is source precedence, then the source's user-defined order. */
export function resolveToolSelection(selection: ToolSelection, tools: readonly ToolPackage[], subagent = false, unique = true): ResolvedToolSelection {
  const names = new Set<string>()
  const entries = tools.filter(tool => {
    const enabled = !tool.error && tool.definition && (subagent && tool.source === 'project'
      ? selection.project : selection.entries.includes(tool.id))
    if (!enabled || (unique && names.has(tool.name.toLowerCase()))) return false
    names.add(tool.name.toLowerCase())
    return true
  }).map(tool => tool.id)
  return { project: false, entries }
}

export function withToolShadows(tools: readonly ToolPackage[], selected: readonly string[]): ToolPackage[] {
  const winners = new Map<string, string>()
  return tools.map(tool => {
    const { shadowedBy: _shadow, ...item } = tool
    if (!tool.definition || tool.error || !selected.includes(tool.id)) return item
    const name = tool.name.toLowerCase()
    const winner = winners.get(name)
    if (!winner) winners.set(name, tool.rootName)
    return { ...item, ...(winner ? { shadowedBy: winner } : {}) }
  })
}
