import { beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  showErrorBox: vi.fn()
}))

vi.mock('electron', () => ({
  dialog: { showErrorBox: electronMocks.showErrorBox }
}))

import { reportStartupFailure, startupFailureCopy } from './startupFailure'

describe('startup failure reporting', () => {
  beforeEach(() => {
    electronMocks.showErrorBox.mockReset()
  })

  it('shows the underlying data error in a localized native dialog', () => {
    const exitApplication = vi.fn()

    reportStartupFailure(new Error('projects.json 数据版本无效'), exitApplication, 'zh-CN')

    expect(electronMocks.showErrorBox).toHaveBeenCalledWith(
      'Anas 启动失败',
      expect.stringContaining('projects.json 数据版本无效')
    )
    expect(exitApplication).toHaveBeenCalledWith(1)
    expect(electronMocks.showErrorBox.mock.invocationCallOrder[0])
      .toBeLessThan(exitApplication.mock.invocationCallOrder[0])
  })

  it('provides English fallback copy for non-Chinese locales', () => {
    expect(startupFailureCopy('Invalid data directory', 'en-US')).toEqual({
      title: 'Anas failed to start',
      content: 'Anas could not start.\n\nInvalid data directory\n\nCheck the error and data directory, then try again.'
    })
  })

  it('still exits when the native dialog itself fails', () => {
    const exitApplication = vi.fn()
    electronMocks.showErrorBox.mockImplementationOnce(() => {
      throw new Error('native dialog unavailable')
    })

    reportStartupFailure(new Error('startup failed'), exitApplication, 'en-US')

    expect(exitApplication).toHaveBeenCalledWith(1)
  })
})
