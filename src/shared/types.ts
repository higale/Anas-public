import type { HelpDocumentId } from './helpDocuments'
import type { SubagentSelection } from './subagentSelection'
import type { ProjectOperationResult } from './projectOperation'
import type { AgentApi } from './agentTypes'
import type { AgentCapabilities, DefaultCapabilitySettings } from './agentCapabilities'
import type { ProjectIconColor, ProjectIconName } from './projectAppearance'

export type { ProjectIconColor, ProjectIconName } from './projectAppearance'

export type ProjectKind = 'workspace' | 'simple_chat'

export interface ProjectModelSelection {
  modelConfigId?: string
  modelParameterPresetId?: string | null
}

interface ProjectBase extends ProjectModelSelection {
  id: string
  name: string
  icon?: ProjectIconName
  iconColor?: ProjectIconColor
  pinned: boolean
  collapsed: boolean
  createdAt: string
  updatedAt: string
}

export interface WorkspaceProject extends ProjectBase {
  kind: 'workspace'
  advancedSettings: boolean
  codingMode: boolean
  prompt: string
  sourceFolders: string[]
  capabilities: AgentCapabilities
  restrictSubagents: boolean
  /** Optional project selection of global subagent definitions. */
  subagentSelection?: SubagentSelection
}

export interface SimpleChatProject extends ProjectBase {
  kind: 'simple_chat'
  prompt: string
}

export type Project = WorkspaceProject | SimpleChatProject

export const DEFAULT_WORKSPACE_PROJECT_ID = 'default-workspace'

export function isDefaultWorkspaceProject(project: Project): boolean {
  return project.id === DEFAULT_WORKSPACE_PROJECT_ID
}

export function compareProjects(left: Project, right: Project): number {
  const leftDefault = isDefaultWorkspaceProject(left)
  const rightDefault = isDefaultWorkspaceProject(right)
  if (leftDefault !== rightDefault) return leftDefault ? 1 : -1
  return Number(right.pinned) - Number(left.pinned)
    || Date.parse(right.updatedAt) - Date.parse(left.updatedAt)
}

export interface WorkspaceProjectRequest extends ProjectModelSelection {
  kind: 'workspace'
  advancedSettings: boolean
  codingMode: boolean
  prompt: string
  name: string
  icon?: ProjectIconName
  iconColor?: ProjectIconColor
  sourceFolders: string[]
  capabilities: AgentCapabilities
  restrictSubagents: boolean
  /** Optional project selection of global subagent definitions. */
  subagentSelection?: SubagentSelection
}

export interface SimpleChatProjectRequest extends ProjectModelSelection {
  kind: 'simple_chat'
  name: string
  icon?: ProjectIconName
  iconColor?: ProjectIconColor
  prompt: string
}

export type ProjectCreateRequest = WorkspaceProjectRequest | SimpleChatProjectRequest
export type ProjectUpdateRequest = ProjectCreateRequest

export interface ProjectStateUpdate {
  pinned?: boolean
  collapsed?: boolean
}

export interface ProjectDeleteResult {
  projectId: string
  deletedThreadIds: string[]
}

export type ModelProtocol =
  | 'openai_responses'
  | 'openai_chat_completions'
  | 'anthropic_messages'
export type ModelListAuth = 'bearer' | 'anthropic'

export interface ModelCapabilities {
  vision: boolean
  toolUse: boolean
}

export interface ModelParameterPreset {
  id: string
  name: string
  parameters: Record<string, unknown>
}

export type ModelParameterPresetMode = 'protocol_default' | 'custom' | 'none'

export interface ModelDefaults {
  parameters: Record<string, unknown>
  parameterPresetMode: ModelParameterPresetMode
  capabilities: ModelCapabilities
  stream: boolean
  maxContextTokens: number
  maxOutputTokens: number
  contextCompressionThreshold: number
  contextCompressionEnabled: boolean
}

export interface ModelProviderDefaults {
  parameters: Record<string, unknown>
}

