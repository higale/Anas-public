import { execFileSync } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { customToolDefaults, serializeCustomTool } from '@shared/customTools'
import { selectedTools } from '../test/toolPackageFixture'
import { resolveToolSelection } from '@shared/toolPackages'
import { defaultCapabilities, intersectCapabilities, parseRunConfiguration, resolveSkillSelection, serializeRunConfiguration } from '@shared/agentCapabilities'

const trashItem = vi.hoisted(() => vi.fn(async (_path: string) => {}))
vi.mock('electron', () => ({ shell: { trashItem } }))
vi.mock('./runtimeLogger', () => ({ runtimeLog: vi.fn() }))
let root: string
let store: typeof import('./toolsStore')
async function packageAt(directory: string, id = 'read-id', name = 'read_complete') {
  await mkdir(directory, { recursive: true })
  const definition = { ...customToolDefaults, id, name, description: 'Read complete text.', inputSchema: { type: 'object', properties: {} } }
  await writeFile(join(directory, 'TOOL.json'), JSON.stringify(serializeCustomTool(definition)))
  return definition
}
beforeEach(async () => {
  vi.resetModules()
  root = await mkdtemp(join(tmpdir(), 'anas-tool-sources-'))
  trashItem.mockReset().mockImplementation(async path => { await rename(path, join(root, 'trashed')) })
  vi.doMock('./config/dataDir', () => ({
    customToolsConfigFileName: 'tools.json', getDataDir: () => root,
    getBundledDataDir: () => resolve('data'), getToolExamplesDir: () => join(root, 'tools_examples'),
    getConfigFile: (name: string) => join(root, 'config', name),
    getBundledConfigFile: (name: string) => resolve('data/config', name)
  }))
  store = await import('./toolsStore')
})
afterEach(async () => { vi.doUnmock('./config/dataDir'); vi.doUnmock('node:fs/promises'); await rm(root, { recursive: true, force: true }) })

