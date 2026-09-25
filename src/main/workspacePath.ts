import { lstat, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, parse, resolve, sep } from 'node:path'

export type WorkspacePathSemantics = 'follow' | 'entry'

/** Shell operands are already literal filenames. Preserve whitespace and let
 * the OS resolve each symlink before a following `..`; tool/UI path cleanup
 * would change the file opened by POSIX programs. Targets must exist. */
export async function resolveShellOperandPath(value: string, workingDir: string): Promise<string> {
  if (!value || !isAbsolute(workingDir)) throw new Error('Shell path and absolute working directory are required.')
  const absolute = isAbsolute(value) ? value : `${workingDir}${workingDir.endsWith(sep) ? '' : sep}${value}`
  return realpath(absolute)
}

export interface CanonicalWorkspacePath {
  requestedPath: string
  lexicalPath: string
  canonicalPath: string
  exists: boolean
  finalIsSymbolicLink: boolean
}

function isFullyQualifiedAbsolutePath(value: string): boolean {
  if (!isAbsolute(value)) return false
  if (process.platform !== 'win32') return true
  const root = parse(value).root
  return root !== '\\' && root !== '/'
}

function isWindowsDriveRelativePath(value: string): boolean {
  return process.platform === 'win32'
    && /^[a-z]:/i.test(parse(value).root)
    && !isAbsolute(value)
}

export function resolveWorkspacePath(input: unknown, primaryFolder: string): string {
  if (typeof input !== 'string' || !input.trim()) throw new Error('path is required')
  if (!isFullyQualifiedAbsolutePath(primaryFolder)) {
    throw new Error('primary folder must be a fully qualified absolute path')
  }
  const value = input.trim()
  if (isAbsolute(value)) {
    if (!isFullyQualifiedAbsolutePath(value)) {
      throw new Error('path must be relative or a fully qualified absolute path')
    }
    return resolve(value)
  }
  if (isWindowsDriveRelativePath(value)) {
    throw new Error('path must be relative or a fully qualified absolute path')
  }
  return resolve(primaryFolder, value)
}

export function tryResolveWorkspacePath(input: unknown, primaryFolder: string): string | undefined {
  try {
    return resolveWorkspacePath(input, primaryFolder)
  } catch {
    return undefined
  }
}

function isMissingPath(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

async function existingPathInfo(path: string): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path)
  } catch (error) {
    if (isMissingPath(error)) return undefined
    throw error
  }
}

async function canonicalizeMissingPath(path: string): Promise<string> {
  const suffix: string[] = []
  let ancestor = path
  while (true) {
    const info = await existingPathInfo(ancestor)
    if (info) {
      const canonicalAncestor = await realpath(ancestor)
      return resolve(canonicalAncestor, ...suffix.reverse())
    }
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new Error(`path has no existing ancestor: ${path}`)
    suffix.push(basename(ancestor))
    ancestor = parent
  }
}

export async function canonicalizeAbsolutePath(
  absolutePath: string,
  semantics: WorkspacePathSemantics
): Promise<Omit<CanonicalWorkspacePath, 'requestedPath'>> {
  const lexicalPath = resolve(absolutePath)
  if (semantics === 'entry') {
    const parent = dirname(lexicalPath)
    const canonicalParent = await canonicalizeAbsolutePath(parent, 'follow')
    const info = await existingPathInfo(lexicalPath)
    return {
      lexicalPath,
      canonicalPath: resolve(canonicalParent.canonicalPath, basename(lexicalPath)),
      exists: Boolean(info),
      finalIsSymbolicLink: info?.isSymbolicLink() ?? false
    }
  }

  const info = await existingPathInfo(lexicalPath)
  return {
    lexicalPath,
    canonicalPath: info ? resolve(await realpath(lexicalPath)) : await canonicalizeMissingPath(lexicalPath),
    exists: Boolean(info),
    finalIsSymbolicLink: info?.isSymbolicLink() ?? false
  }
}

export async function resolveCanonicalWorkspacePath(
  input: unknown,
  primaryFolder: string,
  semantics: WorkspacePathSemantics
): Promise<CanonicalWorkspacePath> {
  const requestedPath = typeof input === 'string' ? input.trim() : ''
  const resolved = resolveWorkspacePath(input, primaryFolder)
  return {
    requestedPath,
    ...await canonicalizeAbsolutePath(resolved, semantics)
  }
}
