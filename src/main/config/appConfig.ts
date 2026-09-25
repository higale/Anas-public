// Skill settings keep their domain store and serialized mutation queue.
export { updateSkillScriptApproval } from '../skillsStore'
import { parseDefaultCapabilitySettings, serializeDefaultCapabilitySettings, type DefaultCapabilitySettings } from '@shared/agentCapabilities'
import { createHash, randomUUID } from 'node:crypto'
import type { CustomToolSave } from '@shared/customTools'
import { listToolSnapshot, saveToolPackage, deleteToolPackage, moveToolPackage } from '../toolsStore'
import { clampSpeechReplySpeed, defaultSpeechReplyVoice } from '@shared/speechText'
import type { AppConfigSnapshot, AppProfile, AppProfileUpdate, AppSettings, AppSettingsUpdate, AttachmentTextOverflowMode, ChatContentWidth, McpServerConfigSave, McpServerUpdate, ModelProviderConfig, ModelProviderConfigSave, NewThreadModelSelection, ProviderModelConfigSave, ResolvedModelConfig, RuntimeLogLevel, SidebarCollapsedSections, SpeechReplyConfig, SubagentConfigSave } from '@shared/types'
import { normalizeSidebarWidth, normalizeUiFontSize, normalizeWorkspacePanelWidth } from '@shared/uiPreferences'
import { mcpServerConfigDetail, normalizeMcpServer, rawMcpServerFromSave, type McpServerConfig } from './mcpServerConfigMapper'
import { modelProviderConfigDetail, normalizeModelProvider, normalizeProviderModel, rawModelProviderFromSave, rawProviderModelFromSave, resolveModelConfig } from './modelConfigMapper'
import {
  asRecord,
  readBundledRawConfig,
  readRawConfig,
  userSettingsConfigExists,
  writeRawMcpServersConfig,
  writeRawModelsConfig,
  writeRawSettingsConfig,
  writeRawCapabilitiesConfig,
  writeRawSubagentsConfig,
  type RawAppConfig,
  type RawAppSettings,
  type RawMcpServer
} from './rawAppConfig'
import { normalizeSubagent, rawSubagentFromSave } from './subagentConfigMapper'
import { normalizeAppProfile, rawAppProfile } from './profileConfig'
import { runtimeLog } from '../runtimeLogger'
import { resolveDefaultProfile } from '../languageStore'
import { armCurrentAgentToolEffect } from '../agent/toolEffectScope'

export type { McpServerConfig } from './mcpServerConfigMapper'

export interface McpRuntimeConfigSnapshot {
  enabled: boolean
  servers: McpServerConfig[]
}

let configMutationTail: Promise<void> = Promise.resolve()
const appConfigChangeListeners = new Set<(change: AppConfigChange) => void>()

export interface AppConfigChange {
  config: 'settings' | 'models'
  key: string
  snapshot: AppConfigSnapshot
}

export interface ConfigValueUpdateResult {
  changed: boolean
  config: 'settings'
  key: string
  snapshot: AppConfigSnapshot
  value: unknown
}

export const assistantNewAvatarPathKey = 'profile.assistant.new_avatar_path'

export function onAppConfigChanged(listener: (change: AppConfigChange) => void): () => void {
  appConfigChangeListeners.add(listener)
  return () => appConfigChangeListeners.delete(listener)
}

function emitAppConfigChanged(change: AppConfigChange): void {
  for (const listener of appConfigChangeListeners) {
    try {
      listener(change)
    } catch (reason) {
      try {
        runtimeLog('warn', 'config', 'A config change listener failed after the config was saved.', { error: reason })
      } catch {
        // Config persistence has already committed; observer failures must not change its result.
      }
    }
  }
}

async function savedModelsSnapshot(): Promise<AppConfigSnapshot> {
  const snapshot = await getAppConfigSnapshot()
  emitAppConfigChanged({ config: 'models', key: 'providers', snapshot })
  return snapshot
}

function serializeConfigMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = configMutationTail.then(mutation, mutation)
  configMutationTail = result.then(() => undefined, () => undefined)
  return result
}

export async function initializeAppProfile(): Promise<void> {
  return serializeConfigMutation(async () => {
    if (await userSettingsConfigExists()) return
    const bundled = await readBundledRawConfig()
    const settings = normalizeSettings(bundled)
    bundled.settings = {
      ...bundled.settings,
      profile: rawAppProfile(await resolveDefaultProfile(settings.language))
    }
    await writeRawSettingsConfig(bundled)
  })
}

function assertUniqueMcpServerIds(servers: unknown[]): void {
  const seen = new Map<string, number>()
  servers.forEach((server, index) => {
    const id = normalizeMcpServer(server, index).id
    const existingIndex = seen.get(id)
    if (existingIndex !== undefined) {
      throw new Error(`MCP server ID "${id}" is already used by server ${existingIndex + 1}.`)
    }
    seen.set(id, index)
  })
}

function assertUniqueModelConfigIds(providers: NonNullable<RawAppConfig['providers']>): void {
  const providerIds = new Map<string, number>()
  const modelIds = new Map<string, string>()
  providers.forEach((rawProvider, providerIndex) => {
    const provider = normalizeModelProvider(rawProvider, providerIndex)
    const existingProviderIndex = providerIds.get(provider.id)
    if (existingProviderIndex !== undefined) {
      throw new Error(`Provider ID "${provider.id}" is already used by provider ${existingProviderIndex + 1}.`)
    }
    providerIds.set(provider.id, providerIndex)
    for (const model of provider.models) {
      const existingProviderName = modelIds.get(model.id)
      if (existingProviderName) {
        throw new Error(`Model configuration ID "${model.id}" is already used by providers "${existingProviderName}" and "${provider.name}".`)
      }
      modelIds.set(model.id, provider.name)
    }
  })
}

