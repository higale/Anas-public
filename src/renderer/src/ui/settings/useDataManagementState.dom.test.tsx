import { act, renderHook, waitFor } from '@testing-library/react'
import type { TFunction } from 'i18next'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StorageUsageValue } from '@shared/types'
import type { SettingsTab } from './settingsTabs'
import { useDataManagementState } from './useDataManagementState'

vi.mock('../notice', () => ({ notice: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }))

const t = ((key: string) => key) as TFunction
const allData = vi.fn(), agentData = vi.fn(), traceData = vi.fn()
const options = { openConfirmDialog: vi.fn(), setConfig: vi.fn(), setInputHistory: vi.fn(), cleanupAgentThreads: vi.fn(), t }

beforeEach(() => {
  allData.mockReset().mockImplementation(() => new Promise(() => {}))
  agentData.mockReset().mockImplementation(() => new Promise(() => {}))
  traceData.mockReset().mockResolvedValue({ totalBytes: 15, approximate: false })
  Object.defineProperty(window, 'gale', { configurable: true, value: {
    app: { getDataStorageUsage: allData, getDeveloperHttpTraceUsage: traceData, getDeveloperHttpTraceEnabled: vi.fn().mockResolvedValue(false) },
    agent: { maintenance: { getStorageUsage: agentData } }
  } })
})

function renderState(tab: SettingsTab = 'dev', open = true) {
  return renderHook(({ settingsTab, settingsOpen }) => useDataManagementState({ ...options, settingsTab, settingsOpen }), {
    initialProps: { settingsTab: tab, settingsOpen: open }
  })
}

describe('Dev storage usage', () => {
  it('loads only developer trace usage when the Dev page opens', async () => {
    const { result } = renderState()
    await waitFor(() => expect(result.current.developerHttpTraceUsage).toEqual({ totalBytes: 15, approximate: false }))
    expect(result.current.developerHttpTraceUsageLoading).toBe(false)
    expect(allData).not.toHaveBeenCalled()
    expect(agentData).not.toHaveBeenCalled()
  })

  it('keeps Dev usage independent of a pending full storage scan', async () => {
    const { result, rerender } = renderState('general')
    expect(result.current.storageUsageLoading).toBe(true)
    rerender({ settingsTab: 'dev', settingsOpen: true })
    await waitFor(() => expect(result.current.developerHttpTraceUsageLoading).toBe(false))
    expect(result.current.developerHttpTraceUsage?.totalBytes).toBe(15)
    expect(result.current.storageUsageLoading).toBe(true)
    expect(allData).toHaveBeenCalledOnce()
    expect(agentData).toHaveBeenCalledOnce()
  })

  it('shares a pending trace scan across tab switches and refreshes on later visits', async () => {
    let resolve!: (value: StorageUsageValue) => void
    traceData.mockReturnValueOnce(new Promise<StorageUsageValue>((done) => { resolve = done }))
    const { result, rerender } = renderState('general')
    expect(traceData).not.toHaveBeenCalled()
    rerender({ settingsTab: 'dev', settingsOpen: true })
    expect(result.current.developerHttpTraceUsageLoading).toBe(true)
    rerender({ settingsTab: 'general', settingsOpen: true })
    rerender({ settingsTab: 'dev', settingsOpen: true })
    expect(traceData).toHaveBeenCalledOnce()
    await act(async () => resolve({ totalBytes: 7, approximate: false }))
    expect(result.current.developerHttpTraceUsage?.totalBytes).toBe(7)
    rerender({ settingsTab: 'general', settingsOpen: true })
    rerender({ settingsTab: 'dev', settingsOpen: true })
    await waitFor(() => expect(result.current.developerHttpTraceUsage?.totalBytes).toBe(15))
    expect(traceData).toHaveBeenCalledTimes(2)
  })

  it('ends loading after a failed scan and retries when Dev is reopened', async () => {
    traceData.mockRejectedValueOnce(new Error('Directory unavailable'))
    const { result, rerender } = renderState()
    await waitFor(() => expect(result.current.developerHttpTraceUsageLoading).toBe(false))
    expect(result.current.developerHttpTraceUsage).toBeUndefined()
    rerender({ settingsTab: 'dev', settingsOpen: false })
    rerender({ settingsTab: 'dev', settingsOpen: true })
    await waitFor(() => expect(result.current.developerHttpTraceUsage?.totalBytes).toBe(15))
  })
})
