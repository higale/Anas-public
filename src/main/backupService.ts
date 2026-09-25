import { createWriteStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { ZipFile } from 'yazl'
import type { DataBackupResult, DataRestoreResult } from '@shared/types'
import { configDirName, configFileNames, getDataDir, getProgramName } from './config/dataDir'
import { readRawConfig } from './config/rawAppConfig'
import { normalizeAppProfile } from './config/profileConfig'
import { snapshotAgentStorage } from './agent/agentDatabaseBackup'
import {
  extractBackupArchive,
  shouldSkipBackupRelativePath
} from './backupArchive'
import { validateRestoredDataDirectory } from './dataRestoreValidation'
import { runtimeLog } from './runtimeLogger'
import { withApplicationDataSnapshot } from './applicationDataSnapshot'

const requiredRestoreFiles = new Set(configFileNames.map((fileName) => `${configDirName}/${fileName}`))
const windowsReservedNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const maxBackupNameBytes = 96
const projectResetEntries = [
  'projects.json', 'projects.json.delete-journal', 'projects.json.delete-stage',
  'sqlite/catalog.sqlite', 'sqlite/catalog.sqlite-wal', 'sqlite/catalog.sqlite-shm', 'sqlite/catalog.sqlite-journal',
  'sqlite/conversations'
] as const
let restoreTail: Promise<void> = Promise.resolve()

function pad(value: number): string {
  return value.toString().padStart(2, '0')
}

function timestamp(date = new Date()): string {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '_',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('')
}

function safeHostName(): string {
  return hostname().replace(/[^\w.-]+/g, '_') || 'host'
}

function canUseFileNameSegment(value: string): boolean {
  if (!value || value === '.' || value === '..') return false
  if (/[<>:"/\\|?*]/.test(value)) return false
  if (Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 31 || codePoint === 127
  })) return false
  if (/[. ]$/.test(value)) return false
  if (windowsReservedNames.test(value)) return false
  return Buffer.byteLength(value, 'utf8') <= maxBackupNameBytes
}

async function backupProfileName(): Promise<string> {
  const raw = await readRawConfig()
  const profile = normalizeAppProfile(raw.settings?.profile)
  const assistantName = profile.assistant.name.trim()
  return canUseFileNameSegment(assistantName) ? assistantName : getProgramName()
}

export async function defaultBackupFileName(date = new Date()): Promise<string> {
  return `${safeHostName()}_Anas_${await backupProfileName()}_Backup_${timestamp(date)}.zip`
}

async function preRestoreBackupFileName(date = new Date()): Promise<string> {
  return `_${await defaultBackupFileName(date)}`
}

function ensureZipExtension(path: string): string {
  return path.toLowerCase().endsWith('.zip') ? path : `${path}.zip`
}

function shouldSkipRelativePath(relPath: string): boolean {
  return shouldSkipBackupRelativePath(relPath)
}

function isInsideDirectory(parent: string, child: string): boolean {
  const parentPath = resolve(parent)
  const childPath = resolve(child)
  return childPath === parentPath || childPath.startsWith(`${parentPath}${sep}`)
}

type BackupSourceEntry = { absPath: string; relPath: string; size: number; kind?: 'directory'; linkTarget?: string }

async function collectFiles(root: string, excludePath: string, current = root, excludedAttachmentThreads: ReadonlySet<string> = new Set()): Promise<BackupSourceEntry[]> {
  const entries = await readdir(current, { withFileTypes: true })
  const files: BackupSourceEntry[] = []
  for (const entry of entries) {
    const absPath = join(current, entry.name)
    if (resolve(absPath).toLowerCase() === excludePath.toLowerCase()) continue
    const relPath = relative(root, absPath)
    if (!relPath || shouldSkipRelativePath(relPath)) continue
    const normalizedRelPath = relPath.split(sep).join('/')
    if (normalizedRelPath.toLowerCase() === 'sqlite') continue
    const [directory, threadId] = normalizedRelPath.split('/')
    if (directory.toLowerCase() === 'attachments' && excludedAttachmentThreads.has(threadId)) continue
    if (entry.isDirectory()) {
      files.push({ absPath, relPath: normalizedRelPath, size: 0, kind: 'directory' })
      files.push(...await collectFiles(root, excludePath, absPath, excludedAttachmentThreads))
    } else if (entry.isSymbolicLink()) {
      // Store self-contained links without traversing them or copying external
      // resources. Resolve chains so restored links do not depend on aliases.
      const target = await realpath(absPath).catch(reason => {
        if (['ENOENT', 'ELOOP'].includes((reason as NodeJS.ErrnoException).code ?? '')) return undefined
        throw reason
      })
      const canonicalRoot = await realpath(root)
      if (target && isInsideDirectory(canonicalRoot, target)) {
        files.push({ absPath, relPath: normalizedRelPath, size: 0, linkTarget: relative(canonicalRoot, target).split(sep).join('/') })
      }
    } else if (entry.isFile()) {
      const info = await stat(absPath)
      files.push({
        absPath,
        relPath: normalizedRelPath,
        size: info.size
      })
    }
  }
  return files
}

export async function createDataBackupZip(targetPath: string): Promise<DataBackupResult> {
  return withApplicationDataSnapshot(() => createDataBackupSnapshot(targetPath))
}

async function createDataBackupSnapshot(targetPath: string): Promise<DataBackupResult> {
  const dataDir = resolve(getDataDir())
  const zipPath = ensureZipExtension(targetPath)
  const resolvedZipPath = resolve(zipPath)
  const snapshotDir = await mkdtemp(join(tmpdir(), 'anas-backup-'))
  try {
    const databaseSnapshots = await snapshotAgentStorage(dataDir, snapshotDir)
    const excludedAttachmentThreads = new Set(databaseSnapshots.flatMap(file => file.excludedAttachmentThreadIds ?? []))
    const entries: BackupSourceEntry[] = [...await collectFiles(dataDir, resolvedZipPath, dataDir, excludedAttachmentThreads), ...databaseSnapshots]
    const includedTargets = new Set(entries.filter(entry => entry.linkTarget === undefined).map(entry => entry.relPath))
    const files = entries.filter(entry => entry.linkTarget === undefined || includedTargets.has(entry.linkTarget))

    await mkdir(dirname(resolvedZipPath), { recursive: true })
    await new Promise<void>((resolvePromise, reject) => {
      const zip = new ZipFile()
      const output = createWriteStream(resolvedZipPath)
      output.on('close', resolvePromise)
      output.on('error', reject)
      zip.outputStream.on('error', reject)
      zip.outputStream.pipe(output)
      for (const file of files) {
        if (file.kind === 'directory') zip.addEmptyDirectory(file.relPath)
        else if (file.linkTarget !== undefined) {
          const target = relative(dirname(file.relPath), file.linkTarget).split(sep).join('/') || '.'
          zip.addBuffer(Buffer.from(target), file.relPath, { mode: 0o120777 })
        } else zip.addFile(file.absPath, file.relPath)
      }
      zip.end()
    })

    const info = await stat(resolvedZipPath)
    return {
      path: resolvedZipPath,
      backupDir: dirname(resolvedZipPath),
      fileCount: files.filter(file => file.kind !== 'directory').length,
      size: info.size
    }
  } finally {
    await rm(snapshotDir, { recursive: true, force: true })
  }
}

type RestorePhase = 'staged' | 'swapping' | 'activated' | 'committed' | 'restoring_previous' | 'rolled_back'

interface RestoreJournal {
  version: 1
  dataDir: string
  phase: RestorePhase
  previousEntries: string[]
  installedEntries: string[]
}

export interface DataRestoreLifecycle {
  deactivate(): Promise<void>
  activate(): Promise<void>
  reactivatePrevious?(): Promise<void>
  finish?(): void
  stateChanged?(state: 'committed' | 'rolled_back', details: { path: string; error?: unknown }): void
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw reason
  }
}

