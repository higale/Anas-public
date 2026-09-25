import { mkdtemp, realpath, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DIFF_MAX_BYTES } from '@shared/diffContents'
import { readRoundContents } from './roundChanges'
import type { FileChangeLedger } from './fileChangeLedger'

const { beforeStat, beforeOpen } = vi.hoisted(() => ({ beforeStat: vi.fn(), beforeOpen: vi.fn() }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual,
    lstat: async (...args: unknown[]) => { await beforeStat(args[0]); return Reflect.apply(actual.lstat, actual, args) },
    open: async (...args: unknown[]) => { await beforeOpen(args[0]); return Reflect.apply(actual.open, actual, args) }
  }
})
const roots: string[] = []
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'anas-round-current-')))
  roots.push(root)
  const path = join(root, 'example.txt')
  const input = { threadId: 'thread', runId: 'run', filePath: path, version: 'a'.repeat(64), target: 'current' as const }
  const ledger = {
    readRoundContent: vi.fn(() => ({ status: 'ready', path, before: 'before\n', after: 'recorded\n', beforeExists: true, afterExists: true })),
    queryRoundFiles: vi.fn(() => ({}))
  }
  const read = (target: 'current' | 'recorded' = 'current', signal?: AbortSignal) => readRoundContents(ledger as unknown as FileChangeLedger, { ...input, target }, signal)
  return { root, path, input, ledger, read }
}
afterEach(async () => {
  beforeStat.mockReset(); beforeOpen.mockReset()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
describe('round comparison targets', () => {
  it('reads current disk text without Git, while recorded mode never reads disk', async () => {
    const { path, read, ledger } = await fixture()
    await writeFile(path, '\uFEFFcurrent\r\nwithout final newline')
    expect(await read('recorded')).toMatchObject({ before: 'before\n', after: 'recorded\n' })
    expect(beforeStat).not.toHaveBeenCalled()
    expect(await read()).toMatchObject({ before: 'before\n', after: '\uFEFFcurrent\r\nwithout final newline' })
    expect(ledger.readRoundContent).toHaveBeenLastCalledWith(expect.anything(), 'before')
  })
  it('distinguishes missing current files from existing empty files', async () => {
    const { path, read } = await fixture()
    expect(await read()).toMatchObject({ after: '', afterExists: false })
    await writeFile(path, '')
    expect(await read()).toMatchObject({ after: '', afterExists: true })
  })
  it('retries a same-size write during reading without inspecting unrelated files', async () => {
    const { path, root, read } = await fixture()
    await writeFile(path, 'first\n')
    let reads = 0
    beforeStat.mockImplementation(async (candidate) => {
      expect(candidate).toBe(path)
      await writeFile(join(root, 'unrelated.txt'), String(++reads))
      if (reads === 3) {
        await writeFile(path, 'later\n')
        // Windows may coalesce timestamps for writes within one clock tick.
        await utimes(path, new Date(), new Date(Date.now() + 1000))
      }
    })
    expect(await read()).toMatchObject({ after: 'later\n' })
  })
  it('retries atomic editor replacement and bounds a continuously changing file', async () => {
    const { path, root, read } = await fixture()
    await writeFile(path, 'first\n')
    beforeOpen.mockImplementationOnce(async () => {
      await rename(path, join(root, 'replaced.txt'))
      await writeFile(path, 'replacement\n')
    })
    expect(await read()).toMatchObject({ after: 'replacement\n' })
    let revision = 0
    beforeStat.mockImplementation(async () => { await writeFile(path, 'x'.repeat(++revision)) })
    expect(await read()).toMatchObject({ status: 'unavailable', reason: 'changing' })
    expect(revision).toBeLessThanOrEqual(9)
  })
  it.each([
    [Buffer.from([0, 1, 2]), 'binary'], [Buffer.from([0xff, 0xfe]), 'encoding'],
    [Buffer.alloc(DIFF_MAX_BYTES + 1, 120), 'too_large']
  ])('reports unavailable current content without presenting an empty file', async (value, reason) => {
    const { path, read } = await fixture()
    await writeFile(path, value)
    expect(await read()).toMatchObject({ status: 'unavailable', reason })
  })
  it('retries transient invalid text when the selected file changes during that read', async () => {
    const { path, read } = await fixture()
    await writeFile(path, 'original')
    beforeOpen.mockImplementationOnce(async () => { await writeFile(path, Buffer.from([0xff, 0xfe])) })
    let stats = 0
    beforeStat.mockImplementation(async () => {
      if (++stats === 3) await writeFile(path, 'valid completed text\n')
    })
    expect(await read()).toMatchObject({ status: 'ready', after: 'valid completed text\n' })
  })
  it('does not read disk for missing history and propagates access failures and cancellation', async () => {
    const { path, read, ledger } = await fixture()
    ledger.readRoundContent.mockReturnValueOnce({ status: 'unavailable', path, reason: 'history_missing' } as never)
    expect(await read()).toMatchObject({ reason: 'history_missing' })
    expect(beforeStat).not.toHaveBeenCalled()
    await writeFile(path, 'text')
    beforeOpen.mockRejectedValueOnce(Object.assign(new Error('Access denied'), { code: 'EACCES' }))
    await expect(read()).rejects.toMatchObject({ code: 'EACCES' })
    await expect(read('current', AbortSignal.abort(new Error('Closed')))).rejects.toThrow('Closed')
  })
  it('rejects a deleted or changed round while current disk I/O is pending', async () => {
    const { path, read, ledger } = await fixture()
    await writeFile(path, 'current')
    beforeOpen.mockImplementationOnce(() => { ledger.queryRoundFiles.mockImplementationOnce(() => { throw new Error('History changed') }) })
    await expect(read()).rejects.toThrow('History changed')
  })
})
