import { validateSubagentSelection } from '@shared/subagentSelection'
import type {
  SubagentConfig,
  SubagentConfigSave,
  SubagentPreset
} from '@shared/types'
import type { RawSubagentConfig } from './rawAppConfig'
import { parseCapabilities, serializeCapabilities } from '@shared/agentCapabilities'

const subagentNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const presets = new Set<SubagentPreset>([
  'general-purpose',
  'web-researcher',
  'project-analyst'
])

function preset(value: unknown, path: string): SubagentPreset | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string' && presets.has(value as SubagentPreset)) {
    return value as SubagentPreset
  }
  throw new Error(`Config value ${path} has unknown preset "${String(value)}".`)
}

function requireName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!subagentNamePattern.test(name) || name.length > 64) {
    throw new Error('Subagent names must use 1-64 lowercase letters, numbers, or single hyphens.')
  }
  return name
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`Config value ${path} must be a string.`)
  return value.trim()
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Config value ${path} must be a boolean.`)
  return value
}

function requireEnabledText(value: string, field: string): void {
  if (!value) throw new Error(`Subagent ${field} must not be empty when enabled.`)
}

export function normalizeSubagent(raw: RawSubagentConfig, index: number): SubagentConfig {
  const path = `subagents[${index}]`
  const normalizedPreset = preset(raw.preset, `${path}.preset`)
  return {
    index,
    ...(raw.subagent_selection === undefined ? {} : { subagentSelection: validateSubagentSelection(raw.subagent_selection) }),
    name: requireName(raw.name),
    enabled: boolean(raw.enabled, `${path}.enabled`),
    preset: normalizedPreset,
    builtIn: normalizedPreset !== undefined,
    description: text(raw.description, `${path}.description`),
    systemPrompt: text(raw.system_prompt, `${path}.system_prompt`),
    capabilities: parseCapabilities(raw.capabilities)
  }
}

export function rawSubagentFromSave(
  subagent: SubagentConfigSave,
  existing?: RawSubagentConfig
): RawSubagentConfig {
  const name = requireName(subagent.name)
  const existingPreset = preset(existing?.preset, 'subagent.preset')
  if (existingPreset && name !== requireName(existing?.name)) {
    throw new Error('Built-in subagent names cannot be changed.')
  }
  const description = text(subagent.description, 'subagent.description')
  const systemPrompt = text(subagent.systemPrompt, 'subagent.systemPrompt')
  const enabled = boolean(subagent.enabled, 'subagent.enabled')
  if (enabled) {
    requireEnabledText(description, 'description')
    requireEnabledText(systemPrompt, 'system prompt')
  }
  return {
    ...(existingPreset ? { preset: existingPreset } : {}),
    name,
    ...(subagent.subagentSelection === undefined ? {} : { subagent_selection: validateSubagentSelection(subagent.subagentSelection) }),
    enabled,
    description,
    system_prompt: systemPrompt,
    capabilities: serializeCapabilities(subagent.capabilities)
  }
}
