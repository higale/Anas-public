import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeveloperActions } from './DeveloperActions'

const mocks = vi.hoisted(() => ({ toggle: vi.fn(), restart: vi.fn(), error: vi.fn() }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../notice', () => ({ notice: { error: mocks.error } }))

beforeEach(() => {
  mocks.toggle.mockResolvedValue(undefined)
  mocks.restart.mockResolvedValue(undefined)
  Object.defineProperty(window, 'gale', { configurable: true, value: {
    app: { toggleDevTools: mocks.toggle, restartInConsole: mocks.restart }
  } })
})

describe('DeveloperActions', () => {
  it('opens DevTools without restarting and prevents repeated restart clicks', async () => {
    render(<DeveloperActions />)
    fireEvent.click(screen.getByRole('button', { name: 'menu.toggle_dev_tools' }))
    expect(mocks.toggle).toHaveBeenCalledOnce()
    expect(mocks.restart).not.toHaveBeenCalled()
    const restart = screen.getByRole('button', { name: 'settings.start_in_console' })
    fireEvent.click(restart)
    fireEvent.click(restart)
    expect(restart).toBeDisabled()
    await waitFor(() => expect(mocks.restart).toHaveBeenCalledOnce())
  })

  it('shows the actual restart failure and allows another attempt', async () => {
    mocks.restart.mockRejectedValueOnce(new Error('Terminal executable is missing.'))
    render(<DeveloperActions />)
    const restart = screen.getByRole('button', { name: 'settings.start_in_console' })
    fireEvent.click(restart)
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith(
      'settings.failed_restart_in_console\nTerminal executable is missing.'
    ))
    expect(restart).toBeEnabled()
    fireEvent.click(restart)
    await waitFor(() => expect(mocks.restart).toHaveBeenCalledTimes(2))
  })
})
