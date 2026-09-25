import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import {
  BaseStore,
  type Item,
  type ListNamespacesOperation,
  type Operation,
  type OperationResults,
  type PutOperation,
  type SearchItem,
  type SearchOperation
} from '@langchain/langgraph-checkpoint'
import type {
  MemoryItem,
  MemoryKind,
  MemoryOrigin,
  MemorySaveRequest,
  MemoryScope,
  MemorySearchRequest,
  MemorySearchResult
} from '@shared/types'

const memoryNamespace = 'memories'
const defaultSearchLimit = 100
const maximumSearchLimit = 500
const maximumQueryLength = 2_000
const maximumMemoryLength = 12_000
const maximumKeywordCount = 20
const maximumKeywordLength = 64
const latinStopWords = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'could', 'did', 'do', 'does',
  'for', 'from', 'had', 'has', 'have', 'how', 'i', 'if', 'in', 'into', 'is', 'it', 'its',
  'may', 'might', 'my', 'of', 'on', 'or', 'our', 'please', 'should', 'that', 'the', 'their',
  'them', 'then', 'there', 'these', 'they', 'this', 'to', 'was', 'we', 'were', 'what',
  'when', 'where', 'which', 'who', 'why', 'will', 'with', 'would', 'you', 'your'
])

type StoreRow = {
  namespace_path: string
  key: string
  value_json: string
  created_at: string
  updated_at: string
}

type StoredMemoryValue = {
  kind: MemoryKind
  content: string
  keywords: string[]
  importance: number
  origin: MemoryOrigin
  sourceThreadId?: string
  sourceRunId?: string
}

export interface SaveMemoryContext {
  accessProjectId?: string
  origin: MemoryOrigin
  newId?: string
  sourceThreadId?: string
  sourceRunId?: string
}

function namespacePath(namespace: readonly string[]): string {
  return JSON.stringify(namespace)
}

function parseNamespace(path: string): string[] {
  const value = JSON.parse(path) as unknown
  if (!Array.isArray(value) || value.some((part) => typeof part !== 'string')) {
    throw new Error('Stored LangGraph namespace is invalid.')
  }
  return value
}

function startsWithNamespace(namespace: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length <= namespace.length
    && prefix.every((part, index) => namespace[index] === part)
}

function asStoreItem(row: StoreRow, score?: number): SearchItem {
  return {
    namespace: parseNamespace(row.namespace_path),
    key: row.key,
    value: JSON.parse(row.value_json) as Record<string, unknown>,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    ...(score === undefined ? {} : { score })
  }
}

function valueAtPath(value: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => (
    current && typeof current === 'object' && !Array.isArray(current)
      ? (current as Record<string, unknown>)[part]
      : undefined
  ), value)
}

function compareFilter(actual: unknown, expected: unknown): boolean {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    return actual === expected
  }
  return Object.entries(expected as Record<string, unknown>).every(([operator, operand]) => {
    if (operator === '$eq') return actual === operand
    if (operator === '$ne') return actual !== operand
    if (operator === '$gt') return typeof actual === 'number' && typeof operand === 'number' && actual > operand
    if (operator === '$gte') return typeof actual === 'number' && typeof operand === 'number' && actual >= operand
    if (operator === '$lt') return typeof actual === 'number' && typeof operand === 'number' && actual < operand
    if (operator === '$lte') return typeof actual === 'number' && typeof operand === 'number' && actual <= operand
    return false
  })
}

function matchesFilter(row: StoreRow, filter: Record<string, unknown> | undefined): boolean {
  if (!filter) return true
  const value = JSON.parse(row.value_json) as Record<string, unknown>
  return Object.entries(filter).every(([path, expected]) => (
    compareFilter(valueAtPath(value, path), expected)
  ))
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replaceAll(/\s+/g, ' ').trim()
}

