import { environmentContextFixture } from '../../../../test/environmentContextFixture'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, EnvironmentContextSettings, GaleApi } from '@shared/types'
import { EnvironmentSettingsSections } from './EnvironmentSettingsSections'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

const environmentMocks = vi.hoisted(() => ({
  detectSystemEnvironment: vi.fn()
}))

vi.mock('../notice', () => ({
  notice: { error: vi.fn(), info: vi.fn() }
}))

function appSettings(
  environmentContext: Partial<EnvironmentContextSettings> = {}
): AppSettings {
  return {
    environmentContext: environmentContextFixture({ customInformationEnabled: false, ...environmentContext })
  } as AppSettings
}

function EnvironmentSettingsHarness({
  initialSettings,
  onSaveSettings
}: {
  initialSettings: AppSettings
  onSaveSettings: (settings: Partial<AppSettings>) => void
}) {
  const [settings, setSettings] = useState(initialSettings)
  return (
    <EnvironmentSettingsSections
      envDraft=""
      settings={settings}
      sectionClass={() => 'environment-section'}
      onAutosizeInput={vi.fn()}
      onOpenEnvFile={vi.fn()}
      onSaveSettings={(update) => {
        onSaveSettings(update)
        setSettings((current) => ({ ...current, ...update }))
      }}
      onUpdateEnvDraft={vi.fn()}
    />
  )
}

describe('environment settings', () => {
  beforeEach(() => {
    environmentMocks.detectSystemEnvironment.mockReset()
    Object.defineProperty(window, 'gale', {
      configurable: true,
      value: {
        app: { detectSystemEnvironment: environmentMocks.detectSystemEnvironment }
      } as unknown as GaleApi
    })
  })

  it('enables custom environment information by default without detecting from settings', () => {
    const { unmount } = render(
      <EnvironmentSettingsSections
        envDraft=""
        settings={undefined}
        sectionClass={() => 'environment-section'}
        onAutosizeInput={vi.fn()}
        onOpenEnvFile={vi.fn()}
        onSaveSettings={vi.fn()}
        onUpdateEnvDraft={vi.fn()}
      />
    )

    expect(screen.getByRole('checkbox', {
      name: 'settings.custom_environment_information'
    })).toBeChecked()
    expect(environmentMocks.detectSystemEnvironment).not.toHaveBeenCalled()
    unmount()
  })

  it('lets users disable bundled command context independently of environment detection', async () => {
    const user = userEvent.setup()
    const onSaveSettings = vi.fn()
    render(<EnvironmentSettingsHarness initialSettings={appSettings()} onSaveSettings={onSaveSettings} />)
    const checkbox = screen.getByRole('checkbox', { name: 'settings.capability_bundledCommands' })
    expect(checkbox).toBeChecked()
    await user.click(checkbox)
    expect(onSaveSettings).toHaveBeenLastCalledWith({
      environmentContext: { ...appSettings().environmentContext, bundledCommands: false }
    })
    expect(checkbox).not.toBeChecked()
    expect(environmentMocks.detectSystemEnvironment).not.toHaveBeenCalled()
  })

  it('detects only on click and appends results after the latest textarea draft', async () => {
    const user = userEvent.setup()
    const onSaveSettings = vi.fn()
    environmentMocks.detectSystemEnvironment.mockResolvedValue({
      content: 'Available development tools:\n- Python: Python 3.13.7 (python3)',
      tools: [{ name: 'Python', executable: 'python3', details: 'Python 3.13.7' }]
    })
    render(
      <EnvironmentSettingsHarness
        initialSettings={appSettings({ customInformation: 'Existing information.' })}
        onSaveSettings={onSaveSettings}
      />
    )
    const input = screen.getByRole('textbox', {
      name: /settings\.custom_environment_information/
    })

    expect(environmentMocks.detectSystemEnvironment).not.toHaveBeenCalled()
    await user.type(input, ' Manual addition.')
    await user.click(screen.getByRole('button', { name: 'settings.detect_system_environment' }))

    const customInformation = [
      'Existing information. Manual addition.',
      '',
      'Available development tools:',
      '- Python: Python 3.13.7 (python3)'
    ].join('\n')
    await waitFor(() => expect(onSaveSettings).toHaveBeenLastCalledWith({
      environmentContext: expect.objectContaining({
        customInformation,
        customInformationEnabled: false
      })
    }))
    expect(input).toHaveValue(customInformation)
    expect(environmentMocks.detectSystemEnvironment).toHaveBeenCalledOnce()
  })

  it('saves a manually edited custom environment value on blur', async () => {
    const user = userEvent.setup()
    const onSaveSettings = vi.fn()
    render(
      <EnvironmentSettingsHarness
        initialSettings={appSettings({ customInformation: 'Existing information.' })}
        onSaveSettings={onSaveSettings}
      />
    )
    const input = screen.getByRole('textbox', {
      name: /settings\.custom_environment_information/
    })

    await user.type(input, ' Manual addition.')
    await user.tab()

    expect(onSaveSettings).toHaveBeenLastCalledWith({
      environmentContext: expect.objectContaining({
        customInformation: 'Existing information. Manual addition.'
      })
    })
  })

  it('preserves an unsaved draft when startup detection updates the saved value', async () => {
    const user = userEvent.setup()
    const onSaveSettings = vi.fn()
    const props = {
      envDraft: '', sectionClass: () => 'environment-section', onAutosizeInput: vi.fn(),
      onOpenEnvFile: vi.fn(), onUpdateEnvDraft: vi.fn(), onSaveSettings
    }
    const { rerender } = render(<EnvironmentSettingsSections {...props} settings={appSettings()} />)
    const input = screen.getByRole('textbox', { name: 'settings.custom_environment_information' })
    await user.type(input, 'My environment')
    rerender(<EnvironmentSettingsSections {...props} settings={appSettings({ customInformation: 'Startup result' })} />)
    expect(input).toHaveValue('My environment')
    await user.tab()
    expect(onSaveSettings).toHaveBeenLastCalledWith({
      environmentContext: expect.objectContaining({ customInformation: 'My environment' })
    })
  })
})
