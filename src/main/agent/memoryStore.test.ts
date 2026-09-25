import { afterEach, describe, expect, it } from 'vitest'
import { BaseStore } from '@langchain/langgraph-checkpoint'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentDatabase } from './agentDatabase'
import { AgentStorage } from './agentStorage'
import { getAgentCatalogFile } from '../config/dataDir'

const openDatabases: Array<{close():void}> = []
const temporaryRoots: string[] = []

function openDatabase(): AgentDatabase {
  const database = AgentDatabase.open(':memory:')
  openDatabases.push(database)
  return database
}

afterEach(async () => {
  while (openDatabases.length > 0) openDatabases.pop()?.close()
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('SqliteMemoryStore', () => {
  it('is the persistent LangGraph store attached to the agent database', async () => {
    const store = openDatabase().memoryStore

    expect(store).toBeInstanceOf(BaseStore)
    await store.put(['custom', 'namespace'], 'key-1', { content: 'value' })

    await expect(store.get(['custom', 'namespace'], 'key-1')).resolves.toMatchObject({
      key: 'key-1',
      namespace: ['custom', 'namespace'],
      value: { content: 'value' }
    })
  })

  it('persists shared memory records in catalog.sqlite across restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-memory-store-'))
    temporaryRoots.push(root)
    const first = AgentStorage.open(root)
    await first.memoryStore.saveMemory({
      scope: 'global',
      kind: 'fact',
      content: 'Persisted across restart',
      keywords: ['restart'],
      importance: 4
    }, { origin: 'user' })
    first.close()

    const reopened = AgentStorage.open(root)
    openDatabases.push(reopened)

    await expect(reopened.memoryStore.searchMemories({ query: 'restart' })).resolves.toMatchObject({
      total: 1,
      items: [{ content: 'Persisted across restart' }]
    })
  })

  it('clears all memories without deleting other LangGraph store namespaces', async () => {
    const store = openDatabase().memoryStore
    await store.put(['custom', 'namespace'], 'keep', { content: 'Keep this value' })
    await store.saveMemory({
      scope: 'global',
      kind: 'fact',
      content: 'Remove the global memory',
      keywords: ['remove-global'],
      importance: 3
    }, { origin: 'user' })
    await store.saveMemory({
      scope: 'project',
      projectId: 'project-1',
      kind: 'preference',
      content: 'Remove the project memory',
      keywords: ['remove-project'],
      importance: 4
    }, { origin: 'agent' })

    expect(store.clearMemories()).toBe(2)
    await expect(store.searchMemories()).resolves.toMatchObject({ total: 0, items: [] })
    await expect(store.searchMemories({ query: 'remove' })).resolves.toMatchObject({ total: 0, items: [] })
    await expect(store.get(['custom', 'namespace'], 'keep')).resolves.toMatchObject({
      value: { content: 'Keep this value' }
    })
  })

  it('returns freed database pages to disk when compacted after cleanup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anas-memory-compact-'))
    temporaryRoots.push(root)
    const file = getAgentCatalogFile(root)
    const database = AgentStorage.open(root)
    openDatabases.push(database)
    for (let index = 0; index < 32; index += 1) {
      await database.memoryStore.saveMemory({
        scope: 'global',
        kind: 'fact',
        content: `${index}: ${'memory content '.repeat(256)}`,
        keywords: [`memory-${index}`],
        importance: 3
      }, { origin: 'user' })
    }
    await database.compact()
    const populatedSize = (await stat(file)).size

    database.memoryStore.clearMemories()
    await database.compact()

    expect((await stat(file)).size).toBeLessThan(populatedSize)
  })

  it('searches English and Chinese memory text without an embedding model', async () => {
    const store = openDatabase().memoryStore
    await store.saveMemory({
      scope: 'global',
      kind: 'preference',
      content: 'Prefer concise TypeScript explanations.',
      keywords: ['TypeScript', 'concise'],
      importance: 4
    }, { origin: 'user' })
    await store.saveMemory({
      scope: 'global',
      kind: 'preference',
      content: 'Prefer concise Python explanations.',
      keywords: ['Python', 'concise'],
      importance: 4
    }, { origin: 'user' })
    await store.saveMemory({
      scope: 'project',
      projectId: 'project-1',
      kind: 'fact',
      content: '这个项目使用结构化长期记忆。',
      keywords: ['记忆系统'],
      importance: 5
    }, { origin: 'agent', sourceThreadId: 'thread-1' })

    await expect(store.searchMemories({ query: 'TypeScript concise' })).resolves.toMatchObject({
      total: 1,
      items: [{ kind: 'preference', scope: 'global' }]
    })
    await expect(store.searchMemories({ query: '结构化记忆' })).resolves.toMatchObject({
      total: 1,
      items: [{ kind: 'fact', projectId: 'project-1' }]
    })
  })

  it('requires lexical matches instead of accepting trigram fragments or metadata fields', async () => {
    const store = openDatabase().memoryStore
    await store.saveMemory({
      scope: 'global',
      kind: 'fact',
      content: 'Other notes said formatting belongs elsewhere.',
      keywords: ['formatting'],
      importance: 5
    }, { origin: 'agent' })
    await store.saveMemory({
      scope: 'global',
      kind: 'preference',
      content: 'The preferred formatter is Biome.',
      keywords: ['biome'],
      importance: 3
    }, { origin: 'user' })

    await expect(store.searchMemories({ query: 'the' })).resolves.toMatchObject({
      total: 1,
      items: [{ content: 'The preferred formatter is Biome.' }]
    })
    await expect(store.searchMemories({ query: 'ai' })).resolves.toMatchObject({ total: 0, items: [] })
    for (const query of ['fact', 'agent', 'importance']) {
      await expect(store.searchMemories({ query })).resolves.toMatchObject({ total: 0, items: [] })
    }
  })

  it('extracts Latin search terms next to CJK text without requiring spaces', async () => {
    const store = openDatabase().memoryStore
    await store.saveMemory({
      scope: 'global',
      kind: 'fact',
      content: 'SVN repositories live under the development directory.',
      keywords: ['svn'],
      importance: 4
    }, { origin: 'user' })

    for (const query of ['更新我的所有svn项目', '更新我的所有 svn 项目', '更新全部SVN仓库']) {
      await expect(store.searchMemories({ query })).resolves.toMatchObject({
        total: 1,
        items: [{ kind: 'fact', scope: 'global' }]
      })
    }
  })

  it('recalls only global and current-project records', async () => {
    const store = openDatabase().memoryStore
    for (const [scope, projectId, content] of [
      ['global', undefined, 'The build command is npm run build.'],
      ['project', 'project-1', 'Project one build command uses npm run build.'],
      ['project', 'project-2', 'Project two build command uses npm run build.']
    ] as const) {
      await store.saveMemory({
        scope,
        ...(projectId ? { projectId } : {}),
        kind: 'fact',
        content,
        keywords: ['build'],
        importance: 3
      }, { origin: 'user' })
    }

    const recalled = await store.relevantMemories('build command', 'project-1', 8)

    expect(recalled.map((memory) => memory.content)).toContain('The build command is npm run build.')
    expect(recalled.map((memory) => memory.content)).toContain('Project one build command uses npm run build.')
    expect(recalled.map((memory) => memory.content)).not.toContain('Project two build command uses npm run build.')
  })

  it('prevents agent writes and deletion from crossing project scope', async () => {
    const store = openDatabase().memoryStore
    const memory = await store.saveMemory({
      scope: 'project',
      projectId: 'project-2',
      kind: 'fact',
      content: 'Project two only',
      keywords: [],
      importance: 3
    }, { origin: 'user' })

    await expect(store.saveMemory({
      id: memory.id,
      scope: 'project',
      projectId: 'project-1',
      kind: 'fact',
      content: 'Cross-scope update',
      keywords: [],
      importance: 3
    }, { origin: 'agent', accessProjectId: 'project-1' })).rejects.toThrow('not available')
    await expect(store.deleteMemory(memory.id, 'project-1')).rejects.toThrow('not available')
    await expect(store.searchMemories({
      scope: 'project',
      projectId: 'project-2'
    })).resolves.toMatchObject({ total: 1 })
  })

  it('updates, moves, filters, and deletes individual records', async () => {
    const store = openDatabase().memoryStore
    const created = await store.saveMemory({
      scope: 'global',
      kind: 'fact',
      content: 'Initial fact',
      keywords: [],
      importance: 2
    }, { origin: 'user' })
    const updated = await store.saveMemory({
      id: created.id,
      scope: 'project',
      projectId: 'project-1',
      kind: 'experience',
      content: 'Updated project experience',
      keywords: ['updated'],
      importance: 5
    }, { origin: 'agent' })

    expect(updated).toMatchObject({
      id: created.id,
      createdAt: created.createdAt,
      scope: 'project',
      projectId: 'project-1',
      kind: 'experience',
      origin: 'user'
    })
    await expect(store.searchMemories({ scope: 'global' })).resolves.toMatchObject({ total: 0 })
    await expect(store.searchMemories({
      scope: 'project',
      projectId: 'project-1',
      kind: 'experience'
    })).resolves.toMatchObject({ total: 1 })

    await store.deleteMemory(created.id)

    await expect(store.searchMemories()).resolves.toMatchObject({ total: 0, items: [] })
  })
})