function searchTerms(query: string): string[] {
  const normalized = normalizedText(query)
  const terms: string[] = []
  const seen = new Set<string>()
  const add = (term: string): void => {
    const value = term.trim()
    if (value.length < 3 || seen.has(value)) return
    seen.add(value)
    terms.push(value.slice(0, 64))
  }
  for (const match of normalized.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu)) {
    const value = match[0]
    for (let index = 0; index <= value.length - 3; index += 1) add(value.slice(index, index + 3))
  }
  for (const match of normalized.matchAll(/[\p{L}\p{N}_./:+-]{3,}/gu)) {
    for (const segment of match[0].split(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/u)) {
      add(segment)
    }
  }
  return terms.slice(0, 24)
}

function latinSearchTerms(value: string): string[] {
  const terms = new Set<string>()
  for (const match of value.matchAll(/[\p{L}\p{N}_./:+-]+/gu)) {
    for (const segment of match[0].split(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/u)) {
      if (/[\p{L}\p{N}]/u.test(segment)) terms.add(segment)
    }
  }
  return [...terms]
}

function cjkSearchTerms(value: string): string[] {
  const terms = new Set<string>()
  for (const match of value.matchAll(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu)) {
    for (let index = 0; index <= match[0].length - 2; index += 1) {
      terms.add(match[0].slice(index, index + 2))
    }
  }
  return [...terms]
}

function requiredTermMatches(termCount: number, cjk: boolean): number {
  if (termCount <= 2) return termCount
  return Math.max(2, Math.ceil(termCount * (cjk ? 0.6 : 0.4)))
}

function indexedText(value: Record<string, unknown>): { content: string; keywords: string } | undefined {
  if (typeof value.content !== 'string') return undefined
  const keywords = Array.isArray(value.keywords)
    ? value.keywords.filter((keyword): keyword is string => typeof keyword === 'string').join(' ')
    : ''
  return { content: value.content, keywords }
}

function memorySearchScore(row: StoreRow, query: string): number | undefined {
  const value = JSON.parse(row.value_json) as Record<string, unknown>
  const indexed = indexedText(value)
  if (!indexed) return undefined
  const searchable = normalizedText(`${indexed.content}\n${indexed.keywords}`)
  const exact = searchable.includes(query)
  const allLatinTerms = latinSearchTerms(query)
  const meaningfulLatinTerms = allLatinTerms.filter((term) => !latinStopWords.has(term))
  const latinTerms = meaningfulLatinTerms.length > 0 ? meaningfulLatinTerms : allLatinTerms
  const cjkTerms = latinTerms.length > 0 ? [] : cjkSearchTerms(query)
  const terms = latinTerms.length > 0 ? latinTerms : cjkTerms
  if (terms.length === 0) return exact ? 2 : undefined

  const searchableTerms = latinTerms.length > 0
    ? new Set(latinSearchTerms(searchable))
    : undefined
  const matched = terms.filter((term) => (
    searchableTerms ? searchableTerms.has(term) : searchable.includes(term)
  )).length
  if (matched < requiredTermMatches(terms.length, cjkTerms.length > 0)) return undefined
  return (exact ? 2 : 0) + matched / terms.length
}

function memoryRankingBoost(row: StoreRow): number {
  const namespace = parseNamespace(row.namespace_path)
  if (namespace[0] !== memoryNamespace) return 0
  const value = JSON.parse(row.value_json) as Record<string, unknown>
  const importance = typeof value.importance === 'number'
    ? Math.min(5, Math.max(1, value.importance))
    : 3
  const ageDays = Math.max(0, (Date.now() - Date.parse(row.updated_at)) / 86_400_000)
  const recency = Math.exp(-ageDays / 180)
  return importance * 0.02 + recency * 0.05
}

function matchNamespacePath(path: readonly string[], pattern: readonly (string | '*')[]): boolean {
  return path.length >= pattern.length
    && pattern.every((part, index) => part === '*' || path[index] === part)
}

function matchesNamespaceConditions(
  namespace: readonly string[],
  operation: ListNamespacesOperation
): boolean {
  return (operation.matchConditions ?? []).every((condition) => {
    if (condition.matchType === 'prefix') return matchNamespacePath(namespace, condition.path)
    const suffix = namespace.slice(Math.max(0, namespace.length - condition.path.length))
    return suffix.length === condition.path.length && matchNamespacePath(suffix, condition.path)
  })
}

