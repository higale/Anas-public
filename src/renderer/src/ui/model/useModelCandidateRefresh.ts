import { useState } from 'react'
import type { TFunction } from 'i18next'
import { notice } from '../notice'
import { buildModelListRequest } from './modelDraft'
import type { ModelDraft } from './modelDraft'

interface UseModelCandidateRefreshOptions {
  modelDraft: ModelDraft
  setModelCandidates: (candidates: string[]) => void
  t: TFunction
}

export function useModelCandidateRefresh({
  modelDraft,
  setModelCandidates,
  t
}: UseModelCandidateRefreshOptions) {
  const [modelListLoading, setModelListLoading] = useState(false)

  async function refreshModelCandidates(): Promise<void> {
    if (!modelDraft.baseUrl.trim()) {
      notice.error(t('settings.base_url_required_for_models'))
      return
    }
    const request = buildModelListRequest(modelDraft)
    if (!request) {
      notice.error(t('settings.base_url_required_for_models'))
      return
    }
    setModelListLoading(true)
    try {
      const result = await window.gale.config.fetchModels(request)
      setModelCandidates(result.models)
      notice.success(t('settings.model_list_refreshed'))
    } catch {
      setModelCandidates([])
      notice.error(t('settings.failed_fetch_model_list'))
    } finally {
      setModelListLoading(false)
    }
  }

  return {
    modelListLoading,
    refreshModelCandidates
  }
}
