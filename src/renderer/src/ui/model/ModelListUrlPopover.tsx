import { PopoverContent } from '../PopoverContent'
import * as Popover from '@radix-ui/react-popover'
import { Link2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ModelListAuth, ModelProtocol } from '@shared/types'
import { resolveModelListEndpoint } from '@shared/modelListEndpoint'
import { findModelTemplate } from '@shared/modelTemplates'
import { CommitTextInput } from '../CommitTextField'
import { SearchableOptionPicker } from '../SearchableOptionPicker'
import { UI_ICON_SIZE_MEDIUM } from '../uiConstants'

export interface ModelListSettingsUpdate {
  modelListAuth: ModelListAuth
  modelListUrl: string
}

interface ModelListUrlPopoverProps {
  baseUrl: string
  modelListAuth: ModelListAuth
  modelListUrl: string
  portalContainer?: HTMLElement | null
  protocol: ModelProtocol
  onChange(update: ModelListSettingsUpdate): void
}

export function ModelListUrlPopover({
  baseUrl,
  modelListAuth,
  modelListUrl,
  portalContainer,
  protocol,
  onChange
}: ModelListUrlPopoverProps) {
  const { t } = useTranslation()
  const matchingTemplate = findModelTemplate(protocol, baseUrl)
  const resetModelListUrl = matchingTemplate?.modelListUrl ?? ''
  const resetModelListAuth = matchingTemplate?.modelListAuth ?? 'bearer'
  const modelListAuthOptions = [
    { value: 'bearer', label: t('settings.model_list_auth_bearer') },
    { value: 'anthropic', label: t('settings.model_list_auth_anthropic') }
  ]
  let effectiveModelListUrl = ''
  let modelListUrlInvalid = false
  try {
    effectiveModelListUrl = resolveModelListEndpoint(baseUrl, modelListUrl)
  } catch {
    modelListUrlInvalid = true
  }
  const tooltip = modelListUrlInvalid
    ? t('settings.model_list_url_invalid')
    : modelListUrl.trim()
      ? t('settings.model_list_url_value', { url: effectiveModelListUrl })
      : effectiveModelListUrl
        ? t('settings.model_list_url_default', { url: effectiveModelListUrl })
        : t('settings.model_list_url_unconfigured')

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          aria-label={t('settings.edit_model_list_settings')}
          className="model-list-url-inline-trigger"
          data-tooltip={tooltip}
          type="button"
        >
          <Link2 size={UI_ICON_SIZE_MEDIUM} />
        </button>
      </Popover.Trigger>
      <Popover.Portal container={portalContainer ?? undefined}>
        <PopoverContent
          align="start"
          className="model-list-url-popover ui-popover"
          collisionPadding={10}
          sideOffset={5}
        >
          <label className="ui-field-stack">
            <span>{t('settings.model_list_url')}</span>
            <CommitTextInput
              aria-label={t('settings.model_list_url')}
              onCommit={(nextModelListUrl) => onChange({
                modelListAuth,
                modelListUrl: nextModelListUrl
              })}
              placeholder="{base_url}/models"
              value={modelListUrl}
            />
          </label>
          <small className="ui-field-hint">{t('settings.model_list_url_placeholders')}</small>
          <small className={modelListUrlInvalid ? 'ui-field-hint ui-status-danger' : 'ui-field-hint'}>
            {modelListUrlInvalid
              ? t('settings.model_list_url_invalid')
              : t('settings.model_list_url_resolved', {
                  url: effectiveModelListUrl || t('settings.model_list_url_unconfigured')
                })}
          </small>
          <div className="ui-field-stack">
            <span>{t('settings.model_list_auth')}</span>
            <SearchableOptionPicker
              ariaLabel={t('settings.model_list_auth')}
              emptyLabel={t('settings.no_options')}
              options={modelListAuthOptions}
              portalContainer={portalContainer}
              searchable={false}
              value={modelListAuth}
              onChange={(nextModelListAuth) => onChange({
                modelListAuth: nextModelListAuth as ModelListAuth,
                modelListUrl
              })}
            />
          </div>
          <small className="ui-field-hint">{t('settings.model_list_auth_hint')}</small>
          {matchingTemplate && (
            <button
              className="ui-button"
              disabled={modelListUrl.trim() === resetModelListUrl && modelListAuth === resetModelListAuth}
              onClick={() => onChange({
                modelListAuth: resetModelListAuth,
                modelListUrl: resetModelListUrl
              })}
              type="button"
            >
              {t('settings.restore_template_model_list_settings')}
            </button>
          )}
        </PopoverContent>
      </Popover.Portal>
    </Popover.Root>
  )
}