function assertUniqueSubagentNames(subagents: NonNullable<RawAppConfig['subagents']>): void {
  const seen = new Map<string, number>()
  subagents.forEach((subagent, index) => {
    const name = normalizeSubagent(subagent, index).name
    const existingIndex = seen.get(name)
    if (existingIndex !== undefined) {
      throw new Error(`Subagent name "${name}" is already used by subagent ${existingIndex + 1}.`)
    }
    seen.set(name, index)
  })
}

function requireString(value: unknown, key: string): string {
  if (typeof value === 'string') return value
  throw new Error(`Config value ${key} must be a string.`)
}

function requireBoolean(value: unknown, key: string): boolean {
  if (typeof value === 'boolean') return value
  throw new Error(`Config value ${key} must be a boolean.`)
}

function requireNumber(value: unknown, key: string): number {
  if (typeof value === 'number') return value
  throw new Error(`Config value ${key} must be a number.`)
}

function normalizeRuntimeLogLevel(value: unknown): RuntimeLogLevel {
  return value === 'trace' || value === 'debug' || value === 'info' || value === 'warn' || value === 'error' || value === 'off'
    ? value
    : 'info'
}

function normalizeTheme(value: unknown): string {
  return value === 'light' || value === 'dark' ? value : 'system'
}

function normalizeMaxModelCallsPerRun(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(9999, Math.max(0, Math.floor(value)))
    : 0
}

function normalizeLogRetentionDays(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(3650, Math.max(0, Math.floor(value)))
    : 14
}

function normalizeAttachmentTextMaxChars(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(2_000_000, Math.max(1_000, Math.floor(value)))
    : 200_000
}

function normalizeAttachmentTextOverflow(value: unknown): AttachmentTextOverflowMode {
  return value === 'truncate' || value === 'error' ? value : 'truncate'
}

function normalizeChatContentWidth(value: unknown): ChatContentWidth {
  return value === 'wide' || value === 'adaptive' ? value : 'narrow'
}

function normalizeNewThreadModelSelection(value: unknown): NewThreadModelSelection {
  return value === 'prompt' || value === 'current' ? value : 'default'
}

function normalizeSidebarCollapsedSections(raw: RawAppConfig): SidebarCollapsedSections {
  const sections = raw.settings?.sidebar_collapsed_sections
  if (!sections) throw new Error('Config setting settings.sidebar_collapsed_sections is missing.')
  return {
    projects: requireBoolean(sections.projects, 'settings.sidebar_collapsed_sections.projects'),
    simpleChats: requireBoolean(sections.simple_chats, 'settings.sidebar_collapsed_sections.simple_chats')
  }
}

function normalizeEnvironmentContext(raw: RawAppConfig): AppSettings['environmentContext'] {
  const context = raw.settings?.environment_context
  if (!context) throw new Error('Config setting settings.environment_context is missing.')
  return {
    operatingSystem: requireBoolean(context.operating_system, 'settings.environment_context.operating_system'),
    powerShell: requireBoolean(context.power_shell, 'settings.environment_context.power_shell'),
    bundledCommands: requireBoolean(context.bundled_commands, 'settings.environment_context.bundled_commands'),
    currentDate: requireBoolean(context.current_date, 'settings.environment_context.current_date'),
    applicationDataDirectory: requireBoolean(
      context.application_data_directory,
      'settings.environment_context.application_data_directory'
    ),
    userHomeDirectory: requireBoolean(context.user_home_directory, 'settings.environment_context.user_home_directory'),
    customInformationEnabled: requireBoolean(
      context.custom_information_enabled,
      'settings.environment_context.custom_information_enabled'
    ),
    customInformation: requireString(context.custom_information, 'settings.environment_context.custom_information')
  }
}

function normalizeSettings(raw: RawAppConfig): AppSettings {
  const settings = raw.settings
  if (!settings) throw new Error('Config settings are missing.')
  return {
    profile: normalizeAppProfile(settings.profile),
    speechReply: normalizeSpeechReply(raw),
    language: requireString(settings.language, 'settings.language'),
    theme: normalizeTheme(settings.theme),
    fontSize: normalizeUiFontSize(settings.font_size),
    chatContentWidth: normalizeChatContentWidth(settings.chat_content_width),
    newThreadModelSelection: normalizeNewThreadModelSelection(settings.new_thread_model_selection),
    attachmentTextMaxChars: normalizeAttachmentTextMaxChars(settings.attachment_text_max_chars),
    attachmentTextOverflow: normalizeAttachmentTextOverflow(settings.attachment_text_overflow),
    logLevel: normalizeRuntimeLogLevel(settings.log_level),
    logRetentionDays: normalizeLogRetentionDays(settings.log_retention_days),
    maxModelCallsPerRun: normalizeMaxModelCallsPerRun(settings.max_model_calls_per_run),
    environmentContext: normalizeEnvironmentContext(raw),
    sidebarVisible: requireBoolean(settings.sidebar_visible, 'settings.sidebar_visible'),
    sidebarWidth: normalizeSidebarWidth(settings.sidebar_width),
    workspacePanelWidth: normalizeWorkspacePanelWidth(settings.workspace_panel_width),
    diffViewMode: settings.diff_view_mode === 'side_by_side' ? 'side_by_side' : 'inline',
    diffFoldUnchanged: requireBoolean(settings.diff_fold_unchanged, 'settings.diff_fold_unchanged'),
    diffWordWrap: requireBoolean(settings.diff_word_wrap, 'settings.diff_word_wrap'),
    sidebarCollapsedSections: normalizeSidebarCollapsedSections(raw),
    backupDir: requireString(settings.backup_dir, 'settings.backup_dir')
  }
}

