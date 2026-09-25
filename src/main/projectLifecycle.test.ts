import { defaultCapabilities, } from '@shared/agentCapabilities'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_WORKSPACE_PROJECT_ID } from '@shared/types'

const paths = vi.hoisted(() => ({ projectFile: '' }))

vi.mock('./config/dataDir', async (importOriginal) => ({
  ...await importOriginal<typeof import('./config/dataDir')>(),
  getProjectStoreFile: () => paths.projectFile,
  getDefaultWorkspaceDir: () => join(root, 'default-workspace')
}))

vi.mock('./runtimeLogger', () => ({ runtimeLog: vi.fn() }))

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'anas-project-lifecycle-'))
  paths.projectFile = join(root, 'projects.json')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('project deletion lifecycle', () => {
  it.each(['simple_chat', 'default'] as const)('clears %s conversations while preserving the project, memories, and other projects', async (kind) => {
    const [{ AgentStorage }, { AgentRuntimeCoordinator }, projectStore] = await Promise.all([
      import('./agent/agentStorage'),
      import('./agent/agentRuntimeCoordinator'),
      import('./projectStore')
    ])
    const project = kind === 'default'
      ? await projectStore.getProject(DEFAULT_WORKSPACE_PROJECT_ID)
      : await projectStore.createProject({ kind: 'simple_chat', name: 'Chat', prompt: '' })
    const storage = AgentStorage.open(root)
    const runtime = new AgentRuntimeCoordinator(storage)
    try {
      const first = storage.createThread({ projectId: project.id })
      const second = storage.createThread({ projectId: project.id })
      storage.updateThread(second.id, { pinned: true })
      const other = storage.createThread({ projectId: 'other-project' })
      await storage.memoryStore.saveMemory({ scope: 'project', projectId: project.id,
        kind: 'fact', content: 'Keep this project memory', keywords: ['keep'], importance: 3 }, { origin: 'user' })

      const result = await runtime.deleteProjectThreads(project.id)

      expect(new Set(result.deletedThreadIds)).toEqual(new Set([first.id, second.id]))
      expect(storage.getThread(first.id)).toBeNull()
      expect(storage.getThread(second.id)).toBeNull()
      expect(storage.getThread(other.id)).not.toBeNull()
      expect(await projectStore.getProject(project.id)).toEqual(project)
      await expect(storage.memoryStore.searchMemories({ scope: 'project', projectId: project.id }))
        .resolves.toMatchObject({ total: 1 })
      await expect(runtime.deleteProjectThreads(project.id)).resolves.toMatchObject({ deletedThreadIds: [] })
      await expect(runtime.deleteProjectThreads('missing')).rejects.toThrow('was not found')
      expect(storage.getThread(other.id)).not.toBeNull()
    } finally {
      await runtime.shutdown()
      storage.close()
    }
  }, 15_000)

  it.each(['running', 'interrupted'] as const)('keeps all project conversations when one is %s', async (status) => {
    const [{ AgentStorage }, { AgentRuntimeCoordinator }, projectStore] = await Promise.all([
      import('./agent/agentStorage'), import('./agent/agentRuntimeCoordinator'), import('./projectStore')
    ])
    const project = await projectStore.createProject({ kind: 'simple_chat', name: 'Chat', prompt: '' })
    const storage = AgentStorage.open(root)
    const runtime = new AgentRuntimeCoordinator(storage)
    try {
      const idle = storage.createThread({ projectId: project.id })
      const busy = storage.createThread({ projectId: project.id })
      storage.conversationForThread(busy.id).updateThread(busy.id, { status })
      storage.refreshConversation(busy.id)
      await expect(runtime.deleteProjectThreads(project.id)).rejects.toThrow('is busy')
      expect(storage.getThread(idle.id)).not.toBeNull()
      expect(storage.getThread(busy.id)).not.toBeNull()
    } finally {
      await runtime.shutdown()
      storage.close()
    }
  }, 15_000)

  it('removes every conversation database before removing the project metadata', async () => {
    const [{ AgentStorage }, { AgentRuntimeCoordinator }, projectStore] = await Promise.all([
      import('./agent/agentStorage'),
      import('./agent/agentRuntimeCoordinator'),
      import('./projectStore')
    ])
    const source = join(root, 'source')
    await mkdir(source)
    const project = await projectStore.createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '', kind: 'workspace', name: 'Project', sourceFolders: [source] })
    const storage = AgentStorage.open(root)
    const runtime = new AgentRuntimeCoordinator(storage)
    try {
      const first = storage.createThread({ projectId: project.id })
      const second = storage.createThread({ projectId: project.id })
      const other = storage.createThread({ projectId: 'other-project' })

      const result = await runtime.deleteProject(project.id)

      expect(result.projectId).toBe(project.id)
      expect(new Set(result.deletedThreadIds)).toEqual(new Set([first.id, second.id]))
      expect(await projectStore.listProjects()).toEqual([
        expect.objectContaining({ id: DEFAULT_WORKSPACE_PROJECT_ID })
      ])
      expect(storage.getThread(first.id)).toBeNull()
      expect(storage.getThread(second.id)).toBeNull()
      expect(storage.getThread(other.id)).not.toBeNull()
    } finally {
      await runtime.shutdown()
      storage.close()
    }
  }, 15_000)

  it('rejects the whole deletion while any project thread is active or interrupted', async () => {
    const [{ AgentStorage }, { AgentRuntimeCoordinator }, projectStore] = await Promise.all([
      import('./agent/agentStorage'),
      import('./agent/agentRuntimeCoordinator'),
      import('./projectStore')
    ])
    const source = join(root, 'source')
    await mkdir(source)
    const project = await projectStore.createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '', kind: 'workspace', name: 'Project', sourceFolders: [source] })
    const storage = AgentStorage.open(root)
    const runtime = new AgentRuntimeCoordinator(storage)
    try {
      const thread = storage.createThread({ projectId: project.id })
      storage.conversationForThread(thread.id).updateThread(thread.id, { status: 'interrupted' })
      storage.refreshConversation(thread.id)

      await expect(runtime.deleteProject(project.id)).rejects.toThrow('is busy')

      expect(await projectStore.listProjects()).toEqual([
        project,
        expect.objectContaining({ id: DEFAULT_WORKSPACE_PROJECT_ID })
      ])
      expect(storage.getThread(thread.id)).not.toBeNull()
    } finally {
      await runtime.shutdown()
      storage.close()
    }
  }, 15_000)
})
