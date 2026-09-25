import { constants } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { mkdtemp, open, rm, stat, symlink, writeFile, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFileTools } from './fileTools'

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, open: vi.fn(original.open), stat: vi.fn(original.stat) }
})

const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
let root: string
beforeEach(async () => {
  vi.mocked(open).mockReset().mockImplementation(actual.open)
  vi.mocked(stat).mockReset().mockImplementation(actual.stat)
  root = await mkdtemp(join(tmpdir(), 'anas-file-open-'))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function invoke(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
  return createFileTools({ primaryFolder: root, maxReadBytes: 1_000_000, signal, toolNames: [name] })[0].invoke(args)
}

async function boundedFifoRead(pipe: string, run: Promise<unknown>) {
  // A broken implementation must fail without leaving a blocked libuv reader.
  const settled = run.then(value => ({ value }), error => ({ error }))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([settled, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('File tool blocked on a FIFO.')), 2000)
    })])
  } finally {
    clearTimeout(timer)
    const writer = await actual.open(pipe, constants.O_WRONLY | constants.O_NONBLOCK).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENXIO') throw error
      return undefined
    })
    await writer?.close()
    await settled
  }
}

describe('file tool opening boundaries', () => {
  it('rejects directories before attempting to open them', async () => {
    vi.mocked(open).mockRejectedValue(new Error('Attempted to open a non-file'))
    await expect(invoke('read_file', { path: root, format: 'raw' })).rejects.toThrow('path is not a file')
  })

  it.each(['type changed', 'cancelled'])('closes the acquired handle when %s during opening', async reason => {
    const path = join(root, 'file.txt')
    await writeFile(path, 'original\r\n')
    const controller = new AbortController()
    let handle: FileHandle | undefined
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      handle = await actual.open(...args)
      if (reason === 'cancelled') controller.abort(new Error('Read cancelled during open'))
      else vi.spyOn(handle, 'stat').mockResolvedValue(await actual.stat(root))
      return handle
    })
    await expect(invoke('read_file', { path, format: 'raw' }, controller.signal)).rejects.toThrow(
      reason === 'cancelled' ? 'Read cancelled during open' : 'path is not a file'
    )
    await expect(handle!.read(Buffer.alloc(1), 0, 1, 0)).rejects.toThrow('file closed')
  })

  it('reads ordinary file symlinks without changing text', async () => {
    const path = join(root, 'file.txt'), link = join(root, 'link.txt'), content = '\ufefftext\r\n'
    await writeFile(path, content)
    await symlink(path, link, 'file')
    expect(await invoke('read_file', { path: link, format: 'raw' })).toBe(content)
    expect(JSON.parse(await invoke('read_multiple_files', { paths: [link] })).files[0]).toMatchObject({ ok: true, content })
  })

  it.skipIf(process.platform === 'win32').each(['direct', 'linked'])('rejects a %s FIFO in both read formats and batches', async kind => {
    const pipe = join(root, 'pipe'), path = kind === 'direct' ? pipe : join(root, 'link')
    execFileSync('mkfifo', [pipe])
    if (kind === 'linked') await symlink(pipe, path)
    const raw = await boundedFifoRead(pipe, invoke('read_file', { path, format: 'raw' }))
    expect(raw).toMatchObject({ error: expect.objectContaining({ message: 'path is not a file' }) })
    const json = await boundedFifoRead(pipe, invoke('read_file', { path }))
    expect(JSON.parse((json as { value: string }).value)).toMatchObject({ ok: false })
    const batch = await boundedFifoRead(pipe, invoke('read_multiple_files', { paths: [path] }))
    expect(JSON.parse((batch as { value: string }).value).files[0]).toMatchObject({ ok: false })
  })

  it.skipIf(process.platform === 'win32').each(['read_file', 'read_multiple_files', 'get_file_info'])('rejects a FIFO substituted after %s preflight without waiting for a writer', async name => {
    const path = join(root, 'file')
    await writeFile(path, 'text\n')
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      await rm(path)
      execFileSync('mkfifo', [path])
      return actual.open(...args)
    })
    const result = await boundedFifoRead(path, invoke(name, name === 'read_multiple_files' ? { paths: [path] } : { path }))
    const output = JSON.parse((result as { value: string }).value)
    if (name === 'read_multiple_files') expect(output.files[0]).toMatchObject({ ok: false })
    else if (name === 'get_file_info') expect(output).not.toHaveProperty('lineCount')
    else expect(output).toMatchObject({ ok: false })
  })
})
