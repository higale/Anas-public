export const helpDocuments = {
  'USER_GUIDE.en.md': 'User Guide',
  'USER_GUIDE.zh-CN.md': '用户手册',
  'AGENT_SKILLS.en.md': 'Agent Skills · English',
  'AGENT_SKILLS.zh-CN.md': 'Agent Skills · 中文'
} as const

export type HelpDocumentId = keyof typeof helpDocuments

export function isHelpDocumentId(value: unknown): value is HelpDocumentId {
  return typeof value === 'string' && Object.hasOwn(helpDocuments, value)
}

export function userGuideId(language: string): HelpDocumentId {
  return language.toLowerCase().startsWith('zh') ? 'USER_GUIDE.zh-CN.md' : 'USER_GUIDE.en.md'
}

/** Resolve only bundled documents; ordinary external links keep their browser destination. */
export function resolveHelpLink(href: string, current: HelpDocumentId): { documentId: HelpDocumentId; anchor: string } | undefined {
  const base = new URL(current, 'https://help.anas.invalid/')
  const url = new URL(href, base)
  if (url.origin !== base.origin || url.search) return undefined
  const documentId = decodeURIComponent(url.pathname.slice(1))
  return isHelpDocumentId(documentId) ? { documentId, anchor: decodeURIComponent(url.hash.slice(1)) } : undefined
}
