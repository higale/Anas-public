import { createWriteStream } from 'node:fs'
import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ZipFile } from 'yazl'

const temporaryDirectories: string[] = []
const configFileNames = ['capabilities.json', 'settings.json', 'models.json', 'subagents.json', 'mcp_servers.json', 'tools.json', 'skills.json'] as const

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'anas-backup-service-'))
  temporaryDirectories.push(directory)
  return directory
}

async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text, 'utf8')
}

async function writeZip(path: string, entries: Array<{ name: string; data?: string }>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const zip = new ZipFile()
    const output = createWriteStream(path)
    output.on('close', resolve)
    output.on('error', reject)
    zip.outputStream.on('error', reject)
    zip.outputStream.pipe(output)
    for (const entry of entries) {
      if (entry.name.endsWith('/')) zip.addEmptyDirectory(entry.name)
      else zip.addBuffer(Buffer.from(entry.data ?? ''), entry.name)
    }
    zip.end()
  })
}

async function loadBackupService(
  dataRoot: string,
  validateRestoredDataDirectory: (root: string) => Promise<void> = async () => undefined,
  failRename?: (source: string, target: string) => boolean,
  snapshotStorage: typeof import('./agent/agentDatabaseBackup').snapshotAgentStorage = async () => []
) {
  vi.resetModules()
  if (failRename) {
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const original = await importOriginal<typeof import('node:fs/promises')>()
      return {
        ...original,
        async rename(source: Parameters<typeof original.rename>[0], target: Parameters<typeof original.rename>[1]) {
          if (failRename(String(source), String(target))) {
            throw Object.assign(new Error('injected rename failure'), { code: 'EIO' })
          }
          return original.rename(source, target)
        }
      }
    })
  }
  vi.doMock('./config/dataDir', () => ({
    configDirName: 'config',
    configFileNames,
    getDataDir: () => dataRoot,
    getFileEditRecordsDir: () => join(dataRoot, 'file_edits'),
    getProgramName: () => 'Anas'
  }))
  vi.doMock('./config/rawAppConfig', () => ({
    readRawConfig: async () => ({})
  }))
  vi.doMock('./config/profileConfig', () => ({
    normalizeAppProfile: () => ({ assistant: { name: 'Test Assistant' } })
  }))
  vi.doMock('./agent/agentDatabaseBackup', () => ({
    snapshotAgentStorage: snapshotStorage
  }))
  vi.doMock('./dataRestoreValidation', () => ({ validateRestoredDataDirectory }))
  return import('./backupService')
}

afterEach(async () => {
  vi.doUnmock('./config/dataDir')
  vi.doUnmock('./config/rawAppConfig')
  vi.doUnmock('./config/profileConfig')
  vi.doUnmock('./agent/agentDatabaseBackup')
  vi.doUnmock('./dataRestoreValidation')
  vi.doUnmock('node:fs/promises')
  vi.resetModules()
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )))
})

