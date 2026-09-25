import { act, renderHook } from '@testing-library/react'
import type { TFunction } from 'i18next'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GaleApi, MemoryItem, MemorySearchResult } from '@shared/types'
import { useMemorySettingsState } from './useMemorySettingsState'

vi.mock('../notice', () => ({
  notice: { error: vi.fn(), success: vi.fn() }
}))

const t = ((key: string) => key) as TFunction

const existingMemory: MemoryItem = {
  id: '10000000-0000-4000-8000-000000000001',
  scope: 'project',
  projectId: 'project-1',
  kind: 'fact',
  content: 'Stored content',
  keywords: [],
  importance: 3,
  origin: 'user',
  createdAt: '2026-08-26T00:00:00.000Z',
  updatedAt: '2026-08-26T00:00:00.000Z'
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

function installMemoryApi(search: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(window, 'gale', {
    configurable: true,
    value: { memory: { search } } as unknown as GaleApi
  })
}

function renderMemoryState() {
  return renderHook(() => useMemorySettingsState({
    openConfirmDialog: vi.fn(),
    settingsOpen: true,
    settingsTab: 'memory',
    t
  }))
}

async function runSearchDelay(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150)
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('useMemorySettingsState', () => {
  it('does not replace a new draft when the initial search finishes', async () => {
    vi.useFakeTimers()
    const pending = deferred<MemorySearchResult>()
    const search = vi.fn(() => pending.promise)
    installMemoryApi(search)
    const { result } = renderMemoryState()

    await runSearchDelay()
    act(() => {
      result.current.startNewMemory()
      result.current.updateMemoryDraft({ content: 'Unsaved new memory' })
    })
    await act(async () => {
      pending.resolve({ items: [existingMemory], total: 1 })
      await pending.promise
    })

    expect(result.current.draft).toMatchObject({ content: 'Unsaved new memory', scope: 'global' })
    expect(result.current.draft?.projectId).toBeUndefined()
    expect(result.current.selectedId).toBeUndefined()
    expect(result.current.result).toMatchObject({ total: 1 })
  })

  it('updates search results without replacing an edited draft', async () => {
    vi.useFakeTimers()
    const pending = deferred<MemorySearchResult>()
    const search = vi.fn()
      .mockResolvedValueOnce({ items: [existingMemory], total: 1 })
      .mockImplementationOnce(() => pending.promise)
    installMemoryApi(search)
    const { result } = renderMemoryState()

    await runSearchDelay()
    act(() => {
      result.current.updateMemoryDraft({ content: 'Locally edited content' })
      result.current.setQuery('different')
    })
    await runSearchDelay()
    await act(async () => {
      pending.resolve({ items: [], total: 0 })
      await pending.promise
    })

    expect(result.current.result).toEqual({ items: [], total: 0 })
    expect(result.current.draft).toMatchObject({
      id: existingMemory.id,
      content: 'Locally edited content'
    })
  })
})
