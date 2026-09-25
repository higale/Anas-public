const localImageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const localPathPattern = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/
const urlSchemePattern = /^[a-zA-Z][a-zA-Z\d+.-]*:/

function fileUrlToPath(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'file:') return null
    const pathName = decodeURIComponent(url.pathname)
    if (/^\/[a-zA-Z]:[\\/]/.test(pathName)) return pathName.slice(1).replaceAll('/', '\\')
    if (url.hostname && url.hostname !== 'localhost') return `\\\\${url.hostname}${pathName.replaceAll('/', '\\')}`
    return pathName
  } catch {
    return null
  }
}

export function normalizeLocalImagePath(src: string | undefined): string | null {
  if (!src) return null
  const value = src.trim()
  if (!value) return null

  const filePath = /^file:/i.test(value) ? fileUrlToPath(value) : value
  if (
    !filePath
    || (!localPathPattern.test(filePath) && (urlSchemePattern.test(filePath) || filePath.startsWith('//')))
  ) return null

  const pathWithoutQuery = filePath.split(/[?#]/, 1)[0] ?? filePath
  const extensionMatch = /\.[a-zA-Z0-9]+$/.exec(pathWithoutQuery)
  const extension = extensionMatch?.[0]?.toLowerCase()
  if (!extension || !localImageExtensions.has(extension)) return null
  if (localPathPattern.test(pathWithoutQuery)) return pathWithoutQuery
  try {
    return decodeURIComponent(pathWithoutQuery)
  } catch {
    return null
  }
}
