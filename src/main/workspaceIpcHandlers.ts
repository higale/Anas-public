import { importToolDirectories, initializeToolsStore, listToolSnapshot, toToolImportError } from './toolsStore'
import { updateSkillScriptApproval } from './config/appConfig'
import type { ToolImportResult } from '@shared/types'
import type { DefaultCapabilitySettings } from '@shared/agentCapabilities'
import { projectOperation } from './projectOperation'
import { ProjectOperationFailure } from '@shared/projectOperation'
import { BrowserWindow, shell } from 'electron'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { AppAvatarImage, AppConfigSnapshot, AppProfileUpdate, AppSettingsUpdate, AttachmentPreview, AttachmentPreviewOptions, AvatarCropSource, AvatarCropSourceReadResult, FileIconImage, FileIconSize, InputHistorySnapshot, McpMaintenanceResult, McpServerConfigSave, McpServerUpdate, McpToolStatus, ModelListRequest, ModelListResponse, ModelProviderConfigSave, Project, ProjectCreateRequest, ProjectStateUpdate, ProjectUpdateRequest, ProviderModelConfigSave, SelectedAttachment, SkillAvailabilityUpdate, SkillDirectoryAddResult, SkillFileNode, SkillFilePreview, SkillImportResult, SkillInvocationResult, SkillRootUpdate, SkillSnapshot, SpeechReplyConfig, SubagentConfigSave } from '@shared/types'
import { saveCustomTool, deleteCustomTool, moveCustomTool, saveDefaultCapabilities, addProviderModels, deleteMcpServer, deleteModelProvider, deleteProviderModel, deleteSubagent, getAppConfigSnapshot, moveMcpServer, moveModelProvider, moveProviderModel, moveSubagent, onAppConfigChanged, restoreSubagent, saveMcpServer, saveModelProvider, saveProviderModel, saveSubagent, selectDefaultModel, updateMcpServer, updateProfile, updateSettings, updateSpeechReply } from './config/appConfig'
import { addExternalSkillDirectory, buildUserSkillInvocation, importSkillDirectories, listSkillFiles, listSkillSnapshot, moveExternalSkillDirectory, readSkillFile, removeExternalSkillDirectory, toSkillImportError, updateExternalSkillDirectory, updateSkillAvailability } from './skillsStore'
import { getSkillExamplesDir, getToolExamplesDir } from './config/dataDir'
import { addInputHistory, getInputHistory, removeInputHistory, setInputHistoryPinned } from './inputHistoryStore'
import { closeCachedMcpServerIndex, getCachedMcpStatus, loadMcpRuntimeForCurrentConfig, pingAndReloadFailedMcpServers, reloadMcpRuntimeForServer } from './mcpRuntimeService'
import { fetchAvailableModels, getCachedAvailableModels } from './modelListService'
import { attachmentExtensions, clearAvatarImage, onAvatarChanged, readAttachmentPreview, readAvatarCropSource, readAvatarCropSourceResult, readAvatarImage, readCurrentAvatarCropSource, readDroppedAttachments, readFileIcon, readSelectedAttachments, releaseTemporaryAttachments, saveAvatarCrop } from './attachments'
import { avatarImageExtensions } from './avatarAssets'
import { configureRuntimeLogger } from './runtimeLogger'
import { applyNativeTheme, configureApplicationMenu } from './appShell'
import { dialogParentFromEvent, showModalOpenDialog } from './modalDialog'
import { createProject, getProject, listProjects, updateProject, updateProjectState, validateProjectSourceFolders } from './projectStore'
import { runtimeLog } from './runtimeLogger'
import { deleteProjectLifecycle, deleteProjectThreadsLifecycle, recoverPendingProjectDeletion } from './agent/agentIpcHandlers'
import { handleMainIpc } from './ipcSecurity'
import { resolveWorkspaceImagePath } from './workspaceImagePath'
import { consumePendingAvatarUpdate } from './avatarConfigService'
import { runApplicationDataOperation } from './applicationDataLifecycle'

function runMcpUpdateInBackground(operation: Promise<unknown>, action: string): void {
  void operation.catch((reason) => {
    runtimeLog('warn', 'mcp', `Failed to ${action}.`, { error: reason })
  })
}

