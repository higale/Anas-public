import type { DefaultCapabilitySettings } from '@shared/agentCapabilities'
import type { HelpDocumentId } from '@shared/helpDocuments'
import type { ProjectOperationResult } from '@shared/projectOperation'
import type { AgentActivityWindowInput, AgentRunActivity, AgentSubagentActivity } from '@shared/agentTypes'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AgentAccessMode, AgentMessageEditResult, AgentMessageRangeInput, AgentMessageRegenerateInput, AgentMessageWindowInput, AgentModelRequestPreview, AgentModelRequestPreviewInput, AgentQueuedInput, AgentQueuedInputCreate, AgentResumeInput, AgentRun, AgentRunCancellationResult, AgentRunDirectionInput, AgentRunDirectionReferenceInput, AgentRunReferenceInput, AgentRunSubmission, AgentRunSubmissionInput, AgentRuntimeEvent, AgentStorageUsageSnapshot, AgentSystemContextPreview, AgentSystemContextPreviewInput, AgentThread, AgentThreadCleanupResult, AgentThreadSnapshot, AgentThreadUpdate, AgentWorkspaceState } from '@shared/agentTypes'
import type { AppAvatarImage, AppBuildInfo, AppConfigSnapshot, AppDataStorageUsageSnapshot, AppProfileUpdate, AppSettingsUpdate, AttachmentPreview, AttachmentPreviewOptions, AvatarCropSaveRequest, AvatarCropSource, AvatarCropSourceReadResult, DataBackupResult, DataCleanupRequest, DataCleanupResult, DataRestoreResult, EnvFileSnapshot, FileIconImage, FileIconSize, GaleApi, InputHistorySnapshot, LanguageResourcesSnapshot, McpMaintenanceResult, McpServerConfigSave, McpServerUpdate, McpToolStatus, MemoryItem, MemorySaveRequest, MemorySearchRequest, MemorySearchResult, ModelListRequest, ModelListResponse, ModelProviderConfigSave, Project, ProjectCreateRequest, ProjectDeleteResult, ProjectStateUpdate, ProjectUpdateRequest, ProviderModelConfigSave, RuntimeToolStatus, SelectedAttachment, SkillAvailabilityUpdate, SkillDirectoryAddResult, SkillFileNode, SkillFilePreview, SkillImportResult, SkillInvocationResult, SkillRootUpdate, SkillSnapshot, SpeechGenerateRequest, SpeechRendererDiagnostics, SpeechRendererWarningKind, SpeechReplyConfig, SpeechVoiceInfo, SubagentConfigSave, SystemEnvironmentDetection } from '@shared/types'
import { subscribeAgentRuntimeEvents } from './agentEventSubscription'

