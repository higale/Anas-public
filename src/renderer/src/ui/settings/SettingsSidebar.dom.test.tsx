import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { SettingsSidebarContent } from './SettingsSidebar'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

describe('settings sidebar', () => {
  it('opens one General page for profiles, appearance, and data', async () => {
    const user = userEvent.setup()
    const onSelectTab = vi.fn()
    render(<SettingsSidebarContent activeTab="model" onSelectTab={onSelectTab} />)

    const general = screen.getByRole('button', { name: /settings\.tabs\.general/ })
    expect(screen.queryByRole('button', { name: /settings\.tabs\.(appearance|local_data)/ })).not.toBeInTheDocument()

    await user.click(general)
    expect(onSelectTab).toHaveBeenCalledWith('general')
  })
})
