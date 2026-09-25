import { writeJsonFileAtomic as writeAtomic } from './atomicJson'
import { mirrorBundledDirectories } from './bundledDirectories'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { shell } from 'electron'
import { customToolsConfigFileName, getBundledConfigFile, getBundledDataDir, getConfigFile, getDataDir, getToolExamplesDir } from './config/dataDir'
import { parseCustomTools, serializeCustomTool, validateCustomTool, type CustomToolDefinition, type CustomToolSave } from '@shared/customTools'
import { normalizeToolSettings, type ToolImportError, type ToolPackage, type ToolRoot, type ToolSnapshot, type ToolSettings } from '@shared/toolPackages'

let mutationTail: Promise<unknown> = Promise.resolve()
const activeDirectories = new Map<string, number>()
const manifestName = 'TOOL.json'
const maxManifestBytes = 128 * 1024
const maxSourceEntries = 2048
let initialization: Promise<void> | undefined
export const getToolsDir = () => join(getDataDir(), 'tools')
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)
async function exists(path: string) {
  try { await lstat(path); return true } catch (reason) { if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return false; throw reason }
}
async function ensureDirectoriesAndConfig(): Promise<string> {
  await mkdir(getToolsDir(), { recursive: true })
  const path = getConfigFile(customToolsConfigFileName)
  await mkdir(dirname(path), { recursive: true })
  try { await copyFile(getBundledConfigFile(customToolsConfigFileName), path, constants.COPYFILE_EXCL) }
  catch (reason) { if ((reason as NodeJS.ErrnoException).code !== 'EEXIST') throw reason }
  return path
}
async function settings(): Promise<ToolSettings> {
  const path = await ensureDirectoriesAndConfig()
  return normalizeToolSettings(JSON.parse(await readFile(path, 'utf8')))
}
function serialize<T>(operation: () => Promise<T>): Promise<T> {
  const next = mutationTail.then(operation)
  mutationTail = next.catch(() => undefined)
  return next
}
function mutate<T>(operation: (config: ToolSettings) => Promise<T>): Promise<T> {
  return serialize(async () => operation(await settings()))
}
const saveSettings = (value: ToolSettings) => writeAtomic(getConfigFile(customToolsConfigFileName), normalizeToolSettings(value))

async function readDefinition(directory: string) {
  const handle = await open(join(directory, manifestName), constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.size > maxManifestBytes) throw new Error('TOOL.json must be a file no larger than 128 KiB.')
    const buffer = Buffer.alloc(maxManifestBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > maxManifestBytes) throw new Error('TOOL.json exceeds 128 KiB.')
    const raw = JSON.parse(buffer.subarray(0, length).toString('utf8'))
    if (typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(raw.id)) throw new Error('Tool package ID must use letters, numbers, underscores or hyphens (1–100 characters).')
    const [tool] = parseCustomTools([{ ...raw, directory: undefined }])
    return tool
  } finally { await handle.close() }
}

export async function initializeToolsStore(): Promise<void> {
  if (!initialization) {
    initialization = (async () => {
      await ensureDirectoriesAndConfig()
      await mirrorBundledDirectories(join(getBundledDataDir(), 'tools_examples'), getToolExamplesDir(), readDefinition)
    })()
    initialization.catch(() => { initialization = undefined })
  }
  await initialization
}

class ToolImportFailure extends Error {
  constructor(readonly error: ToolImportError) { super(error.detail ?? error.code) }
}

export function toToolImportError(reason: unknown): ToolImportError {
  return reason instanceof ToolImportFailure ? reason.error : { code: 'failed', detail: message(reason) }
}

