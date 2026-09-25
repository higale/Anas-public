import { FileDiff, PanelLeftOpen, PanelRightOpen } from 'lucide-react'
import { useLayoutEffect, useRef, useState } from 'react'
import type { DragEvent, FormEvent, KeyboardEvent, RefObject } from 'react'
import { useLiveContextStatus } from './useLiveContextStatus'
import { contextBudgetForModel } from '@shared/contextWindow'
import type { AppConfigSnapshot, Project, SelectedAttachment } from '@shared/types'
import { ChatComposer } from '../chat/ChatComposer'
import type { ProjectCreationKind } from '../projects/ProjectDialog'
import { MarkdownWorkspaceProjectProvider } from '../chat/MarkdownText'
import type { ComposerSuggestion } from '../chat/composerTypes'
import { NoFocusButton } from '../NoFocusButton'
import { AgentApprovalPanel } from './AgentApprovalPanel'
import { DiffPreferences, type DiffViewSettings } from '../diff/DiffView'
import { WorkspacePanels } from './WorkspacePanels'
import { workspacePanelGroup, workspacePanelScope, type WorkspacePanelsController } from './useWorkspacePanels'
import { WORKSPACE_PANEL_WIDTH_DEFAULT } from '@shared/uiPreferences'
import type { CodeReviewRequest } from '@shared/codeReview'
import { interruptActions } from './agentApproval'
import { AgentMessageList, type EarlierActivityRequest } from './AgentMessageList'
import type { AgentRunView } from './useAgentWorkspace'
import type { QueuedAgentMessage } from './useQueuedAgentMessages'
import {
  isAgentThreadLocked,
  type AgentAccessMode,
  type AgentInterruptResponse,
  type AgentMessage,
  type AgentThread,
  type AgentThreadSnapshot
} from '@shared/agentTypes'
import type { AgentSpeechState } from '../speech/useAgentSpeech'
import { useTranslation } from 'react-i18next'
import { ThreadTopbar } from './ThreadTopbar'
import { normalizeChatContentWidth } from '../settings/AppearanceSettings'

interface AgentWorkspaceProps {
  onDiffPreferencesChange?(update: Partial<DiffViewSettings>): Promise<void>
  panels: WorkspacePanelsController
  onPanelWidthCommit(width: number): void | Promise<void>
  onReview?(request: CodeReviewRequest): Promise<void>
  activeThreadId?: string
  attachments: SelectedAttachment[]
  chatPanelRef: RefObject<HTMLElement | null>
  followOutputRef: RefObject<boolean>
  composerDragActive: boolean
  composerFormRef: RefObject<HTMLFormElement | null>
  composerInputRef: RefObject<HTMLTextAreaElement | null>
  config?: AppConfigSnapshot
  defaultModelId?: string
  selectedModelParameterPresetId?: string
  error?: string
  accessMode: AgentAccessMode
  input: string
  assistantName: string
  projects: Project[]
  queuedMessages: QueuedAgentMessage[]
  simpleChatEnabled: boolean
  submissionBusy: boolean
  run?: AgentRunView
  selectedProjectId: string
  selectedProjectThreadCount: number
  showComposerSuggestions: boolean
  sidebarVisible: boolean
  snapshot?: AgentThreadSnapshot
  thread?: AgentThread
  speech: AgentSpeechState
  suggestions: ComposerSuggestion[]
  onApplySuggestion(suggestion: ComposerSuggestion): void
  onAttachFiles(): void | Promise<void>
  onAutosizeInput(event: FormEvent<HTMLTextAreaElement>): void
  onCancelGeneration(): void | Promise<void>
  onChangeAccessMode(accessMode: AgentAccessMode): void
  onChangeInput(value: string): void
  onChangeSpeechReplyEnabled(enabled: boolean): void | Promise<void>
  onComposerDragEnter(event: DragEvent<HTMLFormElement>): void
  onComposerDragLeave(event: DragEvent<HTMLFormElement>): void
  onComposerDragOver(event: DragEvent<HTMLFormElement>): void
  onComposerDrop(event: DragEvent<HTMLFormElement>): void | Promise<void>
  onComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void
  onCompressContext(): void | Promise<void>
  onCreateProject(kind: ProjectCreationKind): void
  onDeleteProject(project: Project): void
  onDeleteProjectThreads(project: Project): void
  onDeleteThread(threadId: string): void
  onDeleteRound(userMessageId: string): void
  onEditProject(project: Project): void
  onEditUserMessage(message: AgentMessage): void
  onRegenerate(userMessageId: string, action: 'regenerate' | 'resend'): void
  onRenameThread(threadId: string, title: string): void | Promise<void>
  onRequestFullAccess(responses: AgentInterruptResponse[]): void
  onLoadEarlierMessages(request: { threadId: string; signal: AbortSignal }): void | Promise<void>
  onLoadEarlierActivities?(request: EarlierActivityRequest): void | Promise<void>
  onLoadSubagentDetails?(threadId: string, runId: string, subagentId: string): Promise<void>
  onLoadEarlierError(threadId: string, error: string): void
  onOpenModelSettings(): void | Promise<void>
  onRemoveAttachment(path: string): void
  onRemoveQueuedMessage(message: QueuedAgentMessage): void | Promise<unknown>
  onRetryQueuedMessage(message: QueuedAgentMessage): void | Promise<unknown>
  onToggleAttachmentContextPolicy(path: string): void
  onRemoveSuggestion(text: string): void | Promise<void>
  onResume(responses: AgentInterruptResponse[]): void | Promise<void>
  onSelectMainModel(modelConfigId: string): void | Promise<void>
  onSelectModelParameterPreset(modelParameterPresetId: string | null): void | Promise<void>
  onSetDefaultModel(modelConfigId: string | null): void | Promise<void>
  onSelectProject(projectId: string): void
  onSpeak(messageId: string, text: string): void | Promise<void>
  onSubmit(event: FormEvent<HTMLFormElement>): void | Promise<void>
  onSteerQueuedMessage(message: QueuedAgentMessage, runId: string): void | Promise<unknown>
  onToggleProjectPinned(project: Project): void | Promise<void>
  onToggleSidebar(): void | Promise<void>
  onToggleThreadPinned(thread: AgentThread): void | Promise<void>
  onToggleSuggestionPinned(text: string, pinned: boolean): void | Promise<void>
}

