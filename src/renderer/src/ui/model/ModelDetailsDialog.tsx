import * as Dialog from '@radix-ui/react-dialog'
import { SlidersHorizontal, X } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { resolveModelListEndpoint } from '@shared/modelListEndpoint'
import { CheckboxField } from '../CheckboxField'
import { CommitTextInput } from '../CommitTextField'
import { RangeField } from '../RangeField'
import { RefreshButton } from '../RefreshButton'
import { SearchableOptionPicker } from '../SearchableOptionPicker'
import {
  SETTINGS_CONTEXT_COMPRESSION_MAX,
  SETTINGS_CONTEXT_COMPRESSION_MIN,
  SETTINGS_RANGE_STEP_FINE,
  SETTINGS_TOKEN_STEP,
  UI_ICON_SIZE_MEDIUM,
  UI_ICON_SIZE_SMALL
} from '../uiConstants'
import {
  maxModelMaxContextTokens,
  maxModelMaxOutputTokens,
  minModelMaxContextTokens
} from './modelDraft'
import type { ModelDraft } from './modelDraft'
import { ModelListUrlPopover } from './ModelListUrlPopover'
import { ModelParameterPresetsEditor } from './ModelParameterPresetsEditor'
import { ModelExtraParametersField } from './ModelExtraParametersField'

interface ModelDetailsDialogProps {
  candidates: string[]
  listLoading: boolean
  modelDraft: ModelDraft
  open: boolean
  onOpenChange(open: boolean): void
  onRefreshCandidates(): void | Promise<void>
  onUpdateDraft(update: Partial<ModelDraft>): void
  onUpdateParameters(parametersJson: string): void
}

