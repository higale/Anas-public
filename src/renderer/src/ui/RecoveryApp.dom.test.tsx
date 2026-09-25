import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RecoverySnapshot } from '@shared/recovery'
import { RecoveryApp } from './RecoveryApp'
import { InitialAppGate } from './InitialAppStatus'
import { createInitialAppLoadSnapshot } from './initialAppLoad'
import { StrictMode } from 'react'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, values?: Record<string, unknown>) => values ? `${key} ${Object.values(values).join(' ')}` : key })
}))

const snapshot: RecoverySnapshot = {
  dataDir: '/test/data', logDir: '/test/data/log', preservationParent: '/test',
  catalogPath: '/test/data/sqlite/catalog.sqlite', conversationsPath: '/test/data/sqlite/conversations',
  startupError: 'Malformed /test/data/config/settings.json', canModify: true,
  files: [
    { name: 'settings.json', path: '/test/data/config/settings.json', error: 'Unexpected token', repairableFields: [] },
    { name: 'subagents.json', path: '/test/data/config/subagents.json', repairableFields: ['subagents.json: subagents[0].capabilities.skills'] },
    { name: 'models.json', path: '/test/data/config/models.json', repairableFields: [] },
    { name: 'projects.json', path: '/test/data/projects.json', error: 'Invalid project', repairableFields: [] }
  ]
}
const api = { inspect: vi.fn(), reset: vi.fn(), enter: vi.fn(), restart: vi.fn(), openDirectory: vi.fn(), resetProjects: vi.fn(), repair: vi.fn() }
beforeEach(() => {
  vi.resetAllMocks()
  api.inspect.mockResolvedValue(snapshot)
  Object.defineProperty(window, 'gale', { configurable: true, value: { recovery: api } })
})

