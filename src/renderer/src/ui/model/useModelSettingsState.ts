import { useEffect, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import type { AppConfigSnapshot, ModelProviderConfigDetail } from '@shared/types'
import { getModelTemplate } from '@shared/modelTemplates'
import type { ConfirmDialogRequest } from '../dialogs/AppDialogs'
import { notice } from '../notice'
import type { SettingsTab } from '../settings/settingsTabs'
import { useQueuedAutosave } from '../useQueuedAutosave'
import {
  buildProviderModelPayload,
  buildProviderPayload,
  emptyModelDraft,
  modelConfigToDraft,
  modelTemplateToDraft,
  providerConfigToDraft,
  validateModelProviderDraft,
  validateProviderModelDraft
} from './modelDraft'
import type { ModelDraft } from './modelDraft'
import { useCachedModelCandidates } from './useCachedModelCandidates'
import { useModelCandidateRefresh } from './useModelCandidateRefresh'

interface UseModelSettingsStateOptions {
  config: AppConfigSnapshot | undefined
  openConfirmDialog: (request: ConfirmDialogRequest) => void
  setConfig: (config: AppConfigSnapshot) => void
  setError: (message: string | undefined) => void
  setSettingsTab: (tab: SettingsTab) => void
  settingsOpen: boolean
  settingsTab: SettingsTab
  t: TFunction
}

export function useModelSettingsState({
  config,
  openConfirmDialog,
  setConfig,
  setError,
  setSettingsTab,
  settingsOpen,
  settingsTab,
  t
}: UseModelSettingsStateOptions) {
  const [editingModelIndex, setEditingModelIndex] = useState<number | undefined>()
  const [editingProviderModelIndex, setEditingProviderModelIndex] = useState<number | undefined>()
  const [modelDraft, setModelDraft] = useState<ModelDraft>(() => emptyModelDraft())
  const [modelDirty, setModelDirty] = useState(false)
  const modelDraftRef = useRef<ModelDraft>(emptyModelDraft())
  const modelListRef = useRef<HTMLDivElement | null>(null)
  const modelDirtyRef = useRef(false)
  const modelAutosave = useQueuedAutosave()
  const modelNoticeId = 'settings-model-status'
  const [modelCandidates, setModelCandidates] = useCachedModelCandidates({
    draft: modelDraft,
    enabled: settingsOpen && settingsTab === 'model'
  })
  const { modelListLoading, refreshModelCandidates } = useModelCandidateRefresh({
    modelDraft,
    setModelCandidates,
    t
  })

  useEffect(() => {
    modelDraftRef.current = modelDraft
  }, [modelDraft])

  useEffect(() => {
    if (!config || modelDirty) return
    const provider = editingModelIndex === undefined ? undefined : config.providers[editingModelIndex]
    if (provider) {
      const selectedModel = editingProviderModelIndex === undefined
        ? undefined
        : provider.models[editingProviderModelIndex]
      const model = selectedModel ?? provider.models[0]
      if (editingProviderModelIndex !== undefined && !selectedModel) setEditingProviderModelIndex(undefined)
      if (modelDraftRef.current.providerId === provider.id && modelDraftRef.current.modelConfigId === model?.id) return
      const draft = providerConfigToDraft(provider, model)
      modelDraftRef.current = draft
      setModelDraft(draft)
      setModelDirtyState(false)
      return
    }
    const fallback = config.providers.find((candidate) => (
      candidate.models.some((model) => model.id === config.defaultModelId)
    )) ?? config.providers[0]
    if (fallback) {
      setEditingModelIndex(fallback.index)
      setEditingProviderModelIndex(undefined)
      return
    }
    setEditingModelIndex(undefined)
    setEditingProviderModelIndex(undefined)
    const draft = emptyModelDraft()
    modelDraftRef.current = draft
    setModelDraft(draft)
    setModelDirtyState(false)
  }, [config, editingModelIndex, editingProviderModelIndex, modelDirty])

  useEffect(() => {
    if (settingsTab !== 'model' || editingModelIndex === undefined) return
    const frame = window.requestAnimationFrame(() => {
      modelListRef.current
        ?.querySelector<HTMLElement>(`[data-model-index="${editingModelIndex}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [config?.providers.length, editingModelIndex, settingsTab])

  function setModelDirtyState(value: boolean): void {
    modelDirtyRef.current = value
    setModelDirty(value)
  }

  async function ensureModelDraftCanLeave(): Promise<boolean> {
    if (!modelDirtyRef.current) return true
    await modelAutosave.waitForIdle()
    if (modelDirtyRef.current) {
      setSettingsTab('model')
      return false
    }
    return true
  }

  async function selectDefaultModel(modelConfigId: string | null): Promise<void> {
    if ((config?.defaultModelId ?? null) === modelConfigId) return
    setError(undefined)
    try {
      setConfig(await window.gale.config.selectDefaultModel(modelConfigId))
    } catch {
      setError(t('settings.failed_select_model'))
    }
  }

  async function editModel(index: number): Promise<void> {
    if (!(await ensureModelDraftCanLeave())) return
    const provider = config?.providers[index]
    const model = provider?.models[0]
    if (!provider) return
    modelAutosave.revise(`provider:${provider.id}`)
    setModelCandidates([])
    setEditingModelIndex(index)
    setEditingProviderModelIndex(undefined)
    const draft = providerConfigToDraft(provider, model)
    modelDraftRef.current = draft
    setModelDraft(draft)
    setModelDirtyState(false)
  }

  async function selectProviderModel(index: number): Promise<boolean> {
    if (!(await ensureModelDraftCanLeave())) return false
    const provider = editingModelIndex === undefined ? undefined : config?.providers[editingModelIndex]
    const model = provider?.models[index]
    if (!provider || !model) return false
    setEditingProviderModelIndex(index)
    const draft = modelConfigToDraft(provider, model)
    modelDraftRef.current = draft
    setModelDraft(draft)
    setModelDirtyState(false)
    return true
  }

  async function createModelDraft(templateId?: string): Promise<void> {
    if (!(await ensureModelDraftCanLeave())) return
    const template = templateId ? getModelTemplate(templateId) : undefined
    const draft = template
      ? modelTemplateToDraft(template)
      : { ...emptyModelDraft(), name: t('settings.new_provider_name') }
    try {
      const payload = buildProviderPayload(draft)
      if (!payload) throw new Error('Provider parameters are invalid.')
      const nextConfig = await window.gale.config.saveModelProvider(payload)
      const provider = nextConfig.providers.at(-1)
      if (!provider) throw new Error('Created provider is missing from the returned config.')
      const savedDraft = providerConfigToDraft(provider)
      setConfig(nextConfig)
      setEditingModelIndex(provider.index)
      setEditingProviderModelIndex(undefined)
      modelDraftRef.current = savedDraft
      setModelDraft(savedDraft)
      setModelDirtyState(false)
    } catch {
      notice.error(t('settings.failed_create_model'), { id: modelNoticeId })
    }
  }

  async function addProviderModel(): Promise<boolean> {
    if (!(await ensureModelDraftCanLeave())) return false
    const providerId = modelDraftRef.current.providerId
    if (!providerId) return false
    const defaults = { ...emptyModelDraft(), providerId }
    const payload = buildProviderModelPayload(defaults)
    if (!payload) return false
    try {
      const nextConfig = await window.gale.config.saveProviderModel(payload)
      const provider = nextConfig.providers.find((candidate) => candidate.id === providerId)
      const model = provider?.models.at(-1)
      if (!provider || !model) return false
      const draft = modelConfigToDraft(provider, model)
      setConfig(nextConfig)
      setEditingModelIndex(provider.index)
      setEditingProviderModelIndex(model.index)
      modelDraftRef.current = draft
      setModelDraft(draft)
      setModelDirtyState(false)
      return true
    } catch {
      notice.error(t('settings.failed_create_model'), { id: modelNoticeId })
      return false
    }
  }

  async function addProviderModels(modelIds: string[]): Promise<boolean> {
    if (!(await ensureModelDraftCanLeave())) return false
    const providerId = modelDraftRef.current.providerId
    if (!providerId) return false
    const uniqueModelIds = Array.from(new Set(modelIds.map((model) => model.trim()).filter(Boolean)))
    if (uniqueModelIds.length === 0) return false
    const payloads = uniqueModelIds.flatMap((model) => {
      const payload = buildProviderModelPayload({ ...emptyModelDraft(), providerId, model })
      return payload ? [payload] : []
    })
    if (payloads.length === 0) return false
    try {
      const nextConfig = await window.gale.config.addProviderModels(payloads)
      const provider = nextConfig.providers.find((candidate) => candidate.id === providerId)
      const model = provider?.models.at(-1)
      if (!provider || !model) return false
      const draft = modelConfigToDraft(provider, model)
      setConfig(nextConfig)
      setEditingModelIndex(provider.index)
      setEditingProviderModelIndex(model.index)
      modelDraftRef.current = draft
      setModelDraft(draft)
      setModelDirtyState(false)
      notice.success(t('settings.models_added', { count: payloads.length }), { id: modelNoticeId })
      return true
    } catch {
      notice.error(t('settings.failed_create_model'), { id: modelNoticeId })
      return false
    }
  }

  function updateModelDraft(update: Partial<ModelDraft>): void {
    const nextDraft = { ...modelDraftRef.current, ...update }
    const modelCandidateSourceUpdate = update.name !== undefined
      || update.protocol !== undefined
      || update.baseUrl !== undefined
      || update.modelListUrl !== undefined
      || update.modelListAuth !== undefined
      || update.apiKey !== undefined
    const providerUpdate = modelCandidateSourceUpdate
      || update.providerParametersJson !== undefined
    if (modelCandidateSourceUpdate) setModelCandidates([])
    modelDraftRef.current = nextDraft
    setModelDraft(nextDraft)
    void saveModelDraftImmediately(nextDraft, providerUpdate ? 'provider' : 'model')
  }

  function updateModelParameters(parametersJson: string): void {
    updateModelDraft({ parametersJson })
  }

  async function saveModelDraftImmediately(draft: ModelDraft, target: 'provider' | 'model'): Promise<boolean> {
    const identity = target === 'provider' ? draft.providerId : draft.modelConfigId
    if (!identity) return false
    const revision = modelAutosave.revise(`${target}:${identity}`)
    setModelDirtyState(true)
    const validationError = target === 'provider'
      ? validateModelProviderDraft(draft, t)
      : validateProviderModelDraft(draft, t)
    if (validationError) {
      notice.error(validationError, { id: modelNoticeId })
      await modelAutosave.waitForIdle()
      if (modelAutosave.isCurrent(revision)) setModelDirtyState(false)
      return false
    }
    const providerPayload = target === 'provider' ? buildProviderPayload(draft) : undefined
    const modelPayload = target === 'model' ? buildProviderModelPayload(draft) : undefined
    if ((target === 'provider' && !providerPayload) || (target === 'model' && !modelPayload)) return false
    const latest = await modelAutosave.enqueue(revision, async (request) => {
      try {
        const nextConfig = target === 'provider'
          ? await window.gale.config.saveModelProvider(providerPayload!)
          : await window.gale.config.saveProviderModel(modelPayload!)
        setConfig(nextConfig)
        if (!request.isCurrent()) return
        const provider = nextConfig.providers.find((candidate) => candidate.id === draft.providerId)
        if (!provider) throw new Error('Saved provider is missing from the returned config.')
        const requestedModel = draft.modelConfigId
          ? provider.models.find((candidate) => candidate.id === draft.modelConfigId) ?? provider.models[0]
          : undefined
        if (target === 'model' && !requestedModel) {
          throw new Error('Saved model configuration is missing from the returned config.')
        }
        const savedDraft = providerConfigToDraft(provider, requestedModel)
        setEditingModelIndex(provider.index)
        setEditingProviderModelIndex((current) => (
          target === 'provider' && current === undefined ? undefined : requestedModel?.index
        ))
        modelDraftRef.current = savedDraft
        setModelDraft(savedDraft)
        setModelDirtyState(false)
      } catch {
        if (request.isCurrent()) {
          notice.error(t('settings.failed_save_model'), { id: modelNoticeId })
          setModelDirtyState(false)
        }
      }
    })
    return !latest || !modelDirtyRef.current
  }

  async function deleteEditingModel(): Promise<void> {
    const provider = editingModelIndex === undefined ? undefined : config?.providers[editingModelIndex]
    if (!provider) return
    openConfirmDialog({
      title: t('settings.delete_provider_title', { name: provider.name }),
      description: t('settings.cannot_be_undone'),
      confirmText: t('common.delete'),
      variant: 'danger',
      onConfirm: async () => {
        try {
          modelAutosave.revise(`provider:delete:${provider.id}`)
          await modelAutosave.waitForIdle()
          const nextConfig = await window.gale.config.deleteModelProvider(provider.id)
          const nextProvider = nextConfig.providers[Math.min(provider.index, nextConfig.providers.length - 1)]
          const nextModel = nextProvider?.models[0]
          const draft = nextProvider ? providerConfigToDraft(nextProvider, nextModel) : emptyModelDraft()
          setConfig(nextConfig)
          setEditingModelIndex(nextProvider?.index)
          setEditingProviderModelIndex(undefined)
          modelDraftRef.current = draft
          setModelDraft(draft)
          setModelDirtyState(false)
        } catch {
          notice.error(t('settings.failed_delete_model'), { id: modelNoticeId })
        }
      }
    })
  }

  async function deleteSelectedProviderModel(): Promise<boolean> {
    if (!(await ensureModelDraftCanLeave())) return false
    const draft = modelDraftRef.current
    if (!draft.providerId || !draft.modelConfigId) return false
    const provider = config?.providers.find((candidate) => candidate.id === draft.providerId)
    if (!provider) return false
    openConfirmDialog({
      title: t('settings.delete_model_title', { name: draft.model || t('settings.this_model') }),
      description: t('settings.cannot_be_undone'),
      confirmText: t('common.delete'),
      variant: 'danger',
      onConfirm: async () => {
        try {
          const nextConfig = await window.gale.config.deleteProviderModel(draft.providerId!, draft.modelConfigId!)
          const nextProvider = nextConfig.providers.find((candidate) => candidate.id === draft.providerId)
          const nextModel = nextProvider?.models[Math.min(draft.modelIndex ?? 0, (nextProvider?.models.length ?? 1) - 1)]
          if (!nextProvider) return
          const nextDraft = providerConfigToDraft(nextProvider, nextModel)
          setConfig(nextConfig)
          setEditingProviderModelIndex(nextModel?.index)
          modelDraftRef.current = nextDraft
          setModelDraft(nextDraft)
          setModelDirtyState(false)
        } catch {
          notice.error(t('settings.failed_delete_model'), { id: modelNoticeId })
        }
      }
    })
    return true
  }

  async function moveEditingModel(direction: -1 | 1): Promise<void> {
    const provider = editingModelIndex === undefined ? undefined : config?.providers[editingModelIndex]
    if (!provider || !(await ensureModelDraftCanLeave())) return
    try {
      const nextConfig = await window.gale.config.moveModelProvider(provider.id, direction)
      const nextProvider = nextConfig.providers.find((candidate) => candidate.id === provider.id)
      const model = nextProvider?.models.find((candidate) => candidate.id === modelDraftRef.current.modelConfigId)
      if (!nextProvider) return
      const draft = providerConfigToDraft(nextProvider, model)
      setConfig(nextConfig)
      setEditingModelIndex(nextProvider.index)
      modelDraftRef.current = draft
      setModelDraft(draft)
      setModelDirtyState(false)
    } catch {
      notice.error(t('settings.failed_move_model'), { id: modelNoticeId })
    }
  }

  async function moveSelectedProviderModel(direction: -1 | 1): Promise<void> {
    const draft = modelDraftRef.current
    if (!draft.providerId || !draft.modelConfigId || !(await ensureModelDraftCanLeave())) return
    try {
      const nextConfig = await window.gale.config.moveProviderModel(draft.providerId, draft.modelConfigId, direction)
      const provider = nextConfig.providers.find((candidate) => candidate.id === draft.providerId)
      const model = provider?.models.find((candidate) => candidate.id === draft.modelConfigId)
      if (!provider || !model) return
      const nextDraft = modelConfigToDraft(provider, model)
      setConfig(nextConfig)
      setEditingProviderModelIndex(model.index)
      modelDraftRef.current = nextDraft
      setModelDraft(nextDraft)
      setModelDirtyState(false)
    } catch {
      notice.error(t('settings.failed_move_model'), { id: modelNoticeId })
    }
  }

  const editingProvider: ModelProviderConfigDetail | undefined = editingModelIndex === undefined
    ? undefined
    : config?.providers[editingModelIndex]

  return {
    addProviderModel,
    addProviderModels,
    createModelDraft,
    deleteEditingModel,
    deleteSelectedProviderModel,
    editModel,
    editingModelIndex,
    editingProvider,
    editingProviderModelIndex,
    ensureModelDraftCanLeave,
    modelCandidates,
    modelDraft,
    modelListLoading,
    modelListRef,
    moveEditingModel,
    moveSelectedProviderModel,
    refreshModelCandidates,
    selectDefaultModel,
    selectProviderModel,
    updateModelDraft,
    updateModelParameters
  }
}
