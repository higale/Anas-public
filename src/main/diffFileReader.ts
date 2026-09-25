import { constants } from 'node:fs'
import { lstat, open, readlink, realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { DIFF_MAX_BYTES, type DiffUnavailableReason } from '@shared/diffContents'

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
export interface FileText { text: string; exists: boolean }
export class UnavailableText extends Error {
  constructor(readonly reason: DiffUnavailableReason) { super(reason) }
}
export class FileTextChanged extends Error {
  constructor() { super('File target changed during the read.') }
}
function missing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR'))
}
export async function fingerprint(path: string): Promise<unknown> {
  try {
    const info = await lstat(path, { bigint: true })
    return [String(info.dev), String(info.ino), String(info.mode), String(info.size), String(info.mtimeNs), String(info.ctimeNs)]
  } catch (error) { if (missing(error)) return null; throw error }
}
function decodeText(bytes: Buffer): string {
  if (bytes.length > DIFF_MAX_BYTES) throw new UnavailableText('too_large')
  if (bytes.includes(0)) throw new UnavailableText('binary')
  try { return utf8.decode(bytes) } catch { throw new UnavailableText('encoding') }
}

/** Read one canonical path; symbolic links display their link text, never the target body. */
export async function workingText(path: string, signal: AbortSignal): Promise<FileText> {
  signal.throwIfAborted()
  let info
  try { info = await lstat(path) } catch (error) { if (missing(error)) return { text: '', exists: false }; throw error }
  if (info.isSymbolicLink()) {
    try { return { text: await readlink(path), exists: true } }
    catch (error) { if (missing(error)) throw new FileTextChanged(); throw error }
  }
  if (info.isDirectory()) return { text: '', exists: false }
  if (!info.isFile()) throw new UnavailableText('unsupported')
  if (info.size > DIFF_MAX_BYTES) throw new UnavailableText('too_large')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error: unknown) => {
    if (missing(error)) throw new FileTextChanged()
    throw error
  })
  try {
    const opened = await handle.stat()
    if (await realpath(dirname(path)) !== dirname(path)) throw new Error('File parent changed during the read.')
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) throw new FileTextChanged()
    const bytes = Buffer.alloc(DIFF_MAX_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      signal.throwIfAborted()
      const chunk = await handle.read(bytes, length, Math.min(65536, bytes.length - length), length)
      if (!chunk.bytesRead) break
      length += chunk.bytesRead
    }
    return { text: decodeText(bytes.subarray(0, length)), exists: true }
  } finally { await handle.close() }
}

/** Verify only the selected file and retry boundedly if an editor changes it during the read. */
export async function readCurrentFileText(path: string, signal: AbortSignal): Promise<FileText> {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted()
    const before = await fingerprint(path)
    try {
      const value = await workingText(path, signal)
      const after = await fingerprint(path)
      signal.throwIfAborted()
      if (isDeepStrictEqual(before, after)) return value
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof UnavailableText) {
        const after = await fingerprint(path)
        signal.throwIfAborted()
        if (!isDeepStrictEqual(before, after)) continue
      }
      if (!(error instanceof FileTextChanged)) throw error
    }
  }
  throw new UnavailableText('changing')
}
