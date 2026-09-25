import { useEffect, useRef, useState } from 'react'
import { buildModelListRequest } from './modelDraft'
import type { ModelDraft } from './modelDraft'

interface UseCachedModelCandidatesOptions {
  draft: ModelDraft
  enabled: boolean
}

export function useCachedModelCandidates({
  draft,
  enabled
}: UseCachedModelCandidatesOptions): [string[], (candidates: string[]) => void] {
  const [candidates, setCandidates] = useState<string[]>([])
  const loadIdRef = useRef(0)

  useEffect(() => {
    const loadId = loadIdRef.current + 1
    loadIdRef.current = loadId
    if (!enabled) return
    const request = buildModelListRequest(draft)
    setCandidates([])
    if (!request) return
    const modelListRequest = request

    async function loadCachedModelCandidates(): Promise<void> {
      try {
        const result = await window.gale.config.getCachedModels(modelListRequest)
        if (loadIdRef.current !== loadId) return
        setCandidates(result?.models ?? [])
      } catch {
        if (loadIdRef.current !== loadId) return
        setCandidates([])
      }
    }

    void loadCachedModelCandidates()
  }, [
    draft.apiKey,
    draft.baseUrl,
    draft.modelListAuth,
    draft.modelListUrl,
    draft.name,
    draft.protocol,
    draft.providerId,
    enabled
  ])

  return [candidates, setCandidates]
}
