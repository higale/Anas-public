import type { Dir, Dirent, Stats } from 'node:fs'
import { lstat, opendir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectoryTreePages } from './directoryTree'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, lstat: vi.fn(actual.lstat), opendir: vi.fn(actual.opendir) }
})
const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
let root: string, pages: DirectoryTreePages, rootInfo: Stats, fileInfo: Stats

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

beforeEach(async () => {
  vi.mocked(lstat).mockImplementation(fs.lstat)
  vi.mocked(opendir).mockImplementation(fs.opendir)
  root = await fs.mkdtemp(join(tmpdir(), 'anas-tree-pages-'))
  await fs.writeFile(join(root, 'fixture.txt'), 'fixture')
  rootInfo = await fs.lstat(root)
  fileInfo = await fs.lstat(join(root, 'fixture.txt'))
  pages = new DirectoryTreePages()
})

afterEach(async () => {
  await pages.closeIdleCursors()
  vi.useRealTimers()
  await fs.rm(root, { recursive: true, force: true })
})

function largeDirectory(count: number, directories = false) {
  let read = 0, closed = false
  const close = vi.fn(async () => { closed = true })
  const directory = {
    read: vi.fn(async () => {
      if (closed) throw new Error('Directory was closed')
      return read < count ? { name: `item-${read++}` } as Dirent : null
    }), close
  } as unknown as Dir
  vi.mocked(opendir).mockResolvedValue(directory)
  vi.mocked(lstat).mockImplementation(async path => String(path) === root || directories ? rootInfo : fileInfo)
  return { directory, close, readCount: () => read }
}

const readOptions = () => ({ root, scope: 'run-one', entryLimit: 3 })

