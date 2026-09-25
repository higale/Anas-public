import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ModelProviderConfigDetail } from '@shared/types'
import { CommitTextInput } from '../CommitTextField'
import { SearchableOptionPicker } from '../SearchableOptionPicker'
import { ModelDetailsDialog } from './ModelDetailsDialog'
import { ModelExtraParametersField } from './ModelExtraParametersField'
import type { ModelDraft } from './modelDraft'
import { providerProtocolLabels } from './providerProtocol'
import { ProviderModelAddDialog } from './ProviderModelAddDialog'
import { ProviderModelList } from './ProviderModelList'

interface ModelEditorProps {
  candidates: string[]
  listLoading: boolean
  modelDraft: ModelDraft
  provider?: ModelProviderConfigDetail
  selectedModelIndex?: number
  onAddProviderModel?: () => boolean | void | Promise<boolean | void>
  onAddProviderModels?: (models: string[]) => boolean | void | Promise<boolean | void>
  onDeleteProviderModel?: () => boolean | void | Promise<boolean | void>
  onMoveProviderModel?: (direction: -1 | 1) => void | Promise<void>
  onSelectProviderModel?: (index: number) => boolean | void | Promise<boolean | void>
  onRefreshCandidates: () => void | Promise<void>
  onUpdateDraft: (update: Partial<ModelDraft>) => void
  onUpdateParameters: (parametersJson: string) => void
}

export function ModelEditor({
  candidates,
  listLoading,
  modelDraft,
  provider,
  selectedModelIndex,
  onAddProviderModel,
  onAddProviderModels,
  onDeleteProviderModel,
  onMoveProviderModel,
  onSelectProviderModel,
  onRefreshCandidates,
  onUpdateDraft,
  onUpdateParameters
}: ModelEditorProps) {
  const { t } = useTranslation()
  const [apiKeyFocused, setApiKeyFocused] = useState(false)
  const [modelAddOpen, setModelAddOpen] = useState(false)
  const [modelDetailsOpen, setModelDetailsOpen] = useState(false)
  const providerOptions = [
    { value: 'openai_responses', label: providerProtocolLabels.openai_responses },
    { value: 'openai_chat_completions', label: providerProtocolLabels.openai_chat_completions },
    { value: 'anthropic_messages', label: providerProtocolLabels.anthropic_messages }
  ]

  async function addProviderModel(): Promise<boolean> {
    if (!onAddProviderModel) return false
    const added = await onAddProviderModel()
    if (added === false) return false
    setModelDetailsOpen(true)
    return true
  }

  function openModelAddDialog(): void {
    setModelAddOpen(true)
    if (candidates.length === 0 && !listLoading) void onRefreshCandidates()
  }

  async function selectProviderModel(index: number): Promise<void> {
    if (index !== selectedModelIndex) await onSelectProviderModel?.(index)
  }

  async function editProviderModel(index: number): Promise<void> {
    if (index !== selectedModelIndex) {
      const selected = await onSelectProviderModel?.(index)
      if (selected === false) return
    }
    setModelDetailsOpen(true)
  }

  return (
    <div className="ui-editor">
      <div className="ui-form-section" data-settings-group="provider">
        <div className="ui-grid-2">
          <label className="ui-field-stack">
            <span>{t('settings.name')}</span>
            <CommitTextInput value={modelDraft.name} onCommit={(name) => onUpdateDraft({ name })} />
          </label>
          <div className="ui-field-stack">
            <span>{t('settings.provider')}</span>
            <SearchableOptionPicker
              ariaLabel={t('settings.provider')}
              emptyLabel={t('settings.no_options')}
              options={providerOptions}
              searchable={false}
              value={modelDraft.protocol}
              onChange={(protocol) => onUpdateDraft({ protocol: protocol as ModelDraft['protocol'] })}
            />
          </div>
        </div>
        <label className="ui-field-stack">
          <span>{t('settings.base_url')}</span>
          <CommitTextInput
            value={modelDraft.baseUrl}
            onCommit={(baseUrl) => onUpdateDraft({ baseUrl })}
            placeholder="https://..."
          />
        </label>
        <label className="ui-field-stack">
          <span>{t('settings.api_key')}</span>
          <CommitTextInput
            value={modelDraft.apiKey}
            onBlur={() => setApiKeyFocused(false)}
            onCommit={(apiKey) => onUpdateDraft({ apiKey })}
            onFocus={() => setApiKeyFocused(true)}
            placeholder={t('common.optional')}
            type={apiKeyFocused ? 'text' : 'password'}
          />
        </label>
        <ModelExtraParametersField
          key={modelDraft.providerId}
          value={modelDraft.providerParametersJson}
          protocol={modelDraft.protocol}
          onCommit={(providerParametersJson) => onUpdateDraft({ providerParametersJson })}
          placeholder='{"reasoning_split":true}'
        />
      </div>

      <div className="ui-form-section ui-form-section-divided" data-settings-group="models">
        {provider && (
          <ProviderModelList
            provider={provider}
            selectedIndex={selectedModelIndex}
            onAdd={openModelAddDialog}
            onDelete={() => void onDeleteProviderModel?.()}
            onEdit={editProviderModel}
            onMove={onMoveProviderModel ?? (() => undefined)}
            onModelListSettingsChange={onUpdateDraft}
            onSelect={selectProviderModel}
          />
        )}
      </div>

      {provider && (
        <>
          <ProviderModelAddDialog
            baseUrl={modelDraft.baseUrl}
            candidates={candidates}
            configuredModelIds={provider.models.map((model) => model.model)}
            listLoading={listLoading}
            modelListAuth={modelDraft.modelListAuth}
            modelListUrl={modelDraft.modelListUrl}
            open={modelAddOpen}
            protocol={modelDraft.protocol}
            onAddBlank={addProviderModel}
            onAddSelected={onAddProviderModels ?? (() => false)}
            onModelListSettingsChange={onUpdateDraft}
            onOpenChange={setModelAddOpen}
            onRefreshCandidates={onRefreshCandidates}
          />
          <ModelDetailsDialog
            candidates={candidates}
            listLoading={listLoading}
            modelDraft={modelDraft}
            open={modelDetailsOpen}
            onOpenChange={setModelDetailsOpen}
            onRefreshCandidates={onRefreshCandidates}
            onUpdateDraft={onUpdateDraft}
            onUpdateParameters={onUpdateParameters}
          />
        </>
      )}
    </div>
  )
}