function normalizeSpeechReply(raw: RawAppConfig): SpeechReplyConfig {
  const speechReply = raw.settings?.speech_reply
  if (!speechReply) throw new Error('Config setting settings.speech_reply is missing.')
  return {
    enabled: requireBoolean(speechReply.enabled, 'settings.speech_reply.enabled'),
    voice: defaultSpeechReplyVoice(requireString(speechReply.voice, 'settings.speech_reply.voice')),
    speed: clampSpeechReplySpeed(requireNumber(speechReply.speed, 'settings.speech_reply.speed'))
  }
}

export async function getAppConfigSnapshot(): Promise<AppConfigSnapshot> {
  const [raw, catalog] = await Promise.all([readRawConfig(), listToolSnapshot()])
  return { ...normalizeAppConfigSnapshot(raw), customTools: catalog.tools }
}

export function normalizeAppConfigSnapshot(raw: RawAppConfig): AppConfigSnapshot {
  const settings = normalizeSettings(raw)
  const providers = (raw.providers ?? []).map(normalizeModelProvider)
  assertUniqueModelConfigIds(raw.providers ?? [])
  const providerDetails = providers.map(modelProviderConfigDetail)
  const resolvedModels = providers.flatMap((provider) => provider.models.map((model) => resolveModelConfig(provider, model)))
  const subagents = (raw.subagents ?? []).map(normalizeSubagent)
  assertUniqueSubagentNames(raw.subagents ?? [])
  assertUniqueMcpServerIds(raw.mcp_servers ?? [])
  const mcpServers = (raw.mcp_servers ?? []).map(mcpServerConfigDetail)
  const defaultModelId = raw.settings?.default_model_id ?? undefined
  const defaultModel = defaultModelId
    ? resolvedModels.find((model) => model.id === defaultModelId)
    : undefined
  if (defaultModelId && !defaultModel) {
    throw new Error(`Default model configuration ID "${defaultModelId}" is not configured.`)
  }
  return { defaultCapabilities: parseDefaultCapabilitySettings(raw.capabilities), customTools: [], providers: providerDetails, subagents, mcpServers, settings, defaultModelId, defaultModel }
}

const maxConfigValueBytes = 256 * 1024
const maxConfigValueDepth = 32
const configKeyPattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/

function canonicalConfigValue(value: unknown, seen: Set<object>, depth: number): unknown {
  if (depth > maxConfigValueDepth) throw new Error('Config value nesting is too deep.')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Config values must contain only finite numbers.')
    return value
  }
  if (!value || typeof value !== 'object') {
    throw new Error('Config values must be valid JSON values.')
  }
  if (seen.has(value)) throw new Error('Config values must not contain cycles.')
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      return value.map((item) => canonicalConfigValue(item, seen, depth + 1))
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Config object values must be plain JSON objects.')
    }
    const result = Object.create(null) as Record<string, unknown>
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalConfigValue((value as Record<string, unknown>)[key], seen, depth + 1)
    }
    return result
  } finally {
    seen.delete(value)
  }
}

function configValueJson(value: unknown): string {
  const json = JSON.stringify(canonicalConfigValue(value, new Set(), 0))
  if (Buffer.byteLength(json, 'utf8') > maxConfigValueBytes) {
    throw new Error(`Config value exceeds the ${maxConfigValueBytes}-byte limit.`)
  }
  return json
}

function cloneConfigValue(value: unknown): unknown {
  return JSON.parse(configValueJson(value)) as unknown
}

function settingsKeySegments(key: string): string[] {
  const normalized = key.trim()
  if (!configKeyPattern.test(normalized)) {
    throw new Error('Config key must be a dot-separated snake_case settings path.')
  }
  return normalized.split('.')
}

function readSettingsPath(root: unknown, segments: readonly string[]): { found: boolean; value?: unknown } {
  let current = root
  for (const segment of segments) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return { found: false }
    const record = current as Record<string, unknown>
    if (!Object.hasOwn(record, segment)) return { found: false }
    current = record[segment]
  }
  return { found: true, value: current }
}

function writeSettingsPath(root: Record<string, unknown>, segments: readonly string[], value: unknown): void {
  let current = root
  for (const segment of segments.slice(0, -1)) {
    const next = current[segment]
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      throw new Error(`Config key settings.${segments.join('.')} is not an object path.`)
    }
    current = next as Record<string, unknown>
  }
  current[segments.at(-1)!] = value
}

function rawSettingsFromSnapshot(snapshot: AppConfigSnapshot): RawAppSettings {
  const settings = snapshot.settings
  return {
    profile: rawAppProfile(settings.profile),
    speech_reply: {
      enabled: settings.speechReply.enabled,
      voice: settings.speechReply.voice,
      speed: settings.speechReply.speed
    },
    default_model_id: snapshot.defaultModelId ?? null,
    language: settings.language,
    theme: settings.theme,
    font_size: settings.fontSize,
    chat_content_width: settings.chatContentWidth,
    new_thread_model_selection: settings.newThreadModelSelection,
    attachment_text_max_chars: settings.attachmentTextMaxChars,
    attachment_text_overflow: settings.attachmentTextOverflow,
    log_level: settings.logLevel,
    log_retention_days: settings.logRetentionDays,
    max_model_calls_per_run: settings.maxModelCallsPerRun,
    environment_context: {
      operating_system: settings.environmentContext.operatingSystem,
      power_shell: settings.environmentContext.powerShell,
      bundled_commands: settings.environmentContext.bundledCommands,
      current_date: settings.environmentContext.currentDate,
      application_data_directory: settings.environmentContext.applicationDataDirectory,
      user_home_directory: settings.environmentContext.userHomeDirectory,
      custom_information_enabled: settings.environmentContext.customInformationEnabled,
      custom_information: settings.environmentContext.customInformation
    },
    sidebar_visible: settings.sidebarVisible,
    sidebar_width: settings.sidebarWidth,
    workspace_panel_width: settings.workspacePanelWidth,
    diff_view_mode: settings.diffViewMode,
    diff_fold_unchanged: settings.diffFoldUnchanged,
    diff_word_wrap: settings.diffWordWrap,
    sidebar_collapsed_sections: {
      projects: settings.sidebarCollapsedSections.projects,
      simple_chats: settings.sidebarCollapsedSections.simpleChats
    },
    backup_dir: settings.backupDir
  }
}

