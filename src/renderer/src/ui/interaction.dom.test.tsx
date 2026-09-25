import { ProjectOperationFailure } from '@shared/projectOperation'
import { PROJECT_ICON_NAMES } from '@shared/projectAppearance'
import { defaultCapabilities, } from '@shared/agentCapabilities'
import axe from 'axe-core'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef, useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_WORKSPACE_PROJECT_ID, type AppConfigSnapshot, type Project, type SelectedAttachment } from '@shared/types'
import type { AgentSystemContextPreviewInput, AgentThread } from '@shared/agentTypes'
import { AgentTaskPlan } from './agent/AgentTaskPlan'
import { ThreadTopbar } from './agent/ThreadTopbar'
import { ThreadList } from './agent/ThreadList'
import { ThreadSidebarContent, ThreadSidebarFooter } from './agent/ThreadSidebar'
import { AttachmentGrid } from './chat/AttachmentGrid'
import { ModelPicker } from './model/ModelPicker'
import { ModelParameterPresetPicker } from './model/ModelParameterPresetPicker'
import { ComposerAccessPicker } from './chat/ComposerAccessPicker'
import { ProjectDialog } from './projects/ProjectDialog'
import { notice } from './notice'
import { ProjectGroup } from './projects/ProjectGroup'
import { ProjectDetailsMenu, ProjectDetailsContextMenu } from './projects/ProjectDetailsMenu'
import { ThreadActionsMenu, ThreadActionsContextMenu } from './agent/ThreadActionsMenu'
import { formatDateTime } from './formatDateTime'
import { NoFocusButton } from './NoFocusButton'
import { installNativeContextMenuPolicy } from '../nativeContextMenuPolicy'

const capabilityApis = {
  tools: { get: vi.fn(async () => ({ roots: [], tools: [] })) },
  skills: { get: vi.fn(async () => ({ roots: [], skills: [] })) },
  mcp: { status: vi.fn(async () => null), onStatus: vi.fn(() => () => {}) },
  app: { getRuntimeTools: vi.fn(async () => ({ checkedAt: '', tools: [], toolNames: [] })) }
}
vi.mock('./notice', () => ({ notice: { error: vi.fn() } }))
beforeEach(() => {
  delete document.documentElement.dataset.platform
  Object.defineProperty(window, 'gale', { configurable: true, value: { ...capabilityApis } })
})

vi.mock('react-i18next', () => {
  const t = (key: string, options?: { name?: string }) => {
      if (key === 'project.untitled_name') return '未命名项目'
      if ((key === 'project.expand_section' || key === 'project.collapse_section') && options?.name) {
        return `${key}:${options.name}`
      }
      return key
  }
  return { useTranslation: () => ({ t }) }
})

function AppMenuFixture() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button type="button">outside target</button>
      <ThreadSidebarFooter
        appMenuOpen={open}
        onAppMenuOpenChange={setOpen}
        onOpenHelp={vi.fn()}
        onOpenSettings={vi.fn()}
        onQuit={vi.fn()}
        onShowAbout={vi.fn()}
      />
    </>
  )
}

function ModelPickerFixture() {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  return (
    <>
      <textarea ref={inputRef} aria-label="composer input" />
      <ModelPicker
        providers={undefined} selectedId={undefined}
        disabled={false}
        focusRef={inputRef}
        onOpenModelSettings={vi.fn()}
        onSelect={vi.fn()}
        onSetDefault={vi.fn()}
      />
      <button type="button">model picker outside target</button>
    </>
  )
}

function modelPickerConfig(withReasoningOptions = false): AppConfigSnapshot {
  const model = {
    id: 'model-1',
    index: 0,
    displayName: 'Friendly model',
    model: 'model-one',
    parameters: {},
    parameterPresetMode: withReasoningOptions ? 'custom' as const : 'none' as const,
    parameterPresets: withReasoningOptions
      ? [
          { id: 'thinking-on', name: '思考开启', parameters: { enable_thinking: true } },
          { id: 'thinking-off', name: '思考关闭', parameters: { enable_thinking: false } }
        ]
      : [],
    capabilities: { vision: true, toolUse: true },
    stream: true,
    maxContextTokens: 128_000,
    maxOutputTokens: 16_000,
    contextCompressionThreshold: 0.8,
    contextCompressionEnabled: true
  }
  return {
    settings: {},
    mcpServers: [],
    providers: [{
      id: 'provider-1',
      index: 0,
      name: 'Provider',
      protocol: 'openai_chat_completions',
      baseUrl: 'https://example.com/v1',
      modelListUrl: 'https://example.com/v1/models',
      modelListAuth: 'bearer',
      parameters: {},
      models: [model]
    }],
    defaultModelId: model.id,
    defaultModel: {
      ...model,
      providerId: 'provider-1',
      providerName: 'Provider',
      protocol: 'openai_chat_completions',
      baseUrl: 'https://example.com/v1'
    }
  } as unknown as AppConfigSnapshot
}

function AccordionModelPickerFixture() {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const config = modelPickerConfig()
  const firstProvider = config.providers[0]
  const secondModel = {
    ...firstProvider.models[0],
    id: 'model-2',
    displayName: 'Second model',
    model: 'model-two'
  }
  config.providers = [firstProvider, {
    ...firstProvider,
    id: 'provider-2',
    index: 1,
    name: 'Second Provider',
    models: [secondModel]
  }]
  config.defaultModelId = secondModel.id
  config.defaultModel = {
    ...secondModel,
    providerId: 'provider-2',
    providerName: 'Second Provider',
    protocol: 'openai_chat_completions',
    baseUrl: 'https://example.com/v1'
  }
  return (
    <ModelPicker
      providers={config?.providers} selectedId={config?.defaultModel?.id}
      disabled={false}
      focusRef={inputRef}
      onOpenModelSettings={vi.fn()}
      onSelect={vi.fn()}
      onSetDefault={vi.fn()}
    />
  )
}

