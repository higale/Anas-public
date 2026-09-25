import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { expect, it, vi } from 'vitest'
import type { SubagentSelection } from '@shared/subagentSelection'
import { SubagentSelectionEditor } from './SubagentSelectionEditor'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

it('edits global references, clears missing entries, and retains custom choices across mode and enable changes', async () => {
  const user = userEvent.setup()
  const changed = vi.fn()
  function Harness() {
    const [value, setValue] = useState<SubagentSelection>({ mode: 'custom', names: ['missing', 'disabled'] })
    const [enabled, setEnabled] = useState(true)
    return <SubagentSelectionEditor value={value} enabled={enabled} onEnable={setEnabled} disabled={false}
      definitions={[{ name: 'researcher', description: 'Research documents', systemPrompt: 'Research.', enabled: true }, { name: 'disabled', description: 'Custom use.', systemPrompt: 'Complete task.', enabled: false }]}
      onChange={(next) => { setValue(next); changed(next) }} />
  }
  render(<Harness />)
  expect(screen.getByRole('checkbox', { name: 'disabled' })).toBeChecked()
  expect(screen.getByText('capabilities.deleted')).toBeInTheDocument()
  expect(screen.queryByText('capabilities.inactive')).not.toBeInTheDocument()
  expect(screen.getByText('1')).toBeInTheDocument()
  await user.click(screen.getByRole('checkbox', { name: 'missing' }))
  expect(screen.queryByRole('checkbox', { name: 'missing' })).not.toBeInTheDocument()
  await user.type(screen.getByRole('searchbox'), 'documents')
  await user.click(screen.getByRole('checkbox', { name: 'researcher' }))
  expect(changed).toHaveBeenLastCalledWith({ mode: 'custom', names: ['disabled', 'researcher'] })
  const picker = screen.getByRole('combobox', { name: 'capabilities.subagent_selection' })
  await user.click(picker)
  await user.click(screen.getByRole('option', { name: 'capabilities.default' }))
  expect(screen.queryByRole('checkbox', { name: 'researcher' })).not.toBeInTheDocument()
  await user.click(picker)
  await user.click(screen.getByRole('option', { name: 'capabilities.custom' }))
  const researcher = screen.getByRole('checkbox', { name: 'researcher' })
  expect(researcher).toBeChecked()
  const enabled = screen.getByRole('checkbox', { name: 'settings.capability_subagents' })
  await user.click(enabled)
  expect(researcher).toBeDisabled()
  await user.click(enabled)
  expect(researcher).toBeChecked()
  expect(researcher).toBeEnabled()
})
