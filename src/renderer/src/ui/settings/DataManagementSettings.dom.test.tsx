import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DataManagementSettings } from './DataManagementSettings'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

describe('DataManagementSettings', () => {
  it('places data directory usage beside its trailing action', () => {
    render(
      <DataManagementSettings
        dataDirectoryUsage={{ totalBytes: 1536, approximate: false }}
        storageUsageLoading={false}
        onBackupDataDirectory={vi.fn()}
        onOpenDataCleanup={vi.fn()}
        onOpenDataDirectory={vi.fn()}
        onRestoreDataDirectory={vi.fn()}
      />
    )

    const usage = screen.getByText('1.50 KB')
    const actionRow = usage.parentElement
    expect(actionRow).toHaveClass('ui-row')
    expect(actionRow).toContainElement(screen.getByRole('button', { name: 'common.open' }))
    expect(screen.getByText('settings.data_directory').parentElement).not.toContainElement(usage)
  })
})
