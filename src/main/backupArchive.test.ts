import { createWriteStream } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ZipFile } from 'yazl'
import {
  backupArchiveLimits,
  extractBackupArchive,
  shouldSkipBackupRelativePath,
  type BackupArchiveLimits
} from './backupArchive'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'anas-backup-archive-'))
  temporaryDirectories.push(directory)
  return directory
}

async function writeZip(
  path: string,
  entries: Array<{ name: string; data?: Buffer; mode?: number; compress?: boolean }>
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const zip = new ZipFile()
    const output = createWriteStream(path)
    output.on('close', resolve)
    output.on('error', reject)
    zip.outputStream.on('error', reject)
    zip.outputStream.pipe(output)
    for (const entry of entries) {
      if (entry.name.endsWith('/')) zip.addEmptyDirectory(entry.name)
      else zip.addBuffer(entry.data ?? Buffer.alloc(0), entry.name, { mode: entry.mode, compress: entry.compress })
    }
    zip.end()
  })
}

function limits(overrides: Partial<BackupArchiveLimits>): BackupArchiveLimits {
  return { ...backupArchiveLimits, ...overrides }
}

async function expectRejectedAndClean(
  archive: string,
  target: string,
  expected: string | RegExp,
  archiveLimits: BackupArchiveLimits = backupArchiveLimits
): Promise<void> {
  await expect(extractBackupArchive(archive, target, archiveLimits)).rejects.toThrow(expected)
  await expect(stat(target)).rejects.toMatchObject({ code: 'ENOENT' })
}

function replaceEntryName(buffer: Buffer, from: string, to: string): Buffer {
  const source = Buffer.from(from)
  const replacement = Buffer.from(to)
  if (source.length !== replacement.length) throw new Error('ZIP entry names must have equal byte lengths.')
  const result = Buffer.from(buffer)
  let offset = 0
  let replacements = 0
  while ((offset = result.indexOf(source, offset)) >= 0) {
    replacement.copy(result, offset)
    offset += replacement.length
    replacements += 1
  }
  if (replacements < 2) throw new Error('Expected local and central ZIP entry names.')
  return result
}

function replaceCentralUncompressedSize(buffer: Buffer, size: number): Buffer {
  const result = Buffer.from(buffer)
  const centralHeader = result.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  if (centralHeader < 0) throw new Error('ZIP central directory was not found.')
  result.writeUInt32LE(size, centralHeader + 24)
  return result
}