describe('tool directory imports', () => {
  it('initializes examples and the user directory before import, then imports independent copies', async () => {
    await store.initializeToolsStore()
    const examples = join(root, 'tools_examples')
    expect(await readdir(join(root, 'tools'))).toEqual([])
    expect(await readdir(examples)).toEqual(expect.arrayContaining(['read_text_raw', 'file_sha256', 'json_format']))
    expect((await store.listToolSnapshot()).tools).toEqual([])
    const result = await store.importToolDirectories(['read_text_raw', 'json_format'].map(name => join(examples, name)))
    expect(result.ids).toEqual(['user:example-read-text-raw', 'user:example-json-format'])
    expect((await store.listToolSnapshot()).tools.map(tool => tool.name)).toEqual(['read_text_raw', 'json_format'])
    const importedScript = join(root, 'tools/read_text_raw/scripts/run.py')
    expect(await readFile(importedScript, 'utf8')).toContain('sys.stdout.buffer.write(content)')
    await writeFile(importedScript, '# user edit')
    expect(await readFile(join(examples, 'read_text_raw/scripts/run.py'), 'utf8')).not.toBe('# user edit')
  })
  it('refreshes bundled examples at initialization while preserving user tools', async () => {
    await packageAt(join(root, 'tools/user_tool'), 'user-id', 'user_tool')
    await mkdir(join(root, 'tools_examples/stale'), { recursive: true })
    await writeFile(join(root, 'tools_examples/stale/old.txt'), 'old bundled example')
    await Promise.all([store.initializeToolsStore(), store.initializeToolsStore()])
    expect((await store.listToolSnapshot()).tools.map(tool => tool.name)).toEqual(['user_tool'])
    await expect(readFile(join(root, 'tools_examples/stale/old.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(join(root, 'tools_examples/read_text_raw/TOOL.json'), 'utf8')).name).toBe('read_text_raw')
  })
  it('initializes resources without overwriting or parsing existing user configuration', async () => {
    await mkdir(join(root, 'config'), { recursive: true })
    const path = join(root, 'config/tools.json')
    await writeFile(path, '{invalid user config')
    await store.initializeToolsStore()
    expect(await readFile(path, 'utf8')).toBe('{invalid user config')
    expect(await readdir(join(root, 'tools_examples'))).toContain('read_text_raw')
    await expect(store.listToolSnapshot()).rejects.toThrow()
  })
  it.each(['name', 'id', 'directory'])('refuses %s conflicts before importing any selected directory', async conflict => {
    await packageAt(join(root, 'tools/existing'), 'existing-id', 'existing')
    const first = join(root, 'sources/fresh')
    const second = join(root, 'sources', conflict === 'directory' ? 'existing' : 'conflict')
    await packageAt(first, 'fresh-id', 'fresh')
    await packageAt(second, conflict === 'id' ? 'existing-id' : 'new-id', conflict === 'name' ? 'existing' : 'different')
    const failure = await store.importToolDirectories([first, second]).catch(reason => reason)
    expect(store.toToolImportError(failure).code).toBe(conflict === 'id' ? 'duplicate_id' : 'already_exists')
    expect((await store.listToolSnapshot()).tools.map(tool => tool.name)).toEqual(['existing'])
    expect(await readdir(join(root, 'tools'))).toEqual(['existing'])
  })
  it('rejects invalid definitions and oversized resources without exposing partial packages', async () => {
    const first = join(root, 'sources/first'), second = join(root, 'sources/second')
    await packageAt(first, 'first-id', 'first')
    await mkdir(second, { recursive: true })
    await writeFile(join(second, 'TOOL.json'), '{}')
    const invalid = await store.importToolDirectories([first, second]).catch(reason => reason)
    expect(store.toToolImportError(invalid)).toMatchObject({ code: 'invalid_tool', name: 'second' })
    await packageAt(second, 'second-id', 'second')
    const large = join(second, 'large.bin')
    await writeFile(large, '')
    await truncate(large, 129 * 1024 * 1024)
    const oversized = await store.importToolDirectories([first, second]).catch(reason => reason)
    expect(store.toToolImportError(oversized).code).toBe('too_large')
    expect(await readdir(join(root, 'tools'))).toEqual([])
  })
  it('rolls back published packages and ordering if a later directory cannot be installed', async () => {
    await store.saveToolPackage({ ...customToolDefaults, name: 'existing', description: 'Existing.', inputSchema: { type: 'object' } })
    const configPath = join(root, 'config/tools.json')
    const before = await readFile(configPath, 'utf8')
    const first = join(root, 'sources/first'), second = join(root, 'sources/second')
    await packageAt(first, 'first-id', 'first')
    await packageAt(second, 'second-id', 'second')
    const blockedTarget = join(await realpath(root), 'tools/second')
    vi.doMock('node:fs/promises', async importOriginal => {
      const fs = await importOriginal<typeof import('node:fs/promises')>()
      return { ...fs, rename: async (source: string, target: string) => {
        if (String(source).includes('.import-') && target === blockedTarget) throw new Error('Simulated rename failure')
        return fs.rename(source, target)
      } }
    })
    vi.resetModules()
    store = await import('./toolsStore')
    await expect(store.importToolDirectories([first, second])).rejects.toThrow('Simulated rename failure')
    expect(await readdir(join(root, 'tools'))).toEqual(['existing'])
    expect(await readFile(configPath, 'utf8')).toBe(before)
    expect(await readFile(join(first, 'TOOL.json'), 'utf8')).toContain('first-id')
  })
  it('refuses imports that would make the user catalog exceed its readable size', async () => {
    await store.listToolSnapshot()
    await Promise.all(Array.from({ length: 2048 }, (_, index) => writeFile(join(root, 'tools', `item-${index}`), '')))
    const source = join(root, 'sources/sample')
    await packageAt(source)
    const failure = await store.importToolDirectories([source]).catch(reason => reason)
    expect(store.toToolImportError(failure).code).toBe('too_many_tools')
    expect((await store.listToolSnapshot()).roots[0].error).toBeUndefined()
  })
})

describe('directory tool packages', () => {
  it('saves definitions separately, keeps identity on rename, persists ordering and moves only owned packages to trash', async () => {
    const draft = { ...customToolDefaults, name: 'first_tool', description: 'First.', inputSchema: { type: 'object' } }
    await store.saveToolPackage(draft)
    await store.saveToolPackage({ ...draft, name: 'second_tool' })
    const first = (await store.listToolSnapshot()).tools[0]
    await mkdir(join(first.directory, 'scripts'))
    await writeFile(join(first.directory, 'scripts/run.py'), 'print("hello")')
    await store.saveToolPackage({ ...first.definition!, name: 'renamed', interactive: true })
    const renamed = (await store.listToolSnapshot()).tools[0]
    expect(renamed.id).toBe(first.id)
    expect(renamed.directory).toBe(join(root, 'tools/renamed'))
    expect(renamed.definition?.directory).toBe(await realpath(renamed.directory))
    await expect(readFile(join(first.directory, 'TOOL.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(renamed.directory, 'scripts/run.py'), 'utf8')).toBe('print("hello")')
    expect(renamed.definition?.interactive).toBe(true)
    expect(JSON.parse(await readFile(join(renamed.directory, 'TOOL.json'), 'utf8'))).not.toHaveProperty('directory')
    expect(resolveToolSelection(selectedTools([first.id]), [renamed]).entries).toEqual([first.id])
    await store.moveToolPackage(first.id, 1)
    expect((await store.listToolSnapshot()).tools.map(tool => tool.name)).toEqual(['second_tool', 'renamed'])
    const config = JSON.parse(await readFile(join(root, 'config/tools.json'), 'utf8'))
    expect(config).not.toHaveProperty('tools')
    await store.deleteToolPackage(first.id)
    expect(trashItem).toHaveBeenCalledWith(renamed.directory)
    expect((await store.listToolSnapshot()).tools.map(tool => tool.name)).toEqual(['second_tool'])
  })
  it('refuses a colliding target directory without changing either package', async () => {
    const definition = await packageAt(join(root, 'tools/original'), 'original-id', 'original')
    await packageAt(join(root, 'tools/taken'), 'taken-id', 'taken')
    const before = await readFile(join(root, 'tools/original/TOOL.json'), 'utf8')
    await expect(store.saveToolPackage({ ...definition, id: 'user:original-id', name: 'taken' })).rejects.toThrow('already exists')
    expect(await readFile(join(root, 'tools/original/TOOL.json'), 'utf8')).toBe(before)
    expect((await store.listToolSnapshot()).tools.map(tool => tool.name)).toEqual(['original', 'taken'])
  })
  it('supports case-only name changes on the current filesystem', async () => {
    const definition = await packageAt(join(root, 'tools/lowercase'), 'case-id', 'lowercase')
    await store.saveToolPackage({ ...definition, id: 'user:case-id', name: 'LowerCase' })
    expect(await readdir(join(root, 'tools'))).toEqual(['LowerCase'])
    expect((await store.listToolSnapshot()).tools[0]).toMatchObject({ id: 'user:case-id', name: 'LowerCase' })
  })
  it('restores the original directory and manifest when the updated manifest cannot be saved', async () => {
    const definition = await packageAt(join(root, 'tools/original'), 'stable', 'original')
    const originalDocument = await readFile(join(root, 'tools/original/TOOL.json'), 'utf8')
    const atomic = await import('./atomicJson')
    const write = vi.spyOn(atomic, 'writeJsonFileAtomic').mockRejectedValue(new Error('Disk full'))
    try {
      await expect(store.saveToolPackage({ ...definition, id: 'user:stable', name: 'renamed' })).rejects.toThrow('Disk full')
      expect(await readdir(join(root, 'tools'))).toEqual(['original'])
      expect(await readFile(join(root, 'tools/original/TOOL.json'), 'utf8')).toBe(originalDocument)
    } finally { write.mockRestore() }
  })
  it('blocks directory changes during execution, then resolves the new location from a saved definition', async () => {
    await packageAt(join(root, 'tools/original'), 'stable', 'original')
    const definition = (await store.listToolSnapshot()).tools[0].definition!
    let release!: () => void
    let started!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const ready = new Promise<void>(resolve => { started = resolve })
    const call = store.withToolPackageDirectory(definition, async directory => {
      expect(directory).toBe(definition.directory)
      started()
      await pending
    })
    await ready
    try {
      await expect(store.saveToolPackage({ ...definition, name: 'renamed' })).rejects.toThrow('in use')
      await expect(store.deleteToolPackage(definition.id)).rejects.toThrow('in use')
    } finally { release(); await call }
    await expect(store.withToolPackageDirectory(definition, async () => { throw new Error('Process failed') })).rejects.toThrow('Process failed')
    await store.saveToolPackage({ ...definition, name: 'renamed' })
    await store.withToolPackageDirectory(definition, async directory => {
      expect(directory).toBe(await realpath(join(root, 'tools/renamed')))
    })
    await store.deleteToolPackage(definition.id)
    await expect(store.withToolPackageDirectory(definition, async () => undefined)).rejects.toThrow('unavailable')
  })
  it('runs a captured tool definition from the renamed package directory', async () => {
    await store.saveToolPackage({ ...customToolDefaults, name: 'original', description: 'Read package data.', inputSchema: { type: 'object' },
      command: `"${process.platform === 'win32' ? process.env.npm_node_execpath : process.execPath}" script.cjs {{args}}` })
    const original = (await store.listToolSnapshot()).tools[0]
    await writeFile(join(original.directory, 'script.cjs'), 'process.stdout.write(require("node:fs").readFileSync("data.txt"))')
    await writeFile(join(original.directory, 'data.txt'), 'package resource')
    const { createCustomTools } = await import('./agent/customToolRuntime')
    const [tool] = createCustomTools([original.definition!], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, backgroundTools: false })
    await store.saveToolPackage({ ...original.definition!, name: 'renamed' })
    expect(tool.name).toBe('original')
    expect(await tool.invoke({})).toBe('package resource')
  })
  it('does not expose a new package when saving the source index fails', async () => {
    await store.listToolSnapshot()
    const atomic = await import('./atomicJson')
    const original = atomic.writeJsonFileAtomic
    const write = vi.spyOn(atomic, 'writeJsonFileAtomic').mockImplementation(async (path, value) => {
      if (path === join(root, 'config/tools.json')) throw new Error('Disk full')
      return original(path, value)
    })
    try {
      await expect(store.saveToolPackage({ ...customToolDefaults, name: 'new_tool', description: 'New.', inputSchema: { type: 'object' } })).rejects.toThrow('Disk full')
      expect((await store.listToolSnapshot()).tools).toEqual([])
    } finally { write.mockRestore() }
  })
  it('keeps the catalog available when creating a package would exceed the source entry budget', async () => {
    await store.listToolSnapshot()
    await Promise.all(Array.from({ length: 2047 }, (_, index) => writeFile(join(root, 'tools', `.entry-${index}`), '')))
    await store.saveToolPackage({ ...customToolDefaults, name: 'last_tool', description: 'Last available entry.', inputSchema: { type: 'object' } })
    const before = await readFile(join(root, 'config/tools.json'), 'utf8')
    await expect(store.saveToolPackage({ ...customToolDefaults, name: 'overflow', description: 'One too many.', inputSchema: { type: 'object' } })).rejects.toThrow('2048')
    expect(await readdir(join(root, 'tools'))).toHaveLength(2048)
    expect(await readFile(join(root, 'config/tools.json'), 'utf8')).toBe(before)
    const snapshot = await store.listToolSnapshot()
    expect(snapshot.roots[0].error).toBeUndefined()
    expect(snapshot.tools.map(tool => tool.name)).toEqual(['last_tool'])
    await store.saveToolPackage({ ...snapshot.tools[0].definition!, description: 'Still editable.' })
    expect((await store.listToolSnapshot()).tools[0].description).toBe('Still editable.')
    await store.deleteToolPackage(snapshot.tools[0].id)
    expect((await store.listToolSnapshot()).tools).toEqual([])
  })
  it('selects and persists more than 128 independently discovered tool packages', async () => {
    await Promise.all(Array.from({ length: 129 }, (_, index) => packageAt(join(root, 'tools', `tool_${index}`), `id-${index}`, `tool_${index}`)))
    const snapshot = await store.listToolSnapshot()
    const customTools = resolveToolSelection(selectedTools(snapshot.tools.map(tool => tool.id)), snapshot.tools)
    expect(customTools.entries).toHaveLength(129)
    const configuration = { codingMode: false, capabilities: { ...defaultCapabilities, customTools,
      skills: resolveSkillSelection(defaultCapabilities.skills, []) }, customTools: snapshot.tools.map(tool => tool.definition!) }
    expect(parseRunConfiguration(serializeRunConfiguration(configuration))).toEqual(configuration)
  })
  it('reads regular manifests through symbolic links', async () => {
    const source = join(root, 'source')
    await packageAt(source)
    const directory = join(root, 'tools/linked')
    await mkdir(directory, { recursive: true })
    await symlink(join(source, 'TOOL.json'), join(directory, 'TOOL.json'), 'file')
    const snapshot = await store.listToolSnapshot()
    expect(snapshot.tools[0].definition).toMatchObject({ id: 'user:read-id', name: 'read_complete' })
  })
  it.skipIf(process.platform === 'win32').each(['direct', 'linked'])('rejects a %s FIFO manifest without blocking subsequent catalog operations', async kind => {
    const directory = join(root, 'tools/fifo_tool')
    await mkdir(directory, { recursive: true })
    const manifest = join(directory, 'TOOL.json')
    const pipe = kind === 'linked' ? join(root, 'manifest-pipe') : manifest
    execFileSync('mkfifo', [pipe])
    if (kind === 'linked') await symlink(pipe, manifest)
    const scan = store.listToolSnapshot()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const snapshot = await Promise.race([scan, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Catalog scan blocked on the FIFO manifest.')), 2000)
      })])
      expect(snapshot.tools[0].error).toContain('must be a file')
      await store.saveToolPackage({ ...customToolDefaults, name: 'working_tool', description: 'Still usable.', inputSchema: { type: 'object' } })
      expect((await store.listToolSnapshot()).tools.find(tool => tool.name === 'working_tool')?.definition).toBeDefined()
    } finally {
      clearTimeout(timer)
      // Release a blocked reader if this regression returns, so the test can fail cleanly.
      const writer = await open(pipe, constants.O_WRONLY | constants.O_NONBLOCK).catch(reason => {
        if ((reason as NodeJS.ErrnoException).code !== 'ENXIO') throw reason
        return undefined
      })
      await writer?.close()
      await scan
    }
  })
  it('resolves enabled same-name tools in project folder then user priority order', async () => {
    const folders = [join(root, 'p1'), join(root, 'p2')]
    for (const folder of folders) await packageAt(join(folder, '.agents/tools/read'))
    await packageAt(join(root, 'tools/read'))
    const snapshot = await store.listToolSnapshot(folders)
    expect(snapshot.tools.map(tool => tool.source)).toEqual(['project', 'project', 'user'])
    expect(resolveToolSelection(defaultCapabilities.customTools, snapshot.tools).entries).toEqual([])
    expect(resolveToolSelection(selectedTools(snapshot.tools.map(tool => tool.id)), snapshot.tools).entries).toEqual([snapshot.tools[0].id])
    const select = { project: false, entries: snapshot.tools.slice(1).map(tool => tool.id) }
    expect(resolveToolSelection(select, snapshot.tools).entries).toEqual([snapshot.tools[1].id])
    expect(resolveToolSelection({ ...select, entries: snapshot.tools.slice(2).map(tool => tool.id) }, snapshot.tools).entries).toEqual(['user:read-id'])
    const global = await store.listToolSnapshot()
    expect(resolveToolSelection(defaultCapabilities.customTools, global.tools).entries).toEqual([])
    expect(resolveToolSelection({ ...select, entries: ['user:read-id'] }, global.tools).entries).toEqual(['user:read-id'])
    const other = await store.listToolSnapshot([folders[1]])
    expect(other.tools.filter(tool => tool.source === 'project').map(tool => tool.id)).toEqual([snapshot.tools[1].id])
  })
  it('isolates broken packages, missing sources, duplicate identities and symlinks', async () => {
    await packageAt(join(root, 'tools/valid'))
    await packageAt(join(root, 'tools/broken'), 'broken')
    await writeFile(join(root, 'tools/broken/TOOL.json'), '{')
    await symlink(join(root, 'missing'), join(root, 'tools/link'), 'dir')
    let snapshot = await store.listToolSnapshot([join(root, 'missing-project')])
    expect(snapshot.roots[0].error).toBeTruthy()
    expect(snapshot.tools.filter(tool => tool.error)).toHaveLength(2)
    expect(resolveToolSelection(selectedTools(snapshot.tools.map(tool => tool.id)), snapshot.tools).entries).toEqual(['user:read-id'])
    await packageAt(join(root, 'tools/duplicate'))
    snapshot = await store.listToolSnapshot()
    expect(snapshot.tools.filter(tool => tool.definition)).toHaveLength(0)
    expect(new Set(snapshot.tools.map(tool => tool.id)).size).toBe(snapshot.tools.length)
    await store.deleteToolPackage('user:invalid:link')
    expect(trashItem).toHaveBeenCalledWith(join(root, 'tools/link'))
  })
  it('uses only fixed roots and refuses project edits through global settings', async () => {
    const project = join(root, 'project')
    const directory = join(project, '.agents/tools/read')
    await packageAt(directory)
    await packageAt(join(root, 'unconfigured/read'))
    const snapshot = await store.listToolSnapshot([project])
    expect(snapshot.roots.map(source => source.path)).toEqual([join(project, '.agents/tools'), join(root, 'tools')])
    expect(snapshot.tools).toHaveLength(1)
    await expect(store.deleteToolPackage(snapshot.tools[0].id)).rejects.toThrow('Only user')
    await expect(store.saveToolPackage(snapshot.tools[0].definition!)).rejects.toThrow('Only valid user')
    expect(await readFile(join(directory, 'TOOL.json'), 'utf8')).toContain('read_complete')
  })
  it('uses saved ordering for same-name user tools', async () => {
    await packageAt(join(root, 'tools/first'), 'first')
    await packageAt(join(root, 'tools/second'), 'second')
    expect(resolveToolSelection(selectedTools(['user:first', 'user:second']), (await store.listToolSnapshot()).tools).entries).toEqual(['user:first'])
    await store.moveToolPackage('user:second', -1)
    expect(resolveToolSelection(selectedTools(['user:first', 'user:second']), (await store.listToolSnapshot()).tools).entries).toEqual(['user:second'])
  })
  it('rejects a saved manifest that would exceed the read limit without replacing the working tool', async () => {
    const definition = await packageAt(join(root, 'tools/read'))
    await expect(store.saveToolPackage({ ...definition, id: 'user:read-id', inputSchema: {
      type: 'object', description: '读'.repeat(50000)
    } })).rejects.toThrow('128 KiB')
    expect((await store.listToolSnapshot()).tools[0].definition?.inputSchema).toEqual(definition.inputSchema)
  })
  it('uses subagent project opt-in and applies the root identity ceiling after selection', async () => {
    const folder = join(root, 'project')
    await packageAt(join(folder, '.agents/tools/read'))
    const catalog = await store.listToolSnapshot([folder])
    const policy = { project: false as const, entries: [] }
    expect(resolveToolSelection(policy, catalog.tools, true).entries).toEqual([])
    const own = resolveToolSelection({ ...policy, project: true }, catalog.tools, true)
    expect(own.entries).toEqual([catalog.tools[0].id])
    const capabilities = { ...defaultCapabilities, skills: resolveSkillSelection(defaultCapabilities.skills, []), customTools: own }
    expect(intersectCapabilities(capabilities, { ...capabilities, customTools: policy }).customTools.entries).toEqual([])
    expect(intersectCapabilities(capabilities, capabilities).customTools.entries).toEqual(own.entries)
  })
})