function memoryNamespaceFor(scope: MemoryScope, projectId?: string): string[] {
  if (scope === 'global') return [memoryNamespace, 'global']
  if (!projectId?.trim()) throw new Error('Project memories require a project ID.')
  return [memoryNamespace, 'project', projectId.trim()]
}

function memoryFromItem(item: SearchItem): MemoryItem {
  const value = item.value as StoredMemoryValue
  const scope = item.namespace[1]
  if (scope !== 'global' && scope !== 'project') throw new Error('Stored memory scope is invalid.')
  return {
    id: item.key,
    scope,
    ...(scope === 'project' ? { projectId: item.namespace[2] } : {}),
    kind: value.kind,
    content: value.content,
    keywords: value.keywords,
    importance: value.importance,
    origin: value.origin,
    ...(value.sourceThreadId ? { sourceThreadId: value.sourceThreadId } : {}),
    ...(value.sourceRunId ? { sourceRunId: value.sourceRunId } : {}),
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    ...(item.score === undefined ? {} : { score: item.score })
  }
}

function validatedMemoryId(id: unknown): string {
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error('Memory ID is invalid.')
  }
  return id
}

function validatedMemoryRequest(request: MemorySaveRequest): MemorySaveRequest {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Memory save request is invalid.')
  }
  if (request.id !== undefined) validatedMemoryId(request.id)
  if (request.scope !== 'global' && request.scope !== 'project') {
    throw new Error('Memory scope is invalid.')
  }
  if (request.scope === 'project' && (
    typeof request.projectId !== 'string'
    || !request.projectId.trim()
    || request.projectId.length > 200
  )) {
    throw new Error('Project memories require a valid project ID.')
  }
  if (typeof request.content !== 'string') throw new Error('Memory content is invalid.')
  if (!Array.isArray(request.keywords) || request.keywords.some((keyword) => typeof keyword !== 'string')) {
    throw new Error('Memory keywords are invalid.')
  }
  const content = request.content.trim()
  if (!content) throw new Error('Memory content is required.')
  if (content.length > maximumMemoryLength) {
    throw new Error(`Memory content must not exceed ${maximumMemoryLength} characters.`)
  }
  if (!['preference', 'fact', 'experience'].includes(request.kind)) {
    throw new Error('Memory kind is invalid.')
  }
  if (!Number.isInteger(request.importance) || request.importance < 1 || request.importance > 5) {
    throw new Error('Memory importance must be an integer from 1 to 5.')
  }
  const keywords = [...new Set(request.keywords.map((keyword) => keyword.trim()).filter(Boolean))]
  if (keywords.length > maximumKeywordCount) {
    throw new Error(`A memory may contain at most ${maximumKeywordCount} keywords.`)
  }
  if (keywords.some((keyword) => keyword.length > maximumKeywordLength)) {
    throw new Error(`Memory keywords must not exceed ${maximumKeywordLength} characters.`)
  }
  return {
    ...request,
    content,
    keywords,
    ...(request.scope === 'global' ? { projectId: undefined } : {})
  }
}

function validatedSearchRequest(request: MemorySearchRequest): MemorySearchRequest {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Memory search request is invalid.')
  }
  if (request.query !== undefined && typeof request.query !== 'string') {
    throw new Error('Memory query is invalid.')
  }
  if (request.scope !== undefined && !['all', 'global', 'project'].includes(request.scope)) {
    throw new Error('Memory search scope is invalid.')
  }
  if (request.projectId !== undefined && (
    typeof request.projectId !== 'string'
    || !request.projectId.trim()
    || request.projectId.length > 200
  )) {
    throw new Error('Memory search project is invalid.')
  }
  if (request.kind !== undefined && !['all', 'preference', 'fact', 'experience'].includes(request.kind)) {
    throw new Error('Memory search kind is invalid.')
  }
  if (request.limit !== undefined && (!Number.isInteger(request.limit) || request.limit < 1)) {
    throw new Error('Memory search limit is invalid.')
  }
  if (request.offset !== undefined && (!Number.isInteger(request.offset) || request.offset < 0)) {
    throw new Error('Memory search offset is invalid.')
  }
  return request
}

