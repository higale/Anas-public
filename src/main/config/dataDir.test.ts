import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const tempDirs: string[] = []
const originalExecPathDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath')
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')
const originalAppImage = process.env.APPIMAGE
const originalPortableExecutableFile = process.env.PORTABLE_EXECUTABLE_FILE

interface LoadDataDirOptions {
  appImagePath?: string
  documentsPath?: string
  executablePath?: string
  isPackaged?: boolean
  platform?: NodeJS.Platform
  portableExecutablePath?: string
}

async function loadDataDir({
  appImagePath,
  documentsPath,
  executablePath = '/Applications/Anas.app/Contents/MacOS/Anas',
  isPackaged = true,
  platform = 'darwin',
  portableExecutablePath
}: LoadDataDirOptions = {}) {
  vi.resetModules()
  const home = await realpath(await mkdtemp(join(tmpdir(), 'anas-data-dir-')))
  const documents = documentsPath ?? join(home, 'Documents')
  const appMock = {
    isPackaged,
    getAppPath: () => '/app',
    getPath: vi.fn((name: string) => {
      if (name !== 'documents') throw new Error(`Unexpected Electron path: ${name}`)
      return documents
    }),
    setPath: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    releaseSingleInstanceLock: vi.fn()
  }

  tempDirs.push(home)
  Object.defineProperty(process, 'execPath', { configurable: true, value: executablePath })
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  if (appImagePath === undefined) delete process.env.APPIMAGE
  else process.env.APPIMAGE = appImagePath
  if (portableExecutablePath === undefined) delete process.env.PORTABLE_EXECUTABLE_FILE
  else process.env.PORTABLE_EXECUTABLE_FILE = portableExecutablePath
  vi.doMock('electron', () => ({ app: appMock }))
  vi.doMock('node:os', () => ({ homedir: () => home }))

  return {
    appMock,
    dataDir: await import('./dataDir'),
    documents,
    home
  }
}

