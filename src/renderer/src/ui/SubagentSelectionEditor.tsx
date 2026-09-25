import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SubagentConfig } from '@shared/types'
import { isSubagentConfigured, selectedSubagents, type SubagentSelection } from '@shared/subagentSelection'
import { CheckboxField } from './CheckboxField'
import { SearchableOptionPicker } from './SearchableOptionPicker'

export interface SubagentSelectionProps {
  value: SubagentSelection
  definitions: readonly Pick<SubagentConfig, 'name' | 'description' | 'systemPrompt' | 'enabled'>[]
  onChange(value: SubagentSelection): void
}

export function SubagentSelectionEditor({ value, definitions, onChange, enabled, onEnable, disabled }: SubagentSelectionProps & {
  enabled: boolean
  onEnable(enabled: boolean): void
  disabled: boolean
}) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')
  const items = [
    ...definitions.map((definition) => ({ ...definition, status: isSubagentConfigured(definition) ? undefined : 'capabilities.subagent_incomplete' })),
    ...value.names.filter((name) => !definitions.some((definition) => definition.name === name))
      .map((name) => ({ name, description: '', status: 'capabilities.deleted' }))
  ]
  const selected = new Set(value.names)
  const count = selectedSubagents(definitions, value).length
  const search = query.trim().toLocaleLowerCase()
  const visible = items.filter((item) => `${item.name} ${item.description}`.toLocaleLowerCase().includes(search))
  return <div className="ui-form-section ui-form-section-divided">
    <div className="ui-form-row ui-form-row-inline">
      <div className="ui-row">
        <CheckboxField className="ui-checkbox-field-inline" checked={enabled} disabled={disabled}
          label={t('settings.capability_subagents')} onChange={onEnable} />
        <small>{count}</small>
      </div>
      <SearchableOptionPicker className="compact" ariaLabel={t('capabilities.subagent_selection')}
        disabled={disabled || !enabled} searchable={false} emptyLabel={t('settings.no_options')}
        value={value.mode} options={[
          { value: 'default', label: t('capabilities.default') },
          { value: 'custom', label: t('capabilities.custom') }
        ]} onChange={(mode) => onChange({ ...value, mode: mode as SubagentSelection['mode'] })} />
    </div>
    {value.mode === 'custom' && <fieldset className="ui-capability-editor" disabled={disabled || !enabled}>
      <input className="ui-input" type="search" aria-label={t('capabilities.search_subagents')}
        placeholder={t('capabilities.search_subagents')} value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="ui-capability-list">
        {visible.map((item) => <CheckboxField key={item.name} className="ui-checkbox-field-inline"
          checked={selected.has(item.name)} aria-label={item.name} tooltip={item.description || undefined}
          label={<span className="ui-row"><code>{item.name}</code>{item.status && <span className="ui-badge">{t(item.status)}</span>}</span>}
          onChange={(checked) => onChange({ ...value, names: checked ? [...value.names, item.name] : value.names.filter((name) => name !== item.name) })} />)}
        {!visible.length && <small>{t('settings.no_options')}</small>}
      </div>
    </fieldset>}
  </div>
}
