import path from 'node:path'

type PathModule = Pick<typeof path, 'isAbsolute' | 'parse' | 'relative' | 'resolve' | 'sep'>

function normalizeCase(value: string, caseInsensitive: boolean): string {
  return caseInsensitive ? value.toLowerCase() : value
}

export function samePath(left: string, right: string, pathModule: PathModule = path, caseInsensitive = process.platform === 'win32'): boolean {
  const normalizedLeft = normalizeCase(pathModule.resolve(left), caseInsensitive)
  const normalizedRight = normalizeCase(pathModule.resolve(right), caseInsensitive)
  return normalizedLeft === normalizedRight
}

export function isSameOrInsideDirectory(baseDir: string, targetPath: string, pathModule: PathModule = path, caseInsensitive = process.platform === 'win32'): boolean {
  const base = pathModule.resolve(baseDir)
  const target = pathModule.resolve(targetPath)
  const baseRoot = normalizeCase(pathModule.parse(base).root, caseInsensitive)
  const targetRoot = normalizeCase(pathModule.parse(target).root, caseInsensitive)
  if (baseRoot !== targetRoot) return false

  const rel = pathModule.relative(base, target)
  if (rel === '') return true
  if (pathModule.isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${pathModule.sep}`)
}
