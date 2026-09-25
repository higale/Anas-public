import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { isSameOrInsideDirectory, samePath } from './pathContainment'

describe('path containment', () => {
  it.each([
    { paths: path.posix, base: '/workspace/project' },
    { paths: path.win32, base: 'C:\\workspace\\project' }
  ])('distinguishes dot-prefixed child names from parent traversal: $base', ({ paths, base }) => {
    expect(isSameOrInsideDirectory(base, paths.join(base, '..notes', 'file'), paths, false)).toBe(true)
    expect(isSameOrInsideDirectory(base, paths.join(base, '..'), paths, false)).toBe(false)
    expect(isSameOrInsideDirectory(base, paths.join(base, '..', 'other'), paths, false)).toBe(false)
  })

  it('treats Windows paths on different drives as unrelated', () => {
    expect(isSameOrInsideDirectory('C:\\Users\\user\\.galeAnas', 'D:\\AnasData', path.win32, true)).toBe(false)
  })

  it('matches Windows paths case-insensitively', () => {
    expect(samePath('C:\\Projects\\Anas\\Data', 'c:\\projects\\anas\\DATA', path.win32, true)).toBe(true)
  })

  it('detects children without matching siblings', () => {
    expect(isSameOrInsideDirectory('/opt/anas/data', '/opt/anas/data/files', path.posix, false)).toBe(true)
    expect(isSameOrInsideDirectory('/opt/anas/data', '/opt/anas/data-old/files', path.posix, false)).toBe(false)
  })
})
