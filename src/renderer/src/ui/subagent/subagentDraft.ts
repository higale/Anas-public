import type { TFunction } from 'i18next'
import { defaultSubagentConfig } from '@shared/subagentConfig'
import type {
  AppConfigSnapshot,
  SubagentConfig,
  SubagentConfigSave
} from '@shared/types'

export type SubagentDraft = Omit<SubagentConfig, 'index'> & {
  index?: number
}

export function subagentToDraft(subagent: SubagentConfig): SubagentDraft {
  return structuredClone(subagent)
}

function nextSubagentName(subagents: AppConfigSnapshot['subagents'] | undefined): string {
  const names = new Set((subagents ?? []).map((subagent) => subagent.name))
  let index = 1
  while (names.has(`custom-agent-${index}`)) index += 1
  return `custom-agent-${index}`
}

export function createSubagentDraft(
  config: AppConfigSnapshot | undefined,
  t: TFunction
): SubagentDraft {
  return {
    name: nextSubagentName(config?.subagents),
    enabled: defaultSubagentConfig.enabled,
    subagentSelection: structuredClone(defaultSubagentConfig.subagentSelection),
    builtIn: false,
    description: t('settings.subagent_new_description'),
    systemPrompt: t('settings.subagent_new_prompt'),
    capabilities: structuredClone(defaultSubagentConfig.capabilities)
  }
}

export function subagentSavePayload(draft: SubagentDraft): SubagentConfigSave {
  return {
    index: draft.index,
    name: draft.name.trim(),
    enabled: draft.enabled,
    ...(draft.subagentSelection === undefined ? {} : { subagentSelection: structuredClone(draft.subagentSelection) }),
    description: draft.description.trim(),
    systemPrompt: draft.systemPrompt.trim(),
    capabilities: structuredClone(draft.capabilities)
  }
}

export function validateSubagentName(
  draft: SubagentDraft,
  subagents: AppConfigSnapshot['subagents'] | undefined,
  t: TFunction
): string | undefined {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(draft.name) || draft.name.length > 64) {
    return t('settings.subagent_name_invalid')
  }
  if (subagents?.some((subagent) =>
    subagent.index !== draft.index && subagent.name === draft.name
  )) {
    return t('settings.subagent_name_duplicate')
  }
  return undefined
}

export function validateSubagentForEnable(
  draft: SubagentDraft,
  t: TFunction
): string | undefined {
  if (!draft.description.trim()) return t('settings.subagent_description_required')
  if (!draft.systemPrompt.trim()) return t('settings.subagent_prompt_required')
  return undefined
}