afterEach(async () => {
  if (originalExecPathDescriptor) Object.defineProperty(process, 'execPath', originalExecPathDescriptor)
  if (originalPlatformDescriptor) Object.defineProperty(process, 'platform', originalPlatformDescriptor)
  if (originalAppImage === undefined) delete process.env.APPIMAGE
  else process.env.APPIMAGE = originalAppImage
  if (originalPortableExecutableFile === undefined) delete process.env.PORTABLE_EXECUTABLE_FILE
  else process.env.PORTABLE_EXECUTABLE_FILE = originalPortableExecutableFile
  vi.doUnmock('electron')
  vi.doUnmock('node:os')
  vi.resetModules()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('physical program name resolution', () => {
  it('uses the outer macOS application bundle name', async () => {
    const { dataDir: { resolveProgramName } } = await loadDataDir()

    expect(resolveProgramName('darwin', '/Applications/Anas Work.app/Contents/MacOS/Anas')).toBe('Anas Work')
  })

  it('preserves characters that are valid in a physical macOS bundle name', async () => {
    const { dataDir: { resolveProgramName } } = await loadDataDir()

    expect(resolveProgramName('darwin', '/Applications/Anas\\Work.app/Contents/MacOS/Anas')).toBe('Anas\\Work')
  })

  it('uses the portable executable name on Windows', async () => {
    const { dataDir: { resolveProgramName } } = await loadDataDir()

    expect(resolveProgramName(
      'win32',
      'C:\\Users\\user\\AppData\\Local\\Temp\\Anas.exe',
      'D:\\Tools\\Anas Work.exe'
    )).toBe('Anas Work')
  })

  it('uses the physical executable name for an installed Windows application', async () => {
    const { dataDir: { resolveProgramName } } = await loadDataDir()

    expect(resolveProgramName('win32', 'D:\\Tools\\Anas Research.exe')).toBe('Anas Research')
  })

  it('uses the AppImage file name on Linux', async () => {
    const { dataDir: { resolveProgramName } } = await loadDataDir()

    expect(resolveProgramName(
      'linux',
      '/tmp/.mount_anas/anas',
      undefined,
      '/home/user/Applications/Anas Work.AppImage'
    )).toBe('Anas Work')
  })

  it('uses the executable file name for a regular Linux binary', async () => {
    const { dataDir: { resolveProgramName } } = await loadDataDir()

    expect(resolveProgramName('linux', '/opt/Anas Research/anas-research')).toBe('anas-research')
  })
})

describe('application data directory', () => {
  it('keeps catalog and conversation paths within the selected data directory', async () => {
    const { dataDir, home } = await loadDataDir()
    const selected = join(home, 'profile')

    expect(dataDir.getAgentCatalogFile(selected)).toBe(join(selected, 'sqlite', 'catalog.sqlite'))
    expect(dataDir.getAgentConversationDatabaseFile('conversation-1', selected)).toBe(join(selected, 'sqlite', 'conversations', 'conversation-1.sqlite'))
    for (const id of ['../outside', 'nested/thread', 'nested\\thread', 'CON', 'thread:stream', '']) {
      expect(() => dataDir.getAgentConversationDatabaseFile(id, selected)).toThrow('not a valid database file name')
    }
    expect(existsSync(selected)).toBe(false)
  })

  it('stores packaged app data directly under .gale plus the physical program name', async () => {
    const { appMock, dataDir, home } = await loadDataDir({
      executablePath: '/Applications/Anas Work.app/Contents/MacOS/Anas'
    })

    expect(dataDir.getDataDir()).toBe(join(home, '.galeAnas Work'))
    expect(dataDir.getConfigFile()).toBe(join(home, '.galeAnas Work', 'config', 'settings.json'))
    expect(dataDir.getFileEditRecordsDir()).toBe(join(home, '.galeAnas Work', 'file_edits'))
    expect(dataDir.getFileEditRecordsDir()).not.toContain(join('.galeAnas Work', 'tmp'))
    expect(existsSync(dataDir.getDataDir())).toBe(false)

    dataDir.configureDataRuntime(['Anas'])

    expect(existsSync(dataDir.getDataDir())).toBe(true)
    expect(existsSync(join(dataDir.getDataDir(), 'electron'))).toBe(true)
    expect(appMock.setPath).toHaveBeenCalledWith('userData', join(home, '.galeAnas Work', 'electron'))
  })

  it('uses the logical product name in development instead of Electron', async () => {
    const { dataDir, home } = await loadDataDir({
      executablePath: '/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
      isPackaged: false
    })

    expect(dataDir.getDataDir()).toBe(join(home, '.galeAnas'))
  })

  it('uses an absolute custom data directory from the startup arguments', async () => {
    const { appMock, dataDir, home } = await loadDataDir()
    const customDataDir = join(home, 'Anas profiles', 'research')

    dataDir.configureDataRuntime(['Anas', '--data-dir', customDataDir])

    expect(dataDir.getDataDir()).toBe(customDataDir)
    expect(dataDir.getConfigFile()).toBe(join(customDataDir, 'config', 'settings.json'))
    expect(existsSync(customDataDir)).toBe(true)
    expect(appMock.setPath).toHaveBeenCalledWith('userData', join(customDataDir, 'electron'))
  })

  it('resolves an equals-form relative custom data directory from the launch directory', async () => {
    const { dataDir, home } = await loadDataDir()
    const launchDir = join(home, 'launcher')

    dataDir.configureDataRuntime(['Anas', '--data-dir=profiles/research'], launchDir)

    expect(dataDir.getDataDir()).toBe(join(launchDir, 'profiles', 'research'))
  })

  it('uses a direct positional directory argument', async () => {
    const { dataDir, home } = await loadDataDir()
    const launchDir = join(home, 'launcher')

    dataDir.configureDataRuntime(['Anas', 'profiles/research'], launchDir)

    expect(dataDir.getDataDir()).toBe(join(launchDir, 'profiles', 'research'))
  })

  it('skips the Electron application entry before reading a development positional argument', async () => {
    const { dataDir, home } = await loadDataDir({ isPackaged: false })
    const launchDir = join(home, 'launcher')

    dataDir.configureDataRuntime(['electron', '.', 'profiles/research'], launchDir)

    expect(dataDir.getDataDir()).toBe(join(launchDir, 'profiles', 'research'))
  })

  it('rejects missing, empty, duplicate, and filesystem-root data directory arguments', async () => {
    const { dataDir, home } = await loadDataDir()

    expect(() => dataDir.resolveDataDirArgument(['Anas', '--data-dir'])).toThrow('requires a directory path')
    expect(() => dataDir.resolveDataDirArgument(['Anas', '--data-dir='])).toThrow('non-empty directory path')
    expect(() => dataDir.resolveDataDirArgument([
      'Anas',
      '--data-dir', join(home, 'one'),
      '--data-dir', join(home, 'two')
    ])).toThrow('may only be specified once')
    expect(() => dataDir.resolveDataDirArgument([
      'Anas',
      join(home, 'one'),
      '--data-dir', join(home, 'two')
    ])).toThrow('may only be specified once')
    expect(() => dataDir.resolveDataDirArgument(['Anas', '--data-dir', parse(home).root])).toThrow('filesystem root')
  })

  it('uses the Documents directory and the data directory name without its leading dot for the default workspace', async () => {
    const { appMock, dataDir, documents } = await loadDataDir({
      executablePath: '/Applications/Anas Work.app/Contents/MacOS/Anas'
    })

    expect(dataDir.getDefaultWorkspaceDir()).toBe(join(documents, 'galeAnas Work'))
    expect(appMock.getPath).toHaveBeenCalledWith('documents')
  })

  it('uses the complete custom data directory name for the default workspace', async () => {
    const { dataDir, documents, home } = await loadDataDir()
    const customDataDir = join(home, 'research')
    dataDir.configureDataRuntime(['Anas', '--data-dir', customDataDir])

    expect(dataDir.getDefaultWorkspaceDir()).toBe(join(documents, 'research'))
  })
})
