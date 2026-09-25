import { initializeHelpFiles } from './helpDocuments'
import { registerAttachmentPreviewProtocol, registerAttachmentPreviewScheme } from './attachments'
import { app, BrowserWindow, nativeTheme } from 'electron'
import { applicationId, applicationName } from '@shared/appMetadata'
import { getAppConfigSnapshot, initializeAppProfile } from './config/appConfig'
import { acquireRuntimeLock, configureDataRuntime, getDataDir, getProgramName, releaseRuntimeLock } from './config/dataDir'
import { closeCachedMcpRuntime, loadMcpRuntimeForCurrentConfig } from './mcpRuntimeService'
import { configureRuntimeLogger, runtimeLog } from './runtimeLogger'
import { cleanupTempFiles, cleanupTempFilesInBackground } from './tempCleanupService'
import { activateMainWindow, applyNativeTheme, applyWindowTheme, configureApplicationMenu, createMainWindow, markAppQuitting } from './appShell'
import { registerAppIpcHandlers } from './appIpcHandlers'
import { registerWorkspaceIpcHandlers } from './workspaceIpcHandlers'
import { closeAgentRuntime, initializeAgentRuntime, recoverPendingProjectDeletion, registerAgentIpcHandlers } from './agent/agentIpcHandlers'
import { applyProfileIcon } from './profileIconService'
import { initializeAvatarAssets } from './avatarAssets'
import { consumePendingAvatarUpdate } from './avatarConfigService'
import { initializeUserShellEnvironment } from './shellEnvironment'
import { initializeCustomEnvironmentInformation } from './environmentContextService'
import { installRuntimeNetworkPolicy } from './runtimeNetworkPolicy'
import { initializeSkillsStore } from './skillsStore'
import { initializeToolsStore } from './toolsStore'
import { recoverInterruptedDataRestore } from './backupService'
import { reportStartupFailure } from './startupFailure'
import { registerSpeechReplyIpc } from './speech/speechReplyIpc'
import { registerSpeechInputIpc } from './speech/speechInputIpc'
import { isRecoveryOperationRunning, registerRecoveryIpcHandlers, showStartupRecovery } from './startupRecovery'

const packagedSmokeMode = process.env.ANAS_PACKAGED_SMOKE === '1'
  || process.argv.includes('--anas-packaged-smoke')

function startApplication(): void {
  let windowReady = false
  registerAttachmentPreviewScheme()
  installRuntimeNetworkPolicy()
  app.setName(applicationName)
  if (process.platform === 'win32') app.setAppUserModelId(applicationId)
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

  try {
    configureDataRuntime()
    app.on('second-instance', () => {
      runtimeLog('info', 'runtime', 'Activated existing application window.')
      if (windowReady) activateMainWindow()
    })
    if (!acquireRuntimeLock()) {
      app.exit(0)
      return
    }
  } catch (reason) {
    reportStartupFailure(reason, (exitCode) => app.exit(exitCode))
    return
  }

  registerAppIpcHandlers()
  registerRecoveryIpcHandlers()
  registerWorkspaceIpcHandlers()
  registerSpeechInputIpc()
  registerSpeechReplyIpc()
  registerAgentIpcHandlers()

  app.on('browser-window-created', (_event, window) => {
    window.on('close', (event) => {
      if (isRecoveryOperationRunning()) event.preventDefault()
    })
  })
  app.on('activate', () => { if (windowReady) activateMainWindow() })

  nativeTheme.on('updated', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      applyWindowTheme(win)
    }
  })

  app.whenReady().then(async () => {
    registerAttachmentPreviewProtocol()
    const recoveredInterruptedRestore = await recoverInterruptedDataRestore()
    await recoverPendingProjectDeletion()
    await initializeAgentRuntime()
    await initializeAppProfile()
    try {
      const config = await getAppConfigSnapshot()
      configureRuntimeLogger(config.settings.logLevel, config.settings.logRetentionDays)
      applyNativeTheme(config.settings.theme)
      runtimeLog('info', 'runtime', 'Application started.', {
        version: app.getVersion(),
        dataDir: getDataDir(),
        programName: getProgramName(),
        theme: config.settings.theme,
        logLevel: config.settings.logLevel,
        logRetentionDays: config.settings.logRetentionDays
      })
      if (recoveredInterruptedRestore) {
        runtimeLog('warn', 'backup', 'Rolled back an interrupted data restore before startup.')
      }
    } catch {
      configureRuntimeLogger('info')
      applyNativeTheme('system')
      runtimeLog('warn', 'runtime', 'Application started with fallback theme.')
    }
    await initializeSkillsStore()
    await initializeToolsStore()
    await initializeUserShellEnvironment()
    await configureApplicationMenu()
    try {
      await initializeAvatarAssets()
    } catch (reason) {
      runtimeLog('warn', 'profile', 'Failed to initialize avatar assets on startup.', { error: reason })
    }
    try {
      await consumePendingAvatarUpdate()
    } catch (reason) {
      runtimeLog('warn', 'profile', 'Failed to apply a pending avatar update on startup.', { error: reason })
    }
    try {
      await initializeHelpFiles()
    } catch (reason) {
      runtimeLog('warn', 'help', 'Failed to initialize help files on startup.', { error: reason })
    }
    await applyProfileIcon()
    await cleanupTempFiles()
    createMainWindow()
    windowReady = true
    void initializeCustomEnvironmentInformation()
    void loadMcpRuntimeForCurrentConfig(false)

  }).catch(async (reason) => {
    try {
      await showStartupRecovery(reason)
      windowReady = true
    } catch (recoveryError) {
      reportStartupFailure(new AggregateError([reason, recoveryError], 'Startup recovery could not open.'), (exitCode) => app.exit(exitCode))
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  let shutdownStarted = false

  app.on('before-quit', (event) => {
    if (shutdownStarted || isRecoveryOperationRunning()) {
      event.preventDefault()
      return
    }
    event.preventDefault()
    shutdownStarted = true
    markAppQuitting()
    let deadline: ReturnType<typeof setTimeout> | undefined
    const shutdown = Promise.allSettled([
      closeAgentRuntime({ allowIncomplete: true, timeoutMs: 5_000 }),
      closeCachedMcpRuntime()
    ])
    void Promise.race([
      shutdown,
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, 5_000)
      })
    ]).finally(() => {
      if (deadline) clearTimeout(deadline)
      cleanupTempFilesInBackground()
      releaseRuntimeLock()
      app.exit(0)
    })
  })
}

if (packagedSmokeMode) {
  void app.whenReady().then(async () => {
    const { runPackagedSmoke } = await import('./packagedSmoke')
    await runPackagedSmoke()
    app.exit(0)
  }).catch((reason) => {
    console.error(reason)
    app.exit(1)
  })
} else {
  startApplication()
}