export function ModelDetailsDialog({
  candidates,
  listLoading,
  modelDraft,
  open,
  onOpenChange,
  onRefreshCandidates,
  onUpdateDraft,
  onUpdateParameters
}: ModelDetailsDialogProps) {
  const { t } = useTranslation()
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null)
  let modelListRequestReady = false
  try {
    modelListRequestReady = Boolean(resolveModelListEndpoint(modelDraft.baseUrl, modelDraft.modelListUrl))
  } catch {
    modelListRequestReady = false
  }
  const modelListUrlAction = (
    <ModelListUrlPopover
      baseUrl={modelDraft.baseUrl}
      modelListAuth={modelDraft.modelListAuth}
      modelListUrl={modelDraft.modelListUrl}
      portalContainer={portalContainer}
      protocol={modelDraft.protocol}
      onChange={onUpdateDraft}
    />
  )

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-backdrop" />
        <Dialog.Content
          className="model-details-dialog ui-dialog ui-dialog-wide ui-dialog-centered ui-popover"
          onPointerDownOutside={(event) => event.preventDefault()}
          ref={setPortalContainer}
        >
          <header className="ui-dialog-header">
            <div className="ui-dialog-icon">
              <SlidersHorizontal size={18} />
            </div>
            <div>
              <Dialog.Title asChild>
                <h2 className="ui-dialog-title">
                  {t('settings.edit_model_title', {
                    name: modelDraft.displayName.trim() || modelDraft.model || t('settings.no_model_id')
                  })}
                </h2>
              </Dialog.Title>
              <Dialog.Description asChild>
                <p className="ui-dialog-description">{t('settings.edit_model_description')}</p>
              </Dialog.Description>
            </div>
          </header>

          <div className="model-details-dialog-content">
            <section className="model-details-group ui-surface-flat">
              <div className="ui-form-section">
                <div className="ui-grid-2">
                  <label className="ui-field-stack">
                    <span>{t('settings.model_display_name')}</span>
                    <CommitTextInput
                      placeholder={t('common.optional')}
                      value={modelDraft.displayName}
                      onCommit={(displayName) => onUpdateDraft({ displayName })}
                    />
                  </label>
                  <div className="ui-field-stack">
                    <span>{t('settings.model_id')}</span>
                    <SearchableOptionPicker
                      allowInput
                      ariaLabel={t('settings.model_id')}
                      emptyLabel={t('settings.no_model_id')}
                      footer={(
                        <div className="provider-model-picker-footer">
                          {modelListUrlAction}
                          <RefreshButton
                            iconSize={UI_ICON_SIZE_MEDIUM}
                            label={t('settings.fetch_available_models')}
                            loading={listLoading}
                            onClick={() => void onRefreshCandidates()}
                            disabled={!modelDraft.baseUrl.trim() || !modelListRequestReady}
                            showLabel
                            variant="small"
                          />
                        </div>
                      )}
                      inputCommitMode="blur"
                      inputPlaceholder={t('settings.model_id_placeholder')}
                      options={Array.from(new Set(candidates.filter(Boolean))).map((candidate) => ({
                        value: candidate,
                        label: candidate
                      }))}
                      portalContainer={portalContainer}
                      searchPlaceholder={t('settings.model_id')}
                      value={modelDraft.model}
                      onChange={(model) => onUpdateDraft({ model })}
                      onInputChange={(model) => onUpdateDraft({ model })}
                    />
                  </div>
                </div>
              </div>
            </section>
            <section className="model-details-group ui-surface-flat">
              <div className="model-capability-controls">
                <CheckboxField
                  checked={modelDraft.stream}
                  label={t('settings.stream_output')}
                  onChange={(stream) => onUpdateDraft({ stream })}
                />
                <CheckboxField
                  checked={modelDraft.capabilities.vision}
                  label={t('settings.model_capability_vision')}
                  onChange={(vision) => onUpdateDraft({
                    capabilities: { ...modelDraft.capabilities, vision }
                  })}
                />
                <CheckboxField
                  checked={modelDraft.capabilities.toolUse}
                  label={t('settings.model_capability_tool_use')}
                  onChange={(toolUse) => onUpdateDraft({
                    capabilities: { ...modelDraft.capabilities, toolUse }
                  })}
                />
              </div>
            </section>
            <section className="model-details-group ui-surface-flat">
              <div className="ui-form-section">
                <div className="model-context-controls ui-grid-3">
                  <label className="ui-field-stack">
                    <span>{t('settings.max_context_tokens')}</span>
                    <CommitTextInput
                      min={minModelMaxContextTokens}
                      max={maxModelMaxContextTokens}
                      step={SETTINGS_TOKEN_STEP}
                      type="number"
                      value={modelDraft.maxContextTokens}
                      onCommit={(maxContextTokens) => onUpdateDraft({ maxContextTokens })}
                    />
                  </label>
                  <label className="ui-field-stack">
                    <span>{t('settings.max_output_tokens')}</span>
                    <CommitTextInput
                      min={SETTINGS_TOKEN_STEP}
                      max={maxModelMaxOutputTokens}
                      normalizeDraft={(value) => value === '0' ? '' : value}
                      placeholder={t('settings.max_output_tokens_ignored')}
                      step={SETTINGS_TOKEN_STEP}
                      type="number"
                      value={modelDraft.maxOutputTokens === '0' ? '' : modelDraft.maxOutputTokens}
                      onDraftChange={(value) => {
                        if (value === '' && modelDraft.maxOutputTokens !== '0') {
                          onUpdateDraft({ maxOutputTokens: '0' })
                        }
                      }}
                      onCommit={(value) => onUpdateDraft({ maxOutputTokens: value === '' ? '0' : value })}
                    />
                  </label>
                  <div className="ui-field-stack">
                    <RangeField
                      checked={modelDraft.contextCompressionEnabled}
                      label={t('settings.context_compression_threshold', {
                        percent: Math.round(modelDraft.contextCompressionThreshold * 100)
                      })}
                      min={SETTINGS_CONTEXT_COMPRESSION_MIN}
                      max={SETTINGS_CONTEXT_COMPRESSION_MAX}
                      step={SETTINGS_RANGE_STEP_FINE}
                      value={modelDraft.contextCompressionThreshold}
                      onChange={(contextCompressionThreshold) => onUpdateDraft({ contextCompressionThreshold })}
                      onCheckedChange={(contextCompressionEnabled) => onUpdateDraft({ contextCompressionEnabled })}
                    />
                  </div>
                </div>
              </div>
            </section>
            <section className="model-details-group ui-surface-flat">
              <div className="ui-form-section">
                <ModelExtraParametersField
                  key={modelDraft.modelConfigId}
                  value={modelDraft.parametersJson}
                  protocol={modelDraft.protocol}
                  portalContainer={portalContainer}
                  onCommit={onUpdateParameters}
                  placeholder='{"temperature":0.7}'
                />
              </div>
            </section>
            <section className="model-details-group ui-surface-flat">
              <ModelParameterPresetsEditor
                draft={modelDraft}
                portalContainer={portalContainer}
                onUpdate={onUpdateDraft}
              />
            </section>
          </div>

          <footer className="model-details-dialog-footer ui-dialog-footer">
            <Dialog.Close asChild>
              <button className="ui-button" type="button">
                <X size={UI_ICON_SIZE_SMALL} />
                <span>{t('common.close')}</span>
              </button>
            </Dialog.Close>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
