import projectDefaults from '../../data/config/projects.json'
import type { SubagentConfig } from './types'

export interface SubagentSelection {
  mode: 'default' | 'custom'
  /** Global definition names; retained when switching back to defaults. */
  names: string[]
}

export function validateSubagentSelection(value: unknown): SubagentSelection {
  const selection = value as Partial<SubagentSelection> | null
  if (!selection || (selection.mode !== 'default' && selection.mode !== 'custom')
    || !Array.isArray(selection.names) || selection.names.some((name) => typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64)) {
    throw new Error('Invalid subagent selection.')
  }
  return { mode: selection.mode, names: [...new Set(selection.names)] }
}

export const defaultSubagentSelection = validateSubagentSelection(projectDefaults.subagent_selection)

export function isSubagentConfigured(definition: Pick<SubagentConfig, 'description' | 'systemPrompt'>): boolean {
  return Boolean(definition.description.trim() && definition.systemPrompt.trim())
}

/** Custom choices are explicit grants; enabled only selects the global defaults. */
export function selectedSubagents<T extends Pick<SubagentConfig, 'name' | 'enabled' | 'description' | 'systemPrompt'>>(
  definitions: readonly T[], selection = defaultSubagentSelection
): T[] {
  return definitions.filter((definition) => isSubagentConfigured(definition)
    && (selection.mode === 'default' ? definition.enabled : selection.names.includes(definition.name)))
}