export function findResolvedModelConfig(
  config: Pick<AppConfigSnapshot, 'providers'>,
  modelConfigId: string | undefined
): ResolvedModelConfig | undefined {
  if (!modelConfigId) return undefined
  for (const provider of config.providers) {
    const model = provider.models.find((candidate) => candidate.id === modelConfigId)
    if (model) return resolveModelConfig(provider, model)
  }
  return undefined
}

export async function getResolvedModelConfig(modelConfigId: string): Promise<ResolvedModelConfig | undefined> {
  return findResolvedModelConfig(await getAppConfigSnapshot(), modelConfigId)
}

export async function getModelProviderConfig(providerId: string): Promise<ModelProviderConfig | undefined> {
  const raw = await readRawConfig()
  return (raw.providers ?? []).map(normalizeModelProvider).find((provider) => provider.id === providerId)
}

export async function getMcpRuntimeConfigSnapshot(): Promise<McpRuntimeConfigSnapshot> {
  const raw = await readRawConfig()
  return {
    enabled: true,
    servers: (raw.mcp_servers ?? []).map(normalizeMcpServer).filter((server) => server.enabled)
  }
}

export async function getBackupDirectory(): Promise<string> {
  const raw = await readRawConfig()
  return raw.settings?.backup_dir?.trim() ?? ''
}

export async function updateBackupDirectory(path: string): Promise<void> {
  return serializeConfigMutation(async () => {
    const raw = await readRawConfig()
    raw.settings = {
      ...raw.settings,
      backup_dir: path
    }
    await writeRawSettingsConfig(raw)
  })
}

export async function selectDefaultModel(modelConfigId: string | null): Promise<AppConfigSnapshot> {
  return serializeConfigMutation(async () => {
    const raw = await readRawConfig()
    if (modelConfigId !== null) {
      const providers = (raw.providers ?? []).map(normalizeModelProvider)
      const exists = providers.some((provider) => provider.models.some((model) => model.id === modelConfigId))
      if (!exists) throw new Error(`Model configuration not found: ${modelConfigId}`)
    }
    raw.settings = {
      ...raw.settings,
      default_model_id: modelConfigId
    }
    await writeRawSettingsConfig(raw)
    const snapshot = await getAppConfigSnapshot()
    emitAppConfigChanged({ config: 'settings', key: 'default_model_id', snapshot })
    return snapshot
  })
}

export async function saveModelProvider(provider: ModelProviderConfigSave): Promise<AppConfigSnapshot> {
  return serializeConfigMutation(async () => {
    const raw = await readRawConfig()
    const providers = Array.isArray(raw.providers) ? [...raw.providers] : []
    if (provider.id === undefined) {
      const providerId = randomUUID()
      const created = rawModelProviderFromSave(provider, providerId)
      providers.push(created)
    } else {
      const index = providers.findIndex((entry, entryIndex) => normalizeModelProvider(entry, entryIndex).id === provider.id)
      if (index < 0) throw new Error(`Provider not found: ${provider.id}`)
      providers[index] = rawModelProviderFromSave(provider, provider.id, providers[index])
    }
    assertUniqueModelConfigIds(providers)
    raw.providers = providers
    await writeRawModelsConfig(raw)
    return savedModelsSnapshot()
  })
}

export async function deleteModelProvider(providerId: string): Promise<AppConfigSnapshot> {
  return serializeConfigMutation(async () => {
    const raw = await readRawConfig()
    const providers = Array.isArray(raw.providers) ? [...raw.providers] : []
    const index = providers.findIndex((entry, entryIndex) => normalizeModelProvider(entry, entryIndex).id === providerId)
    if (index < 0) throw new Error(`Provider not found: ${providerId}`)
    const deletedModelIds = new Set(normalizeModelProvider(providers[index], index).models.map((model) => model.id))
    providers.splice(index, 1)
    const defaultDeleted = raw.settings?.default_model_id
      ? deletedModelIds.has(raw.settings.default_model_id)
      : false
    raw.providers = providers
    if (defaultDeleted) {
      raw.settings = {
        ...raw.settings,
        default_model_id: null
      }
    }
    if (defaultDeleted) await writeRawSettingsConfig(raw)
    await writeRawModelsConfig(raw)
    return savedModelsSnapshot()
  })
}

export async function moveModelProvider(providerId: string, direction: -1 | 1): Promise<AppConfigSnapshot> {
  return serializeConfigMutation(async () => {
    const raw = await readRawConfig()
    const providers = Array.isArray(raw.providers) ? [...raw.providers] : []
    const index = providers.findIndex((entry, entryIndex) => normalizeModelProvider(entry, entryIndex).id === providerId)
    if (index < 0) throw new Error(`Provider not found: ${providerId}`)
    const nextIndex = index + direction
    if (nextIndex < 0 || nextIndex >= providers.length) return getAppConfigSnapshot()

    const [provider] = providers.splice(index, 1)
    providers.splice(nextIndex, 0, provider)
    raw.providers = providers
    await writeRawModelsConfig(raw)
    return savedModelsSnapshot()
  })
}

