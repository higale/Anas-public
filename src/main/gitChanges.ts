import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { parsePatch } from 'diff'
import type { GitContentInput, GitReferenceQuery, GitReferenceResult, GitReference, GitChangeFile, GitChangeQuery, GitChangeResult } from '@shared/gitChanges'
import { DIFF_MAX_BYTES, type DiffContents } from '@shared/diffContents'
import { createTextPatch } from './fileEditDiff'
import { GitReadError } from '@shared/gitChanges'
import { fingerprint, workingText, UnavailableText, FileTextChanged } from './diffFileReader'

const limits = { files: 1000, output: 4 * 1024 * 1024, patchChars: 40_000, durationMs: 30_000 }
const oidPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
interface Entry { path: string; relativePath: string; status: string; source: 'tracked' | 'untracked'; mode?: string }
interface Observation { root: string; folder: string; head: string | null; baseline: string | null; entries: Entry[]; version: string; targetIdentity: string }
type ObservationInput = Omit<GitChangeQuery, 'baseline' | 'head'> & { baseline?: string | null; head?: string | null }

function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }

/** Invoke Git directly, never through a shell, pager, textconv or external diff. */
async function git(folder: string, args: string[], signal: AbortSignal): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  return new Promise((resolveResult, reject) => {
    execFile('git', ['--no-pager', '--literal-pathspecs', '-c', 'core.quotePath=false', '-c', 'core.fsmonitor=false', ...args], {
      cwd: folder, env: { ...env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      encoding: 'buffer', maxBuffer: limits.output, timeout: 10_000, killSignal: 'SIGKILL', windowsHide: true, signal
    }, (error, stdout, stderr) => {
      if (error) {
        const message = `Git ${args[0]} failed: ${String(stderr).slice(0, 2000) || error.message}`
        // Only repository discovery can report an ordinary non-worktree directory.
        const notRepository = args[0] === 'rev-parse' && args.includes('--show-toplevel') && error.code === 128
          && /fatal: (?:not a git repository|this operation must be run in a work tree)/.test(String(stderr))
        reject(notRepository ? new GitReadError('not_repository', message, { cause: error }) : new Error(message, { cause: error }))
        return
      }
      try { resolveResult(utf8.decode(stdout)) } catch { reject(new Error('Git output contains unsupported non-UTF-8 paths or text.')) }
    })
  })
}

function line(value: string): string { return value.replace(/\r?\n$/, '') }
async function commit(folder: string, ref: string, signal: AbortSignal): Promise<string> {
  if (!ref || ref.length > 1024 || ref.includes('\0')) throw new Error('An explicit commit or branch baseline is required.')
  const oid = line(await git(folder, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], signal))
  if (!oidPattern.test(oid)) throw new Error('Git did not resolve an exact commit.')
  return oid
}

function nulEntries(value: string, maximum = limits.files): string[] {
  if (value && !value.endsWith('\0')) throw new Error('Git path listing is incomplete.')
  const fields = value ? value.slice(0, -1).split('\0') : []
  if (fields.length > maximum) throw new Error(`Git changes exceed ${limits.files} files; select a narrower source folder.`)
  return fields
}

function pathInRoot(root: string, name: string): string {
  if (!name || isAbsolute(name) || name.includes('\0')) throw new Error('Git returned an invalid relative path.')
  const path = resolve(root, name), suffix = relative(root, path)
  if (!suffix || suffix === '..' || suffix.startsWith(`..${sep}`) || isAbsolute(suffix)) throw new Error('Git path is outside its repository.')
  return path
}

