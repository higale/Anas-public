import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queryGitChanges, readGitContents, queryGitReferences } from './gitChanges'

const { beforeStat, beforeOpen } = vi.hoisted(() => ({ beforeStat: vi.fn(), beforeOpen: vi.fn() }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, lstat: async (...args: unknown[]) => {
    await beforeStat(args[0])
    return Reflect.apply(actual.lstat, actual, args)
  }, open: async (...args: unknown[]) => {
    await beforeOpen(args[0])
    return Reflect.apply(actual.open, actual, args)
  } }
})

const run = promisify(execFile), roots: string[] = []
async function git(root: string, ...args: string[]) {
  const { stdout } = await run('git', args, { cwd: root })
  return stdout.trim()
}
async function repository(committed = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'anas-git-changes-')))
  roots.push(root)
  await git(root, 'init', '-b', 'main')
  await git(root, 'config', 'user.name', 'Test')
  await git(root, 'config', 'user.email', 'test@example.invalid')
  await git(root, 'config', 'core.autocrlf', 'false')
  await writeFile(join(root, 'one.txt'), 'before\n')
  if (committed) { await git(root, 'add', '--', 'one.txt'); await git(root, 'commit', '-m', 'Initial') }
  return root
}
afterEach(async () => {
  beforeStat.mockReset()
  beforeOpen.mockReset()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('read-only Git changes', () => {
  it('separates committed baseline changes from staged, unstaged and untracked working files', async () => {
    const root = await repository(), base = await git(root, 'rev-parse', 'HEAD')
    await writeFile(join(root, 'one.txt'), 'committed\n')
    await git(root, 'commit', '-am', 'Second')
    await writeFile(join(root, 'one.txt'), 'staged\n'); await git(root, 'add', 'one.txt')
    await writeFile(join(root, 'one.txt'), 'working\n')
    await writeFile(join(root, 'new.txt'), 'new\n')
    const indexBefore = await readFile(join(root, '.git', 'index'))
    const workspace = await queryGitChanges({ sourceFolder: root, scope: 'workspace' })
    expect(workspace.files).toHaveLength(2)
    const tracked = workspace.files.find((file) => file.source === 'tracked')!
    expect(tracked.patch).toContain('-committed'); expect(tracked.patch).toContain('+working')
    expect(tracked.patch).not.toContain('staged')
    expect(tracked).toMatchObject({ addedLines: 1, removedLines: 1 })
    const baseline = await queryGitChanges({ sourceFolder: root, scope: 'baseline', baseline: base })
    expect(baseline.baseline).toBe(base)
    expect(baseline.files).toHaveLength(1)
    expect(baseline.files[0].patch).toContain('-before'); expect(baseline.files[0].patch).toContain('+committed')
    expect(baseline.files[0].patch).not.toContain('working')
    expect(await readFile(join(root, '.git', 'index'))).toEqual(indexBefore)
    expect(await readFile(join(root, 'one.txt'), 'utf8')).toBe('working\n')
  })

  it('reads exact HEAD, index and worktree text without reconstructing from patches', async () => {
    const root = await repository(), path = join(root, 'one.txt')
    await writeFile(path, 'staged\n'); await git(root, 'add', 'one.txt')
    await writeFile(path, 'working\r\nwithout final newline')
    for (const [scope, before, after] of [
      ['workspace', 'before\n', 'working\r\nwithout final newline'],
      ['staged', 'before\n', 'staged\n'], ['unstaged', 'staged\n', 'working\r\nwithout final newline']
    ] as const) {
      const list = await queryGitChanges({ sourceFolder: root, scope, includePatch: false })
      expect(list.files[0].patch).toBe('')
      expect(await readGitContents({ projectId: 'test', sourceFolder: root, scope, filePath: path }))
        .toMatchObject({ status: 'ready', before, after, beforeExists: true, afterExists: true })
    }
  })

  it('distinguishes additions, deletions, empty, binary, oversized and non-UTF-8 files', async () => {
    const root = await repository()
    await rm(join(root, 'one.txt'))
    await writeFile(join(root, 'empty.ts'), '')
    await writeFile(join(root, 'binary'), Buffer.from([0, 1]))
    await writeFile(join(root, 'large'), 'x'.repeat(1_000_001))
    await writeFile(join(root, 'encoding'), Buffer.from([0xff, 0xfe]))
    const list = await queryGitChanges({ sourceFolder: root, scope: 'workspace', includePatch: false, limit: 20 })
    const read = (name: string) => readGitContents({ projectId: 'test', sourceFolder: root, scope: 'workspace', filePath: join(root, name), baseline: list.baseline })
    expect(await read('one.txt')).toMatchObject({ status: 'ready', before: 'before\n', after: '', afterExists: false })
    expect(await read('empty.ts')).toMatchObject({ status: 'ready', before: '', after: '', beforeExists: false, afterExists: true })
    expect(await read('binary')).toMatchObject({ status: 'unavailable', reason: 'binary' })
    expect(await read('large')).toMatchObject({ status: 'unavailable', reason: 'too_large' })
    expect(await read('encoding')).toMatchObject({ status: 'unavailable', reason: 'encoding' })
    await expect(readGitContents({ projectId: 'test', sourceFolder: root, scope: 'workspace', filePath: join(root, 'empty.ts') }, AbortSignal.abort())).rejects.toThrow()
    await writeFile(join(root, 'empty.ts'), 'changed')
    await expect(read('empty.ts')).resolves.toMatchObject({ status: 'ready', after: 'changed' })
  })

  it.each(['workspace', 'unstaged', 'staged'] as const)('isolates %s file reads from unrelated working and index changes', async (scope) => {
    const root = await repository(), path = join(root, 'one.txt')
    await writeFile(path, 'selected staged\n'); await git(root, 'add', 'one.txt')
    await writeFile(path, 'selected working\n')
    const list = await queryGitChanges({ sourceFolder: root, scope, includePatch: false })
    await writeFile(join(root, 'other.txt'), 'other staged\n'); await git(root, 'add', 'other.txt')
    beforeStat.mockImplementation(async (candidate: string) => {
      if (candidate === path) {
        await writeFile(join(root, 'other.txt'), 'concurrent unrelated change\n')
        await git(root, 'add', 'other.txt')
      }
    })
    await expect(readGitContents({ projectId: 'test', sourceFolder: root, scope, filePath: path, baseline: list.baseline }))
      .resolves.toMatchObject({ status: 'ready', after: scope === 'staged' ? 'selected staged\n' : 'selected working\n' })
  })

  it('reads a file after its changes have been reverted, without a list refresh', async () => {
    const root = await repository(), path = join(root, 'one.txt')
    await writeFile(path, 'edit\n')
    const list = await queryGitChanges({ sourceFolder: root, scope: 'workspace', includePatch: false })
    await writeFile(path, 'before\n')
    await expect(readGitContents({ projectId: 'test', sourceFolder: root, scope: 'workspace', filePath: path, baseline: list.baseline }))
      .resolves.toMatchObject({ status: 'ready', before: 'before\n', after: 'before\n' })
  })

  it('retries a concurrent file edit and returns stable current text', async () => {
    const root = await repository(), path = join(root, 'one.txt')
    await writeFile(path, 'first\n')
    let reads = 0
    beforeStat.mockImplementation(async (candidate: string) => {
      if (candidate === path && ++reads === 2) await writeFile(path, 'second stable text\n')
    })
    await expect(readGitContents({ projectId: 'test', sourceFolder: root, scope: 'workspace', filePath: path }))
      .resolves.toMatchObject({ status: 'ready', before: 'before\n', after: 'second stable text\n' })
  })

  it('reports a continuously changing file after bounded retries', async () => {
    const root = await repository(), path = join(root, 'one.txt')
    let revision = 0
    beforeStat.mockImplementation(async (candidate: string) => {
      if (candidate === path) await writeFile(path, 'revision ' + ++revision)
    })
    await expect(readGitContents({ projectId: 'test', sourceFolder: root, scope: 'workspace', filePath: path }))
      .resolves.toMatchObject({ status: 'unavailable', reason: 'changing' })
  })

  it('retries an editor replacing the file between stat and open', async () => {
    const root = await repository(), path = join(root, 'one.txt')
    beforeOpen.mockImplementationOnce(async () => {
      await rename(path, join(root, 'old.txt'))
      await writeFile(path, 'atomic replacement\n')
    })
    await expect(readGitContents({ projectId: 'test', sourceFolder: root, scope: 'workspace', filePath: path }))
      .resolves.toMatchObject({ status: 'ready', before: 'before\n', after: 'atomic replacement\n' })
  })

  it('preserves permission failures instead of treating them as concurrent edits', async () => {
    const root = await repository(), path = join(root, 'one.txt')
    beforeOpen.mockRejectedValue(Object.assign(new Error('Access denied'), { code: 'EACCES' }))
    await expect(readGitContents({ projectId: 'test', sourceFolder: root, scope: 'workspace', filePath: path }))
      .rejects.toMatchObject({ code: 'EACCES' })
  })

  it('cancels a changing file read instead of continuing its retries', async () => {
    const root = await repository(), path = join(root, 'one.txt'), controller = new AbortController()
    let reads = 0
    beforeStat.mockImplementation(async (candidate: string) => {
      if (candidate === path && ++reads === 2) {
        await writeFile(path, 'changed during read')
        controller.abort(new Error('Reader closed'))
      }
    })
    await expect(readGitContents({ projectId: 'test', sourceFolder: root, scope: 'workspace', filePath: path }, controller.signal))
      .rejects.toThrow('Reader closed')
  })

  it('keeps the initially resolved baseline while retrying a file edit', async () => {
    const root = await repository(), path = join(root, 'one.txt')
    await git(root, 'branch', 'baseline')
    await writeFile(path, 'second commit\n'); await git(root, 'commit', '-am', 'Second')
    await writeFile(path, 'first edit\n')
    let reads = 0
    beforeStat.mockImplementation(async (candidate: string) => {
      if (candidate === path && ++reads === 2) {
        await git(root, 'branch', '-f', 'baseline', 'HEAD')
        await writeFile(path, 'stable edit\n')
      }
    })
    await expect(readGitContents({ projectId: 'test', sourceFolder: root, scope: 'workspace', filePath: path, baseline: 'baseline' }))
      .resolves.toMatchObject({ status: 'ready', before: 'before\n', after: 'stable edit\n' })
  })

  it('preserves an explicitly empty baseline when an unborn repository gains its first commit', async () => {
    const root = await repository(false), path = join(root, 'one.txt')
    const list = await queryGitChanges({ sourceFolder: root, scope: 'workspace', includePatch: false })
    await git(root, 'add', '.'); await git(root, 'commit', '-m', 'First')
    await expect(readGitContents({ projectId: 'test', sourceFolder: root, scope: 'workspace', filePath: path, baseline: list.baseline }))
      .resolves.toMatchObject({ status: 'ready', before: '', beforeExists: false, after: 'before\n' })
  })

  it('rejects files outside the selected source folder', async () => {
    const root = await repository(), folder = join(root, 'nested')
    await mkdir(folder)
    await expect(readGitContents({ projectId: 'test', sourceFolder: folder, scope: 'workspace', filePath: join(root, 'one.txt') }))
      .rejects.toThrow('outside')
  })

  it('lists grouped refs and validates hashes, while comparisons stay pinned when branches move', async () => {
    const root = await repository(), old = await git(root, 'rev-parse', 'HEAD')
    await git(root, 'branch', 'topic'); await git(root, 'tag', '-a', 'v1', '-m', 'Version one')
    await git(root, 'update-ref', 'refs/remotes/origin/main', old)
    await writeFile(join(root, 'one.txt'), 'next\n'); await git(root, 'commit', '-am', 'Second commit')
    const refs = await queryGitReferences({ projectId: 'test', sourceFolder: root, kind: 'refs' })
    expect(refs.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ value: 'refs/heads/main', group: 'local', current: true }),
      expect.objectContaining({ value: 'refs/remotes/origin/main', group: 'remote' }),
      expect.objectContaining({ value: 'refs/tags/v1', group: 'tag', commit: old })
    ]))
    const history = await queryGitReferences({ projectId: 'test', sourceFolder: root, kind: 'history' })
    expect(history.entries.map((entry) => entry.label)).toEqual(['Second commit', 'Initial'])
    expect((await queryGitReferences({ projectId: 'test', sourceFolder: root, kind: 'resolve', ref: old.slice(0, 8) })).entries[0].commit).toBe(old)
    await expect(queryGitReferences({ projectId: 'test', sourceFolder: root, kind: 'resolve', ref: '--help' })).rejects.toThrow()
    const list = await queryGitChanges({ sourceFolder: root, scope: 'baseline', baseline: old, includePatch: false })
    await git(root, 'branch', '-f', 'topic', 'HEAD')
    const data = await readGitContents({ projectId: 'test', sourceFolder: root, scope: 'baseline', baseline: list.baseline!, head: list.head!, filePath: join(root, 'one.txt') })
    expect(data).toMatchObject({ status: 'ready', before: 'before\n', after: 'next\n' })
  })

  it('returns complete text beyond patch budgets and preserves BOMs and line endings', async () => {
    const root = await repository(), path = join(root, 'one.txt')
    const text = '\uFEFF' + 'full line\r\n'.repeat(6000)
    await writeFile(path, text)
    const list = await queryGitChanges({ sourceFolder: root, scope: 'workspace' })
    expect(list.files[0]).toMatchObject({ patch: '', patchTruncated: true })
    expect(await readGitContents({ projectId: 'test', sourceFolder: root, scope: 'workspace', filePath: path }))
      .toMatchObject({ status: 'ready', before: 'before\n', after: text })
    await git(root, 'add', 'one.txt'); await git(root, 'commit', '-m', 'BOM text')
    await writeFile(path, 'replacement')
    const next = await queryGitChanges({ sourceFolder: root, scope: 'workspace', includePatch: false })
    expect(await readGitContents({ projectId: 'test', sourceFolder: root, scope: 'workspace', filePath: path, baseline: next.baseline }))
      .toMatchObject({ status: 'ready', before: text, after: 'replacement' })
  })

  it('paginates commit history from an immutable head', async () => {
    const root = await repository(), tree = await git(root, 'rev-parse', 'HEAD^{tree}')
    let head = await git(root, 'rev-parse', 'HEAD')
    for (let i = 0; i < 31; i++) head = await git(root, 'commit-tree', tree, '-p', head, '-m', `Commit ${i}`)
    await git(root, 'update-ref', 'HEAD', head)
    const first = await queryGitReferences({ projectId: 'test', sourceFolder: root, kind: 'history' })
    expect(first.entries).toHaveLength(30); expect(first.hasMore).toBe(true)
    await git(root, 'update-ref', 'HEAD', await git(root, 'commit-tree', tree, '-p', head, '-m', 'Later'))
    const second = await queryGitReferences({ projectId: 'test', sourceFolder: root, kind: 'history', ref: first.historyHead, after: 30 })
    expect(second.entries.map((entry) => entry.label)).toEqual(['Commit 0', 'Initial'])
    expect(second.hasMore).toBe(false)
    expect(new Set([...first.entries, ...second.entries].map((entry) => entry.commit)).size).toBe(32)
  })

  it('compares a currently untracked file to its historical content instead of inventing an addition', async () => {
    const root = await repository(), baseline = await git(root, 'rev-parse', 'HEAD'), path = join(root, 'one.txt')
    await git(root, 'rm', 'one.txt'); await git(root, 'commit', '-m', 'Remove tracked file')
    await writeFile(path, 'recreated\n')
    const list = await queryGitChanges({ sourceFolder: root, scope: 'workspace', baseline })
    expect(list.files[0]).toMatchObject({ status: 'M' })
    expect(list.files[0].patch).toContain('-before')
    expect(list.files[0].patch).toContain('+recreated')
    expect(await readGitContents({ projectId: 'test', sourceFolder: root, scope: 'workspace', baseline, filePath: path }))
      .toMatchObject({ status: 'ready', before: 'before\n', after: 'recreated\n', beforeExists: true })
  })

  it('supports unborn branches without manufacturing a commit or writing the index', async () => {
    const root = await repository(false)
    await git(root, 'add', 'one.txt')
    await writeFile(join(root, 'empty'), '')
    const value = await queryGitChanges({ sourceFolder: root, scope: 'workspace' })
    expect(value.head).toBeNull(); expect(value.baseline).toBeNull()
    expect(value.files).toHaveLength(2)
    expect(value.files.find((file) => file.relativePath === 'empty')?.patch).toContain('new file mode')
    await expect(git(root, 'rev-parse', '--verify', 'HEAD')).rejects.toThrow()
  })

  it('keeps an explicitly selected subdirectory narrow and preserves literal unusual paths', async () => {
    const root = await repository(), folder = join(root, 'sub [x]')
    await mkdir(folder)
    // Windows forbids control characters in filenames; retain literal path
    // coverage there while also exercising tabs/newlines on POSIX.
    const name = process.platform === 'win32' ? '中文 [name] $.txt' : '中文 \tname\n.txt'
    await writeFile(join(folder, name), 'hello\n')
    await writeFile(join(root, 'outside.txt'), 'outside')
    const value = await queryGitChanges({ sourceFolder: folder, scope: 'workspace' })
    expect(value.repositoryRoot).toBe(root)
    expect(value.files.map((file) => file.path)).toEqual([join(folder, name)])
    expect(value.files[0].patch).toContain('+hello')
  })

  it('rejects a stale page even when a working edit has the same byte and line counts', async () => {
    const root = await repository()
    await writeFile(join(root, 'one.txt'), 'aaaaaa\n')
    await writeFile(join(root, 'two.txt'), 'two\n')
    const first = await queryGitChanges({ sourceFolder: root, scope: 'workspace', limit: 1 })
    const next = await queryGitChanges({ sourceFolder: root, scope: 'workspace', limit: 1, after: first.nextAfter, version: first.version })
    expect(next.files).toHaveLength(1)
    expect(next.files[0].path).not.toBe(first.files[0].path)
    await writeFile(join(root, 'one.txt'), 'bbbbbb\n')
    await expect(queryGitChanges({ sourceFolder: root, scope: 'workspace', after: first.nextAfter, version: first.version })).rejects.toThrow('Refresh')
  })

  it('does not let ambient Git environment redirect the selected worktree', async () => {
    const root = await repository(), other = await repository()
    await writeFile(join(root, 'one.txt'), 'selected\n')
    await writeFile(join(other, 'one.txt'), 'unrelated\n')
    vi.stubEnv('GIT_DIR', join(other, '.git')); vi.stubEnv('GIT_WORK_TREE', other)
    const value = await queryGitChanges({ sourceFolder: root, scope: 'workspace' })
    expect(value.repositoryRoot).toBe(root)
    expect(value.files[0].patch).toContain('+selected')
    expect(value.files[0].patch).not.toContain('unrelated')
  })

  it('reports binary and oversized untracked files without treating them as empty', async () => {
    const root = await repository()
    await writeFile(join(root, 'binary'), Buffer.from([0, 1, 2]))
    await writeFile(join(root, 'large'), 'x'.repeat(1_000_001))
    const value = await queryGitChanges({ sourceFolder: root, scope: 'workspace' })
    expect(value.files).toHaveLength(2)
    expect(value.files.every((file) => file.unavailableReason && !file.patch)).toBe(true)
  })

  it.runIf(process.platform !== 'win32')('shows a new symlink itself, not its target contents', async () => {
    const root = await repository()
    await symlink('one.txt', join(root, 'link'))
    const value = await queryGitChanges({ sourceFolder: root, scope: 'workspace' })
    expect(value.files[0].patch).toContain('new file mode 120000')
    expect(value.files[0].patch).toContain('+one.txt')
    expect(value.files[0].patch).not.toContain('before')
  })

  it('requires an explicit existing baseline and handles non-Git folders and cancellation', async () => {
    const root = await repository()
    await expect(queryGitChanges({ sourceFolder: root, scope: 'baseline' })).rejects.toThrow('Invalid')
    await expect(queryGitChanges({ sourceFolder: root, scope: 'baseline', baseline: 'missing' })).rejects.toThrow()
    await expect(queryGitChanges({ sourceFolder: root, scope: 'baseline', baseline: '--help' })).rejects.toThrow()
    const plain = await realpath(await mkdtemp(join(tmpdir(), 'anas-not-git-'))); roots.push(plain)
    await expect(queryGitChanges({ sourceFolder: plain, scope: 'workspace' })).rejects.toMatchObject({ code: 'not_repository' })
    await expect(queryGitReferences({ projectId: 'project', sourceFolder: plain, kind: 'refs' })).rejects.toMatchObject({ code: 'not_repository' })
    await expect(queryGitChanges({ sourceFolder: root, scope: 'workspace' }, AbortSignal.abort())).rejects.toThrow()
  })

  it('distinguishes a bare repository from a missing or damaged source folder', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'anas-bare-git-'))); roots.push(root)
    await git(root, 'init', '--bare')
    await expect(queryGitReferences({ projectId: 'project', sourceFolder: root, kind: 'refs' })).rejects.toMatchObject({ code: 'not_repository' })
    await expect(queryGitReferences({ projectId: 'project', sourceFolder: join(root, 'missing'), kind: 'refs' })).rejects.not.toMatchObject({ code: 'not_repository' })
  })

  it('limits simultaneous reads and releases capacity after completion', async () => {
    const root = await repository()
    const input = { sourceFolder: root, scope: 'workspace' as const }
    const first = queryGitChanges(input), second = queryGitChanges(input)
    await expect(queryGitChanges(input)).rejects.toThrow('busy')
    await Promise.all([first, second])
    expect((await queryGitChanges(input)).files).toEqual([])
  })

  it('rejects changes that happen between the metadata observation and patch verification', async () => {
    const root = await repository(), path = join(root, 'one.txt')
    await writeFile(path, 'first\n')
    let reads = 0
    beforeStat.mockImplementation(async (candidate: string) => {
      if (candidate === path && ++reads === 2) await writeFile(path, 'second\n')
    })
    await expect(queryGitChanges({ sourceFolder: root, scope: 'workspace' })).rejects.toThrow('changed during the read')
  })

  it('does not silently follow a baseline branch that moves during a comparison', async () => {
    const root = await repository()
    await git(root, 'branch', 'baseline')
    await writeFile(join(root, 'one.txt'), 'next\n'); await git(root, 'commit', '-am', 'Next')
    let moved = false
    beforeStat.mockImplementation(async (candidate: string) => {
      if (candidate === root && !moved) { moved = true; await git(root, 'branch', '-f', 'baseline', 'HEAD') }
    })
    await expect(queryGitChanges({ sourceFolder: root, scope: 'baseline', baseline: 'baseline' })).rejects.toThrow('changed during the read')
  })

  it('keeps an unborn orphan branch valid even when other branches have commits', async () => {
    const root = await repository()
    await git(root, 'checkout', '--orphan', 'fresh')
    const result = await queryGitChanges({ sourceFolder: root, scope: 'workspace' })
    expect(result.head).toBeNull()
    expect(result.files[0].patch).toContain('+before')
  })

  it('reports tracked deletion when a parent directory becomes a regular file', async () => {
    const root = await repository()
    await mkdir(join(root, 'dir')); await writeFile(join(root, 'dir', 'file'), 'inside\n')
    await git(root, 'add', 'dir'); await git(root, 'commit', '-m', 'Directory')
    await rm(join(root, 'dir'), { recursive: true }); await writeFile(join(root, 'dir'), 'replacement\n')
    const result = await queryGitChanges({ sourceFolder: root, scope: 'workspace' })
    expect(result.files.find((file) => file.relativePath === 'dir/file')).toMatchObject({ status: 'D' })
    expect(result.files.find((file) => file.relativePath === 'dir/file')?.patch).toContain('-inside')
    expect(result.files.find((file) => file.relativePath === 'dir')?.patch).toContain('+replacement')
    expect(await readGitContents({ projectId: 'test', sourceFolder: root, scope: 'workspace', filePath: join(root, 'dir') }))
      .toMatchObject({ status: 'ready', beforeExists: false, after: 'replacement\n' })
  })
})