export async function saveProviderModel(model: ProviderModelConfigSave): Promise<AppConfigSnapshot> {
  return serializeConfigMutation(async () => {
    const raw = await readRawConfig()
    const providers = Array.isArray(raw.providers) ? [...raw.providers] : []
    const providerIndex = providers.findIndex((entry, index) => normalizeModelProvider(entry, index).id === model.providerId)
    if (providerIndex < 0) throw new Error(`Provider not found: ${model.providerId}`)
    const provider = { ...providers[providerIndex] }
    const protocol = normalizeModelProvider(provider, providerIndex).protocol
    const models = Array.isArray(provider.models) ? [...provider.models] : []
    if (model.id === undefined) {
      models.push(rawProviderModelFromSave(model, randomUUID(), protocol))
    } else {
      const modelIndex = models.findIndex((entry, index) => (
        normalizeProviderModel(entry, providerIndex, index, protocol).id === model.id
      ))
      if (modelIndex < 0) throw new Error(`Model configuration not found: ${model.id}`)
      models[modelIndex] = rawProviderModelFromSave(model, model.id, protocol, models[modelIndex])
    }
    provider.models = models
    providers[providerIndex] = provider
    assertUniqueModelConfigIds(providers)
    raw.providers = providers
    await writeRawModelsConfig(raw)
    return savedModelsSnapshot()
  })
}

export async function addProviderModels(modelsToAdd: ProviderModelConfigSave[]): Promise<AppConfigSnapshot> {
  return serializeConfigMutation(async () => {
    if (!Array.isArray(modelsToAdd)) throw new Error('Model configurations must be an array.')
    if (modelsToAdd.length === 0) throw new Error('At least one model configuration is required.')
    if (modelsToAdd.some((model) => !model || typeof model !== 'object')) {
      throw new Error('Each model configuration must be an object.')
    }
    if (modelsToAdd.some((model) => model.id !== undefined)) {
      throw new Error('Bulk model creation cannot update existing model configurations.')
    }
    const providerId = modelsToAdd[0].providerId
    if (modelsToAdd.some((model) => model.providerId !== providerId)) {
      throw new Error('Bulk model creation must target one provider.')
    }

    const raw = await readRawConfig()
    const providers = Array.isArray(raw.providers) ? [...raw.providers] : []
    const providerIndex = providers.findIndex((entry, index) => normalizeModelProvider(entry, index).id === providerId)
    if (providerIndex < 0) throw new Error(`Provider not found: ${providerId}`)
    const provider = { ...providers[providerIndex] }
    const protocol = normalizeModelProvider(provider, providerIndex).protocol
    const models = Array.isArray(provider.models) ? [...provider.models] : []
    models.push(...modelsToAdd.map((model) => rawProviderModelFromSave(model, randomUUID(), protocol)))
    provider.models = models
    providers[providerIndex] = provider
    assertUniqueModelConfigIds(providers)
    raw.providers = providers
    await writeRawModelsConfig(raw)
    return savedModelsSnapshot()
  })
}

export async function deleteProviderModel(providerId: string, modelConfigId: string): Promise<AppConfigSnapshot> {
  return serializeConfigMutation(async () => {
    const raw = await readRawConfig()
    const providers = Array.isArray(raw.providers) ? [...raw.providers] : []
    const providerIndex = providers.findIndex((entry, index) => normalizeModelProvider(entry, index).id === providerId)
    if (providerIndex < 0) throw new Error(`Provider not found: ${providerId}`)
    const provider = { ...providers[providerIndex] }
    const protocol = normalizeModelProvider(provider, providerIndex).protocol
    const models = Array.isArray(provider.models) ? [...provider.models] : []
    const modelIndex = models.findIndex((entry, index) => (
      normalizeProviderModel(entry, providerIndex, index, protocol).id === modelConfigId
    ))
    if (modelIndex < 0) throw new Error(`Model configuration not found: ${modelConfigId}`)
    models.splice(modelIndex, 1)
    provider.models = models
    providers[providerIndex] = provider
    raw.providers = providers
    const defaultDeleted = raw.settings?.default_model_id === modelConfigId
    if (defaultDeleted) {
      raw.settings = { ...raw.settings, default_model_id: null }
      await writeRawSettingsConfig(raw)
    }
    await writeRawModelsConfig(raw)
    return savedModelsSnapshot()
  })
}

export async function moveProviderModel(
  providerId: string,
  modelConfigId: string,
  direction: -1 | 1
): Promise<AppConfigSnapshot> {
  return serializeConfigMutation(async () => {
    const raw = await readRawConfig()
    const providers = Array.isArray(raw.providers) ? [...raw.providers] : []
    const providerIndex = providers.findIndex((entry, index) => normalizeModelProvider(entry, index).id === providerId)
    if (providerIndex < 0) throw new Error(`Provider not found: ${providerId}`)
    const provider = { ...providers[providerIndex] }
    const protocol = normalizeModelProvider(provider, providerIndex).protocol
    const models = Array.isArray(provider.models) ? [...provider.models] : []
    const modelIndex = models.findIndex((entry, index) => (
      normalizeProviderModel(entry, providerIndex, index, protocol).id === modelConfigId
    ))
    if (modelIndex < 0) throw new Error(`Model configuration not found: ${modelConfigId}`)
    const nextIndex = modelIndex + direction
    if (nextIndex < 0 || nextIndex >= models.length) return getAppConfigSnapshot()
    const [moved] = models.splice(modelIndex, 1)
    models.splice(nextIndex, 0, moved)
    provider.models = models
    providers[providerIndex] = provider
    raw.providers = providers
    await writeRawModelsConfig(raw)
    return savedModelsSnapshot()
  })
}

export async function saveSubagent(subagent: SubagentConfigSave): Promise<AppConfigSnapshot> {
  return serializeConfigMutation(async () => {
    const raw = await readRawConfig()
    const subagents = Array.isArray(raw.subagents) ? [...raw.subagents] : []
    if (subagent.index === undefined) {
      subagents.push(rawSubagentFromSave(subagent))
    } else {
      if (subagent.index < 0 || subagent.index >= subagents.length) {
        throw new Error(`Subagent index ${subagent.index} is out of range.`)
      }
      subagents[subagent.index] = rawSubagentFromSave(subagent, subagents[subagent.index])
    }
    assertUniqueSubagentNames(subagents)
    raw.subagents = subagents
    await writeRawSubagentsConfig(raw)
    return getAppConfigSnapshot()
  })
}