async function observe(input: ObservationInput, signal: AbortSignal, filePath?: string): Promise<Observation> {
  signal.throwIfAborted()
  const folder = await realpath(input.sourceFolder)
  const root = await realpath(line(await git(folder, ['rev-parse', '--show-toplevel'], signal)))
  const scopePath = relative(root, folder)
  if (scopePath === '..' || scopePath.startsWith(`..${sep}`) || isAbsolute(scopePath)) throw new Error('Selected folder is outside the Git worktree.')
  let filter = scopePath || '.'
  if (filePath !== undefined) {
    if (!isAbsolute(filePath)) throw new Error('An absolute Git file path is required.')
    pathInRoot(folder, relative(folder, filePath))
    filter = relative(root, filePath).split(sep).join('/')
  }
  // A missing HEAD is valid only for an unborn branch; invalid repositories
  // and detached references remain errors instead of becoming empty history.
  let head: string | null
  try { head = input.head !== undefined ? input.head : await commit(root, 'HEAD', signal) } catch (error) {
    const reference = line(await git(root, ['symbolic-ref', '-q', 'HEAD'], signal))
    const exists = await git(root, ['show-ref', '--verify', '--quiet', reference], signal).then(() => true).catch((reason: unknown) => {
      const cause = reason instanceof Error ? reason.cause : undefined
      if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 1) return false
      throw reason
    })
    if (exists || input.scope === 'baseline') throw error
    head = null
  }
  if (input.head) head = await commit(root, input.head, signal)
  const baseline = input.scope === 'unstaged' || input.baseline === null ? null : input.baseline && input.baseline !== 'HEAD'
    ? await commit(root, input.baseline, signal) : head
  const entries: Entry[] = []
  let evidence: string
  if (baseline === null && input.scope !== 'unstaged') {
    evidence = await git(root, ['ls-files', '--cached', '-z', '--', filter], signal)
    for (const name of nulEntries(evidence)) {
      signal.throwIfAborted()
      const path = pathInRoot(root, name)
      if (input.scope === 'staged' || await fingerprint(path) !== null) entries.push({ path, relativePath: name, status: 'A', source: 'tracked' })
    }
  } else {
    // NUL delimiters preserve whitespace, tabs and newlines in paths.
    evidence = await git(root, ['diff', '--raw', '-z', '--no-abbrev', '--no-renames', '--no-ext-diff', '--no-textconv', '--ignore-submodules=none',
      ...(input.scope === 'staged' ? ['--cached'] : []),
      ...(input.scope === 'unstaged' ? [] : [baseline!]), ...(input.scope === 'baseline' ? [head!] : []), '--', filter], signal)
    const fields = nulEntries(evidence, limits.files * 2)
    if (fields.length % 2) throw new Error('Git raw change listing is incomplete.')
    for (let index = 0; index < fields.length; index += 2) {
      const match = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([A-Z])$/.exec(fields[index])
      if (!match || !oidPattern.test(match[3]) || !oidPattern.test(match[4])) throw new Error('Git returned unsupported change metadata.')
      const name = fields[index + 1]
      entries.push({ path: pathInRoot(root, name), relativePath: name, status: match[5], source: 'tracked', mode: match[2] })
    }
  }
  if (input.scope === 'workspace' || input.scope === 'unstaged') {
    const untracked = await git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', filter], signal)
    evidence += untracked
    for (const name of nulEntries(untracked)) entries.push({ path: pathInRoot(root, name), relativePath: name, status: 'A', source: 'untracked' })
  }
  const unique = new Map<string, Entry>()
  for (const entry of entries) {
    const previous = unique.get(entry.relativePath)
    if (previous?.status !== 'U') unique.set(entry.relativePath, entry.source === 'untracked' && previous?.status === 'D' ? { ...entry, status: 'M' } : entry)
  }
  if (unique.size > limits.files) throw new Error(`Git changes exceed ${limits.files} files; select a narrower source folder.`)
  const sorted = [...unique.values()].sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0)
  const identities: unknown[] = []
  if (input.scope !== 'baseline') {
    if (filePath !== undefined) {
      identities.push(await git(root, ['ls-files', '--stage', '-z', '--', filter], signal))
      if (input.scope !== 'staged') identities.push(await fingerprint(filePath))
    } else {
      const indexPath = line(await git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], signal))
      identities.push(await fingerprint(indexPath))
      for (let index = 0; input.scope !== 'staged' && index < sorted.length; index += 32) {
        signal.throwIfAborted()
        identities.push(...await Promise.all(sorted.slice(index, index + 32).map((entry) => fingerprint(entry.path))))
      }
    }
  }
  const rootInfo = await lstat(root, { bigint: true })
  const folderInfo = await lstat(folder, { bigint: true })
  const targetIdentity = hash([root, folder, String(rootInfo.dev), String(rootInfo.ino), String(folderInfo.dev), String(folderInfo.ino)])
  return { root, folder, head, baseline, entries: sorted, targetIdentity,
    version: hash([targetIdentity, input.scope, head, baseline, evidence, identities]) }
}