export interface ProviderModelConfig {
  id: string
  displayName: string
  model: string
  parameters: Record<string, unknown>
  parameterPresets?: ModelParameterPreset[]
  parameterPresetMode: ModelParameterPresetMode
  defaultParameterPresetId?: string
  capabilities: ModelCapabilities
  stream: boolean
  maxContextTokens: number
  maxOutputTokens: number
  contextCompressionThreshold: number
  contextCompressionEnabled: boolean
}

export interface ProviderModelConfigDetail extends ProviderModelConfig {
  index: number
}

export interface ProviderModelConfigSave {
  id?: string
  providerId: string
  displayName: string
  model: string
  parameters: Record<string, unknown>
  parameterPresets?: ModelParameterPreset[]
  parameterPresetMode: ModelParameterPresetMode
  defaultParameterPresetId?: string
  capabilities: ModelCapabilities
  stream: boolean
  maxContextTokens: number
  maxOutputTokens: number
  contextCompressionThreshold: number
  contextCompressionEnabled: boolean
}

export interface ModelProviderConfig {
  id: string
  name: string
  protocol: ModelProtocol
  baseUrl: string
  modelListUrl: string
  modelListAuth: ModelListAuth
  apiKey?: string
  parameters: Record<string, unknown>
  models: ProviderModelConfigDetail[]
}

export interface ModelProviderConfigDetail extends ModelProviderConfig {
  index: number
}

export interface ModelProviderConfigSave {
  id?: string
  name: string
  protocol: ModelProtocol
  baseUrl: string
  modelListUrl?: string
  modelListAuth: ModelListAuth
  apiKey: string
  parameters: Record<string, unknown>
}

export interface ResolvedModelConfig extends ProviderModelConfig {
  providerId: string
  providerName: string
  protocol: ModelProtocol
  baseUrl: string
  apiKey?: string
}

export interface ModelListRequest {
  providerId?: string
  name?: string
  protocol: ModelProtocol
  baseUrl: string
  modelListUrl?: string
  modelListAuth: ModelListAuth
  model?: string
  apiKey?: string
}

export interface ModelListResponse {
  models: string[]
}

export type SubagentPreset = 'general-purpose' | 'web-researcher' | 'project-analyst'
export interface SubagentDefaults {
  subagentSelection: SubagentSelection
  enabled: boolean
  capabilities: AgentCapabilities
}

export interface SubagentConfig {
  /** Omission follows global defaults for further delegation. */
  subagentSelection?: SubagentSelection
  index: number
  name: string
  /** Included by default; custom selections may grant access independently. */
  enabled: boolean
  preset?: SubagentPreset
  builtIn: boolean
  description: string
  systemPrompt: string
  capabilities: AgentCapabilities
}

export interface SubagentConfigSave {
  subagentSelection?: SubagentSelection
  index?: number
  name: string
  enabled: boolean
  description: string
  systemPrompt: string
  capabilities: AgentCapabilities
}

export interface McpServerConfigDetail {
  index: number
  name: string
  enabled: boolean
  type: McpServerType
  url: string
  id: string
  command: string
  args: string[]
  workingDir: string
  timeoutMs: number
  apiKey?: string
  env: Record<string, string>
}

export type McpServerType = 'stdio' | 'http' | 'sse'

export interface McpServerConfigSave {
  index?: number
  name: string
  enabled: boolean
  timeoutMs: number
  type: McpServerType
  url?: string
  apiKey?: string | null
  id: string
  command?: string
  args: string[]
  workingDir?: string
  env: Record<string, string>
}

export interface McpServerUpdate {
  enabled?: boolean
  timeoutMs?: number
}

export interface McpToolStatus {
  checkedAt: string
  servers: Array<{
    id: string
    index: number
    name: string
    type: McpServerType
    state: 'idle' | 'starting' | 'ready' | 'degraded' | 'recovering' | 'failed' | 'stopped'
    toolCount: number
    toolNames: string[]
    lastCheckedAt?: string
    lastError?: string
    lastStartedAt?: string
    nextRetryAt?: string
  }>
  loaded: Array<{ id: string; index: number; name: string; toolCount: number; toolNames: string[] }>
  errors: Array<{ id: string; index: number; name: string; error: string }>
  tools: RuntimeToolDefinition[]
  toolNames: string[]
}