export async function saveCustomTool(input: CustomToolSave): Promise<AppConfigSnapshot> {
  await saveToolPackage(input)
  return getAppConfigSnapshot()
}
export async function deleteCustomTool(id: string): Promise<AppConfigSnapshot> {
  await deleteToolPackage(id)
  return getAppConfigSnapshot()
}
export async function moveCustomTool(id: string, direction: -1 | 1): Promise<AppConfigSnapshot> {
  await moveToolPackage(id, direction)
  return getAppConfigSnapshot()
}

export async function deleteSubagent(index: number): Promise<AppConfigSnapshot> {
  return serializeConfigMutation(async () => {
    const raw = await readRawConfig()
    const subagents = Array.isArray(raw.subagents) ? [...raw.subagents] : []
    if (index < 0 || index >= subagents.length) throw new Error(`Subagent index ${index} is out of range.`)
    if (normalizeSubagent(subagents[index], index).builtIn) {
      throw new Error('Built-in subagents cannot be deleted.')
    }
    subagents.splice(index, 1)
    raw.subagents = subagents
    await writeRawSubagentsConfig(raw)
    return getAppConfigSnapshot()
  })
}

export async function moveSubagent(index: number, direction: -1 | 1): Promise<AppConfigSnapshot> {
  return serializeConfigMutation(async () => {
    const raw = await readRawConfig()
    const subagents = Array.isArray(raw.subagents) ? [...raw.subagents] : []
    const nextIndex = index + direction
    if (index < 0 || index >= subagents.length) throw new Error(`Subagent index ${index} is out of range.`)
    if (nextIndex < 0 || nextIndex >= subagents.length) return getAppConfigSnapshot()
    const [subagent] = subagents.splice(index, 1)
    subagents.splice(nextIndex, 0, subagent)
    raw.subagents = subagents
    await writeRawSubagentsConfig(raw)
    return getAppConfigSnapshot()
  })
}

export async function restoreSubagent(index: number): Promise<AppConfigSnapshot> {
  return serializeConfigMutation(async () => {
    const raw = await readRawConfig()
    const subagents = Array.isArray(raw.subagents) ? [...raw.subagents] : []
    if (index < 0 || index >= subagents.length) throw new Error(`Subagent index ${index} is out of range.`)
    const current = normalizeSubagent(subagents[index], index)
    if (!current.preset) throw new Error('Only built-in subagents can be restored.')
    const bundled = await readBundledRawConfig()
    const replacement = (bundled.subagents ?? []).find((candidate, candidateIndex) =>
      normalizeSubagent(candidate, candidateIndex).preset === current.preset
    )
    if (!replacement) throw new Error(`Bundled subagent preset "${current.preset}" was not found.`)
    subagents[index] = replacement
    assertUniqueSubagentNames(subagents)
    raw.subagents = subagents
    await writeRawSubagentsConfig(raw)
    return getAppConfigSnapshot()
  })
}

export async function updateConfigValue(
  config: string,
  key: string,
  value: unknown
): Promise<ConfigValueUpdateResult> {
  if (config !== 'settings') throw new Error(`Config document "${config}" is not supported.`)
  const segments = settingsKeySegments(key)
  const normalizedKey = segments.join('.')
  const desiredValue = cloneConfigValue(value)
  return serializeConfigMutation(async () => {
    const [raw, bundled] = await Promise.all([readRawConfig(), readBundledRawConfig()])
    if (!raw.settings || !bundled.settings) throw new Error('Config settings are missing.')
    if (!readSettingsPath(bundled.settings, segments).found) {
      throw new Error(`Config key settings.${normalizedKey} does not exist.`)
    }
    const currentSettings = cloneConfigValue(raw.settings) as Record<string, unknown>
    const currentValue = readSettingsPath(currentSettings, segments)
    if (!currentValue.found) throw new Error(`Config key settings.${normalizedKey} is unavailable.`)
    writeSettingsPath(currentSettings, segments, desiredValue)
    const candidateSnapshot = normalizeAppConfigSnapshot({
      ...raw,
      settings: currentSettings as RawAppSettings
    })
    const canonicalSettings = rawSettingsFromSnapshot(candidateSnapshot)
    const acceptedValue = readSettingsPath(canonicalSettings, segments)
    if (!acceptedValue.found) {
      throw new Error(`Config key settings.${normalizedKey} is not mapped by the application.`)
    }
    if (configValueJson(acceptedValue.value) !== configValueJson(desiredValue)) {
      throw new Error(`Config value for settings.${normalizedKey} is invalid or non-canonical.`)
    }
    const changed = configValueJson(currentValue.value) !== configValueJson(acceptedValue.value)
    if (changed) {
      armCurrentAgentToolEffect({
        kind: 'config_update',
        target: {
          config,
          key: normalizedKey,
          beforeFingerprint: createHash('sha256').update(configValueJson(currentValue.value)).digest('hex'),
          desiredFingerprint: createHash('sha256').update(configValueJson(acceptedValue.value)).digest('hex')
        },
        recoveryMode: 'idempotent'
      })
      raw.settings = canonicalSettings
      await writeRawSettingsConfig(raw)
    }
    const snapshot = await getAppConfigSnapshot()
    if (changed) emitAppConfigChanged({ config, key: normalizedKey, snapshot })
    return {
      changed,
      config,
      key: normalizedKey,
      snapshot,
      value: acceptedValue.value
    }
  })
}

export async function clearNewAvatarPath(expectedPath: string): Promise<boolean> {
  return serializeConfigMutation(async () => {
    const raw = await readRawConfig()
    const profile = normalizeAppProfile(raw.settings?.profile)
    if (profile.assistant.newAvatarPath !== expectedPath) return false
    profile.assistant.newAvatarPath = ''
    raw.settings = {
      ...raw.settings,
      profile: rawAppProfile(profile)
    }
    await writeRawSettingsConfig(raw)
    const snapshot = await getAppConfigSnapshot()
    emitAppConfigChanged({ config: 'settings', key: assistantNewAvatarPathKey, snapshot })
    return true
  })
}

