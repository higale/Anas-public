import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { helpDocuments } from '@shared/helpDocuments'

const paths = vi.hoisted(() => ({ data: '' }))
vi.mock('./config/dataDir', () => ({
  getDataDir: () => paths.data,
  getBundledDataDir: () => resolve('data')
}))
import { initializeHelpFiles, readHelpDocument } from './helpDocuments'

beforeEach(async () => {
  paths.data = await mkdtemp(join(tmpdir(), 'anas-help-'))
  await initializeHelpFiles()
})
afterEach(async () => { await rm(paths.data, { recursive: true, force: true }) })

describe('bundled help documents', () => {
  it('copies and reads all bundled documents without opening the file manager', async () => {
    for (const id of Object.keys(helpDocuments)) {
      expect(await readHelpDocument(id)).toBe(await readFile(join('data/help', id), 'utf8'))
    }
  })
  it.each(['../config/app.json', '', null, {}, '/USER_GUIDE.en.md'])('rejects an unknown document %j', async (id) => {
    await expect(readHelpDocument(id)).rejects.toThrow('Unknown help document')
  })
  it('reports missing and oversized documents instead of truncating their text', async () => {
    const file = join(paths.data, 'help/USER_GUIDE.en.md')
    await writeFile(file, Buffer.alloc(1024 * 1024 + 1))
    await expect(readHelpDocument('USER_GUIDE.en.md')).rejects.toThrow('too large')
    await rm(file)
    await expect(readHelpDocument('USER_GUIDE.en.md')).rejects.toThrow()
  })
})
