import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DataCleanupDialog } from './DataCleanupDialog'
import { defaultDataCleanupSelection } from './dialogTypes'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

describe('DataCleanupDialog', () => {
  it('shows total storage usage for every measurable cleanup item', async () => {
    render(
      <DataCleanupDialog
        open
        selection={defaultDataCleanupSelection()}
        busy={false}
        storageUsageLoading={false}
        usage={{
          agent_unpinned_threads: { totalBytes: 2048, approximate: true },
          memories: { totalBytes: 1024, approximate: true },
          input_history: { totalBytes: 100, approximate: false },
          cache_folder: { totalBytes: 3000, approximate: true },
          temp_folder: { totalBytes: 4000, approximate: false },
          log_folder: { totalBytes: 5000, approximate: false },
          developer_http_trace: { totalBytes: 6000, approximate: false }
        }}
        onToggle={vi.fn()}
        onToggleAll={vi.fn()}
        onClose={vi.fn()}
        onRun={vi.fn()}
      />
    )

    expect(await screen.findByText('≈ 2.00 KB')).toBeVisible()
    expect(screen.getByText('≈ 1.00 KB')).toBeVisible()
    expect(screen.getByText('100 B')).toBeVisible()
    expect(screen.getByText('≈ 2.93 KB')).toBeVisible()
    expect(screen.getByText('3.91 KB')).toBeVisible()
    expect(screen.getByText('4.88 KB')).toBeVisible()
    expect(screen.getByText('5.86 KB')).toBeVisible()
  })
})
