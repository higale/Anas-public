import { defaultSubagentSelection } from '@shared/subagentSelection'
import type { FormEvent } from 'react'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  McpServerConfigDetail,
  McpToolStatus,
  RuntimeToolStatus,
  SkillSnapshot,
  SubagentConfig
} from '@shared/types'
import { CheckboxField } from '../CheckboxField'
import { CommitTextInput, CommitTextarea } from '../CommitTextField'
import { UI_ICON_SIZE_SMALL, UI_TEXTAREA_ROWS_COMPACT } from '../uiConstants'
import { CapabilityEditor } from '../CapabilityEditor'
import type { SubagentDraft } from './subagentDraft'

interface SubagentEditorProps {
  customTools?: import('@shared/toolPackages').ToolPackage[]
  draft: SubagentDraft
  subagents?: readonly SubagentConfig[]
  mcpStatus: McpToolStatus | undefined
  mcpServers?: McpServerConfigDetail[]
  runtimeToolStatus: RuntimeToolStatus | undefined
  skills: SkillSnapshot | undefined
  onAutosizeInput: (event: FormEvent<HTMLTextAreaElement>) => void
  onRestore: () => void
  onUpdate: (update: Partial<SubagentDraft>) => void
}

export function SubagentEditor({
  customTools,
  draft,
  subagents = [],
  mcpStatus,
  mcpServers,
  runtimeToolStatus,
  skills,
  onAutosizeInput,
  onRestore,
  onUpdate
}: SubagentEditorProps) {
  const { t } = useTranslation()
  return (
    <div className="ui-editor settings-subagent-editor">
      <div className="ui-toolbar ui-toolbar-between">
        <CheckboxField
          checked={draft.enabled}
          label={t('settings.subagent_default_enabled')}
          onChange={(enabled) => onUpdate({ enabled })}
        />
        {draft.builtIn && (
          <button
            className="ui-button ui-button-compact"
            type="button"
            onClick={onRestore}
          >
            <RefreshCw size={UI_ICON_SIZE_SMALL} />
            <span>{t('settings.restore_default')}</span>
          </button>
        )}
      </div>

      <div className="ui-form-section">
        <label className="ui-field-stack">
          <span>{t('settings.subagent_identifier')}</span>
          <CommitTextInput
            disabled={draft.builtIn}
            value={draft.name}
            onCommit={(name) => onUpdate({ name: name.trim() })}
          />
          <small>{t('settings.subagent_identifier_hint')}</small>
        </label>
        <label className="ui-field-stack">
          <span>{t('settings.subagent_selection_description')}</span>
          <CommitTextarea
            className="ui-autosize-textarea ui-code-textarea"
            data-max-height="none"
            rows={UI_TEXTAREA_ROWS_COMPACT}
            value={draft.description}
            onInput={onAutosizeInput}
            onCommit={(description) => onUpdate({ description })}
          />
          <small>{t('settings.subagent_selection_description_hint')}</small>
        </label>
        <label className="ui-field-stack">
          <span>{t('settings.subagent_system_prompt')}</span>
          <CommitTextarea
            className="ui-autosize-textarea ui-code-textarea"
            data-max-height="none"
            rows={5}
            value={draft.systemPrompt}
            onInput={onAutosizeInput}
            onCommit={(systemPrompt) => onUpdate({ systemPrompt })}
          />
        </label>
      </div>

      <CapabilityEditor customTools={customTools} value={draft.capabilities} subagent skills={skills} mcpStatus={mcpStatus} mcpServers={mcpServers} runtimeToolStatus={runtimeToolStatus}
        subagentSelection={{ value: draft.subagentSelection ?? defaultSubagentSelection, definitions: subagents,
          onChange: (subagentSelection) => onUpdate({ subagentSelection }) }}
        onEnableAll={(capabilities) => onUpdate({ capabilities, subagentSelection: { ...(draft.subagentSelection ?? defaultSubagentSelection), mode: 'default' } })}
        onChange={(capabilities) => onUpdate({ capabilities })} />
    </div>
  )
}
