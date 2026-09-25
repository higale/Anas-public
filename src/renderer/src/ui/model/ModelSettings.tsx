import type { RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppConfigSnapshot, ModelProviderConfigDetail } from '@shared/types'
import { ModelEditor } from './ModelEditor'
import { ModelListPane } from './ModelListPane'
import type { ModelDraft } from './modelDraft'

interface ModelSettingsProps {
  candidates: string[]
  config: AppConfigSnapshot | undefined
  editingModelIndex?: number
  editingProvider?: ModelProviderConfigDetail
  editingProviderModelIndex?: number
  listLoading: boolean
  listRef: RefObject<HTMLDivElement | null>
  modelDraft: ModelDraft
  sectionClass: string
  onCreateModel: (templateId?: string) => void | Promise<void>
  onAddProviderModel: () => boolean | void | Promise<boolean | void>
  onAddProviderModels: (models: string[]) => boolean | void | Promise<boolean | void>
  onDeleteProviderModel: () => boolean | void | Promise<boolean | void>
  onDeleteModel: () => void | Promise<void>
  onEditModel: (index: number) => void | Promise<void>
  onMoveModel: (direction: -1 | 1) => void | Promise<void>
  onMoveProviderModel: (direction: -1 | 1) => void | Promise<void>
  onSelectProviderModel: (index: number) => boolean | void | Promise<boolean | void>
  onRefreshCandidates: () => void | Promise<void>
  onUpdateDraft: (update: Partial<ModelDraft>) => void
  onUpdateParameters: (parametersJson: string) => void
}

export function ModelSettings({
  candidates,
  config,
  editingModelIndex,
  editingProvider,
  editingProviderModelIndex,
  listLoading,
  listRef,
  modelDraft,
  sectionClass,
  onCreateModel,
  onAddProviderModel,
  onAddProviderModels,
  onDeleteProviderModel,
  onDeleteModel,
  onEditModel,
  onMoveModel,
  onMoveProviderModel,
  onSelectProviderModel,
  onRefreshCandidates,
  onUpdateDraft,
  onUpdateParameters
}: ModelSettingsProps) {
  const { t } = useTranslation()

  return (
    <section className={sectionClass}>
      <ModelListPane
        config={config}
        editingModelIndex={editingModelIndex}
        listRef={listRef}
        onCreateModel={onCreateModel}
        onDeleteModel={onDeleteModel}
        onEditModel={onEditModel}
        onMoveModel={onMoveModel}
      />
      {editingProvider
        ? (
            <ModelEditor
              key={editingProvider.id}
              candidates={candidates}
              provider={editingProvider}
              selectedModelIndex={editingProviderModelIndex}
              listLoading={listLoading}
              modelDraft={modelDraft}
              onAddProviderModel={onAddProviderModel}
              onAddProviderModels={onAddProviderModels}
              onDeleteProviderModel={onDeleteProviderModel}
              onMoveProviderModel={onMoveProviderModel}
              onSelectProviderModel={onSelectProviderModel}
              onRefreshCandidates={onRefreshCandidates}
              onUpdateDraft={onUpdateDraft}
              onUpdateParameters={onUpdateParameters}
            />
          )
        : (
            <div className="ui-editor-empty ui-editor">
              {config && <div className="ui-empty-state">{t('settings.add_provider_to_configure')}</div>}
            </div>
          )}
    </section>
  )
}
