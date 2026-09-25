import { createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, realpath, rm, stat, symlink } from 'node:fs/promises'
import { dirname, posix, resolve, sep, win32 } from 'node:path'
import { Transform, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { crc32 } from 'node:zlib'
import { openPromise, type Entry } from 'yauzl'

const gibibyte = 1024 ** 3
const mebibyte = 1024 ** 2
const unixFileTypeMask = 0xf000
const unixRegularFile = 0x8000
const unixDirectory = 0x4000
const unixSymbolicLink = 0xa000

export interface BackupArchiveLimits {
  maxArchiveBytes: number
  maxEntries: number
  maxEntryBytes: number
  maxTotalBytes: number
  maxCompressionRatio: number
  compressionRatioThresholdBytes: number
  maxPathBytes: number
}

export const backupArchiveLimits: Readonly<BackupArchiveLimits> = Object.freeze({
  maxArchiveBytes: 8 * gibibyte,
  maxEntries: 100_000,
  maxEntryBytes: 4 * gibibyte,
  maxTotalBytes: 16 * gibibyte,
  maxCompressionRatio: 1_000,
  compressionRatioThresholdBytes: mebibyte,
  maxPathBytes: 1_024
})

export interface ExtractedBackupArchive {
  fileCount: number
  totalBytes: number
  entryNames: Set<string>
}

const skippedRootDirs = new Set(['dev', 'electron', 'log', 'tmp'])

export function shouldSkipBackupRelativePath(relPath: string): boolean {
  const first = relPath.split(/[\\/]/)[0]?.toLowerCase()
  return skippedRootDirs.has(first)
}

function requireSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Backup archive ${label} is invalid.`)
  }
}

function entryKind(entry: Entry): 'directory' | 'file' | 'link' {
  const unixType = (entry.externalFileAttributes >>> 16) & unixFileTypeMask
  if (unixType === unixSymbolicLink && !entry.fileName.endsWith('/')) return 'link'
  if (entry.fileName.endsWith('/') || unixType === unixDirectory) return 'directory'
  if (unixType === 0 || unixType === unixRegularFile) return 'file'
  throw new Error(`Backup archive entry is not a regular file: ${entry.fileName}`)
}

function normalizedEntryName(entry: Entry, limits: BackupArchiveLimits): string {
  if (entry.isEncrypted()) {
    throw new Error(`Encrypted backup archive entries are not supported: ${entry.fileName}`)
  }
  const rawName = entry.fileName.normalize('NFC').replace(/\\/g, '/')
  const name = rawName.endsWith('/') ? rawName.slice(0, -1) : rawName
  if (
    !name
    || name.startsWith('/')
    || name.includes('\0')
    || win32.isAbsolute(name)
    || Buffer.byteLength(name, 'utf8') > limits.maxPathBytes
  ) {
    throw new Error(`Invalid backup entry path: ${entry.fileName}`)
  }
  const segments = name.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Invalid backup entry path: ${entry.fileName}`)
  }
  return name
}

function safeRestorePath(root: string, relPath: string): string {
  const target = resolve(root, relPath)
  const rootPath = resolve(root)
  if (target === rootPath || !target.startsWith(`${rootPath}${sep}`)) {
    throw new Error(`Invalid backup entry path: ${relPath}`)
  }
  return target
}

function validateEntryBudget(
  entry: Entry,
  limits: BackupArchiveLimits,
  totalDeclaredBytes: number
): number {
  if (!entry.canDecodeFileData()) {
    throw new Error(`Backup archive entry uses an unsupported encoding: ${entry.fileName}`)
  }
  requireSafeInteger(entry.compressedSize, `compressed size for ${entry.fileName}`)
  requireSafeInteger(entry.uncompressedSize, `uncompressed size for ${entry.fileName}`)
  if (entry.uncompressedSize > limits.maxEntryBytes) {
    throw new Error(`Backup archive entry exceeds the size limit: ${entry.fileName}`)
  }
  const nextTotal = totalDeclaredBytes + entry.uncompressedSize
  if (!Number.isSafeInteger(nextTotal) || nextTotal > limits.maxTotalBytes) {
    throw new Error('Backup archive exceeds the total extracted size limit.')
  }
  if (entry.uncompressedSize >= limits.compressionRatioThresholdBytes) {
    const ratio = entry.compressedSize === 0
      ? Number.POSITIVE_INFINITY
      : entry.uncompressedSize / entry.compressedSize
    if (ratio > limits.maxCompressionRatio) {
      throw new Error(`Backup archive entry exceeds the compression ratio limit: ${entry.fileName}`)
    }
  }
  return nextTotal
}

function byteBudgetTransform(
  entry: Entry,
  limits: BackupArchiveLimits,
  addTotalBytes: (bytes: number) => number
): Transform {
  let entryBytes = 0
  let entryCrc32 = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      entryBytes += chunk.byteLength
      entryCrc32 = crc32(chunk, entryCrc32)
      const totalBytes = addTotalBytes(chunk.byteLength)
      if (entryBytes > entry.uncompressedSize || entryBytes > limits.maxEntryBytes) {
        callback(new Error(`Backup archive entry expanded beyond its declared size: ${entry.fileName}`))
        return
      }
      if (totalBytes > limits.maxTotalBytes) {
        callback(new Error('Backup archive exceeded the total extracted size limit.'))
        return
      }
      callback(null, chunk)
    },
    flush(callback) {
      if (entryBytes !== entry.uncompressedSize) {
        callback(new Error(`Backup archive entry size did not match its declaration: ${entry.fileName}`))
        return
      }
      if (entryCrc32 !== entry.crc32) {
        callback(new Error(`Backup archive entry checksum did not match its declaration: ${entry.fileName}`))
        return
      }
      callback()
    }
  })
}

