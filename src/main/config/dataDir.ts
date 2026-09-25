import { app } from 'electron'
import { mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path, { join, resolve } from 'node:path'
import { applicationName } from '@shared/appMetadata'

export const configDirName = 'config'
export const capabilitiesConfigFileName = 'capabilities.json'
export const settingsConfigFileName = 'settings.json'
export const modelsConfigFileName = 'models.json'
export const subagentsConfigFileName = 'subagents.json'
export const mcpServersConfigFileName = 'mcp_servers.json'
export const customToolsConfigFileName = 'tools.json'
export const skillsConfigFileName = 'skills.json'
export const inputHistoryFileName = 'input_history.json'
export const configFileNames = [
  capabilitiesConfigFileName,
  settingsConfigFileName,
  modelsConfigFileName,
  subagentsConfigFileName,
  mcpServersConfigFileName,
  customToolsConfigFileName,
  skillsConfigFileName
] as const

function withoutExtension(fileName: string, extension: string): string {
  return fileName.toLowerCase().endsWith(extension.toLowerCase())
    ? fileName.slice(0, -extension.length)
    : fileName
}

function macBundleName(executablePath: string): string | undefined {
  const marker = '.app/Contents/MacOS/'
  const index = executablePath.toLowerCase().lastIndexOf(marker.toLowerCase())
  if (index < 0) return undefined
  const bundlePath = executablePath.slice(0, index + '.app'.length)
  return withoutExtension(path.posix.basename(bundlePath), '.app')
}

function normalizedProgramName(value: string | undefined): string {
  const normalized = value?.normalize('NFC').trim().replaceAll('\0', '')
  return normalized && normalized !== '.' && normalized !== '..' ? normalized : applicationName
}

export function resolveProgramName(
  platform: NodeJS.Platform,
  executablePath: string,
  portableExecutablePath?: string,
  appImagePath?: string
): string {
  if (platform === 'darwin') {
    return normalizedProgramName(macBundleName(executablePath) ?? withoutExtension(path.posix.basename(executablePath), path.posix.extname(executablePath)))
  }
  if (platform === 'win32') {
    const physicalExecutable = portableExecutablePath?.trim() || executablePath
    return normalizedProgramName(withoutExtension(path.win32.basename(physicalExecutable), '.exe'))
  }
  if (platform === 'linux') {
    const physicalExecutable = appImagePath?.trim() || executablePath
    return normalizedProgramName(withoutExtension(path.posix.basename(physicalExecutable), '.AppImage'))
  }
  return normalizedProgramName(withoutExtension(path.basename(executablePath), path.extname(executablePath)))
}

let cachedProgramName: string | undefined
let configuredDataDir: string | undefined

const dataDirArgument = '--data-dir'

export function getProgramName(): string {
  if (cachedProgramName) return cachedProgramName
  const electronApp = app as typeof app | undefined
  cachedProgramName = electronApp?.isPackaged
    ? resolveProgramName(
        process.platform,
        process.execPath,
        process.env.PORTABLE_EXECUTABLE_FILE,
        process.env.APPIMAGE
      )
    : applicationName
  return cachedProgramName
}

export function getBundledDataDir(): string {
  const electronApp = app as typeof app | undefined
  return electronApp?.isPackaged
    ? join(process.resourcesPath, 'data')
    : join(electronApp?.getAppPath() ?? process.cwd(), 'data')
}

function getDefaultDataDir(): string {
  return join(homedir(), `.gale${getProgramName()}`)
}

export function resolveDataDirArgument(
  argv: readonly string[],
  cwd = process.cwd(),
  positionalArgumentIndex = 1
): string | undefined {
  let value: string | undefined

  const useValue = (candidate: string): void => {
    if (value !== undefined) {
      throw new Error('The data directory may only be specified once.')
    }
    if (!candidate.trim()) {
      throw new Error('The data directory requires a non-empty directory path.')
    }
    if (candidate.includes('\0')) {
      throw new Error('The data directory contains an invalid null character.')
    }
    value = candidate
  }

  const positionalArgument = argv[positionalArgumentIndex]
  if (positionalArgument !== undefined && !positionalArgument.startsWith('-')) {
    useValue(positionalArgument)
  }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    let candidate: string | undefined

    if (argument === dataDirArgument) {
      candidate = argv[index + 1]
      if (candidate === undefined || candidate.startsWith('--')) {
        throw new Error(`${dataDirArgument} requires a directory path.`)
      }
      index += 1
    } else if (argument.startsWith(`${dataDirArgument}=`)) {
      candidate = argument.slice(dataDirArgument.length + 1)
    } else {
      continue
    }
    useValue(candidate)
  }

  if (value === undefined) return undefined
  const resolved = resolve(cwd, value)
  if (resolved === path.parse(resolved).root) {
    throw new Error(`${dataDirArgument} cannot target a filesystem root.`)
  }
  return resolved
}