async function newFilePatch(entry: Entry, observation: Observation, scope: GitChangeQuery['scope'], signal: AbortSignal): Promise<GitChangeFile> {
  const output: GitChangeFile = { ...entry, patch: '', patchTruncated: false }
  try {
    const before = await revisionText(observation.root, entry.relativePath, scope === 'unstaged' ? 'index' : observation.baseline, signal)
    const after = await workingText(entry.path, signal)
    const patch = createTextPatch({ path: entry.path, baseDirectory: observation.root, beforeText: before.text,
      afterText: after.text, beforeExists: before.exists, afterExists: after.exists, maxChars: limits.patchChars })
    const info = await lstat(entry.path)
    const mode = info.isSymbolicLink() ? '120000' : info.mode & 0o111 ? '100755' : '100644'
    return { ...output, patch: patch.patch.replace('new file mode 100644', `new file mode ${mode}`), patchTruncated: patch.patchTruncated,
      addedLines: patch.addedLines, removedLines: patch.removedLines, unavailableReason: patch.patchUnavailableReason }
  } catch (error) {
    if (!(error instanceof UnavailableText)) throw error
    return { ...output, unavailableReason: error.reason }
  }
}

async function filePatch(entry: Entry, observation: Observation, scope: GitChangeQuery['scope'], signal: AbortSignal): Promise<GitChangeFile> {
  if (entry.status === 'U') return { ...entry, patch: '', patchTruncated: false, unavailableReason: 'Unmerged file; resolve the conflict before requesting a coherent diff.' }
  if (entry.source === 'untracked' || (observation.baseline === null && scope === 'workspace')) return newFilePatch(entry, observation, scope, signal)
  const patch = await git(observation.root, ['diff', '--patch', '--no-color', '--no-renames', '--no-ext-diff', '--no-textconv', '--submodule=short', '--ignore-submodules=none',
    ...(scope === 'staged' ? ['--cached'] : []),
    ...(scope === 'unstaged' || observation.baseline === null ? [] : [observation.baseline]), ...(scope === 'baseline' ? [observation.head!] : []), '--', entry.relativePath], signal)
  const hunks = parsePatch(patch).flatMap((item) => item.hunks)
  const truncated = patch.length > limits.patchChars
  return { ...entry, patch: truncated ? '' : patch, patchTruncated: truncated,
    ...(hunks.length ? { addedLines: hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith('+')).length, 0),
      removedLines: hunks.reduce((sum, hunk) => sum + hunk.lines.filter((line) => line.startsWith('-')).length, 0) } : {}) }
}