export function registerWorkspaceIpcHandlers(): void {
  onAppConfigChanged(({ key, snapshot }) => {
    if (key === 'language') {
      void runApplicationDataOperation(() => configureApplicationMenu()).catch((reason) => {
        runtimeLog('warn', 'config', 'Failed to apply a saved language config change.', { error: reason })
      })
    }
    if (key === 'theme') applyNativeTheme(snapshot.settings.theme)
    if (key === 'log_level' || key === 'log_retention_days') {
      configureRuntimeLogger(snapshot.settings.logLevel, snapshot.settings.logRetentionDays)
    }
    for (const window of BrowserWindow.getAllWindows()) {
      try {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send('config:changed', snapshot)
        }
      } catch (reason) {
        try {
          runtimeLog('warn', 'config', 'Failed to notify a renderer about a saved config change.', { error: reason })
        } catch {
          // Notification is best-effort after the config has already been persisted.
        }
      }
    }
  })
  onAvatarChanged((avatar) => {
    for (const window of BrowserWindow.getAllWindows()) {
      try {
        if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
          window.webContents.send('files:avatarChanged', avatar)
        }
      } catch (reason) {
        try {
          runtimeLog('warn', 'avatar', 'Failed to notify a renderer about a saved avatar change.', { error: reason })
        } catch {
          // Notification is best-effort after the avatar assets have already committed.
        }
      }
    }
  })
  handleMainIpc('projects:list', async (): Promise<Project[]> => {
    await recoverPendingProjectDeletion()
    return listProjects()
  })
  handleMainIpc('projects:create', async (_event, request: ProjectCreateRequest) => projectOperation(async () => {
    await recoverPendingProjectDeletion()
    return createProject(request)
  }))
  handleMainIpc('projects:update', async (_event, projectId: string, request: ProjectUpdateRequest) => projectOperation(async () => {
    await recoverPendingProjectDeletion()
    return updateProject(projectId, request)
  }))
  handleMainIpc('projects:updateState', async (_event, projectId: string, update: ProjectStateUpdate): Promise<Project> => {
    await recoverPendingProjectDeletion()
    return updateProjectState(projectId, update)
  })
  handleMainIpc('projects:delete', async (_event, projectId: string) => deleteProjectLifecycle(projectId))
  handleMainIpc('projects:deleteThreads', async (_event, projectId: string) => deleteProjectThreadsLifecycle(projectId))
  handleMainIpc('projects:openSourceFolder', async (_event, projectId: string, sourceFolder: string): Promise<string> => {
    if (typeof projectId !== 'string' || typeof sourceFolder !== 'string') {
      throw new Error('Project source folder is invalid.')
    }
    const project = await getProject(projectId)
    if (project.kind !== 'workspace' || !project.sourceFolders.includes(sourceFolder)) {
      throw new Error('Source folder does not belong to the project.')
    }
    const info = await stat(sourceFolder)
    if (!info.isDirectory()) throw new Error('Project source folder is not a directory.')
    const error = await shell.openPath(sourceFolder)
    if (error) throw new Error(error)
    return sourceFolder
  })
  handleMainIpc('projects:fromDroppedFiles', async (_event, filePaths: string[]) => projectOperation(async () => {
    if (!Array.isArray(filePaths)) throw new ProjectOperationFailure({ code: 'invalid_settings' }, 'Dropped project folders are invalid.')
    return validateProjectSourceFolders(filePaths)
  }))
  handleMainIpc('projects:chooseSourceFolders', async (event) => projectOperation(async () => {
    const result = await showModalOpenDialog(dialogParentFromEvent(event), {
      title: 'Choose project source folders',
      properties: ['openDirectory', 'multiSelections', 'createDirectory']
    })
    return result.canceled ? [] : result.filePaths
  }))
  handleMainIpc('config:get', async (): Promise<AppConfigSnapshot> => {
    try {
      await consumePendingAvatarUpdate()
    } catch (reason) {
      runtimeLog('warn', 'profile', 'Failed to apply a pending avatar update during config refresh.', { error: reason })
    }
    return getAppConfigSnapshot()
  })
  handleMainIpc('config:selectDefaultModel', async (_event, modelConfigId: string | null): Promise<AppConfigSnapshot> => selectDefaultModel(modelConfigId))
  handleMainIpc('config:saveModelProvider', async (_event, provider: ModelProviderConfigSave): Promise<AppConfigSnapshot> => saveModelProvider(provider))
  handleMainIpc('config:deleteModelProvider', async (_event, providerId: string): Promise<AppConfigSnapshot> => deleteModelProvider(providerId))
  handleMainIpc('config:moveModelProvider', async (_event, providerId: string, direction: -1 | 1): Promise<AppConfigSnapshot> => moveModelProvider(providerId, direction))
  handleMainIpc('config:saveProviderModel', async (_event, model: ProviderModelConfigSave): Promise<AppConfigSnapshot> => saveProviderModel(model))
  handleMainIpc('config:addProviderModels', async (_event, models: ProviderModelConfigSave[]): Promise<AppConfigSnapshot> => addProviderModels(models))
  handleMainIpc('config:deleteProviderModel', async (_event, providerId: string, modelConfigId: string): Promise<AppConfigSnapshot> => deleteProviderModel(providerId, modelConfigId))
  handleMainIpc('config:moveProviderModel', async (_event, providerId: string, modelConfigId: string, direction: -1 | 1): Promise<AppConfigSnapshot> => moveProviderModel(providerId, modelConfigId, direction))
  handleMainIpc('tools:get', async (_event, projectId?: string, sourceFolders?: string[]) => {
    const project = sourceFolders === undefined && projectId ? await getProject(projectId) : undefined
    return listToolSnapshot(sourceFolders ?? (project?.kind === 'workspace' ? project.sourceFolders : []))
  })
  handleMainIpc('tools:refresh', async () => getAppConfigSnapshot())
  handleMainIpc('tools:importDirectories', async (event): Promise<ToolImportResult> => {
    try {
      await initializeToolsStore()
      const result = await showModalOpenDialog(dialogParentFromEvent(event), {
        defaultPath: getToolExamplesDir(), properties: ['openDirectory', 'multiSelections']
      })
      if (result.canceled || !result.filePaths.length) return { status: 'cancelled' }
      return { status: 'imported', ...await importToolDirectories(result.filePaths), config: await getAppConfigSnapshot() }
    } catch (reason) {
      const error = toToolImportError(reason)
      if (error.code === 'failed') runtimeLog('error', 'tools', 'Failed to import tool directories.', { error: reason })
      return { status: 'error', error }
    }
  })
  handleMainIpc('config:saveCustomTool', async (_event, tool: import('@shared/customTools').CustomToolSave) => saveCustomTool(tool))
  handleMainIpc('config:deleteCustomTool', async (_event, id: string) => deleteCustomTool(id))
  handleMainIpc('config:moveCustomTool', async (_event, id: string, direction: -1 | 1) => moveCustomTool(id, direction))
  handleMainIpc('config:saveSubagent', async (_event, subagent: SubagentConfigSave): Promise<AppConfigSnapshot> => saveSubagent(subagent))
  handleMainIpc('config:deleteSubagent', async (_event, index: number): Promise<AppConfigSnapshot> => deleteSubagent(index))
  handleMainIpc('config:moveSubagent', async (_event, index: number, direction: -1 | 1): Promise<AppConfigSnapshot> => moveSubagent(index, direction))
  handleMainIpc('config:restoreSubagent', async (_event, index: number): Promise<AppConfigSnapshot> => restoreSubagent(index))
  handleMainIpc('config:getCachedModels', async (_event, request: ModelListRequest): Promise<ModelListResponse | null> => getCachedAvailableModels(request))
  handleMainIpc('config:fetchModels', async (_event, request: ModelListRequest): Promise<ModelListResponse> => fetchAvailableModels(request))
  handleMainIpc('config:saveDefaultCapabilities', async (_event, value: DefaultCapabilitySettings): Promise<AppConfigSnapshot> => saveDefaultCapabilities(value))
  handleMainIpc('config:updateSettings', async (_event, settings: AppSettingsUpdate): Promise<AppConfigSnapshot> => {
    const snapshot = await updateSettings(settings)
    if (settings.language !== undefined) {
      await configureApplicationMenu()
    }
    if (settings.theme !== undefined) applyNativeTheme(snapshot.settings.theme)
    if (settings.logLevel !== undefined || settings.logRetentionDays !== undefined) {
      configureRuntimeLogger(snapshot.settings.logLevel, snapshot.settings.logRetentionDays)
    }
    return snapshot
  })
  handleMainIpc('config:updateProfile', async (_event, profile: AppProfileUpdate): Promise<AppConfigSnapshot> => {
    return updateProfile(profile)
  })
  handleMainIpc('config:updateSpeechReply', async (_event, settings: Partial<SpeechReplyConfig>): Promise<AppConfigSnapshot> => {
    return updateSpeechReply(settings)
  })
  handleMainIpc('config:updateMcpServer', async (_event, index: number, update: McpServerUpdate): Promise<AppConfigSnapshot> => {
    const snapshot = await updateMcpServer(index, update)
    runMcpUpdateInBackground(reloadMcpRuntimeForServer(index), 'reload an updated MCP server')
    return snapshot
  })
  handleMainIpc('config:saveMcpServer', async (_event, server: McpServerConfigSave): Promise<AppConfigSnapshot> => {
    const snapshot = await saveMcpServer(server)
    runMcpUpdateInBackground(
      reloadMcpRuntimeForServer(server.index ?? snapshot.mcpServers.length - 1),
      'load a saved MCP server'
    )
    return snapshot
  })
  handleMainIpc('config:deleteMcpServer', async (_event, index: number): Promise<AppConfigSnapshot> => {
    const snapshot = await deleteMcpServer(index)
    runMcpUpdateInBackground(
      closeCachedMcpServerIndex(index).then(() => loadMcpRuntimeForCurrentConfig(false)),
      'remove a deleted MCP server'
    )
    return snapshot
  })
  handleMainIpc('config:moveMcpServer', async (_event, index: number, direction: -1 | 1): Promise<AppConfigSnapshot> => {
    const snapshot = await moveMcpServer(index, direction)
    runMcpUpdateInBackground(loadMcpRuntimeForCurrentConfig(false), 'apply reordered MCP servers')
    return snapshot
  })
  handleMainIpc('skills:updateScriptApproval', async (_event, projectId: string | undefined, skillId: string | undefined, enabled: boolean): Promise<SkillSnapshot> => updateSkillScriptApproval(projectId, skillId, enabled))
  handleMainIpc('skills:get', async (_event, projectId?: string, sourceFolders?: string[]): Promise<SkillSnapshot> => listSkillSnapshot(projectId, sourceFolders))
  handleMainIpc('skills:listFiles', async (_event, projectId: string | undefined, skillId: string, relativePath?: string): Promise<SkillFileNode[]> => listSkillFiles(projectId, skillId, relativePath))
  handleMainIpc('skills:readFile', async (_event, projectId: string | undefined, skillId: string, relativePath: string): Promise<SkillFilePreview> => readSkillFile(projectId, skillId, relativePath))
  handleMainIpc('skills:invoke', async (_event, projectId: string | undefined, name: string, sourceAlias: string | undefined, args: string): Promise<SkillInvocationResult> => buildUserSkillInvocation(projectId, name, sourceAlias, args))
  handleMainIpc('skills:updateAvailability', async (_event, projectId: string | undefined, skillId: string, settings: SkillAvailabilityUpdate): Promise<SkillSnapshot> => updateSkillAvailability(projectId, skillId, settings))
  handleMainIpc('skills:addDirectory', async (event, projectId?: string): Promise<SkillDirectoryAddResult> => {
    const result = await showModalOpenDialog(dialogParentFromEvent(event), {
      properties: ['openDirectory']
    })
    const path = result.filePaths[0]
    if (result.canceled || !path) return { status: 'cancelled' }
    return { status: 'added', snapshot: await addExternalSkillDirectory(path, projectId) }
  })
  handleMainIpc('skills:importDirectories', async (event, projectId?: string): Promise<SkillImportResult> => {
    const result = await showModalOpenDialog(dialogParentFromEvent(event), {
      defaultPath: getSkillExamplesDir(),
      properties: ['openDirectory', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return { status: 'cancelled' }
    try {
      return { status: 'imported', ...await importSkillDirectories(result.filePaths, projectId) }
    } catch (reason) {
      const error = toSkillImportError(reason)
      if (error.code === 'failed') runtimeLog('error', 'skills', 'Failed to import Skill directories.', { error: reason })
      return { status: 'error', error }
    }
  })
  handleMainIpc('skills:updateDirectory', async (_event, projectId: string | undefined, rootId: string, update: SkillRootUpdate): Promise<SkillSnapshot> => updateExternalSkillDirectory(rootId, update, projectId))
  handleMainIpc('skills:removeDirectory', async (_event, projectId: string | undefined, rootId: string): Promise<SkillSnapshot> => removeExternalSkillDirectory(rootId, projectId))
  handleMainIpc('skills:moveDirectory', async (_event, projectId: string | undefined, rootId: string, direction: -1 | 1): Promise<SkillSnapshot> => moveExternalSkillDirectory(rootId, direction, projectId))
  handleMainIpc('mcp:test', async (): Promise<McpToolStatus> => {
    return loadMcpRuntimeForCurrentConfig(true)
  })
  handleMainIpc('mcp:reloadServer', async (_event, index: number): Promise<McpToolStatus> => {
    return reloadMcpRuntimeForServer(index)
  })
  handleMainIpc('mcp:reloadFailed', async (): Promise<McpMaintenanceResult> => {
    return pingAndReloadFailedMcpServers()
  })
  handleMainIpc('mcp:status', async (): Promise<McpToolStatus | null> => {
    return getCachedMcpStatus()
  })
  handleMainIpc('inputHistory:get', async (): Promise<InputHistorySnapshot> => getInputHistory())
  handleMainIpc('inputHistory:add', async (_event, text: string): Promise<InputHistorySnapshot> => addInputHistory(text))
  handleMainIpc('inputHistory:remove', async (_event, text: string): Promise<InputHistorySnapshot> => removeInputHistory(text))
  handleMainIpc('inputHistory:setPinned', async (_event, text: string, pinned: boolean): Promise<InputHistorySnapshot> => setInputHistoryPinned(text, pinned))
  handleMainIpc('files:getAvatar', async (): Promise<AppAvatarImage | null> => {
    return readAvatarImage()
  })
  handleMainIpc('files:getAvatarSource', async (): Promise<AvatarCropSource | null> => {
    return readCurrentAvatarCropSource()
  })
  handleMainIpc('files:chooseAvatarSource', async (event): Promise<AvatarCropSource | null> => {
    const result = await showModalOpenDialog(dialogParentFromEvent(event), {
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: avatarImageExtensions.map((ext) => ext.slice(1)) }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return readAvatarCropSource(result.filePaths[0])
  })
  handleMainIpc('files:readAvatarSourceFromDroppedPaths', async (_event, paths: unknown): Promise<AvatarCropSourceReadResult> => {
    const sourcePath = Array.isArray(paths)
      ? paths.find((path): path is string => typeof path === 'string' && path.trim().length > 0)
      : undefined
    return readAvatarCropSourceResult(sourcePath)
  })
  handleMainIpc('files:saveAvatarCrop', async (_event, request: unknown): Promise<AppAvatarImage | null> => {
    return saveAvatarCrop(request)
  })
  handleMainIpc('files:clearAvatar', async (): Promise<AppAvatarImage | null> => {
    return clearAvatarImage()
  })
  handleMainIpc('files:openText', async (event): Promise<SelectedAttachment[]> => {
    const result = await showModalOpenDialog(dialogParentFromEvent(event), {
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Attachments', extensions: attachmentExtensions },
        { name: 'All Files', extensions: ['*'] }
      ]
    })
    if (result.canceled) return []

    return readSelectedAttachments(result.filePaths)
  })
  handleMainIpc('files:readDroppedAttachments', async (_event, filePaths: string[]): Promise<SelectedAttachment[]> => {
    if (!Array.isArray(filePaths)) return []
    return readDroppedAttachments(filePaths.filter((filePath): filePath is string => typeof filePath === 'string'))
  })
  handleMainIpc('files:readAttachments', async (_event, filePaths: string[]): Promise<SelectedAttachment[]> => {
    if (!Array.isArray(filePaths)) return []
    return readSelectedAttachments(filePaths.filter((filePath): filePath is string => typeof filePath === 'string'))
  })
  handleMainIpc('files:releaseTemporaryAttachments', async (_event, filePaths: string[]): Promise<void> => {
    if (!Array.isArray(filePaths)) return
    await releaseTemporaryAttachments(
      filePaths.filter((filePath): filePath is string => typeof filePath === 'string')
    )
  })
  handleMainIpc('files:readAttachmentPreview', async (_event, filePath: string, options?: AttachmentPreviewOptions): Promise<AttachmentPreview | null> => {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) return null
    const normalizedOptions = options && typeof options === 'object' && !Array.isArray(options)
      ? options
      : undefined
    const projectId = typeof normalizedOptions?.projectId === 'string'
      ? normalizedOptions.projectId.trim()
      : ''
    const requestedPath = filePath.trim()
    const project = !isAbsolute(requestedPath) && projectId ? await getProject(projectId) : undefined
    const resolvedPath = await resolveWorkspaceImagePath(requestedPath, project)
    if (!resolvedPath) return null
    return readAttachmentPreview(resolvedPath, normalizedOptions && {
      mode: normalizedOptions.mode,
      size: normalizedOptions.size
    })
  })
  handleMainIpc('files:readFileIcon', async (_event, filePath: string, size?: FileIconSize): Promise<FileIconImage | null> => {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) return null
    try {
      return await readFileIcon(filePath, size)
    } catch {
      return null
    }
  })
  handleMainIpc('files:showItemInFolder', async (_event, filePath: string): Promise<string> => {
    if (typeof filePath !== 'string' || filePath.trim().length === 0) throw new Error('File path is required.')
    await stat(filePath)
    shell.showItemInFolder(filePath)
    return filePath
  })
}
