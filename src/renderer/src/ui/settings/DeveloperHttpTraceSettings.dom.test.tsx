import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { DeveloperHttpTraceSettings } from './DeveloperHttpTraceSettings'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

describe('DeveloperHttpTraceSettings', () => {
  it('updates the developer HTTP trace switch and opens its directory', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    const onOpenDirectory = vi.fn()
    render(
      <DeveloperHttpTraceSettings
        enabled={false}
        storageUsageLoading={false}
        usage={{ totalBytes: 1536, approximate: false }}
        onChange={onChange}
        onOpenDirectory={onOpenDirectory}
      />
    )

    const checkbox = screen.getByRole('checkbox', { name: 'settings.developer_http_trace_enabled' })
    expect(checkbox.closest('.ui-form-row')).toHaveClass('ui-form-row-fit-control')
    expect(checkbox.closest('label')).toHaveClass('ui-form-row-control-end')
    const usage = screen.getByText('1.50 KB')
    expect(usage).toBeVisible()
    expect(usage.parentElement).toHaveClass('ui-row')
    expect(usage.parentElement).toContainElement(
      screen.getByRole('button', { name: 'settings.open_developer_http_trace_folder' })
    )
    await user.click(checkbox)
    expect(onChange).toHaveBeenCalledWith(true)

    await user.click(screen.getByRole('button', { name: 'settings.open_developer_http_trace_folder' }))
    expect(onOpenDirectory).toHaveBeenCalledOnce()
  })
})