describe('data backup restore', () => {
  it.for([false, true])('round trips tool packages, resources and selections (links: %s)', async (withLinks, { skip }) => {
    const root = await temporaryDirectory()
    const dataRoot = join(root, 'data')
    const files = new Map<string, Buffer>()
    for (const name of configFileNames) files.set(`config/${name}`, await readFile(join(process.cwd(), 'data/config', name)))
    const toolId = 'user:example-read-text-raw'
    files.set('config/tools.json', Buffer.from(JSON.stringify({ order: [toolId] })))
    const capabilities = JSON.parse(files.get('config/capabilities.json')!.toString())
    capabilities.custom_tools = { project: false, entries: [toolId] }
    files.set('config/capabilities.json', Buffer.from(JSON.stringify(capabilities)))
    for (const name of ['TOOL.json', 'scripts/run.py', 'README.md']) {
      files.set(`tools/read_text_raw/${name}`, await readFile(join(process.cwd(), 'data/tools_examples/read_text_raw', name)))
    }
    files.set('tools/read_text_raw/resources/sample.bin', Buffer.from([0, 1, 255, 13, 10]))
    files.set('tools/read_text_raw/scripts/entry.sh', Buffer.from('#!/bin/sh\nprintf "restored tool"\n'))
    files.set('tools_examples/read_text_raw/TOOL.json', files.get('tools/read_text_raw/TOOL.json')!)
    for (const [name, content] of files) {
      await mkdir(dirname(join(dataRoot, name)), { recursive: true })
      await writeFile(join(dataRoot, name), content)
    }
    const executablePath = join(dataRoot, 'tools/read_text_raw/scripts/entry.sh')
    await chmod(executablePath, 0o750)
    const emptyResource = join(dataRoot, 'tools/read_text_raw/resources/empty')
    await mkdir(emptyResource)
    const links = withLinks ? ['tools/read_text_raw/run', 'tools/read_text_raw/run_alias', 'tools/read_text_raw/resources_alias', 'tools/read_text_raw/self'] : []
    if (links.length) {
      try {
        await symlink(executablePath, join(dataRoot, links[0]), 'file')
      } catch (error) {
        if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) {
          return skip('Windows file symlink creation requires Developer Mode or the symlink privilege')
        }
        throw error
      }
      await symlink('run', join(dataRoot, links[1]), 'file')
      await symlink('resources', join(dataRoot, links[2]), 'dir')
      await symlink('.', join(dataRoot, links[3]), 'dir')
      await writeText(join(root, 'external.txt'), 'not part of the backup')
      await symlink(join(root, 'external.txt'), join(dataRoot, 'tools/read_text_raw/external'))
    }
    const service = await loadBackupService(dataRoot)
    const backup = await service.createDataBackupZip(join(root, 'tools.zip'))
    const { extractBackupArchive } = await import('./backupArchive')
    const extractedRoot = join(root, 'extracted')
    const extracted = await extractBackupArchive(backup.path, extractedRoot)
    expect([...extracted.entryNames].sort()).toEqual([...files.keys(), ...links].sort())
    for (const [name, content] of files) expect(await readFile(join(extractedRoot, name))).toEqual(content)
    await rm(join(dataRoot, 'tools'), { recursive: true })
    await writeText(join(dataRoot, 'tools/new_tool/TOOL.json'), 'new tool after backup')
    await writeText(join(dataRoot, 'config/tools.json'), JSON.stringify({ order: [] }))
    await writeText(join(dataRoot, 'config/capabilities.json'), '{}')
    const result = await service.restoreDataBackupZip(backup.path)
    for (const [name, content] of files) expect(await readFile(join(dataRoot, name))).toEqual(content)
    expect((await stat(emptyResource)).isDirectory()).toBe(true)
    if (process.platform !== 'win32') {
      expect((await stat(executablePath)).mode & 0o777).toBe(0o750)
      expect((await promisify(execFile)(executablePath)).stdout).toBe('restored tool')
      if (withLinks) expect((await promisify(execFile)(join(dataRoot, links[1]))).stdout).toBe('restored tool')
    }
    if (withLinks) {
      for (const link of links) expect((await lstat(join(dataRoot, link))).isSymbolicLink()).toBe(true)
      expect((await readlink(join(dataRoot, links[0]))).replaceAll('\\', '/')).toBe('scripts/entry.sh')
      expect((await readlink(join(dataRoot, links[1]))).replaceAll('\\', '/')).toBe('scripts/entry.sh')
      expect(await readFile(join(dataRoot, links[1]))).toEqual(files.get('tools/read_text_raw/scripts/entry.sh'))
      expect(await readFile(join(dataRoot, links[2], 'sample.bin'))).toEqual(files.get('tools/read_text_raw/resources/sample.bin'))
      expect(await readlink(join(dataRoot, links[3]))).toBe('.')
      expect(await readFile(join(dataRoot, links[3], 'TOOL.json'))).toEqual(files.get('tools/read_text_raw/TOOL.json'))
      await expect(lstat(join(dataRoot, 'tools/read_text_raw/external'))).rejects.toMatchObject({ code: 'ENOENT' })
    }
    await expect(stat(join(dataRoot, 'tools/new_tool'))).rejects.toMatchObject({ code: 'ENOENT' })
    const previousRoot = join(root, 'before-restore')
    await extractBackupArchive(result.preRestoreBackupPath, previousRoot)
    expect(await readFile(join(previousRoot, 'tools/new_tool/TOOL.json'), 'utf8')).toBe('new tool after backup')
  })

  it('keeps referenced attachment files until the ZIP has finished while background cleanup waits', async () => {
    const root = await temporaryDirectory()
    const dataRoot = join(root, 'data')
    const attachmentRoot = join(dataRoot, 'attachments')
    const attachment = join(attachmentRoot, 'thread', 'artifact', 'content.txt')
    await writeText(attachment, 'Attachment captured by the database snapshot')
    const requestId = '11111111-1111-4111-8111-111111111111'
    const requestDirectory = join(dataRoot, 'file_edits', requestId)
    await mkdir(requestDirectory, { recursive: true })
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const snapshotReady = new Promise<void>(resolve => { entered = resolve })
    const service = await loadBackupService(dataRoot, undefined, undefined, async () => {
      entered()
      await gate
      return []
    })
    const { deleteArchivedAgentAttachments } = await import('./agent/agentAttachmentStore')
    const { FileEditStore } = await import('./fileEditStore')
    const backup = service.createDataBackupZip(join(root, 'backup.zip'))
    await snapshotReady
    const cleanup = deleteArchivedAgentAttachments([{ id: 'artifact', path: attachment }], attachmentRoot)
    const editCleanup = new FileEditStore(join(dataRoot, 'file_edits')).deleteFileEditRecordsForRequest(requestId)
    expect(await readFile(attachment, 'utf8')).toContain('captured')
    expect((await stat(requestDirectory)).isDirectory()).toBe(true)
    release()
    const result = await backup
    await cleanup
    await editCleanup
    await expect(stat(requestDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(attachment)).rejects.toMatchObject({ code: 'ENOENT' })
    const { extractBackupArchive } = await import('./backupArchive')
    const extracted = join(root, 'extracted')
    await extractBackupArchive(result.path, extracted)
    expect(await readFile(join(extracted, 'attachments/thread/artifact/content.txt'), 'utf8')).toContain('captured')
  })

  it('excludes attachment trees belonging to already accepted conversation deletions', async () => {
    const root = await temporaryDirectory()
    const dataRoot = join(root, 'data')
    await writeText(join(dataRoot, 'attachments/deleted/artifact/content.txt'), 'Deleted large attachment')
    await writeText(join(dataRoot, 'attachments/retained/artifact/content.txt'), 'Keep this attachment')
    const service = await loadBackupService(dataRoot, undefined, undefined, async (_source, destination) => {
      const absPath = join(destination, 'sqlite/catalog.sqlite')
      await writeText(absPath, 'snapshot catalog')
      return [{ absPath, relPath: 'sqlite/catalog.sqlite', size: 16, excludedAttachmentThreadIds: ['deleted'] }]
    })
    const result = await service.createDataBackupZip(join(root, 'backup.zip'))
    const { extractBackupArchive } = await import('./backupArchive')
    const extracted = await extractBackupArchive(result.path, join(root, 'extracted'))
    expect([...extracted.entryNames]).toEqual(expect.arrayContaining(['attachments/retained/artifact/content.txt']))
    expect([...extracted.entryNames].some(name => name.startsWith('attachments/deleted/'))).toBe(false)
  })

  it('archives SQLite snapshots without copying live databases or their sidecars', async () => {
    const root = await temporaryDirectory()
    const dataRoot = join(root, 'data')
    for (const name of ['catalog.sqlite', 'catalog.sqlite-wal', 'conversations/first.sqlite', 'conversations/first.sqlite-shm']) {
      await writeText(join(dataRoot, 'sqlite', name), `live ${name}`)
    }
    await writeText(join(dataRoot, 'attachments/first/content.txt'), 'attachment')
    const service = await loadBackupService(dataRoot, undefined, undefined, async (_source, destination) => {
      const files = ['sqlite/catalog.sqlite', 'sqlite/conversations/first.sqlite']
      return Promise.all(files.map(async (relPath) => {
        const absPath = join(destination, relPath)
        await writeText(absPath, `snapshot ${relPath}`)
        return { absPath, relPath, size: (await stat(absPath)).size }
      }))
    })

    const result = await service.createDataBackupZip(join(root, 'backup.zip'))
    const { extractBackupArchive } = await import('./backupArchive')
    const destination = join(root, 'extracted')
    const extracted = await extractBackupArchive(result.path, destination)

    expect([...extracted.entryNames].sort()).toEqual([
      'attachments/first/content.txt', 'sqlite/catalog.sqlite', 'sqlite/conversations/first.sqlite'
    ])
    expect(await readFile(join(destination, 'sqlite/conversations/first.sqlite'), 'utf8')).toBe('snapshot sqlite/conversations/first.sqlite')
  })

  it('resets broken project metadata and all database files together, preserving unrelated data', async () => {
    const root = await temporaryDirectory()
    const dataRoot = join(root, 'data')
    const resetFiles = ['projects.json', 'projects.json.delete-journal', 'projects.json.delete-stage',
      'sqlite/catalog.sqlite', 'sqlite/catalog.sqlite-wal', 'sqlite/catalog.sqlite-shm', 'sqlite/catalog.sqlite-journal',
      'sqlite/conversations/first.sqlite', 'sqlite/conversations/second.sqlite', 'sqlite/conversations/second.sqlite-wal']
    for (const name of resetFiles) await writeText(join(dataRoot, name), `broken ${name}`)
    const untouched = ['config/settings.json', 'skills/test/SKILL.md', 'attachments/example.txt', 'sqlite/unrelated.sqlite']
    for (const name of untouched) await writeText(join(dataRoot, name), 'keep')
    const service = await loadBackupService(dataRoot)
    const { preserveRecoveryData } = await import('./recoveryData')
    const preserved = await service.resetProjectData(() => preserveRecoveryData(dataRoot, root))
    for (const name of resetFiles) {
      await expect(stat(join(dataRoot, name))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(preserved, 'data', name), 'utf8')).toBe(`broken ${name}`)
    }
    for (const name of untouched) expect(await readFile(join(dataRoot, name), 'utf8')).toBe('keep')
    expect(await service.recoverInterruptedDataRestore()).toBe(false)
  })

  it('does not reset projects or database when preservation fails', async () => {
    const root = await temporaryDirectory()
    const dataRoot = join(root, 'data')
    await writeText(join(dataRoot, 'projects.json'), 'broken projects')
    await writeText(join(dataRoot, 'sqlite/catalog.sqlite'), 'database')
    const service = await loadBackupService(dataRoot)
    await expect(service.resetProjectData(async () => { throw new Error('disk full') })).rejects.toThrow('disk full')
    expect(await readFile(join(dataRoot, 'projects.json'), 'utf8')).toBe('broken projects')
    expect(await readFile(join(dataRoot, 'sqlite/catalog.sqlite'), 'utf8')).toBe('database')
  })

  it('rolls back catalog and projects if moving the conversation directory fails', async () => {
    const root = await temporaryDirectory()
    const dataRoot = join(root, 'data')
    await writeText(join(dataRoot, 'projects.json'), 'projects')
    await writeText(join(dataRoot, 'sqlite/catalog.sqlite'), 'catalog')
    await writeText(join(dataRoot, 'sqlite/conversations/first.sqlite'), 'conversation')
    const service = await loadBackupService(dataRoot, undefined, (source) =>
      source === join(dataRoot, 'sqlite/conversations'))
    await expect(service.resetProjectData(async () => '/preserved')).rejects.toThrow('injected rename failure')
    expect(await readFile(join(dataRoot, 'projects.json'), 'utf8')).toBe('projects')
    expect(await readFile(join(dataRoot, 'sqlite/catalog.sqlite'), 'utf8')).toBe('catalog')
    expect(await readFile(join(dataRoot, 'sqlite/conversations/first.sqlite'), 'utf8')).toBe('conversation')
  })

  it('rolls back the project file if moving the database fails during reset', async () => {
    const root = await temporaryDirectory()
    const dataRoot = join(root, 'data')
    await writeText(join(dataRoot, 'projects.json'), 'broken projects')
    await writeText(join(dataRoot, 'sqlite/catalog.sqlite'), 'database')
    const service = await loadBackupService(dataRoot, undefined, (source, target) =>
      source === join(dataRoot, 'sqlite/catalog.sqlite') && target.includes(join('previous', 'sqlite', 'catalog.sqlite')))
    await expect(service.resetProjectData(async () => '/preserved')).rejects.toThrow('injected rename failure')
    expect(await readFile(join(dataRoot, 'projects.json'), 'utf8')).toBe('broken projects')
    expect(await readFile(join(dataRoot, 'sqlite/catalog.sqlite'), 'utf8')).toBe('database')
    expect((await readdir(root)).filter((name) => name.startsWith('.anas-restore'))).toEqual([])
  })

  it('recovers an interrupted project reset using the same transaction journal on next startup', async () => {
    const root = await temporaryDirectory()
    const dataRoot = join(root, 'data')
    const transaction = join(root, '.anas-restore-data-test-reset')
    await writeText(join(transaction, 'previous/projects.json'), 'old projects')
    await writeText(join(transaction, 'previous/sqlite/catalog.sqlite'), 'old database')
    await mkdir(join(dataRoot, 'sqlite'), { recursive: true })
    await writeText(join(transaction, 'transaction.json'), JSON.stringify({
      version: 1, dataDir: dataRoot, phase: 'swapping',
      previousEntries: ['projects.json', 'sqlite/catalog.sqlite'], installedEntries: []
    }))
    const service = await loadBackupService(dataRoot)
    expect(await service.recoverInterruptedDataRestore()).toBe(true)
    expect(await readFile(join(dataRoot, 'projects.json'), 'utf8')).toBe('old projects')
    expect(await readFile(join(dataRoot, 'sqlite/catalog.sqlite'), 'utf8')).toBe('old database')
    expect(await service.recoverInterruptedDataRestore()).toBe(false)
  })

  it('rejects linked SQLite directories before preserving or resetting any project data', async () => {
    const root = await temporaryDirectory()
    const dataRoot = join(root, 'data')
    await writeText(join(root, 'external/catalog.sqlite'), 'external database')
    await writeText(join(dataRoot, 'projects.json'), 'projects')
    await symlink(join(root, 'external'), join(dataRoot, 'sqlite'), 'junction')
    const service = await loadBackupService(dataRoot)
    const preserve = vi.fn(async () => '/preserved')
    await expect(service.resetProjectData(preserve)).rejects.toThrow('linked or invalid SQLite directory')
    expect(preserve).not.toHaveBeenCalled()
    expect(await readFile(join(dataRoot, 'projects.json'), 'utf8')).toBe('projects')
    expect(await readFile(join(root, 'external/catalog.sqlite'), 'utf8')).toBe('external database')
  })

  it('rejects damaged reset journals with targets outside the supported data set', async () => {
    const root = await temporaryDirectory()
    const dataRoot = join(root, 'data')
    const transaction = join(root, '.anas-restore-data-test-reset')
    await writeText(join(dataRoot, 'projects.json'), 'keep')
    await writeText(join(root, 'outside.txt'), 'outside')
    const service = await loadBackupService(dataRoot)
    for (const previousEntries of [['../outside.txt'], ['sqlite/other.sqlite'], ['sqlite', 'sqlite/catalog.sqlite']]) {
      await writeText(join(transaction, 'transaction.json'), JSON.stringify({
        version: 1, dataDir: dataRoot, phase: 'swapping', previousEntries, installedEntries: []
      }))
      await expect(service.recoverInterruptedDataRestore()).rejects.toThrow('Invalid restore transaction journal')
      expect(await readFile(join(dataRoot, 'projects.json'), 'utf8')).toBe('keep')
      expect(await readFile(join(root, 'outside.txt'), 'utf8')).toBe('outside')
    }
  })


  it('restores a valid bounded archive only after staging and validation completes', async () => {
    const root = await temporaryDirectory()
    const dataRoot = join(root, 'data')
    const archive = join(root, 'valid.zip')
    await Promise.all([
      writeText(join(dataRoot, 'old.txt'), 'old data'),
      writeText(join(dataRoot, 'log', 'current.log'), 'keep runtime log'),
      ...configFileNames.map((fileName) => (
        writeText(join(dataRoot, 'config', fileName), `old ${fileName}`)
      ))
    ])
    await writeZip(archive, [
      ...configFileNames.map((fileName) => ({
        name: `config/${fileName}`,
        data: `new ${fileName}`
      })),
      { name: 'notes/state.txt', data: 'new state' },
      { name: 'log/archived.log', data: 'must not restore' }
    ])
    const backupService = await loadBackupService(dataRoot)

    const result = await backupService.restoreDataBackupZip(archive)

    expect(result.path).toBe(archive)
    expect(result.fileCount).toBe(configFileNames.length + 1)
    expect((await stat(result.preRestoreBackupPath)).isFile()).toBe(true)
    await expect(readFile(join(dataRoot, 'config', 'settings.json'), 'utf8')).resolves.toBe('new settings.json')
    await expect(readFile(join(dataRoot, 'notes', 'state.txt'), 'utf8')).resolves.toBe('new state')
    await expect(readFile(join(dataRoot, 'log', 'current.log'), 'utf8')).resolves.toBe('keep runtime log')
    await expect(stat(join(dataRoot, 'log', 'archived.log'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(dataRoot, 'old.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not change current data or create a pre-restore backup for an invalid archive', async () => {
    const root = await temporaryDirectory()
    const dataRoot = join(root, 'data')
    const archive = join(root, 'missing-config.zip')
    await writeText(join(dataRoot, 'current.txt'), 'current data')
    await writeZip(archive, [{ name: 'config/settings.json', data: '{}' }])
    const backupService = await loadBackupService(dataRoot)
    const deactivate = vi.fn(async () => undefined)
    const activate = vi.fn(async () => undefined)

    await expect(backupService.restoreDataBackupZip(archive, {
      deactivate,
      activate
    })).rejects.toThrow(
      'Backup archive is missing config/capabilities.json'
    )

    expect(deactivate).not.toHaveBeenCalled()
    expect(activate).not.toHaveBeenCalled()
    await expect(readFile(join(dataRoot, 'current.txt'), 'utf8')).resolves.toBe('current data')
    expect((await readdir(root)).filter((name) => name !== 'data' && name !== 'missing-config.zip'))
      .toEqual([])
  })

  it('does not accept directories in place of required configuration files', async () => {
    const root = await temporaryDirectory()
    const dataRoot = join(root, 'data')
    const archive = join(root, 'directory-config.zip')
    await writeText(join(dataRoot, 'current.txt'), 'current data')
    await writeZip(archive, [
      ...configFileNames.map((fileName) => ({ name: `config/${fileName}/` })),
      { name: 'notes/state.txt', data: 'filler' }
    ])
    const backupService = await loadBackupService(dataRoot)

    await expect(backupService.restoreDataBackupZip(archive)).rejects.toThrow(
      'Backup archive is missing config/capabilities.json'
    )
    await expect(readFile(join(dataRoot, 'current.txt'), 'utf8')).resolves.toBe('current data')
  })

  it('rejects formally invalid staged data before creating a safety backup or changing live data', async () => {
    const root = await temporaryDirectory()
    const dataRoot = join(root, 'data')
    const archive = join(root, 'invalid-data.zip')
    await writeText(join(dataRoot, 'current.txt'), 'current data')
    await writeZip(archive, configFileNames.map((fileName) => ({
      name: `config/${fileName}`,
      data: '{}'
    })))
    const backupService = await loadBackupService(dataRoot, async () => {
      throw new Error('formal validation failed')
    })

    await expect(backupService.restoreDataBackupZip(archive)).rejects.toThrow('formal validation failed')
    await expect(readFile(join(dataRoot, 'current.txt'), 'utf8')).resolves.toBe('current data')
    expect((await readdir(root)).sort()).toEqual(['data', 'invalid-data.zip'])
  })

  it('rolls back the complete managed data set when restored runtime activation fails', async () => {
    const root = await temporaryDirectory()
    const dataRoot = join(root, 'data')
    const archive = join(root, 'startup-failure.zip')
    await Promise.all([
      writeText(join(dataRoot, 'current.txt'), 'current data'),
      writeText(join(dataRoot, 'log', 'current.log'), 'keep log'),
      ...configFileNames.map((fileName) => writeText(join(dataRoot, 'config', fileName), `old ${fileName}`))
    ])
    await writeZip(archive, [
      ...configFileNames.map((fileName) => ({ name: `config/${fileName}`, data: `new ${fileName}` })),
      { name: 'notes/state.txt', data: 'new state' }
    ])
    const backupService = await loadBackupService(dataRoot)
    let activations = 0
    let deactivations = 0
    const states: string[] = []

    await expect(backupService.restoreDataBackupZip(archive, {
      async deactivate() {
        deactivations += 1
      },
      async activate() {
        activations += 1
        if (activations === 1) throw new Error('restored startup failed')
      },
      stateChanged(state) {
        states.push(state)
      }
    })).rejects.toThrow('restored startup failed')

    expect(deactivations).toBe(2)
    expect(activations).toBe(2)
    expect(states).toEqual(['rolled_back'])
    await expect(readFile(join(dataRoot, 'current.txt'), 'utf8')).resolves.toBe('current data')
    await expect(readFile(join(dataRoot, 'config', 'settings.json'), 'utf8')).resolves.toBe('old settings.json')
    await expect(readFile(join(dataRoot, 'log', 'current.log'), 'utf8')).resolves.toBe('keep log')
    await expect(stat(join(dataRoot, 'notes', 'state.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(root)).filter((name) => name.startsWith('.anas-restore-'))).toEqual([])
  })

  it('quiesces before swapping and activates only after the restored data is installed', async () => {
    const root = await temporaryDirectory()
    const dataRoot = join(root, 'data')
    const archive = join(root, 'ordered.zip')
    await Promise.all([
      writeText(join(dataRoot, 'marker.txt'), 'old'),
      ...configFileNames.map((fileName) => writeText(join(dataRoot, 'config', fileName), `old ${fileName}`))
    ])
    await writeZip(archive, [
      ...configFileNames.map((fileName) => ({ name: `config/${fileName}`, data: `new ${fileName}` })),
      { name: 'marker.txt', data: 'new' }
    ])
    const backupService = await loadBackupService(dataRoot)
    const order: string[] = []

    await backupService.restoreDataBackupZip(archive, {
      async deactivate() {
        order.push(`deactivate:${await readFile(join(dataRoot, 'marker.txt'), 'utf8')}`)
      },
      async activate() {
        order.push(`activate:${await readFile(join(dataRoot, 'marker.txt'), 'utf8')}`)
      },
      finish() {
        order.push('finish')
      },
      stateChanged(state) {
        order.push(state)
      }
    })

    expect(order).toEqual(['deactivate:old', 'activate:new', 'committed', 'finish'])
  })

  it('serializes complete restore lifecycles', async () => {
    const root = await temporaryDirectory()
    const dataRoot = join(root, 'data')
    const firstArchive = join(root, 'first.zip')
    const secondArchive = join(root, 'second.zip')
    await Promise.all([
      ...configFileNames.map((fileName) => writeText(join(dataRoot, 'config', fileName), `old ${fileName}`)),
      writeZip(firstArchive, configFileNames.map((fileName) => ({
        name: `config/${fileName}`,
        data: `first ${fileName}`
      }))),
      writeZip(secondArchive, configFileNames.map((fileName) => ({
        name: `config/${fileName}`,
        data: `second ${fileName}`
      })))
    ])
    const backupService = await loadBackupService(dataRoot)
    const order: string[] = []
    const lifecycle = (name: string) => ({
      async deactivate() {
        order.push(`deactivate:${name}`)
      },
      async activate() {
        order.push(`activate:${name}`)
      }
    })

    await Promise.all([
      backupService.restoreDataBackupZip(firstArchive, lifecycle('first')),
      backupService.restoreDataBackupZip(secondArchive, lifecycle('second'))
    ])

    expect(order).toEqual([
      'deactivate:first',
      'activate:first',
      'deactivate:second',
      'activate:second'
    ])
    await expect(readFile(join(dataRoot, 'config', 'settings.json'), 'utf8'))
      .resolves.toBe('second settings.json')
  })

  it('reactivates unchanged data when recovery fails after deactivation but before swap', async () => {
    const root = await temporaryDirectory()
    const dataRoot = join(root, 'data')
    const archive = join(root, 'recovery-failure.zip')
    await Promise.all([
      writeText(join(dataRoot, 'current.txt'), 'current data'),
      writeText(join(root, '.anas-restore-data-broken', 'transaction.json'), '{broken'),
      ...configFileNames.map((fileName) => writeText(join(dataRoot, 'config', fileName), `old ${fileName}`))
    ])
    await writeZip(archive, configFileNames.map((fileName) => ({
      name: `config/${fileName}`,
      data: `new ${fileName}`
    })))
    const backupService = await loadBackupService(dataRoot)
    const order: string[] = []

    await expect(backupService.restoreDataBackupZip(archive, {
      async deactivate() {
        order.push('deactivate')
      },
      async activate() {
        order.push('activate')
      }
    })).rejects.toThrow()

    expect(order).toEqual(['deactivate', 'activate'])
    await expect(readFile(join(dataRoot, 'current.txt'), 'utf8')).resolves.toBe('current data')
    await expect(readFile(join(dataRoot, 'config', 'settings.json'), 'utf8')).resolves.toBe('old settings.json')
  })

  it('deactivates restored data before rolling back a failed commit journal', async () => {
    const root = await temporaryDirectory()
    const dataRoot = join(root, 'data')
    const archive = join(root, 'commit-failure.zip')
    await Promise.all([
      writeText(join(dataRoot, 'marker.txt'), 'old'),
      ...configFileNames.map((fileName) => writeText(join(dataRoot, 'config', fileName), `old ${fileName}`))
    ])
    await writeZip(archive, [
      ...configFileNames.map((fileName) => ({ name: `config/${fileName}`, data: `new ${fileName}` })),
      { name: 'marker.txt', data: 'new' }
    ])
    let failNextCommittedJournal = false
    let injected = false
    const backupService = await loadBackupService(
      dataRoot,
      async () => undefined,
      (_source, target) => {
        if (!failNextCommittedJournal || injected || !String(target).endsWith('transaction.json')) {
          return false
        }
        injected = true
        return true
      }
    )
    const order: string[] = []
    let activation = 0

    await expect(backupService.restoreDataBackupZip(archive, {
      async deactivate() {
        order.push(`deactivate:${await readFile(join(dataRoot, 'marker.txt'), 'utf8')}`)
      },
      async activate() {
        activation += 1
        order.push(`activate:${await readFile(join(dataRoot, 'marker.txt'), 'utf8')}`)
        if (activation === 1) failNextCommittedJournal = true
      },
      finish() {
        order.push('finish')
      },
      stateChanged(state) {
        order.push(state)
      }
    })).rejects.toThrow('injected rename failure')

    expect(order).toEqual([
      'deactivate:old',
      'activate:new',
      'deactivate:new',
      'rolled_back',
      'activate:old',
      'finish'
    ])
    await expect(readFile(join(dataRoot, 'marker.txt'), 'utf8')).resolves.toBe('old')
  })

  it('automatically rolls back a durable interrupted swap before the next restore or startup', async () => {
    const root = await temporaryDirectory()
    const dataRoot = join(root, 'data')
    const transactionRoot = join(root, '.anas-restore-data-interrupted')
    await Promise.all([
      writeText(join(dataRoot, 'config', 'settings.json'), 'new data'),
      writeText(join(dataRoot, 'log', 'current.log'), 'keep log'),
      writeText(join(transactionRoot, 'previous', 'config', 'settings.json'), 'old data'),
      writeText(join(transactionRoot, 'previous', 'old.txt'), 'old file'),
      writeText(join(transactionRoot, 'staged', 'notes', 'state.txt'), 'uninstalled staged data'),
      writeText(join(transactionRoot, 'transaction.json'), JSON.stringify({
        version: 1,
        dataDir: dataRoot,
        phase: 'activated',
        previousEntries: ['config', 'old.txt'],
        installedEntries: ['config']
      }))
    ])
    const backupService = await loadBackupService(dataRoot)

    await expect(backupService.recoverInterruptedDataRestore()).resolves.toBe(true)

    await expect(readFile(join(dataRoot, 'config', 'settings.json'), 'utf8')).resolves.toBe('old data')
    await expect(readFile(join(dataRoot, 'old.txt'), 'utf8')).resolves.toBe('old file')
    await expect(readFile(join(dataRoot, 'log', 'current.log'), 'utf8')).resolves.toBe('keep log')
    await expect(stat(transactionRoot)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rolls back entries already renamed when installation fails midway', async () => {
    const root = await temporaryDirectory()
    const dataRoot = join(root, 'data')
    const archive = join(root, 'rename-failure.zip')
    await Promise.all([
      writeText(join(dataRoot, 'current.txt'), 'current data'),
      ...configFileNames.map((fileName) => writeText(join(dataRoot, 'config', fileName), `old ${fileName}`))
    ])
    await writeZip(archive, [
      ...configFileNames.map((fileName) => ({ name: `config/${fileName}`, data: `new ${fileName}` })),
      { name: 'notes/state.txt', data: 'new state' }
    ])
    const backupService = await loadBackupService(
      dataRoot,
      async () => undefined,
      (_source, target) => target === join(dataRoot, 'notes')
    )

    await expect(backupService.restoreDataBackupZip(archive)).rejects.toThrow('injected rename failure')

    await expect(readFile(join(dataRoot, 'current.txt'), 'utf8')).resolves.toBe('current data')
    await expect(readFile(join(dataRoot, 'config', 'settings.json'), 'utf8')).resolves.toBe('old settings.json')
    await expect(stat(join(dataRoot, 'notes'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await readdir(root)).filter((name) => name.startsWith('.anas-restore-'))).toEqual([])
  })

  it('preserves entries already restored when rollback fails and is retried', async () => {
    const root = await temporaryDirectory()
    const dataRoot = join(root, 'data')
    const transactionRoot = join(root, '.anas-restore-data-rollback-interrupted')
    await Promise.all([
      writeText(join(dataRoot, 'config', 'settings.json'), 'new config'),
      writeText(join(dataRoot, 'tools', 'sample', 'run.sh'), 'new script'),
      writeText(join(dataRoot, 'new-only.txt'), 'new file'),
      writeText(join(transactionRoot, 'previous', 'config', 'settings.json'), 'old config'),
      writeText(join(transactionRoot, 'previous', 'tools', 'sample', 'run.sh'), 'old script'),
      writeText(join(transactionRoot, 'transaction.json'), JSON.stringify({
        version: 1,
        dataDir: dataRoot,
        phase: 'activated',
        previousEntries: ['config', 'tools'],
        installedEntries: ['config', 'tools', 'new-only.txt']
      }))
    ])
    let failRollback = true
    const backupService = await loadBackupService(dataRoot, undefined, (source) => (
      failRollback && source === join(transactionRoot, 'previous', 'config')
    ))

    await expect(backupService.recoverInterruptedDataRestore()).rejects.toThrow('injected rename failure')
    expect(await readFile(join(dataRoot, 'tools', 'sample', 'run.sh'), 'utf8')).toBe('old script')
    await expect(stat(join(dataRoot, 'new-only.txt'))).rejects.toMatchObject({ code: 'ENOENT' })

    failRollback = false
    await expect(backupService.recoverInterruptedDataRestore()).resolves.toBe(true)
    expect(await readFile(join(dataRoot, 'tools', 'sample', 'run.sh'), 'utf8')).toBe('old script')
    expect(await readFile(join(dataRoot, 'config', 'settings.json'), 'utf8')).toBe('old config')
    await expect(stat(transactionRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(backupService.recoverInterruptedDataRestore()).resolves.toBe(false)
  })
})
