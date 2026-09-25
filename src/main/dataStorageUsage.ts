import { lstat, opendir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { AppDataStorageUsageSnapshot, StorageUsageValue } from '@shared/types'
import { getDataDir, inputHistoryFileName } from './config/dataDir'

const statConcurrency = 32

interface DataDirectoryTotals {
  cache: number
  developerHttpTrace: number
  inputHistory: number
  log: number
  temp: number
  total: number
}

export interface DataStorageUsageDependencies {
  dataDir?: string
  electronCacheSize?: () => Promise<number>
}

function isMissingPath(reason: unknown): boolean {
  return Boolean(
    reason
    && typeof reason === 'object'
    && 'code' in reason
    && (reason as NodeJS.ErrnoException).code === 'ENOENT'
  )
}

function addBytes(current: number, bytes: number): number {
  return Math.min(Number.MAX_SAFE_INTEGER, current + Math.max(0, bytes))
}

function usage(totalBytes: number, approximate = false): StorageUsageValue {
  return { totalBytes, approximate }
}

async function* dataDirectoryFiles(root: string): AsyncGenerator<{ path: string; parts: string[] }> {
  const pendingDirectories = [root]
  while (pendingDirectories.length > 0) {
    const directoryPath = pendingDirectories.pop()!
    let directory
    try {
      directory = await opendir(directoryPath)
    } catch (reason) {
      if (isMissingPath(reason)) continue
      throw reason
    }
    try {
      for await (const entry of directory) {
        const path = join(directoryPath, entry.name)
        if (entry.isDirectory()) {
          pendingDirectories.push(path)
        } else if (entry.isFile()) {
          yield { path, parts: relative(root, path).split(/[\\/]/) }
        }
      }
    } catch (reason) {
      if (!isMissingPath(reason)) throw reason
    }
  }
}

async function measureFiles(
  files: Array<{ path: string; parts: string[] }>,
  totals: DataDirectoryTotals
): Promise<void> {
  const measured = await Promise.all(files.map(async (file) => {
    try {
      const info = await lstat(file.path)
      return info.isFile() ? info.size : 0
    } catch (reason) {
      if (isMissingPath(reason)) return 0
      throw reason
    }
  }))
  for (let index = 0; index < files.length; index += 1) {
    const bytes = measured[index] ?? 0
    const parts = files[index]!.parts
    totals.total = addBytes(totals.total, bytes)
    if (parts[0] === 'cache') totals.cache = addBytes(totals.cache, bytes)
    if (parts[0] === 'tmp') totals.temp = addBytes(totals.temp, bytes)
    if (parts[0] === 'log') totals.log = addBytes(totals.log, bytes)
    if (parts[0] === 'dev' && parts[1] === 'model-http') {
      totals.developerHttpTrace = addBytes(totals.developerHttpTrace, bytes)
    }
    if (parts.length === 1 && parts[0] === inputHistoryFileName) {
      totals.inputHistory = addBytes(totals.inputHistory, bytes)
    }
  }
}

async function scanDataDirectory(root: string): Promise<DataDirectoryTotals> {
  const totals: DataDirectoryTotals = {
    cache: 0,
    developerHttpTrace: 0,
    inputHistory: 0,
    log: 0,
    temp: 0,
    total: 0
  }
  let batch: Array<{ path: string; parts: string[] }> = []
  for await (const file of dataDirectoryFiles(root)) {
    batch.push(file)
    if (batch.length === statConcurrency) {
      await measureFiles(batch, totals)
      batch = []
    }
  }
  if (batch.length > 0) await measureFiles(batch, totals)
  return totals
}

export async function measureDirectorySize(root: string): Promise<number> {
  return (await scanDataDirectory(root)).total
}

export async function getDeveloperHttpTraceUsage(
  dependencies: Pick<DataStorageUsageDependencies, 'dataDir'> = {}
): Promise<StorageUsageValue> {
  return usage(await measureDirectorySize(join(dependencies.dataDir ?? getDataDir(), 'dev', 'model-http')))
}

export async function getDataStorageUsage(
  dependencies: DataStorageUsageDependencies = {}
): Promise<AppDataStorageUsageSnapshot> {
  const totals = await scanDataDirectory(dependencies.dataDir ?? getDataDir())
  let electronCacheBytes = 0
  try {
    electronCacheBytes = Math.max(0, await dependencies.electronCacheSize?.() ?? 0)
  } catch {
    // The application cache remains useful even when Chromium cannot report its cache size.
  }
  return {
    dataDirectory: usage(totals.total),
    developerHttpTrace: usage(totals.developerHttpTrace),
    cleanup: {
      input_history: usage(totals.inputHistory),
      cache_folder: usage(addBytes(totals.cache, electronCacheBytes), true),
      temp_folder: usage(totals.temp),
      log_folder: usage(totals.log),
      developer_http_trace: usage(totals.developerHttpTrace)
    }
  }
}