export function getDataDir(): string {
  return configuredDataDir ?? getDefaultDataDir()
}

export function getDefaultWorkspaceDir(): string {
  const electronApp = app as typeof app | undefined
  if (!electronApp) throw new Error('Electron app runtime is unavailable.')
  const dataDirName = path.basename(getDataDir())
  return join(electronApp.getPath('documents'), dataDirName.startsWith('.') ? dataDirName.slice(1) : dataDirName)
}

export function getElectronUserDataDir(): string {
  return join(getDataDir(), 'electron')
}

export function configureDataRuntime(argv: readonly string[] = process.argv, cwd = process.cwd()): void {
  const electronApp = app as typeof app | undefined
  if (!electronApp) throw new Error('Electron app runtime is unavailable.')
  const requestedDataDir = resolveDataDirArgument(argv, cwd, electronApp.isPackaged ? 1 : 2)
  const selectedDataDir = requestedDataDir ?? getDefaultDataDir()
  mkdirSync(selectedDataDir, { recursive: true })
  configuredDataDir = requestedDataDir ? realpathSync.native(selectedDataDir) : selectedDataDir
  mkdirSync(getElectronUserDataDir(), { recursive: true })
  electronApp.setPath('userData', getElectronUserDataDir())
}

export function acquireRuntimeLock(): boolean {
  const electronApp = app as typeof app | undefined
  if (!electronApp) throw new Error('Electron app runtime is unavailable.')
  return electronApp.requestSingleInstanceLock()
}

export function releaseRuntimeLock(): void {
  const electronApp = app as typeof app | undefined
  if (!electronApp) return
  electronApp.releaseSingleInstanceLock()
}

export function getBundledConfigDir(): string {
  return join(getBundledDataDir(), configDirName)
}

export function getBundledConfigFile(fileName: typeof configFileNames[number] = settingsConfigFileName): string {
  return join(getBundledConfigDir(), fileName)
}

export function getBundledEnvFile(): string {
  return join(getBundledDataDir(), '.env')
}

export function getBundledMemoryDir(): string {
  return join(getBundledDataDir(), 'memory')
}

export function getBundledLangDir(): string {
  return join(getBundledDataDir(), 'lang')
}

export function getConfigDir(): string {
  return join(getDataDir(), configDirName)
}

export function getConfigFile(fileName: typeof configFileNames[number] = settingsConfigFileName): string {
  return join(getConfigDir(), fileName)
}

export function getEnvFile(): string {
  return join(getDataDir(), '.env')
}

export function getAgentCatalogFile(dataDir = getDataDir()): string {
  return join(dataDir, 'sqlite', 'catalog.sqlite')
}

export function getAgentConversationsDir(dataDir = getDataDir()): string {
  return join(dataDir, 'sqlite', 'conversations')
}

export function getAgentConversationDatabaseFile(ownerThreadId: string, dataDir = getDataDir()): string {
  if (
    typeof ownerThreadId !== 'string'
    || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(ownerThreadId)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(ownerThreadId)
  ) throw new Error('Agent conversation ID is not a valid database file name.')
  return join(getAgentConversationsDir(dataDir), `${ownerThreadId}.sqlite`)
}

export function getAgentAttachmentsDir(): string {
  return join(getDataDir(), 'attachments')
}

export function getFileEditRecordsDir(): string {
  return join(getDataDir(), 'file_edits')
}

export function getCacheDir(): string {
  return join(getDataDir(), 'cache')
}

export function getTempDir(): string {
  return join(getDataDir(), 'tmp')
}

export function getProjectStoreFile(): string {
  return join(getDataDir(), 'projects.json')
}

export function getInputHistoryFile(): string {
  return join(getDataDir(), inputHistoryFileName)
}

export function getLangDir(): string {
  return join(getDataDir(), 'lang')
}

export function getSkillsDir(): string {
  return join(getDataDir(), 'skills')
}

export function getSystemSkillsDir(): string {
  return join(getDataDir(), 'skills_system')
}

export function getSkillExamplesDir(): string {
  return join(getDataDir(), 'skills_examples')
}

export function getToolExamplesDir(): string {
  return join(getDataDir(), 'tools_examples')
}

export function getLogDir(): string {
  return join(getDataDir(), 'log')
}

export function getDeveloperHttpTraceDir(): string {
  return join(getDataDir(), 'dev', 'model-http')
}
