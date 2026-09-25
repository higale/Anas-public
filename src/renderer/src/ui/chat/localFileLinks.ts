const localFileHrefPrefix = 'anas-local-file:'
const absoluteLocalPathPattern = /^(?:[a-zA-Z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+|\/(?!\/))/
const labeledPathPattern = /^(\s*(?:文件路径|file path)\s*[:：]\s*)(.*)$/i
const trailingSentencePunctuationPattern = /[。！？，；;,]+$/

interface MarkdownNode {
  type: string
  value?: string
  url?: string
  children?: MarkdownNode[]
}

function localPathParts(line: string): { prefix: string; path: string; suffix: string } | undefined {
  const labeled = labeledPathPattern.exec(line)
  const prefix = labeled?.[1] ?? line.match(/^\s*/)?.[0] ?? ''
  const candidate = (labeled?.[2] ?? line.slice(prefix.length)).trimEnd()
  const trailingWhitespace = (labeled?.[2] ?? line.slice(prefix.length)).slice(candidate.length)
  const punctuation = trailingSentencePunctuationPattern.exec(candidate)?.[0] ?? ''
  const path = punctuation ? candidate.slice(0, -punctuation.length) : candidate
  if (!absoluteLocalPathPattern.test(path) || /[\\/]$/.test(path)) return undefined
  return {
    prefix,
    path,
    suffix: `${punctuation}${trailingWhitespace}`
  }
}

export function localFileHref(path: string): string {
  return `${localFileHrefPrefix}${encodeURIComponent(path)}`
}

export function localFilePathFromHref(href: string | undefined): string | undefined {
  if (!href?.startsWith(localFileHrefPrefix)) return undefined
  try {
    const path = decodeURIComponent(href.slice(localFileHrefPrefix.length))
    return absoluteLocalPathPattern.test(path) ? path : undefined
  } catch {
    return undefined
  }
}

function linkedLine(line: string): MarkdownNode[] | undefined {
  const parts = localPathParts(line)
  if (!parts) return undefined
  return [
    ...(parts.prefix ? [{ type: 'text', value: parts.prefix }] : []),
    {
      type: 'link',
      url: localFileHref(parts.path),
      children: [{ type: 'text', value: parts.path }]
    },
    ...(parts.suffix ? [{ type: 'text', value: parts.suffix }] : [])
  ]
}

function linkedText(value: string): MarkdownNode[] | undefined {
  const pieces = value.split(/(\r?\n)/)
  let changed = false
  const nodes = pieces.flatMap((piece): MarkdownNode[] => {
    if (/^\r?\n$/.test(piece)) return [{ type: 'text', value: piece }]
    const linked = linkedLine(piece)
    if (!linked) return [{ type: 'text', value: piece }]
    changed = true
    return linked
  })
  return changed ? nodes : undefined
}

function linkedInlineCode(node: MarkdownNode): MarkdownNode | undefined {
  if (node.type !== 'inlineCode' || typeof node.value !== 'string') return undefined
  const path = node.value.trim()
  if (!absoluteLocalPathPattern.test(path) || /[\\/]$/.test(path)) return undefined
  return {
    type: 'link',
    url: localFileHref(path),
    children: [{ type: 'text', value: path }]
  }
}

function transformNode(node: MarkdownNode): void {
  if (!node.children || node.type === 'link' || node.type === 'image') return
  node.children = node.children.flatMap((child) => {
    if (child.type === 'text' && typeof child.value === 'string') {
      return linkedText(child.value) ?? [child]
    }
    const linkedCode = linkedInlineCode(child)
    if (linkedCode) return [linkedCode]
    transformNode(child)
    return [child]
  })
}

export function remarkLocalFileLinks() {
  return (tree: MarkdownNode): void => transformNode(tree)
}