let activeReads = 0
export async function queryGitChanges(input: GitChangeQuery, signal?: AbortSignal): Promise<GitChangeResult> {
  const after = input.after ?? 0, limit = input.limit ?? 5
  if (!isAbsolute(input.sourceFolder) || !['workspace', 'baseline', 'staged', 'unstaged'].includes(input.scope)
    || !Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 20
    || (input.scope === 'baseline' && !input.baseline)) throw new Error('Invalid Git change scope or paging parameters.')
  if (activeReads >= 2) throw new Error('Git change reads are busy. Try again after the current read finishes.')
  activeReads++
  try {
    const boundedSignal = AbortSignal.any([AbortSignal.timeout(limits.durationMs), ...(signal ? [signal] : [])])
    const before = await observe(input, boundedSignal)
    if (input.version && input.version !== before.version) throw new GitReadError('stale', 'Git changes changed. Refresh before continuing.')
    const selected = input.filePath ? before.entries.filter((entry) => entry.path === input.filePath) : before.entries
    if (input.filePath && selected.length === 0) throw new Error('The selected file is not part of this Git change scope.')
    const files: GitChangeFile[] = []
    for (const entry of selected.slice(after, after + limit)) {
      boundedSignal.throwIfAborted()
      try { files.push(input.includePatch === false ? { ...entry, patch: '', patchTruncated: false } : await filePatch(entry, before, input.scope, boundedSignal)) }
      catch (error) {
        boundedSignal.throwIfAborted()
        files.push({ ...entry, patch: '', patchTruncated: false, unavailableReason: error instanceof Error ? error.message : String(error) })
      }
    }
    const verified = await observe(input, boundedSignal)
    if (verified.version !== before.version) throw new GitReadError('stale', 'Git targets changed during the read. Refresh and try again.')
    const hasMore = after + files.length < selected.length
    return { scope: input.scope, sourceFolder: before.folder, repositoryRoot: before.root, head: before.head, baseline: before.baseline,
      baselineLabel: input.baseline, version: before.version, fileCount: selected.length, files, hasMore,
      ...(hasMore ? { nextAfter: after + files.length } : {}) }
  } finally { activeReads-- }
}

async function blobText(root: string, oid: string, signal: AbortSignal): Promise<string> {
  if (!oidPattern.test(oid)) throw new Error('Invalid Git blob identity.')
  const size = Number(line(await git(root, ['cat-file', '-s', oid], signal)))
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid Git blob size.')
  if (size > DIFF_MAX_BYTES) throw new UnavailableText('too_large')
  // The blob is immutable; Git output is bounded independently of the size probe.
  try {
    const text = await git(root, ['cat-file', 'blob', oid], signal)
    if (text.includes('\0')) throw new UnavailableText('binary')
    return text
  } catch (error) {
    if (error instanceof Error && error.message.includes('non-UTF-8')) throw new UnavailableText('encoding')
    throw error
  }
}
async function revisionText(root: string, name: string, revision: string | null, signal: AbortSignal): Promise<{ text: string; exists: boolean }> {
  if (revision === null) return { text: '', exists: false }
  const fields = revision === 'index'
    ? nulEntries(await git(root, ['ls-files', '--stage', '-z', '--', name], signal))
    : nulEntries(await git(root, ['ls-tree', '-z', revision, '--', name], signal))
  const record = fields.find((field) => field.slice(field.indexOf('\t') + 1) === name)
  if (!record) return { text: '', exists: false }
  const metadata = record.slice(0, record.indexOf('\t')).split(' ')
  const mode = metadata[0], oid = revision === 'index' ? metadata[1] : metadata[2]
  if (revision === 'index' && metadata[2] !== '0') throw new UnavailableText('conflict')
  if (mode === '040000') return { text: '', exists: false }
  if (!['100644', '100755', '120000'].includes(mode)) throw new UnavailableText('unsupported')
  return { text: await blobText(root, oid, signal), exists: true }
}
/** Read current file content with pinned commits and at most two retries for concurrent edits. */
export async function readGitContents(input: GitContentInput, signal?: AbortSignal): Promise<DiffContents> {
  const bounded = AbortSignal.any([AbortSignal.timeout(limits.durationMs), ...(signal ? [signal] : [])])
  let observation = await observe(input, bounded, input.filePath)
  const pinned = { ...input, baseline: observation.baseline, head: observation.head }
  const path = resolve(input.filePath)
  const name = relative(observation.root, path).split(sep).join('/')
  for (let attempt = 0; attempt < 3; attempt++) {
    bounded.throwIfAborted()
    let result: DiffContents | undefined
    try {
      if (observation.entries.some((entry) => entry.path === path && entry.status === 'U')) throw new UnavailableText('conflict')
      const before = await revisionText(observation.root, name, input.scope === 'unstaged' ? 'index' : observation.baseline, bounded)
      const after = input.scope === 'baseline'
        ? await revisionText(observation.root, name, observation.head, bounded)
        : input.scope === 'staged' ? await revisionText(observation.root, name, 'index', bounded)
          : await workingText(path, bounded)
      result = { status: 'ready', path, before: before.text, after: after.text, beforeExists: before.exists, afterExists: after.exists }
    } catch (error) {
      bounded.throwIfAborted()
      if (error instanceof UnavailableText) result = { status: 'unavailable', path, reason: error.reason }
      else if (!(error instanceof FileTextChanged)) throw error
    }
    const verified = await observe(pinned, bounded, path)
    bounded.throwIfAborted()
    if (verified.targetIdentity !== observation.targetIdentity) throw new Error('Git repository or source folder changed during the read.')
    if (result && verified.version === observation.version) return result
    observation = verified
  }
  return { status: 'unavailable', path, reason: 'changing' }
}

