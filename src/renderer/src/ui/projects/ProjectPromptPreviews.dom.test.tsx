import { diffViewSettingsFixture } from '../../../../test/diffViewSettingsFixture'
import { environmentContextFixture } from '../../../../test/environmentContextFixture'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultCapabilities } from '@shared/agentCapabilities'
import type { WorkspaceProjectRequest, AppSettings, GaleApi } from '@shared/types'
import { ProjectPromptPreviews } from './ProjectPromptPreviews'

const contextMocks = vi.hoisted(() => ({
  preview: vi.fn(),
  previewModelRequest: vi.fn(),
  saveModelRequest: vi.fn()
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('../notice', () => ({
  notice: { error: vi.fn(), success: vi.fn() }
}))

const settings = {
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
} satisfies AppSettings

const project: WorkspaceProjectRequest = { kind: 'workspace', name: 'Draft', sourceFolders: ['C:/draft'], prompt: 'Unsaved prompt', advancedSettings: true, codingMode: false, capabilities: defaultCapabilities, restrictSubagents: false, modelConfigId: 'model-2', modelParameterPresetId: 'preset-2' }

describe('model request preview', () => {
  beforeEach(() => {
    contextMocks.preview.mockReset()
    contextMocks.previewModelRequest.mockReset()
    contextMocks.saveModelRequest.mockReset()
    Object.defineProperty(window, 'gale', {
      configurable: true,
      value: {
        agent: { context: contextMocks }
      } as unknown as GaleApi
    })
  })

  it('shows and saves the complete captured request including credentials', async () => {
    const content = JSON.stringify({
      request: {
        headers: { authorization: 'Bearer complete-api-key' },
        body: { messages: [{ role: 'user', content: 'hello world' }] }
      }
    }, null, 2)
    contextMocks.previewModelRequest.mockResolvedValue({ content })
    contextMocks.saveModelRequest.mockResolvedValue('/tmp/model-request.json')
    render(
      <ProjectPromptPreviews
        project={project}
        settings={settings}
        projectId="0"
      />
    )

    await userEvent.click(screen.getByRole('button', { name: 'settings.view_model_request' }))

    expect(await screen.findByText(/Bearer complete-api-key/)).toBeInTheDocument()
    expect(contextMocks.previewModelRequest).toHaveBeenCalledWith({
      projectId: '0',
      project,
      settings
    })

    await userEvent.click(screen.getByRole('button', { name: 'common.save' }))
    expect(contextMocks.saveModelRequest).toHaveBeenCalledWith(content)
  })

  it('uses the current coding mode in the open compression preview', async () => {
    const props = { settings, projectId: 'project', project }
    const view = render(<ProjectPromptPreviews {...props} />)
    await userEvent.click(screen.getByRole('button', { name: 'settings.view_context_compression_prompt' }))
    const preview = screen.getByText(/You are a conversation summarizer/)
    expect(preview).not.toHaveTextContent('Coding continuation handoff:')
    view.rerender(<ProjectPromptPreviews {...props} project={{ ...project, codingMode: true }} />)
    expect(preview).toHaveTextContent('Coding continuation handoff:')
    view.rerender(<ProjectPromptPreviews {...props} />)
    expect(preview).not.toHaveTextContent('Coding continuation handoff:')
  })

  it.each([
    ['preview', 'settings.view_effective_system_context'],
    ['previewModelRequest', 'settings.view_model_request']
  ] as const)('refreshes %s on a coding mode change and ignores the stale result', async (method, label) => {
    let resolveOld!: (value: { content: string }) => void
    contextMocks[method].mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve }))
      .mockResolvedValueOnce({ content: '<coding_instruction>Current coding preview</coding_instruction>' })
    const props = { settings, projectId: 'project', project }
    const view = render(<ProjectPromptPreviews {...props} />)
    await userEvent.click(screen.getByRole('button', { name: label }))
    await waitFor(() => expect(contextMocks[method]).toHaveBeenCalledOnce())
    view.rerender(<ProjectPromptPreviews {...props} project={{ ...project, codingMode: true }} />)
    expect(await screen.findByText(/Current coding preview/)).toBeInTheDocument()
    await act(async () => { resolveOld({ content: 'Stale ordinary preview' }) })
    expect(screen.queryByText('Stale ordinary preview')).not.toBeInTheDocument()
    expect(contextMocks[method]).toHaveBeenCalledTimes(2)
  })
})
