import { useState } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TFunction } from 'i18next'
import type { AppConfigSnapshot } from '@shared/types'
import { defaultCapabilitySettings, type DefaultCapabilitySettings } from '@shared/agentCapabilities'
import { CapabilitySettings } from './CapabilitySettings'
import { useSettingsController } from './useSettingsController'
import { notice } from '../notice'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../../i18n', () => ({ applyLanguagePreference: vi.fn() }))
vi.mock('../notice', () => ({ notice: { error: vi.fn() } }))
const t = ((key: string) => key) as TFunction

function Harness() {
  const [config, setConfig] = useState<AppConfigSnapshot>()
  const controller = useSettingsController({ setConfig, t })
  const value = config ?? { customTools: [], defaultCapabilities: defaultCapabilitySettings, subagents: [], mcpServers: [] }
  return <>
    <button onClick={() => controller.setSettingsOpen(!controller.settingsOpen)}>Toggle settings</button>
    {controller.settingsOpen && <CapabilitySettings config={value} pending={controller.pendingDefaultCapabilities} onSave={controller.saveDefaultCapabilities} />}
  </>
}

afterEach(() => vi.unstubAllGlobals())

describe('capability save lifetime', () => {
  it('restores saved values and reports a failure after the page has been closed', async () => {
    let reject!: (error: Error) => void
    const save = vi.fn(() => new Promise<void>((_resolve, rejectSave) => { reject = rejectSave }))
    vi.stubGlobal('gale', { config: { saveDefaultCapabilities: save } })
    render(<Harness />)
    const toggle = screen.getByRole('button', { name: 'Toggle settings' })
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('checkbox', { name: 'settings.capability_profile' }))
    fireEvent.click(toggle)
    reject(new Error('Disk write failed'))
    await waitFor(() => expect(notice.error).toHaveBeenCalledWith('chat.failed_save_settings'))
    fireEvent.click(toggle)
    const profile = screen.getByRole('checkbox', { name: 'settings.capability_profile' })
    expect(profile).toBeChecked()
    expect(profile).toBeEnabled()
  })

  it('retains the pending choice and prevents stale saves after reopening settings', async () => {
    let finish!: () => void
    const pending = new Promise<void>((resolve) => { finish = resolve })
    const save = vi.fn(async (value: DefaultCapabilitySettings) => {
      await pending
      return { customTools: [], defaultCapabilities: value, subagents: [], mcpServers: [] }
    })
    vi.stubGlobal('gale', { config: { saveDefaultCapabilities: save } })
    render(<Harness />)
    const toggle = screen.getByRole('button', { name: 'Toggle settings' })
    fireEvent.click(toggle)
    fireEvent.click(screen.getByRole('checkbox', { name: 'settings.capability_profile' }))
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    const profile = screen.getByRole('checkbox', { name: 'settings.capability_profile' })
    expect(profile).not.toBeChecked()
    expect(profile).toBeDisabled()
    finish()
    await waitFor(() => expect(profile).toBeEnabled())
    fireEvent.click(screen.getByRole('checkbox', { name: 'settings.capability_workspaceContext' }))
    await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
    expect(save.mock.calls[1][0].capabilities).toMatchObject({ profile: false, workspace: false })
  })
})
