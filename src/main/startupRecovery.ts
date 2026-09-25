import { app, shell } from 'electron'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getAgentCatalogFile, getAgentConversationsDir, getBundledConfigDir, getDataDir, getLogDir } from './config/dataDir'
import { handleMainIpc } from './ipcSecurity'
import { beginApplicationDataTransition } from './applicationDataLifecycle'
import { closeAgentRuntime } from './agent/agentIpcHandlers'
import { closeCachedMcpRuntime } from './mcpRuntimeService'
import { createMainWindow } from './appShell'
import { preserveRecoveryData, requireResettableConfigFile, resetRecoveryConfig } from './recoveryData'
import { recoverInterruptedDataRestore, resetProjectData } from './backupService'
import { errorDetail, type RecoveryResult, type RecoverySnapshot } from '@shared/recovery'
import { configureRuntimeLogger, runtimeLog } from './runtimeLogger'
import { inspectRecoveryRepair, repairRecoveryData, requireRecoveryFile } from './recoveryRepair'
import { readProjectStoreFile } from './projectStore'
import { AgentStorage } from './agent/agentStorage'

let active = false
let canModify = false
let busy = false
let startupError = ''
let stopError: string | undefined
let lastPreservationPath: string | undefined

export function isRecoveryOperationRunning(): boolean {
  return busy
}

async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  if (busy) throw new Error('Another recovery operation is in progress.')
  busy = true
  try { return await operation() } finally { busy = false }
}

async function stopWriters(): Promise<void> {
  canModify = false
  stopError = undefined
  try {
    await beginApplicationDataTransition()
    const results = await Promise.allSettled([closeAgentRuntime(), closeCachedMcpRuntime()])
    const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Could not stop application data writers.')
    await recoverInterruptedDataRestore()
    canModify = true
  } catch (error) {
    stopError = errorDetail(error)
  }
}

function requireRecovery(): void {
  if (!active) throw new Error('Enter startup recovery before performing this operation.')
}

function requireStopped(): void {
  requireRecovery()
  if (!canModify) throw new Error(stopError ?? 'Application data writers have not stopped.')
}

async function preserve(): Promise<string> {
  requireStopped()
  lastPreservationPath = await preserveRecoveryData(getDataDir(), dirname(getDataDir()))
  runtimeLog('info', 'recovery', 'Preserved application data.', { path: lastPreservationPath })
  return lastPreservationPath
}

export async function showStartupRecovery(error: unknown): Promise<void> {
  active = true
  startupError = errorDetail(error)
  // Keep old logs intact while diagnosing a failed startup.
  try { configureRuntimeLogger('info', 0) } catch (logError) {
    startupError = errorDetail(new AggregateError([error, logError], 'Startup failed; recovery logging is also unavailable.'))
  }
  runtimeLog('error', 'startup', startupError)
  await exclusive(stopWriters)
  createMainWindow({ recovery: true })
}

export function registerRecoveryIpcHandlers(): void {
  handleMainIpc('recovery:enter', async (event, detail: unknown): Promise<void> => {
    if (typeof detail !== 'string' || detail.length > 32_000) throw new Error('Invalid startup error details.')
    await exclusive(async () => {
      active = true
      startupError = detail
      await stopWriters()
      const url = new URL(event.sender.getURL())
      // A hash-only navigation would keep the normal application mounted.
      url.searchParams.set('recovery', randomUUID())
      url.hash = 'recovery'
      await event.sender.loadURL(url.toString())
    })
  })
  handleMainIpc('recovery:inspect', async (): Promise<RecoverySnapshot> => {
    requireRecovery()
    const repair = await inspectRecoveryRepair(getDataDir())
    const projects = repair.files.find((file) => file.name === 'projects.json')
    if (canModify && projects && !projects.error && !projects.repairableFields.length) {
      try {
        const store = await readProjectStoreFile(projects.path)
        AgentStorage.validateCatalogBackup(getAgentCatalogFile(), new Set(store.projects.map((project) => project.id)))
      } catch (error) {
        // Only the shared catalog belongs to global startup recovery. An
        // unreadable conversation is reported when that conversation is opened.
        projects.error = errorDetail(error)
      }
    }
    return {
      dataDir: getDataDir(), logDir: getLogDir(), preservationParent: dirname(getDataDir()),
      catalogPath: getAgentCatalogFile(), conversationsPath: getAgentConversationsDir(),
      startupError, stopError, canModify, lastPreservationPath,
      files: repair.files
    }
  })
  handleMainIpc('recovery:repair', (_event, file: unknown) => exclusive(async () => {
    requireStopped()
    const result = await repairRecoveryData(getDataDir(), requireRecoveryFile(file), () => preserve())
    runtimeLog('info', 'recovery', 'Repaired application data fields.', { repaired: result.repaired, unresolved: result.unresolved })
    return result
  }))
  handleMainIpc('recovery:openDirectory', async (_event, kind: unknown): Promise<void> => {
    const path = kind === 'data' ? getDataDir() : kind === 'log' ? getLogDir()
      : kind === 'preservation' && active ? lastPreservationPath : undefined
    if (!path) throw new Error('Unknown recovery directory.')
    const error = await shell.openPath(path)
    if (error) throw new Error(error)
  })
  handleMainIpc('recovery:reset', (_event, file: unknown): Promise<RecoveryResult> => exclusive(async () => {
    requireStopped()
    const selected = requireResettableConfigFile(file)
    const preservationPath = await preserve()
    await resetRecoveryConfig(getDataDir(), getBundledConfigDir(), selected)
    runtimeLog('warn', 'recovery', 'Reset configuration file.', { file: selected, preservationPath })
    return { preservationPath }
  }))
  handleMainIpc('recovery:resetProjects', (): Promise<RecoveryResult> => exclusive(async () => {
    requireStopped()
    try {
      const preservationPath = await resetProjectData(() => preserve())
      runtimeLog('warn', 'recovery', 'Reset projects and agent storage.', { preservationPath })
      return { preservationPath }
    } catch (error) {
      try { await recoverInterruptedDataRestore() } catch (rollbackError) {
        canModify = false
        stopError = errorDetail(rollbackError)
      }
      throw error
    }
  }))
  handleMainIpc('recovery:restart', (): void => {
    requireRecovery()
    if (busy) throw new Error('Wait for the recovery operation to finish before restarting.')
    app.relaunch()
    app.quit()
  })
}