describe('RecoveryApp', () => {
  it('shows only affected files, with inline actions and collapsed diagnostics, without generic choices', async () => {
    render(<RecoveryApp />)
    expect(await screen.findByRole('group', { name: 'settings.json' })).toBeVisible()
    expect(screen.queryByRole('group', { name: 'models.json' })).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'recovery.restore' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'recovery.preserve' })).not.toBeInTheDocument()
    expect(screen.getByText('recovery.details').closest('details')).not.toHaveAttribute('open')
    expect(within(screen.getByRole('group', { name: 'settings.json' })).queryByRole('button', { name: 'recovery.repair' })).not.toBeInTheDocument()
  })

  it('confirms repair for only the clicked file and leaves other failures actionable', async () => {
    const user = userEvent.setup()
    api.repair.mockImplementation(async () => {
      api.inspect.mockResolvedValue({ ...snapshot, files: snapshot.files.map((file) => file.name === 'subagents.json' ? { ...file, repairableFields: [] } : file) })
      return { repaired: ['subagents.json: subagents[0].capabilities.skills'], unresolved: [] }
    })
    render(<RecoveryApp />)
    await user.click(within(await screen.findByRole('group', { name: 'subagents.json' })).getByRole('button', { name: 'recovery.repair' }))
    expect(api.repair).not.toHaveBeenCalled()
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('/test/data/config/subagents.json')
    await user.click(within(dialog).getByRole('button', { name: 'recovery.repair' }))
    await waitFor(() => expect(api.repair).toHaveBeenCalledExactlyOnceWith('subagents.json'))
    expect(await screen.findByText('recovery.file_repaired')).toBeVisible()
    expect(within(screen.getByRole('group', { name: 'settings.json' })).getByRole('button', { name: 'recovery.reset' })).toBeEnabled()
    await user.click(screen.getByText('recovery.details'))
    expect((screen.getByRole('textbox', { name: 'recovery.details' }) as HTMLTextAreaElement).value).toContain('subagents[0].capabilities.skills')
    expect(api.reset).not.toHaveBeenCalled()
    expect(api.resetProjects).not.toHaveBeenCalled()
  })

  it('requires destructive confirmation for the exact file, and supports cancel', async () => {
    const user = userEvent.setup()
    api.reset.mockImplementation(async () => {
      api.inspect.mockResolvedValue({ ...snapshot, files: snapshot.files.map((file) => file.name === 'settings.json' ? { ...file, error: undefined } : file) })
    })
    render(<RecoveryApp />)
    const row = within(await screen.findByRole('group', { name: 'settings.json' }))
    await user.click(row.getByRole('button', { name: 'recovery.reset' }))
    expect(screen.getByRole('alertdialog')).toHaveTextContent('/test/data/config/settings.json')
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'common.cancel' }))
    expect(api.reset).not.toHaveBeenCalled()
    await user.click(row.getByRole('button', { name: 'recovery.reset' }))
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'recovery.reset' }))
    await waitFor(() => expect(api.reset).toHaveBeenCalledExactlyOnceWith('settings.json'))
    expect(await screen.findByText('recovery.file_reset')).toBeVisible()
  })

  it('identifies the catalog and conversation directory before resetting projects and does not offer the action again', async () => {
    const user = userEvent.setup()
    render(<RecoveryApp />)
    const row = within(await screen.findByRole('group', { name: 'projects.json' }))
    await user.click(row.getByRole('button', { name: 'recovery.reset' }))
    const dialog = screen.getByRole('alertdialog')
    expect(dialog).toHaveTextContent('/test/data/projects.json')
    expect(dialog).toHaveTextContent('/test/data/sqlite/catalog.sqlite')
    expect(dialog).toHaveTextContent('/test/data/sqlite/conversations')
    await user.click(within(dialog).getByRole('button', { name: 'recovery.reset_projects_confirm_button' }))
    await waitFor(() => expect(api.resetProjects).toHaveBeenCalledOnce())
    expect(row.queryByRole('button')).not.toBeInTheDocument()
    expect(api.reset).not.toHaveBeenCalled()
  })

  it('leaves unresolved repairs actionable and retains the preservation location in details', async () => {
    const user = userEvent.setup()
    api.repair.mockResolvedValue({ repaired: [], unresolved: ['File changed since inspection'] })
    api.inspect.mockResolvedValue({ ...snapshot, lastPreservationPath: '/test/preserved' })
    render(<RecoveryApp />)
    await user.click(await screen.findByRole('button', { name: 'recovery.repair' }))
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'recovery.repair' }))
    expect(await screen.findByText('File changed since inspection')).toBeVisible()
    expect(screen.getByRole('button', { name: 'recovery.repair' })).toBeEnabled()
    await user.click(screen.getByText('recovery.details'))
    expect(screen.getByText('recovery.saved_at /test/preserved')).toBeVisible()
  })

  it('disables file actions until writers have stopped', async () => {
    api.inspect.mockResolvedValue({ ...snapshot, canModify: false, stopError: 'run active' })
    render(<RecoveryApp />)
    await screen.findByText('recovery.stop_failed')
    for (const button of screen.getAllByRole('button', { name: /recovery.reset$|recovery.repair$/ })) expect(button).toBeDisabled()
    expect(screen.getByRole('button', { name: 'recovery.restart' })).toBeEnabled()
  })

  it('automatically enters file recovery once after both critical resources settle, including StrictMode', async () => {
    const state = createInitialAppLoadSnapshot()
    state.projects = { phase: 'error', error: 'bad projects.json' }
    state.config = { phase: 'loading' }
    const view = render(<StrictMode><InitialAppGate snapshot={state} /></StrictMode>)
    expect(api.enter).not.toHaveBeenCalled()
    const failed = { ...state, config: { phase: 'error' as const, error: 'bad settings.json' } }
    view.rerender(<StrictMode><InitialAppGate snapshot={failed} /></StrictMode>)
    await waitFor(() => expect(api.enter).toHaveBeenCalledOnce())
    expect(api.enter).toHaveBeenCalledWith(expect.stringContaining('bad projects.json'))
    expect(api.enter).toHaveBeenCalledWith(expect.stringContaining('bad settings.json'))
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('allows retry when automatic recovery navigation fails without retrying endlessly', async () => {
    const user = userEvent.setup()
    const state = createInitialAppLoadSnapshot()
    state.projects = { phase: 'ready' }
    state.config = { phase: 'error', error: 'bad settings.json' }
    api.enter.mockRejectedValueOnce(new Error('navigation failed')).mockResolvedValue(undefined)
    render(<StrictMode><InitialAppGate snapshot={state} /></StrictMode>)
    expect(await screen.findByText('navigation failed')).toBeVisible()
    expect(api.enter).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: 'common.reload' }))
    await waitFor(() => expect(api.enter).toHaveBeenCalledTimes(2))
  })

  it('does not enter recovery for optional resource failures', () => {
    const state = createInitialAppLoadSnapshot()
    state.projects = { phase: 'ready' }
    state.config = { phase: 'ready' }
    state.icon = { phase: 'error', error: 'optional icon unavailable' }
    const view = render(<InitialAppGate snapshot={state} />)
    expect(api.enter).not.toHaveBeenCalled()
    expect(view.container).toBeEmptyDOMElement()
  })
})