export interface McpMaintenanceResult {
  checkedAt: string
  scheduled: boolean
  alreadyRunning: boolean
  reason?: 'disabled' | 'no_servers'
}

export interface RuntimeToolDefinition {
  name: string
  capabilityId?: string
  description: string
  parameters: Array<{ name: string; description: string; schema?: unknown }>
  inputSchema?: unknown
}

export interface RuntimeToolStatus {
  checkedAt: string
  tools: RuntimeToolDefinition[]
  toolNames: string[]
}

export type SelectedAttachmentKind = 'text' | 'image' | 'binary'

export interface SelectedAttachment {
  path: string
  name: string
  size: number
  kind: SelectedAttachmentKind
  mimeType: string
  contextPolicy: 'one_turn' | 'conversation'
  temporary?: boolean
  text?: string
  dataUri?: string
  url?: string
  truncated?: boolean
  skippedReason?: string
}

export interface InputHistoryItem {
  text: string
  pinned: boolean
  createdAt: string
  updatedAt: string
}

export interface InputHistorySnapshot {
  maxHistory: number
  items: InputHistoryItem[]
}

export interface DataBackupResult {
  path: string
  backupDir: string
  fileCount: number
  size: number
}

export interface DataRestoreResult {
  path: string
  preRestoreBackupPath: string
  fileCount: number
  size: number
}

export interface StorageUsageValue {
  totalBytes: number
  approximate: boolean
}

export type DataCleanupTarget =
  | 'input_history'
  | 'cache_folder'
  | 'temp_folder'
  | 'log_folder'
  | 'developer_http_trace'

export type DataCleanupRequest = Partial<Record<DataCleanupTarget, boolean>>

export interface DataCleanupResultItem {
  target: DataCleanupTarget
  path?: string
  ok: boolean
  skipped?: boolean
  error?: string
}

export interface DataCleanupResult {
  items: DataCleanupResultItem[]
}

export interface AppDataStorageUsageSnapshot {
  dataDirectory: StorageUsageValue
  developerHttpTrace: StorageUsageValue
  cleanup: Record<DataCleanupTarget, StorageUsageValue>
}

export interface AppAvatarImage {
  path: string
  mimeType: string
  dataUri: string
  source: 'custom' | 'default'
}

export interface AvatarCropArea {
  height: number
  width: number
  x: number
  y: number
}

export type AvatarRotation = 0 | 90 | 180 | 270

export interface AvatarTransform {
  crop: AvatarCropArea
  rotation: AvatarRotation
}

export interface AvatarCropSource {
  dataUri: string
  height: number
  mimeType: string
  path: string
  transform?: AvatarTransform
  width: number
}

export type AvatarCropSourceReadResult =
  | { ok: true; source: AvatarCropSource }
  | { ok: false; errorCode: 'load_failed' | 'unsupported_type' }

export interface AvatarCropSaveRequest {
  pngBytes: Uint8Array
  sourcePath: string
  transform: AvatarTransform
}

export interface AttachmentPreview {
  path: string
  mimeType: string
  src: string
}

export interface AttachmentPreviewOptions {
  mode?: 'thumbnail' | 'original'
  size?: number
  projectId?: string
}

export type FileIconSize = 'small' | 'normal' | 'large'

export interface FileIconImage {
  path: string
  dataUri: string
}

export interface EnvFileSnapshot {
  path: string
  content: string
}

export interface LanguagePackSummary {
  code: string
  name: string
  author?: string
  builtIn: boolean
  userPath?: string
}

export interface LanguageResourcesSnapshot {
  langDir: string
  languages: LanguagePackSummary[]
  resources: Record<string, unknown>
}

export interface SpeechReplyConfig {
  enabled: boolean
  voice: string
  speed: number
}

export interface SpeechVoiceInfo {
  shortName: string
  gender: string
  detail: string
}

export interface SpeechGenerateRequest {
  requestId: string
  /** Plain text already cleaned before segmentation; synthesis must not reparse Markdown. */
  text: string
  voice: string
  speed: number
}

export type SpeechRendererWarningKind =
  | 'playback_media_error'
  | 'playback_start_failed'
  | 'generation_request_failed'

