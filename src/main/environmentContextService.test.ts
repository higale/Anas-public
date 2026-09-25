import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initializeCustomEnvironmentInformation } from './environmentContextService'

const mocks = vi.hoisted(() => ({ read: vi.fn(), fill: vi.fn(), detect: vi.fn(), log: vi.fn() }))
vi.mock('./config/appConfig', () => ({ getAppConfigSnapshot: mocks.read, fillEmptyCustomEnvironmentInformation: mocks.fill }))
vi.mock('./systemEnvironmentDetection', () => ({ detectSystemEnvironment: mocks.detect }))
vi.mock('./runtimeLogger', () => ({ runtimeLog: mocks.log }))

describe('startup environment initialization', () => {
  beforeEach(() => {
    mocks.read.mockResolvedValue({ settings: { environmentContext: { customInformationEnabled: true, customInformation: '' } } })
    mocks.fill.mockResolvedValue(true)
  })

  it('skips probing when custom information already exists', async () => {
    mocks.read.mockResolvedValue({ settings: { environmentContext: { customInformationEnabled: true, customInformation: 'User content' } } })
    await initializeCustomEnvironmentInformation()
    expect(mocks.detect).not.toHaveBeenCalled()
    expect(mocks.fill).not.toHaveBeenCalled()
  })

  it('does not start detection when custom information is disabled, even if empty', async () => {
    mocks.read.mockResolvedValue({ settings: { environmentContext: { customInformationEnabled: false, customInformation: '' } } })
    await initializeCustomEnvironmentInformation()
    expect(mocks.detect).not.toHaveBeenCalled()
    expect(mocks.fill).not.toHaveBeenCalled()
  })

  it('logs detection failures without failing application startup', async () => {
    mocks.detect.mockRejectedValue(new Error('Probe failed'))
    await expect(initializeCustomEnvironmentInformation()).resolves.toBeUndefined()
    expect(mocks.fill).not.toHaveBeenCalled()
    expect(mocks.log).toHaveBeenCalledWith('warn', 'runtime', expect.any(String), expect.any(Object))
  })
})
