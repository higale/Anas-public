import log from 'electron-log/main'
import { closeSync, mkdirSync, openSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { dirname, join, parse } from 'node:path'
import { shell } from 'electron'
import { getLogDir } from './config/dataDir'
import type { RuntimeLogLevel } from '@shared/types'

const maxLoggedStringLength = 4000
const dayInMs = 24 * 60 * 60 * 1000
const levelRank: Record<RuntimeLogLevel, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  off: 5
}

let currentLevel: RuntimeLogLevel = 'info'
let electronLogInitialized = false
const channelLoggers = new Map<string, typeof log>()

function localDateStart(date = new Date()): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function parseLogDate(fileName: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})_.+\.log$/.exec(fileName)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day)
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day ? date : null
}

function logDateStamp(date = new Date()): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-')
}

function safeLogChannel(channel: string): string {
  const safe = channel.trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80)
  return safe || 'main'
}

function logChannelPath(channel: string): { dir: string; fileChannel: string } {
  const safeChannel = safeLogChannel(channel)
  if (safeChannel.startsWith('mcp_')) {
    return {
      dir: join(getLogDir(), 'mcp'),
      fileChannel: safeChannel.slice('mcp_'.length) || 'server'
    }
  }
  return {
    dir: getLogDir(),
    fileChannel: safeChannel
  }
}

function logFilePath(date = new Date(), channel = 'main'): string {
  const target = logChannelPath(channel)
  const stamp = [
    logDateStamp(date),
    target.fileChannel
  ].join('_')
  return join(target.dir, `${stamp}.log`)
}

function ensureLogFile(): string {
  mkdirSync(getLogDir(), { recursive: true })
  const path = logFilePath()
  closeSync(openSync(path, 'a'))
  return path
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function quoteBatchArgument(value: string): string {
  return `"${value.replace(/%/g, '%%').replace(/"/g, '""')}"`
}

function quoteShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

function quoteAppleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function archiveLogFile(file: { toString(): string }): void {
  const currentPath = file.toString()
  const { dir, name, ext } = parse(currentPath)
  const archivePrefix = name.endsWith('_main') ? name.slice(0, -'_main'.length) : name
  const archivePattern = new RegExp(`^${escapeRegExp(archivePrefix)}_(\\d+)${escapeRegExp(ext)}$`)
  const nextIndex =
    readdirSync(dir).reduce((maxIndex, fileName) => {
      const match = archivePattern.exec(fileName)
      if (!match) return maxIndex
      return Math.max(maxIndex, Number(match[1]))
    }, 0) + 1

  renameSync(currentPath, join(dir, `${archivePrefix}_${String(nextIndex).padStart(4, '0')}${ext}`))
}

function pruneOldLogFilesInDir(dir: string, cutoff: Date): number {
  let deleted = 0

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      deleted += pruneOldLogFilesInDir(entryPath, cutoff)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.log')) continue
    const logDate = parseLogDate(entry.name)
    if (!logDate || logDate >= cutoff) continue
    try {
      unlinkSync(entryPath)
      deleted += 1
    } catch {
      // Ignore individual cleanup failures so logging can still initialize.
    }
  }

  return deleted
}

function pruneOldLogFiles(retentionDays: number): number {
  if (retentionDays <= 0) return 0
  const cutoff = new Date(localDateStart().getTime() - (retentionDays - 1) * dayInMs)
  return pruneOldLogFilesInDir(getLogDir(), cutoff)
}

function toElectronLogLevel(level: RuntimeLogLevel): 'silly' | 'debug' | 'info' | 'warn' | 'error' | false {
  if (level === 'off') return false
  if (level === 'trace') return 'silly'
  return level
}

function safeData(data: unknown): unknown {
  if (data instanceof Error) return { name: data.name, message: data.message, stack: data.stack }
  if (typeof data === 'string') {
    return data.length > maxLoggedStringLength ? `${data.slice(0, maxLoggedStringLength)}... [truncated]` : data
  }
  if (Array.isArray(data)) return data.map(safeData)
  if (data && typeof data === 'object') {
    return Object.fromEntries(
      Object.entries(data as Record<string, unknown>).map(([key, value]) => [key, safeData(value)])
    )
  }
  return data
}

