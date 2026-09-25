import { userGuideId } from '@shared/helpDocuments'
import { unwrapProjectResult } from '@shared/projectOperation'
import { UserInputDialog } from './agent/UserInputDialog'
import { FormEvent, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { getLanguageOptions, systemLanguagePreference } from '../i18n'
import {
  isAgentThreadLocked,
  type AgentAccessMode,
  type AgentInterruptResponse,
  type AgentMessage,
  type AgentThreadCleanupResult
} from '@shared/agentTypes'
import { applyModelParameterPreset, findProviderModelConfig, isSelectableModelConfig } from '@shared/modelConfig'
import { defaultCapabilitySettings, effectiveProjectCapabilities, projectSkillSnapshot } from '@shared/agentCapabilities'
import { SIDEBAR_WIDTH_DEFAULT } from '@shared/uiPreferences'
import { compareProjects, DEFAULT_WORKSPACE_PROJECT_ID, isDefaultWorkspaceProject, type AppBuildInfo, type AppConfigSnapshot, type LanguagePackSummary, type Project, type ProjectCreateRequest, type ProjectStateUpdate, type RuntimeToolStatus, type SidebarCollapsedSections, type SidebarSectionId } from '@shared/types'
import { NoticeHost, notice } from './notice'
import {
  releaseTemporaryAttachments,
  useComposerAttachments
} from './chat/useComposerAttachments'
import {
  newThreadComposerDraftKey,
  threadComposerDraftKey,
  useComposerDrafts
} from './chat/composerDrafts'
import { attachmentPromptText } from './chat/attachmentUtils'
import { useComposerKeyDown } from './chat/useComposerKeyDown'
import { SynchronousSubmissionLock } from './chat/synchronousSubmissionLock'
import { useComposerSuggestions } from './chat/useComposerSuggestions'
import { useProjectSkills } from './chat/useProjectSkills'
import { useInputHistoryState } from './chat/useInputHistoryState'
import {
  newThreadDraftModelSelection,
  projectDraftModelSelection,
  reconcileDraftModelSelection,
  type DraftModelSelection
} from '@shared/draftModelSelection'
import { AgentWorkspace } from './agent/AgentWorkspace'
import { ThreadSidebarContent, ThreadSidebarFooter } from './agent/ThreadSidebar'
import { useAgentWorkspace } from './agent/useAgentWorkspace'
import { agentActionError } from './agent/agentErrorMessage'
import { AppSidebar } from './AppSidebar'
import { useWorkspacePanels, workspacePanelScope } from './agent/useWorkspacePanels'
import { sidebarWidthCssValue } from './SidebarResizeHandle'
import { AboutDialog, AvatarCropDialog, ConfirmDialog, DataCleanupDialog } from './dialogs/AppDialogs'
import type { ConfirmDialogRequest } from './dialogs/AppDialogs'
import { useModelSettingsState } from './model/useModelSettingsState'
import { useMcpSettingsState } from './mcp/useMcpSettingsState'
import { SettingsSidebarContent, SettingsSidebarFooter } from './settings/SettingsSidebar'
import { SettingsScreen } from './settings/SettingsScreen'
import { useDataManagementState } from './settings/useDataManagementState'
import { useEnvSettingsState } from './settings/useEnvSettingsState'
import { useMemorySettingsState } from './settings/useMemorySettingsState'
import { usePersonaAvatarState } from './settings/usePersonaAvatarState'
import { useSettingsController } from './settings/useSettingsController'
import { useSkillsSettingsState } from './settings/useSkillsSettingsState'
import { useSubagentSettingsState } from './subagent/useSubagentSettingsState'
import { useAppChromeActions } from './useAppChromeActions'
import { useAppLayoutEffects } from './useAppLayoutEffects'
import { useSidebarPeek } from './useSidebarPeek'
import { focusAfterRender } from './focusAfterRender'
import { useAppLifecycle } from './useAppLifecycle'
import { GlobalTooltip } from './GlobalTooltip'
import { ProjectDialog, type ProjectCreationKind } from './projects/ProjectDialog'
import { useAgentSpeech } from './speech/useAgentSpeech'
import { parseSlashSkillInput } from '@shared/skillShortcuts'
import { AppIssueTray, InitialAppGate } from './InitialAppStatus'
import { initialAppCriticalPhase } from './initialAppLoad'

type ChatScrollSnapshot = {
  bottomDistance: number
  top: number
}

function orderProjects(projects: Project[]): Project[] {
  return [...projects].sort(compareProjects)
}

const expandedSidebarSections: SidebarCollapsedSections = {
  projects: false,
  simpleChats: false
}

export function App() {
  const { t, i18n } = useTranslation()
  const [projects, setProjects] = useState<Project[]>([])
  const [projectDialogOpen, setProjectDialogOpen] = useState(false)
  const [projectDialogKind, setProjectDialogKind] = useState<ProjectCreationKind>('workspace')
  const [editingProject, setEditingProject] = useState<Project | undefined>()
  const [appError, setAppError] = useState<string | undefined>()
  const [settingsError, setSettingsError] = useState<string | undefined>()
  const [config, setConfig] = useState<AppConfigSnapshot | undefined>()
  const [resolvedTheme, setResolvedTheme] = useState<'light' | 'dark'>('light')
  const [appMenuOpen, setAppMenuOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [appBuildInfo, setAppBuildInfo] = useState<AppBuildInfo | undefined>()
  const [appIcon, setAppIcon] = useState<string | undefined>()
  const [languageOptions, setLanguageOptions] = useState<LanguagePackSummary[]>(() => getLanguageOptions())
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogRequest | undefined>()
  const [zoomHud, setZoomHud] = useState<number | undefined>()
  const [runtimeToolStatus, setRuntimeToolStatus] = useState<RuntimeToolStatus | undefined>()
  const [submissionBusy, setSubmissionBusy] = useState(false)
  const [draftModelSelection, setDraftModelSelection] = useState<DraftModelSelection>({
    modelConfigId: undefined,
    modelParameterPresetId: null,
    parameterPresetSource: 'model-default'
  })
  const chatPanelRef = useRef<HTMLElement | null>(null)
  const composerFormRef = useRef<HTMLFormElement | null>(null)
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null)
  const settingsContentRef = useRef<HTMLDivElement | null>(null)
  const mcpListRef = useRef<HTMLDivElement | null>(null)
  const followOutputRef = useRef(true)
  const nextFollowOutputScrollBehaviorRef = useRef<ScrollBehavior>('smooth')
  const chatScrollSnapshotRef = useRef<ChatScrollSnapshot | undefined>(undefined)
  const zoomHudTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const sidebarSectionMutationPendingRef = useRef(false)
  const submissionLockRef = useRef(new SynchronousSubmissionLock())
  const draftModelInitializedRef = useRef(false)
  const workspacePanels = useWorkspacePanels()
  const agent = useAgentWorkspace({ onAppError: setAppError })
  const {
    activeThreadId: agentActiveThreadId,
    draftProjectId: agentDraftProjectId,
    loadingThreads: agentLoadingThreads,
    setNewThreadWorkspace,
    workspaceState: agentWorkspaceState
  } = agent
  const activeProjectId = agent.activeThread?.projectId ?? agent.draftProjectId
  const activeProject = projects.find((project) => project.id === activeProjectId)
  const draftProject = projects.find((project) => project.id === agentDraftProjectId)
  const activeProjectThreadCount = agent.threads.filter((thread) => thread.projectId === activeProjectId).length
  const simpleChatEnabled = activeProject?.kind === 'simple_chat'
  const composerDraftKey = agent.activeThreadId
    ? threadComposerDraftKey(agent.activeThreadId)
    : newThreadComposerDraftKey(agent.draftProjectId)
  const {
    attachments,
    discardDrafts: discardComposerDrafts,
    accessMode: draftAccessMode,
    input,
    setAttachments,
    setAccessMode: setDraftAccessMode,
    setInput
  } = useComposerDrafts(composerDraftKey)
  const speech = useAgentSpeech(config?.settings.speechReply, agent.activeThreadId)
  const generationBusy = agent.activeRun?.status === 'running'
  const threadLocked = submissionBusy || Boolean(agent.activeRun)
    || isAgentThreadLocked(agent.activeThread?.status)
  const { modelConfigId: draftModelConfigId, modelParameterPresetId: draftModelParameterPresetId } = draftModelSelection
  const selectedModelId = agent.activeThread ? agent.activeThread.modelConfigId : draftModelConfigId
  const selectedModel = config ? findProviderModelConfig(config.providers, selectedModelId) : undefined
  const selectedModelParameterPresetId = agent.activeThread
    ? agent.activeThread.modelParameterPresetId
    : draftModelParameterPresetId ?? undefined
  const selectedPresetValid = !selectedModelParameterPresetId || selectedModel?.parameterPresets?.some(
    (preset) => preset.id === selectedModelParameterPresetId
  )
  const chatConfig = config
    ? { ...config, defaultModelId: selectedModelId, defaultModel: selectedModel && selectedPresetValid
      ? applyModelParameterPreset(selectedModel, selectedModelParameterPresetId)
      : selectedModel }
    : undefined
  const visionEnabled = selectedModel?.capabilities.vision ?? false
  const agentCapabilitiesEnabled = Boolean(config && !simpleChatEnabled)

  useEffect(
    () => window.gale.agent.onEvent(speech.handleEvent),
    [speech.handleEvent]
  )

  useEffect(() => {
    if (agentActiveThreadId) {
      draftModelInitializedRef.current = false
      return
    }
    if (agentLoadingThreads || !config || !draftProject) return
    if (!draftModelInitializedRef.current) {
      const restoredWorkspace = agentWorkspaceState?.mode === 'new_thread'
        && agentWorkspaceState.projectId === agentDraftProjectId
        ? agentWorkspaceState
        : undefined
      const restoredModel = findProviderModelConfig(config.providers, restoredWorkspace?.modelConfigId)
      const currentDraftModel = findProviderModelConfig(config.providers, draftModelConfigId)
      const defaults = restoredModel && isSelectableModelConfig(restoredModel)
        ? reconcileDraftModelSelection(restoredModel, {
            modelConfigId: restoredModel.id,
            modelParameterPresetId: restoredWorkspace?.modelParameterPresetId ?? null,
            parameterPresetSource: 'explicit'
          })
        : newThreadDraftModelSelection(
            config,
            currentDraftModel,
            draftModelParameterPresetId ?? null,
            projectDraftModelSelection(config.providers, draftProject)
          )
      draftModelInitializedRef.current = true
      setDraftModelSelection(defaults)
      setNewThreadWorkspace(
        agentDraftProjectId,
        defaults.modelConfigId,
        defaults.modelParameterPresetId
      )
      return
    }
    const draftModel = findProviderModelConfig(config.providers, draftModelConfigId)
    if (draftModelConfigId && (!draftModel || !isSelectableModelConfig(draftModel))) {
      const defaults = newThreadDraftModelSelection(
        config, undefined, null, projectDraftModelSelection(config.providers, draftProject)
      )
      setDraftModelSelection(defaults)
      setNewThreadWorkspace(
        agentDraftProjectId,
        defaults.modelConfigId,
        defaults.modelParameterPresetId
      )
      return
    }
    const nextSelection = reconcileDraftModelSelection(draftModel, draftModelSelection)
    if (nextSelection !== draftModelSelection) {
      setDraftModelSelection(nextSelection)
      setNewThreadWorkspace(
        agentDraftProjectId,
        nextSelection.modelConfigId,
        nextSelection.modelParameterPresetId
      )
    }
  }, [
    agentActiveThreadId,
    agentDraftProjectId,
    agentLoadingThreads,
    agentWorkspaceState,
    config,
    draftModelConfigId,
    draftModelParameterPresetId,
    draftModelSelection,
    draftProject,
    setNewThreadWorkspace
  ])

  useEffect(() => {
    const removeZoomListener = window.gale.app.onZoomChanged((zoom) => {
      setZoomHud(zoom)
      if (zoomHudTimeoutRef.current) clearTimeout(zoomHudTimeoutRef.current)
      zoomHudTimeoutRef.current = setTimeout(() => {
        setZoomHud(undefined)
        zoomHudTimeoutRef.current = undefined
      }, 900)
    })
    return () => {
      removeZoomListener()
      if (zoomHudTimeoutRef.current) clearTimeout(zoomHudTimeoutRef.current)
    }
  }, [])
  const {
    closeSettings,
    pendingDefaultCapabilities,
    saveLanguage,
    saveProfile,
    saveSettings,
    saveDefaultCapabilities,
    saveSpeechReply,
    setSettingsOpen,
    setSettingsTab,
    settingsOpen,
    settingsTab,
    switchSettingsTab
  } = useSettingsController({ setConfig, t })
  useEffect(() => {
    if (!settingsOpen || (settingsTab !== 'tools' && settingsTab !== 'subagents' && settingsTab !== 'capabilities')) return
    void window.gale.app.getRuntimeTools()
      .then((status) => {
        setRuntimeToolStatus(status)
        setSettingsError(undefined)
      })
      .catch(() => setSettingsError(t('chat.failed_load_app')))
  }, [
    config?.mcpServers,
    config?.subagents,
    settingsOpen,
    settingsTab,
    t
  ])
  useLayoutEffect(() => {
    if (settingsOpen) return
    const panel = chatPanelRef.current
    const snapshot = chatScrollSnapshotRef.current
    if (!panel || !snapshot) return
    chatScrollSnapshotRef.current = undefined
    if (snapshot.bottomDistance < 96) {
      panel.scrollTop = panel.scrollHeight
      return
    }
    panel.scrollTop = Math.min(snapshot.top, Math.max(0, panel.scrollHeight - panel.clientHeight))
  }, [settingsOpen])

  function captureChatScrollSnapshot(): void {
    const panel = chatPanelRef.current
    if (!panel) return
    chatScrollSnapshotRef.current = {
      bottomDistance: panel.scrollHeight - panel.scrollTop - panel.clientHeight,
      top: panel.scrollTop
    }
  }

  function openSettings(): void {
    if (!settingsOpen) captureChatScrollSnapshot()
    setSettingsOpen(true)
  }

  function openGeneralSettings(): void {
    if (!settingsOpen) captureChatScrollSnapshot()
    setAppMenuOpen(false)
    setSettingsTab('general')
    setSettingsOpen(true)
  }

  const {
    inputHistory,
    removeInputHistoryItem,
    saveInputHistoryText,
    setInputHistory,
    toggleInputHistoryPinned
  } = useInputHistoryState({ setError: agent.setActiveError, t })
  const {
    avatar,
    avatarCropSource,
    avatarDragActive,
    cancelPersonaAvatarCrop,
    choosePersonaAvatar,
    clearPersonaAvatar,
    editPersonaAvatar,
    handleAvatarDragEnter,
    handleAvatarDragLeave,
    handleAvatarDragOver,
    handleAvatarDrop,
    savePersonaAvatarCrop
  } = usePersonaAvatarState({ t })
  const {
    backupDataDirectory,
    closeDataCleanupDialog,
    dataCleanupBusy,
    dataCleanupOpen,
    dataCleanupSelection,
    dataCleanupUsage,
    dataDirectoryUsage,
    developerHttpTraceEnabled,
    developerHttpTraceUsage,
    developerHttpTraceUsageLoading,
    openDataCleanup,
    openDataDirectory,
    openDeveloperHttpTraceDirectory,
    openLogDirectory,
    openRuntimeLogViewer,
    restoreDataDirectory,
    runDataCleanup,
    storageUsageLoading,
    toggleAllDataCleanupTargets,
    toggleDataCleanupTarget,
    updateDeveloperHttpTraceEnabled
  } = useDataManagementState({
    cleanupAgentThreads,
    openConfirmDialog,
    setConfig,
    setInputHistory,
    settingsOpen,
    settingsTab,
    t
  })
  const { envDraft, envPath, openEnvFile, updateEnvDraft } = useEnvSettingsState({ settingsOpen, settingsTab, t })
  const memorySettings = useMemorySettingsState({
    openConfirmDialog,
    settingsOpen,
    settingsTab,
    t
  })
  const {
    addDirectory: addSkillDirectory,
    importDirectories: importSkills,
    moveDirectory: moveSkillDirectory,
    refreshSkills,
    updateDirectory: updateSkillDirectory,
    removeDirectory: removeSkillDirectory,
    skills,
    updateScriptApproval: updateSkillScriptApproval,
    updateAvailability: updateSkillAvailability
  } = useSkillsSettingsState({
    openConfirmDialog,
    settingsOpen,
    settingsTab,
    t
  })
  const {
    addSubagent,
    deleteSubagent,
    draft: subagentDraft,
    editSubagent,
    editingIndex: editingSubagentIndex,
    listRef: subagentListRef,
    moveSubagent,
    restoreSubagent,
    updateDraft: updateSubagentDraft
  } = useSubagentSettingsState({ config, openConfirmDialog, setConfig, t })
  const {
    addMcpServer,
    deleteEditingMcpServer,
    editMcpServer,
    editingMcpIndex,
    mcpDraft,
    mcpReloadingFailed,
    mcpRuntimeEnabled,
    mcpStatus,
    moveEditingMcpServer,
    reloadFailedMcpServers,
    updateMcpDraft
  } = useMcpSettingsState({ config, openConfirmDialog, setConfig, t })

  const {
    addProviderModel,
    addProviderModels,
    createModelDraft,
    deleteEditingModel,
    deleteSelectedProviderModel,
    editModel,
    editingModelIndex,
    editingProvider,
    editingProviderModelIndex,
    ensureModelDraftCanLeave,
    modelCandidates,
    modelDraft,
    modelListLoading,
    modelListRef,
    moveEditingModel,
    moveSelectedProviderModel,
    refreshModelCandidates,
    selectDefaultModel,
    selectProviderModel,
    updateModelDraft,
    updateModelParameters
  } = useModelSettingsState({
    config,
    openConfirmDialog,
    setConfig,
    setError: setSettingsError,
    setSettingsTab,
    settingsOpen,
    settingsTab,
    t
  })

  async function openModelSettings(): Promise<void> {
    if (!settingsOpen) captureChatScrollSnapshot()
    const selectedProvider = config?.providers.find((provider) => (
      provider.models.some((model) => model.id === selectedModelId)
    ))
    if (selectedProvider && selectedProvider.index !== editingModelIndex) {
      await editModel(selectedProvider.index)
    }
    setSettingsTab('model')
    setSettingsOpen(true)
  }

  async function selectChatModel(modelConfigId: string): Promise<void> {
    const model = config ? findProviderModelConfig(config.providers, modelConfigId) : undefined
    const parameterPresetId = model?.defaultParameterPresetId ?? null
    if (agent.activeThreadId) {
      await agent.setThreadModel(agent.activeThreadId, modelConfigId, parameterPresetId)
      return
    }
    draftModelInitializedRef.current = true
    setDraftModelSelection({
      modelConfigId,
      modelParameterPresetId: parameterPresetId,
      parameterPresetSource: 'model-default'
    })
    agent.setNewThreadWorkspace(agent.draftProjectId, modelConfigId, parameterPresetId)
  }

  async function selectChatModelParameterPreset(modelParameterPresetId: string | null): Promise<void> {
    if (agent.activeThreadId) {
      await agent.setThreadModelParameterPreset(agent.activeThreadId, modelParameterPresetId)
      return
    }
    draftModelInitializedRef.current = true
    setDraftModelSelection((current) => ({
      ...current,
      modelParameterPresetId,
      parameterPresetSource: 'explicit'
    }))
    agent.setNewThreadWorkspace(
      agent.draftProjectId,
      draftModelSelection.modelConfigId,
      modelParameterPresetId
    )
  }

  const sidebarVisible = config?.settings.sidebarVisible ?? true
  const sidebarWidth = config?.settings.sidebarWidth ?? SIDEBAR_WIDTH_DEFAULT
  const sidebarCollapsedSections = config?.settings.sidebarCollapsedSections ?? expandedSidebarSections
  const sidebarPeek = useSidebarPeek(!sidebarVisible, () => setAppMenuOpen(false))
  const assistantName = config?.settings.profile.assistant.name ?? 'Ananas'
  const assistantRole = config ? config.settings.profile.assistant.role.trim() : ''
  const {
    openHelpFromMenu,
    openSettingsFromMenu,
    quitFromMenu,
    showAboutFromMenu,
    toggleSidebar
  } = useAppChromeActions({
    onOpenHelp: async () => {
      if (settingsOpen) {
        if (!(await ensureModelDraftCanLeave())) return
        await closeSettings()
      }
      workspacePanels.open(workspacePanelScope(agent.activeThreadId, activeProjectId), {
        kind: 'document', documentId: userGuideId(i18n.resolvedLanguage ?? i18n.language)
      })
    },
    onOpenSettings: openSettings,
    setAboutOpen,
    setAppMenuOpen,
    setConfig,
    setError: setAppError,
    sidebarVisible,
    t
  })
  const {
    attachTextFiles,
    composerDragActive,
    handleComposerDragEnter,
    handleComposerDragLeave,
    handleComposerDragOver,
    handleComposerDrop,
    removeAttachment,
    restoreAttachments,
    toggleAttachmentContextPolicy
  } = useComposerAttachments({
    attachments,
    draftKey: composerDraftKey,
    setAttachments,
    t,
    visionEnabled
  })
  const { initialLoad, retryInitialResource } = useAppLifecycle({
    config,
    setAboutOpen,
    setAppBuildInfo,
    setAppIcon,
    setAppMenuOpen,
    setConfig,
    setInputHistory,
    setLanguageOptions,
    setProjects,
    setResolvedTheme,
    t
  })
  const projectSkills = useProjectSkills(activeProjectId, skills, activeProject?.kind === 'workspace' ? activeProject.sourceFolders : undefined)
  const {
    applyComposerSuggestion,
    composerSuggestions,
    dismissComposerSuggestions,
    executeExactSlashCommand,
    handleInputChange,
    resetComposerSuggestions,
    showComposerSuggestions,
  } = useComposerSuggestions({
    input,
    inputHistory,
    setInput,
    skills: activeProject?.kind === 'workspace' ? projectSkillSnapshot(projectSkills, effectiveProjectCapabilities(activeProject, config?.defaultCapabilities ?? defaultCapabilitySettings).skills) : projectSkills,
    skillShortcutsEnabled: agentCapabilitiesEnabled,
    t
  })
  useEffect(() => resetComposerSuggestions(), [composerDraftKey, resetComposerSuggestions])
  const { handleAutosizeInput } = useAppLayoutEffects({
    busy: generationBusy,
    chatPanelRef,
    composerInputRef,
    editingMcpIndex,
    error: agent.activeError,
    followOutputRef,
    input,
    mcpArgsText: mcpDraft.argsText,
    mcpEnvText: mcpDraft.envText,
    mcpListRef,
    mcpServerCount: config?.mcpServers.length,
    memoryDraft: memorySettings.draft?.content,
    messages: agent.activeSnapshot?.messages,
    nextFollowOutputScrollBehaviorRef,
    settingsContentRef,
    settingsOpen,
    settingsTab,
    subagentDescription: subagentDraft.description,
    subagentSystemPrompt: subagentDraft.systemPrompt,
  })

  function openConfirmDialog(request: ConfirmDialogRequest): void {
    setConfirmDialog(() => request)
  }

  function discardComposerDraftsAndRelease(keys: Iterable<string>): void {
    const discarded = discardComposerDrafts(keys)
    releaseTemporaryAttachments(discarded.flatMap((draft) => draft.attachments))
  }

  async function cleanupAgentThreads(): Promise<AgentThreadCleanupResult> {
    const result = await agent.cleanupThreads()
    discardComposerDraftsAndRelease(result.deletedThreadIds.map(threadComposerDraftKey))
    return result
  }

  async function openThread(threadId: string): Promise<void> {
    speech.stop()
    followOutputRef.current = true
    nextFollowOutputScrollBehaviorRef.current = 'auto'
    await agent.openThread(threadId)
    focusAfterRender(composerInputRef)
  }

  function startNewThread(
    projectId = DEFAULT_WORKSPACE_PROJECT_ID,
    project = projects.find((item) => item.id === projectId)
  ): void {
    const defaults = newThreadDraftModelSelection(
      config,
      selectedModel,
      selectedModelParameterPresetId ?? null,
      projectDraftModelSelection(config?.providers, project)
    )
    speech.stop()
    followOutputRef.current = true
    nextFollowOutputScrollBehaviorRef.current = 'auto'
    draftModelInitializedRef.current = Boolean(config && project)
    setDraftModelSelection(defaults)
    agent.startNewThread(
      projectId,
      defaults.modelConfigId,
      defaults.modelParameterPresetId
    )
    resetComposerSuggestions()
    focusAfterRender(composerInputRef)
  }

  function editUserMessage(message: AgentMessage): void {
    if (!agent.activeThreadId || threadLocked) return
    const threadId = agent.activeThreadId
    const text = message.content.find((block) => block.type === 'text')?.text ?? ''
    openConfirmDialog({
      title: t('chat.edit_message_title'),
      description: t('chat.edit_message_description'),
      confirmText: t('common.edit'),
      onConfirm: async () => {
        speech.stop()
        agent.setThreadError(threadId, undefined)
        try {
          const restoredAttachments = await agent.prepareMessageEdit(threadId, message.id)
          setInput(text)
          restoreAttachments(restoredAttachments)
          focusAfterRender(composerInputRef)
        } catch (error) {
          agent.setThreadError(threadId, agentActionError(t('chat.failed_delete_message_range'), error))
        }
      }
    })
  }

  function deleteMessageRound(userMessageId: string): void {
    if (!agent.activeThreadId || threadLocked) return
    const threadId = agent.activeThreadId
    openConfirmDialog({
      title: t('chat.delete_message_range_title'),
      description: t('chat.delete_message_range_description'),
      confirmText: t('common.delete'),
      variant: 'danger',
      onConfirm: async () => {
        try {
          speech.stop()
          await agent.truncateFromMessage(threadId, userMessageId)
          agent.setThreadError(threadId, undefined)
        } catch (error) {
          agent.setThreadError(threadId, agentActionError(t('chat.failed_delete_message_range'), error))
        }
      }
    })
  }

  function requestEnableFullAccess(
    afterEnable?: () => void | Promise<void>
  ): void {
    const threadId = agent.activeThreadId
    openConfirmDialog({
      title: t('chat.enable_full_access_title'),
      description: t('chat.enable_full_access_description'),
      confirmText: t('chat.enable_full_access'),
      onConfirm: async () => {
        try {
          await setComposerAccessMode('full_access', threadId)
          await afterEnable?.()
          agent.setThreadError(threadId, undefined)
        } catch {
          agent.setThreadError(threadId, t('chat.failed_update_access'))
        }
      }
    })
  }

  async function setComposerAccessMode(
    accessMode: AgentAccessMode,
    threadId = agent.activeThreadId
  ): Promise<void> {
    if (threadId) {
      await agent.setAccessMode(threadId, accessMode)
      return
    }
    setDraftAccessMode(accessMode)
  }

  function changeComposerAccessMode(accessMode: AgentAccessMode): void {
    const threadId = agent.activeThreadId
    const current = agent.activeThread?.accessMode ?? draftAccessMode
    if (accessMode === current) return
    if (accessMode === 'full_access') {
      requestEnableFullAccess()
      return
    }
    void setComposerAccessMode(accessMode, threadId)
      .then(() => agent.setThreadError(threadId, undefined))
      .catch(() => {
        agent.setThreadError(threadId, t('chat.failed_update_access'))
      })
  }

  function requestApprovalFullAccess(
    responses: AgentInterruptResponse[]
  ): void {
    const threadId = agent.activeThreadId
    if (!threadId) return
    requestEnableFullAccess(() => agent.resume(threadId, responses))
  }

  function regenerateMessage(
    userMessageId: string,
    action: 'regenerate' | 'resend'
  ): void {
    if (!agent.activeThreadId || threadLocked) return
    const threadId = agent.activeThreadId
    openConfirmDialog({
      title: t(`chat.${action}_message_title`),
      description: t(`chat.${action}_message_description`),
      confirmText: t(`common.${action}`),
      onConfirm: async () => {
        speech.stop()
        followOutputRef.current = true
        agent.setThreadError(threadId, undefined)
        try {
          const sourceMessage = agent.activeSnapshot?.messages.find(
            (message) => message.id === userMessageId
          )
          let skillPromptText: string | undefined
          if (sourceMessage?.skillInvocation) {
            const { name, sourceAlias, args } = sourceMessage.skillInvocation
            const invocation = await window.gale.skills.invoke(
              agent.activeThread?.projectId,
              name,
              sourceAlias,
              args
            )
            if (!invocation.handled) {
              throw new Error(t('settings.skill_not_found', { name }))
            }
            if (invocation.errorCode === 'user_unavailable') {
              throw new Error(t('chat.skill_user_unavailable', {
                name: invocation.errorName ?? name
              }))
            }
            if (invocation.errorCode === 'source_not_found') {
              throw new Error(t('chat.skill_source_not_found', { source: sourceAlias ?? '' }))
            }
            if (invocation.errorCode === 'source_skill_not_found') {
              throw new Error(t('chat.skill_not_found_in_source', { name, source: sourceAlias ?? '' }))
            }
            if (!invocation.promptText) {
              throw new Error(t('chat.failed_regenerate_message'))
            }
            skillPromptText = invocation.promptText
          }
          await agent.regenerateMessage(threadId, userMessageId, skillPromptText)
        } catch (error) {
          agent.setThreadError(threadId, agentActionError(t('chat.failed_regenerate_message'), error))
        }
      }
    })
  }

  async function compressContext(): Promise<void> {
    if (!agent.activeThreadId || threadLocked) return
    const threadId = agent.activeThreadId
    agent.setThreadError(threadId, undefined)
    try {
      await agent.compressContext(threadId)
    } catch {
      agent.setThreadError(threadId, t('chat.failed_compress_context'))
    }
  }

  async function createProject(request: ProjectCreateRequest): Promise<Project> {
    const project = unwrapProjectResult(await window.gale.projects.create(request))
    setProjects((items) => orderProjects([project, ...items]))
    startNewThread(project.id, project)
    return project
  }

  function openCreateProjectDialog(kind: ProjectCreationKind): void {
    setEditingProject(undefined)
    setProjectDialogKind(kind)
    setProjectDialogOpen(true)
  }

  function openEditProjectDialog(project: Project): void {
    setEditingProject(project)
    setProjectDialogKind(project.kind)
    setProjectDialogOpen(true)
  }

  function requestDeleteProject(project: Project): void {
    if (isDefaultWorkspaceProject(project)) return
    const threadCount = agent.threads.filter((thread) => thread.projectId === project.id).length
    openConfirmDialog({
      title: t('project.delete_title', { name: project.name }),
      description: t('project.delete_description', { count: threadCount }),
      confirmText: t('project.delete'),
      variant: 'danger',
      onConfirm: async () => {
        try {
          const result = await window.gale.projects.delete(project.id)
          agent.removeThreads(result.deletedThreadIds)
          workspacePanels.remove(workspacePanelScope(undefined, project.id))
          for (const threadId of result.deletedThreadIds) workspacePanels.remove(workspacePanelScope(threadId, project.id))
          discardComposerDraftsAndRelease([
            newThreadComposerDraftKey(project.id),
            ...result.deletedThreadIds.map(threadComposerDraftKey)
          ])
          setProjects((items) => items.filter((item) => item.id !== project.id))
          if (!agent.activeThreadId && agent.draftProjectId === project.id) {
            startNewThread(DEFAULT_WORKSPACE_PROJECT_ID)
          }
          setAppError(undefined)
          if (editingProject?.id === project.id) {
            setProjectDialogOpen(false)
            setEditingProject(undefined)
          }
        } catch {
          await Promise.all([
            window.gale.projects.list().then(setProjects),
            agent.reloadThreads()
          ]).catch(() => undefined)
          setAppError(t('project.failed_delete'))
        }
      }
    })
  }

  function requestDeleteProjectThreads(project: Project): void {
    const threadCount = agent.threads.filter((thread) => thread.projectId === project.id).length
    if (threadCount === 0) return
    openConfirmDialog({
      title: t('project.delete_threads_title', { name: project.name }),
      description: t('project.delete_threads_description', { count: threadCount }),
      confirmText: t('project.delete_threads'),
      variant: 'danger',
      onConfirm: async () => {
        try {
          const result = await window.gale.projects.deleteThreads(project.id)
          agent.removeThreads(result.deletedThreadIds)
          for (const threadId of result.deletedThreadIds) workspacePanels.remove(workspacePanelScope(threadId, project.id))
          discardComposerDraftsAndRelease(result.deletedThreadIds.map(threadComposerDraftKey))
          setAppError(undefined)
        } catch {
          await agent.reloadThreads().catch(() => undefined)
          setAppError(t('project.failed_delete_threads'))
        }
      }
    })
  }

  function requestDeleteThread(threadId: string): void {
    openConfirmDialog({
      title: t('chat.delete_thread_title', {
        title: agent.threads.find((thread) => thread.id === threadId)?.title ?? t('chat.this_thread')
      }),
      description: t('settings.cannot_be_undone'),
      confirmText: t('common.delete'),
      variant: 'danger',
      onConfirm: async () => {
        await agent.deleteThread(threadId)
        workspacePanels.remove(workspacePanelScope(threadId, ''))
        discardComposerDraftsAndRelease([threadComposerDraftKey(threadId)])
      }
    })
  }

  async function saveProject(request: ProjectCreateRequest): Promise<Project> {
    if (!editingProject) return createProject(request)
    const project = unwrapProjectResult(await window.gale.projects.update(editingProject.id, request))
    setProjects((items) => orderProjects([project, ...items.filter((item) => item.id !== project.id)]))
    return project
  }

  async function updateProjectState(project: Project, update: ProjectStateUpdate): Promise<void> {
    try {
      const updated = await window.gale.projects.updateState(project.id, update)
      setProjects((items) => orderProjects(items.map((item) => item.id === updated.id ? updated : item)))
      setAppError(undefined)
    } catch {
      setAppError(t('project.failed_update'))
    }
  }

  async function toggleSidebarSection(section: SidebarSectionId): Promise<void> {
    if (!config || sidebarSectionMutationPendingRef.current) return
    sidebarSectionMutationPendingRef.current = true
    try {
      const nextConfig = await window.gale.config.updateSettings({
        sidebarCollapsedSections: {
          ...config.settings.sidebarCollapsedSections,
          [section]: !config.settings.sidebarCollapsedSections[section]
        }
      })
      setConfig(nextConfig)
    } catch {
      setAppError(t('project.failed_update_sidebar_sections'))
    } finally {
      sidebarSectionMutationPendingRef.current = false
    }
  }

  async function commitSidebarWidth(width: number): Promise<void> {
    if (!config || width === config.settings.sidebarWidth) return
    try {
      setConfig(await window.gale.config.updateSettings({ sidebarWidth: width }))
      setAppError(undefined)
    } catch (reason) {
      setAppError(t('chat.failed_update_sidebar_width'))
      throw reason
    }
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    await sendCurrentMessage()
  }

  async function sendCurrentMessage(): Promise<void> {
    await submissionLockRef.current.run(async () => {
      setSubmissionBusy(true)
      try {
        await sendCurrentMessageUnlocked()
      } finally {
        setSubmissionBusy(false)
        focusAfterRender(composerInputRef)
      }
    })
  }

  async function sendCurrentMessageUnlocked(): Promise<void> {
    const submittedDraftKey = composerDraftKey
    const threadId = agent.activeThreadId
    const originalText = input.trim()
    const queueing = Boolean(
      threadId
      && agent.activeRun?.operation === 'agent'
      && agent.activeRun.status === 'running'
    )
    if (threadLocked && !queueing) return
    if (originalText.startsWith('/') && executeExactSlashCommand()) return
    if (!selectedModel || !isSelectableModelConfig(selectedModel)) {
      agent.setThreadError(threadId, t('chat.select_model_before_send'))
      return
    }
    let text = originalText
    let displayText = originalText
    if (!text && attachments.length === 0) return
    const unavailableAttachment = attachments.find((attachment) => attachment.skippedReason)
    if (unavailableAttachment) {
      agent.setThreadError(threadId, `${unavailableAttachment.name}: ${unavailableAttachment.skippedReason}`)
      return
    }
    if (!visionEnabled && attachments.some((attachment) => attachment.kind === 'image')) {
      agent.setThreadError(threadId, t('chat.vision_unsupported_attachment'))
      return
    }
    followOutputRef.current = true
    agent.setThreadError(threadId, undefined)
    try {
      const slashSkill = agentCapabilitiesEnabled
        ? parseSlashSkillInput(originalText)
        : undefined
      if (slashSkill) {
        const invocation = await window.gale.skills.invoke(
          agent.activeThread?.projectId ?? agent.draftProjectId,
          slashSkill.name,
          slashSkill.sourceAlias,
          slashSkill.args
        )
        if (invocation.handled) {
          if (invocation.errorCode === 'user_unavailable') {
            agent.setThreadError(threadId, t('chat.skill_user_unavailable', { name: invocation.errorName ?? slashSkill.name }))
            return
          }
          if (invocation.errorCode === 'source_not_found') {
            agent.setThreadError(threadId, t('chat.skill_source_not_found', { source: slashSkill.sourceAlias ?? '' }))
            return
          }
          if (invocation.errorCode === 'source_skill_not_found') {
            agent.setThreadError(threadId, t('chat.skill_not_found_in_source', { name: slashSkill.name, source: slashSkill.sourceAlias ?? '' }))
            return
          }
          if (!invocation.promptText) {
            agent.setThreadError(threadId, t('chat.failed_send'))
            return
          }
          text = invocation.promptText
          displayText = invocation.displayText
        }
      }
      const historyText = displayText
      const fallbackAttachmentPrompt = t('chat.attachment_fallback_prompt')
      text = attachmentPromptText(text, attachments.length, fallbackAttachmentPrompt)
      displayText = attachmentPromptText(displayText, attachments.length, fallbackAttachmentPrompt)
      if (queueing && threadId) {
        const queuedAttachments = attachments
        setInput('')
        setAttachments([])
        try {
          await agent.queueMessage(threadId, text, displayText, queuedAttachments)
        } catch (reason) {
          setInput((current) => current || input)
          setAttachments((current) => current.length > 0 ? current : queuedAttachments)
          throw reason
        }
        releaseTemporaryAttachments(attachments)
      } else {
        speech.stop()
        await agent.send(
          text,
          attachments,
          displayText,
          draftAccessMode,
          selectedModel.id,
          draftModelParameterPresetId ?? null
        )
      }
      if (historyText) await saveInputHistoryText(historyText)
      if (!queueing) discardComposerDraftsAndRelease([submittedDraftKey])
      resetComposerSuggestions()
    } catch {
      agent.setThreadError(threadId, t('chat.failed_send'))
    }
  }

  const handleComposerKeyDown = useComposerKeyDown({
    dismissComposerSuggestions,
    handleInputChange,
    sendCurrentMessage,
    showComposerSuggestions,
  })
  const shellClassName = [
    'app-shell ui-window ui-fill',
    sidebarVisible ? '' : 'sidebar-collapsed',
    !sidebarVisible && sidebarPeek.open ? 'sidebar-peek-open' : ''
  ].filter(Boolean).join(' ')
  const initialAppReady = initialAppCriticalPhase(initialLoad) === 'ready'

  return (
    <>
      <NoticeHost theme={resolvedTheme} />
      <GlobalTooltip />
      <div
        className={shellClassName}
        style={{ '--sidebar-width': sidebarWidthCssValue(sidebarWidth) } as CSSProperties}
      >
      <InitialAppGate snapshot={initialLoad} />
      {initialAppReady && (
        <AppIssueTray
          appError={appError}
          snapshot={initialLoad}
          onDismissAppError={() => setAppError(undefined)}
          onRetry={retryInitialResource}
        />
      )}
      {!sidebarVisible && (
        <div
          className="sidebar-peek-trigger"
          aria-hidden="true"
          onPointerEnter={(event) => {
            if (event.pointerType !== 'touch') sidebarPeek.show()
          }}
        />
      )}
      <div className="window-drag-layer" aria-hidden="true" />
      {zoomHud !== undefined && <div className="zoom-hud" role="status" aria-live="polite">{zoomHud}%</div>}
      <div
        className="app-layout ui-sidebar-main ui-fill"
        aria-hidden={!initialAppReady}
        inert={initialAppReady ? undefined : true}
      >
      <AppSidebar
        ariaLabel={settingsOpen ? t('settings.title') : t('chat.threads')}
        avatarDataUri={avatar?.dataUri}
        assistantName={assistantName}
        assistantRole={assistantRole}
        sidebarVisible={sidebarVisible}
        sidebarWidth={sidebarWidth}
        footer={settingsOpen ? (
          <SettingsSidebarFooter onBack={() => closeSettings(ensureModelDraftCanLeave)} />
        ) : (
          <ThreadSidebarFooter
            appMenuOpen={appMenuOpen}
            buildInfo={appBuildInfo}
            onOpenHelp={openHelpFromMenu}
            onOpenSettings={openSettingsFromMenu}
            onQuit={quitFromMenu}
            onShowAbout={showAboutFromMenu}
            onAppMenuOpenChange={setAppMenuOpen}
          />
        )}
        onAvatarClick={settingsOpen
          ? () => switchSettingsTab('general', ensureModelDraftCanLeave)
          : openGeneralSettings}
        onSidebarWidthCommit={commitSidebarWidth}
        onToggleSidebar={toggleSidebar}
      >
        {settingsOpen ? (
          <SettingsSidebarContent
            activeTab={settingsTab}
            onSelectTab={(tab) => switchSettingsTab(tab, ensureModelDraftCanLeave)}
          />
        ) : (
          <ThreadSidebarContent
            activeThreadId={agent.activeThreadId}
            loading={!initialAppReady || agent.loadingThreads}
            projects={projects}
            selectedProjectId={agent.activeThreadId ? undefined : agent.draftProjectId}
            sidebarCollapsedSections={sidebarCollapsedSections}
            threads={agent.threads}
            onDeleteProject={requestDeleteProject}
            onDeleteProjectThreads={requestDeleteProjectThreads}
            onDeleteThread={requestDeleteThread}
            onEditProject={openEditProjectDialog}
            onOpenThread={openThread}
            onRenameThread={agent.renameThread}
            onStartNewThread={startNewThread}
            onStartProjectThread={startNewThread}
            onToggleSidebarSection={toggleSidebarSection}
            onToggleProjectCollapsed={(project) => updateProjectState(project, { collapsed: !project.collapsed })}
            onToggleProjectPinned={(project) => updateProjectState(project, { pinned: !project.pinned })}
            onTogglePinned={agent.togglePinned}
          />
        )}
      </AppSidebar>

      {settingsOpen ? (
        <SettingsScreen
          onConfigChange={setConfig}
          pendingDefaultCapabilities={pendingDefaultCapabilities}
          activeTab={settingsTab}
          avatar={avatar}
          avatarDragActive={avatarDragActive}
          backupDir={config?.settings.backupDir}
          config={config}
          dataDirectoryUsage={dataDirectoryUsage}
          developerHttpTraceEnabled={developerHttpTraceEnabled}
          developerHttpTraceUsage={developerHttpTraceUsage}
          developerHttpTraceUsageLoading={developerHttpTraceUsageLoading}
          editingMcpIndex={editingMcpIndex}
          editingModelIndex={editingModelIndex}
          editingProvider={editingProvider}
          editingProviderModelIndex={editingProviderModelIndex}
          envDraft={envDraft}
          envPath={envPath}
          error={settingsError}
          languageOptions={languageOptions}
          mcpDraft={mcpDraft}
          mcpListRef={mcpListRef}
          mcpReloadingFailed={mcpReloadingFailed}
          mcpRuntimeEnabled={mcpRuntimeEnabled}
          mcpStatus={mcpStatus}
          runtimeToolStatus={runtimeToolStatus}
          subagentDraft={subagentDraft}
          subagentListRef={subagentListRef}
          editingSubagentIndex={editingSubagentIndex}
          memory={memorySettings}
          modelCandidates={modelCandidates}
          modelDraft={modelDraft}
          modelListLoading={modelListLoading}
          modelListRef={modelListRef}
          projects={projects}
          settingsContentRef={settingsContentRef}
          sidebarVisible={sidebarVisible}
          skills={skills}
          systemLanguage={systemLanguagePreference}
          storageUsageLoading={storageUsageLoading}
          onAddMcpServer={addMcpServer}
          onAddSubagent={addSubagent}
          onAutosizeInput={handleAutosizeInput}
          onAvatarDragEnter={handleAvatarDragEnter}
          onAvatarDragLeave={handleAvatarDragLeave}
          onAvatarDragOver={handleAvatarDragOver}
          onAvatarDrop={handleAvatarDrop}
          onBackupDataDirectory={backupDataDirectory}
          onEditAvatar={editPersonaAvatar}
          onClearAvatar={clearPersonaAvatar}
          onCreateModel={createModelDraft}
          onAddProviderModel={addProviderModel}
          onAddProviderModels={addProviderModels}
          onDeleteMcpServer={deleteEditingMcpServer}
          onDeleteSubagent={deleteSubagent}
          onDeleteModel={deleteEditingModel}
          onDeleteProviderModel={deleteSelectedProviderModel}
          onAddSkillDirectory={addSkillDirectory}
          onImportSkills={importSkills}
          onEditMcpServer={editMcpServer}
          onEditSubagent={editSubagent}
          onEditModel={editModel}
          onMoveMcpServer={moveEditingMcpServer}
          onMoveSubagent={moveSubagent}
          onReloadFailedMcpServers={reloadFailedMcpServers}
          onMoveModel={moveEditingModel}
          onMoveProviderModel={moveSelectedProviderModel}
          onSelectProviderModel={selectProviderModel}
          onOpenEnvFile={openEnvFile}
          onOpenDataCleanup={openDataCleanup}
          onOpenDataDirectory={openDataDirectory}
          onOpenDeveloperHttpTraceDirectory={openDeveloperHttpTraceDirectory}
          onOpenLogDirectory={openLogDirectory}
          onOpenRuntimeLogViewer={openRuntimeLogViewer}
          onRefreshModelCandidates={refreshModelCandidates}
          onRestoreDataDirectory={restoreDataDirectory}
          onRestoreSubagent={restoreSubagent}
          onSaveLanguage={saveLanguage}
          onSaveProfile={saveProfile}
          onSaveSettings={saveSettings}
          onSaveDefaultCapabilities={saveDefaultCapabilities}
          onDeveloperHttpTraceEnabledChange={updateDeveloperHttpTraceEnabled}
          onSaveSpeechReply={saveSpeechReply}
          onMoveSkillDirectory={moveSkillDirectory}
          onRefreshSkills={refreshSkills}
          onUpdateSkillDirectory={updateSkillDirectory}
          onRemoveSkillDirectory={removeSkillDirectory}
          onToggleSidebar={toggleSidebar}
          onUpdateEnvDraft={updateEnvDraft}
          onUpdateMcpDraft={updateMcpDraft}
          onUpdateSubagentDraft={updateSubagentDraft}
          onUpdateModelDraft={updateModelDraft}
          onUpdateModelParameters={updateModelParameters}
          onUpdateSkillScriptApproval={updateSkillScriptApproval}
          onUpdateSkillAvailability={updateSkillAvailability}
        />
      ) : (
      <AgentWorkspace
        onDiffPreferencesChange={async (update) => { setConfig(await window.gale.config.updateSettings(update)) }}
        panels={workspacePanels}
        onPanelWidthCommit={async (workspacePanelWidth) => {
          try { setConfig(await window.gale.config.updateSettings({ workspacePanelWidth })) }
          catch (error) { notice.error(t('agent.failed_update_panel_width')); throw error }
        }}
        activeThreadId={agent.activeThreadId}
        attachments={attachments}
        chatPanelRef={chatPanelRef}
        composerDragActive={composerDragActive}
        composerFormRef={composerFormRef}
        composerInputRef={composerInputRef}
        config={chatConfig}
        defaultModelId={config?.defaultModelId}
        selectedModelParameterPresetId={selectedModelParameterPresetId}
        error={agent.activeError}
        accessMode={agent.activeThread?.accessMode ?? draftAccessMode}
        followOutputRef={followOutputRef}
        input={input}
        assistantName={assistantName}
        projects={projects}
        queuedMessages={agent.activeQueuedMessages}
        simpleChatEnabled={simpleChatEnabled}
        run={agent.activeRun}
        submissionBusy={submissionBusy}
        speech={speech.state}
        selectedProjectId={activeProjectId}
        selectedProjectThreadCount={activeProjectThreadCount}
        showComposerSuggestions={showComposerSuggestions}
        sidebarVisible={sidebarVisible}
        snapshot={agent.activeSnapshot}
        thread={agent.activeThread}
        suggestions={composerSuggestions}
        onApplySuggestion={applyComposerSuggestion}
        onAttachFiles={attachTextFiles}
        onAutosizeInput={handleAutosizeInput}
        onCancelGeneration={() => {
          speech.stop()
          return agent.activeThreadId
            ? agent.cancel(agent.activeThreadId)
            : Promise.resolve()
        }}
        onChangeAccessMode={changeComposerAccessMode}
        onChangeInput={handleInputChange}
        onChangeSpeechReplyEnabled={(enabled) => saveSpeechReply({ enabled })}
        onComposerDragEnter={handleComposerDragEnter}
        onComposerDragLeave={handleComposerDragLeave}
        onComposerDragOver={handleComposerDragOver}
        onComposerDrop={handleComposerDrop}
        onComposerKeyDown={handleComposerKeyDown}
        onCompressContext={compressContext}
        onCreateProject={openCreateProjectDialog}
        onDeleteProject={requestDeleteProject}
        onDeleteProjectThreads={requestDeleteProjectThreads}
        onDeleteThread={requestDeleteThread}
        onDeleteRound={deleteMessageRound}
        onEditProject={openEditProjectDialog}
        onEditUserMessage={editUserMessage}
        onRegenerate={regenerateMessage}
        onRenameThread={agent.renameThread}
        onRequestFullAccess={requestApprovalFullAccess}
        onLoadEarlierMessages={({ threadId, signal }) => agent.loadEarlierMessages(threadId, signal)}
        onLoadEarlierActivities={({ threadId, runId, signal }) => agent.loadEarlierActivities(threadId, runId, signal)}
        onLoadSubagentDetails={agent.loadSubagentDetails}
        onLoadEarlierError={agent.setThreadError}
        onOpenModelSettings={openModelSettings}
        onRemoveAttachment={removeAttachment}
        onRemoveQueuedMessage={agent.removeQueuedMessage}
        onRetryQueuedMessage={agent.retryQueuedMessage}
        onToggleAttachmentContextPolicy={toggleAttachmentContextPolicy}
        onRemoveSuggestion={removeInputHistoryItem}
        onResume={(responses) => agent.activeThreadId
          ? agent.resume(agent.activeThreadId, responses)
          : Promise.resolve()}
        onSelectMainModel={selectChatModel}
        onSelectModelParameterPreset={selectChatModelParameterPreset}
        onSetDefaultModel={selectDefaultModel}
        onSelectProject={(projectId) => {
          if (projectId !== agent.draftProjectId) startNewThread(projectId)
        }}
        onSpeak={(messageId, text) => speech.playText(messageId, text, true)}
        onSubmit={handleSubmit}
        onReview={async (request) => {
          if (submissionLockRef.current.locked || threadLocked) throw new Error(t('agent.review_busy'))
          if (!selectedModel?.capabilities.toolUse) throw new Error(t('agent.review_model_required'))
          await submissionLockRef.current.run(async () => {
            setSubmissionBusy(true)
            try {
              speech.stop()
              await agent.send(t('agent.review_title'), [], t('agent.review_title'), draftAccessMode,
                selectedModel.id, draftModelParameterPresetId ?? null, request)
            } finally { setSubmissionBusy(false) }
          })
        }}
        onSteerQueuedMessage={agent.steerQueuedMessage}
        onToggleProjectPinned={(project) => updateProjectState(project, { pinned: !project.pinned })}
        onToggleSidebar={toggleSidebar}
        onToggleThreadPinned={agent.togglePinned}
        onToggleSuggestionPinned={toggleInputHistoryPinned}
      />
      )}
      </div>

      <ConfirmDialog request={confirmDialog} onClose={() => setConfirmDialog(undefined)} />
      <UserInputDialog />
      <AvatarCropDialog
        source={avatarCropSource}
        onCancel={cancelPersonaAvatarCrop}
        onChooseSource={choosePersonaAvatar}
        onSave={savePersonaAvatarCrop}
      />
      <ProjectDialog
        config={config}
        open={projectDialogOpen}
        kind={projectDialogKind}
        project={editingProject}
        onClose={() => setProjectDialogOpen(false)}
        onSave={saveProject}
      />
      <AboutDialog
        open={aboutOpen}
        buildInfo={appBuildInfo}
        iconDataUri={appIcon}
        onClose={() => setAboutOpen(false)}
      />
      <DataCleanupDialog
        open={dataCleanupOpen}
        selection={dataCleanupSelection}
        busy={dataCleanupBusy}
        storageUsageLoading={storageUsageLoading}
        usage={dataCleanupUsage}
        onToggleAll={toggleAllDataCleanupTargets}
        onToggle={toggleDataCleanupTarget}
        onClose={closeDataCleanupDialog}
        onRun={() => void runDataCleanup()}
      />
      </div>
    </>
  )
}
