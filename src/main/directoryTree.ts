import { randomUUID } from 'node:crypto'
import type { Dir, Stats } from 'node:fs'
import { lstat, opendir, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { samePath } from './pathContainment'
import { runtimeLog } from './runtimeLogger'

const maximumSessions = 16
const cursorLifetimeMs = 5 * 60_000
const maximumPendingDirectories = 1024
const maximumPendingPathBytes = 1024 * 1024
const maximumPageBytes = 1024 * 1024
const maximumPageSteps = 2000
const pageTimeMs = 1000
export const maximumTreeDepth = 64

interface DirectoryTarget { path: string; depth: number; dev: number; ino: number }
interface TreeEntry {
  relativePath: string
  type: 'directory' | 'file' | 'symlink' | 'other' | 'unavailable'
  depth: number
  size?: number
  errorCode?: string
  childrenOmitted?: 'depth_limit' | 'directory_queue_limit'
}
interface TreeError { relativePath: string; errorCode: string }
interface TreeSession {
  cursor: string
  root: string
  canonicalRoot: string
  scope: string
  depthLimit: number
  rootInfo?: Stats
  started: boolean
  pending: DirectoryTarget[]
  pendingPathBytes: number
  active?: { target: DirectoryTarget; directory: Dir }
  buffered?: TreeEntry
  busy: boolean
  closed: boolean
  closing?: Promise<void>
  depthTruncated: boolean
  queueTruncated: boolean
  accessTruncated: boolean
  timer?: NodeJS.Timeout
  lifetimeSignal?: AbortSignal
  onAbort?: () => void
}
interface PageBudget { remaining: number; until: number; omittedErrors: number }
class PageBudgetReached extends Error {}
class DirectoryChanged extends Error {
  constructor(path: string) {
    super(`Directory tree ${path === '.' ? 'root' : `directory "${path}"`} changed; start again without cursor.`)
  }
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN'
}

/** Incremental breadth-first enumeration. Only one directory handle is open per
 * cursor; both the retained frontier and the number of idle cursors are bounded.
 * Cursors are transient product resources, not conversation/checkpoint state. */
export class DirectoryTreePages {
  private readonly sessions = new Map<string, TreeSession>()

  async read(options: {
    root: string; scope: string; entryLimit: number; depthLimit?: number; cursor?: string
    signal?: AbortSignal; lifetimeSignal?: AbortSignal
  }): Promise<Record<string, unknown>> {
    options.signal?.throwIfAborted()
    options.lifetimeSignal?.throwIfAborted()
    if (!Number.isSafeInteger(options.entryLimit) || options.entryLimit < 1 || options.entryLimit > 1000) throw new Error('Invalid directory tree page size.')
    if (options.depthLimit !== undefined && (!Number.isSafeInteger(options.depthLimit) || options.depthLimit < 0 || options.depthLimit > maximumTreeDepth)) throw new Error('Invalid directory tree depth.')
    let session: TreeSession
    if (options.cursor) {
      const existing = this.sessions.get(options.cursor)
      if (!existing || existing.closed) throw new Error('Directory tree cursor expired or was consumed. Start again without cursor.')
      if (existing.scope !== options.scope || !samePath(existing.root, options.root)) throw new Error('Directory tree cursor belongs to a different run or path.')
      if (options.depthLimit !== undefined && options.depthLimit !== existing.depthLimit) throw new Error('Keep the same max_depth when continuing a directory tree.')
      if (existing.busy) throw new Error('This directory tree page is already being read. Wait for its result before continuing.')
      session = existing
    } else {
      if (this.sessions.size >= maximumSessions) throw new Error('Too many open directory trees. Finish an existing tree; idle cursors expire after 5 minutes.')
      session = {
        cursor: randomUUID(), root: options.root, canonicalRoot: options.root, scope: options.scope,
        depthLimit: options.depthLimit ?? maximumTreeDepth, started: false,
        pending: [], pendingPathBytes: 0, busy: false, closed: false,
        depthTruncated: false, queueTruncated: false, accessTruncated: false,
        lifetimeSignal: options.lifetimeSignal
      }
      this.sessions.set(session.cursor, session)
      session.onAbort = () => {
        if (!session.busy) this.closeIdle(session)
      }
      session.lifetimeSignal?.addEventListener('abort', session.onAbort, { once: true })
    }
    session.busy = true
    clearTimeout(session.timer)
    const signals = [options.signal, session.lifetimeSignal].filter((signal): signal is AbortSignal => Boolean(signal))
    const signal = AbortSignal.any(signals)
    const budget = { remaining: maximumPageSteps, until: Date.now() + pageTimeMs, omittedErrors: 0 }
    const entries: TreeEntry[] = [], errors: TreeError[] = []
    let bytes = 0, pageLimitedBy: 'entries' | 'bytes' | 'work' | undefined
    try {
      signal.throwIfAborted()
      if (session.rootInfo) {
        await this.verifyDirectory(session, { path: session.root, dev: session.rootInfo.dev, ino: session.rootInfo.ino }, signal)
      }
      if (session.active && session.active.target.depth > 0) await this.verifyDirectory(session, session.active.target, signal)
      while (entries.length < options.entryLimit) {
        const entry = session.buffered ?? await this.next(session, budget, errors, signal)
        if (!entry) break
        const size = Buffer.byteLength(JSON.stringify(entry))
        if (entries.length && bytes + size > maximumPageBytes) {
          session.buffered = entry
          pageLimitedBy = 'bytes'
          break
        }
        session.buffered = undefined
        entries.push(entry)
        bytes += size
      }
      // One-entry lookahead avoids promising another page after the last item.
      // It shares the same work budget and never lists an entire directory.
      if (!session.buffered) session.buffered = await this.next(session, budget, errors, signal)
      if (session.buffered && !pageLimitedBy) pageLimitedBy = 'entries'
    } catch (error) {
      if (error instanceof PageBudgetReached) pageLimitedBy = 'work'
      else { await this.close(session); throw error }
    }
    try {
      signal.throwIfAborted()
      if (session.active) await this.verifyDirectory(session, session.active.target, signal)
      const hasMore = Boolean(session.buffered || !session.started || session.active || session.pending.length)
      const result: Record<string, unknown> = {
        entries, returnedCount: entries.length, entryLimit: options.entryLimit, depthLimit: session.depthLimit,
        truncated: hasMore || session.depthTruncated || session.queueTruncated || session.accessTruncated,
        hasMore, depthTruncated: session.depthTruncated, queueTruncated: session.queueTruncated,
        accessTruncated: session.accessTruncated,
        ...(errors.length ? { errors } : {}), ...(budget.omittedErrors ? { omittedErrors: budget.omittedErrors } : {}),
        ...(pageLimitedBy && hasMore ? { pageLimitedBy } : {})
      }
      if (hasMore) {
        this.sessions.delete(session.cursor)
        session.cursor = randomUUID()
        this.sessions.set(session.cursor, session)
        result.nextCursor = session.cursor
        result.cursorExpiresInSeconds = cursorLifetimeMs / 1000
        session.busy = false
        session.timer = setTimeout(() => this.closeIdle(session), cursorLifetimeMs)
        session.timer.unref()
      } else await this.close(session)
      return result
    } catch (error) { await this.close(session); throw error }
  }

  private async verifyDirectory(session: TreeSession, target: Pick<DirectoryTarget, 'path' | 'dev' | 'ino'>, signal: AbortSignal): Promise<void> {
    // Revalidate at page/open/close boundaries, not for every child. Checking the
    // canonical path also catches a replaced ancestor while this inode survives.
    const path = relative(session.root, target.path) || '.'
    try {
      const info = await lstat(target.path)
      signal.throwIfAborted()
      if (info.dev !== target.dev || info.ino !== target.ino || !info.isDirectory() || info.isSymbolicLink()) throw new DirectoryChanged(path)
      const canonical = await realpath(target.path)
      signal.throwIfAborted()
      if (!samePath(canonical, join(session.canonicalRoot, path))) throw new DirectoryChanged(path)
    } catch (error) {
      signal.throwIfAborted()
      if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(errorCode(error))) throw new DirectoryChanged(path)
      throw error
    }
  }

  private entry(session: TreeSession, path: string, depth: number, info: Stats): TreeEntry {
    const entry: TreeEntry = { relativePath: relative(session.root, path) || '.', depth,
      type: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other' }
    if (entry.type !== 'directory') entry.size = info.size
    else if (depth >= session.depthLimit) {
      entry.childrenOmitted = 'depth_limit'
      session.depthTruncated = true
    } else {
      const bytes = Buffer.byteLength(path)
      if (session.pending.length >= maximumPendingDirectories || session.pendingPathBytes + bytes > maximumPendingPathBytes) {
        entry.childrenOmitted = 'directory_queue_limit'
        session.queueTruncated = true
      } else {
        session.pending.push({ path, depth, dev: info.dev, ino: info.ino })
        session.pendingPathBytes += bytes
      }
    }
    return entry
  }

  private async next(session: TreeSession, budget: PageBudget, errors: TreeError[], signal: AbortSignal): Promise<TreeEntry | undefined> {
    const report = (path: string, error: unknown) => {
      session.accessTruncated = true
      if (errors.length < 20) errors.push({ relativePath: relative(session.root, path) || '.', errorCode: errorCode(error) })
      else budget.omittedErrors++
    }
    while (true) {
      signal.throwIfAborted()
      if (budget.remaining-- <= 0 || Date.now() >= budget.until) throw new PageBudgetReached()
      if (!session.started) {
        const info = await lstat(session.root)
        signal.throwIfAborted()
        if (info.isDirectory()) session.canonicalRoot = await realpath(session.root)
        signal.throwIfAborted()
        session.started = true
        session.rootInfo = info
        return this.entry(session, session.root, 0, info)
      }
      if (!session.active) {
        const target = session.pending.shift()
        if (!target) return undefined
        session.pendingPathBytes -= Buffer.byteLength(target.path)
        try {
          await this.verifyDirectory(session, target, signal)
          const directory = await opendir(target.path, { bufferSize: 1 })
          session.active = { target, directory }
          signal.throwIfAborted()
          await this.verifyDirectory(session, target, signal)
        } catch (error) {
          signal.throwIfAborted()
          if (target.path === session.root || error instanceof DirectoryChanged) throw error
          await this.closeDirectory(session)
          report(target.path, error)
          continue
        }
      }
      const active = session.active
      let child
      try { child = await active.directory.read() } catch (error) {
        signal.throwIfAborted()
        await this.verifyDirectory(session, active.target, signal)
        report(active.target.path, error)
        await this.closeDirectory(session)
        continue
      }
      signal.throwIfAborted()
      if (!child) {
        await this.verifyDirectory(session, active.target, signal)
        await this.closeDirectory(session)
        continue
      }
      const path = join(active.target.path, child.name), depth = active.target.depth + 1
      try {
        const info = await lstat(path)
        signal.throwIfAborted()
        return this.entry(session, path, depth, info)
      } catch (error) {
        signal.throwIfAborted()
        session.accessTruncated = true
        return { relativePath: relative(session.root, path), depth, type: 'unavailable', errorCode: errorCode(error) }
      }
    }
  }

  private async closeDirectory(session: TreeSession): Promise<void> {
    const active = session.active
    session.active = undefined
    if (active) await active.directory.close()
  }

  private async close(session: TreeSession): Promise<void> {
    if (session.closing) return session.closing
    session.closed = true
    clearTimeout(session.timer)
    if (session.onAbort) session.lifetimeSignal?.removeEventListener('abort', session.onAbort)
    session.closing = (async () => {
      try { await this.closeDirectory(session) } finally { this.sessions.delete(session.cursor) }
    })()
    return session.closing
  }

  private closeIdle(session: TreeSession): void {
    if (session.busy || session.closed) return
    void this.close(session).catch(error => runtimeLog('warn', 'directory-tree', 'Could not close a directory cursor.', { error: String(error) }))
  }

  async closeIdleCursors(scope?: string): Promise<void> {
    await Promise.all([...this.sessions.values()].filter(session => !session.busy && (scope === undefined || session.scope === scope)).map(session => this.close(session)))
  }
}

export const directoryTreePages = new DirectoryTreePages()