describe('renderer interaction accessibility', () => {
  it('previews unsaved project edits and closes only the preview on Escape', async () => {
    const preview = vi.fn(async (_input: AgentSystemContextPreviewInput) => ({ content: 'Preview from draft' }))
    Object.defineProperty(window, 'gale', { configurable: true, value: { ...capabilityApis, agent: { context: { preview } } } })
    const user = userEvent.setup()
    const onSave = vi.fn()
    const onClose = vi.fn()
    render(<ProjectDialog open kind="simple_chat" project={preferredProject} config={modelPickerConfig(true)} onClose={onClose} onSave={onSave} />)
    const input = screen.getByLabelText('project.simple_chat_prompt')
    await user.type(input, 'Unsaved instructions')
    await user.click(screen.getByRole('button', { name: 'settings.view_effective_system_context' }))
    expect(await screen.findByText('Preview from draft')).toBeInTheDocument()
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({
      projectId: preferredProject.id,
      project: expect.objectContaining({ prompt: 'Unsaved instructions', modelConfigId: 'model-1', modelParameterPresetId: 'thinking-off' })
    }))
    await user.keyboard('{Escape}')
    expect(screen.queryByText('Preview from draft')).not.toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
    expect(input).toHaveValue('Unsaved instructions')
    await user.click(screen.getByRole('button', { name: 'common.save' }))
    expect(onSave).toHaveBeenCalledWith(preview.mock.calls[0][0].project)
  })

  const preferredProject: Project = {
    id: 'project-preference', kind: 'simple_chat', name: 'Preferred project', prompt: '',
    pinned: false, collapsed: false, createdAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z',
    modelConfigId: 'model-1', modelParameterPresetId: 'thinking-off'
  }

  it.each(['workspace', 'simple_chat'] as const)('aligns model/reasoning with the %s content heading', (kind) => {
    render(<ProjectDialog open kind={kind} config={modelPickerConfig(true)} onClose={vi.fn()} onSave={vi.fn()} />)
    const label = screen.getByText(kind === 'simple_chat' ? 'project.simple_chat_prompt' : 'project.source_folders')
    const header = label.parentElement!
    expect(header).toHaveClass('ui-row-between')
    expect(within(header).getByRole('button', { name: 'chat.select_model' })).toBeInTheDocument()
    expect(label.nextElementSibling).toHaveClass('composer-model-selection-group')
    expect(header.closest('label')).toBeNull()
    if (kind === 'simple_chat') {
      expect(screen.getByRole('textbox', { name: 'project.simple_chat_prompt' })).toBeVisible()
    }
  })

  it.each(['workspace', 'simple_chat'] as const)('keeps the %s project dialog and edits when clicking outside, but allows explicit dismissal', async (kind) => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const project: Project = kind === 'simple_chat'
      ? preferredProject
      : {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, ...preferredProject, kind: 'workspace', sourceFolders: ['D:/project'] }
    render(<ProjectDialog open kind={kind} project={project} config={modelPickerConfig(true)}
      onClose={onClose} onSave={vi.fn()} />)
    const nameInput = screen.getByRole('textbox', { name: 'project.name' })
    await user.clear(nameInput)
    await user.type(nameInput, 'Unsaved project name')
    await user.click(document.querySelector('.ui-backdrop')!)
    expect(onClose).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeVisible()
    expect(nameInput).toHaveValue('Unsaved project name')

    await user.click(screen.getByRole('button', { name: 'chat.select_model' }))
    await screen.findByRole('menu')
    await user.click(document.querySelector('.ui-backdrop')!)
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(onClose).not.toHaveBeenCalled()
    expect(nameInput).toHaveValue('Unsaved project name')

    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
    onClose.mockClear()
    await user.click(screen.getByRole('button', { name: 'common.cancel' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('uses the same two direct model/reasoning segments in project settings without global actions', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(preferredProject)
    render(<ProjectDialog open kind="simple_chat" project={preferredProject}
      config={modelPickerConfig(true)} onClose={vi.fn()} onSave={onSave} />)
    const modelButton = screen.getByRole('button', { name: 'chat.select_model' })
    const reasoningButton = screen.getByRole('button', { name: 'chat.select_model_parameter_preset' })
    expect(modelButton).toHaveTextContent('Friendly model')
    expect(reasoningButton).toHaveTextContent('思考关闭')
    expect(modelButton.parentElement).toBe(reasoningButton.parentElement)
    expect(modelButton.parentElement).toHaveClass('composer-model-selection-group')
    await user.click(modelButton)
    expect(screen.queryByRole('menuitem', { name: 'chat.model_settings' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'chat.set_default_model' })).not.toBeInTheDocument()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(modelButton).toHaveFocus())
    await user.click(reasoningButton)
    await user.click(screen.getByRole('menuitemradio', { name: '思考开启' }))
    await waitFor(() => expect(reasoningButton).toHaveTextContent('思考开启'))
    await waitFor(() => expect(reasoningButton).toHaveFocus())
    await user.click(screen.getByRole('button', { name: 'common.save' }))
    expect(onSave).toHaveBeenCalledWith({
      kind: 'simple_chat', name: preferredProject.name, prompt: '',
      modelConfigId: 'model-1', modelParameterPresetId: 'thinking-on'
    })
  })

  it('preserves explicit no-reasoning-selection and clears both project preferences from the model menu', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(preferredProject)
    const config = modelPickerConfig(true)
    config.providers[0].models[0].defaultParameterPresetId = 'thinking-on'
    const props = { open: true, kind: 'simple_chat' as const, config, onClose: vi.fn(), onSave }
    const project = { ...preferredProject, modelParameterPresetId: null }
    const { rerender } = render(<ProjectDialog {...props} project={project} />)
    expect(screen.getByRole('button', { name: 'chat.select_model_parameter_preset' }))
      .toHaveTextContent('chat.no_model_parameter_preset')
    await user.click(screen.getByRole('button', { name: 'common.save' }))
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ modelParameterPresetId: null }))
    rerender(<ProjectDialog {...props} project={{ ...project }} />)
    await user.click(screen.getByRole('button', { name: 'chat.select_model' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'chat.clear_model_selection' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'chat.select_model_parameter_preset' })).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'common.save' }))
    expect(onSave).toHaveBeenLastCalledWith({ kind: 'simple_chat', name: project.name, prompt: '' })
  })

  it('leaves new projects unselected and initializes reasoning when a model is picked', async () => {
    const user = userEvent.setup()
    const config = modelPickerConfig(true)
    config.providers[0].models[0].defaultParameterPresetId = 'thinking-on'
    render(<ProjectDialog open kind="simple_chat" config={config} onClose={vi.fn()} onSave={vi.fn()} />)
    const button = screen.getByRole('button', { name: 'chat.select_model' })
    expect(button).toHaveTextContent('chat.select_model')
    expect(screen.queryByRole('button', { name: 'chat.select_model_parameter_preset' })).not.toBeInTheDocument()
    await user.click(button)
    await user.click(screen.getByRole('menuitemradio', { name: /Friendly model/ }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'chat.select_model_parameter_preset' })).toHaveTextContent('思考开启'))
  })

  it('lets users clear unavailable project models even when the provider list is empty', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn().mockResolvedValue(preferredProject)
    render(<ProjectDialog open kind="simple_chat" project={preferredProject}
      config={{ ...modelPickerConfig(), providers: [] }} onClose={vi.fn()} onSave={onSave} />)
    await user.click(screen.getByRole('button', { name: 'chat.select_model' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'chat.clear_model_selection' }))
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'common.save' }))
    expect(onSave).toHaveBeenCalledWith({ kind: 'simple_chat', name: preferredProject.name, prompt: '' })
  })

  it.each([
    ['win32', '_win32'],
    ['darwin', '_darwin'],
    ['linux', '']
  ])('shows access modes with current system hints on %s and supports changing access', async (platform, hintSuffix) => {
    document.documentElement.dataset.platform = platform
    const onChange = vi.fn()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    render(
      <ComposerAccessPicker
        accessMode="read_only_allowed"
        disabled={false}
        onChange={onChange}
      />
    )

    expect(screen.getByText('chat.access_read_only_allowed')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'chat.access_mode' }))
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      `chat.access_strict_approvalchat.access_strict_approval_hint${hintSuffix}`,
      `chat.access_read_only_allowedchat.access_read_only_allowed_hint${hintSuffix}`,
      'chat.access_fullchat.access_full_hint'
    ])

    await userEvent.click(screen.getByRole('menuitem', { name: /chat\.access_strict_approval/ }))
    expect(onChange).toHaveBeenCalledWith('strict_approval')
  })

  it('starts a new thread without using the click event as its project', async () => {
    const user = userEvent.setup()
    const onStartNewThread = vi.fn()
    render(
      <ThreadSidebarContent
        loading={false}
        projects={[]}
        sidebarCollapsedSections={{ projects: false, simpleChats: false }}
        threads={[]}
        onDeleteProject={vi.fn()}
        onDeleteProjectThreads={vi.fn()}
        onDeleteThread={vi.fn()}
        onEditProject={vi.fn()}
        onOpenThread={vi.fn()}
        onRenameThread={vi.fn()}
        onStartNewThread={onStartNewThread}
        onStartProjectThread={vi.fn()}
        onToggleSidebarSection={vi.fn()}
        onToggleProjectCollapsed={vi.fn()}
        onToggleProjectPinned={vi.fn()}
        onTogglePinned={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: 'chat.new_thread' }))

    expect(onStartNewThread).toHaveBeenCalledWith()
  })

  it('keeps focus on the input when a no-focus action is clicked', async () => {
    const user = userEvent.setup()
    render(
      <>
        <textarea aria-label="focus owner" />
        <NoFocusButton type="button">no-focus action</NoFocusButton>
      </>
    )
    const input = screen.getByRole('textbox', { name: 'focus owner' })
    const action = screen.getByRole('button', { name: 'no-focus action' })

    input.focus()
    await user.click(action)

    expect(action).toHaveAttribute('tabindex', '-1')
    expect(input).toHaveFocus()
  })

  it('keeps the app menu trigger out of sequential keyboard focus', async () => {
    const user = userEvent.setup()
    render(<AppMenuFixture />)
    const trigger = screen.getByRole('button', { name: 'settings.title' })
    const outsideTarget = screen.getByRole('button', { name: 'outside target' })

    await user.tab()
    expect(outsideTarget).toHaveFocus()
    await user.tab()
    expect(trigger).not.toHaveFocus()
  })

  it('keeps pointer focus on the outside target when dismissing the app menu', async () => {
    const user = userEvent.setup()
    render(<AppMenuFixture />)
    const trigger = screen.getByRole('button', { name: 'settings.title' })
    const outsideTarget = screen.getByRole('button', { name: 'outside target' })

    await user.click(trigger)
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    await user.click(outsideTarget)

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(outsideTarget).toHaveFocus()
    expect(trigger).not.toHaveFocus()
  })

  it('does not restore trigger focus when the app menu closes with Escape', async () => {
    const user = userEvent.setup()
    render(<AppMenuFixture />)
    const trigger = screen.getByRole('button', { name: 'settings.title' })

    await user.click(trigger)
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    await user.keyboard('{Escape}')

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(trigger).not.toHaveFocus()
  })

  it('does not focus the app menu trigger when clicking it to close the menu', async () => {
    const user = userEvent.setup()
    render(<AppMenuFixture />)
    const trigger = screen.getByRole('button', { name: 'settings.title' })

    await user.click(trigger)
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    await user.click(trigger)

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(trigger).not.toHaveFocus()
  })

  it('returns focus to the owning input when its menu closes from an outside click', async () => {
    const user = userEvent.setup()
    render(<ModelPickerFixture />)
    const input = screen.getByRole('textbox', { name: 'composer input' })

    await user.click(screen.getByRole('button', { name: 'chat.select_model' }))
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'model picker outside target' }))

    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(input).toHaveFocus()
  })

  it.each(['model', 'reasoning'] as const)('preserves outside input focus for the project %s menu and restores the trigger otherwise', async (kind) => {
    const user = userEvent.setup()
    const config = modelPickerConfig(true)
    render(
      <>
        <input aria-label="project name" />
        {kind === 'model'
          ? <ModelPicker providers={config.providers} disabled={false} onSelect={vi.fn()} />
          : <ModelParameterPresetPicker model={config.defaultModel} disabled={false} onSelect={vi.fn()} />}
      </>
    )
    const trigger = screen.getByRole('button')
    const input = screen.getByRole('textbox', { name: 'project name' })
    await user.click(trigger)
    await screen.findByRole('menu')
    await user.click(input)
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(input).toHaveFocus()
    await user.keyboard('Project')
    expect(input).toHaveValue('Project')

    await user.click(trigger)
    await screen.findByRole('menu')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(trigger).toHaveFocus())

    await user.click(trigger)
    await screen.findByRole('menu')
    await user.click(screen.getAllByRole('menuitemradio')[0])
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(trigger).toHaveFocus()
  })

  it('opens the selected provider and allows every provider to be collapsed', async () => {
    const user = userEvent.setup()
    render(<AccordionModelPickerFixture />)
    const trigger = screen.getByRole('button', { name: 'chat.select_model' })

    await user.click(trigger)
    const firstProvider = await screen.findByRole('menuitem', { name: 'Provider' })
    const selectedProvider = screen.getByRole('menuitem', {
      name: 'Second Provider'
    })
    expect(firstProvider).toHaveAttribute('aria-expanded', 'false')
    expect(selectedProvider).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menuitemradio')).toHaveTextContent('Second model')

    await user.click(firstProvider)
    expect(screen.getByRole('menuitem', { name: 'Provider' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menuitem', { name: 'Second Provider' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('menuitemradio')).toHaveTextContent('Friendly model')

    await user.click(screen.getByRole('menuitem', { name: 'Provider' }))
    expect(screen.getByRole('menuitem', { name: 'Provider' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('menuitem', { name: 'Second Provider' })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument()
    expect(screen.getByRole('menu')).toBeVisible()

    screen.getByRole('menuitem', { name: 'Provider' }).focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('menuitemradio')).toHaveTextContent('Friendly model')
    await user.keyboard('{Enter}')
    expect(screen.queryByRole('menuitemradio')).not.toBeInTheDocument()

    await user.keyboard('{Escape}')
    await user.click(trigger)
    expect(await screen.findByRole('menuitem', { name: 'Second Provider' }))
      .toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menuitemradio')).toHaveTextContent('Second model')
  })

  it('opens the first provider when no model is selected', async () => {
    const user = userEvent.setup()
    const config = modelPickerConfig()
    config.defaultModelId = undefined
    config.defaultModel = undefined
    const inputRef = { current: document.createElement('textarea') }
    render(
      <ModelPicker
        providers={config.providers}
        disabled={false}
        focusRef={inputRef}
        onOpenModelSettings={vi.fn()}
        onSelect={vi.fn()}
        onSetDefault={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: 'chat.select_model' }))
    expect(await screen.findByRole('menuitem', { name: 'Provider' }))
      .toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('menuitemradio')).toHaveTextContent('Friendly model')
  })

  it('places model settings on the left and sets the selected model as default from the right', async () => {
    const user = userEvent.setup()
    const inputRef = { current: document.createElement('textarea') }
    const onSetDefault = vi.fn()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    render(
      <ModelPicker
        providers={modelPickerConfig(true)?.providers} selectedId={modelPickerConfig(true)?.defaultModel?.id}
        defaultModelId="another-model"
        disabled={false}
        focusRef={inputRef}
        onOpenModelSettings={vi.fn()}
        onSelect={vi.fn()}
        onSetDefault={onSetDefault}
      />
    )

    const trigger = screen.getByRole('button', { name: 'chat.select_model' })
    expect(trigger).toHaveTextContent('Friendly model')
    await user.click(trigger)
    const modelOption = await screen.findByRole('menuitemradio', { name: /Friendly model/ })
    expect(modelOption).toHaveTextContent('Friendly model')
    expect(modelOption.querySelectorAll('[data-model-status-badge]')).toHaveLength(1)
    const settings = await screen.findByRole('menuitem', { name: 'chat.model_settings' })
    const setDefault = screen.getByRole('menuitem', { name: 'chat.set_default_model' })
    expect(settings.parentElement).toHaveClass('composer-model-footer')
    expect(settings.nextElementSibling).toBe(setDefault)

    await user.click(setDefault)
    expect(onSetDefault).toHaveBeenCalledWith('model-1')
    expect(screen.getByRole('menu')).toBeVisible()
  })

  it('marks the selected model when it is already the global default', async () => {
    const user = userEvent.setup()
    const inputRef = { current: document.createElement('textarea') }
    const onSetDefault = vi.fn()
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    render(
      <ModelPicker
        providers={modelPickerConfig()?.providers} selectedId={modelPickerConfig()?.defaultModel?.id}
        defaultModelId="model-1"
        disabled={false}
        focusRef={inputRef}
        onOpenModelSettings={vi.fn()}
        onSelect={vi.fn()}
        onSetDefault={onSetDefault}
      />
    )

    await user.click(screen.getByRole('button', { name: 'chat.select_model' }))
    const clearDefault = await screen.findByRole('menuitem', { name: 'chat.clear_default_model' })
    expect(document.querySelector('.composer-model-default-marker')).toBeInTheDocument()

    await user.click(clearDefault)
    expect(onSetDefault).toHaveBeenCalledWith(null)
    expect(screen.getByRole('menu')).toBeVisible()
  })

  it('sets a model as default from its context menu without selecting it', async () => {
    const user = userEvent.setup()
    const inputRef = { current: document.createElement('textarea') }
    const onSelect = vi.fn()
    const onSetDefault = vi.fn()
    render(
      <ModelPicker
        providers={modelPickerConfig()?.providers} selectedId={modelPickerConfig()?.defaultModel?.id}
        defaultModelId="another-model"
        disabled={false}
        focusRef={inputRef}
        onOpenModelSettings={vi.fn()}
        onSelect={onSelect}
        onSetDefault={onSetDefault}
      />
    )

    await user.click(screen.getByRole('button', { name: 'chat.select_model' }))
    await user.pointer({ target: screen.getByRole('menuitemradio'), keys: '[MouseRight]' })
    const contextMenu = await waitFor(() => {
      const element = document.querySelector('.composer-model-context-menu')
      expect(element).toBeInTheDocument()
      return element as HTMLElement
    })
    expect(document.querySelector('.composer-model-menu')).toBeVisible()

    const setDefault = within(contextMenu).getByRole('menuitem', { name: 'chat.set_default_model' })
    await user.hover(setDefault)
    expect(document.querySelector('.composer-model-context-menu')).toBeVisible()
    await user.click(setDefault)
    expect(onSetDefault).toHaveBeenCalledOnce()
    expect(onSetDefault).toHaveBeenCalledWith('model-1')
    expect(onSelect).not.toHaveBeenCalled()
    await waitFor(() => expect(document.querySelector('.composer-model-context-menu')).not.toBeInTheDocument())
    expect(document.querySelector('.composer-model-menu')).toBeVisible()
  })

  it('clears the default from the default model context menu', async () => {
    const user = userEvent.setup()
    const inputRef = { current: document.createElement('textarea') }
    const onSetDefault = vi.fn()
    render(
      <ModelPicker
        providers={modelPickerConfig()?.providers} selectedId={modelPickerConfig()?.defaultModel?.id}
        defaultModelId="model-1"
        disabled={false}
        focusRef={inputRef}
        onOpenModelSettings={vi.fn()}
        onSelect={vi.fn()}
        onSetDefault={onSetDefault}
      />
    )

    await user.click(screen.getByRole('button', { name: 'chat.select_model' }))
    await user.pointer({ target: screen.getByRole('menuitemradio'), keys: '[MouseRight]' })
    const contextMenu = await waitFor(() => {
      const element = document.querySelector('.composer-model-context-menu')
      expect(element).toBeInTheDocument()
      return element as HTMLElement
    })
    expect(document.querySelector('.composer-model-menu')).toBeVisible()

    const clearDefault = within(contextMenu).getByRole('menuitem', { name: 'chat.clear_default_model' })
    await waitFor(() => expect(clearDefault).toHaveFocus())
    await user.keyboard('{Enter}')
    expect(onSetDefault).toHaveBeenCalledWith(null)
    await waitFor(() => expect(document.querySelector('.composer-model-context-menu')).not.toBeInTheDocument())
    expect(document.querySelector('.composer-model-menu')).toBeVisible()
  })

  it('keeps reasoning as a directly clickable segment and switches options', async () => {
    const user = userEvent.setup()
    const inputRef = { current: document.createElement('textarea') }
    const onSelect = vi.fn()
    const model = modelPickerConfig(true).defaultModel
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    render(
      <ModelParameterPresetPicker
        disabled={false}
        focusRef={inputRef}
        model={model}
        selectedId="thinking-on"
        onSelect={onSelect}
      />
    )

    const trigger = screen.getByRole('button', { name: 'chat.select_model_parameter_preset' })
    expect(trigger).toHaveClass('composer-model-segment')
    expect(trigger).toHaveTextContent('思考开启')
    await user.click(trigger)
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(2)
    await user.click(screen.getByRole('menuitemradio', { name: '思考关闭' }))
    expect(onSelect).toHaveBeenCalledWith('thinking-off')
  })

  it('offers no selection at the end of the reasoning list', async () => {
    const user = userEvent.setup()
    const inputRef = { current: document.createElement('textarea') }
    const onSelect = vi.fn()
    const model = modelPickerConfig(true).defaultModel
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    render(
      <ModelParameterPresetPicker
        disabled={false}
        focusRef={inputRef}
        model={model}
        selectedId="thinking-on"
        onSelect={onSelect}
      />
    )

    await user.click(screen.getByRole('button', { name: 'chat.select_model_parameter_preset' }))
    const noSelection = screen.getByRole('menuitem', { name: 'chat.no_model_parameter_preset' })
    const menuItems = screen
      .getByRole('menu')
      .querySelectorAll('[role="menuitemradio"], [role="menuitem"]')
    expect(menuItems[menuItems.length - 1]).toBe(noSelection)
    await user.click(noSelection)
    expect(onSelect).toHaveBeenLastCalledWith(null)
  })

  it('shows the unselected state in the reasoning segment', () => {
    const inputRef = { current: document.createElement('textarea') }
    render(
      <ModelParameterPresetPicker
        disabled={false}
        focusRef={inputRef}
        model={modelPickerConfig(true).defaultModel}
        onSelect={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: 'chat.select_model_parameter_preset' }))
      .toHaveTextContent('chat.no_model_parameter_preset')
  })

  it('operates the task plan popover from the keyboard and returns focus', async () => {
    const user = userEvent.setup()
    render(<AgentTaskPlan active todos={[{ content: 'Current step', status: 'in_progress' }]} />)
    const trigger = screen.getByRole('button', { name: /agent\.task_plan/ })

    trigger.focus()
    await user.keyboard('{Enter}')
    expect(await screen.findByText('Current step')).toBeVisible()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(trigger).toHaveFocus())
  })

  it('keeps attachment remove and pin actions isolated from the open action', async () => {
    const user = userEvent.setup()
    const onRemoveAttachment = vi.fn()
    const onToggleContextPolicy = vi.fn()
    const attachment: SelectedAttachment = {
      contextPolicy: 'one_turn',
      dataUri: 'data:image/png;base64,iVBORw0KGgo=',
      kind: 'image',
      mimeType: 'image/png',
      name: 'image.png',
      path: '/workspace/image.png',
      size: 12
    }
    render(
      <AttachmentGrid
        attachments={[attachment]}
        mode="composer"
        onRemoveAttachment={onRemoveAttachment}
        onToggleContextPolicy={onToggleContextPolicy}
      />
    )

    await user.click(screen.getByRole('button', { name: 'chat.remove_attachment' }))
    await user.click(screen.getByRole('button', { name: 'chat.attachment_keep_in_conversation' }))
    expect(onRemoveAttachment).toHaveBeenCalledWith(attachment.path)
    expect(onToggleContextPolicy).toHaveBeenCalledWith(attachment.path)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('keeps project collapse, pin, and new-chat actions independent', async () => {
    const user = userEvent.setup()
    const onToggleCollapsed = vi.fn()
    const onTogglePinned = vi.fn()
    const onStartChat = vi.fn()
    const project: Project = {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '',
      id: 'project-1',
      kind: 'workspace',
      name: 'Project',
      pinned: false,
      collapsed: false,
      sourceFolders: ['/workspace'],
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z'
    }
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    render(
      <ProjectGroup
        project={project}
        threadCount={1}
        onDelete={vi.fn()}
        onDeleteThreads={vi.fn()}
        onEdit={vi.fn()}
        onStartChat={onStartChat}
        onToggleCollapsed={onToggleCollapsed}
        onTogglePinned={onTogglePinned}
      >
        <span>Thread</span>
      </ProjectGroup>
    )

    await user.click(screen.getByRole('button', { name: 'project.collapse' }))
    expect(onToggleCollapsed).toHaveBeenCalledWith(project)
    await user.click(screen.getByRole('button', { name: 'project.show_details' }))
    await user.click(await screen.findByRole('menuitem', { name: 'project.pin' }))
    expect(onTogglePinned).toHaveBeenCalledWith(project)
    await user.click(screen.getByRole('button', { name: 'project.new_chat' }))
    expect(onStartChat).toHaveBeenCalledWith(project.id)
  })

  it('opens the shared project details menu from the project heading context menu', async () => {
    const onToggleCollapsed = vi.fn()
    const onTogglePinned = vi.fn()
    const openSourceFolder = vi.fn(async () => '/workspace')
    const project: Project = {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '',
      id: 'project-1',
      kind: 'workspace',
      name: 'Project',
      pinned: false,
      collapsed: false,
      sourceFolders: ['/workspace'],
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z'
    }
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0)
      return 1
    })
    Object.defineProperty(window, 'gale', {
      configurable: true,
      value: { ...capabilityApis, projects: { openSourceFolder } }
    })
    const { container } = render(
      <ProjectGroup
        project={project}
        threadCount={2}
        onDelete={vi.fn()}
        onDeleteThreads={vi.fn()}
        onEdit={vi.fn()}
        onStartChat={vi.fn()}
        onToggleCollapsed={onToggleCollapsed}
        onTogglePinned={onTogglePinned}
      >
        <span>Thread</span>
      </ProjectGroup>
    )
    const heading = container.querySelector('.project-thread-heading')
    if (!heading) throw new Error('Project heading was not rendered.')

    const disposeContextMenuPolicy = installNativeContextMenuPolicy()
    try {
      fireEvent.contextMenu(heading, { clientX: 80, clientY: 120 })

      expect(await screen.findByText('project.thread_count')).toBeVisible()
      fireEvent.click(screen.getByRole('menuitem', { name: '/workspace' }))
      await waitFor(() => expect(openSourceFolder).toHaveBeenCalledWith(project.id, '/workspace'))

      fireEvent.contextMenu(heading, { clientX: 80, clientY: 120 })
      fireEvent.click(screen.getByRole('menuitem', { name: 'project.pin' }))
      expect(onTogglePinned).toHaveBeenCalledWith(project)
      expect(onToggleCollapsed).not.toHaveBeenCalled()
    } finally {
      disposeContextMenuPolicy()
    }
  })

  it('opens shared thread actions from the thread row context menu without opening the thread', async () => {
    const onOpenThread = vi.fn()
    const onTogglePinned = vi.fn()
    const project: Project = {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '',
      id: 'project-1',
      kind: 'workspace',
      name: 'Project',
      pinned: false,
      collapsed: false,
      sourceFolders: ['/workspace'],
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z'
    }
    const thread: AgentThread = {
      id: 'thread-1',
      title: 'Thread',
      projectId: project.id,
      pinned: false,
      accessMode: 'read_only_allowed',
      status: 'idle',
      userTurnCount: 1,
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z'
    }
    const { container } = render(
      <ThreadList
        loading={false}
        projects={[project]}
        sidebarCollapsedSections={{ projects: false, simpleChats: false }}
        threads={[thread]}
        onDeleteProject={vi.fn()}
        onDeleteProjectThreads={vi.fn()}
        onDeleteThread={vi.fn()}
        onEditProject={vi.fn()}
        onOpenThread={onOpenThread}
        onRenameThread={vi.fn()}
        onStartProjectThread={vi.fn()}
        onToggleSidebarSection={vi.fn()}
        onToggleProjectCollapsed={vi.fn()}
        onToggleProjectPinned={vi.fn()}
        onTogglePinned={onTogglePinned}
      />
    )
    const threadItem = container.querySelector('.thread-item')
    if (!threadItem) throw new Error('Thread item was not rendered.')
    expect(threadItem).not.toHaveTextContent(formatDateTime(thread.updatedAt))
    expect(threadItem).not.toHaveTextContent('chat.user_turn_count')

    const disposeContextMenuPolicy = installNativeContextMenuPolicy()
    try {
      fireEvent.contextMenu(threadItem, { clientX: 80, clientY: 120 })

      fireEvent.click(await screen.findByRole('menuitem', { name: 'chat.pin_thread' }))
      expect(onTogglePinned).toHaveBeenCalledWith(thread)
      expect(onOpenThread).not.toHaveBeenCalled()
    } finally {
      disposeContextMenuPolicy()
    }
  })

  it.each(['dropdown', 'context'] as const)('omits simple-chat instructions from the %s menu', async (kind) => {
    const user = userEvent.setup()
    const project: Project = { id: 'simple', kind: 'simple_chat', name: 'Simple chat', prompt: 'Private system instructions',
      pinned: false, collapsed: false, createdAt: '2026-09-06T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z' }
    const onEdit = vi.fn()
    const props = { project, threadCount: 2, onEdit, onDelete: vi.fn(), onDeleteThreads: vi.fn(), onTogglePinned: vi.fn() }
    render(kind === 'dropdown'
      ? <ProjectDetailsMenu {...props} placement="topbar"><button>Open details</button></ProjectDetailsMenu>
      : <ProjectDetailsContextMenu {...props}><button>Open details</button></ProjectDetailsContextMenu>)
    const trigger = screen.getByRole('button', { name: 'Open details' })
    if (kind === 'dropdown') await user.click(trigger)
    else fireEvent.contextMenu(trigger)
    const menu = await screen.findByRole('menu')
    expect(menu).toHaveTextContent('Simple chat')
    expect(menu).not.toHaveTextContent(project.prompt)
    expect(menu).not.toHaveTextContent('project.simple_chat_prompt')
    expect(menu.querySelectorAll('.project-details-separator')).toHaveLength(1)
    await user.click(screen.getByRole('menuitem', { name: 'project.edit' }))
    await waitFor(() => expect(onEdit).toHaveBeenCalledWith(project))
  })

  it.each(['dropdown', 'context'] as const)('deletes conversations from the %s project menu', async (kind) => {
    const user = userEvent.setup()
    const project: Project = { id: 'simple', kind: 'simple_chat', name: 'Chat', prompt: '',
      pinned: false, collapsed: false, createdAt: '', updatedAt: '' }
    const onDeleteThreads = vi.fn()
    const props = { project, threadCount: 2, onEdit: vi.fn(), onDelete: vi.fn(), onDeleteThreads, onTogglePinned: vi.fn() }
    const view = render(kind === 'dropdown'
      ? <ProjectDetailsMenu {...props} placement="topbar"><button>Open project</button></ProjectDetailsMenu>
      : <ProjectDetailsContextMenu {...props}><button>Open project</button></ProjectDetailsContextMenu>)
    const trigger = screen.getByRole('button', { name: 'Open project' })
    if (kind === 'dropdown') await user.click(trigger)
    else fireEvent.contextMenu(trigger)
    const action = await screen.findByRole('menuitem', { name: 'project.delete_threads' })
    expect(action.previousElementSibling).toHaveAttribute('role', 'separator')
    await user.click(action)
    await waitFor(() => expect(onDeleteThreads).toHaveBeenCalledWith(project))
    expect(props.onDelete).not.toHaveBeenCalled()
    view.unmount()
    render(<ProjectDetailsMenu {...props} threadCount={0} placement="topbar"><button>Empty project</button></ProjectDetailsMenu>)
    await user.click(screen.getByRole('button', { name: 'Empty project' }))
    expect(await screen.findByRole('menuitem', { name: 'project.delete_threads' })).toHaveAttribute('aria-disabled', 'true')
  })

  it.each(['dropdown', 'context'] as const)('places thread time and turn count above actions in the %s menu', async (kind) => {
    const user = userEvent.setup()
    const thread: AgentThread = { id: 'thread-meta', projectId: 'default-workspace', title: 'Thread metadata',
      pinned: false, status: 'idle', accessMode: 'read_only_allowed', userTurnCount: 7,
      createdAt: '2026-09-06T01:00:00Z', updatedAt: '2026-09-06T08:00:00Z' }
    const onTogglePinned = vi.fn()
    const props = { thread, onTogglePinned, onRename: vi.fn(), onDelete: vi.fn() }
    render(kind === 'dropdown'
      ? <ThreadActionsMenu {...props}><button>Thread actions</button></ThreadActionsMenu>
      : <ThreadActionsContextMenu {...props}><button>Thread actions</button></ThreadActionsContextMenu>)
    const trigger = screen.getByRole('button', { name: 'Thread actions' })
    if (kind === 'dropdown') await user.click(trigger)
    else fireEvent.contextMenu(trigger)
    const menu = await screen.findByRole('menu')
    expect(menu.firstElementChild).toHaveClass('ui-menu-description')
    expect(menu.firstElementChild).toHaveTextContent(formatDateTime(thread.updatedAt))
    expect(menu.firstElementChild).toHaveTextContent('chat.user_turn_count')
    expect(menu.querySelector('time')).toHaveAttribute('datetime', thread.updatedAt)
    expect(screen.getAllByRole('menuitem')).toHaveLength(3)
    await user.click(screen.getByRole('menuitem', { name: 'chat.pin_thread' }))
    expect(onTogglePinned).toHaveBeenCalledWith(thread)
  })

  it('opens project details and thread actions from the topbar', async () => {
    const user = userEvent.setup()
    const project: Project = {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '',
      id: 'project-1',
      kind: 'workspace',
      name: 'Project',
      pinned: false,
      collapsed: false,
      sourceFolders: ['/workspace'],
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z'
    }
    const thread: AgentThread = {
      id: 'thread-1',
      title: 'Thread',
      projectId: project.id,
      pinned: false,
      accessMode: 'read_only_allowed',
      status: 'idle',
      userTurnCount: 1,
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z'
    }

    render(
      <ThreadTopbar
        project={project}
        projectThreadCount={3}
        thread={thread}
        title={thread.title}
        onDeleteProject={vi.fn()}
        onDeleteProjectThreads={vi.fn()}
        onDeleteThread={vi.fn()}
        onEditProject={vi.fn()}
        onRenameThread={vi.fn()}
        onToggleProjectPinned={vi.fn()}
        onToggleThreadPinned={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: 'project.show_details' }))
    expect(await screen.findByText('project.thread_count')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'common.more' }))
    expect(await screen.findByRole('menu')).toBeVisible()
    expect(screen.getByText('chat.rename_thread')).toBeVisible()
    await waitFor(() => expect(screen.queryByText('project.thread_count')).not.toBeInTheDocument())
  })

  it('groups the default workspace with workspace projects and italicizes its name', async () => {
    const user = userEvent.setup()
    const workspace: Project = {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '',
      id: 'workspace-project',
      kind: 'workspace',
      name: 'Workspace project',
      pinned: false,
      collapsed: false,
      sourceFolders: ['/workspace'],
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z'
    }
    const simpleChat: Project = {
      id: 'simple-project',
      kind: 'simple_chat',
      name: 'Simple project',
      pinned: false,
      collapsed: false,
      prompt: '',
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z'
    }
    const defaultWorkspace: Project = {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '',
      id: DEFAULT_WORKSPACE_PROJECT_ID,
      kind: 'workspace',
      name: 'Default Workspace',
      pinned: false,
      collapsed: false,
      sourceFolders: ['/default-workspace'],
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z'
    }
    const makeThread = (id: string, title: string, projectId: string): AgentThread => ({
      id,
      title,
      projectId,
      pinned: false,
      accessMode: 'read_only_allowed',
      status: 'idle',
      userTurnCount: 1,
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z'
    })
    function Fixture() {
      const [sidebarCollapsedSections, setSidebarCollapsedSections] = useState({
        projects: false,
        simpleChats: false
      })
      return (
        <ThreadList
          loading={false}
          projects={[simpleChat, workspace, defaultWorkspace]}
          selectedProjectId={workspace.id}
          sidebarCollapsedSections={sidebarCollapsedSections}
          threads={[
            makeThread('default-thread', 'Default workspace thread', defaultWorkspace.id),
            makeThread('simple-thread', 'Simple thread', simpleChat.id),
            makeThread('workspace-thread', 'Workspace thread', workspace.id)
          ]}
          onDeleteProject={vi.fn()}
          onDeleteProjectThreads={vi.fn()}
          onDeleteThread={vi.fn()}
          onEditProject={vi.fn()}
          onOpenThread={vi.fn()}
          onRenameThread={vi.fn()}
          onStartProjectThread={vi.fn()}
          onToggleSidebarSection={(section) => setSidebarCollapsedSections((current) => ({
            ...current,
            [section]: !current[section]
          }))}
          onToggleProjectCollapsed={vi.fn()}
          onToggleProjectPinned={vi.fn()}
          onTogglePinned={vi.fn()}
        />
      )
    }
    const { container } = render(<Fixture />)

    expect([...container.querySelectorAll('.thread-group-label')].map((element) => element.textContent)).toEqual([
      'project.projects',
      'project.simple_chats'
    ])
    const content = container.textContent ?? ''
    expect(content.indexOf('Workspace thread')).toBeLessThan(content.indexOf('Default workspace thread'))
    expect(content.indexOf('Default workspace thread')).toBeLessThan(content.indexOf('Simple thread'))
    const defaultWorkspaceGroup = container.querySelector('.project-thread-group[data-default-workspace]')
    if (!defaultWorkspaceGroup) throw new Error('Default workspace project group was not rendered.')
    expect(within(defaultWorkspaceGroup as HTMLElement).getByText('Default Workspace'))
      .toHaveClass('project-default-workspace-name')
    expect(screen.getByText('Workspace project')).not.toHaveClass('project-default-workspace-name')
    expect(screen.getByText('Workspace project').closest('.project-thread-heading'))
      .toHaveAttribute('data-selected', 'true')
    expect(screen.getByText('Default Workspace').closest('.project-thread-heading'))
      .not.toHaveAttribute('data-selected')

    await user.click(within(defaultWorkspaceGroup as HTMLElement).getByRole('button', { name: 'project.show_details' }))
    expect(await screen.findByText('project.edit')).toBeVisible()
    expect(screen.queryByText('project.pin')).not.toBeInTheDocument()
    expect(screen.queryByText('project.delete')).not.toBeInTheDocument()
    await user.keyboard('{Escape}')

    const projectsToggle = screen.getByRole('button', {
      name: 'project.collapse_section:project.projects'
    })
    await user.click(projectsToggle)
    expect(projectsToggle).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Workspace thread')).not.toBeInTheDocument()
    expect(screen.queryByText('Default workspace thread')).not.toBeInTheDocument()
    expect(screen.getByText('Simple thread')).toBeVisible()

    await user.click(projectsToggle)
    expect(projectsToggle).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByText('Workspace thread')).toBeVisible()
    expect(screen.getByText('Default workspace thread')).toBeVisible()

    await user.click(screen.getByRole('button', {
      name: 'project.collapse_section:project.simple_chats'
    }))
    expect(screen.queryByText('Simple thread')).not.toBeInTheDocument()
  })
  it('submits the default project name while allowing an empty simple-chat prompt', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => ({
      id: 'project-1',
      kind: 'simple_chat' as const,
      name: '未命名项目',
      prompt: '',
      pinned: false,
      collapsed: false,
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z'
    }))
    render(
      <ProjectDialog
        open
        kind="simple_chat"
        onClose={vi.fn()}
        onSave={onSave}
      />
    )

    await user.click(screen.getByRole('button', { name: 'project.create_simple_chat' }))

    expect(onSave).toHaveBeenCalledWith({
      kind: 'simple_chat',
      name: '未命名项目',
      prompt: ''
    })
  })

  it.each([false, true])('shows the save failure reason in a notice and allows correcting the name (editing: %s)', async (editing) => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    const failure = new ProjectOperationFailure({ code: 'duplicate_name', name: 'Existing' })
    const onSave = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(preferredProject)
    render(<ProjectDialog open kind="simple_chat" project={editing ? preferredProject : undefined}
      onClose={onClose} onSave={onSave} />)
    const nameInput = screen.getByRole('textbox', { name: 'project.name' })
    const promptInput = screen.getByRole('textbox', { name: 'project.simple_chat_prompt' })
    await user.clear(nameInput)
    await user.type(nameInput, 'Existing')
    await user.type(promptInput, 'Keep this draft')
    const save = screen.getByRole('button', { name: editing ? 'common.save' : 'project.create_simple_chat' })
    await user.click(save)
    expect(notice.error).toHaveBeenCalledWith(editing ? 'project.failed_update' : 'project.failed_create', { description: 'project.errors.duplicate_name' })
    expect(onClose).not.toHaveBeenCalled()
    expect(promptInput).toHaveValue('Keep this draft')
    expect(save).toBeEnabled()
    await user.clear(nameInput)
    await user.type(nameInput, 'Unique')
    await user.click(save)
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'Unique', prompt: 'Keep this draft' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('shows the default tag when editing the default workspace', () => {
    const defaultWorkspace: Project = {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '',
      id: DEFAULT_WORKSPACE_PROJECT_ID,
      kind: 'workspace',
      name: 'Default Workspace',
      pinned: false,
      collapsed: false,
      sourceFolders: ['/default-workspace'],
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z'
    }
    render(
      <ProjectDialog
        open
        kind="workspace"
        project={defaultWorkspace}
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )

    expect(screen.getByText('common.default')).toHaveClass('project-default-badge')
    expect(screen.queryByText('project.primary_folder')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'project.set_primary_folder' })).not.toBeInTheDocument()
  })

  it('marks the first project folder as primary and promotes another folder by reordering', async () => {
    const user = userEvent.setup()
    const project: Project = {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '',
      id: 'project-1',
      kind: 'workspace',
      name: 'Workspace',
      pinned: false,
      collapsed: false,
      sourceFolders: ['/workspace/primary', '/workspace/additional'],
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z'
    }
    const onSave = vi.fn(async () => project)
    render(
      <ProjectDialog
        open
        kind="workspace"
        project={project}
        onClose={vi.fn()}
        onSave={onSave}
      />
    )

    expect(screen.getByText('project.primary_folder').closest('.project-folder-item'))
      .toHaveTextContent('/workspace/primary')

    await user.click(screen.getByRole('button', { name: 'project.set_primary_folder' }))

    expect(screen.getByText('project.primary_folder').closest('.project-folder-item'))
      .toHaveTextContent('/workspace/additional')
    await user.click(screen.getByRole('button', { name: 'common.save' }))
    expect(onSave).toHaveBeenCalledWith({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '',
      kind: 'workspace',
      name: 'Workspace',
      sourceFolders: ['/workspace/additional', '/workspace/primary']
    })
  })

  it('selects a project icon color and returns to automatic color', async () => {
    const user = userEvent.setup()
    render(
      <ProjectDialog
        open
        kind="simple_chat"
        onClose={vi.fn()}
        onSave={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: 'project.choose_icon' }))
    const automatic = screen.getByRole('button', { name: 'project.icon_color_auto' })
    expect(automatic).toHaveAttribute('aria-pressed', 'true')

    const colorOptions = screen.getAllByRole('button', { name: 'project.icon_color_option' })
    await user.click(colorOptions[0])
    expect(colorOptions[0]).toHaveAttribute('aria-pressed', 'true')
    expect(automatic).toHaveAttribute('aria-pressed', 'false')

    await user.click(automatic)
    expect(automatic).toHaveAttribute('aria-pressed', 'true')
  })

  it.each([
    { codingMode: false, icon: undefined, iconColor: 'blue', expected: 'braces' },
    { codingMode: false, icon: 'folder', iconColor: 'red', expected: 'braces' },
    { codingMode: true, icon: 'braces', iconColor: 'green', expected: 'folder' },
    { codingMode: false, icon: 'brain', iconColor: 'purple', expected: 'brain' },
    { codingMode: true, icon: 'brain', iconColor: 'pink', expected: 'brain' },
    { codingMode: false, icon: 'folder', iconColor: undefined, expected: 'braces' }
  ] as const)('toggles coding=$codingMode with icon=$icon and preserves color=$iconColor', async ({ codingMode, icon, iconColor, expected }) => {
    const user = userEvent.setup()
    const project: Project = {
      id: 'appearance-project', kind: 'workspace', name: 'Appearance', sourceFolders: ['D:/project'],
      codingMode, icon, iconColor, advancedSettings: false, prompt: '',
      capabilities: structuredClone(defaultCapabilities), restrictSubagents: false,
      pinned: false, collapsed: false, createdAt: '2026-09-08T00:00:00Z', updatedAt: '2026-09-08T00:00:00Z'
    }
    const onSave = vi.fn().mockResolvedValue(project)
    render(<ProjectDialog open kind="workspace" project={project} onClose={vi.fn()} onSave={onSave} />)
    await user.click(screen.getByRole('checkbox', { name: 'project.coding_mode' }))
    await user.click(screen.getByRole('button', { name: 'common.save' }))
    const saved = onSave.mock.calls[0][0]
    expect(saved).toMatchObject({ codingMode: !codingMode, icon: expected })
    expect(saved.iconColor).toBe(iconColor)
    expect(project).toMatchObject({ codingMode, icon, iconColor })
  })

  it('resumes icon following after manually selecting the current mode default', async () => {
    const user = userEvent.setup()
    const project: Project = {
      id: 'appearance-project', kind: 'workspace', name: 'Appearance', sourceFolders: ['D:/project'],
      codingMode: false, icon: 'brain', iconColor: 'blue', advancedSettings: false, prompt: '',
      capabilities: structuredClone(defaultCapabilities), restrictSubagents: false,
      pinned: false, collapsed: false, createdAt: '2026-09-08T00:00:00Z', updatedAt: '2026-09-08T00:00:00Z'
    }
    const onSave = vi.fn().mockResolvedValue(project)
    render(<ProjectDialog open kind="workspace" project={project} onClose={vi.fn()} onSave={onSave} />)
    const mode = screen.getByRole('checkbox', { name: 'project.coding_mode' })
    await user.click(mode)
    await user.click(screen.getByRole('button', { name: 'project.choose_icon' }))
    const icons = screen.getAllByRole('button', { name: 'project.icon_option' })
    expect(icons[PROJECT_ICON_NAMES.indexOf('brain')]).toHaveAttribute('aria-pressed', 'true')
    await user.click(icons[PROJECT_ICON_NAMES.indexOf('braces')])
    await user.click(screen.getByRole('button', { name: 'common.done' }))
    await user.click(mode)
    await user.click(screen.getByRole('button', { name: 'project.choose_icon' }))
    expect(screen.getAllByRole('button', { name: 'project.icon_option' })[PROJECT_ICON_NAMES.indexOf('folder')])
      .toHaveAttribute('aria-pressed', 'true')
    await user.click(screen.getByRole('button', { name: 'common.done' }))
    await user.click(mode)
    await user.click(screen.getByRole('button', { name: 'common.save' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ codingMode: true, icon: 'braces', iconColor: 'blue' }))
  })

  it('retains coding mode only after save and preserves the draft when saving fails', async () => {
    const user = userEvent.setup()
    const project: Project = {
      id: 'coding-project', kind: 'workspace', name: 'Coding', sourceFolders: ['D:/project'],
      codingMode: false, advancedSettings: false, prompt: '', capabilities: structuredClone(defaultCapabilities), restrictSubagents: false,
      pinned: false, collapsed: false, createdAt: '2026-09-08T00:00:00Z', updatedAt: '2026-09-08T00:00:00Z'
    }
    const saved = { ...project, codingMode: true, icon: 'braces' as const }
    const onSave = vi.fn().mockRejectedValueOnce(new Error('Save failed')).mockResolvedValue(saved)
    const onClose = vi.fn()
    const props = { kind: 'workspace' as const, project, onSave, onClose }
    const { rerender } = render(<ProjectDialog {...props} open />)
    const mode = () => screen.getByRole('checkbox', { name: 'project.coding_mode' })
    expect(mode()).not.toBeChecked()
    await user.click(mode())
    await user.click(screen.getByRole('button', { name: 'common.cancel' }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(onSave).not.toHaveBeenCalled()
    rerender(<ProjectDialog {...props} open={false} />)
    rerender(<ProjectDialog {...props} open />)
    expect(mode()).not.toBeChecked()
    await user.click(mode())
    await user.click(screen.getByRole('button', { name: 'common.save' }))
    expect(notice.error).toHaveBeenCalledWith('project.failed_update', { description: 'project.errors.unexpected' })
    expect(mode()).toBeChecked()
    expect(onClose).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: 'common.save' }))
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ codingMode: true, advancedSettings: false, icon: 'braces' }))
    expect(onClose).toHaveBeenCalledTimes(2)
    rerender(<ProjectDialog {...props} project={saved} open={false} />)
    rerender(<ProjectDialog {...props} project={saved} open />)
    expect(mode()).toBeChecked()
    rerender(<ProjectDialog {...props} project={project} open />)
    expect(mode()).not.toBeChecked()
    rerender(<ProjectDialog open kind="simple_chat" onClose={onClose} onSave={onSave} />)
    expect(screen.queryByRole('checkbox', { name: 'project.coding_mode' })).not.toBeInTheDocument()
  })

  it('hides advanced fields without discarding their draft values', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn()
    const project: Project = {
      id: 'advanced-project', kind: 'workspace', name: 'Advanced', sourceFolders: ['D:/project'],
      codingMode: false, advancedSettings: false, prompt: 'Saved rules', capabilities: structuredClone(defaultCapabilities), restrictSubagents: false,
      pinned: false, collapsed: false, createdAt: '2026-09-06T00:00:00Z', updatedAt: '2026-09-06T00:00:00Z'
    }
    render(<ProjectDialog open kind="workspace" project={project} onClose={vi.fn()} onSave={onSave} />)
    const advanced = screen.getByRole('checkbox', { name: 'project.advanced_settings' })
    const coding = screen.getByRole('checkbox', { name: 'project.coding_mode' })
    expect(coding).not.toBeChecked()
    await user.click(coding)
    expect(advanced.closest('footer')).not.toBeNull()
    expect(screen.queryByRole('textbox', { name: 'project.prompt' })).toBeNull()
    expect(screen.queryByText('settings.capabilities')).toBeNull()
    await user.click(advanced)
    const prompt = screen.getByRole('textbox', { name: 'project.prompt' })
    expect(prompt).toHaveClass('ui-textarea')
    expect(prompt).not.toHaveClass('project-prompt-input')
    expect(prompt).toHaveAttribute('rows', '2')
    expect(prompt).toHaveValue('Saved rules')
    await user.clear(prompt)
    await user.type(prompt, 'New rules')
    await user.click(screen.getByText('settings.capabilities'))
    await user.click(screen.getByRole('checkbox', { name: 'settings.capability_workspaceContext' }))
    await user.click(advanced)
    expect(screen.queryByRole('textbox', { name: 'project.prompt' })).toBeNull()
    expect(coding).toBeVisible()
    expect(coding).toBeChecked()
    await user.click(advanced)
    expect(screen.getByRole('textbox', { name: 'project.prompt' })).toHaveValue('New rules')
    await user.click(advanced)
    await user.click(screen.getByRole('button', { name: 'common.save' }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      codingMode: true, advancedSettings: false, prompt: 'New rules', capabilities: expect.objectContaining({ workspace: false })
    }))
  })

  it('prefers the first source folder name for a workspace project', async () => {
    const user = userEvent.setup()
    const onSave = vi.fn(async () => ({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '',
      id: 'project-1',
      kind: 'workspace' as const,
      name: '未命名项目',
      sourceFolders: ['/workspace'],
      pinned: false,
      collapsed: false,
      createdAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z'
    }))
    Object.defineProperty(window, 'gale', {
      configurable: true,
      value: {
        ...capabilityApis,
        projects: {
          chooseSourceFolders: vi.fn(async () => ({ status: 'ok', value: ['/workspace'] }))
        }
      }
    })
    render(
      <ProjectDialog
        open
        kind="workspace"
        onClose={vi.fn()}
        onSave={onSave}
      />
    )

    await waitFor(() => expect(capabilityApis.skills.get).toHaveBeenLastCalledWith(undefined, []))
    await user.click(screen.getByRole('button', { name: 'project.add_folders' }))
    await waitFor(() => expect(capabilityApis.skills.get).toHaveBeenLastCalledWith(undefined, ['/workspace']))
    await user.click(screen.getByRole('button', { name: 'project.create' }))

    expect(onSave).toHaveBeenCalledWith({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: false, prompt: '',
      kind: 'workspace',
      name: 'workspace',
      sourceFolders: ['/workspace']
    })
  })

  it('has no automated accessibility violations in the open app menu', async () => {
    const user = userEvent.setup()
    render(<AppMenuFixture />)
    await user.click(screen.getByRole('button', { name: 'settings.title' }))
    const menu = await screen.findByRole('menu')

    const result = await axe.run(menu, {
      rules: { 'color-contrast': { enabled: false } }
    })
    expect(result.violations).toEqual([])
  })
})
