import { isAbsolute, join, resolve } from 'node:path'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveShellOperandPath, resolveWorkspacePath, tryResolveWorkspacePath } from './workspacePath'

const temporaryDirectories: string[] = []
async function shellFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'anas-shell-path-')))
  temporaryDirectories.push(root)
  const skill = join(root, 'skill'), outside = join(root, 'outside')
  await mkdir(skill)
  await mkdir(join(outside, 'child'), { recursive: true })
  await writeFile(join(skill, 'run.py'), 'SKILL')
  await writeFile(join(outside, 'run.py'), 'OUTSIDE')
  return { root, skill, outside }
}
afterEach(async () => { await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

describe('literal Shell operand paths', () => {
  it('resolves existing absolute and relative filenames from the execution directory', async () => {
    const h = await shellFixture()
    for (const operand of ['run.py', join(h.skill, 'run.py')]) {
      expect(await readFile(await resolveShellOperandPath(operand, h.skill), 'utf8')).toBe('SKILL')
    }
    await expect(resolveShellOperandPath('missing.py', h.skill)).rejects.toThrow()
  })

  it.skipIf(process.platform === 'win32')('follows a symlink before processing a subsequent parent component', async () => {
    const h = await shellFixture()
    await symlink(join(h.outside, 'child'), join(h.skill, 'link'))
    for (const operand of ['link/../run.py', `${h.skill}/link/../run.py`]) {
      expect(await readFile(await resolveShellOperandPath(operand, h.skill), 'utf8')).toBe('OUTSIDE')
    }
  })

  it.skipIf(process.platform === 'win32')('retains leading and trailing whitespace in quoted filenames', async () => {
    const h = await shellFixture()
    for (const name of [' run.py', 'run.py ']) {
      await writeFile(join(h.skill, name), name)
      expect(await readFile(await resolveShellOperandPath(name, h.skill), 'utf8')).toBe(name)
    }
  })

  it.skipIf(process.platform === 'win32')('does not erase invalid intermediate components', async () => {
    const h = await shellFixture()
    await expect(resolveShellOperandPath('missing/../run.py', h.skill)).rejects.toThrow()
    await expect(resolveShellOperandPath('run.py/../run.py', h.skill)).rejects.toThrow()
  })
})

describe('workspace paths', () => {
  const primaryFolder = resolve('workspace', 'primary')

  it('resolves relative paths from the primary folder', () => {
    expect(resolveWorkspacePath(join('src', 'main.ts'), primaryFolder))
      .toBe(join(primaryFolder, 'src', 'main.ts'))
  })

  it('preserves absolute paths', () => {
    const path = resolve('outside', 'notes.txt')
    expect(isAbsolute(path)).toBe(true)
    expect(resolveWorkspacePath(path, primaryFolder)).toBe(path)
  })

  it('rejects missing paths without producing an authorization path', () => {
    expect(() => resolveWorkspacePath('  ', primaryFolder)).toThrow('path is required')
    expect(tryResolveWorkspacePath(undefined, primaryFolder)).toBeUndefined()
  })

  it.runIf(process.platform === 'win32')('rejects ambiguous Windows paths', () => {
    expect(() => resolveWorkspacePath('C:outside.txt', primaryFolder))
      .toThrow('path must be relative or a fully qualified absolute path')
    expect(() => resolveWorkspacePath('\\outside.txt', primaryFolder))
      .toThrow('path must be relative or a fully qualified absolute path')
    expect(() => resolveWorkspacePath('\\\\server', primaryFolder))
      .toThrow('path must be relative or a fully qualified absolute path')
    expect(tryResolveWorkspacePath('C:outside.txt', primaryFolder)).toBeUndefined()
  })

  it.runIf(process.platform === 'win32')('accepts fully qualified Windows paths', () => {
    expect(resolveWorkspacePath('C:\\outside.txt', primaryFolder)).toBe('C:\\outside.txt')
    expect(resolveWorkspacePath('\\\\server\\share\\outside.txt', primaryFolder))
      .toBe('\\\\server\\share\\outside.txt')
  })
})