export interface SpeechRendererDiagnostics {
  token: number
  sequence: number
  textLength: number
  code?: number
}

export type RuntimeLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'off'
export type AttachmentTextOverflowMode = 'truncate' | 'error'
export interface SidebarCollapsedSections {
  projects: boolean
  simpleChats: boolean
}

export type SidebarSectionId = keyof SidebarCollapsedSections

export type AppBuildInfo = {
  version: string
  environment: 'production'
  builtAt: string
} | {
  version: string
  environment: 'development'
}

export type ChatContentWidth = 'narrow' | 'wide' | 'adaptive'

export interface AgentFeatures {
  configuration: boolean
  profile: boolean
  environment: boolean
  applicationEnvironment: boolean
  subagents: boolean
  workspaceContext: boolean
  memory: boolean
  skills: boolean
  mcp: boolean
  planning: boolean
  commandExecution: boolean
  networkAccess: boolean
  backgroundTools: boolean
  fileRead: boolean
  fileWrite: boolean
}

export interface EnvironmentContextSettings {
  operatingSystem: boolean
  powerShell: boolean
  bundledCommands: boolean
  currentDate: boolean
  applicationDataDirectory: boolean
  userHomeDirectory: boolean
  customInformationEnabled: boolean
  customInformation: string
}

export interface DetectedSystemEnvironmentTool {
  command: string
  version: string
}

export interface SystemEnvironmentDetection {
  content: string
  tools: DetectedSystemEnvironmentTool[]
}

export type NewThreadModelSelection = 'prompt' | 'default' | 'current'

export interface AppSettings {
  profile: AppProfile
  speechReply: SpeechReplyConfig
  language: string
  theme: string
  fontSize: number
  chatContentWidth: ChatContentWidth
  newThreadModelSelection: NewThreadModelSelection
  attachmentTextMaxChars: number
  attachmentTextOverflow: AttachmentTextOverflowMode
  logLevel: RuntimeLogLevel
  logRetentionDays: number
  maxModelCallsPerRun: number
  environmentContext: EnvironmentContextSettings
  sidebarVisible: boolean
  sidebarWidth: number
  workspacePanelWidth: number
  diffViewMode: 'inline' | 'side_by_side'
  diffFoldUnchanged: boolean
  diffWordWrap: boolean
  sidebarCollapsedSections: SidebarCollapsedSections
  backupDir: string
}

export type AppSettingsUpdate = Partial<Omit<AppSettings, 'profile' | 'speechReply'>>

export interface AssistantProfile {
  name: string
  role: string
  instructions: string
  newAvatarPath: string
}

export interface UserProfile {
  preferredName: string
  personalInfo: string
}

export interface AppProfile {
  assistant: AssistantProfile
  user: UserProfile
}

export interface AppProfileUpdate {
  assistant?: Partial<Omit<AssistantProfile, 'newAvatarPath'>>
  user?: Partial<UserProfile>
}

export interface AppConfigSnapshot {
  customTools: import('./toolPackages').ToolPackage[]
  defaultCapabilities: DefaultCapabilitySettings
  providers: ModelProviderConfigDetail[]
  subagents: SubagentConfig[]
  mcpServers: McpServerConfigDetail[]
  settings: AppSettings
  defaultModelId?: string
  defaultModel?: ResolvedModelConfig
}

export type MemoryScope = 'global' | 'project'
export type MemoryKind = 'preference' | 'fact' | 'experience'
export type MemoryOrigin = 'user' | 'agent'

export interface MemoryItem {
  id: string
  scope: MemoryScope
  projectId?: string
  kind: MemoryKind
  content: string
  keywords: string[]
  importance: number
  origin: MemoryOrigin
  sourceThreadId?: string
  sourceRunId?: string
  createdAt: string
  updatedAt: string
  score?: number
}

export interface MemorySearchRequest {
  query?: string
  scope?: 'all' | MemoryScope
  projectId?: string
  kind?: 'all' | MemoryKind
  limit?: number
  offset?: number
}

export interface MemorySearchResult {
  items: MemoryItem[]
  total: number
}

