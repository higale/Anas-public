import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createFromPath: vi.fn(),
  dockSetIcon: vi.fn(),
  findAvatarWindowsIconPath: vi.fn(),
  getAllWindows: vi.fn(),
  pruneAvatarWindowsIcons: vi.fn(),
  runtimeLog: vi.fn(),
  stat: vi.fn()
}))

vi.mock('electron', () => ({
  app: { dock: { setIcon: mocks.dockSetIcon } },
  BrowserWindow: { getAllWindows: mocks.getAllWindows },
  nativeImage: { createFromPath: mocks.createFromPath }
}))

vi.mock('node:fs/promises', () => ({
  stat: mocks.stat
}))

vi.mock('./avatarAssets', () => ({
  avatarDockIconPath: () => '/profile/avatar-dock.png',
  findAvatarWindowsIconPath: mocks.findAvatarWindowsIconPath,
  pruneAvatarWindowsIcons: mocks.pruneAvatarWindowsIcons
}))

vi.mock('./config/dataDir', () => ({
  getDataDir: () => '/profile'
}))

vi.mock('./runtimeLogger', () => ({
  runtimeLog: mocks.runtimeLog
}))

import { applyProfileIcon, applyProfileWindowIcon } from './profileIconService'

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

function profileImage(name: string) {
  return {
    isEmpty: () => false,
    name
  }
}

function profileWindow() {
  return {
    isDestroyed: vi.fn(() => false),
    setAppDetails: vi.fn(),
    setIcon: vi.fn()
  }
}

describe('profile system icon', () => {
  beforeEach(() => {
    setPlatform('win32')
    mocks.createFromPath.mockReset()
    mocks.dockSetIcon.mockReset()
    mocks.findAvatarWindowsIconPath.mockReset()
      .mockResolvedValue('C:\\profile\\avatar-win-v1-a1b2c3d4e5f60708.ico')
    mocks.getAllWindows.mockReset()
    mocks.pruneAvatarWindowsIcons.mockReset().mockResolvedValue(undefined)
    mocks.runtimeLog.mockReset()
    mocks.stat.mockReset().mockResolvedValue({})
  })

  afterEach(() => {
    if (originalPlatformDescriptor) Object.defineProperty(process, 'platform', originalPlatformDescriptor)
  })

  it('applies the profile icon and taskbar identity when a Windows window starts', async () => {
    const image = profileImage('startup')
    const win = profileWindow()
    mocks.createFromPath.mockReturnValue(image)

    await applyProfileWindowIcon(win as never)

    expect(win.setIcon).toHaveBeenCalledWith(image)
    expect(win.setAppDetails).toHaveBeenCalledWith({
      appId: 'com.5nx.anas',
      appIconPath: 'C:\\profile\\avatar-win-v1-a1b2c3d4e5f60708.ico',
      appIconIndex: 0
    })
    expect(mocks.pruneAvatarWindowsIcons).toHaveBeenCalledWith('C:\\profile\\avatar-win-v1-a1b2c3d4e5f60708.ico')
  })

  it('reloads the changed ICO before refreshing every live Windows window', async () => {
    const first = profileImage('first')
    const second = profileImage('second')
    const firstPath = 'C:\\profile\\avatar-win-v1-1111111111111111.ico'
    const secondPath = 'C:\\profile\\avatar-win-v1-2222222222222222.ico'
    const windows = [profileWindow(), profileWindow()]
    mocks.findAvatarWindowsIconPath.mockResolvedValueOnce(firstPath).mockResolvedValueOnce(secondPath)
    mocks.createFromPath.mockReturnValueOnce(first).mockReturnValueOnce(second)
    mocks.getAllWindows.mockReturnValue(windows)

    await applyProfileIcon()
    await applyProfileIcon()

    expect(mocks.createFromPath).toHaveBeenCalledTimes(2)
    for (const win of windows) {
      expect(win.setIcon).toHaveBeenNthCalledWith(1, first)
      expect(win.setIcon).toHaveBeenNthCalledWith(2, second)
      expect(win.setAppDetails).toHaveBeenNthCalledWith(1, {
        appId: 'com.5nx.anas',
        appIconPath: firstPath,
        appIconIndex: 0
      })
      expect(win.setAppDetails).toHaveBeenNthCalledWith(2, {
        appId: 'com.5nx.anas',
        appIconPath: secondPath,
        appIconIndex: 0
      })
    }
    expect(mocks.pruneAvatarWindowsIcons).toHaveBeenNthCalledWith(1, firstPath)
    expect(mocks.pruneAvatarWindowsIcons).toHaveBeenNthCalledWith(2, secondPath)
  })

  it('preserves the current icon when the generated ICO cannot be decoded', async () => {
    const win = profileWindow()
    mocks.createFromPath.mockReturnValue({ isEmpty: () => true })
    mocks.getAllWindows.mockReturnValue([win])

    await applyProfileIcon()

    expect(win.setIcon).not.toHaveBeenCalled()
    expect(win.setAppDetails).not.toHaveBeenCalled()
    expect(mocks.runtimeLog).toHaveBeenCalledWith(
      'warn',
      'profile',
      'Avatar Windows icon could not be decoded.',
      { iconPath: 'C:\\profile\\avatar-win-v1-a1b2c3d4e5f60708.ico' }
    )
    expect(mocks.pruneAvatarWindowsIcons).not.toHaveBeenCalled()
  })

  it('continues refreshing other windows when one window rejects the icon', async () => {
    const image = profileImage('current')
    const broken = profileWindow()
    const healthy = profileWindow()
    broken.setIcon.mockImplementation(() => {
      throw new Error('window was destroyed')
    })
    mocks.createFromPath.mockReturnValue(image)
    mocks.getAllWindows.mockReturnValue([broken, healthy])

    await applyProfileIcon()

    expect(healthy.setIcon).toHaveBeenCalledWith(image)
    expect(healthy.setAppDetails).toHaveBeenCalledOnce()
    expect(mocks.runtimeLog).toHaveBeenCalledWith(
      'warn',
      'profile',
      'Failed to refresh a profile window icon.',
      { error: expect.any(Error) }
    )
  })

  it('preserves the macOS Dock icon behavior', async () => {
    setPlatform('darwin')
    const image = profileImage('dock')
    mocks.createFromPath.mockReturnValue(image)

    await applyProfileIcon()

    expect(mocks.createFromPath).toHaveBeenCalledWith('/profile/avatar-dock.png')
    expect(mocks.dockSetIcon).toHaveBeenCalledWith(image)
    expect(mocks.getAllWindows).not.toHaveBeenCalled()
  })

  it('does not load a Windows icon on Linux', async () => {
    setPlatform('linux')

    await applyProfileIcon()

    expect(mocks.createFromPath).not.toHaveBeenCalled()
    expect(mocks.getAllWindows).not.toHaveBeenCalled()
  })
})
