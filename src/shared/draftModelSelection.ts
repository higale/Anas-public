import { findProviderModelConfig, isSelectableModelConfig } from './modelConfig'
import type { ModelProviderConfig, NewThreadModelSelection, ProjectModelSelection, ProviderModelConfig } from './types'

type DraftModelCandidate = Pick<
  ProviderModelConfig,
  'id' | 'defaultParameterPresetId' | 'model'
> & { baseUrl: string }

interface DraftModelDefaultsSource {
  settings: { newThreadModelSelection: NewThreadModelSelection }
  defaultModel?: DraftModelCandidate
  providers?: Array<{
    baseUrl: string
    models: Array<Pick<ProviderModelConfig, 'id' | 'defaultParameterPresetId' | 'model'>>
  }>
}

export interface DraftModelSelection {
  modelConfigId: string | undefined
  modelParameterPresetId: string | null
  parameterPresetSource: 'model-default' | 'explicit'
}

export function projectDraftModelSelection(
  providers: ModelProviderConfig[] | undefined,
  project: ProjectModelSelection | undefined
): DraftModelSelection | undefined {
  const model = findProviderModelConfig(providers ?? [], project?.modelConfigId)
  if (!model || !isSelectableModelConfig(model)) return undefined
  return reconcileDraftModelSelection(model, {
    modelConfigId: model.id,
    modelParameterPresetId: project?.modelParameterPresetId ?? null,
    parameterPresetSource: project?.modelParameterPresetId === undefined ? 'model-default' : 'explicit'
  })
}

export function newThreadDraftModelSelection(
  config: DraftModelDefaultsSource | undefined,
  currentModel?: DraftModelCandidate,
  currentModelParameterPresetId: string | null = null,
  projectSelection?: DraftModelSelection
): DraftModelSelection {
  if (projectSelection) return projectSelection
  const selection = config?.settings.newThreadModelSelection
  const selectableCurrent = currentModel && isSelectableModelConfig(currentModel)
    ? { model: currentModel, source: 'current' as const }
    : undefined
  const selectableDefault = config?.defaultModel && isSelectableModelConfig(config.defaultModel)
    ? { model: config.defaultModel, source: 'model-default' as const }
    : undefined
  const firstSelectable = config?.providers?.flatMap((provider) => (
    provider.models.map((model) => ({ ...model, baseUrl: provider.baseUrl }))
  )).find(isSelectableModelConfig)
  const firstProviderModel = firstSelectable
    ? { model: firstSelectable, source: 'model-default' as const }
    : undefined
  const requested = selection === 'current'
    ? selectableCurrent
    : selection === 'default'
      ? selectableDefault
      : undefined
  const resolved = selection === 'prompt'
    ? undefined
    : requested ?? selectableCurrent ?? selectableDefault ?? firstProviderModel
  const model = resolved?.model
  const usesCurrentSelection = resolved?.source === 'current'
  return {
    modelConfigId: model?.id,
    modelParameterPresetId: usesCurrentSelection
      ? currentModelParameterPresetId
      : model?.defaultParameterPresetId ?? null,
    parameterPresetSource: usesCurrentSelection ? 'explicit' : 'model-default'
  }
}

export function reconcileDraftModelSelection(
  model: Pick<ProviderModelConfig, 'defaultParameterPresetId' | 'parameterPresets'> | undefined,
  selection: DraftModelSelection
): DraftModelSelection {
  const defaultId = model?.defaultParameterPresetId ?? null
  if (selection.parameterPresetSource === 'model-default') {
    return selection.modelParameterPresetId === defaultId
      ? selection
      : { ...selection, modelParameterPresetId: defaultId }
  }
  if (selection.modelParameterPresetId === null) return selection
  if (model?.parameterPresets?.some((preset) => preset.id === selection.modelParameterPresetId)) {
    return selection
  }
  return {
    ...selection,
    modelParameterPresetId: defaultId,
    parameterPresetSource: 'model-default'
  }
}