export function AgentWorkspace(props: AgentWorkspaceProps) {
  const { t } = useTranslation()
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const panelToggleRef = useRef<HTMLButtonElement | null>(null)
  const [availableWidth, setAvailableWidth] = useState(0)
  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const measure = () => setAvailableWidth(body.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    return () => observer.disconnect()
  }, [])
  const scope = workspacePanelScope(props.activeThreadId, props.selectedProjectId)
  const panelGroup = workspacePanelGroup(props.panels, scope)
  const fontGrowth = Math.max(0, (props.config?.settings.fontSize ?? 14) - 14)
  const panelMinWidth = 320 + fontGrowth * 16
  const chatMinWidth = 520 + fontGrowth * 20
  const narrow = availableWidth < panelMinWidth + chatMinWidth
  const panelMaxWidth = Math.max(panelMinWidth, availableWidth - chatMinWidth)
  const panelWidth = Math.min(panelMaxWidth, Math.max(panelMinWidth, props.config?.settings.workspacePanelWidth ?? WORKSPACE_PANEL_WIDTH_DEFAULT))
  const title = props.snapshot?.thread.title ?? props.thread?.title ?? t('chat.new_thread')
  const selectedProject = props.projects.find((project) => project.id === props.selectedProjectId)
  const generationBusy = props.run?.status === 'running'
  const threadLocked = Boolean(props.run)
    || isAgentThreadLocked(props.snapshot?.thread.status)
  const compressionBusy = generationBusy && props.run?.operation === 'compression'
  const selectedModel = props.config?.defaultModel
  const selectedPresetValid = !props.selectedModelParameterPresetId || selectedModel?.parameterPresets?.some(
    (preset) => preset.id === props.selectedModelParameterPresetId
  )
  const currentRun = props.run ?? props.snapshot?.pendingRun
  const continuationRunId = currentRun?.status === 'running' || currentRun?.status === 'interrupted'
    ? 'runId' in currentRun ? currentRun.runId : currentRun.id : undefined
  const continuationStatus = currentRun?.status === 'running' || currentRun?.status === 'interrupted'
    ? currentRun.status : undefined
  const contextStatus = useLiveContextStatus(
    props.activeThreadId, selectedPresetValid ? selectedModel : undefined, props.snapshot?.contextStatus,
    { config: props.config, project: selectedProject, continuationRunId, continuationStatus,
      liveStatus: props.run?.liveContextStatus }
  )
  const contextBudget = props.snapshot?.contextStatus && selectedPresetValid
    ? contextBudgetForModel(selectedModel, continuationRunId && props.snapshot.contextStatus.runId === continuationRunId
      ? contextStatus?.includeProjectRules ?? props.snapshot.contextStatus.includeProjectRules
      : selectedProject?.kind === 'workspace' && selectedProject.codingMode) : undefined
  const showApprovalPanel = props.run?.status === 'interrupted'
    && interruptActions(props.run.interrupts).length > 0
  const sidebarLabel = t('chat.show_sidebar')
  const visibleActivities = [
    ...(props.snapshot?.activities ?? []).filter((activity) => activity.runId !== props.run?.runId),
    ...(props.run ? [props.run] : [])
  ]
  const openSubagent = (runId: string, subagentId: string) => {
    const subagent = visibleActivities.find((run) => run.runId === runId)?.subagents.find((item) => item.id === subagentId)
    props.panels.open(scope, { kind: 'subagent', runId, subagentId, name: subagent?.name ?? subagentId })
  }

  const chatContentWidth = normalizeChatContentWidth(props.config?.settings.chatContentWidth)

  return (
    <MarkdownWorkspaceProjectProvider
      projectId={selectedProject?.kind === 'workspace' ? selectedProject.id : undefined}
    >
      <DiffPreferences.Provider value={{
        diffViewMode: props.config?.settings.diffViewMode ?? 'inline',
        diffFoldUnchanged: props.config?.settings.diffFoldUnchanged ?? true,
        diffWordWrap: props.config?.settings.diffWordWrap ?? false,
        onChange: props.onDiffPreferencesChange ?? (async () => {})
      }}>
      <main className={`agent-workspace workspace-reading workspace-reading-${chatContentWidth} ui-main`}>
      <div className="agent-workspace-body" data-panels-open={panelGroup.expanded} ref={bodyRef}
        style={{ '--workspace-panel-width': `${narrow ? Math.min(WORKSPACE_PANEL_WIDTH_DEFAULT + fontGrowth * 24, Math.max(0, availableWidth - 16)) : panelWidth}px` } as React.CSSProperties}>
      <div className="agent-chat-column" hidden={panelGroup.expanded && panelGroup.maximized}>
      <header className="topbar ui-main">
        {!props.sidebarVisible && (
          <>
            <NoFocusButton
              className="topbar-sidebar-toggle ui-tool-button ui-tool-button-square"
              type="button"
              aria-label={sidebarLabel}
              data-tooltip={sidebarLabel}
              onClick={() => void props.onToggleSidebar()}
            >
              <PanelLeftOpen size={18} />
            </NoFocusButton>
            <span className="topbar-sidebar-divider" aria-hidden="true" />
          </>
        )}
        <ThreadTopbar
          project={selectedProject}
          projectThreadCount={props.selectedProjectThreadCount}
          thread={props.thread}
          title={title}
          onDeleteProject={props.onDeleteProject}
          onDeleteProjectThreads={props.onDeleteProjectThreads}
          onDeleteThread={props.onDeleteThread}
          onEditProject={props.onEditProject}
          onRenameThread={props.onRenameThread}
          onToggleProjectPinned={props.onToggleProjectPinned}
          onToggleThreadPinned={props.onToggleThreadPinned}
        />
        <div className="ui-row ui-row-tight ui-push-end">
          {selectedProject && <NoFocusButton type="button" className="ui-tool-button ui-tool-button-square"
            aria-label={t('agent.file_changes')} data-tooltip={t('agent.file_changes')} onClick={() => props.panels.open(scope, {
              kind: 'files', projectId: selectedProject.id, threadId: props.activeThreadId
            })}>
            <FileDiff size={18} />
          </NoFocusButton>}
          {panelGroup.tabs.length > 0 && !panelGroup.expanded && <NoFocusButton ref={panelToggleRef} type="button"
            className="ui-tool-button ui-tool-button-square" aria-expanded={false}
            aria-label={t('agent.show_panels')}
            data-tooltip={t('agent.show_panels')}
            onClick={() => props.panels.toggle(scope)}>
            <PanelRightOpen size={18} />
          </NoFocusButton>}
        </div>
      </header>
      <AgentMessageList
        onOpenChanges={(runId) => {
          const threadId = props.activeThreadId
          if (threadId) props.panels.open(scope, { kind: 'files', projectId: props.selectedProjectId, threadId, runId })
        }}
        title={title}
        navigationKey={props.activeThreadId}
        messages={props.snapshot?.messages ?? []}
        activities={props.snapshot?.activities ?? []}
        run={props.run}
        panelRef={props.chatPanelRef}
        followOutputRef={props.followOutputRef}
        error={props.error}
        speech={props.speech}
        earlierMessageCount={props.snapshot?.messageWindow.remaining ?? 0}
        onDeleteRound={props.onDeleteRound}
        onEditUserMessage={props.onEditUserMessage}
        onRegenerate={props.onRegenerate}
        onLoadEarlier={props.onLoadEarlierMessages}
        onLoadEarlierActivities={props.onLoadEarlierActivities}
        onLoadEarlierError={props.onLoadEarlierError}
        onOpenSubagent={openSubagent}
        onSpeak={props.onSpeak}
      />
      {showApprovalPanel && props.run && (
        <AgentApprovalPanel
          error={props.error}
          accessMode={props.accessMode}
          interrupts={props.run.interrupts}
          onRequestFullAccess={props.onRequestFullAccess}
          onResume={props.onResume}
        />
      )}
      <ChatComposer
        attachments={props.attachments}
        config={props.config}
        defaultModelId={props.defaultModelId}
        selectedModelParameterPresetId={props.selectedModelParameterPresetId}
        contextCompressionBusy={compressionBusy}
        contextCompressionDisabled={
          threadLocked
          || !props.activeThreadId
          || props.simpleChatEnabled
          || !contextStatus?.manualCompressionAvailable
        }
        contextStatus={contextStatus}
        contextBudget={contextBudget}
        generationBusy={generationBusy}
        locked={threadLocked}
        dragActive={props.composerDragActive}
        accessMode={props.accessMode}
        formRef={props.composerFormRef}
        input={props.input}
        inputRef={props.composerInputRef}
        assistantName={props.assistantName}
        projects={props.projects}
        queuedMessages={props.queuedMessages}
        simpleChatEnabled={props.simpleChatEnabled}
        submissionBusy={props.submissionBusy}
        run={props.run}
        selectedProjectId={props.selectedProjectId}
        projectSelectionDisabled={Boolean(props.activeThreadId)}
        showProjectPicker={!props.activeThreadId}
        showSuggestions={props.showComposerSuggestions}
        suggestions={props.suggestions}
        todos={props.snapshot?.todos ?? []}
        onApplySuggestion={props.onApplySuggestion}
        onAttachFiles={props.onAttachFiles}
        onAutosizeInput={props.onAutosizeInput}
        onCancelGeneration={props.onCancelGeneration}
        onChangeAccessMode={props.onChangeAccessMode}
        onChangeInput={props.onChangeInput}
        onChangeSpeechReplyEnabled={props.onChangeSpeechReplyEnabled}
        onCompressContext={props.onCompressContext}
        onDragEnter={props.onComposerDragEnter}
        onDragLeave={props.onComposerDragLeave}
        onDragOver={props.onComposerDragOver}
        onDrop={props.onComposerDrop}
        onKeyDown={props.onComposerKeyDown}
        onCreateProject={props.onCreateProject}
        onOpenModelSettings={props.onOpenModelSettings}
        onOpenSubagent={openSubagent}
        onRemoveAttachment={props.onRemoveAttachment}
        onRemoveQueuedMessage={props.onRemoveQueuedMessage}
        onRetryQueuedMessage={props.onRetryQueuedMessage}
        onToggleAttachmentContextPolicy={props.onToggleAttachmentContextPolicy}
        onRemoveSuggestion={props.onRemoveSuggestion}
        onSelectMainModel={props.onSelectMainModel}
        onSelectModelParameterPreset={props.onSelectModelParameterPreset}
        onSetDefaultModel={props.onSetDefaultModel}
        onSteerQueuedMessage={props.onSteerQueuedMessage}
        onSelectProject={props.onSelectProject}
        onSubmit={props.onSubmit}
        onToggleSuggestionPinned={props.onToggleSuggestionPinned}
      />
      </div>
      <WorkspacePanels controller={props.panels} scope={scope} activities={visibleActivities}
        project={selectedProject?.kind === 'workspace' ? selectedProject : undefined}
        sidebarVisible={props.sidebarVisible} onToggleSidebar={props.onToggleSidebar}
        narrow={narrow} width={panelWidth} minWidth={panelMinWidth} maxWidth={panelMaxWidth}
        toggleRef={panelToggleRef} inputRef={props.composerInputRef} onWidthCommit={props.onPanelWidthCommit} onOpenSubagent={openSubagent}
        onLoadEarlierActivities={props.onLoadEarlierActivities} onLoadEarlierError={props.onLoadEarlierError}
        onLoadSubagentDetails={props.onLoadSubagentDetails}
        onReview={!props.submissionBusy && !isAgentThreadLocked(props.thread?.status) ? props.onReview : undefined} />
      </div>
      </main>
      </DiffPreferences.Provider>
    </MarkdownWorkspaceProjectProvider>
  )
}