async function writeRestoreJournal(path: string, journal: RestoreJournal): Promise<void> {
  validateRestoreJournal(journal, resolve(getDataDir()), path)
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

function validateRestoreJournal(value: unknown, dataDir: string, path: string): asserts value is RestoreJournal {
  const journal = value as Partial<RestoreJournal> | null
  const validEntries = (entries: unknown, allowDatabaseFiles: boolean): entries is string[] => {
    if (!Array.isArray(entries) || entries.length > 100_000) return false
    const roots = new Set<string>()
    for (const name of entries) {
      if (typeof name !== 'string' || !name || /[\\:]/.test(name) || name.includes('\0') || name === '.' || name === '..') return false
      if (name.includes('/')) {
        if (!allowDatabaseFiles || !projectResetEntries.some((target) => target === name)) return false
      } else if (shouldSkipRelativePath(name)) return false
      else roots.add(name)
    }
    return new Set(entries).size === entries.length
      && !entries.some((name) => name.includes('/') && roots.has(name.split('/')[0]))
  }
  if (!journal || journal.version !== 1 || typeof journal.dataDir !== 'string' || resolve(journal.dataDir) !== dataDir
    || !['staged', 'swapping', 'activated', 'committed', 'restoring_previous', 'rolled_back'].includes(journal.phase ?? '')
    || !validEntries(journal.previousEntries, true) || !validEntries(journal.installedEntries, false)) {
    throw new Error(`Invalid restore transaction journal: ${path}`)
  }
}

async function rollbackRestore(transactionRoot: string, journal: RestoreJournal): Promise<void> {
  const staged = join(transactionRoot, 'staged')
  const previous = join(transactionRoot, 'previous')
  if (journal.phase !== 'restoring_previous') {
    for (const name of [...journal.installedEntries].reverse()) {
      await rm(join(journal.dataDir, name), { recursive: true, force: true })
    }
    // Commit this boundary before moving any old entries back. Retrying cleanup
    // after a partial rollback would otherwise delete data already restored.
    journal.phase = 'restoring_previous'
    await writeRestoreJournal(join(transactionRoot, 'transaction.json'), journal)
  }
  for (const name of [...journal.previousEntries].reverse()) {
    const saved = join(previous, name)
    if (!(await pathExists(saved))) continue
    if (name.includes('/')) {
      const parent = dirname(join(journal.dataDir, name))
      await mkdir(parent, { recursive: true })
      if (!(await lstat(parent)).isDirectory()) throw new Error(`Cannot roll back through a linked directory: ${parent}`)
    }
    await rm(join(journal.dataDir, name), { recursive: true, force: true })
    await rename(saved, join(journal.dataDir, name))
  }
  journal.phase = 'rolled_back'
  await writeRestoreJournal(join(transactionRoot, 'transaction.json'), journal)
  await rm(staged, { recursive: true, force: true })
}

async function managedEntryNames(root: string): Promise<string[]> {
  if (!(await pathExists(root))) return []
  return (await readdir(root, { withFileTypes: true }))
    .filter((entry) => !shouldSkipRelativePath(entry.name))
    .map((entry) => entry.name)
    .sort()
}

async function swapRestoredData(transactionRoot: string, journal: RestoreJournal): Promise<void> {
  const staged = join(transactionRoot, 'staged')
  const previous = join(transactionRoot, 'previous')
  await mkdir(journal.dataDir, { recursive: true })
  await mkdir(previous)
  journal.phase = 'swapping'
  journal.previousEntries = await managedEntryNames(journal.dataDir)
  await writeRestoreJournal(join(transactionRoot, 'transaction.json'), journal)
  for (const name of journal.previousEntries) {
    await rename(join(journal.dataDir, name), join(previous, name))
  }
  for (const name of await managedEntryNames(staged)) {
    journal.installedEntries.push(name)
    await writeRestoreJournal(join(transactionRoot, 'transaction.json'), journal)
    await rename(join(staged, name), join(journal.dataDir, name))
  }
  journal.phase = 'activated'
  await writeRestoreJournal(join(transactionRoot, 'transaction.json'), journal)
}

async function recoverInterruptedDataRestoreExcept(ignoredRoot?: string): Promise<boolean> {
  const dataDir = resolve(getDataDir())
  const parent = dirname(dataDir)
  const prefix = `.anas-restore-${basename(dataDir)}-`
  if (!(await pathExists(parent))) return false
  let recovered = false
  for (const entry of await readdir(parent, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue
    const root = join(parent, entry.name)
    if (ignoredRoot && resolve(root) === resolve(ignoredRoot)) continue
    const journalPath = join(root, 'transaction.json')
    try {
      const journal: unknown = JSON.parse(await readFile(journalPath, 'utf8'))
      validateRestoreJournal(journal, dataDir, journalPath)
      if (journal.phase !== 'committed' && journal.phase !== 'rolled_back') {
        await rollbackRestore(root, journal)
        recovered = true
      }
      await rm(root, { recursive: true, force: true })
    } catch (reason) {
      if ((reason as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw reason
    }
  }
  return recovered
}

export function recoverInterruptedDataRestore(): Promise<boolean> {
  return recoverInterruptedDataRestoreExcept()
}

async function restoreDataBackupZipExclusive(
  sourcePath: string,
  lifecycle?: DataRestoreLifecycle
): Promise<DataRestoreResult> {
  const dataDir = resolve(getDataDir())
  const resolvedSourcePath = resolve(sourcePath)
  const sourceInfo = await stat(resolvedSourcePath)
  await mkdir(dirname(dataDir), { recursive: true })
  const tempRoot = await mkdtemp(join(dirname(dataDir), `.anas-restore-${basename(dataDir)}-`))
  const restoreDir = join(tempRoot, 'staged')
  const journal: RestoreJournal = {
    version: 1,
    dataDir,
    phase: 'staged',
    previousEntries: [],
    installedEntries: []
  }
  let swapped = false
  let cleanupTransaction = true
  let deactivationAttempted = false
  let activationAttempted = false

  try {
    const extracted = await extractBackupArchive(resolvedSourcePath, restoreDir)
    for (const fileName of requiredRestoreFiles) {
      if (!extracted.entryNames.has(fileName)) {
        throw new Error(`Backup archive is missing ${fileName}.`)
      }
    }
    await validateRestoredDataDirectory(restoreDir)
    await writeRestoreJournal(join(tempRoot, 'transaction.json'), journal)

    if (lifecycle) {
      // Mark before awaiting: a failed deactivation may still have closed one
      // of several runtime resources and therefore requires reactivation.
      deactivationAttempted = true
      await lifecycle.deactivate()
    }
    // Interrupted transactions can rename live data and therefore must only
    // be recovered after the current runtime has reached the same quiescent
    // boundary used for the new swap.
    await recoverInterruptedDataRestoreExcept(tempRoot)

    const preferredBackupDir = dirname(resolvedSourcePath)
    const preRestoreBackupDir = isInsideDirectory(dataDir, preferredBackupDir) ? tmpdir() : preferredBackupDir
    const preRestoreBackupPath = (await createDataBackupZip(join(preRestoreBackupDir, await preRestoreBackupFileName()))).path
    cleanupTransaction = false
    await swapRestoredData(tempRoot, journal)
    swapped = true
    if (lifecycle) {
      activationAttempted = true
      await lifecycle.activate()
    }
    journal.phase = 'committed'
    await writeRestoreJournal(join(tempRoot, 'transaction.json'), journal)
    cleanupTransaction = true
    try {
      lifecycle?.stateChanged?.('committed', { path: resolvedSourcePath })
    } catch (error) {
      runtimeLog('warn', 'backup', 'A data restore commit observer failed.', { error })
    }
    lifecycle?.finish?.()
    return {
      path: resolvedSourcePath,
      preRestoreBackupPath,
      fileCount: extracted.fileCount,
      size: sourceInfo.size
    }
  } catch (reason) {
    const recoveryFailures: unknown[] = []
    let safeToRollback = true
    if (activationAttempted && lifecycle) {
      try {
        await lifecycle.deactivate()
      } catch (error) {
        safeToRollback = false
        recoveryFailures.push(error)
      }
    }
    const needsRollback = swapped
      || journal.phase === 'swapping'
      || journal.phase === 'activated'
    let rolledBack = !needsRollback
    if (needsRollback && safeToRollback) {
      try {
        await rollbackRestore(tempRoot, journal)
        cleanupTransaction = true
        rolledBack = true
        try {
          lifecycle?.stateChanged?.('rolled_back', { path: resolvedSourcePath, error: reason })
        } catch (error) {
          runtimeLog('warn', 'backup', 'A data restore rollback observer failed.', { error })
        }
      } catch (error) {
        recoveryFailures.push(error)
      }
    }
    if (deactivationAttempted && rolledBack && lifecycle) {
      try {
        await (lifecycle.reactivatePrevious ?? lifecycle.activate)()
      } catch (error) {
        recoveryFailures.push(error)
      }
    }
    if (recoveryFailures.length > 0) {
      throw new AggregateError(
        [reason, ...recoveryFailures],
        rolledBack
          ? 'Data restore failed and the previous runtime could not be reactivated.'
          : 'Data restore failed and its transaction could not be rolled back safely.'
      )
    }
    if (deactivationAttempted && rolledBack) lifecycle?.finish?.()
    throw reason
  } finally {
    if (cleanupTransaction) {
      await rm(tempRoot, { recursive: true, force: true }).catch((error) => {
        runtimeLog('warn', 'backup', 'Failed to remove a finished data restore transaction.', {
          path: tempRoot,
          error
        })
      })
    }
  }
}

export function restoreDataBackupZip(
  sourcePath: string,
  lifecycle?: DataRestoreLifecycle
): Promise<DataRestoreResult> {
  return enqueueDataReplacement(() => restoreDataBackupZipExclusive(sourcePath, lifecycle))
}

function enqueueDataReplacement<T>(operation: () => Promise<T>): Promise<T> {
  const result = restoreTail.then(operation, operation)
  restoreTail = result.then(() => undefined, () => undefined)
  return result
}

// Uses the restore journal so a crash cannot leave old project metadata paired
// with a new database (or the reverse). Call only with all data writers stopped.
export function resetProjectData(preserveCurrentData: () => Promise<string>): Promise<string> {
  return enqueueDataReplacement(async () => {
    await recoverInterruptedDataRestore()
    const dataDir = resolve(getDataDir())
    const sqliteDir = await lstat(join(dataDir, 'sqlite')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (sqliteDir && !sqliteDir.isDirectory()) throw new Error('Cannot reset project data through a linked or invalid SQLite directory.')
    const previousEntries: string[] = []
    for (const target of projectResetEntries) {
      try {
        const info = await lstat(join(dataDir, target))
        if (target === 'sqlite/conversations' ? !info.isDirectory() : !info.isFile()) {
          throw new Error(`Cannot reset a linked or invalid project data entry: ${join(dataDir, target)}`)
        }
        previousEntries.push(target)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    const preservationPath = await preserveCurrentData()
    const transactionRoot = await mkdtemp(join(dirname(dataDir), `.anas-restore-${basename(dataDir)}-`))
    const journalPath = join(transactionRoot, 'transaction.json')
    const journal: RestoreJournal = { version: 1, dataDir, phase: 'staged', previousEntries, installedEntries: [] }
    let cleanup = true
    try {
      await mkdir(join(transactionRoot, 'previous', 'sqlite'), { recursive: true })
      await writeRestoreJournal(journalPath, journal)
      journal.phase = 'swapping'
      await writeRestoreJournal(journalPath, journal)
      cleanup = false
      for (const target of previousEntries) {
        await rename(join(dataDir, target), join(transactionRoot, 'previous', target))
      }
      // Normal initialization creates a default project and empty database on
      // restart. No damaged JSON or SQLite file needs to be opened for the reset.
      journal.phase = 'committed'
      await writeRestoreJournal(journalPath, journal)
      cleanup = true
      return preservationPath
    } catch (error) {
      if (!cleanup) {
        try {
          await rollbackRestore(transactionRoot, journal)
          cleanup = true
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'Project data reset failed and could not be rolled back safely.')
        }
      }
      throw error
    } finally {
      if (cleanup) await rm(transactionRoot, { recursive: true, force: true }).catch((error) => {
        runtimeLog('warn', 'recovery', 'Could not remove a finished project reset transaction.', { path: transactionRoot, error })
      })
    }
  })
}

export function defaultBackupDirectory(): string {
  return getDataDir()
}

export async function backupDialogDefaultPath(backupDirectory?: string): Promise<string> {
  return join(backupDirectory || defaultBackupDirectory(), await defaultBackupFileName())
}
