import { writeJsonFileAtomic } from '../atomicJson'
import { access, copyFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RuntimeLogLevel } from '@shared/types'
import {
  configFileNames,
  capabilitiesConfigFileName,
  getBundledConfigFile,
  getConfigDir,
  getConfigFile,
  mcpServersConfigFileName,
  modelsConfigFileName,
  settingsConfigFileName,
  skillsConfigFileName,
  subagentsConfigFileName
} from './dataDir'

export interface RawProviderModelConfig {
  id?: string
  display_name?: string
  model?: string
  parameters?: Record<string, unknown>
  parameter_presets?: Array<{
    id?: string
    name?: string
    parameters?: Record<string, unknown>
  }>
  parameter_preset_mode?: string
  default_parameter_preset_id?: string
  capabilities?: {
    vision?: boolean
    tool_use?: boolean
  }
  stream?: boolean
  max_context_tokens?: number
  max_output_tokens?: number
  context_compression_threshold?: number
  context_compression_enabled?: boolean
}

export interface RawModelProviderConfig {
  id?: string
  name?: string
  protocol?: string
  base_url?: string
  model_list_url?: string
  model_list_auth?: string
  api_key?: string
  parameters?: Record<string, unknown>
  models?: RawProviderModelConfig[]
}

export interface RawSubagentConfig {
  subagent_selection?: unknown
  preset?: string
  name?: string
  enabled?: boolean
  description?: string
  system_prompt?: string
  capabilities?: unknown
}

export interface RawAppProfile {
  assistant?: Partial<{
    name: string
    role: string
    instructions: string
    new_avatar_path: string
  }>
  user?: Partial<{
    preferred_name: string
    personal_info: string
  }>
}

export interface RawAppSettings {
  profile?: RawAppProfile
  speech_reply?: Partial<{
    enabled: boolean
    voice: string
    speed: number
  }>
  default_model_id?: string | null
  language?: string
  theme?: string
  font_size?: number
  chat_content_width?: string
  new_thread_model_selection?: string
  attachment_text_max_chars?: number
  attachment_text_overflow?: string
  log_level?: RuntimeLogLevel
  log_retention_days?: number
  max_model_calls_per_run?: number
  environment_context?: Partial<{
    operating_system: boolean
    power_shell: boolean
    bundled_commands: boolean
    current_date: boolean
    application_data_directory: boolean
    user_home_directory: boolean
    custom_information_enabled: boolean
    custom_information: string
  }>
  sidebar_visible?: boolean
  sidebar_width?: number
  workspace_panel_width?: number
  diff_view_mode?: 'inline' | 'side_by_side'
  diff_fold_unchanged?: boolean
  diff_word_wrap?: boolean
  sidebar_collapsed_sections?: Partial<{
    projects: boolean
    simple_chats: boolean
  }>
  backup_dir?: string
}

export interface RawAppConfig {
  capabilities?: unknown
  settings?: RawAppSettings
  providers?: RawModelProviderConfig[]
  subagents?: RawSubagentConfig[]
  mcp_servers?: unknown[]
}

export interface RawMcpServer {
  name?: string
  enabled?: boolean
  timeout_ms?: number
  type?: string
  url?: string
  api_key?: string
  id?: string
  command?: string
  args?: unknown[]
  working_dir?: string
  env?: Record<string, unknown>
}

type RawSettingsConfigFile = RawAppSettings

interface RawModelsConfigFile {
  providers?: RawAppConfig['providers']
}

interface RawSubagentsConfigFile {
  subagents?: RawAppConfig['subagents']
}

interface RawMcpServersConfigFile {
  mcp_servers?: RawAppConfig['mcp_servers']
}

type RawSkillsConfigFile = Record<string, unknown>

