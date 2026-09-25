import rawSubagentsConfig from '../../data/config/subagents.json'
import { validateSubagentSelection } from './subagentSelection'
import { parseCapabilities } from './agentCapabilities'
import type { SubagentDefaults } from './types'

export const defaultSubagentConfig: SubagentDefaults = {
  subagentSelection: validateSubagentSelection(rawSubagentsConfig.subagent_defaults.subagent_selection),
  enabled: rawSubagentsConfig.subagent_defaults.enabled,
  capabilities: parseCapabilities(rawSubagentsConfig.subagent_defaults.capabilities)
}