export interface MemorySaveRequest {
  id?: string
  scope: MemoryScope
  projectId?: string
  kind: MemoryKind
  content: string
  keywords: string[]
  importance: number
}

export type SkillRootKind = 'system' | 'user' | 'project' | 'external'

export const SKILL_ROOT_DISPLAY_NAME_MAX_LENGTH = 80
export const SKILL_SHORTCUT_ALIAS_MAX_LENGTH = 64
export const SKILL_SHORTCUT_ALIAS_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface SkillRootSummary {
  id: string
  kind: SkillRootKind
  name: string
  shortcutAlias: string
  path: string
  removable: boolean
  available: boolean
  issue?: 'not_found' | 'not_directory' | 'unreadable'
}

export interface SkillSummary {
  scriptAutoApprove: boolean
  id: string
  rootId: string
  name: string
  description: string
  compatibility?: string
  modelAvailable: boolean
  userAvailable: boolean
  dirPath: string
  linked: boolean
  linkTarget?: string
  resolvedDirPath?: string
  relativePath: string
  source: SkillRootKind
  rootName: string
  shortcutAlias: string
  shortcut?: string
  modelShadowedBy?: string
  userShadowedBy?: string
  loadError?: SkillLoadIssue
}

export type SkillLoadIssueCode =
  | 'yaml_parse_failed'
  | 'missing_frontmatter'
  | 'missing_name'
  | 'invalid_name'
  | 'name_mismatch'
  | 'missing_description'
  | 'description_too_long'
  | 'invalid_frontmatter_field'
  | 'missing_skill_file'
  | 'unreadable_skill_file'

export interface SkillLoadIssue {
  code: SkillLoadIssueCode
  detail?: string
  name?: string
  expected?: string
}

export interface SkillSnapshot {
  scriptAutoApprove: boolean
  projectId?: string
  roots: SkillRootSummary[]
  skills: SkillSummary[]
}

export interface SkillFileNode {
  name: string
  path: string
  relativePath: string
  kind: 'directory' | 'text' | 'binary' | 'symlink'
  size?: number
  linkTarget?: string
  resolvedPath?: string
  linkDirectory?: boolean
}

export interface SkillFilePreview {
  skillId: string
  name: string
  path: string
  relativePath: string
  size: number
  kind: 'text' | 'binary'
  content?: string
  linkTarget?: string
  resolvedPath: string
}

export interface SkillAvailabilityUpdate {
  modelAvailable?: boolean
  userAvailable?: boolean
}

export interface SkillRootUpdate {
  name: string
  shortcutAlias: string
}

export type SkillDirectoryAddResult =
  | { status: 'cancelled' }
  | { status: 'added'; snapshot: SkillSnapshot }

export type SkillImportError =
  | { code: 'already_exists'; name: string }
  | { code: 'invalid_directory' }
  | { code: 'invalid_skill'; issue: SkillLoadIssue }
  | { code: 'failed' }

export type SkillImportResult =
  | { status: 'cancelled' }
  | { status: 'imported'; names: string[]; snapshot: SkillSnapshot }
  | { status: 'error'; error: SkillImportError }

export type ToolImportResult =
  | { status: 'cancelled' }
  | { status: 'imported'; ids: string[]; names: string[]; config: AppConfigSnapshot }
  | { status: 'error'; error: import('./toolPackages').ToolImportError }

export type SkillInvocationErrorCode = 'user_unavailable' | 'source_not_found' | 'source_skill_not_found'

export interface SkillInvocationResult {
  handled: boolean
  promptText: string
  displayText: string
  errorCode?: SkillInvocationErrorCode
  errorName?: string
}

