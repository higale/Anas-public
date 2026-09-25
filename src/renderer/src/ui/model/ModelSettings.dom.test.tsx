import { defaultCapabilitySettings } from '@shared/agentCapabilities'
import { diffViewSettingsFixture } from '../../../../test/diffViewSettingsFixture'
import { environmentContextFixture } from '../../../../test/environmentContextFixture'
import { createRef } from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { AppConfigSnapshot } from '@shared/types'
import { ModelSettings } from './ModelSettings'
import { emptyModelDraft } from './modelDraft'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

const emptyConfig = { customTools: [],
  defaultCapabilities: structuredClone(defaultCapabilitySettings),
  providers: [],
  subagents: [],
  mcpServers: [],
  settings: {
    profile: {
      assistant: { name: 'Ananas', role: '', instructions: '', newAvatarPath: '' },
      user: { preferredName: '', personalInfo: '' }
    },
    speechReply: { enabled: false, voice: '', speed: 1 },
    language: 'en',
    theme: 'dark',
    fontSize: 14,
    chatContentWidth: 'narrow',
    newThreadModelSelection: 'default',
    attachmentTextMaxChars: 200_000,
    attachmentTextOverflow: 'truncate',
    logLevel: 'info',
    logRetentionDays: 14,
    maxModelCallsPerRun: 100,
    environmentContext: environmentContextFixture(),
    sidebarVisible: true,
    sidebarWidth: 260,
      workspacePanelWidth: 480, ...diffViewSettingsFixture,
    sidebarCollapsedSections: { projects: false, simpleChats: false },
    backupDir: ''
  }
} satisfies AppConfigSnapshot

describe('empty model settings', () => {
  it('hides the unbound editor until a provider exists', () => {
    render(
      <ModelSettings
        candidates={[]}
        config={emptyConfig}
        listLoading={false}
        listRef={createRef<HTMLDivElement>()}
        modelDraft={emptyModelDraft()}
        sectionClass="settings-workbench ui-workbench ui-grid-sidebar"
        onCreateModel={vi.fn()}
        onAddProviderModel={vi.fn()}
        onAddProviderModels={vi.fn()}
        onDeleteProviderModel={vi.fn()}
        onDeleteModel={vi.fn()}
        onEditModel={vi.fn()}
        onMoveModel={vi.fn()}
        onMoveProviderModel={vi.fn()}
        onSelectProviderModel={vi.fn()}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={vi.fn()}
        onUpdateParameters={vi.fn()}
      />
    )

    expect(screen.queryByLabelText('settings.name')).not.toBeInTheDocument()
    const emptyState = screen.getByText('settings.add_provider_to_configure')
    expect(emptyState).toBeInTheDocument()
    expect(emptyState).toBeVisible()
    expect(screen.queryByRole('heading', { name: 'settings.model' })).not.toBeInTheDocument()
  })
})