export async function fillEmptyCustomEnvironmentInformation(content: string): Promise<boolean> {
  if (!content.trim()) return false
  return serializeConfigMutation(async () => {
    const raw = await readRawConfig()
    const context = normalizeEnvironmentContext(raw)
    if (!context.customInformationEnabled || context.customInformation.trim()) return false
    raw.settings = {
      ...raw.settings,
      environment_context: { ...raw.settings?.environment_context, custom_information: content }
    }
    await writeRawSettingsConfig(raw)
    const snapshot = await getAppConfigSnapshot()
    emitAppConfigChanged({ config: 'settings', key: 'environment_context.custom_information', snapshot })
    return true
  })
}

export async function updateSettings(settings: AppSettingsUpdate): Promise<AppConfigSnapshot> {
  return serializeConfigMutation(async () => {
    const raw = await readRawConfig()
    raw.settings = {
      ...raw.settings,
      language: settings.language ?? raw.settings?.language,
      theme: settings.theme === undefined ? raw.settings?.theme : normalizeTheme(settings.theme),
      font_size: settings.fontSize === undefined
        ? raw.settings?.font_size
        : normalizeUiFontSize(settings.fontSize),
      chat_content_width: settings.chatContentWidth ?? raw.settings?.chat_content_width,
      new_thread_model_selection: settings.newThreadModelSelection ?? raw.settings?.new_thread_model_selection,
      attachment_text_max_chars: settings.attachmentTextMaxChars ?? raw.settings?.attachment_text_max_chars,
      attachment_text_overflow: settings.attachmentTextOverflow ?? raw.settings?.attachment_text_overflow,
      log_level: settings.logLevel ?? raw.settings?.log_level,
      log_retention_days: settings.logRetentionDays ?? raw.settings?.log_retention_days,
      max_model_calls_per_run: settings.maxModelCallsPerRun === undefined
        ? raw.settings?.max_model_calls_per_run
        : normalizeMaxModelCallsPerRun(settings.maxModelCallsPerRun),
      environment_context: settings.environmentContext
        ? {
            operating_system: settings.environmentContext.operatingSystem,
            power_shell: settings.environmentContext.powerShell,
            bundled_commands: settings.environmentContext.bundledCommands,
            current_date: settings.environmentContext.currentDate,
            application_data_directory: settings.environmentContext.applicationDataDirectory,
            user_home_directory: settings.environmentContext.userHomeDirectory,
            custom_information_enabled: settings.environmentContext.customInformationEnabled,
            custom_information: settings.environmentContext.customInformation
          }
        : raw.settings?.environment_context,
      diff_view_mode: settings.diffViewMode === undefined ? raw.settings?.diff_view_mode : settings.diffViewMode === 'side_by_side' ? 'side_by_side' : 'inline',
      diff_fold_unchanged: settings.diffFoldUnchanged ?? raw.settings?.diff_fold_unchanged,
      diff_word_wrap: settings.diffWordWrap ?? raw.settings?.diff_word_wrap,
      sidebar_visible: settings.sidebarVisible ?? raw.settings?.sidebar_visible,
      workspace_panel_width: settings.workspacePanelWidth === undefined
        ? raw.settings?.workspace_panel_width
        : normalizeWorkspacePanelWidth(settings.workspacePanelWidth),
      sidebar_width: settings.sidebarWidth === undefined
        ? raw.settings?.sidebar_width
        : normalizeSidebarWidth(settings.sidebarWidth),
      sidebar_collapsed_sections: settings.sidebarCollapsedSections
          ? {
            projects: settings.sidebarCollapsedSections.projects,
            simple_chats: settings.sidebarCollapsedSections.simpleChats
          }
        : raw.settings?.sidebar_collapsed_sections,
      backup_dir: settings.backupDir ?? raw.settings?.backup_dir
    }
    await writeRawSettingsConfig(raw)
    return getAppConfigSnapshot()
  })
}

function hasProfileUpdate(update: AppProfileUpdate): boolean {
  return [
    update.assistant?.name,
    update.assistant?.role,
    update.assistant?.instructions,
    update.user?.preferredName,
    update.user?.personalInfo
  ].some((value) => value !== undefined)
}

function assertProfileUpdate(update: AppProfileUpdate): void {
  if (!update || typeof update !== 'object' || !hasProfileUpdate(update)) {
    throw new Error('At least one profile field is required.')
  }
  const fields: Array<[unknown, string]> = [
    [update.assistant?.name, 'assistant.name'],
    [update.assistant?.role, 'assistant.role'],
    [update.assistant?.instructions, 'assistant.instructions'],
    [update.user?.preferredName, 'user.preferred_name'],
    [update.user?.personalInfo, 'user.personal_info']
  ]
  for (const [value, path] of fields) {
    if (value !== undefined && typeof value !== 'string') {
      throw new Error(`Profile value ${path} must be a string.`)
    }
  }
  if (update.assistant?.name !== undefined && !update.assistant.name.trim()) {
    throw new Error('Profile value assistant.name must not be empty.')
  }
}

type ProfileUpdateField = readonly [path: string, before: string, desired: string]

function profileUpdateFields(
  current: AppProfile,
  desired: AppProfile,
  update: AppProfileUpdate
): ProfileUpdateField[] {
  const fields: ProfileUpdateField[] = []
  if (update.assistant?.name !== undefined) {
    fields.push(['assistant.name', current.assistant.name, desired.assistant.name])
  }
  if (update.assistant?.role !== undefined) {
    fields.push(['assistant.role', current.assistant.role, desired.assistant.role])
  }
  if (update.assistant?.instructions !== undefined) {
    fields.push(['assistant.instructions', current.assistant.instructions, desired.assistant.instructions])
  }
  if (update.user?.preferredName !== undefined) {
    fields.push(['user.preferredName', current.user.preferredName, desired.user.preferredName])
  }
  if (update.user?.personalInfo !== undefined) {
    fields.push(['user.personalInfo', current.user.personalInfo, desired.user.personalInfo])
  }
  return fields
}