const api: GaleApi = {
  recovery: {
    enter: (detail) => ipcRenderer.invoke('recovery:enter', detail),
    inspect: () => ipcRenderer.invoke('recovery:inspect'),
    openDirectory: (kind) => ipcRenderer.invoke('recovery:openDirectory', kind),
    reset: (file) => ipcRenderer.invoke('recovery:reset', file),
    resetProjects: () => ipcRenderer.invoke('recovery:resetProjects'),
    repair: (file) => ipcRenderer.invoke('recovery:repair', file),
    restart: () => ipcRenderer.invoke('recovery:restart')
  },
  speechInput: {
    open: () => ipcRenderer.invoke('speech:openInput')
  },
  agent: {
    userInput: {
      list: () => ipcRenderer.invoke('agent:userInput:list'),
      shown: (id) => ipcRenderer.invoke('agent:userInput:shown', id),
      interact: (id) => ipcRenderer.invoke('agent:userInput:interact', id),
      respond: (id, response) => ipcRenderer.invoke('agent:userInput:respond', id, response),
      onChange: (listener) => {
        const handle = (_event: Electron.IpcRendererEvent, snapshot: import('@shared/userInput').UserInputSnapshot) => listener(snapshot)
        ipcRenderer.on('agent:userInput:changed', handle)
        return () => { ipcRenderer.removeListener('agent:userInput:changed', handle) }
      }
    },
    changes: {
      gitContents: (input, requestId) => ipcRenderer.invoke('agent:changes:gitContents', input, requestId),
      gitReferences: (input, requestId) => ipcRenderer.invoke('agent:changes:gitReferences', input, requestId),
      rounds: (input, requestId) => ipcRenderer.invoke('agent:changes:rounds', input, requestId),
      roundFiles: (input, requestId) => ipcRenderer.invoke('agent:changes:roundFiles', input, requestId),
      roundContents: (input, requestId) => ipcRenderer.invoke('agent:changes:roundContents', input, requestId),
      cancelRead: (requestId: string): Promise<void> => ipcRenderer.invoke('agent:changes:cancelRead', requestId),
      git: (input, requestId) => ipcRenderer.invoke('agent:changes:git', input, requestId)
    },
    workspace: {
      get: (): Promise<AgentWorkspaceState> => ipcRenderer.invoke('agent:workspace:get'),
      set: (state: AgentWorkspaceState): Promise<void> => ipcRenderer.invoke('agent:workspace:set', state)
    },
    threads: {
      list: (): Promise<AgentThread[]> => ipcRenderer.invoke('agent:threads:list'),
      get: (threadId: string): Promise<AgentThreadSnapshot> => ipcRenderer.invoke('agent:threads:get', threadId),
      update: (threadId: string, input: AgentThreadUpdate): Promise<AgentThread> =>
        ipcRenderer.invoke('agent:threads:update', threadId, input),
      setAccessMode: (threadId: string, accessMode: AgentAccessMode): Promise<AgentThread> =>
        ipcRenderer.invoke('agent:threads:setAccessMode', threadId, accessMode),
      delete: (threadId: string): Promise<void> => ipcRenderer.invoke('agent:threads:delete', threadId),
      cleanup: (): Promise<AgentThreadCleanupResult> => ipcRenderer.invoke('agent:threads:cleanup')
    },
    queuedInputs: {
      list: (): Promise<AgentQueuedInput[]> => ipcRenderer.invoke('agent:queuedInputs:list'),
      enqueue: (input: AgentQueuedInputCreate): Promise<AgentQueuedInput> =>
        ipcRenderer.invoke('agent:queuedInputs:enqueue', input),
      remove: (threadId: string, queuedInputId: string): Promise<boolean> =>
        ipcRenderer.invoke('agent:queuedInputs:remove', threadId, queuedInputId),
      markFailed: (threadId: string, queuedInputId: string, error: string): Promise<AgentQueuedInput> =>
        ipcRenderer.invoke('agent:queuedInputs:markFailed', threadId, queuedInputId, error),
      retry: (threadId: string, queuedInputId: string): Promise<AgentQueuedInput> =>
        ipcRenderer.invoke('agent:queuedInputs:retry', threadId, queuedInputId)
    },
    maintenance: {
      compactDatabase: (): Promise<void> => ipcRenderer.invoke('agent:database:compact'),
      getStorageUsage: (): Promise<AgentStorageUsageSnapshot> => ipcRenderer.invoke('agent:storage:getUsage')
    },
    runs: {
      submit: (input: AgentRunSubmissionInput): Promise<AgentRunSubmission> =>
        ipcRenderer.invoke('agent:runs:submit', input),
      compress: (threadId: string): Promise<AgentRun> =>
        ipcRenderer.invoke('agent:runs:compress', threadId),
      recover: (threadId: string): Promise<boolean> =>
        ipcRenderer.invoke('agent:runs:recover', threadId),
      resume: (input: AgentResumeInput): Promise<AgentRun> => ipcRenderer.invoke('agent:runs:resume', input),
      steer: (input: AgentRunDirectionInput): Promise<boolean> =>
        ipcRenderer.invoke('agent:runs:steer', input),
      removeSteer: (input: AgentRunDirectionReferenceInput): Promise<boolean> =>
        ipcRenderer.invoke('agent:runs:steer:remove', input),
      cancel: (input: AgentRunReferenceInput): Promise<AgentRunCancellationResult> =>
        ipcRenderer.invoke('agent:runs:cancel', input)
    },
    messages: {
      truncate: (input: AgentMessageRangeInput): Promise<AgentThreadSnapshot> =>
        ipcRenderer.invoke('agent:messages:truncate', input),
      prepareEdit: (input: AgentMessageRangeInput): Promise<AgentMessageEditResult> =>
        ipcRenderer.invoke('agent:messages:prepareEdit', input),
      regenerate: (input: AgentMessageRegenerateInput): Promise<AgentRun> =>
        ipcRenderer.invoke('agent:messages:regenerate', input),
      loadEarlier: (input: AgentMessageWindowInput): Promise<AgentThreadSnapshot> =>
        ipcRenderer.invoke('agent:messages:loadEarlier', input)
    },
    activities: {
      loadEarlier: (input: AgentActivityWindowInput): Promise<AgentRunActivity> =>
        ipcRenderer.invoke('agent:activities:loadEarlier', input),
      subagent: (input: AgentRunReferenceInput & { subagentId: string }): Promise<AgentSubagentActivity> =>
        ipcRenderer.invoke('agent:activities:subagent', input)
    },
    context: {
      status: (threadId: string) => ipcRenderer.invoke('agent:context:status', threadId),
      preview: (input: AgentSystemContextPreviewInput): Promise<AgentSystemContextPreview> =>
        ipcRenderer.invoke('agent:context:preview', input),
      previewModelRequest: (input: AgentModelRequestPreviewInput): Promise<AgentModelRequestPreview> =>
        ipcRenderer.invoke('agent:context:previewModelRequest', input),
      saveModelRequest: (content: string): Promise<string | null> =>
        ipcRenderer.invoke('agent:context:saveModelRequest', content)
    },
    onEvent: (
      listener: (event: AgentRuntimeEvent) => void,
      subscribed?: () => void | Promise<void>,
      subscriptionError?: (message: string) => void
    ): (() => void) => subscribeAgentRuntimeEvents(ipcRenderer, listener, {
      synchronize: subscribed,
      onError: subscriptionError
    })
  },
  projects: {
    list: (): Promise<Project[]> => ipcRenderer.invoke('projects:list'),
    create: (request: ProjectCreateRequest): Promise<ProjectOperationResult<Project>> => ipcRenderer.invoke('projects:create', request),
    update: (projectId: string, request: ProjectUpdateRequest): Promise<ProjectOperationResult<Project>> => ipcRenderer.invoke('projects:update', projectId, request),
    updateState: (projectId: string, update: ProjectStateUpdate): Promise<Project> => ipcRenderer.invoke('projects:updateState', projectId, update),
    delete: (projectId: string): Promise<ProjectDeleteResult> => ipcRenderer.invoke('projects:delete', projectId),
    deleteThreads: (projectId: string): Promise<ProjectDeleteResult> => ipcRenderer.invoke('projects:deleteThreads', projectId),
    openSourceFolder: (projectId: string, sourceFolder: string): Promise<string> =>
      ipcRenderer.invoke('projects:openSourceFolder', projectId, sourceFolder),
    fromDroppedFiles: (files: File[]): Promise<ProjectOperationResult<string[]>> => {
      const paths = files.map((file) => webUtils.getPathForFile(file)).filter((path) => path.trim().length > 0)
      return ipcRenderer.invoke('projects:fromDroppedFiles', paths)
    },
    chooseSourceFolders: (): Promise<ProjectOperationResult<string[]>> => ipcRenderer.invoke('projects:chooseSourceFolders')
  },
  config: {
    get: (): Promise<AppConfigSnapshot> => ipcRenderer.invoke('config:get'),
    selectDefaultModel: (modelConfigId: string | null): Promise<AppConfigSnapshot> => ipcRenderer.invoke('config:selectDefaultModel', modelConfigId),
    saveModelProvider: (provider: ModelProviderConfigSave): Promise<AppConfigSnapshot> => ipcRenderer.invoke('config:saveModelProvider', provider),
    deleteModelProvider: (providerId: string): Promise<AppConfigSnapshot> => ipcRenderer.invoke('config:deleteModelProvider', providerId),
    moveModelProvider: (providerId: string, direction: -1 | 1): Promise<AppConfigSnapshot> => ipcRenderer.invoke('config:moveModelProvider', providerId, direction),
    saveProviderModel: (model: ProviderModelConfigSave): Promise<AppConfigSnapshot> => ipcRenderer.invoke('config:saveProviderModel', model),
    addProviderModels: (models: ProviderModelConfigSave[]): Promise<AppConfigSnapshot> => ipcRenderer.invoke('config:addProviderModels', models),
    deleteProviderModel: (providerId: string, modelConfigId: string): Promise<AppConfigSnapshot> => ipcRenderer.invoke('config:deleteProviderModel', providerId, modelConfigId),
    moveProviderModel: (providerId: string, modelConfigId: string, direction: -1 | 1): Promise<AppConfigSnapshot> => ipcRenderer.invoke('config:moveProviderModel', providerId, modelConfigId, direction),
    saveCustomTool: (tool: import('@shared/customTools').CustomToolSave): Promise<AppConfigSnapshot> => ipcRenderer.invoke('config:saveCustomTool', tool),
    deleteCustomTool: (id: string): Promise<AppConfigSnapshot> => ipcRenderer.invoke('config:deleteCustomTool', id),
    moveCustomTool: (id: string, direction: -1 | 1): Promise<AppConfigSnapshot> => ipcRenderer.invoke('config:moveCustomTool', id, direction),
    saveSubagent: (subagent: SubagentConfigSave): Promise<AppConfigSnapshot> => ipcRenderer.invoke('config:saveSubagent', subagent),
    deleteSubagent: (index: number): Promise<AppConfigSnapshot> => ipcRenderer.invoke('config:deleteSubagent', index),
    moveSubagent: (index: number, direction: -1 | 1): Promise<AppConfigSnapshot> => ipcRenderer.invoke('config:moveSubagent', index, direction),
    restoreSubagent: (index: number): Promise<AppConfigSnapshot> => ipcRenderer.invoke('config:restoreSubagent', index),
    getCachedModels: (request: ModelListRequest): Promise<ModelListResponse | null> => ipcRenderer.invoke('config:getCachedModels', request),
    fetchModels: (request: ModelListRequest): Promise<ModelListResponse> => ipcRenderer.invoke('config:fetchModels', request),
    saveDefaultCapabilities: (value: DefaultCapabilitySettings): Promise<AppConfigSnapshot> => ipcRenderer.invoke('config:saveDefaultCapabilities', value),
    updateSettings: (settings: AppSettingsUpdate): Promise<AppConfigSnapshot> => ipcRenderer.invoke('config:updateSettings', settings),
    updateProfile: (profile: AppProfileUpdate): Promise<AppConfigSnapshot> => ipcRenderer.invoke('config:updateProfile', profile),
    onChanged: (listener: (config: AppConfigSnapshot) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, config: AppConfigSnapshot): void => listener(config)
      ipcRenderer.on('config:changed', handler)
      return () => ipcRenderer.removeListener('config:changed', handler)
    },
    updateSpeechReply: (settings: Partial<SpeechReplyConfig>): Promise<AppConfigSnapshot> => ipcRenderer.invoke('config:updateSpeechReply', settings),
    updateMcpServer: (index: number, update: McpServerUpdate): Promise<AppConfigSnapshot> => ipcRenderer.invoke('config:updateMcpServer', index, update),
    saveMcpServer: (server: McpServerConfigSave): Promise<AppConfigSnapshot> => ipcRenderer.invoke('config:saveMcpServer', server),
    deleteMcpServer: (index: number): Promise<AppConfigSnapshot> => ipcRenderer.invoke('config:deleteMcpServer', index),
    moveMcpServer: (index: number, direction: -1 | 1): Promise<AppConfigSnapshot> => ipcRenderer.invoke('config:moveMcpServer', index, direction)
  },
  memory: {
    search: (request: MemorySearchRequest = {}): Promise<MemorySearchResult> => ipcRenderer.invoke('memory:search', request),
    save: (request: MemorySaveRequest): Promise<MemoryItem> => ipcRenderer.invoke('memory:save', request),
    delete: (id: string): Promise<void> => ipcRenderer.invoke('memory:delete', id),
    clear: (): Promise<number> => ipcRenderer.invoke('memory:clear')
  },
  tools: {
    get: (projectId, sourceFolders) => ipcRenderer.invoke('tools:get', projectId, sourceFolders),
    refresh: () => ipcRenderer.invoke('tools:refresh'),
    importDirectories: () => ipcRenderer.invoke('tools:importDirectories')
  },
  skills: {
    updateScriptApproval: (projectId: string | undefined, skillId: string | undefined, enabled: boolean): Promise<SkillSnapshot> => ipcRenderer.invoke('skills:updateScriptApproval', projectId, skillId, enabled),
    get: (projectId?: string, sourceFolders?: string[]): Promise<SkillSnapshot> => ipcRenderer.invoke('skills:get', projectId, sourceFolders),
    listFiles: (projectId: string | undefined, skillId: string, relativePath?: string): Promise<SkillFileNode[]> => ipcRenderer.invoke('skills:listFiles', projectId, skillId, relativePath),
    readFile: (projectId: string | undefined, skillId: string, relativePath: string): Promise<SkillFilePreview> => ipcRenderer.invoke('skills:readFile', projectId, skillId, relativePath),
    invoke: (projectId: string | undefined, name: string, sourceAlias: string | undefined, args: string): Promise<SkillInvocationResult> => ipcRenderer.invoke('skills:invoke', projectId, name, sourceAlias, args),
    updateAvailability: (projectId: string | undefined, skillId: string, settings: SkillAvailabilityUpdate): Promise<SkillSnapshot> => ipcRenderer.invoke('skills:updateAvailability', projectId, skillId, settings),
    addDirectory: (projectId?: string): Promise<SkillDirectoryAddResult> => ipcRenderer.invoke('skills:addDirectory', projectId),
    importDirectories: (projectId?: string): Promise<SkillImportResult> => ipcRenderer.invoke('skills:importDirectories', projectId),
    updateDirectory: (projectId: string | undefined, rootId: string, update: SkillRootUpdate): Promise<SkillSnapshot> => ipcRenderer.invoke('skills:updateDirectory', projectId, rootId, update),
    removeDirectory: (projectId: string | undefined, rootId: string): Promise<SkillSnapshot> => ipcRenderer.invoke('skills:removeDirectory', projectId, rootId),
    moveDirectory: (projectId: string | undefined, rootId: string, direction: -1 | 1): Promise<SkillSnapshot> => ipcRenderer.invoke('skills:moveDirectory', projectId, rootId, direction)
  },
  mcp: {
    status: (): Promise<McpToolStatus | null> => ipcRenderer.invoke('mcp:status'),
    test: (): Promise<McpToolStatus> => ipcRenderer.invoke('mcp:test'),
    reloadServer: (index: number): Promise<McpToolStatus> => ipcRenderer.invoke('mcp:reloadServer', index),
    reloadFailed: (): Promise<McpMaintenanceResult> => ipcRenderer.invoke('mcp:reloadFailed'),
    onStatus: (listener: (status: McpToolStatus) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, status: McpToolStatus): void => listener(status)
      ipcRenderer.on('mcp:status', handler)
      return () => ipcRenderer.removeListener('mcp:status', handler)
    }
  },
  files: {
    openText: (): Promise<SelectedAttachment[]> => ipcRenderer.invoke('files:openText'),
    fromDroppedFiles: (files: File[]): Promise<SelectedAttachment[]> => {
      const paths = files.map((file) => webUtils.getPathForFile(file)).filter((path) => path.trim().length > 0)
      return ipcRenderer.invoke('files:readDroppedAttachments', paths)
    },
    readAttachments: (paths: string[]): Promise<SelectedAttachment[]> => ipcRenderer.invoke('files:readAttachments', paths),
    releaseTemporaryAttachments: (paths: string[]): Promise<void> =>
      ipcRenderer.invoke('files:releaseTemporaryAttachments', paths),
    readAttachmentPreview: (path: string, options?: AttachmentPreviewOptions): Promise<AttachmentPreview | null> => ipcRenderer.invoke('files:readAttachmentPreview', path, options),
    readFileIcon: (path: string, size?: FileIconSize): Promise<FileIconImage | null> => ipcRenderer.invoke('files:readFileIcon', path, size),
    showItemInFolder: (path: string): Promise<string> => ipcRenderer.invoke('files:showItemInFolder', path),
    getAvatar: (): Promise<AppAvatarImage | null> => ipcRenderer.invoke('files:getAvatar'),
    getAvatarSource: (): Promise<AvatarCropSource | null> => ipcRenderer.invoke('files:getAvatarSource'),
    chooseAvatarSource: (): Promise<AvatarCropSource | null> => ipcRenderer.invoke('files:chooseAvatarSource'),
    readAvatarSourceFromDroppedFiles: (files: File[]): Promise<AvatarCropSourceReadResult> => {
      const paths = files.map((file) => webUtils.getPathForFile(file)).filter((path) => path.trim().length > 0)
      return ipcRenderer.invoke('files:readAvatarSourceFromDroppedPaths', paths)
    },
    saveAvatarCrop: (request: AvatarCropSaveRequest): Promise<AppAvatarImage | null> => ipcRenderer.invoke('files:saveAvatarCrop', request),
    clearAvatar: (): Promise<AppAvatarImage | null> => ipcRenderer.invoke('files:clearAvatar'),
    onAvatarChanged: (listener: (avatar: AppAvatarImage | null) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, avatar: AppAvatarImage | null): void => listener(avatar)
      ipcRenderer.on('files:avatarChanged', handler)
      return () => ipcRenderer.removeListener('files:avatarChanged', handler)
    }
  },
  inputHistory: {
    get: (): Promise<InputHistorySnapshot> => ipcRenderer.invoke('inputHistory:get'),
    add: (text: string): Promise<InputHistorySnapshot> => ipcRenderer.invoke('inputHistory:add', text),
    remove: (text: string): Promise<InputHistorySnapshot> => ipcRenderer.invoke('inputHistory:remove', text),
    setPinned: (text: string, pinned: boolean): Promise<InputHistorySnapshot> => ipcRenderer.invoke('inputHistory:setPinned', text, pinned)
  },
  speech: {
    generate: (request: SpeechGenerateRequest): Promise<Uint8Array> => ipcRenderer.invoke('speech:generate', request),
    cancel: (requestId: string): Promise<void> => ipcRenderer.invoke('speech:cancel', requestId),
    listVoices: (forceRefresh?: boolean): Promise<SpeechVoiceInfo[]> => ipcRenderer.invoke('speech:listVoices', forceRefresh),
    logWarning: (kind: SpeechRendererWarningKind, diagnostics: SpeechRendererDiagnostics): Promise<void> =>
      ipcRenderer.invoke('speech:logWarning', kind, diagnostics)
  },
  app: {
    getBuildInfo: (): Promise<AppBuildInfo> => ipcRenderer.invoke('app:getBuildInfo'),
    toggleDevTools: (): Promise<void> => ipcRenderer.invoke('app:toggleDevTools'),
    restartInConsole: (): Promise<void> => ipcRenderer.invoke('app:restartInConsole'),
    getIcon: (): Promise<string | undefined> => ipcRenderer.invoke('app:getIcon'),
    getRuntimeTools: (): Promise<RuntimeToolStatus> => ipcRenderer.invoke('app:getRuntimeTools'),
    onAboutRequested: (listener: () => void): (() => void) => {
      const handler = (): void => listener()
      ipcRenderer.on('app:aboutRequested', handler)
      return () => ipcRenderer.removeListener('app:aboutRequested', handler)
    },
    onZoomChanged: (listener: (zoom: number) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, zoom: number): void => listener(zoom)
      ipcRenderer.on('app:zoomChanged', handler)
      return () => ipcRenderer.removeListener('app:zoomChanged', handler)
    },
    quit: (): Promise<void> => ipcRenderer.invoke('app:quit'),
    openExternalUrl: (url: string): Promise<string> => ipcRenderer.invoke('app:openExternalUrl', url),
    readHelp: (documentId: HelpDocumentId): Promise<string> => ipcRenderer.invoke('app:readHelp', documentId),
    onHelpRequested: (listener: () => void): (() => void) => {
      const handler = (): void => listener()
      ipcRenderer.on('app:helpRequested', handler)
      return () => ipcRenderer.removeListener('app:helpRequested', handler)
    },
    openDataDir: (): Promise<string> => ipcRenderer.invoke('app:openDataDir'),
    openPath: (path: string): Promise<string> => ipcRenderer.invoke('app:openPath', path),
    showItemInFolder: (path: string): Promise<string> => ipcRenderer.invoke('app:showItemInFolder', path),
    openLogDir: (): Promise<string> => ipcRenderer.invoke('app:openLogDir'),
    openLogViewer: (): Promise<string> => ipcRenderer.invoke('app:openLogViewer'),
    getDataStorageUsage: (): Promise<AppDataStorageUsageSnapshot> => ipcRenderer.invoke('app:getDataStorageUsage'),
    getDeveloperHttpTraceUsage: () => ipcRenderer.invoke('app:getDeveloperHttpTraceUsage'),
    getDeveloperHttpTraceEnabled: (): Promise<boolean> => ipcRenderer.invoke('app:getDeveloperHttpTraceEnabled'),
    setDeveloperHttpTraceEnabled: (enabled: boolean): Promise<boolean> => ipcRenderer.invoke('app:setDeveloperHttpTraceEnabled', enabled),
    openDeveloperHttpTraceDir: (): Promise<string> => ipcRenderer.invoke('app:openDeveloperHttpTraceDir'),
    readEnvFile: (): Promise<EnvFileSnapshot> => ipcRenderer.invoke('app:readEnvFile'),
    saveEnvFile: (content: string): Promise<EnvFileSnapshot> => ipcRenderer.invoke('app:saveEnvFile', content),
    detectSystemEnvironment: (): Promise<SystemEnvironmentDetection> => ipcRenderer.invoke('app:detectSystemEnvironment'),
    getLanguageResources: (): Promise<LanguageResourcesSnapshot> => ipcRenderer.invoke('app:getLanguageResources'),
    backupData: (): Promise<DataBackupResult | null> => ipcRenderer.invoke('app:backupData'),
    selectDataRestoreBackup: (): Promise<string | null> => ipcRenderer.invoke('app:selectDataRestoreBackup'),
    restoreData: (sourcePath: string): Promise<DataRestoreResult> => ipcRenderer.invoke('app:restoreData', sourcePath),
    cleanupData: (request: DataCleanupRequest): Promise<DataCleanupResult> => ipcRenderer.invoke('app:cleanupData', request)
  }
}

contextBridge.exposeInMainWorld('gale', api)
