import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, opendir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { getDataStorageUsage, getDeveloperHttpTraceUsage, measureDirectorySize } from './dataStorageUsage'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, opendir: vi.fn(actual.opendir) }
})

let root = ''

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = ''
  vi.clearAllMocks()
})

async function file(relativePath: string, bytes: number): Promise<void> {
  const path = join(root, relativePath)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, Buffer.alloc(bytes))
}

describe('data storage usage', () => {
  it('measures developer traces without opening unrelated data directories', async () => {
    root = await mkdtemp(join(tmpdir(), 'anas-storage-usage-'))
    await Promise.all([file('dev/model-http/request/body.txt', 15), file('sqlite/agent.sqlite', 100), file('attachments/image.png', 50)])
    expect(await getDeveloperHttpTraceUsage({ dataDir: root })).toEqual({ totalBytes: 15, approximate: false })
    const visited = vi.mocked(opendir).mock.calls.map(([path]) => String(path))
    const traceRoot = join(root, 'dev', 'model-http')
    expect(visited.length).toBeGreaterThan(0)
    expect(visited.every((path) => path === traceRoot || path.startsWith(traceRoot + sep))).toBe(true)
  })

  it('returns zero when the developer trace directory does not exist', async () => {
    root = await mkdtemp(join(tmpdir(), 'anas-storage-usage-'))
    expect(await getDeveloperHttpTraceUsage({ dataDir: root })).toEqual({ totalBytes: 0, approximate: false })
  })

  it('measures the data directory once and classifies cleanup directories', async () => {
    root = await mkdtemp(join(tmpdir(), 'anas-storage-usage-'))
    await Promise.all([
      file('config/settings.json', 11),
      file('cache/models.json', 12),
      file('tmp/speech.bin', 13),
      file('log/current.log', 14),
      file('dev/model-http/request/response-body.sse', 15),
      file('input_history.json', 16)
    ])

    const snapshot = await getDataStorageUsage({
      dataDir: root,
      electronCacheSize: async () => 17
    })

    expect(snapshot.dataDirectory).toEqual({ totalBytes: 81, approximate: false })
    expect(snapshot.developerHttpTrace).toEqual({ totalBytes: 15, approximate: false })
    expect(snapshot.cleanup).toEqual({
      input_history: { totalBytes: 16, approximate: false },
      cache_folder: { totalBytes: 29, approximate: true },
      temp_folder: { totalBytes: 13, approximate: false },
      log_folder: { totalBytes: 14, approximate: false },
      developer_http_trace: { totalBytes: 15, approximate: false }
    })
    await expect(measureDirectorySize(join(root, 'dev', 'model-http'))).resolves.toBe(15)
  })

  it('returns zero for missing paths and keeps the application cache when Chromium measurement fails', async () => {
    root = await mkdtemp(join(tmpdir(), 'anas-storage-usage-'))
    await file('cache/available.bin', 9)

    const snapshot = await getDataStorageUsage({
      dataDir: root,
      electronCacheSize: async () => { throw new Error('unavailable') }
    })

    expect(snapshot.cleanup.cache_folder).toEqual({ totalBytes: 9, approximate: true })
    await expect(measureDirectorySize(join(root, 'missing'))).resolves.toBe(0)
  })
})