export function importToolDirectories(sourcePaths: readonly string[]): Promise<{ ids: string[]; names: string[] }> {
  return mutate(async config => {
    if (!Array.isArray(sourcePaths) || !sourcePaths.length || sourcePaths.length > 128
      || sourcePaths.some(path => typeof path !== 'string' || !isAbsolute(path))) {
      throw new ToolImportFailure({ code: 'invalid_directory' })
    }
    const catalog = await readToolSnapshot()
    const catalogError = catalog.roots.find(root => root.error)?.error
    if (catalogError) throw new Error(catalogError)
    const names = new Set(catalog.tools.map(tool => tool.name.toLowerCase()))
    const ids = new Set(catalog.tools.map(tool => tool.id))
    const targets = new Set<string>()
    const root = await realpath(getToolsDir())
    if ((await readdir(root)).length + sourcePaths.length > maxSourceEntries) throw new ToolImportFailure({ code: 'too_many_tools' })
    const sources = []
    for (const path of sourcePaths) {
      const name = basename(path)
      const canonical = await realpath(path).catch(() => undefined)
      if (!canonical || name.startsWith('.') || !(await lstat(canonical)).isDirectory()) throw new ToolImportFailure({ code: 'invalid_directory' })
      const rootRelative = relative(canonical, root)
      if (!rootRelative || (rootRelative !== '..' && !rootRelative.startsWith(`..${sep}`) && !isAbsolute(rootRelative))) {
        throw new ToolImportFailure({ code: 'invalid_directory' })
      }
      const definition = await readDefinition(canonical).catch(reason => { throw new ToolImportFailure({ code: 'invalid_tool', name, detail: message(reason) }) })
      const id = `user:${definition.id}`
      if (targets.has(name.toLowerCase()) || names.has(definition.name.toLowerCase()) || await exists(join(root, name))) {
        throw new ToolImportFailure({ code: 'already_exists', name: definition.name })
      }
      if (ids.has(id)) throw new ToolImportFailure({ code: 'duplicate_id', name: definition.name })
      targets.add(name.toLowerCase()); names.add(definition.name.toLowerCase()); ids.add(id)
      sources.push({ name, path: canonical, definition, id })
    }
    const stage = join(root, `.import-${randomUUID()}`)
    const previous = structuredClone(config)
    const installed: string[] = []
    let settingsSaved = false, entries = 0, bytes = 0
    await mkdir(stage)
    try {
      for (const source of sources) {
        const target = join(stage, source.name)
        await cp(source.path, target, { recursive: true, dereference: false, errorOnExist: true, force: false, verbatimSymlinks: true,
          filter: async path => {
            const info = await lstat(path)
            if (!info.isDirectory() && !info.isFile() && !info.isSymbolicLink()) throw new ToolImportFailure({ code: 'invalid_tool', name: source.name })
            bytes += info.size
            if (++entries > 10000 || bytes > 128 * 1024 * 1024 || relative(source.path, path).split(sep).length > 32) throw new ToolImportFailure({ code: 'too_large' })
            return true
          }
        })
        const staged = await readDefinition(target).catch(reason => { throw new ToolImportFailure({ code: 'invalid_tool', name: source.name, detail: message(reason) }) })
        if (staged.id !== source.definition.id || staged.name !== source.definition.name) throw new ToolImportFailure({ code: 'invalid_tool', name: source.name })
      }
      config.order = [...config.order.filter(id => !id.startsWith('user:')), ...catalog.tools.map(tool => tool.id), ...sources.map(source => source.id)]
      await saveSettings(config)
      settingsSaved = true
      for (const source of sources) {
        const target = join(root, source.name)
        if (await exists(target)) throw new ToolImportFailure({ code: 'already_exists', name: source.name })
        await rename(join(stage, source.name), target)
        installed.push(target)
      }
      return { ids: sources.map(source => source.id), names: sources.map(source => source.definition.name) }
    } catch (reason) {
      const rollback = await Promise.allSettled([
        ...installed.map(path => rm(path, { recursive: true, force: true })),
        ...(settingsSaved ? [saveSettings(previous)] : [])
      ])
      const failures = rollback.filter(result => result.status === 'rejected')
      if (failures.length) throw new Error(`${message(reason)}; import rollback failed: ${failures.map(result => message(result.reason)).join('; ')}`)
      throw reason
    } finally { await rm(stage, { recursive: true, force: true }) }
  })
}

