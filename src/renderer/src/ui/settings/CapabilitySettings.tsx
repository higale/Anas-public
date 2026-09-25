import { useTranslation } from 'react-i18next'
import type { DefaultCapabilitySettings } from '@shared/agentCapabilities'
import type { AppConfigSnapshot, McpToolStatus, RuntimeToolStatus, SkillSnapshot } from '@shared/types'
import { CapabilityEditor } from '../CapabilityEditor'
import { CheckboxField } from '../CheckboxField'

interface Props {
  config: Pick<AppConfigSnapshot, 'defaultCapabilities' | 'subagents' | 'mcpServers' | 'customTools'>
  pending?: DefaultCapabilitySettings
  skills?: SkillSnapshot
  mcpStatus?: McpToolStatus
  runtimeToolStatus?: RuntimeToolStatus
  onSave: (value: DefaultCapabilitySettings) => void | Promise<void>
}

export function CapabilitySettings({ config, pending, skills, mcpStatus, runtimeToolStatus, onSave }: Props) {
  const { t } = useTranslation()
  const value = pending ?? config.defaultCapabilities
  const saving = pending !== undefined
  function save(update: Partial<DefaultCapabilitySettings>) {
    void onSave({ ...value, ...update })
  }
  return (
    <CapabilityEditor customTools={config.customTools} value={value.capabilities} skills={skills} mcpStatus={mcpStatus}
      mcpServers={config.mcpServers} runtimeToolStatus={runtimeToolStatus} disabled={saving}
      subagentSelection={{ value: value.subagentSelection, definitions: config.subagents,
        onChange: (subagentSelection) => void save({ subagentSelection }) }}
      toolbarEnd={<CheckboxField className="ui-checkbox-field-inline" checked={value.restrictSubagents}
        disabled={saving} label={t('capabilities.restrict_subagents')} tooltip={t('capabilities.restrict_subagents_hint')}
        onChange={(restrictSubagents) => void save({ restrictSubagents })} />}
      onEnableAll={(capabilities) => void save({ capabilities, restrictSubagents: false,
        subagentSelection: { ...value.subagentSelection, mode: 'default' } })}
      onChange={(capabilities) => void save({ capabilities })} />
  )
}
