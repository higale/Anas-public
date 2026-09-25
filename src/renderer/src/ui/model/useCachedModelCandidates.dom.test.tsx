import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelListAuth } from '@shared/types'
import { emptyModelDraft } from './modelDraft'
import { useCachedModelCandidates } from './useCachedModelCandidates'

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('cached model candidates', () => {
  it('clears and reloads candidates when model list authentication changes', async () => {
    let resolveAnthropic: ((value: { models: string[] }) => void) | undefined
    const getCachedModels = vi.fn()
      .mockResolvedValueOnce({ models: ['bearer-model'] })
      .mockImplementationOnce(() => new Promise<{ models: string[] }>((resolve) => {
        resolveAnthropic = resolve
      }))
    vi.stubGlobal('gale', { config: { getCachedModels } })
    const initialDraft = {
      ...emptyModelDraft(),
      baseUrl: 'https://example.com/v1'
    }
    const { result, rerender } = renderHook(
      ({ modelListAuth }: { modelListAuth: ModelListAuth }) => useCachedModelCandidates({
        draft: { ...initialDraft, modelListAuth },
        enabled: true
      }),
      { initialProps: { modelListAuth: 'bearer' as ModelListAuth } }
    )

    await waitFor(() => expect(result.current[0]).toEqual(['bearer-model']))
    rerender({ modelListAuth: 'anthropic' })

    await waitFor(() => expect(result.current[0]).toEqual([]))
    expect(getCachedModels).toHaveBeenLastCalledWith(expect.objectContaining({
      modelListAuth: 'anthropic'
    }))

    await act(async () => resolveAnthropic?.({ models: ['claude-model'] }))
    await waitFor(() => expect(result.current[0]).toEqual(['claude-model']))
  })
})