function configureLogInstance(logger: typeof log, resolvePathFn: () => string, consoleLevel: ReturnType<typeof toElectronLogLevel>): void {
  logger.transports.file.resolvePathFn = () => {
    const path = resolvePathFn()
    mkdirSync(dirname(path), { recursive: true })
    return path
  }
  logger.transports.file.archiveLogFn = archiveLogFile
  logger.transports.file.level = toElectronLogLevel(currentLevel)
  logger.transports.console.level = consoleLevel
  logger.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'
}

function shouldLog(level: RuntimeLogLevel): boolean {
  return levelRank[level] >= levelRank[currentLevel] && currentLevel !== 'off'
}

export function configureRuntimeLogger(level: RuntimeLogLevel, retentionDays = 14): void {
  currentLevel = level
  mkdirSync(getLogDir(), { recursive: true })
  const deletedLogs = pruneOldLogFiles(retentionDays)
  if (!electronLogInitialized) {
    log.initialize()
    electronLogInitialized = true
  }
  configureLogInstance(log, () => logFilePath(), toElectronLogLevel(level))
  for (const [channel, logger] of channelLoggers) {
    configureLogInstance(logger, () => logFilePath(new Date(), channel), false)
  }
  if (deletedLogs > 0) runtimeLog('info', 'runtime', 'Old log files deleted.', { count: deletedLogs, retentionDays })
}

function writeLog(logger: typeof log, level: Exclude<RuntimeLogLevel, 'off'>, source: string, message: string, data?: unknown): void {
  if (!shouldLog(level)) return
  const payload = data === undefined ? [] : [safeData(data)]
  const args = [`[${source}] ${message}`, ...payload]
  if (level === 'trace') {
    logger.silly(...args)
  } else {
    logger[level](...args)
  }
}

function channelLogger(channel: string): typeof log {
  const safeChannel = safeLogChannel(channel)
  const current = channelLoggers.get(safeChannel)
  if (current) return current

  const logger = log.create({ logId: `channel:${safeChannel}` })
  logger.initialize()
  configureLogInstance(logger, () => logFilePath(new Date(), safeChannel), false)
  channelLoggers.set(safeChannel, logger)
  return logger
}

export function runtimeLog(level: Exclude<RuntimeLogLevel, 'off'>, source: string, message: string, data?: unknown): void {
  writeLog(log, level, source, message, data)
}

export function runtimeChannelLog(level: Exclude<RuntimeLogLevel, 'off'>, channel: string, source: string, message: string, data?: unknown): void {
  writeLog(channelLogger(channel), level, source, message, data)
}

export async function openRuntimeLogDir(): Promise<string> {
  mkdirSync(getLogDir(), { recursive: true })
  const error = await shell.openPath(getLogDir())
  if (error) throw new Error(error)
  return getLogDir()
}

export async function openRuntimeLogViewer(): Promise<string> {
  const path = ensureLogFile()

  if (process.platform === 'win32') {
    const logDir = getLogDir()
    const scriptPath = join(logDir, '_anas_tail_log.ps1')
    const launcherPath = join(logDir, '_anas_tail_log.cmd')
    writeFileSync(scriptPath, `Get-Content -Path ${quotePowerShellLiteral(path)} -Wait\r\n`, 'utf8')
    writeFileSync(launcherPath, [
      '@echo off',
      'title Anas Runtime Log',
      `powershell.exe -NoExit -NoProfile -ExecutionPolicy Bypass -File ${quoteBatchArgument(scriptPath)}`,
      ''
    ].join('\r\n'), 'utf8')
    const error = await shell.openPath(launcherPath)
    if (error) throw new Error(error)
    return path
  }

  if (process.platform === 'darwin') {
    const command = `tail -f ${quoteShellLiteral(path)}`
    const appleScript = [
      'tell application "System Events"',
      'set terminalWasRunning to exists process "Terminal"',
      'end tell',
      'tell application "Terminal"',
      'activate',
      'delay 0.2',
      'if terminalWasRunning or not (exists window 1) then',
      `do script ${quoteAppleScriptString(command)}`,
      'else',
      `do script ${quoteAppleScriptString(command)} in selected tab of front window`,
      'end if',
      'end tell'
    ]
    const child = spawn('osascript', appleScript.flatMap((line) => ['-e', line]), {
      detached: true,
      stdio: 'ignore'
    })
    child.unref()
    return path
  }

  const child = spawn('tail', ['-f', path], {
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
  return path
}