export async function extractBackupArchive(
  sourcePath: string,
  targetRoot: string,
  limits: BackupArchiveLimits = backupArchiveLimits
): Promise<ExtractedBackupArchive> {
  const sourceInfo = await stat(sourcePath)
  if (!sourceInfo.isFile()) throw new Error('Backup archive is not a regular file.')
  if (sourceInfo.size > limits.maxArchiveBytes) {
    throw new Error('Backup archive exceeds the compressed size limit.')
  }

  const zip = await openPromise(sourcePath, {
    autoClose: true,
    lazyEntries: true,
    decodeStrings: true,
    validateEntrySizes: true,
    strictFileNames: true
  })
  const entryNames = new Set<string>()
  const collisionKeys = new Set<string>()
  const links: Array<{ name: string; path: string; target: string; resolvedTarget: string }> = []
  let entryCount = 0
  let fileCount = 0
  let totalDeclaredBytes = 0
  let totalBytes = 0

  try {
    await mkdir(targetRoot, { recursive: true })
    for await (const entry of zip.eachEntry()) {
      entryCount += 1
      if (entryCount > limits.maxEntries) {
        throw new Error('Backup archive contains too many entries.')
      }
      const name = normalizedEntryName(entry, limits)
      const collisionKey = name.toLowerCase()
      if (collisionKeys.has(collisionKey)) {
        throw new Error(`Backup archive contains a duplicate entry path: ${name}`)
      }
      collisionKeys.add(collisionKey)
      const kind = entryKind(entry)
      totalDeclaredBytes = validateEntryBudget(entry, limits, totalDeclaredBytes)
      if (shouldSkipBackupRelativePath(name)) continue
      if (kind === 'directory') {
        if (entry.uncompressedSize !== 0) throw new Error(`Backup directory contains unexpected data: ${name}`)
        await mkdir(safeRestorePath(targetRoot, name), { recursive: true })
        continue
      }
      entryNames.add(name)

      const targetPath = safeRestorePath(targetRoot, name)
      await mkdir(dirname(targetPath), { recursive: true })
      if (kind === 'link' && entry.uncompressedSize > limits.maxPathBytes) throw new Error(`Backup link target is too long: ${name}`)
      const linkChunks: Buffer[] = []
      const source = await zip.openReadStreamPromise(entry)
      await pipeline(
        source,
        byteBudgetTransform(entry, limits, (bytes) => {
          totalBytes += bytes
          return totalBytes
        }),
        kind === 'link' ? new Writable({ write(chunk: Buffer, _encoding, callback) { linkChunks.push(chunk); callback() } })
          : createWriteStream(targetPath, { flags: 'wx' })
      )
      if (kind === 'link') {
        const target = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(linkChunks)).normalize('NFC')
        if (!target || target !== posix.normalize(target) || target.includes('\0') || target.includes('\\') || posix.isAbsolute(target) || win32.isAbsolute(target)) {
          throw new Error(`Invalid backup link target: ${name}`)
        }
        const resolvedTarget = safeRestorePath(targetRoot, posix.join(posix.dirname(name), target))
        links.push({ name, path: targetPath, target, resolvedTarget })
      }
      const unixMode = entry.externalFileAttributes >>> 16
      if ((unixMode & unixFileTypeMask) === unixRegularFile) {
        // Restore ordinary access bits, including executable tool entries, after
        // writing so read-only files can be extracted and umask cannot drop bits.
        await chmod(targetPath, unixMode & 0o777)
      }
      fileCount += 1
    }
    // Resolve every target before creating any link. App backups flatten link
    // chains to archived files/directories; no extraction writes through links.
    const canonicalRoot = await realpath(targetRoot)
    const resolvedLinks = []
    for (const link of links) {
      const occupied = await lstat(link.path).then(() => true, reason => {
        if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw reason
      })
      if (occupied) throw new Error(`Backup link target path conflicts with an extracted entry: ${link.name}`)
      const target = await realpath(link.resolvedTarget).catch(() => { throw new Error(`Backup link target is missing or linked: ${link.name}`) })
      if (!target.startsWith(`${canonicalRoot}${sep}`)) throw new Error(`Backup link target escapes the restore directory: ${link.name}`)
      resolvedLinks.push({ ...link, type: (await stat(target)).isDirectory() ? 'dir' as const : 'file' as const })
    }
    for (const link of resolvedLinks) await symlink(link.target, link.path, link.type)
    if (fileCount === 0) throw new Error('Backup archive is empty.')
    return { fileCount, totalBytes, entryNames }
  } catch (error) {
    await rm(targetRoot, { recursive: true, force: true })
    throw error
  } finally {
    zip.close()
  }
}
