import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const localRequire = createRequire(import.meta.url)
const { canUsePtyPrebuild } = localRequire('../../scripts/prepare-native-dependencies.cjs') as {
  canUsePtyPrebuild(options: { appDir: string; platform: NodeJS.Platform; arch: string; electronVersion: string }): boolean
}
const options = {
  appDir: process.cwd(), platform: process.platform, arch: process.arch,
  electronVersion: process.versions.electron!
}
const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('native dependency prebuild selection', () => {
  it('retains normal rebuilding for unverified platforms and architectures', () => {
    expect(canUsePtyPrebuild({ ...options, platform: 'linux' })).toBe(false)
    expect(canUsePtyPrebuild({ ...options, arch: 'unverified' })).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')('does not verify a different Electron version with the installed executable', () => {
    expect(canUsePtyPrebuild({ ...options, electronVersion: '0.0.0' })).toBe(false)
  })

  it.skipIf(process.platform !== 'win32')('verifies both native bindings and actual command output in Electron', () => {
    expect(canUsePtyPrebuild(options)).toBe(true)
  }, 20000)

  it.skipIf(process.platform !== 'win32')('returns to normal rebuilding when the prebuild is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-native-dependency-test-'))
    roots.push(root)
    const electron = join(root, 'node_modules', 'electron')
    await mkdir(electron, { recursive: true })
    await writeFile(join(root, 'package.json'), '{}')
    await writeFile(join(electron, 'package.json'), JSON.stringify({ version: options.electronVersion, main: 'index.cjs' }))
    await writeFile(join(electron, 'index.cjs'), `module.exports = ${JSON.stringify(process.execPath)}`)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(canUsePtyPrebuild({ ...options, appDir: root })).toBe(false)
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('using normal rebuild'))
  })
})
