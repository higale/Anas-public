import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { open } from 'yauzl'

const { archiveWindowsRelease } = createRequire(import.meta.url)('../../scripts/archive-windows-release.cjs') as {
  archiveWindowsRelease: (directory: string, destination: string) => Promise<void>
}
const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'anas-release-zip-'))
  roots.push(root)
  const directory = join(root, 'win-unpacked')
  mkdirSync(directory)
  writeFileSync(join(directory, 'Anas.exe'), 'executable')
  return { root, directory, destination: join(root, 'release.zip') }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function readArchive(path: string): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    open(path, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error)
      const entries = new Map<string, Buffer>()
      const fail = (reason: Error) => { zip.close(); reject(reason) }
      zip.on('error', fail)
      zip.on('end', () => resolve(entries))
      zip.on('entry', (entry) => {
        if (entry.fileName.endsWith('/')) {
          entries.set(entry.fileName, Buffer.alloc(0))
          zip.readEntry()
          return
        }
        zip.openReadStream(entry, (reason, stream) => {
          if (reason || !stream) return fail(reason ?? new Error('ZIP entry stream missing.'))
          const chunks: Buffer[] = []
          stream.on('data', (chunk: Buffer) => chunks.push(chunk))
          stream.on('error', fail)
          stream.on('end', () => { entries.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry() })
        })
      })
      zip.readEntry()
    })
  })
}

describe('Windows folder release archive', () => {
  it('includes the entire folder, binary data, hidden files, Unicode names and empty directories', async () => {
    const { directory, destination } = fixture()
    mkdirSync(join(directory, 'resources', 'empty'), { recursive: true })
    const binary = Buffer.from([0, 255, 1, 254])
    writeFileSync(join(directory, 'resources', 'native.dll'), binary)
    writeFileSync(join(directory, 'resources', '.env'), 'EXAMPLE=placeholder')
    writeFileSync(join(directory, '说明.txt'), '使用说明')
    await archiveWindowsRelease(directory, destination)
    const entries = await readArchive(destination)
    expect([...entries.keys()].every((name) => name.startsWith('Anas/'))).toBe(true)
    expect(entries.get('Anas/Anas.exe')?.toString()).toBe('executable')
    expect(entries.get('Anas/resources/native.dll')).toEqual(binary)
    expect(entries.get('Anas/resources/.env')?.toString()).toBe('EXAMPLE=placeholder')
    expect(entries.get('Anas/说明.txt')?.toString()).toBe('使用说明')
    expect(entries.has('Anas/resources/empty/')).toBe(true)
    expect(existsSync(`${destination}.partial`)).toBe(false)
  })

  it('refuses to replace an existing release', async () => {
    const { directory, destination } = fixture()
    writeFileSync(destination, 'published')
    await expect(archiveWindowsRelease(directory, destination)).rejects.toThrow('already exists')
    expect(readFileSync(destination, 'utf8')).toBe('published')
  })

  it('rejects linked package directories before creating an archive', async () => {
    const { root, directory, destination } = fixture()
    const outside = join(root, 'outside')
    mkdirSync(outside)
    symlinkSync(outside, join(directory, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(archiveWindowsRelease(directory, destination)).rejects.toThrow('Unsupported Windows package entry')
    expect(existsSync(destination)).toBe(false)
    expect(existsSync(`${destination}.partial`)).toBe(false)
  })

  it('propagates output errors without publishing an incomplete archive', async () => {
    const { root, directory } = fixture()
    const destination = join(root, 'missing', 'release.zip')
    await expect(archiveWindowsRelease(directory, destination)).rejects.toThrow()
    expect(existsSync(destination)).toBe(false)
  })
})
