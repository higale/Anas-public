import { constants } from 'node:fs'
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resettableConfigFiles, type ResettableConfigFile } from '@shared/recovery'
import { isSameOrInsideDirectory, samePath } from './pathContainment'

const excludedRoots = new Set(['electron', 'tmp', 'cache', 'dev'])
const maxEntries = 100_000
const maxBytes = 16 * 1024 ** 3

// A forensic copy, not a logical SQLite backup. Call only after application
// writers have stopped. Preserve WAL/SHM and links without parsing damaged data.
export async function preserveRecoveryData(dataDir: string, destinationParent: string): Promise<string> {
  const root = await realpath(dataDir)
  const parent = await realpath(destinationParent)
  if (isSameOrInsideDirectory(root, parent)) throw new Error('Recovery copies must be saved outside the application data directory.')
  const recoveryDirectory = join(parent, 'Anas-Recovery')
  await mkdir(recoveryDirectory, { recursive: true, mode: 0o700 })
  const recoveryRoot = await realpath(recoveryDirectory)
  if (isSameOrInsideDirectory(root, recoveryRoot)) throw new Error('Recovery copies must be saved outside the application data directory.')
  const output = await mkdtemp(join(recoveryRoot, `${new Date().toISOString().replace(/[:.]/g, '-')}-`))
  const payload = join(output, 'data')
  let entries = 0
  let bytes = 0
  async function copy(source: string, target: string, depth: number): Promise<void> {
    if (++entries > maxEntries || depth > 64) throw new Error('Recovery copy exceeds the file count or directory depth limit.')
    const info = await lstat(source)
    if (info.isSymbolicLink()) {
      await cp(source, target, { dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false })
    } else if (info.isDirectory()) {
      await mkdir(target, { mode: 0o700 })
      for (const entry of await readdir(source)) await copy(join(source, entry), join(target, entry), depth + 1)
    } else if (info.isFile()) {
      bytes += info.size
      if (bytes > maxBytes) throw new Error('Recovery copy exceeds the 16 GiB limit.')
      await copyFile(source, target, constants.COPYFILE_EXCL)
    } else {
      throw new Error(`Cannot preserve special file: ${source}`)
    }
  }
  try {
    await mkdir(payload, { mode: 0o700 })
    for (const name of await readdir(root)) {
      if (!excludedRoots.has(name)) await copy(join(root, name), join(payload, name), 0)
    }
    await writeFile(join(output, 'recovery.json'), JSON.stringify({
      source: root, createdAt: new Date().toISOString(), entries, bytes,
      excludedRoots: [...excludedRoots], symbolicLinks: 'Preserved without copying their targets',
      format: 'Raw data preservation; not a validated application backup'
    }, null, 2), { flag: 'wx', mode: 0o600 })
    return output
  } catch (error) {
    // Only our newly created, incomplete copy is removed. The source is untouched.
    await rm(output, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export function requireResettableConfigFile(file: unknown): ResettableConfigFile {
  if (typeof file !== 'string' || !resettableConfigFiles.includes(file as ResettableConfigFile)) {
    throw new Error('Select exactly one supported configuration file to reset.')
  }
  return file as ResettableConfigFile
}

export async function resetRecoveryConfig(dataDir: string, bundledDir: string, file: ResettableConfigFile): Promise<void> {
  requireResettableConfigFile(file)
  const root = await realpath(dataDir)
  const config = join(root, 'config')
  await mkdir(config, { recursive: true })
  if (!samePath(await realpath(config), config)) throw new Error('Cannot reset configuration through a linked directory.')
  const target = join(config, file)
  try {
    if (!(await lstat(target)).isFile()) throw new Error(`Cannot reset a non-regular configuration file: ${target}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const defaults = await readFile(join(bundledDir, file), 'utf8')
  JSON.parse(defaults)
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, defaults, { flag: 'wx', mode: 0o600 })
    await rename(temporary, target)
  } finally {
    await rm(temporary, { force: true })
  }
}
