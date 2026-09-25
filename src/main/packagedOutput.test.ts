import { createRequire } from 'node:module'
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const { directoryBytes } = createRequire(import.meta.url)('../../scripts/verify-packaged-app.cjs') as {
  directoryBytes: (path: string) => number
}
const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'anas-package-links-'))
  roots.push(root)
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe.skipIf(process.platform === 'win32')('packaged framework symlinks', () => {
  it('counts versioned files only once while accepting framework directory and binary links', () => {
    const root = fixture()
    mkdirSync(join(root, 'Versions', 'A'), { recursive: true })
    writeFileSync(join(root, 'Versions', 'A', 'Binary'), 'binary')
    symlinkSync('A', join(root, 'Versions', 'Current'))
    symlinkSync('Versions/Current/Binary', join(root, 'Binary'))
    expect(directoryBytes(root)).toBe(6 + lstatSync(join(root, 'Versions', 'Current')).size + lstatSync(join(root, 'Binary')).size)
  })
  it('rejects external targets even when the sibling shares the application name prefix', () => {
    const root = fixture()
    const app = join(root, 'app')
    mkdirSync(app)
    writeFileSync(join(root, 'app-external'), 'outside')
    symlinkSync('../app-external', join(app, 'escape'))
    expect(() => directoryBytes(app)).toThrow('escapes the application')
  })
  it.each(['missing', 'loop'])('rejects a %s link instead of ignoring an incomplete package', (target) => {
    const root = fixture()
    symlinkSync(target, join(root, 'loop'))
    expect(() => directoryBytes(root)).toThrow()
  })
})
