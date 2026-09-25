import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import en from '../../../data/lang/en.json'
import zhCN from '../../../data/lang/zh-CN.json'
import { initializeI18n } from './i18n'

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : []
  })
}

function literalTranslationKeys(): Set<string> {
  const keys = new Set<string>()
  const root = join(process.cwd(), 'src/renderer/src')
  for (const path of sourceFiles(root)) {
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(/\bt\(\s*['"]([^'"]+)['"]/g)) {
      keys.add(match[1])
    }
  }
  return keys
}

function hasTranslation(resource: object, key: string): boolean {
  let value: unknown = resource
  for (const segment of key.split('.')) {
    if (!value || typeof value !== 'object' || !(segment in value)) return false
    value = (value as Record<string, unknown>)[segment]
  }
  return typeof value === 'string'
}

function caughtErrorTextLocations(path: string): string[] {
  const sourceText = readFileSync(path, 'utf8')
  const sourceFile = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  )
  const caughtNames: Set<string>[] = []
  const locations: string[] = []

  function isCaughtIdentifier(node: ts.Node): node is ts.Identifier {
    return ts.isIdentifier(node) && caughtNames.some((names) => names.has(node.text))
  }

  function visit(node: ts.Node): void {
    if (ts.isCatchClause(node)) {
      const name = node.variableDeclaration?.name
      caughtNames.push(new Set(name && ts.isIdentifier(name) ? [name.text] : []))
      ts.forEachChild(node.block, visit)
      caughtNames.pop()
      return
    }
    const caughtMessage = ts.isPropertyAccessExpression(node)
      && node.name.text === 'message'
      && isCaughtIdentifier(node.expression)
    const caughtString = ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'String'
      && node.arguments.length === 1
      && isCaughtIdentifier(node.arguments[0])
    if (caughtMessage || caughtString) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
      locations.push(`${path}:${line + 1}:${character + 1}`)
    }
    ts.forEachChild(node, visit)
  }

  visit(sourceFile)
  return locations
}

describe('renderer translations', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('defines every literal translation key in both bundled languages', () => {
    const keys = [...literalTranslationKeys()]
    expect(keys.filter((key) => !hasTranslation(en, key))).toEqual([])
    expect(keys.filter((key) => !hasTranslation(zhCN, key))).toEqual([])
  })

  it('does not use caught Error text as renderer copy', () => {
    const root = join(process.cwd(), 'src/renderer/src')
    const offenders = sourceFiles(root)
      .filter((path) => !/\.test\.[^.]+$/.test(path))
      .flatMap(caughtErrorTextLocations)
    expect(offenders).toEqual([])
  })

  it('initializes language resources when the startup config read fails', async () => {
    const snapshot = {
      langDir: 'lang',
      languages: [{ code: 'en', name: 'English', fileName: 'en.json' }],
      resources: { en }
    }
    vi.stubGlobal('window', {
      gale: {
        app: { getLanguageResources: vi.fn(async () => snapshot) },
        config: { get: vi.fn(async () => { throw new Error('Config unavailable') }) }
      }
    })
    vi.stubGlobal('navigator', { language: 'en-US', languages: ['en-US'] })
    vi.stubGlobal('document', { documentElement: { lang: '' } })

    await expect(initializeI18n()).resolves.toEqual(snapshot)
    expect(document.documentElement.lang).toBe('en')
  })

  it('boots recovery with bundled translations without any normal application IPC', async () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', { language: 'zh-CN', languages: ['zh-CN'] })
    vi.stubGlobal('document', { documentElement: { lang: '' } })
    const snapshot = await initializeI18n(true)
    expect(snapshot.resources['zh-CN']).toEqual(zhCN)
    expect(document.documentElement.lang).toBe('zh-CN')
  })
})