function profileFieldFingerprint(fields: ProfileUpdateField[], valueIndex: 1 | 2): string {
  return createHash('sha256')
    .update(JSON.stringify(fields.map(([path, before, desired]) => [
      path,
      valueIndex === 1 ? before : desired
    ])))
    .digest('hex')
}

export async function updateProfile(update: AppProfileUpdate): Promise<AppConfigSnapshot> {
  assertProfileUpdate(update)
  return serializeConfigMutation(async () => {
    const raw = await readRawConfig()
    const current = normalizeAppProfile(raw.settings?.profile)
    const desired: AppProfile = {
      assistant: {
        ...current.assistant,
        ...update.assistant,
        ...(update.assistant?.name !== undefined
          ? { name: update.assistant.name.trim() }
          : {})
      },
      user: {
        ...current.user,
        ...update.user
      }
    }
    const fields = profileUpdateFields(current, desired, update)
    const alreadyApplied = fields.every(([, before, after]) => before === after)
    if (!alreadyApplied) {
      armCurrentAgentToolEffect({
        kind: 'profile_update',
        target: {
          fields: fields.map(([path]) => path),
          beforeFingerprint: profileFieldFingerprint(fields, 1),
          desiredFingerprint: profileFieldFingerprint(fields, 2)
        },
        recoveryMode: 'idempotent'
      })
      raw.settings = {
        ...raw.settings,
        profile: rawAppProfile(desired)
      }
      await writeRawSettingsConfig(raw)
    }
    const snapshot = await getAppConfigSnapshot()
    emitAppConfigChanged({ config: 'settings', key: 'profile', snapshot })
    return snapshot
  })
}

export async function updateSpeechReply(settings: Partial<SpeechReplyConfig>): Promise<AppConfigSnapshot> {
  return serializeConfigMutation(async () => {
    const raw = await readRawConfig()
    const current = normalizeSpeechReply(raw)
    raw.settings = {
      ...raw.settings,
      speech_reply: {
        enabled: settings.enabled ?? current.enabled,
        voice: defaultSpeechReplyVoice(settings.voice ?? current.voice),
        speed: clampSpeechReplySpeed(settings.speed ?? current.speed)
      }
    }
    await writeRawSettingsConfig(raw)
    return getAppConfigSnapshot()
  })
}

export async function updateMcpServer(index: number, update: McpServerUpdate): Promise<AppConfigSnapshot> {
  return serializeConfigMutation(async () => {
    const raw = await readRawConfig()
    const servers = Array.isArray(raw.mcp_servers) ? [...raw.mcp_servers] : []
    if (index < 0 || index >= servers.length) throw new Error(`MCP server index ${index} is out of range.`)
    const server = asRecord(servers[index])
    servers[index] = {
      ...server,
      enabled: update.enabled ?? server.enabled,
      timeout_ms: update.timeoutMs ?? server.timeout_ms
    }
    assertUniqueMcpServerIds(servers)
    raw.mcp_servers = servers
    await writeRawMcpServersConfig(raw)
    return getAppConfigSnapshot()
  })
}

export async function saveMcpServer(server: McpServerConfigSave): Promise<AppConfigSnapshot> {
  return serializeConfigMutation(async () => {
    const raw = await readRawConfig()
    const servers = Array.isArray(raw.mcp_servers) ? [...raw.mcp_servers] : []
    if (server.index === undefined) {
      servers.push(rawMcpServerFromSave(server))
    } else {
      if (server.index < 0 || server.index >= servers.length) throw new Error(`MCP server index ${server.index} is out of range.`)
      servers[server.index] = rawMcpServerFromSave(server, asRecord(servers[server.index]) as RawMcpServer)
    }
    assertUniqueMcpServerIds(servers)
    raw.mcp_servers = servers
    await writeRawMcpServersConfig(raw)
    return getAppConfigSnapshot()
  })
}

export async function deleteMcpServer(index: number): Promise<AppConfigSnapshot> {
  return serializeConfigMutation(async () => {
    const raw = await readRawConfig()
    const servers = Array.isArray(raw.mcp_servers) ? [...raw.mcp_servers] : []
    if (index < 0 || index >= servers.length) throw new Error(`MCP server index ${index} is out of range.`)
    servers.splice(index, 1)
    raw.mcp_servers = servers
    await writeRawMcpServersConfig(raw)
    return getAppConfigSnapshot()
  })
}

export async function moveMcpServer(index: number, direction: -1 | 1): Promise<AppConfigSnapshot> {
  return serializeConfigMutation(async () => {
    const raw = await readRawConfig()
    const servers = Array.isArray(raw.mcp_servers) ? [...raw.mcp_servers] : []
    const nextIndex = index + direction
    if (index < 0 || index >= servers.length) throw new Error(`MCP server index ${index} is out of range.`)
    if (nextIndex < 0 || nextIndex >= servers.length) return getAppConfigSnapshot()
    const [server] = servers.splice(index, 1)
    servers.splice(nextIndex, 0, server)
    raw.mcp_servers = servers
    await writeRawMcpServersConfig(raw)
    return getAppConfigSnapshot()
  })
}

export async function saveDefaultCapabilities(value: DefaultCapabilitySettings): Promise<AppConfigSnapshot> {
  const capabilities = serializeDefaultCapabilitySettings(value)
  return serializeConfigMutation(async () => {
    const raw = await readRawConfig()
    raw.capabilities = capabilities
    await writeRawCapabilitiesConfig(raw)
    return getAppConfigSnapshot()
  })
}