async function scan(root: ToolRoot, config: ToolSettings): Promise<ToolPackage[]> {
  try {
    const entries = await readdir(root.path, { withFileTypes: true })
    if (entries.length > maxSourceEntries) throw new Error(`Tool source exceeds ${maxSourceEntries} entries.`)
    const tools: ToolPackage[] = []
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || (!entry.isDirectory() && !entry.isSymbolicLink())) continue
      const directory = join(root.path, entry.name)
      const base = { rootId: root.id, rootName: root.name, source: root.source, directory }
      try {
        const definition = await readDefinition(directory)
        const id = `${root.id}:${definition.id}`
        tools.push({ ...base, id, name: definition.name, description: definition.description,
          definition: { ...definition, id, directory: await realpath(directory) } })
      } catch (reason) {
        tools.push({ ...base, id: `${root.id}:invalid:${entry.name}`, name: entry.name, description: '', error: message(reason) })
      }
    }
    const counts = new Map<string, number>()
    for (const tool of tools) counts.set(tool.id, (counts.get(tool.id) ?? 0) + 1)
    for (const tool of tools) if (counts.get(tool.id)! > 1) {
      tool.id = `${root.id}:duplicate:${basename(tool.directory)}`
      tool.error = 'Duplicate tool package ID in this source.'
      delete tool.definition
    }
    const rank = new Map(config.order.map((id, index) => [id, index]))
    return tools.sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || a.name.localeCompare(b.name))
  } catch (reason) { root.error = message(reason); return [] }
}

export function listToolSnapshot(sourceFolders: readonly string[] = []): Promise<ToolSnapshot> {
  return serialize(() => readToolSnapshot(sourceFolders))
}

async function readToolSnapshot(sourceFolders: readonly string[] = []): Promise<ToolSnapshot> {
  if (!Array.isArray(sourceFolders) || sourceFolders.some(folder => typeof folder !== 'string' || !isAbsolute(folder))) throw new Error('Tool source folders must be absolute paths.')
  const config = await settings()
  const roots: ToolRoot[] = [
    ...[...new Set(sourceFolders.map(folder => resolve(folder)))].map(folder => ({
      id: `project-${createHash('sha256').update(folder).digest('hex').slice(0, 16)}`,
      name: basename(folder), path: join(folder, '.agents', 'tools'), source: 'project' as const
    })),
    { id: 'user', name: 'User', path: getToolsDir(), source: 'user' }
  ]
  const tools = (await Promise.all(roots.map(root => scan(root, config)))).flat()
  return { roots, tools }
}

/** Pin resources for the process lifetime; saved runs keep their definition but follow the user's package ID. */
export async function withToolPackageDirectory<T>(definition: CustomToolDefinition, operation: (directory: string) => Promise<T>): Promise<T> {
  const directory = await serialize(async () => {
    let current = definition.directory
    if (definition.id.startsWith('user:')) {
      current = (await readToolSnapshot()).tools.find(tool => tool.id === definition.id)?.definition?.directory
    }
    if (!current) throw new Error(`Tool package is unavailable: ${definition.id}`)
    current = await realpath(current)
    activeDirectories.set(current, (activeDirectories.get(current) ?? 0) + 1)
    return current
  })
  try { return await operation(directory) }
  finally {
    const count = activeDirectories.get(directory)! - 1
    if (count) activeDirectories.set(directory, count)
    else activeDirectories.delete(directory)
  }
}

function assertDirectoryIdle(directory: string): void {
  if (activeDirectories.has(directory)) throw new Error('This tool directory is in use. Wait for its running tool calls to finish before renaming or deleting it.')
}

async function renameToolDirectory(source: string, target: string, document: ReturnType<typeof serializeCustomTool>): Promise<void> {
  if (await exists(target)) {
    const [sourceInfo, targetInfo] = await Promise.all([lstat(source), lstat(target)])
    const sameCaseInsensitiveEntry = source.toLowerCase() === target.toLowerCase()
      && sourceInfo.dev === targetInfo.dev && sourceInfo.ino === targetInfo.ino
    if (!sameCaseInsensitiveEntry) throw new Error(`Tool directory already exists: ${basename(target)}`)
  }
  // Keep the package at a visible path even if the app exits between these two
  // atomic operations. A failed manifest replacement leaves the old file intact.
  await rename(source, target)
  try { await writeAtomic(join(target, manifestName), document) }
  catch (reason) {
    try { await rename(target, source) }
    catch (rollback) { throw new Error(`Could not save the tool or restore its directory. Files remain at ${target}. ${message(reason)}; ${message(rollback)}`) }
    throw reason
  }
}

