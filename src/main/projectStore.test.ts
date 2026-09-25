import { defaultCapabilities, } from '@shared/agentCapabilities'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_WORKSPACE_PROJECT_ID, type Project, type ProjectCreateRequest } from '@shared/types'
import { serializeCapabilities } from '@shared/agentCapabilities'

function storedProjectJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (item?.kind !== 'workspace' || !item.capabilities) return item
    const { restrictSubagents, capabilities, advancedSettings, codingMode, ...metadata } = item
    return { ...metadata, restrict_subagents: restrictSubagents, advanced_settings: advancedSettings, coding_mode: codingMode, capabilities: serializeCapabilities(capabilities) }
  })
}

const storePaths = vi.hoisted(() => ({
  projectFile: ''
}))

vi.mock('./config/dataDir', () => ({
  getProjectStoreFile: () => storePaths.projectFile,
  getDefaultWorkspaceDir: () => join(tempDir, 'default-workspace')
}))

let tempDir = ''

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'anas-project-store-'))
  storePaths.projectFile = join(tempDir, 'projects.json')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('project store', () => {
  it('validates a project preview without creating or updating stored projects', async () => {
    const store = await import('./projectStore')
    const saved = await store.createProject({ kind: 'simple_chat', name: 'Saved', prompt: 'Original' })
    const before = await readFile(storePaths.projectFile, 'utf8')
    const preview = await store.prepareProjectPreview({
      kind: 'workspace', name: 'Unsaved', prompt: 'Draft instructions', sourceFolders: [tempDir],
      capabilities: defaultCapabilities, restrictSubagents: false, advancedSettings: true, codingMode: true
    }, saved.id)
    expect(preview).toMatchObject({ id: saved.id, prompt: 'Draft instructions', sourceFolders: [tempDir], codingMode: true })
    expect(await readFile(storePaths.projectFile, 'utf8')).toBe(before)
    await expect(store.prepareProjectPreview({ kind: 'simple_chat', name: 'Invalid', prompt: 42 } as unknown as ProjectCreateRequest))
      .rejects.toThrow('prompt')
  })

  it('shares first initialization between concurrent readers and a project creation', async () => {
    const store = await import('./projectStore')
    const results = await Promise.all([
      ...Array.from({ length: 30 }, () => store.listProjects()),
      store.createProject({ kind: 'simple_chat', name: 'Created during startup', prompt: '' })
    ])
    const created = results.at(-1) as Project
    const projects = await store.listProjects()
    expect(projects.map(project => project.id).sort()).toEqual([DEFAULT_WORKSPACE_PROJECT_ID, created.id].sort())
    const timestamps = results.slice(0, -1).map(projects => (projects as Project[]).find(project => project.id === DEFAULT_WORKSPACE_PROJECT_ID)?.createdAt)
    expect(new Set(timestamps).size).toBe(1)
    expect(await store.getProject(created.id)).toEqual(created)
  })

  it('persists project subagent selections independently of capability limits and allows clearing the override', async () => {
    const store = await import('./projectStore')
    const folder = join(tempDir, 'selection')
    await mkdir(folder)
    const request = { kind: 'workspace' as const, name: 'Selected agents', sourceFolders: [folder],
      codingMode: false, advancedSettings: true, prompt: '', capabilities: structuredClone(defaultCapabilities), restrictSubagents: false,
      subagentSelection: { mode: 'custom' as const, names: ['general-purpose', 'removed-agent'] } }
    const created = await store.createProject(request)
    expect((await store.getProject(created.id))).toMatchObject({ subagentSelection: request.subagentSelection, restrictSubagents: false })
    const raw = JSON.parse(await readFile(storePaths.projectFile, 'utf8')).projects.find((item: Project) => item.id === created.id)
    expect(raw.subagent_selection).toEqual(request.subagentSelection)
    expect(raw).not.toHaveProperty('subagentSelection')
    await store.updateProject(created.id, { ...request, subagentSelection: { mode: 'custom', names: [] }, restrictSubagents: true })
    expect(await store.getProject(created.id)).toMatchObject({ subagentSelection: { mode: 'custom', names: [] }, restrictSubagents: true })
    await expect(store.updateProject(created.id, { ...request, subagentSelection: { mode: 'custom', names: ['bad name'] } })).rejects.toThrow()
    expect(await store.getProject(created.id)).toMatchObject({ subagentSelection: { mode: 'custom', names: [] } })
    await store.updateProject(created.id, { ...request, subagentSelection: undefined })
    expect(await store.getProject(created.id)).not.toHaveProperty('subagentSelection')
  })

  it('defaults coding mode off and round trips it independently of advanced settings', async () => {
    const store = await import('./projectStore')
    expect(await store.getProject(DEFAULT_WORKSPACE_PROJECT_ID)).toMatchObject({ codingMode: false })
    const folder = join(tempDir, 'coding')
    await mkdir(folder)
    const request = { kind: 'workspace' as const, name: 'Coding', sourceFolders: [folder], codingMode: true,
      advancedSettings: false, prompt: '', capabilities: structuredClone(defaultCapabilities), restrictSubagents: false }
    const created = await store.createProject(request)
    expect(await store.getProject(created.id)).toEqual(created)
    expect(created).toMatchObject({ codingMode: true, advancedSettings: false })
    const raw = JSON.parse(await readFile(storePaths.projectFile, 'utf8'))
    const stored = raw.projects.find((item: Project) => item.id === created.id)
    expect(stored.coding_mode).toBe(true)
    expect(stored).not.toHaveProperty('codingMode')
    for (const value of [undefined, null, 'true', 1]) {
      await expect(store.updateProject(created.id, { ...request, codingMode: value } as unknown as ProjectCreateRequest))
        .rejects.toThrow('coding mode')
      await expect(store.createProject({ ...request, name: 'Invalid mode', codingMode: value } as unknown as ProjectCreateRequest))
        .rejects.toThrow('coding mode')
    }
    expect(await store.getProject(created.id)).toEqual(created)
    expect(await store.updateProject(created.id, { ...request, codingMode: false })).toMatchObject({ codingMode: false })
    expect(await store.getProject(created.id)).toMatchObject({ codingMode: false })
    stored.coding_mode = 'false'
    await writeFile(storePaths.projectFile, JSON.stringify(raw))
    await expect(store.getProject(created.id)).rejects.toThrow('coding mode')
    expect(JSON.parse(await readFile(storePaths.projectFile, 'utf8'))).toEqual(raw)
  })

  it('retains advanced values while disabled and persists the switch in snake_case', async () => {
    const store = await import('./projectStore')
    const folder = join(tempDir, 'advanced')
    await mkdir(folder)
    const request = { kind: 'workspace' as const, name: 'Advanced', sourceFolders: [folder], codingMode: false, advancedSettings: true,
      prompt: 'Project instructions', capabilities: { ...structuredClone(defaultCapabilities), workspace: false }, restrictSubagents: true }
    const created = await store.createProject(request)
    const disabled = await store.updateProject(created.id, { ...request, advancedSettings: false })
    expect(await store.getProject(created.id)).toEqual(disabled)
    expect(disabled).toMatchObject({ advancedSettings: false, prompt: request.prompt, capabilities: request.capabilities, restrictSubagents: true })
    const raw = JSON.parse(await readFile(storePaths.projectFile, 'utf8')).projects.find((item: Project) => item.id === created.id)
    expect(raw.advanced_settings).toBe(false)
    expect(raw).not.toHaveProperty('advancedSettings')
    expect(await store.updateProject(created.id, request)).toMatchObject({ advancedSettings: true, prompt: request.prompt })
    await expect(store.updateProject(created.id, { ...request, advancedSettings: 'yes' } as unknown as ProjectCreateRequest)).rejects.toThrow('advanced settings')
  })

  it('persists project model settings in snake_case and clears both selections together', async () => {
    const store = await import('./projectStore')
    const project = await store.createProject({
      kind: 'simple_chat', name: 'Model preference', prompt: '',
      modelConfigId: 'project-model', modelParameterPresetId: null
    })
    expect(await store.getProject(project.id)).toEqual(project)
    const raw = JSON.parse(await readFile(storePaths.projectFile, 'utf8'))
      .projects.find((item: Project) => item.id === project.id)
    expect(raw).toMatchObject({ model_config_id: 'project-model', model_parameter_preset_id: null })
    expect(raw).not.toHaveProperty('modelConfigId')
    expect(raw).not.toHaveProperty('modelParameterPresetId')
    const updated = await store.updateProject(project.id, {
      kind: 'simple_chat', name: project.name, prompt: '',
      modelConfigId: 'project-model', modelParameterPresetId: 'thinking-on'
    })
    expect(await store.getProject(project.id)).toEqual(updated)
    const cleared = await store.updateProject(project.id, { kind: 'simple_chat', name: project.name, prompt: '' })
    expect(cleared).not.toHaveProperty('modelConfigId')
    expect(cleared).not.toHaveProperty('modelParameterPresetId')
    expect(await store.getProject(project.id)).toEqual(cleared)
  })

  it.each([
    { modelConfigId: 3 }, { modelConfigId: '' },
    { modelConfigId: 'model', modelParameterPresetId: 3 },
    { modelConfigId: 'model', modelParameterPresetId: '' },
    { modelParameterPresetId: 'preset' }, { modelParameterPresetId: null }
  ])('rejects malformed project model preferences: %j', async (selection) => {
    const store = await import('./projectStore')
    await expect(store.createProject({ kind: 'simple_chat', name: 'Invalid', prompt: '', ...selection } as ProjectCreateRequest))
      .rejects.toThrow(/Project model/)
  })

  it('preserves unavailable model references and surviving project preferences through deletion', async () => {
    const store = await import('./projectStore')
    const preferred = await store.createProject({
      kind: 'simple_chat', name: 'Keep', prompt: '', modelConfigId: 'deleted-model', modelParameterPresetId: 'deleted-preset'
    })
    const removed = await store.createProject({ kind: 'simple_chat', name: 'Remove', prompt: '' })
    await store.deleteProjectWithThreads(removed.id, [], (commit) => commit())
    expect(await store.getProject(preferred.id)).toEqual(preferred)
    const previous = JSON.parse(await readFile(storePaths.projectFile, 'utf8'))
    const next = { ...previous, projects: previous.projects.filter((item: Project) => item.id !== preferred.id) }
    await writeFile(`${storePaths.projectFile}.delete-journal`, JSON.stringify({
      version: 4, projectId: preferred.id, threadIds: ['thread'], previous, next
    }), 'utf8')
    await writeFile(storePaths.projectFile, JSON.stringify(next), 'utf8')
    await store.recoverProjectDeletion(() => true, vi.fn())
    expect(await store.getProject(preferred.id)).toEqual(preferred)
  })

  it('creates and lists a project with canonical absolute source folders', async () => {
    const firstFolder = join(tempDir, 'source')
    const secondFolder = join(tempDir, 'docs')
    await Promise.all([
      mkdir(firstFolder, { recursive: true }),
      mkdir(secondFolder, { recursive: true })
    ])
    const { createProject, listProjects } = await import('./projectStore')

    const project = await createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '',
      kind: 'workspace',
      name: '  My   Project  ',
      sourceFolders: [firstFolder, secondFolder, firstFolder]
    })

    expect(project.name).toBe('My Project')
    expect(project).toMatchObject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '',
      kind: 'workspace',
      pinned: false,
      collapsed: false,
      sourceFolders: [firstFolder, secondFolder]
    })
    expect(await listProjects()).toEqual([
      project,
      expect.objectContaining({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: false, prompt: '', id: DEFAULT_WORKSPACE_PROJECT_ID, kind: 'workspace' })
    ])
  })

  it('requires at least one existing directory and a unique name', async () => {
    const sourceFolder = join(tempDir, 'source')
    await mkdir(sourceFolder, { recursive: true })
    const { createProject } = await import('./projectStore')

    await expect(createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '', kind: 'workspace', name: 'Example', sourceFolders: [] }))
      .rejects.toThrow('At least one source folder is required.')
    await expect(createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '', kind: 'workspace', name: 'Example', sourceFolders: [join(tempDir, 'missing')] }))
      .rejects.toThrow()

    await createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '', kind: 'workspace', name: 'Example', sourceFolders: [sourceFolder] })
    await expect(createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '', kind: 'workspace', name: 'example', sourceFolders: [sourceFolder] }))
      .rejects.toThrow('already exists')
  })

  it('creates and updates a simple chat project with an optional prompt', async () => {
    const { createProject, updateProject } = await import('./projectStore')

    const project = await createProject({
      kind: 'simple_chat',
      name: '  Plain   chat  ',
      prompt: '  Answer only from this conversation.  '
    })

    expect(project).toMatchObject({
      kind: 'simple_chat',
      name: 'Plain chat',
      prompt: 'Answer only from this conversation.'
    })
    const emptyPrompt = await createProject({ kind: 'simple_chat', name: '未命名项目', prompt: '   ' })
    expect(emptyPrompt).toMatchObject({
      kind: 'simple_chat',
      name: '未命名项目',
      prompt: ''
    })
    await expect(createProject({ kind: 'simple_chat', name: '   ', prompt: '' }))
      .rejects.toThrow('Project name is required.')

    const updated = await updateProject(project.id, {
      kind: 'simple_chat',
      name: 'Plain chat',
      prompt: 'Be concise.'
    })
    expect(updated).toMatchObject({ kind: 'simple_chat', prompt: 'Be concise.' })
    await expect(updateProject(project.id, {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '',
      kind: 'workspace',
      name: 'Plain chat',
      sourceFolders: []
    })).rejects.toThrow('kind cannot be changed')
  })

  it('persists project appearance and clears it when automatic defaults are selected', async () => {
    const { createProject, updateProject } = await import('./projectStore')
    const project = await createProject({
      kind: 'simple_chat',
      name: 'Styled chat',
      icon: 'heart',
      iconColor: 'pink',
      prompt: ''
    })

    expect(project).toMatchObject({ icon: 'heart', iconColor: 'pink' })

    const updated = await updateProject(project.id, {
      kind: 'simple_chat',
      name: project.name,
      prompt: ''
    })
    expect(updated).not.toHaveProperty('icon')
    expect(updated).not.toHaveProperty('iconColor')

    await expect(createProject({
      kind: 'simple_chat',
      name: 'Invalid icon',
      icon: 'unknown' as 'folder',
      prompt: ''
    })).rejects.toThrow('Project icon is invalid.')
  })

  it('persists project pin and collapse state without changing its update timestamp', async () => {
    const sourceFolder = join(tempDir, 'source')
    await mkdir(sourceFolder, { recursive: true })
    const { createProject, listProjects, updateProjectState } = await import('./projectStore')
    const first = await createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '', kind: 'workspace', name: 'First', sourceFolders: [sourceFolder] })
    const second = await createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '', kind: 'workspace', name: 'Second', sourceFolders: [sourceFolder] })

    const updated = await updateProjectState(first.id, { pinned: true, collapsed: true })

    expect(updated).toMatchObject({ pinned: true, collapsed: true, updatedAt: first.updatedAt })
    expect((await listProjects()).map((project) => project.id)).toEqual([
      first.id,
      second.id,
      DEFAULT_WORKSPACE_PROJECT_ID
    ])
    await expect(updateProjectState(first.id, {})).rejects.toThrow('state update is invalid')
    await expect(updateProjectState('missing', { pinned: true })).rejects.toThrow('not found')
  })

  it('updates a project while preserving its identifier and validates unique names', async () => {
    const firstFolder = join(tempDir, 'first')
    const secondFolder = join(tempDir, 'second')
    await Promise.all([
      mkdir(firstFolder, { recursive: true }),
      mkdir(secondFolder, { recursive: true })
    ])
    const { createProject, listProjects, updateProject } = await import('./projectStore')
    const first = await createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '', kind: 'workspace', name: 'First', sourceFolders: [firstFolder] })
    await createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '', kind: 'workspace', name: 'Second', sourceFolders: [secondFolder] })

    const updated = await updateProject(first.id, {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '',
      kind: 'workspace',
      name: '  Updated   Project ',
      sourceFolders: [secondFolder, firstFolder, secondFolder]
    })

    expect(updated).toMatchObject({
      id: first.id,
      name: 'Updated Project',
      sourceFolders: [secondFolder, firstFolder],
      createdAt: first.createdAt
    })
    expect((await listProjects()).find((project) => project.id === first.id)).toEqual(updated)
    await expect(updateProject(first.id, {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '', kind: 'workspace', name: 'second', sourceFolders: [firstFolder] }))
      .rejects.toThrow('already exists')
    await expect(updateProject('missing', {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '', kind: 'workspace', name: 'Missing', sourceFolders: [firstFolder] }))
      .rejects.toThrow('not found')
  })

  it('canonicalizes dropped source folders and rejects dropped files', async () => {
    const sourceFolder = join(tempDir, 'source')
    const sourceFile = join(tempDir, 'file.txt')
    await mkdir(sourceFolder, { recursive: true })
    await writeFile(sourceFile, 'not a folder', 'utf8')
    const { validateProjectSourceFolders } = await import('./projectStore')

    await expect(validateProjectSourceFolders([sourceFolder, sourceFolder]))
      .resolves.toEqual([sourceFolder])
    await expect(validateProjectSourceFolders([sourceFile]))
      .rejects.toThrow(`Source folder is not a directory: ${sourceFile}`)
  })

  it('commits project JSON only through the owning thread lifecycle', async () => {
    const sourceFolder = join(tempDir, 'source')
    await mkdir(sourceFolder, { recursive: true })
    const { createProject, deleteProjectWithThreads, listProjects } = await import('./projectStore')
    const project = await createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '', kind: 'workspace', name: 'Disposable', sourceFolders: [sourceFolder] })

    await deleteProjectWithThreads(project.id, [], (commit) => commit())

    expect(await listProjects()).toEqual([
      expect.objectContaining({ id: DEFAULT_WORKSPACE_PROJECT_ID })
    ])
  })

  it('serializes concurrent project mutations without losing updates', async () => {
    const sourceFolder = join(tempDir, 'source')
    await mkdir(sourceFolder, { recursive: true })
    const { createProject, listProjects, updateProject } = await import('./projectStore')

    const [first, second, third] = await Promise.all([
      createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '', kind: 'workspace', name: 'First', sourceFolders: [sourceFolder] }),
      createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '', kind: 'workspace', name: 'Second', sourceFolders: [sourceFolder] }),
      createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '', kind: 'workspace', name: 'Third', sourceFolders: [sourceFolder] })
    ])
    await Promise.all([
      updateProject(first.id, {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '', kind: 'workspace', name: 'First updated', sourceFolders: [sourceFolder] }),
      updateProject(second.id, {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '', kind: 'workspace', name: 'Second updated', sourceFolders: [sourceFolder] })
    ])

    expect((await listProjects()).filter((project) => project.id !== DEFAULT_WORKSPACE_PROJECT_ID).map((project) => project.id).sort()).toEqual(
      [first.id, second.id, third.id].sort()
    )
    expect((await listProjects()).filter((project) => project.id !== DEFAULT_WORKSPACE_PROJECT_ID).map((project) => project.name).sort()).toEqual([
      'First updated',
      'Second updated',
      'Third'
    ])
  })

  it('restores project JSON when the database commit callback fails after rename', async () => {
    const sourceFolder = join(tempDir, 'source')
    await mkdir(sourceFolder, { recursive: true })
    const { createProject, deleteProjectWithThreads, listProjects } = await import('./projectStore')
    const project = await createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '', kind: 'workspace', name: 'Keep', sourceFolders: [sourceFolder] })

    await expect(deleteProjectWithThreads(project.id, ['thread-1'], (commit) => {
      commit()
      throw new Error('database commit failed')
    })).rejects.toThrow('database commit failed')

    expect(await listProjects()).toEqual([
      project,
      expect.objectContaining({ id: DEFAULT_WORKSPACE_PROJECT_ID })
    ])
  })

  it('uses durable thread truth to finish or roll back an interrupted deletion', async () => {
    const sourceFolder = join(tempDir, 'source')
    await mkdir(sourceFolder, { recursive: true })
    const store = await import('./projectStore')
    const project = await store.createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '', kind: 'workspace', name: 'Crash', sourceFolders: [sourceFolder] })
    const previous = { version: 4, projects: await store.listProjects() }
    const next = {
      version: 4,
      projects: previous.projects.filter((item) => item.id !== project.id)
    }
    const journal = {
      version: 4,
      projectId: project.id,
      threadIds: ['thread-1'],
      previous,
      next
    }
    await writeFile(`${storePaths.projectFile}.delete-journal`, storedProjectJson(journal), 'utf8')
    await writeFile(storePaths.projectFile, storedProjectJson(next), 'utf8')

    const completeDatabaseCommit = vi.fn()
    await expect(store.recoverProjectDeletion(
      (id) => id === 'thread-1',
      completeDatabaseCommit
    )).resolves.toBe(true)
    expect(await store.listProjects()).toEqual(previous.projects)
    expect(completeDatabaseCommit).not.toHaveBeenCalled()

    await writeFile(`${storePaths.projectFile}.delete-journal`, storedProjectJson(journal), 'utf8')
    await writeFile(storePaths.projectFile, storedProjectJson(previous), 'utf8')
    await expect(store.recoverProjectDeletion(
      () => false,
      completeDatabaseCommit
    )).resolves.toBe(true)
    expect(await store.listProjects()).toEqual(next.projects)
    expect(completeDatabaseCommit).toHaveBeenCalledOnce()
    expect(completeDatabaseCommit).toHaveBeenCalledWith(project.id)
  })

  it('finishes database cleanup when an interrupted deletion has no conversations', async () => {
    const sourceFolder = join(tempDir, 'source')
    await mkdir(sourceFolder, { recursive: true })
    const store = await import('./projectStore')
    const project = await store.createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '', kind: 'workspace', name: 'Empty', sourceFolders: [sourceFolder] })
    const previous = { version: 4, projects: await store.listProjects() }
    const next = {
      version: 4,
      projects: previous.projects.filter((item) => item.id !== project.id)
    }
    const journal = {
      version: 4,
      projectId: project.id,
      threadIds: [],
      previous,
      next
    }
    await writeFile(`${storePaths.projectFile}.delete-journal`, storedProjectJson(journal), 'utf8')
    await writeFile(storePaths.projectFile, storedProjectJson(next), 'utf8')
    const completeDatabaseCommit = vi.fn()

    await expect(store.recoverProjectDeletion(
      () => false,
      completeDatabaseCommit
    )).resolves.toBe(true)

    expect(completeDatabaseCommit).toHaveBeenCalledOnce()
    expect(completeDatabaseCommit).toHaveBeenCalledWith(project.id)
    expect(await store.listProjects()).toEqual(next.projects)
  })

  it('keeps the editable default workspace last and rejects pinning or deletion', async () => {
    const sourceFolder = join(tempDir, 'custom-default')
    await mkdir(sourceFolder, { recursive: true })
    const store = await import('./projectStore')
    const initial = await store.getProject(DEFAULT_WORKSPACE_PROJECT_ID)

    const updated = await store.updateProject(DEFAULT_WORKSPACE_PROJECT_ID, {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '',
      kind: 'workspace',
      name: 'Personal Workspace',
      icon: 'folder',
      modelConfigId: 'workspace-model',
      modelParameterPresetId: null,
      sourceFolders: [sourceFolder]
    })

    expect(updated).toMatchObject({
      id: DEFAULT_WORKSPACE_PROJECT_ID,
      name: 'Personal Workspace',
      modelConfigId: 'workspace-model',
      modelParameterPresetId: null,
      sourceFolders: [sourceFolder]
    })
    expect(updated.createdAt).toBe(initial.createdAt)
    await expect(store.updateProjectState(DEFAULT_WORKSPACE_PROJECT_ID, { pinned: true }))
      .rejects.toThrow('fixed position')
    await expect(store.deleteProjectWithThreads(DEFAULT_WORKSPACE_PROJECT_ID, [], (commit) => commit()))
      .rejects.toThrow('cannot be deleted')
    expect((await store.listProjects()).at(-1)).toEqual(updated)
  })
})