describe('incremental directory tree pages', () => {
  it('reads only a small prefix of a huge directory and continues without rereading earlier entries', async () => {
    const listing = largeDirectory(1_000_000)
    const first = await pages.read({ ...readOptions(), entryLimit: 1 })
    expect(first).toMatchObject({ entries: [{ relativePath: '.', type: 'directory' }], hasMore: true })
    expect(listing.readCount()).toBeLessThan(4)
    const cursor = first.nextCursor as string
    const next = await pages.read({ ...readOptions(), cursor })
    expect(next.entries).toMatchObject([{ relativePath: 'item-0' }, { relativePath: 'item-1' }, { relativePath: 'item-2' }])
    expect(listing.readCount()).toBeLessThan(6)
    expect(opendir).toHaveBeenCalledTimes(1)
    await expect(pages.read({ ...readOptions(), cursor })).rejects.toThrow('expired or was consumed')
    await pages.closeIdleCursors()
    expect(listing.close).toHaveBeenCalledOnce()
  })

  it('paginates real nested directories breadth-first without duplicates or missing files', async () => {
    for (let i = 0; i < 5; i++) {
      await fs.mkdir(join(root, `dir-${i}`))
      await fs.writeFile(join(root, `dir-${i}`, 'child.txt'), String(i))
    }
    const entries: Array<{ relativePath: string; depth: number }> = []
    let cursor: string | undefined
    do {
      const page = await pages.read({ ...readOptions(), cursor })
      entries.push(...page.entries as typeof entries)
      cursor = page.nextCursor as string | undefined
    } while (cursor)
    expect(entries).toHaveLength(12)
    expect(new Set(entries.map(entry => entry.relativePath)).size).toBe(12)
    expect(entries.map(entry => entry.depth)).toEqual([0, ...Array(6).fill(1), ...Array(5).fill(2)])
    const fileReads = vi.mocked(lstat).mock.calls.map(([path]) => String(path)).filter(path => path.endsWith('.txt'))
    expect(fileReads.length).toBe(new Set(fileReads).size)
  })

  it('reports directories omitted by the bounded frontier instead of allocating the whole tree', async () => {
    const listing = largeDirectory(1_000_000, true)
    const first = await pages.read({ ...readOptions(), entryLimit: 1000 })
    const second = await pages.read({ ...readOptions(), entryLimit: 1000, cursor: first.nextCursor as string })
    expect(second).toMatchObject({ hasMore: true, queueTruncated: true, truncated: true })
    expect(second.entries).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'directory', childrenOmitted: 'directory_queue_limit' })]))
    expect(listing.readCount()).toBeLessThan(2100)
  })

  it('limits deep expansion and never opens a directory at the requested boundary', async () => {
    const page = await pages.read({ ...readOptions(), depthLimit: 0 })
    expect(page).toMatchObject({ hasMore: false, depthTruncated: true,
      entries: [{ relativePath: '.', childrenOmitted: 'depth_limit' }] })
    expect(opendir).not.toHaveBeenCalled()
    await expect(pages.read({ ...readOptions(), depthLimit: 65 })).rejects.toThrow('depth')
  })

  it('does not follow directory symlinks', async () => {
    await fs.mkdir(join(root, 'actual'))
    await fs.writeFile(join(root, 'actual', 'inside.txt'), 'inside')
    try { await fs.symlink(join(root, 'actual'), join(root, 'linked'), 'junction') } catch (error) {
      if (['EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return
      throw error
    }
    const page = await pages.read({ ...readOptions(), entryLimit: 100 })
    expect(page.entries).toEqual(expect.arrayContaining([expect.objectContaining({ relativePath: 'linked', type: 'symlink' })]))
    expect(JSON.stringify(page.entries)).not.toContain(join('linked', 'inside.txt'))
  })

  it('binds cursors to their run, root and depth without consuming them on mismatches', async () => {
    largeDirectory(100)
    const first = await pages.read({ ...readOptions(), depthLimit: 2 })
    const cursor = first.nextCursor as string
    await expect(pages.read({ ...readOptions(), cursor, scope: 'different-run' })).rejects.toThrow('different run or path')
    await expect(pages.read({ ...readOptions(), cursor, root: join(root, 'other') })).rejects.toThrow('different run or path')
    await expect(pages.read({ ...readOptions(), cursor, depthLimit: 3 })).rejects.toThrow('same max_depth')
    expect(await pages.read({ ...readOptions(), cursor })).toMatchObject({ depthLimit: 2, hasMore: true })
  })

  it('rejects a cursor when its root has been replaced', async () => {
    const listing = largeDirectory(100)
    const first = await pages.read(readOptions())
    // Preserve Stats methods and use a distinct value even when a Windows
    // file ID exceeds Number.MAX_SAFE_INTEGER and adding one has no effect.
    const replacedRoot: Stats = Object.assign(Object.create(rootInfo), { ino: rootInfo.ino === 0 ? 1 : 0 })
    vi.mocked(lstat).mockResolvedValueOnce(replacedRoot)
    await expect(pages.read({ ...readOptions(), cursor: first.nextCursor as string })).rejects.toThrow('root changed')
    expect(listing.close).toHaveBeenCalledOnce()
  })

  it('invalidates a cursor when its open subdirectory is replaced with a symlink between pages', async () => {
    const treeRoot = join(root, 'tree'), active = join(treeRoot, 'active'), outside = join(root, 'outside')
    await fs.mkdir(active, { recursive: true })
    for (let index = 0; index < 3; index++) {
      await fs.mkdir(join(active, `nested-${index}`))
      await fs.mkdir(join(outside, `nested-${index}`), { recursive: true })
      await fs.writeFile(join(outside, `nested-${index}`, 'outside-only.txt'), 'outside')
    }
    const handles: Dir[] = []
    vi.mocked(opendir).mockImplementation(async (path, options) => {
      const directory = await fs.opendir(path, options)
      handles.push(directory)
      return directory
    })
    const first = await pages.read({ ...readOptions(), root: treeRoot, entryLimit: 2 })
    await fs.rename(active, join(root, 'old-active'))
    await fs.symlink(outside, active, 'junction')
    await expect(pages.read({ ...readOptions(), root: treeRoot, cursor: first.nextCursor as string }))
      .rejects.toThrow('changed; start again without cursor')
    await expect(pages.read({ ...readOptions(), root: treeRoot, cursor: first.nextCursor as string }))
      .rejects.toThrow('expired or was consumed')
    for (const handle of handles) await expect(handle.read()).rejects.toMatchObject({ code: 'ERR_DIR_CLOSED' })
  })

  it('rejects a replaced ancestor even when the open directory retains its inode', async () => {
    const treeRoot = join(root, 'tree'), parent = join(treeRoot, 'parent'), active = join(parent, 'active')
    await fs.mkdir(active, { recursive: true })
    for (let index = 0; index < 3; index++) await fs.writeFile(join(active, `file-${index}`), 'original')
    let acquired: Dir | undefined
    vi.mocked(opendir).mockImplementation(async (path, options) => {
      const directory = await fs.opendir(path, options)
      if (String(path) === active) acquired = directory
      return directory
    })
    const first = await pages.read({ ...readOptions(), root: treeRoot, entryLimit: 3 })
    expect(acquired).toBeDefined()
    const original = await fs.lstat(active), moved = join(root, 'moved-parent')
    const canonical = await fs.realpath(active)
    // Windows locks an ancestor containing an open directory. Move the open
    // directory itself, then replace its now-empty ancestor with a junction.
    await fs.mkdir(moved)
    await fs.rename(active, join(moved, 'active'))
    await fs.rmdir(parent)
    await fs.symlink(moved, parent, 'junction')
    const current = await fs.lstat(active)
    expect([current.dev, current.ino]).toEqual([original.dev, original.ino])
    expect(await fs.realpath(active)).not.toBe(canonical)
    await expect(pages.read({ ...readOptions(), root: treeRoot, cursor: first.nextCursor as string }))
      .rejects.toThrow('changed; start again without cursor')
    await expect(acquired!.read()).rejects.toMatchObject({ code: 'ERR_DIR_CLOSED' })
    await expect(pages.read({ ...readOptions(), root: treeRoot, cursor: first.nextCursor as string }))
      .rejects.toThrow('expired or was consumed')
  })

  it.each(['opening', 'page return', 'directory completion'])('invalidates changed paths and closes acquired handles before %s', async boundary => {
    const treeRoot = join(root, 'tree'), active = join(treeRoot, 'active'), outside = join(root, 'outside')
    await fs.mkdir(active, { recursive: true })
    await fs.mkdir(outside)
    await fs.writeFile(join(active, 'original.txt'), 'original')
    let acquired: Dir | undefined
    const replaceActive = async () => {
      await fs.rename(active, join(root, 'old-active'))
      await fs.symlink(outside, active, 'junction')
    }
    vi.mocked(opendir).mockImplementation(async (path, options) => {
      const directory = await fs.opendir(path, options)
      if (String(path) === active) {
        acquired = directory
        if (boundary === 'opening') await replaceActive()
      }
      return directory
    })
    if (boundary !== 'opening') vi.mocked(lstat).mockImplementation(async path => {
      const info = await fs.lstat(path)
      if (String(path) === join(active, 'original.txt')) await replaceActive()
      return info
    })
    await expect(pages.read({ ...readOptions(), root: treeRoot, entryLimit: boundary === 'page return' ? 2 : 100 }))
      .rejects.toThrow('changed; start again without cursor')
    expect(acquired).toBeDefined()
    await expect(acquired!.read()).rejects.toMatchObject({ code: 'ERR_DIR_CLOSED' })
  })

  it('closes a directory acquired after cancellation without starting its enumeration', async () => {
    const listing = largeDirectory(100)
    const opening = deferred<Dir>(), started = deferred<void>()
    vi.mocked(opendir).mockImplementationOnce(() => { started.resolve(); return opening.promise })
    const controller = new AbortController()
    const pending = pages.read({ ...readOptions(), signal: controller.signal })
    const rejection = expect(pending).rejects.toThrow('Stopped')
    await started.promise
    controller.abort(new Error('Stopped'))
    opening.resolve(listing.directory)
    await rejection
    expect(listing.readCount()).toBe(0)
    expect(listing.close).toHaveBeenCalledOnce()
  })

  it('rejects overlapping page requests and closes the cursor when the active page is cancelled', async () => {
    const listing = largeDirectory(100)
    const first = await pages.read(readOptions())
    const cursor = first.nextCursor as string, started = deferred<void>(), read = deferred<Dirent | null>()
    vi.spyOn(listing.directory, 'read').mockImplementationOnce(() => { started.resolve(); return read.promise })
    const controller = new AbortController()
    const pending = pages.read({ ...readOptions(), cursor, signal: controller.signal })
    const rejection = expect(pending).rejects.toThrow('Stopped')
    await started.promise
    await expect(pages.read({ ...readOptions(), cursor })).rejects.toThrow('already being read')
    controller.abort(new Error('Stopped'))
    read.resolve({ name: 'late' } as Dirent)
    await rejection
    expect(listing.close).toHaveBeenCalledOnce()
    await expect(pages.read({ ...readOptions(), cursor })).rejects.toThrow('expired or was consumed')
  })

  it.each(['expiry', 'run cancellation', 'run completion'])('releases idle handles after %s', async reason => {
    vi.useFakeTimers()
    const listing = largeDirectory(100), controller = new AbortController()
    const first = await pages.read({ ...readOptions(), lifetimeSignal: controller.signal })
    if (reason === 'expiry') await vi.advanceTimersByTimeAsync(5 * 60_000)
    else if (reason === 'run cancellation') controller.abort()
    await pages.closeIdleCursors('run-one')
    expect(listing.close).toHaveBeenCalledOnce()
    await expect(pages.read({ ...readOptions(), cursor: first.nextCursor as string })).rejects.toThrow('expired or was consumed')
  })

  it('bounds live cursors and permits another traversal after closing an old scope', async () => {
    largeDirectory(100)
    for (let i = 0; i < 16; i++) await pages.read({ ...readOptions(), scope: `run-${i}` })
    await expect(pages.read(readOptions())).rejects.toThrow('Too many open')
    await pages.closeIdleCursors('run-0')
    largeDirectory(100)
    expect(await pages.read(readOptions())).toMatchObject({ hasMore: true })
  })

  it('returns resumable partial results when the cooperative page time budget is reached', async () => {
    const listing = largeDirectory(100)
    let now = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    vi.mocked(lstat).mockImplementationOnce(async () => { now += 1500; return rootInfo })
    const first = await pages.read(readOptions())
    expect(first).toMatchObject({ returnedCount: 1, hasMore: true, pageLimitedBy: 'work' })
    expect(listing.readCount()).toBe(0)
    expect(await pages.read({ ...readOptions(), cursor: first.nextCursor as string })).toMatchObject({ returnedCount: 3, hasMore: true })
  })
})