export async function saveToolPackage(input: CustomToolSave): Promise<void> {
  return mutate(async config => {
    const catalog = await readToolSnapshot()
    const existing = input.id === undefined ? undefined : catalog.tools.find(tool => tool.id === input.id)
    if (input.id !== undefined && (!existing || existing.source !== 'user' || !existing.definition)) throw new Error('Only valid user tools can be edited here.')
    const id = existing?.definition?.id.slice('user:'.length) ?? randomUUID()
    const definition = validateCustomTool({ ...input, id, directory: undefined })
    const document = serializeCustomTool(definition)
    if (Buffer.byteLength(`${JSON.stringify(document, null, 2)}\n`, 'utf8') > maxManifestBytes) throw new Error('TOOL.json exceeds 128 KiB.')
    const directory = existing && existing.name === definition.name ? existing.directory : join(getToolsDir(), definition.name)
    if (!existing && await exists(directory)) throw new Error(`Tool directory already exists: ${definition.name}`)
    if (existing && directory !== existing.directory) {
      assertDirectoryIdle(existing.definition!.directory!)
      await renameToolDirectory(existing.directory, directory, document)
    } else if (existing) await writeAtomic(join(directory, manifestName), document)
    else {
      if ((await readdir(getToolsDir())).length >= maxSourceEntries) throw new Error(`Tool source cannot exceed ${maxSourceEntries} entries.`)
      const stage = join(getToolsDir(), `.new-${randomUUID()}`)
      const previous = structuredClone(config)
      let settingsSaved = false
      try {
        await mkdir(stage)
        await writeAtomic(join(stage, manifestName), document)
        const currentIds = catalog.tools.filter(tool => tool.source === 'user').map(tool => tool.id)
        config.order = [...config.order.filter(id => !id.startsWith('user:')), ...currentIds, `user:${id}`]
        // Commit the index before exposing the package. An orphan index entry
        // cannot make a half-created tool available to a concurrent reader.
        await saveSettings(config)
        settingsSaved = true
        await rename(stage, directory)
      } catch (reason) {
        if (settingsSaved) await saveSettings(previous)
        throw reason
      } finally { await rm(stage, { recursive: true, force: true }) }
    }
  })
}

export async function deleteToolPackage(id: string): Promise<void> {
  return mutate(async config => {
    const tool = (await readToolSnapshot()).tools.find(tool => tool.id === id)
    if (!tool || tool.source !== 'user') throw new Error('Only user tools can be deleted here.')
    const directory = await realpath(tool.directory).catch(reason => {
      if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw reason
    })
    if (directory) assertDirectoryIdle(directory)
    await shell.trashItem(tool.directory)
    config.order = config.order.filter(candidate => candidate !== id)
    await saveSettings(config)
  })
}

export async function moveToolPackage(id: string, direction: -1 | 1): Promise<void> {
  return mutate(async config => {
    if (direction !== -1 && direction !== 1) throw new Error('Invalid move direction.')
    const snapshot = await readToolSnapshot()
    const tool = snapshot.tools.find(tool => tool.id === id)
    if (!tool) throw new Error('Tool not found.')
    const ids = snapshot.tools.filter(item => item.rootId === tool.rootId).map(item => item.id)
    const index = ids.indexOf(id), target = index + direction
    if (target < 0 || target >= ids.length) return
    ;[ids[index], ids[target]] = [ids[target], ids[index]]
    config.order = [...config.order.filter(item => !ids.includes(item)), ...ids]
    await saveSettings(config)
  })
}

export async function validateRestoredTools(root: string): Promise<void> {
  normalizeToolSettings(JSON.parse(await readFile(join(root, 'config', customToolsConfigFileName), 'utf8')))
  const directory = join(root, 'tools')
  if (!await exists(directory)) return
  if (!(await lstat(directory)).isDirectory()) throw new Error('Restored tools must be a directory.')
  // Broken individual packages remain visible as unavailable; they must not prevent data recovery.
}