interface RawConfigFiles {
  capabilities: unknown
  settings: RawSettingsConfigFile
  models: RawModelsConfigFile
  subagents: RawSubagentsConfigFile
  mcpServers: RawMcpServersConfigFile
  skills: RawSkillsConfigFile
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function userSettingsConfigExists(): Promise<boolean> {
  return fileExists(getConfigFile(settingsConfigFileName))
}

async function ensureConfigFiles(): Promise<void> {
  await mkdir(getConfigDir(), { recursive: true })
  for (const fileName of configFileNames) {
    if (fileName === settingsConfigFileName) continue
    const bundled = getBundledConfigFile(fileName)
    if (!(await fileExists(bundled))) {
      throw new Error(`Bundled config template is missing: ${bundled}`)
    }
    const target = getConfigFile(fileName)
    if (!(await fileExists(target))) await copyFile(bundled, target)
  }
}

async function readJsonFile<T>(path: string): Promise<T> {
  const content = await readFile(path, 'utf8')
  try {
    return JSON.parse(content) as T
  } catch (cause) {
    throw new Error(`Could not read configuration file: ${path}\n${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
}

async function readConfigFilesFrom(path: (fileName: typeof configFileNames[number]) => string): Promise<RawConfigFiles> {
  const [settings, models, subagents, mcpServers, skills, capabilities] = await Promise.all([
    readJsonFile<RawSettingsConfigFile>(path(settingsConfigFileName)),
    readJsonFile<RawModelsConfigFile>(path(modelsConfigFileName)),
    readJsonFile<RawSubagentsConfigFile>(path(subagentsConfigFileName)),
    readJsonFile<RawMcpServersConfigFile>(path(mcpServersConfigFileName)),
    readJsonFile<RawSkillsConfigFile>(path(skillsConfigFileName)),
    readJsonFile<unknown>(path(capabilitiesConfigFileName))
  ])
  return { settings, models, subagents, mcpServers, skills, capabilities }
}

async function readConfigFiles(bundled: boolean): Promise<RawConfigFiles> {
  return readConfigFilesFrom(bundled ? getBundledConfigFile : getConfigFile)
}

function mergeRawConfig(bundled: RawConfigFiles, parsed: RawConfigFiles): RawAppConfig {
  const settings = {
    ...bundled.settings,
    ...parsed.settings,
    profile: {
      assistant: {
        ...asRecord(bundled.settings.profile?.assistant),
        ...asRecord(parsed.settings.profile?.assistant)
      },
      user: {
        ...asRecord(bundled.settings.profile?.user),
        ...asRecord(parsed.settings.profile?.user)
      }
    },
    speech_reply: {
      ...asRecord(bundled.settings.speech_reply),
      ...asRecord(parsed.settings.speech_reply)
    },
    environment_context: {
      ...bundled.settings.environment_context,
      ...parsed.settings.environment_context
    },
    sidebar_collapsed_sections: {
      ...bundled.settings.sidebar_collapsed_sections,
      ...parsed.settings.sidebar_collapsed_sections
    }
  } as RawAppConfig['settings']
  return {
    settings,
    capabilities: parsed.capabilities,
    providers: Array.isArray(parsed.models.providers) ? parsed.models.providers : bundled.models.providers,
    subagents: Array.isArray(parsed.subagents.subagents)
      ? parsed.subagents.subagents
      : bundled.subagents.subagents,
    mcp_servers: Array.isArray(parsed.mcpServers.mcp_servers)
      ? parsed.mcpServers.mcp_servers
      : bundled.mcpServers.mcp_servers
  }
}

export async function readRawConfig(): Promise<RawAppConfig> {
  await ensureConfigFiles()
  const [bundled, parsed] = await Promise.all([
    readConfigFiles(true),
    readConfigFiles(false)
  ])
  return mergeRawConfig(bundled, parsed)
}

export async function readRawConfigFromDirectory(configDir: string): Promise<RawAppConfig> {
  const [bundled, parsed] = await Promise.all([
    readConfigFiles(true),
    readConfigFilesFrom((fileName) => join(configDir, fileName))
  ])
  return mergeRawConfig(bundled, parsed)
}

export async function readBundledRawConfig(): Promise<RawAppConfig> {
  const bundled = await readConfigFiles(true)
  return mergeRawConfig(bundled, bundled)
}

export async function writeRawSettingsConfig(config: RawAppConfig): Promise<void> {
  await writeJsonFileAtomic(
    getConfigFile(settingsConfigFileName),
    (config.settings ?? {}) satisfies RawSettingsConfigFile
  )
}

export async function writeRawModelsConfig(config: RawAppConfig): Promise<void> {
  await writeJsonFileAtomic(getConfigFile(modelsConfigFileName), {
    providers: config.providers ?? []
  } satisfies RawModelsConfigFile)
}

export async function writeRawSubagentsConfig(config: RawAppConfig): Promise<void> {
  await writeJsonFileAtomic(getConfigFile(subagentsConfigFileName), {
    subagents: config.subagents ?? []
  } satisfies RawSubagentsConfigFile)
}

export async function writeRawMcpServersConfig(config: RawAppConfig): Promise<void> {
  await writeJsonFileAtomic(getConfigFile(mcpServersConfigFileName), {
    mcp_servers: config.mcp_servers ?? []
  } satisfies RawMcpServersConfigFile)
}

export async function writeRawCapabilitiesConfig(config: RawAppConfig): Promise<void> {
  await writeJsonFileAtomic(getConfigFile(capabilitiesConfigFileName), config.capabilities)
}