function markEntryEncrypted(buffer: Buffer): Buffer {
  const result = Buffer.from(buffer)
  const localHeader = result.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  const centralHeader = result.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  if (localHeader < 0 || centralHeader < 0) throw new Error('ZIP entry headers were not found.')
  result.writeUInt16LE(result.readUInt16LE(localHeader + 6) | 1, localHeader + 6)
  result.writeUInt16LE(result.readUInt16LE(centralHeader + 8) | 1, centralHeader + 8)
  return result
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

describe('backup archive extraction', () => {
  it('excludes developer HTTP traces from backup creation and restore', () => {
    expect(shouldSkipBackupRelativePath('dev/model-http/request/response-body.sse')).toBe(true)
    expect(shouldSkipBackupRelativePath('log/current.log')).toBe(true)
    expect(shouldSkipBackupRelativePath('config/settings.json')).toBe(false)
  })

  it('streams regular files while excluding runtime-only roots', async () => {
    const root = await temporaryDirectory()
    const archive = join(root, 'valid.zip')
    const target = join(root, 'restore')
    await writeZip(archive, [
      { name: 'config/settings.json', data: Buffer.from('{"ok":true}') },
      { name: 'notes/state.txt', data: Buffer.from('payload') },
      { name: 'log/ignored.log', data: Buffer.from('not restored') },
      { name: 'dev/model-http/ignored.json', data: Buffer.from('not restored') },
      { name: 'empty/' }
    ])

    const extracted = await extractBackupArchive(archive, target)

    expect(extracted.fileCount).toBe(2)
    expect(extracted.totalBytes).toBe(Buffer.byteLength('{"ok":true}payload'))
    expect(extracted.entryNames).toEqual(new Set([
      'config/settings.json',
      'notes/state.txt'
    ]))
    await expect(readFile(join(target, 'config', 'settings.json'), 'utf8')).resolves.toBe('{"ok":true}')
    await expect(readFile(join(target, 'notes', 'state.txt'), 'utf8')).resolves.toBe('payload')
    await expect(stat(join(target, 'log', 'ignored.log'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(target, 'dev', 'model-http', 'ignored.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects empty and over-count archives before retaining staged output', async () => {
    const root = await temporaryDirectory()
    const emptyArchive = join(root, 'empty.zip')
    const countArchive = join(root, 'count.zip')
    await writeZip(emptyArchive, [{ name: 'directory/' }])
    await writeZip(countArchive, [
      { name: 'one.txt', data: Buffer.from('1') },
      { name: 'two.txt', data: Buffer.from('2') },
      { name: 'three.txt', data: Buffer.from('3') }
    ])

    await expectRejectedAndClean(emptyArchive, join(root, 'empty-target'), 'Backup archive is empty')
    await expectRejectedAndClean(
      countArchive,
      join(root, 'count-target'),
      'too many entries',
      limits({ maxEntries: 2 })
    )
  })

  it.skipIf(process.platform === 'win32')('restores ordinary Unix permissions without special mode bits', async () => {
    const root = await temporaryDirectory()
    const archive = join(root, 'permissions.zip')
    const target = join(root, 'restore')
    await writeZip(archive, [
      { name: 'tools/run', data: Buffer.from('executable'), mode: 0o107751 },
      { name: 'tools/resource', data: Buffer.from('read only'), mode: 0o100440 }
    ])
    await extractBackupArchive(archive, target)
    expect((await stat(join(target, 'tools/run'))).mode & 0o7777).toBe(0o751)
    expect((await stat(join(target, 'tools/resource'))).mode & 0o7777).toBe(0o440)
    expect(await readFile(join(target, 'tools/resource'), 'utf8')).toBe('read only')
  })

  it('rejects single-entry, total-size, compressed-size, and ratio budget violations', async () => {
    const root = await temporaryDirectory()
    const archive = join(root, 'budgets.zip')
    await writeZip(archive, [
      { name: 'one.txt', data: Buffer.alloc(8, 0x61) },
      { name: 'two.txt', data: Buffer.alloc(8, 0x62) }
    ])

    await expectRejectedAndClean(
      archive,
      join(root, 'entry-target'),
      'entry exceeds the size limit',
      limits({ maxEntryBytes: 7 })
    )
    await expectRejectedAndClean(
      archive,
      join(root, 'total-target'),
      'total extracted size limit',
      limits({ maxTotalBytes: 15 })
    )
    await expectRejectedAndClean(
      archive,
      join(root, 'archive-target'),
      'compressed size limit',
      limits({ maxArchiveBytes: 1 })
    )
    await expectRejectedAndClean(
      archive,
      join(root, 'ratio-target'),
      'compression ratio limit',
      limits({ compressionRatioThresholdBytes: 1, maxCompressionRatio: 0.5 })
    )
  })

  it('rejects duplicate, traversal, encrypted, and special-file entries', async () => {
    const root = await temporaryDirectory()
    const duplicate = join(root, 'duplicate.zip')
    const traversal = join(root, 'traversal.zip')
    const encrypted = join(root, 'encrypted.zip')
    const special = join(root, 'special.zip')
    await writeZip(duplicate, [
      { name: 'Config/settings.json', data: Buffer.from('first') },
      { name: 'config/SETTINGS.json', data: Buffer.from('second') }
    ])
    await writeZip(traversal, [{ name: 'aa/x.txt', data: Buffer.from('escape') }])
    await writeFile(
      traversal,
      replaceEntryName(await readFile(traversal), 'aa/x.txt', '../x.txt')
    )
    await writeZip(encrypted, [{ name: 'secret.txt', data: Buffer.from('secret') }])
    await writeFile(encrypted, markEntryEncrypted(await readFile(encrypted)))
    await writeZip(special, [{
      name: 'link',
      data: Buffer.from('target'),
      mode: 0o140777
    }])

    await expectRejectedAndClean(duplicate, join(root, 'duplicate-target'), 'duplicate entry path')
    await expectRejectedAndClean(traversal, join(root, 'traversal-target'), /invalid relative path|Invalid backup entry path/i)
    await expectRejectedAndClean(encrypted, join(root, 'encrypted-target'), 'Encrypted backup archive entries')
    await expectRejectedAndClean(special, join(root, 'special-target'), 'not a regular file')
  })

  it('rejects a stream that expands beyond its central-directory declaration', async () => {
    const root = await temporaryDirectory()
    const archive = join(root, 'mismatch.zip')
    await writeZip(archive, [{ name: 'payload.txt', data: Buffer.from('actual payload') }])
    await writeFile(
      archive,
      replaceCentralUncompressedSize(await readFile(archive), 1)
    )

    await expectRejectedAndClean(
      archive,
      join(root, 'mismatch-target'),
      /declared size|size|bytes/i
    )
  })

  it.each(['/tmp/outside', '../../outside', 'missing', 'C:\\outside', 'missing/../content.txt'])('rejects a link with an unavailable or external target: %s', async target => {
    const root = await temporaryDirectory()
    const archive = join(root, 'link.zip')
    await writeZip(archive, [
      { name: 'tools/run', data: Buffer.from(target), mode: 0o120777 },
      { name: 'tools/content.txt', data: Buffer.from('content') }
    ])
    await expectRejectedAndClean(archive, join(root, 'restore'), /Invalid backup|Backup link target/)
  })

  it('rejects linked target chains and links colliding with extracted ancestors', async () => {
    const root = await temporaryDirectory()
    for (const entries of [
      [{ name: 'tools/a', data: Buffer.from('b'), mode: 0o120777 }, { name: 'tools/b', data: Buffer.from('a'), mode: 0o120777 }],
      [{ name: 'tools/a', data: Buffer.from('b'), mode: 0o120777 }, { name: 'tools/a/file', data: Buffer.from('content') }, { name: 'tools/b/' }]
    ]) {
      const archive = join(root, 'link.zip')
      await writeZip(archive, entries)
      await expectRejectedAndClean(archive, join(root, 'restore'), /Backup link target|EEXIST/)
    }
  })

  it('rejects same-length content corruption before retaining extracted files', async () => {
    const root = await temporaryDirectory()
    const archive = join(root, 'checksum-mismatch.zip')
    const payload = Buffer.from('#!/bin/sh\nprintf original\n')
    await writeZip(archive, [{ name: 'tools/sample/run.sh', data: payload, compress: false }])
    const bytes = await readFile(archive)
    const payloadOffset = bytes.indexOf(payload)
    expect(payloadOffset).toBeGreaterThanOrEqual(0)
    bytes[payloadOffset + payload.length - 2] ^= 1
    await writeFile(archive, bytes)

    await expectRejectedAndClean(archive, join(root, 'checksum-target'), 'checksum did not match')
  })
})
