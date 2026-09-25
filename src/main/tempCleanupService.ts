import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { getTempDir } from './config/dataDir'
import { runtimeLog } from './runtimeLogger'

const externalRegistryName = 'external-files'
const externalTemporaryFileIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

interface ExternalTemporaryFileRecord {
  id: string
  kind: 'http-download'
  path: string
  version: 1
}

function tempDirPath(): string {
  return getTempDir()
}

function externalRegistryPath(): string {
  return join(tempDirPath(), externalRegistryName)
}

function externalRecordPath(id: string): string {
  return join(externalRegistryPath(), `${id}.json`)
}

function isValidExternalRecord(value: unknown, expectedId?: string): value is ExternalTemporaryFileRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Partial<ExternalTemporaryFileRecord>
  return record.version === 1
    && record.kind === 'http-download'
    && typeof record.id === 'string'
    && externalTemporaryFileIdPattern.test(record.id)
    && (!expectedId || record.id === expectedId)
    && typeof record.path === 'string'
    && isAbsolute(record.path)
    && basename(record.path).endsWith(`.anas-download-${record.id}.tmp`)
}

async function readExternalRecord(path: string, expectedId?: string): Promise<ExternalTemporaryFileRecord> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!isValidExternalRecord(parsed, expectedId)) {
    throw new Error(`Invalid external temporary file record: ${path}`)
  }
  return parsed
}

export async function registerExternalTemporaryFile(
  path: string,
  id: string
): Promise<string> {
  const record: ExternalTemporaryFileRecord = { id, kind: 'http-download', path, version: 1 }
  if (!isValidExternalRecord(record, id)) throw new Error('Invalid external temporary file identity.')
  const registry = externalRegistryPath()
  const recordPath = externalRecordPath(id)
  await mkdir(registry, { recursive: true })
  try {
    const previous = await readExternalRecord(recordPath, id)
    if (previous.path !== path) throw new Error(`External temporary file identity changed: ${id}`)
    await rm(previous.path, { force: true })
    await rm(recordPath, { force: true })
  } catch (reason) {
    const code = reason && typeof reason === 'object' && 'code' in reason ? reason.code : undefined
    if (code !== 'ENOENT') throw reason
  }
  const stagingPath = join(registry, `.${id}-${randomUUID()}.tmp`)
  try {
    await writeFile(stagingPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'wx' })
    await rename(stagingPath, recordPath)
  } finally {
    await rm(stagingPath, { force: true }).catch(() => undefined)
  }
  return recordPath
}

export async function releaseExternalTemporaryFile(path: string, recordPath: string): Promise<void> {
  const removed = await rm(path, { force: true }).then(() => true, () => false)
  if (removed) await rm(recordPath, { force: true }).catch(() => undefined)
}

async function cleanupExternalTemporaryFiles(): Promise<{ scanned: number; deleted: number; failed: number }> {
  const registry = externalRegistryPath()
  let entries: Array<{ name: string; isFile(): boolean }>
  try {
    entries = await readdir(registry, { withFileTypes: true })
  } catch (reason) {
    const code = reason && typeof reason === 'object' && 'code' in reason ? reason.code : undefined
    if (code !== 'ENOENT') throw reason
    return { scanned: 0, deleted: 0, failed: 0 }
  }
  let scanned = 0
  let deleted = 0
  let failed = 0
  for (const entry of entries) {
    scanned += 1
    const recordPath = join(registry, entry.name)
    try {
      if (!entry.isFile() || !entry.name.endsWith('.json')) throw new Error('Unexpected external temporary file record.')
      const expectedId = entry.name.slice(0, -'.json'.length)
      const record = await readExternalRecord(recordPath, expectedId)
      await rm(record.path, { force: true })
      await rm(recordPath, { force: true })
      deleted += 1
    } catch (reason) {
      failed += 1
      runtimeLog('warn', 'tmp', 'Failed to clean registered external temporary file.', {
        recordPath,
        error: reason
      })
    }
  }
  await rmdir(registry).catch(() => undefined)
  return { scanned, deleted, failed }
}

export async function cleanupTempFiles(): Promise<void> {
  const tempDir = tempDirPath()
  let { scanned, deleted, failed } = await cleanupExternalTemporaryFiles().catch((reason) => {
    runtimeLog('warn', 'tmp', 'External temporary file cleanup failed.', { error: reason })
    return { scanned: 0, deleted: 0, failed: 1 }
  })

  let entries: Array<{ name: string }>
  try {
    entries = await readdir(tempDir, { withFileTypes: true })
  } catch (reason) {
    const code = reason && typeof reason === 'object' ? (reason as { code?: unknown }).code : undefined
    if (code !== 'ENOENT') {
      runtimeLog('warn', 'tmp', 'Temp cleanup skipped.', { dir: tempDir, error: reason })
    }
    return
  }

  for (const entry of entries) {
    if (entry.name === externalRegistryName) continue
    scanned += 1
    const filePath = join(tempDir, entry.name)
    try {
      await rm(filePath, { force: true, recursive: true })
      deleted += 1
    } catch (reason) {
      failed += 1
      runtimeLog('debug', 'tmp', 'Failed to delete temp entry.', { path: filePath, error: reason })
    }
  }

  runtimeLog(deleted > 0 || failed > 0 ? 'info' : 'debug', 'tmp', 'Temp cleanup finished.', {
    dir: tempDir,
    scanned,
    deleted,
    failed
  })
}

export function cleanupTempFilesInBackground(): void {
  const tempDir = tempDirPath()
  const script = `
const fs = require('fs')
const path = require('path')
const dir = process.argv[1]
const registryName = ${JSON.stringify(externalRegistryName)}
const registry = path.join(dir, registryName)
try {
  for (const name of fs.readdirSync(registry)) {
    const recordPath = path.join(registry, name)
    try {
      const record = JSON.parse(fs.readFileSync(recordPath, 'utf8'))
      const valid = record && record.version === 1 && record.kind === 'http-download'
        && typeof record.id === 'string' && name === record.id + '.json'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.id)
        && typeof record.path === 'string' && path.isAbsolute(record.path)
        && path.basename(record.path).endsWith('.anas-download-' + record.id + '.tmp')
      if (!valid) continue
      fs.rmSync(record.path, { force: true })
      fs.rmSync(recordPath, { force: true })
    } catch {}
  }
  fs.rmdirSync(registry)
} catch {}
try {
  for (const name of fs.readdirSync(dir)) {
    if (name === registryName) continue
    fs.rmSync(path.join(dir, name), { recursive: true, force: true })
  }
} catch (reason) {
  if (!reason || reason.code !== 'ENOENT') process.exitCode = 1
}
`

  try {
    const child = spawn(process.execPath, ['-e', script, tempDir], {
      detached: true,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1'
      },
      stdio: 'ignore',
      windowsHide: true
    })
    child.unref()
    runtimeLog('debug', 'tmp', 'Temp cleanup scheduled in background.', { dir: tempDir })
  } catch (reason) {
    runtimeLog('debug', 'tmp', 'Failed to schedule background temp cleanup.', { dir: tempDir, error: reason })
  }
}
