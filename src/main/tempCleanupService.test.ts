import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dataDirMocks = vi.hoisted(() => ({ tempDir: '' }))
const runtimeLoggerMocks = vi.hoisted(() => ({ runtimeLog: vi.fn() }))

vi.mock('./config/dataDir', () => ({ getTempDir: () => dataDirMocks.tempDir }))
vi.mock('./runtimeLogger', () => runtimeLoggerMocks)

import {
  cleanupTempFiles,
  registerExternalTemporaryFile,
  releaseExternalTemporaryFile
} from './tempCleanupService'

describe('temporary artifact cleanup', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'anas-temp-cleanup-'))
    dataDirMocks.tempDir = join(root, 'app-temp')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
    runtimeLoggerMocks.runtimeLog.mockClear()
  })

  it('removes a registered adjacent download left by a hard exit', async () => {
    const id = '92fc4f89-547c-8f85-8cce-3de105696f70'
    const target = join(root, `report.bin.anas-download-${id}.tmp`)
    await writeFile(target, 'partial download')
    await registerExternalTemporaryFile(target, id)

    await cleanupTempFiles()

    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(dataDirMocks.tempDir)).resolves.toEqual([])
  })

  it('removes the registry record after a normal download cleanup', async () => {
    const id = '95cb583c-29fe-8d10-9fa8-ab710787044d'
    const target = join(root, `report.bin.anas-download-${id}.tmp`)
    const recordPath = await registerExternalTemporaryFile(target, id)
    await writeFile(target, 'complete')

    await releaseExternalTemporaryFile(target, recordPath)
    await cleanupTempFiles()

    await expect(readFile(target)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readdir(dataDirMocks.tempDir)).resolves.toEqual([])
  })

  it('never follows a corrupt registry record to an unrelated file', async () => {
    const id = '9fc93880-7b75-83c2-a79e-0a6dc8c78079'
    const sentinel = join(root, 'sentinel.txt')
    const registry = join(dataDirMocks.tempDir, 'external-files')
    await writeFile(sentinel, 'keep')
    await import('node:fs/promises').then(({ mkdir }) => mkdir(registry, { recursive: true }))
    await writeFile(join(registry, `${id}.json`), JSON.stringify({
      version: 1,
      kind: 'http-download',
      id,
      path: sentinel
    }))

    await cleanupTempFiles()

    await expect(readFile(sentinel, 'utf8')).resolves.toBe('keep')
    await expect(readFile(join(registry, `${id}.json`), 'utf8').then(JSON.parse))
      .resolves.toMatchObject({ path: sentinel })
  })
})
