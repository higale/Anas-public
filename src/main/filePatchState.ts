import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { dirname } from 'node:path'
import { maxPatchInputBytes } from './fileEditDiff'
import { maxFilePatchBatchBytes, maxFilePatchOperations, type FilePatchTarget } from './filePatch'
import { samePath } from './pathContainment'
import { canonicalizeAbsolutePath } from './workspacePath'

export interface FilePatchFileIdentity {
  device: string
  inode: string
  size: number
  mode: number
  modifiedNs: string
  changedNs: string
}

interface FilePatchParentIdentity {
  path: string
  device: string
  inode: string
}

export interface FilePatchPreimage {
  target: FilePatchTarget
  parent: FilePatchParentIdentity
  text: string | null
  hash: string | null
  identity: FilePatchFileIdentity | null
}

function changed(path: string): Error {
  return new Error(`Patch target changed; resolve and read it again: ${path}`)
}

function identity(info: BigIntStats): FilePatchFileIdentity {
  return {
    device: String(info.dev), inode: String(info.ino), size: Number(info.size), mode: Number(info.mode),
    modifiedNs: String(info.mtimeNs), changedNs: String(info.ctimeNs)
  }
}

function sameIdentity(left: FilePatchFileIdentity, right: FilePatchFileIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.size === right.size
    && left.mode === right.mode && left.modifiedNs === right.modifiedNs && left.changedNs === right.changedNs
}

async function verifyTarget(target: FilePatchTarget, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const current = await canonicalizeAbsolutePath(target.lexicalPath, target.semantics)
  if (!samePath(current.canonicalPath, target.canonicalPath) || current.exists !== target.exists
    || current.finalIsSymbolicLink !== target.finalIsSymbolicLink) throw changed(target.lexicalPath)
  signal?.throwIfAborted()
}

async function parentIdentity(target: string, signal?: AbortSignal): Promise<FilePatchParentIdentity> {
  let path = dirname(target)
  for (let depth = 0; depth < 256; depth++) {
    signal?.throwIfAborted()
    try {
      const info = await lstat(path, { bigint: true })
      signal?.throwIfAborted()
      if (!info.isDirectory() || info.isSymbolicLink()) throw changed(path)
      return { path, device: String(info.dev), inode: String(info.ino) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const next = dirname(path)
    if (next === path) break
    path = next
  }
  throw new Error('Patch parent directory cannot be resolved within the depth limit.')
}

async function verifyParent(parent: FilePatchParentIdentity, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const info = await lstat(parent.path, { bigint: true })
  signal?.throwIfAborted()
  if (!info.isDirectory() || info.isSymbolicLink()
    || String(info.dev) !== parent.device || String(info.ino) !== parent.inode) throw changed(parent.path)
}

async function readPreimage(target: FilePatchTarget, remainingBytes: number, signal?: AbortSignal): Promise<FilePatchPreimage> {
  await verifyTarget(target, signal)
  const parent = await parentIdentity(target.canonicalPath, signal)
  let before: BigIntStats
  try {
    before = await lstat(target.canonicalPath, { bigint: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || target.exists) throw error
    await verifyTarget(target, signal)
    await verifyParent(parent, signal)
    return { target: { ...target }, parent, text: null, hash: null, identity: null }
  }
  if (!target.exists) throw changed(target.canonicalPath)
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Patch requires a regular text file: ${target.canonicalPath}`)
  const limit = Math.min(maxPatchInputBytes, remainingBytes)
  if (before.size > BigInt(limit)) throw new Error(`Patch snapshot exceeds the remaining byte budget (${limit}).`)
  const expectedIdentity = identity(before)
  // Refuse a leaf link or a special file substituted after lstat. NONBLOCK is
  // ignored for regular files but avoids blocking on a substituted FIFO on POSIX.
  const handle = await open(target.canonicalPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  let bytes: Buffer
  try {
    signal?.throwIfAborted()
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || !sameIdentity(expectedIdentity, identity(opened))) throw changed(target.canonicalPath)
    const buffer = Buffer.alloc(expectedIdentity.size + 1)
    let length = 0
    while (length < buffer.length) {
      signal?.throwIfAborted()
      const result = await handle.read(buffer, length, Math.min(65_536, buffer.length - length), length)
      signal?.throwIfAborted()
      if (result.bytesRead === 0) break
      length += result.bytesRead
    }
    if (length !== expectedIdentity.size
      || !sameIdentity(expectedIdentity, identity(await handle.stat({ bigint: true })))) throw changed(target.canonicalPath)
    bytes = buffer.subarray(0, length)
  } finally {
    await handle.close()
  }
  const after = await lstat(target.canonicalPath, { bigint: true })
  if (!after.isFile() || after.isSymbolicLink() || !sameIdentity(expectedIdentity, identity(after))) throw changed(target.canonicalPath)
  await verifyTarget(target, signal)
  await verifyParent(parent, signal)
  if (bytes.includes(0)) throw new Error('Patch cannot read binary data as UTF-8 text.')
  // Preserve a UTF-8 BOM as part of the file contents and reject invalid bytes.
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  return {
    target: { ...target }, parent, text, identity: expectedIdentity,
    hash: createHash('sha256').update(bytes).digest('hex')
  }
}

function assertTargetCount(count: number): void {
  if (count === 0 || count > maxFilePatchOperations * 2) throw new Error('Patch snapshot target count is invalid.')
}

// Caller must complete rules and authorization first. This reads contents, but
// never creates parents, staging records, or target files.
export async function captureFilePatchPreimages(targets: readonly FilePatchTarget[], signal?: AbortSignal): Promise<FilePatchPreimage[]> {
  assertTargetCount(targets.length)
  const preimages: FilePatchPreimage[] = []
  let remaining = maxFilePatchBatchBytes
  for (const target of targets) {
    const preimage = await readPreimage(target, remaining, signal)
    remaining -= preimage.identity?.size ?? 0
    preimages.push(preimage)
  }
  // A file read early in the batch may have changed while later files were read.
  await verifyFilePatchPreimages(preimages, signal)
  return preimages
}

// Reuse immediately before preparing/committing a record. This is a consistency
// check, not an OS-level compare-and-swap or a replacement for commit recovery.
export async function verifyFilePatchPreimages(preimages: readonly FilePatchPreimage[], signal?: AbortSignal): Promise<void> {
  assertTargetCount(preimages.length)
  let remaining = maxFilePatchBatchBytes
  for (const expected of preimages) {
    await verifyParent(expected.parent, signal)
    const current = await readPreimage(expected.target, remaining, signal)
    remaining -= current.identity?.size ?? 0
    if (current.hash !== expected.hash || current.text !== expected.text
      || (current.identity === null) !== (expected.identity === null)
      || (current.identity && expected.identity && !sameIdentity(current.identity, expected.identity))) {
      throw changed(expected.target.canonicalPath)
    }
  }
}
