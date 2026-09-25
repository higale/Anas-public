import { readHelpDocument } from './helpDocuments'
import { app, session, shell } from 'electron'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type { AppBuildInfo, AppDataStorageUsageSnapshot, DataBackupResult, DataCleanupRequest, DataCleanupResult, DataRestoreResult, EnvFileSnapshot, LanguageResourcesSnapshot, RuntimeToolStatus, SpeechRendererDiagnostics, SpeechRendererWarningKind, SystemEnvironmentDetection } from '@shared/types'
import { getAppConfigSnapshot, getBackupDirectory, updateBackupDirectory } from './config/appConfig'
import { getDataDir, getDeveloperHttpTraceDir } from './config/dataDir'
import { readDataEnvFile, reloadDataEnv, writeDataEnvFile } from './config/apiKeys'
import { backupDialogDefaultPath, createDataBackupZip, restoreDataBackupZip } from './backupService'
import { cleanupData } from './dataCleanupService'
import { getLanguageResources } from './languageStore'
import {
  closeCachedMcpRuntime,
  loadMcpRuntimeForCurrentConfig,
  reopenCachedMcpRuntime
} from './mcpRuntimeService'
import { configureRuntimeLogger, openRuntimeLogDir, openRuntimeLogViewer, runtimeLog } from './runtimeLogger'
import { applyNativeTheme, configureApplicationMenu, openExternalUrl } from './appShell'
import { closeAgentRuntime, initializeAgentRuntime } from './agent/agentIpcHandlers'
import { isDeveloperHttpTraceEnabled, setDeveloperHttpTraceEnabled } from './agent/developerHttpTraceState'
import { dialogParentFromEvent, showModalOpenDialog, showModalSaveDialog } from './modalDialog'
import { getRuntimeToolStatus } from './runtimeToolStatus'
import { handleMainIpc } from './ipcSecurity'
import {
  beginApplicationDataTransition,
  finishApplicationDataTransition
} from './applicationDataLifecycle'
import { detectSystemEnvironment } from './systemEnvironmentDetection'
import { getDataStorageUsage, getDeveloperHttpTraceUsage } from './dataStorageUsage'
import { restartInConsole } from './consoleRestart'

declare const __ANAS_BUILD_ENVIRONMENT__: AppBuildInfo['environment']
declare const __ANAS_BUILD_TIME__: string

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

const speechWarningMessages: Record<SpeechRendererWarningKind, string> = {
  playback_media_error: 'Speech playback media error.',
  playback_start_failed: 'Speech playback start failed.',
  generation_request_failed: 'Speech generation request failed in renderer.'
}

function speechWarningKind(value: unknown): SpeechRendererWarningKind {
  if (typeof value !== 'string' || !(value in speechWarningMessages)) {
    throw new Error('Invalid speech warning kind.')
  }
  return value as SpeechRendererWarningKind
}

function speechDiagnostics(value: unknown): SpeechRendererDiagnostics {
  const record = asRecord(value)
  const readInteger = (key: keyof SpeechRendererDiagnostics, optional = false): number | undefined => {
    const item = record[key]
    if (optional && item === undefined) return undefined
    if (!Number.isSafeInteger(item) || (item as number) < 0) {
      throw new Error(`Invalid speech diagnostic ${key}.`)
    }
    return item as number
  }
  return {
    token: readInteger('token') as number,
    sequence: readInteger('sequence') as number,
    textLength: readInteger('textLength') as number,
    code: readInteger('code', true)
  }
}

function isMissingPath(reason: unknown): boolean {
  return Boolean(reason && typeof reason === 'object' && 'code' in reason && (reason as { code?: unknown }).code === 'ENOENT')
}

function resolveDataPath(targetPath: string): string {
  const dataDir = resolve(getDataDir())
  const target = resolve(targetPath)
  if (target !== dataDir && !target.startsWith(`${dataDir}${sep}`)) {
    throw new Error('Path must be inside the Anas data directory.')
  }
  return target
}

function appIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(app.getAppPath(), 'build', 'icon.png')
}

async function clearElectronCache(): Promise<void> {
  const currentSession = session.defaultSession
  await currentSession.clearCache()
  await currentSession.clearCodeCaches({})
  await currentSession.clearStorageData({
    storages: ['shadercache', 'cachestorage']
  })
}

export function registerAppIpcHandlers(): void {
  handleMainIpc('app:getBuildInfo', (): AppBuildInfo => {
    const version = app.getVersion()
    return __ANAS_BUILD_ENVIRONMENT__ === 'production'
      ? { version, environment: 'production', builtAt: __ANAS_BUILD_TIME__ }
      : { version, environment: 'development' }
  })
  handleMainIpc('app:toggleDevTools', (event): void => {
    event.sender.toggleDevTools()
  })
  handleMainIpc('app:restartInConsole', (): Promise<void> => restartInConsole())
  handleMainIpc('app:getIcon', async (): Promise<string | undefined> => {
    try {
      const buffer = await readFile(appIconPath())
      return `data:image/png;base64,${buffer.toString('base64')}`
    } catch (reason) {
      if (isMissingPath(reason)) return undefined
      throw reason
    }
  })
  handleMainIpc('app:getRuntimeTools', async (): Promise<RuntimeToolStatus> => {
    const config = await getAppConfigSnapshot()
    return getRuntimeToolStatus(config)
  })
  handleMainIpc('app:quit', (): void => {
    app.quit()
  })
  handleMainIpc('app:openExternalUrl', async (_event, url: string): Promise<string> => openExternalUrl(url))
  handleMainIpc('app:readHelp', async (_event, documentId: unknown): Promise<string> => readHelpDocument(documentId))
  handleMainIpc('app:openDataDir', async (): Promise<string> => {
    const dataDir = getDataDir()
    await shell.openPath(dataDir)
    return dataDir
  })
  handleMainIpc('app:openPath', async (_event, targetPath: string): Promise<string> => {
    const target = resolveDataPath(targetPath)
    const error = await shell.openPath(target)
    if (error) throw new Error(error)
    return target
  })
  handleMainIpc('app:showItemInFolder', async (_event, targetPath: string): Promise<string> => {
    const target = resolveDataPath(targetPath)
    await stat(target)
    shell.showItemInFolder(target)
    return target
  })
  handleMainIpc('app:openLogDir', async (): Promise<string> => openRuntimeLogDir())
  handleMainIpc('app:openLogViewer', async (): Promise<string> => openRuntimeLogViewer())
  handleMainIpc('app:getDataStorageUsage', (): Promise<AppDataStorageUsageSnapshot> => (
    getDataStorageUsage({ electronCacheSize: () => session.defaultSession.getCacheSize() })
  ))
  handleMainIpc('app:getDeveloperHttpTraceEnabled', (): boolean => isDeveloperHttpTraceEnabled())
  handleMainIpc('app:getDeveloperHttpTraceUsage', () => getDeveloperHttpTraceUsage())
  handleMainIpc('app:setDeveloperHttpTraceEnabled', (_event, enabled: unknown): boolean => (
    setDeveloperHttpTraceEnabled(enabled)
  ))
  handleMainIpc('app:openDeveloperHttpTraceDir', async (): Promise<string> => {
    const traceDir = getDeveloperHttpTraceDir()
    await mkdir(traceDir, { recursive: true })
    const error = await shell.openPath(traceDir)
    if (error) throw new Error(error)
    return traceDir
  })
  handleMainIpc('app:readEnvFile', async (): Promise<EnvFileSnapshot> => readDataEnvFile())
  handleMainIpc('app:saveEnvFile', async (_event, content: string): Promise<EnvFileSnapshot> => {
    const snapshot = writeDataEnvFile(content)
    runtimeLog('info', 'config', 'Data .env file saved.', {
      path: snapshot.path,
      length: snapshot.content.length
    })
    return snapshot
  })
  handleMainIpc('app:detectSystemEnvironment', async (): Promise<SystemEnvironmentDetection> => {
    const detection = await detectSystemEnvironment()
    runtimeLog('info', 'runtime', 'System environment detection finished.', {
      detectedToolCount: detection.tools.length
    })
    return detection
  })
  handleMainIpc('app:getLanguageResources', async (): Promise<LanguageResourcesSnapshot> => {
    const resources = await getLanguageResources()
    await configureApplicationMenu()
    return resources
  })
  handleMainIpc('speech:logWarning', async (_event, kind: unknown, diagnostics: unknown): Promise<void> => {
    const warningKind = speechWarningKind(kind)
    runtimeLog('warn', 'speech', speechWarningMessages[warningKind], speechDiagnostics(diagnostics))
  })
  handleMainIpc('app:backupData', async (event): Promise<DataBackupResult | null> => {
    const result = await showModalSaveDialog(dialogParentFromEvent(event), {
      title: 'Backup Anas data',
      defaultPath: await backupDialogDefaultPath(await getBackupDirectory()),
      filters: [
        { name: 'Zip Archive', extensions: ['zip'] }
      ]
    })
    if (result.canceled || !result.filePath) return null
    await updateBackupDirectory(dirname(result.filePath))
    const backup = await createDataBackupZip(result.filePath)
    runtimeLog('info', 'backup', 'Data backup created.', backup)
    return backup
  })
  handleMainIpc('app:selectDataRestoreBackup', async (event): Promise<string | null> => {
    const result = await showModalOpenDialog(dialogParentFromEvent(event), {
      title: 'Restore Anas data backup',
      properties: ['openFile'],
      filters: [
        { name: 'Zip Archive', extensions: ['zip'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
  handleMainIpc('app:restoreData', async (_event, sourcePath: unknown): Promise<DataRestoreResult> => {
    if (typeof sourcePath !== 'string' || !sourcePath.trim()) {
      throw new Error('Invalid data restore source path.')
    }
    const deactivate = async (): Promise<void> => {
      await beginApplicationDataTransition()
      const stopped = await Promise.allSettled([
        closeAgentRuntime(),
        closeCachedMcpRuntime()
      ])
      const failures = stopped.flatMap((result) => (
        result.status === 'rejected' ? [result.reason] : []
      ))
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Application data could not be closed for restore.')
      }
    }
    const activate = async (): Promise<void> => {
      reloadDataEnv()
      await Promise.all([
        initializeAgentRuntime(),
        reopenCachedMcpRuntime()
      ])
      const snapshot = await getAppConfigSnapshot()
      configureRuntimeLogger(snapshot.settings.logLevel, snapshot.settings.logRetentionDays)
      applyNativeTheme(snapshot.settings.theme)
      await loadMcpRuntimeForCurrentConfig(true)
    }
    const restore = await restoreDataBackupZip(sourcePath, {
      deactivate,
      activate,
      finish: finishApplicationDataTransition,
      stateChanged(state, details) {
        runtimeLog(state === 'committed' ? 'warn' : 'error', 'backup', `Data restore ${state}.`, details)
      }
    })
    runtimeLog('warn', 'backup', 'Data backup restored.', restore)
    return restore
  })
  handleMainIpc('app:cleanupData', async (_event, request: DataCleanupRequest): Promise<DataCleanupResult> => {
    const cleanupRequest = asRecord(request) as DataCleanupRequest
    const cleanup = await cleanupData(cleanupRequest, { clearElectronCache })
    if (cleanupRequest.log_folder === true) {
      const snapshot = await getAppConfigSnapshot()
      configureRuntimeLogger(snapshot.settings.logLevel, snapshot.settings.logRetentionDays)
    }
    runtimeLog('warn', 'cleanup', 'Data cleanup finished.', cleanup)
    return cleanup
  })
}
