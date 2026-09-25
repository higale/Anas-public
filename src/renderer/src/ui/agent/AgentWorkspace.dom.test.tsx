import { createRef, type ComponentProps, type ReactNode } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentContextStatus, AgentInterrupt, AgentThreadSnapshot } from '@shared/agentTypes'
import type { AppConfigSnapshot } from '@shared/types'
import { defaultModelConfig, modelContextKey } from '@shared/modelConfig'
import { defaultCapabilities } from '@shared/agentCapabilities'
import type { AgentContextBudget } from '@shared/contextWindow'
import { ComposerContextMeter } from '../chat/ComposerContextMeter'
import { AgentWorkspace } from './AgentWorkspace'
import type { AgentRunView } from './useAgentWorkspace'
import { workspacePanelScope } from './useWorkspacePanels'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

vi.mock('../chat/ChatComposer', () => ({
  ChatComposer: ({ contextStatus, contextBudget }: { contextStatus?: AgentContextStatus; contextBudget?: AgentContextBudget }) => (
    <div data-testid="chat-composer">
      <ComposerContextMeter status={contextStatus} budget={contextBudget} compressionBusy={false} disabled={false} onCompress={() => {}} />
    </div>
  )
}))

vi.mock('../chat/MarkdownText', () => ({
  MarkdownWorkspaceProjectProvider: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('./AgentMessageList', () => ({
  AgentMessageList: ({ error }: { error?: string }) => (
    <div data-testid="conversation-error">{error}</div>
  ),
  AgentSubagentPanel: () => null
}))

vi.mock('./ThreadTopbar', () => ({
  ThreadTopbar: () => null
}))

function interruptedRun(interrupts: AgentInterrupt[]): AgentRunView {
  return {
    runId: 'run-1',
    operation: 'agent',
    status: 'interrupted',
    createdAt: '2026-09-04T00:00:00.000Z',
    updatedAt: '2026-09-04T00:00:01.000Z',
    models: [],
    tools: [],
    subagents: [],
    interrupts
  }
}

function workspaceProps(
  run: AgentRunView,
  error?: string
): ComponentProps<typeof AgentWorkspace> {
  return {
    panels: { groups: {}, documents: { tabs: [], expanded: false, maximized: false }, open: vi.fn(), select: vi.fn(), close: vi.fn(), toggle: vi.fn(), dismiss: vi.fn(), toggleMaximized: vi.fn(), remove: vi.fn() },
    onPanelWidthCommit: vi.fn(),
    activeThreadId: 'thread-1',
    attachments: [],
    chatPanelRef: createRef<HTMLElement>(),
    followOutputRef: { current: true },
    composerDragActive: false,
    composerFormRef: createRef<HTMLFormElement>(),
    composerInputRef: createRef<HTMLTextAreaElement>(),
    error,
    accessMode: 'read_only_allowed',
    input: '',
    assistantName: 'Anas',
    projects: [],
    queuedMessages: [],
    simpleChatEnabled: false,
    submissionBusy: false,
    run,
    selectedProjectId: '',
    selectedProjectThreadCount: 0,
    showComposerSuggestions: false,
    sidebarVisible: true,
    speech: { status: 'idle' },
    suggestions: [],
    onApplySuggestion: vi.fn(),
    onAttachFiles: vi.fn(),
    onAutosizeInput: vi.fn(),
    onCancelGeneration: vi.fn(),
    onChangeAccessMode: vi.fn(),
    onChangeInput: vi.fn(),
    onChangeSpeechReplyEnabled: vi.fn(),
    onComposerDragEnter: vi.fn(),
    onComposerDragLeave: vi.fn(),
    onComposerDragOver: vi.fn(),
    onComposerDrop: vi.fn(),
    onComposerKeyDown: vi.fn(),
    onCompressContext: vi.fn(),
    onCreateProject: vi.fn(),
    onDeleteProject: vi.fn(),
    onDeleteProjectThreads: vi.fn(),
    onDeleteThread: vi.fn(),
    onDeleteRound: vi.fn(),
    onEditProject: vi.fn(),
    onEditUserMessage: vi.fn(),
    onRegenerate: vi.fn(),
    onRenameThread: vi.fn(),
    onRequestFullAccess: vi.fn(),
    onLoadEarlierMessages: vi.fn(),
    onLoadEarlierError: vi.fn(),
    onOpenModelSettings: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onRemoveQueuedMessage: vi.fn(),
    onRetryQueuedMessage: vi.fn(),
    onToggleAttachmentContextPolicy: vi.fn(),
    onRemoveSuggestion: vi.fn(),
    onResume: vi.fn(),
    onSelectMainModel: vi.fn(),
    onSelectModelParameterPreset: vi.fn(),
    onSetDefaultModel: vi.fn(),
    onSelectProject: vi.fn(),
    onSpeak: vi.fn(),
    onSubmit: vi.fn(),
    onSteerQueuedMessage: vi.fn(),
    onToggleProjectPinned: vi.fn(),
    onToggleSidebar: vi.fn(),
    onToggleThreadPinned: vi.fn(),
    onToggleSuggestionPinned: vi.fn()
  }
}

describe('AgentWorkspace', () => {
  beforeEach(() => vi.stubGlobal('gale', { agent: { context: { status: vi.fn(async () => undefined) } } }))
  afterEach(() => vi.unstubAllGlobals())
  it('keeps an open context window mounted while model parameters require an asynchronous reestimate', async () => {
    let finish!: (status: AgentContextStatus) => void
    const reader = vi.fn(() => new Promise<AgentContextStatus>((resolve) => { finish = resolve }))
    vi.stubGlobal('gale', { agent: { context: { status: reader } } })
    const model = { ...defaultModelConfig, id: 'model', providerId: 'provider', providerName: 'Provider',
      protocol: 'openai_chat_completions' as const,
      model: 'model-b', displayName: 'Model B', baseUrl: 'https://example.test/v1',
      maxContextTokens: 100_000, maxOutputTokens: 5_000, contextCompressionEnabled: true, contextCompressionThreshold: 0.6 }
    const contextStatus: AgentContextStatus = {
      runId: 'run-1',
      modelConfigId: model.id, modelContextKey: modelContextKey(model),
      maxContextTokens: 100_000, maxOutputTokens: 5_000, inputCapacityTokens: 95_000,
      estimatedInputTokens: 20_000, currentContextTokens: 20_000,
      serverUsage: { inputTokens: 18_000, outputTokens: 2_000, totalTokens: 20_000 },
      compressionEnabled: true, compressionThreshold: 0.6, compressionThresholdTokens: 57_000,
      compressionApplied: false, manualCompressionAvailable: true,
      breakdown: { profileTokens: 0, systemInstructionTokens: 0, runtimeContextTokens: 0,
        workspaceTokens: 0, memoryTokens: 0, skillTokens: 0, toolDefinitionTokens: 0,
        messageTokens: 20_000, attachmentTokens: 0 }
    }
    const snapshot: AgentThreadSnapshot = {
      thread: { id: 'thread-1', projectId: 'project', title: 'Test', pinned: false, accessMode: 'read_only_allowed', status: 'running',
        userTurnCount: 1, createdAt: '', updatedAt: '' },
      messages: [], activities: [], todos: [], interrupts: [], contextStatus,
      messageWindow: { startIndex: 0, shown: 0, total: 0, remaining: 0 }
    }
    const props = workspaceProps({ ...interruptedRun([]), status: 'running' })
    props.run!.liveContextStatus = contextStatus
    const config = { settings: {}, defaultModel: model } as AppConfigSnapshot
    const { rerender } = render(<AgentWorkspace {...props} snapshot={snapshot} config={config} />)
    const meter = screen.getByRole('button', { name: /chat.context_window_title/ })
    fireEvent.click(meter)
    expect(screen.getByText('chat.context_model_window').parentElement).toHaveTextContent('100k')
    const edited = { ...model, model: 'model-b-updated', parameters: { temperature: 0.8 },
      maxContextTokens: 80_000, maxOutputTokens: 4_000, contextCompressionThreshold: 0.5 }
    rerender(<AgentWorkspace {...props} snapshot={snapshot} config={{ ...config, defaultModel: edited }} />)
    expect(meter).toHaveAttribute('aria-expanded', 'true')
    expect(meter).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByText('chat.context_model_window').parentElement).toHaveTextContent('80k')
    expect(screen.getByText('chat.context_response_reserve').parentElement).toHaveTextContent('4k')
    expect(screen.getByText('chat.context_auto_compress_at').parentElement).toHaveTextContent('38k · 50%')
    expect(screen.queryByText('chat.context_local_estimate')).toBeNull()
    expect(screen.queryByText('chat.context_current_window')).toBeNull()
    expect(screen.getByRole('button', { name: 'chat.compress_context_now' })).toBeDisabled()
    await act(async () => finish({ ...contextStatus, modelContextKey: modelContextKey(edited),
      estimatedInputTokens: 8_000, currentContextTokens: 8_000, serverUsage: undefined }))
    expect(meter).toHaveAttribute('aria-expanded', 'true')
    expect(meter).toHaveAttribute('aria-busy', 'false')
    expect(screen.getByText('≈ 8k')).toBeInTheDocument()
    expect(screen.getByText('chat.context_model_window').parentElement).toHaveTextContent('80k')
    rerender(<AgentWorkspace {...props} snapshot={snapshot} config={{ ...config, defaultModel: undefined }} />)
    expect(screen.queryByRole('button', { name: /chat.context_window_title/ })).toBeNull()
  })
  it.each(['running', 'interrupted', 'snapshot-only'] as const)(
    'updates the next request budget immediately after a settings edit during %s', (state) => {
      const contextStatus: AgentContextStatus = {
        runId: 'run-1',
        modelConfigId: 'model', maxContextTokens: 50_000, maxOutputTokens: 10_000,
        inputCapacityTokens: 40_000, estimatedInputTokens: 20_000, currentContextTokens: 20_000,
        compressionEnabled: true, compressionThreshold: 0.8, compressionThresholdTokens: 32_000,
        compressionApplied: false, manualCompressionAvailable: true,
        breakdown: { profileTokens: 0, systemInstructionTokens: 0, runtimeContextTokens: 0,
          workspaceTokens: 0, memoryTokens: 0, skillTokens: 0, toolDefinitionTokens: 0,
          messageTokens: 20_000, attachmentTokens: 0 }
      }
      const snapshot: AgentThreadSnapshot = {
        thread: { id: 'thread-1', title: 'Test', projectId: 'project', pinned: false,
          accessMode: 'read_only_allowed', status: state === 'interrupted' ? 'interrupted' : 'running',
          userTurnCount: 1, createdAt: '', updatedAt: '' },
        messages: [], activities: [], todos: [], interrupts: [], contextStatus,
        pendingRun: { id: 'run-1', threadId: 'thread-1', operation: 'agent',
          status: state === 'interrupted' ? 'interrupted' : 'running', createdAt: '', updatedAt: '' },
        messageWindow: { startIndex: 0, shown: 0, total: 0, remaining: 0 }
      }
      const props = workspaceProps({ ...interruptedRun([]), status: state === 'interrupted' ? 'interrupted' : 'running' })
      if (state === 'snapshot-only') props.run = undefined
      const config = { settings: {}, defaultModel: {
        ...defaultModelConfig, model: 'model', baseUrl: 'https://example.test/v1',
        id: 'model', maxContextTokens: 50_000, maxOutputTokens: 10_000,
        contextCompressionEnabled: true, contextCompressionThreshold: 0.8
      } } as AppConfigSnapshot
      contextStatus.modelContextKey = modelContextKey(config.defaultModel!)
      const { rerender } = render(<AgentWorkspace {...props} snapshot={snapshot} config={config} />)
      fireEvent.click(screen.getByRole('button', { name: /chat.context_window_title/ }))
      const edited = { ...config, defaultModel: { ...config.defaultModel!,
        maxContextTokens: 30_000, maxOutputTokens: 5_000, contextCompressionThreshold: 0.4 } }
      rerender(<AgentWorkspace {...props} snapshot={snapshot} config={edited} />)
      expect(screen.getByText('chat.context_model_window').parentElement).toHaveTextContent('30k')
      expect(screen.getByText('chat.context_response_reserve').parentElement).toHaveTextContent('5k')
      expect(screen.getByText('chat.context_input_capacity').parentElement).toHaveTextContent('25k')
      expect(screen.getByText('chat.context_auto_compress_at').parentElement).toHaveTextContent('10k · 40%')

      // Persisted measurements can be reused before the next request starts,
      // but always against the latest selection and budget.
      const nextRun = { ...interruptedRun([]), runId: 'run-2', status: 'running' as const }
      const nextSnapshot: AgentThreadSnapshot = { ...snapshot,
        thread: { ...snapshot.thread, status: 'running' },
        pendingRun: { ...snapshot.pendingRun!, id: 'run-2', status: 'running' } }
      const run = state === 'snapshot-only' ? undefined : nextRun
      rerender(<AgentWorkspace {...props} run={run} snapshot={nextSnapshot} config={edited} />)
      expect(screen.getByText('chat.context_model_window').parentElement).toHaveTextContent('30k')
      const nextStatus = { ...contextStatus, runId: 'run-2', maxContextTokens: 30_000,
        maxOutputTokens: 5_000, inputCapacityTokens: 25_000,
        compressionThreshold: 0.4, compressionThresholdTokens: 10_000 }
      rerender(<AgentWorkspace {...props} run={run}
        snapshot={{ ...nextSnapshot, contextStatus: nextStatus }} config={config} />)
      expect(screen.getByText('chat.context_model_window').parentElement).toHaveTextContent('50k')
      expect(screen.getByText('chat.context_auto_compress_at').parentElement).toHaveTextContent('32k · 80%')
      rerender(<AgentWorkspace {...props} snapshot={snapshot} config={{ ...config, defaultModel: undefined }} />)
      expect(screen.queryByRole('button', { name: /chat.context_window_title/ })).toBeNull()
    }
  )

  it.each(['running', 'interrupted'] as const)('refreshes edited project context according to the %s run lifecycle', async (state) => {
    const finish: Array<(status: AgentContextStatus) => void> = []
    const reader = vi.fn(() => new Promise<AgentContextStatus>((resolve) => finish.push(resolve)))
    vi.stubGlobal('gale', { agent: { context: { status: reader } } })
    const model = { ...defaultModelConfig, id: 'model', providerId: 'provider', providerName: 'Provider',
      protocol: 'openai_chat_completions' as const,
      model: 'model', displayName: 'Model', baseUrl: 'https://example.test/v1',
      maxContextTokens: 2_500, maxOutputTokens: 1_500, contextCompressionThreshold: 0.95 }
    const contextStatus: AgentContextStatus = {
      runId: 'run-1', modelConfigId: model.id, modelContextKey: modelContextKey(model),
      maxContextTokens: 2_500, maxOutputTokens: 1_500, inputCapacityTokens: 1_000,
      estimatedInputTokens: 200, currentContextTokens: 200, includeProjectRules: false,
      compressionEnabled: true, compressionThreshold: 0.95, compressionThresholdTokens: 950,
      compressionApplied: false, manualCompressionAvailable: true,
      breakdown: { profileTokens: 0, systemInstructionTokens: 0, runtimeContextTokens: 0,
        workspaceTokens: 0, memoryTokens: 0, skillTokens: 0, toolDefinitionTokens: 0,
        messageTokens: 200, attachmentTokens: 0 }
    }
    const project = { id: 'project', name: 'Project', kind: 'workspace' as const,
      advancedSettings: true, prompt: 'Original project instructions.', codingMode: false,
      sourceFolders: ['C:/workspace'], capabilities: structuredClone(defaultCapabilities),
      restrictSubagents: false, pinned: false, collapsed: false, createdAt: '', updatedAt: '' }
    const props = { ...workspaceProps({ ...interruptedRun([]), status: state }), selectedProjectId: project.id }
    if (state === 'running') props.run!.liveContextStatus = contextStatus
    const snapshot: AgentThreadSnapshot = {
      thread: { id: 'thread-1', projectId: project.id, title: 'Test', pinned: false, accessMode: 'read_only_allowed', status: state,
        userTurnCount: 1, createdAt: '', updatedAt: '' },
      messages: [], activities: [], todos: [], interrupts: [], contextStatus,
      messageWindow: { startIndex: 0, shown: 0, total: 0, remaining: 0 }
    }
    const config = { settings: {}, defaultModel: model } as AppConfigSnapshot
    const { rerender } = render(<AgentWorkspace {...props} snapshot={snapshot} config={config} projects={[project]} />)
    const meter = screen.getByRole('button', { name: /chat.context_window_title/ })
    fireEvent.click(meter)
    let nextPreview = 0
    if (state === 'interrupted') await act(async () => finish[nextPreview++](contextStatus))
    const changed = { ...project, codingMode: true, prompt: 'Next run instructions.' }
    rerender(<AgentWorkspace {...props} snapshot={snapshot} config={config} projects={[changed]} />)
    if (state === 'running') {
      expect(reader).not.toHaveBeenCalled()
      expect(screen.getByText('≈ 200')).toBeInTheDocument()
    } else {
      expect(meter).toHaveAttribute('aria-busy', 'true')
      expect(screen.queryByText('≈ 200')).toBeNull()
      await act(async () => finish[nextPreview++]({ ...contextStatus, estimatedInputTokens: 300, currentContextTokens: 300 }))
      expect(screen.getByText('≈ 300')).toBeInTheDocument()
    }
    // Editing coding mode cannot change the saved continuation's rule budget.
    expect(screen.getByText('chat.context_auto_compress_at').parentElement).toHaveTextContent('950 · 95%')

    const idle = { ...snapshot, thread: { ...snapshot.thread, status: 'idle' as const } }
    rerender(<AgentWorkspace {...props} run={undefined} snapshot={idle} config={config} projects={[changed]} />)
    expect(reader).toHaveBeenCalledWith('thread-1')
    expect(meter).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByText('≈ 200')).toBeNull()
    await act(async () => finish[nextPreview++]({ ...contextStatus, includeProjectRules: true,
      estimatedInputTokens: 400, currentContextTokens: 400 }))
    expect(screen.getByText('≈ 400')).toBeInTheDocument()
    expect(screen.getByText('chat.context_auto_compress_at').parentElement).toHaveTextContent('744 · 74.4%')

    rerender(<AgentWorkspace {...props} run={undefined} snapshot={idle} config={config}
      projects={[{ ...changed, prompt: 'Updated while idle.' }]} />)
    expect(meter).toHaveAttribute('aria-busy', 'true')
    await act(async () => finish[nextPreview++]({ ...contextStatus, includeProjectRules: true,
      estimatedInputTokens: 300, currentContextTokens: 300 }))
    expect(screen.getByText('≈ 300')).toBeInTheDocument()
  })

  it('shows the main panel opener only while collapsed and one panel closer while expanded', () => {
    const props = workspaceProps(interruptedRun([]))
    const scope = workspacePanelScope(props.activeThreadId, props.selectedProjectId)
    const group = { tabs: [{ id: 'subagent:one', panel: { kind: 'subagent' as const, runId: 'run', subagentId: 'one', name: 'One' }, view: new Map() }], activeId: 'subagent:one', expanded: false, maximized: false }
    props.panels.groups = { [scope]: group }
    const { rerender } = render(<AgentWorkspace {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'agent.show_panels' }))
    expect(props.panels.toggle).toHaveBeenCalledWith(scope)
    expect(screen.queryByRole('button', { name: 'agent.hide_panels' })).toBeNull()
    rerender(<AgentWorkspace {...props} panels={{ ...props.panels, groups: { [scope]: { ...group, expanded: true } } }} />)
    expect(screen.queryByRole('button', { name: 'agent.show_panels' })).toBeNull()
    expect(screen.getAllByRole('button', { name: 'agent.hide_panels' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'agent.hide_panels' }))
    expect(props.panels.dismiss).toHaveBeenCalledWith(scope)
  })
  it('keeps the workspace usable when an interrupted run has no actionable approval', () => {
    render(
      <AgentWorkspace
        {...workspaceProps(interruptedRun([]), 'chat.failed_load_app')}
      />
    )

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByTestId('conversation-error')).toHaveTextContent('chat.failed_load_app')
    expect(screen.getByTestId('chat-composer')).toBeInTheDocument()
  })

  it('shows the modal when an interrupted run contains an actionable approval', () => {
    render(
      <AgentWorkspace
        {...workspaceProps(interruptedRun([{
          id: 'approval-1',
          approvalGeneration: 'generation-1',
          value: {
            actionRequests: [{
              name: 'pwsh',
              args: { command: 'npm test' }
            }]
          }
        }]))}
      />
    )

    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('agent.approval_required')).toBeInTheDocument()
  })
})
