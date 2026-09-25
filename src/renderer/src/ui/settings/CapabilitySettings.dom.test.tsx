import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { defaultCapabilitySettings, type DefaultCapabilitySettings } from '@shared/agentCapabilities'
import { CapabilitySettings } from './CapabilitySettings'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

function config() {
  return { customTools: [], defaultCapabilities: structuredClone(defaultCapabilitySettings), subagents: [], mcpServers: [] }
}

describe('default capability settings', () => {
  it('enables the whole policy in one save without changing subagent definitions', async () => {
    const value = config()
    value.defaultCapabilities.capabilities.profile = false
    value.defaultCapabilities.restrictSubagents = true
    value.defaultCapabilities.subagentSelection = { mode: 'custom', names: ['reviewer'] }
    const onSave = vi.fn(async (_value: DefaultCapabilitySettings) => undefined)
    render(<CapabilitySettings config={value} onSave={onSave} />)
    fireEvent.click(screen.getByRole('button', { name: 'settings.capabilities_enable_all' }))
    await waitFor(() => expect(onSave).toHaveBeenCalledOnce())
    expect(onSave.mock.calls[0][0]).toMatchObject({ capabilities: { profile: true }, restrictSubagents: false,
      subagentSelection: { mode: 'default', names: ['reviewer'] } })
    expect(value.defaultCapabilities.capabilities.profile).toBe(false)
  })
})
