import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const paths = vi.hoisted(() => ({
  cache: '',
  developerHttpTrace: '',
  log: '',
  temp: ''
}))

vi.mock('./config/dataDir', () => ({
  getCacheDir: () => paths.cache,
  getDeveloperHttpTraceDir: () => paths.developerHttpTrace,
  getLogDir: () => paths.log,
  getTempDir: () => paths.temp
}))

vi.mock('./inputHistoryStore', () => ({
  clearInputHistory: vi.fn(async () => undefined)
}))

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'anas-data-cleanup-'))
  paths.cache = join(root, 'cache')
  paths.developerHttpTrace = join(root, 'dev', 'model-http')
  paths.log = join(root, 'log')
  paths.temp = join(root, 'tmp')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('data cleanup service', () => {
  it('clears only unpinned input history through the protected store operation', async () => {
    const { clearInputHistory } = await import('./inputHistoryStore')
    const { cleanupData } = await import('./dataCleanupService')

    await expect(cleanupData({ input_history: true })).resolves.toEqual({
      items: [{ target: 'input_history', ok: true, skipped: false }]
    })
    expect(clearInputHistory).toHaveBeenCalledWith()
  })

  it('clears both application and Electron caches for the cache target', async () => {
    const clearElectronCache = vi.fn(async () => undefined)
    await mkdir(join(paths.cache, 'model_lists'), { recursive: true })
    await writeFile(join(paths.cache, 'model_lists', 'models.json'), '{}', 'utf8')
    const { cleanupData } = await import('./dataCleanupService')

    await expect(cleanupData(
      { cache_folder: true },
      { clearElectronCache }
    )).resolves.toEqual({
      items: [{ target: 'cache_folder', path: paths.cache, ok: true, skipped: false }]
    })
    await expect(readdir(root)).resolves.not.toContain('cache')
    expect(clearElectronCache).toHaveBeenCalledOnce()
  })

  it('reports Electron cache failures as a failed cache cleanup', async () => {
    const { cleanupData } = await import('./dataCleanupService')
    const result = await cleanupData(
      { cache_folder: true },
      { clearElectronCache: async () => { throw new Error('cache busy') } }
    )

    expect(result.items).toEqual([{
      target: 'cache_folder',
      ok: false,
      error: 'cache busy'
    }])
  })

  it('removes the complete developer HTTP trace directory', async () => {
    await mkdir(join(paths.developerHttpTrace, 'request-1'), { recursive: true })
    await writeFile(join(paths.developerHttpTrace, 'request-1', 'response-body.sse'), 'raw response', 'utf8')
    const { cleanupData } = await import('./dataCleanupService')

    await expect(cleanupData({ developer_http_trace: true })).resolves.toEqual({
      items: [{
        target: 'developer_http_trace',
        path: paths.developerHttpTrace,
        ok: true,
        skipped: false
      }]
    })
    await expect(readdir(join(root, 'dev'))).resolves.not.toContain('model-http')
  })
})
