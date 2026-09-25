import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Plus } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { addModelExtraParameter, modelExtraParameterGroups, modelExtraParameterStatus } from '@shared/modelExtraParameterTemplates'
import type { ModelExtraParameterTemplate } from '@shared/modelExtraParameterTemplates'
import type { ModelProtocol } from '@shared/types'
import { CommitTextarea } from '../CommitTextField'
import { DropdownMenuContent, DropdownMenuRoot, DropdownMenuTrigger } from '../DropdownMenuShell'
import { UI_ICON_SIZE_SMALL, UI_TEXTAREA_ROWS_COMPACT } from '../uiConstants'
import { parseModelParametersJson } from './modelDraft'

interface ModelExtraParametersFieldProps {
  value: string
  protocol: ModelProtocol
  placeholder: string
  portalContainer?: HTMLElement | null
  onCommit(value: string): void
}

export function ModelExtraParametersField({ value, protocol, placeholder, portalContainer, onCommit }: ModelExtraParametersFieldProps) {
  const { t } = useTranslation()
  const inputId = useId()
  const [draft, setDraft] = useState(value)
  const [open, setOpen] = useState(false)
  useEffect(() => setDraft(value), [value])
  const parameters = open ? parseModelParametersJson(draft) : undefined

  function addParameter(template: ModelExtraParameterTemplate): void {
    const current = parseModelParametersJson(draft)
    if (!current || modelExtraParameterStatus(current, template.path) !== 'missing') return
    const next = JSON.stringify(addModelExtraParameter(current, template), null, 2)
    setDraft(next)
    onCommit(next)
  }

  return (
    <div className="ui-field-stack">
      <div className="ui-row">
        <label className="ui-field-label" htmlFor={inputId}>{t('settings.extra_parameters')}</label>
        <DropdownMenuRoot open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger asChild>
            <button className="ui-tool-button ui-tool-button-small" type="button" aria-label={t('settings.add_extra_parameter')} data-tooltip={t('settings.add_extra_parameter')}>
              <Plus size={UI_ICON_SIZE_SMALL} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenu.Portal container={portalContainer ?? undefined}>
            <DropdownMenuContent className="ui-menu ui-menu-list ui-menu-detailed" align="start" collisionPadding={10} sideOffset={5}>
              <DropdownMenu.Label className="ui-menu-description">
                {t('settings.extra_parameter_templates_hint')}
              </DropdownMenu.Label>
              {!parameters && <div className="ui-menu-description ui-status-danger" role="alert">{t('settings.model_parameters_invalid_json')}</div>}
              {modelExtraParameterGroups[protocol].map((group, groupIndex) => (
                <DropdownMenu.Group key={group.label}>
                  <DropdownMenu.Label className="ui-menu-description">{group.label}</DropdownMenu.Label>
                  {group.parameters.map((template, templateIndex) => {
                    const name = template.path.join('.')
                    const itemId = `${inputId}-${groupIndex}-${templateIndex}`
                    const status = parameters ? modelExtraParameterStatus(parameters, template.path) : undefined
                    return (
                      <DropdownMenu.Item
                        key={name}
                        className="ui-menu-item ui-menu-item-row"
                        aria-labelledby={`${itemId}-name`}
                        aria-describedby={`${itemId}-description ${itemId}-example${status === 'present' || status === 'conflict' ? ` ${itemId}-state` : ''}`}
                        textValue={name}
                        disabled={status !== 'missing'}
                        onSelect={() => addParameter(template)}
                      >
                        <span className="ui-copy-stack">
                          <span className="ui-row">
                            <span id={`${itemId}-name`}>{name}</span>
                            {status === 'present' && <span id={`${itemId}-state`} className="ui-badge">{t('settings.model_already_added')}</span>}
                            {status === 'conflict' && <span id={`${itemId}-state`} className="ui-badge">{t('settings.parameter_structure_conflict')}</span>}
                          </span>
                          <small id={`${itemId}-description`}>{t(template.description)}{template.range && ` · ${t('settings.parameter_range', { range: template.range })}`}</small>
                          <small id={`${itemId}-example`}>{t('settings.parameter_example', { value: JSON.stringify(template.example) })}{template.note && ` · ${t(template.note)}`}</small>
                        </span>
                      </DropdownMenu.Item>
                    )
                  })}
                </DropdownMenu.Group>
              ))}
            </DropdownMenuContent>
          </DropdownMenu.Portal>
        </DropdownMenuRoot>
      </div>
      <CommitTextarea
        id={inputId}
        aria-label={t('settings.extra_parameters')}
        className="ui-autosize-textarea ui-code-textarea"
        data-max-height="none"
        value={value}
        onDraftChange={setDraft}
        onCommit={onCommit}
        placeholder={placeholder}
        rows={UI_TEXTAREA_ROWS_COMPACT}
      />
    </div>
  )
}