export async function queryGitReferences(input: GitReferenceQuery, signal?: AbortSignal): Promise<GitReferenceResult> {
  const bounded = AbortSignal.any([AbortSignal.timeout(limits.durationMs), ...(signal ? [signal] : [])])
  const root = await realpath(line(await git(input.sourceFolder, ['rev-parse', '--show-toplevel'], bounded)))
  const base = { repositoryRoot: root, entries: [] as GitReference[], hasMore: false }
  if (input.kind === 'resolve') {
    if (!input.ref || !/^[a-fA-F0-9]{7,64}$/.test(input.ref)) throw new Error('Paste a commit hash with at least 7 hexadecimal characters.')
    const oid = await commit(root, input.ref, bounded)
    const label = line(await git(root, ['show', '-s', '--format=%s', oid], bounded)).slice(0, 500)
    return { ...base, entries: [{ value: oid, commit: oid, label, group: 'history' }] }
  }
  if (input.kind === 'history') {
    const after = input.after ?? 0
    if (!Number.isSafeInteger(after) || after < 0 || after > 10000) throw new Error('Commit history page exceeds its bounds.')
    const head = await commit(root, input.ref ?? 'HEAD', bounded)
    const rows = (await git(root, ['log', '--format=%H%x00%s', '-z', '--max-count=31', `--skip=${after}`, head, '--'], bounded)).split('\0')
    if (rows.at(-1) === '') rows.pop()
    if (rows.length % 2) throw new Error('Incomplete Git history.')
    const entries: GitReference[] = []
    for (let i = 0; i < rows.length; i += 2) entries.push({ value: rows[i], commit: rows[i], label: rows[i + 1].slice(0, 500), group: 'history' })
    return { ...base, entries: entries.slice(0, 30), hasMore: entries.length > 30, historyHead: head }
  }
  const current = await git(root, ['symbolic-ref', '-q', 'HEAD'], bounded).then(line).catch(() => '')
  const refs = (await git(root, ['for-each-ref', '--count=1001', '--format=%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(symref)', 'refs/heads', 'refs/remotes', 'refs/tags'], bounded)).trimEnd().split('\n').filter(Boolean)
  if (refs.length > 1000) throw new Error('Repository has more than 1000 references; narrow the repository references.')
  const entries: GitReference[] = []
  // An unborn repository has no resolvable HEAD and may still contain staged files.
  let head: string | undefined
  try { head = await commit(root, 'HEAD', bounded) } catch (error) {
    if (!current || refs.some((row) => row.startsWith(`${current}\0`))) throw error
  }
  if (head) entries.push({ value: 'HEAD', commit: head, label: 'HEAD', group: 'head' })
  for (const row of refs) {
    const [ref, oid, type, peeled, peeledType, symbolic] = row.split('\0')
    if (symbolic || (type !== 'commit' && peeledType !== 'commit')) continue
    const group = ref.startsWith('refs/heads/') ? 'local' : ref.startsWith('refs/remotes/') ? 'remote' : 'tag'
    entries.push({ value: ref, commit: type === 'commit' ? oid : peeled, label: ref.replace(/^refs\/(heads|remotes|tags)\//, ''), group, current: ref === current })
  }
  bounded.throwIfAborted()
  return { ...base, entries }
}