export interface GaleApi {
  recovery: import('./recovery').RecoveryApi
  speechInput: import('./speechInput').SpeechInputApi
  agent: AgentApi
  projects: {
    list(): Promise<Project[]>
    create(request: ProjectCreateRequest): Promise<ProjectOperationResult<Project>>
    update(projectId: string, request: ProjectUpdateRequest): Promise<ProjectOperationResult<Project>>
    updateState(projectId: string, update: ProjectStateUpdate): Promise<Project>
    delete(projectId: string): Promise<ProjectDeleteResult>
    deleteThreads(projectId: string): Promise<ProjectDeleteResult>
    openSourceFolder(projectId: string, sourceFolder: string): Promise<string>
    fromDroppedFiles(files: File[]): Promise<ProjectOperationResult<string[]>>
    chooseSourceFolders(): Promise<ProjectOperationResult<string[]>>
  }
  config: {
    get(): Promise<AppConfigSnapshot>
    selectDefaultModel(modelConfigId: string | null): Promise<AppConfigSnapshot>
    saveModelProvider(provider: ModelProviderConfigSave): Promise<AppConfigSnapshot>
    deleteModelProvider(providerId: string): Promise<AppConfigSnapshot>
    moveModelProvider(providerId: string, direction: -1 | 1): Promise<AppConfigSnapshot>
    saveProviderModel(model: ProviderModelConfigSave): Promise<AppConfigSnapshot>
    addProviderModels(models: ProviderModelConfigSave[]): Promise<AppConfigSnapshot>
    deleteProviderModel(providerId: string, modelConfigId: string): Promise<AppConfigSnapshot>
    moveProviderModel(providerId: string, modelConfigId: string, direction: -1 | 1): Promise<AppConfigSnapshot>
    saveCustomTool(tool: import('./customTools').CustomToolSave): Promise<AppConfigSnapshot>
    deleteCustomTool(id: string): Promise<AppConfigSnapshot>
    moveCustomTool(id: string, direction: -1 | 1): Promise<AppConfigSnapshot>
    saveSubagent(subagent: SubagentConfigSave): Promise<AppConfigSnapshot>
    deleteSubagent(index: number): Promise<AppConfigSnapshot>
    moveSubagent(index: number, direction: -1 | 1): Promise<AppConfigSnapshot>
    restoreSubagent(index: number): Promise<AppConfigSnapshot>
    getCachedModels(request: ModelListRequest): Promise<ModelListResponse | null>
    fetchModels(request: ModelListRequest): Promise<ModelListResponse>
    saveDefaultCapabilities(value: DefaultCapabilitySettings): Promise<AppConfigSnapshot>
    updateSettings(settings: AppSettingsUpdate): Promise<AppConfigSnapshot>
    updateProfile(profile: AppProfileUpdate): Promise<AppConfigSnapshot>
    onChanged(listener: (config: AppConfigSnapshot) => void): () => void
    updateSpeechReply(settings: Partial<SpeechReplyConfig>): Promise<AppConfigSnapshot>
    updateMcpServer(index: number, update: McpServerUpdate): Promise<AppConfigSnapshot>
    saveMcpServer(server: McpServerConfigSave): Promise<AppConfigSnapshot>
    deleteMcpServer(index: number): Promise<AppConfigSnapshot>
    moveMcpServer(index: number, direction: -1 | 1): Promise<AppConfigSnapshot>
  }
  memory: {
    search(request?: MemorySearchRequest): Promise<MemorySearchResult>
    save(request: MemorySaveRequest): Promise<MemoryItem>
    delete(id: string): Promise<void>
    clear(): Promise<number>
  }
  tools: {
    get(projectId?: string, sourceFolders?: string[]): Promise<import('./toolPackages').ToolSnapshot>
    refresh(): Promise<AppConfigSnapshot>
    importDirectories(): Promise<ToolImportResult>
  }
  skills: {
    updateScriptApproval(projectId: string | undefined, skillId: string | undefined, enabled: boolean): Promise<SkillSnapshot>
    get(projectId?: string, sourceFolders?: string[]): Promise<SkillSnapshot>
    listFiles(projectId: string | undefined, skillId: string, relativePath?: string): Promise<SkillFileNode[]>
    readFile(projectId: string | undefined, skillId: string, relativePath: string): Promise<SkillFilePreview>
    invoke(projectId: string | undefined, name: string, sourceAlias: string | undefined, args: string): Promise<SkillInvocationResult>
    updateAvailability(projectId: string | undefined, skillId: string, settings: SkillAvailabilityUpdate): Promise<SkillSnapshot>
    addDirectory(projectId?: string): Promise<SkillDirectoryAddResult>
    importDirectories(projectId?: string): Promise<SkillImportResult>
    updateDirectory(projectId: string | undefined, rootId: string, update: SkillRootUpdate): Promise<SkillSnapshot>
    removeDirectory(projectId: string | undefined, rootId: string): Promise<SkillSnapshot>
    moveDirectory(projectId: string | undefined, rootId: string, direction: -1 | 1): Promise<SkillSnapshot>
  }
  mcp: {
    status(): Promise<McpToolStatus | null>
    test(): Promise<McpToolStatus>
    reloadServer(index: number): Promise<McpToolStatus>
    reloadFailed(): Promise<McpMaintenanceResult>
    onStatus(listener: (status: McpToolStatus) => void): () => void
  }
  files: {
    openText(): Promise<SelectedAttachment[]>
    fromDroppedFiles(files: File[]): Promise<SelectedAttachment[]>
    readAttachments(paths: string[]): Promise<SelectedAttachment[]>
    releaseTemporaryAttachments(paths: string[]): Promise<void>
    readAttachmentPreview(path: string, options?: AttachmentPreviewOptions): Promise<AttachmentPreview | null>
    readFileIcon(path: string, size?: FileIconSize): Promise<FileIconImage | null>
    showItemInFolder(path: string): Promise<string>
    getAvatar(): Promise<AppAvatarImage | null>
    getAvatarSource(): Promise<AvatarCropSource | null>
    chooseAvatarSource(): Promise<AvatarCropSource | null>
    readAvatarSourceFromDroppedFiles(files: File[]): Promise<AvatarCropSourceReadResult>
    saveAvatarCrop(request: AvatarCropSaveRequest): Promise<AppAvatarImage | null>
    clearAvatar(): Promise<AppAvatarImage | null>
    onAvatarChanged(listener: (avatar: AppAvatarImage | null) => void): () => void
  }
  inputHistory: {
    get(): Promise<InputHistorySnapshot>
    add(text: string): Promise<InputHistorySnapshot>
    remove(text: string): Promise<InputHistorySnapshot>
    setPinned(text: string, pinned: boolean): Promise<InputHistorySnapshot>
  }
  speech: {
    generate(request: SpeechGenerateRequest): Promise<Uint8Array>
    cancel(requestId: string): Promise<void>
    listVoices(forceRefresh?: boolean): Promise<SpeechVoiceInfo[]>
    logWarning(kind: SpeechRendererWarningKind, diagnostics: SpeechRendererDiagnostics): Promise<void>
  }
  app: {
    getBuildInfo(): Promise<AppBuildInfo>
    toggleDevTools(): Promise<void>
    restartInConsole(): Promise<void>
    getIcon(): Promise<string | undefined>
    getRuntimeTools(): Promise<RuntimeToolStatus>
    onAboutRequested(listener: () => void): () => void
    onZoomChanged(listener: (zoom: number) => void): () => void
    quit(): Promise<void>
    openExternalUrl(url: string): Promise<string>
    readHelp(documentId: HelpDocumentId): Promise<string>
    onHelpRequested(listener: () => void): () => void
    openDataDir(): Promise<string>
    openPath(path: string): Promise<string>
    showItemInFolder(path: string): Promise<string>
    openLogDir(): Promise<string>
    openLogViewer(): Promise<string>
    getDataStorageUsage(): Promise<AppDataStorageUsageSnapshot>
    getDeveloperHttpTraceUsage(): Promise<StorageUsageValue>
    getDeveloperHttpTraceEnabled(): Promise<boolean>
    setDeveloperHttpTraceEnabled(enabled: boolean): Promise<boolean>
    openDeveloperHttpTraceDir(): Promise<string>
    readEnvFile(): Promise<EnvFileSnapshot>
    saveEnvFile(content: string): Promise<EnvFileSnapshot>
    detectSystemEnvironment(): Promise<SystemEnvironmentDetection>
    getLanguageResources(): Promise<LanguageResourcesSnapshot>
    backupData(): Promise<DataBackupResult | null>
    selectDataRestoreBackup(): Promise<string | null>
    restoreData(sourcePath: string): Promise<DataRestoreResult>
    cleanupData(request: DataCleanupRequest): Promise<DataCleanupResult>
  }
}