export class SqliteMemoryStore extends BaseStore {
  constructor(private readonly database: Database.Database) {
    super()
    this.initialize()
  }

  private initialize(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS agent_store_items (
        namespace_path TEXT NOT NULL CHECK (json_valid(namespace_path)),
        key TEXT NOT NULL CHECK (length(key) > 0),
        value_json TEXT NOT NULL CHECK (json_valid(value_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (namespace_path, key)
      );

      CREATE INDEX IF NOT EXISTS agent_store_items_updated_idx
        ON agent_store_items (updated_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS agent_memory_fts USING fts5(
        namespace_path UNINDEXED,
        key UNINDEXED,
        content,
        keywords,
        tokenize = 'trigram'
      );
    `)
  }

  override async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    const execute = this.database.transaction((items: Operation[]) => (
      items.map((operation) => {
        if ('value' in operation) return this.putOperation(operation)
        if ('namespacePrefix' in operation) return this.searchOperation(operation)
        if ('matchConditions' in operation || 'maxDepth' in operation) {
          return this.listNamespacesOperation(operation as ListNamespacesOperation)
        }
        if ('namespace' in operation) return this.getOperation(operation.namespace, operation.key)
        return this.listNamespacesOperation(operation)
      })
    ))
    return execute(operations) as OperationResults<Op>
  }

  private getOperation(namespace: string[], key: string): Item | null {
    const row = this.database.prepare(`
      SELECT namespace_path, key, value_json, created_at, updated_at
      FROM agent_store_items
      WHERE namespace_path = ? AND key = ?
    `).get(namespacePath(namespace), key) as StoreRow | undefined
    return row ? asStoreItem(row) : null
  }

  private putOperation(operation: PutOperation): void {
    const path = namespacePath(operation.namespace)
    if (operation.value === null) {
      this.database.prepare('DELETE FROM agent_memory_fts WHERE namespace_path = ? AND key = ?')
        .run(path, operation.key)
      this.database.prepare('DELETE FROM agent_store_items WHERE namespace_path = ? AND key = ?')
        .run(path, operation.key)
      return
    }
    const valueJson = JSON.stringify(operation.value)
    const now = new Date().toISOString()
    this.database.prepare(`
      INSERT INTO agent_store_items (namespace_path, key, value_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (namespace_path, key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `).run(path, operation.key, valueJson, now, now)
    this.database.prepare('DELETE FROM agent_memory_fts WHERE namespace_path = ? AND key = ?')
      .run(path, operation.key)
    if (operation.namespace[0] !== memoryNamespace || operation.index === false) return
    const indexed = indexedText(operation.value)
    if (!indexed) return
    this.database.prepare(`
      INSERT INTO agent_memory_fts (namespace_path, key, content, keywords)
      VALUES (?, ?, ?, ?)
    `).run(path, operation.key, indexed.content, indexed.keywords)
  }

  private ftsRanks(query: string): Map<string, number> {
    const terms = searchTerms(query)
    if (terms.length === 0) return new Map()
    const statement = this.database.prepare(`
      SELECT namespace_path, key
      FROM agent_memory_fts
      WHERE agent_memory_fts MATCH ?
      ORDER BY bm25(agent_memory_fts)
      LIMIT 500
    `)
    const matches = new Map<string, number>()
    for (const term of terms) {
      const match = `"${term.replaceAll('"', '""')}"`
      const rows = statement.all(match) as Array<{ namespace_path: string; key: string }>
      for (const row of rows) {
        const key = `${row.namespace_path}\u0000${row.key}`
        matches.set(key, (matches.get(key) ?? 0) + 1 / terms.length)
      }
    }
    return matches
  }

  private searchOperation(operation: SearchOperation): SearchItem[] {
    const rows = this.database.prepare(`
      SELECT namespace_path, key, value_json, created_at, updated_at
      FROM agent_store_items
    `).all() as StoreRow[]
    const query = normalizedText(operation.query ?? '').slice(0, maximumQueryLength)
    const ranks = query ? this.ftsRanks(query) : new Map<string, number>()
    const candidates = rows
      .filter((row) => startsWithNamespace(parseNamespace(row.namespace_path), operation.namespacePrefix))
      .filter((row) => matchesFilter(row, operation.filter))
      .flatMap((row): Array<{ row: StoreRow; score?: number }> => {
        if (!query) return [{ row }]
        const textScore = memorySearchScore(row, query)
        if (textScore === undefined) return []
        const rank = ranks.get(`${row.namespace_path}\u0000${row.key}`)
        return [{ row, score: textScore + (rank ?? 0) + memoryRankingBoost(row) }]
      })
      .sort((left, right) => {
        if (left.score !== undefined || right.score !== undefined) {
          const score = (right.score ?? 0) - (left.score ?? 0)
          if (score !== 0) return score
        }
        return right.row.updated_at.localeCompare(left.row.updated_at)
      })
    const offset = Math.max(0, operation.offset ?? 0)
    const limit = Math.max(0, operation.limit ?? 10)
    return candidates.slice(offset, offset + limit).map(({ row, score }) => asStoreItem(row, score))
  }

  private listNamespacesOperation(operation: ListNamespacesOperation): string[][] {
    const rows = this.database.prepare(`
      SELECT DISTINCT namespace_path
      FROM agent_store_items
      ORDER BY namespace_path
    `).all() as Array<{ namespace_path: string }>
    const namespaces = rows
      .map((row) => parseNamespace(row.namespace_path))
      .filter((namespace) => matchesNamespaceConditions(namespace, operation))
      .map((namespace) => operation.maxDepth ? namespace.slice(0, operation.maxDepth) : namespace)
      .filter((namespace, index, all) => (
        all.findIndex((candidate) => namespacePath(candidate) === namespacePath(namespace)) === index
      ))
    return namespaces.slice(operation.offset, operation.offset + operation.limit)
  }

  async searchMemories(request: MemorySearchRequest = {}): Promise<MemorySearchResult> {
    request = validatedSearchRequest(request)
    const scope = request.scope ?? 'all'
    const namespacePrefix = scope === 'global'
      ? [memoryNamespace, 'global']
      : scope === 'project'
        ? [memoryNamespace, 'project', ...(request.projectId ? [request.projectId] : [])]
        : [memoryNamespace]
    const all = this.searchOperation({
      namespacePrefix,
      query: request.query?.trim() || undefined,
      filter: request.kind && request.kind !== 'all' ? { kind: request.kind } : undefined,
      limit: Number.MAX_SAFE_INTEGER,
      offset: 0
    }).map(memoryFromItem)
    const offset = Math.max(0, request.offset ?? 0)
    const limit = Math.min(maximumSearchLimit, Math.max(1, request.limit ?? defaultSearchLimit))
    return { items: all.slice(offset, offset + limit), total: all.length }
  }

  clearMemories(): number {
    return this.database.transaction(() => {
      this.database.prepare(`
        DELETE FROM agent_memory_fts
        WHERE json_extract(namespace_path, '$[0]') = ?
      `).run(memoryNamespace)
      return this.database.prepare(`
        DELETE FROM agent_store_items
        WHERE json_extract(namespace_path, '$[0]') = ?
      `).run(memoryNamespace).changes
    })()
  }

  async relevantMemories(query: string, projectId: string, limit = 8): Promise<MemoryItem[]> {
    const [global, project] = await Promise.all([
      this.search([memoryNamespace, 'global'], { query, limit }),
      this.search([memoryNamespace, 'project', projectId], { query, limit })
    ])
    return [...global, ...project]
      .map(memoryFromItem)
      .sort((left, right) => {
        const score = (right.score ?? 0) - (left.score ?? 0)
        if (score !== 0) return score
        const importance = right.importance - left.importance
        return importance !== 0 ? importance : right.updatedAt.localeCompare(left.updatedAt)
      })
      .slice(0, Math.max(1, limit))
  }

  async saveMemory(request: MemorySaveRequest, context: SaveMemoryContext): Promise<MemoryItem> {
    const value = validatedMemoryRequest(request)
    const newId = context.newId ? validatedMemoryId(context.newId) : undefined
    const namespace = memoryNamespaceFor(value.scope, value.projectId)
    const lookupId = value.id ?? newId
    const existing = lookupId ? await this.findMemory(lookupId) : undefined
    if (value.id && !existing) throw new Error(`Memory ${value.id} was not found.`)
    if (
      existing?.scope === 'project'
      && context.accessProjectId
      && existing.projectId !== context.accessProjectId
    ) {
      throw new Error(`Memory ${existing.id} is not available to the current project.`)
    }
    if (existing) {
      const oldNamespace = memoryNamespaceFor(existing.scope, existing.projectId)
      if (namespacePath(oldNamespace) !== namespacePath(namespace)) {
        const storedValue = {
          kind: value.kind,
          content: value.content,
          keywords: value.keywords,
          importance: value.importance,
          origin: existing.origin,
          ...(existing.sourceThreadId || context.sourceThreadId
            ? { sourceThreadId: existing.sourceThreadId ?? context.sourceThreadId }
            : {}),
          ...(existing.sourceRunId || context.sourceRunId
            ? { sourceRunId: existing.sourceRunId ?? context.sourceRunId }
            : {})
        }
        const move = this.database.transaction(() => {
          this.putOperation({ namespace: oldNamespace, key: existing.id, value: null })
          this.putOperation({
            namespace,
            key: existing.id,
            value: storedValue,
            index: ['content', 'keywords']
          })
          this.database.prepare(`
            UPDATE agent_store_items
            SET created_at = ?
            WHERE namespace_path = ? AND key = ?
          `).run(existing.createdAt, namespacePath(namespace), existing.id)
        })
        move()
        const moved = await this.get(namespace, existing.id)
        if (!moved) throw new Error(`Memory ${existing.id} was not stored.`)
        return memoryFromItem(moved)
      }
    }
    const id = existing?.id ?? newId ?? randomUUID()
    await this.put(namespace, id, {
      kind: value.kind,
      content: value.content,
      keywords: value.keywords,
      importance: value.importance,
      origin: existing?.origin ?? context.origin,
      ...(existing?.sourceThreadId || context.sourceThreadId
        ? { sourceThreadId: existing?.sourceThreadId ?? context.sourceThreadId }
        : {}),
      ...(existing?.sourceRunId || context.sourceRunId
        ? { sourceRunId: existing?.sourceRunId ?? context.sourceRunId }
        : {})
    }, ['content', 'keywords'])
    const stored = await this.get(namespace, id)
    if (!stored) throw new Error(`Memory ${id} was not stored.`)
    return memoryFromItem(stored)
  }

  async deleteMemory(id: string, accessProjectId?: string): Promise<void> {
    id = validatedMemoryId(id)
    const existing = await this.findMemory(id)
    if (!existing) return
    if (
      existing.scope === 'project'
      && accessProjectId
      && existing.projectId !== accessProjectId
    ) {
      throw new Error(`Memory ${id} is not available to the current project.`)
    }
    await this.delete(memoryNamespaceFor(existing.scope, existing.projectId), id)
  }

  deleteProjectMemories(projectId: string): number {
    if (typeof projectId !== 'string' || !projectId.trim() || projectId.length > 200) {
      throw new Error('Project memory cleanup requires a valid project ID.')
    }
    const path = namespacePath(memoryNamespaceFor('project', projectId))
    return this.database.transaction(() => {
      this.database.prepare('DELETE FROM agent_memory_fts WHERE namespace_path = ?').run(path)
      return this.database.prepare('DELETE FROM agent_store_items WHERE namespace_path = ?').run(path).changes
    })()
  }

  private async findMemory(id: string): Promise<MemoryItem | undefined> {
    const rows = this.database.prepare(`
      SELECT namespace_path, key, value_json, created_at, updated_at
      FROM agent_store_items
      WHERE key = ?
    `).all(id) as StoreRow[]
    const row = rows.find((candidate) => parseNamespace(candidate.namespace_path)[0] === memoryNamespace)
    return row ? memoryFromItem(asStoreItem(row)) : undefined
  }
}
