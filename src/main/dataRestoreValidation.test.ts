import { defaultCapabilities, serializeCapabilities } from '@shared/agentCapabilities'
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentStorage } from './agent/agentStorage'
import { getAgentCatalogFile, getAgentConversationDatabaseFile } from './config/dataDir'
import { validateRestoredDataDirectory } from './dataRestoreValidation'

const temporaryDirectories: string[] = []

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'anas-restore-validation-'))
  temporaryDirectories.push(root)
  await cp(join(process.cwd(), 'data', 'config'), join(root, 'config'), { recursive: true })
  return root
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, value, 'utf8')
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('restored data validation', () => {
  it('accepts formal config, project, input history, Skill, custom tool, SQLite, and attachment state', async () => {
    const root = await fixture()
    await writeText(join(root, 'projects.json'), JSON.stringify({
      version: 4,
      projects: [{
 capabilities: serializeCapabilities(defaultCapabilities), restrict_subagents: false, coding_mode: false, advanced_settings: true, prompt: '',
        id: 'project-1',
        name: 'Project',
        kind: 'workspace',
        pinned: false,
        collapsed: false,
        sourceFolders: ['D:/workspace'],
        createdAt: '2026-08-10T00:00:00.000Z',
        updatedAt: '2026-08-10T00:00:00.000Z'
      }, {
 capabilities: serializeCapabilities(defaultCapabilities), restrict_subagents: false, coding_mode: false, advanced_settings: true, prompt: '',
        id: 'default-workspace',
        name: 'Default Workspace',
        kind: 'workspace',
        pinned: false,
        collapsed: false,
        sourceFolders: ['D:/default-workspace'],
        createdAt: '2026-08-10T00:00:00.000Z',
        updatedAt: '2026-08-10T00:00:00.000Z'
      }]
    }))
    await writeText(join(root, 'input_history.json'), JSON.stringify({
      version: 1,
      maxHistory: 10,
      items: []
    }))
    await writeText(join(root, 'skills', 'sample', 'SKILL.md'), '---\nname: sample\ndescription: Sample skill\n---\nBody\n')
    await cp(join(process.cwd(), 'data/tools_examples/read_text_raw'), join(root, 'tools/read_text_raw'), { recursive: true })
    await writeText(join(root, 'config/tools.json'), JSON.stringify({ order: ['user:example-read-text-raw'] }))
    const storage = AgentStorage.open(root)
    storage.createThread({ projectId: 'project-1', title: 'Project conversation' })
    storage.createThread({ title: 'Default conversation' })
    storage.close()

    await expect(validateRestoredDataDirectory(root)).resolves.toBeUndefined()
  })

  it('rejects invalid tool settings or a non-directory tools root before restore', async () => {
    const root = await fixture()
    await writeText(join(root, 'config/tools.json'), JSON.stringify({ order: 'invalid' }))
    await expect(validateRestoredDataDirectory(root)).rejects.toThrow('Invalid tool settings')
    await writeText(join(root, 'config/tools.json'), JSON.stringify({ order: [] }))
    await writeText(join(root, 'tools'), 'not a directory')
    await expect(validateRestoredDataDirectory(root)).rejects.toThrow('Restored tools must be a directory')
  })

  it('rejects malformed and semantically invalid configuration', async () => {
    const root = await fixture()
    await writeText(join(root, 'config', 'settings.json'), '{not json')
    await expect(validateRestoredDataDirectory(root)).rejects.toThrow()

    await cp(join(process.cwd(), 'data', 'config', 'settings.json'), join(root, 'config', 'settings.json'), { force: true })
    const parsed = JSON.parse(await readFile(join(root, 'config', 'settings.json'), 'utf8')) as Record<string, unknown>
    parsed.default_model_id = 'missing-model'
    await writeText(join(root, 'config', 'settings.json'), JSON.stringify(parsed))
    await expect(validateRestoredDataDirectory(root)).rejects.toThrow('Default model configuration ID')

    const skillsRoot = await fixture()
    await writeText(join(skillsRoot, 'config', 'skills.json'), JSON.stringify({ external_directories: 'invalid', availability: {} }))
    await expect(validateRestoredDataDirectory(skillsRoot)).rejects.toThrow('Skills configuration is invalid')
  })

  it('rejects a corrupt catalog instead of activating it', async () => {
    const root = await fixture()
    await writeText(getAgentCatalogFile(root), 'not a sqlite database')
    await expect(validateRestoredDataDirectory(root)).rejects.toThrow()
  })

  it('rejects a corrupt conversation from the otherwise valid catalog', async () => {
    const root = await fixture()
    const storage = AgentStorage.open(root)
    const thread = storage.createThread()
    storage.close()
    await writeText(getAgentConversationDatabaseFile(thread.id, root), 'not a sqlite database')

    await expect(validateRestoredDataDirectory(root)).rejects.toThrow()
  })

  it('rejects a missing conversation instead of restoring an incomplete catalog', async () => {
    const root = await fixture()
    const storage = AgentStorage.open(root)
    const thread = storage.createThread()
    storage.close()
    await rm(getAgentConversationDatabaseFile(thread.id, root))

    await expect(validateRestoredDataDirectory(root)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects conversation files absent from the catalog', async () => {
    const root = await fixture()
    const storage = AgentStorage.open(root)
    storage.close()
    await writeText(getAgentConversationDatabaseFile('unlisted', root), 'unlisted content')

    await expect(validateRestoredDataDirectory(root)).rejects.toThrow('Unexpected conversation storage entry: unlisted.sqlite')
  })

  it('rejects valid conversation databases exchanged between catalog entries', async () => {
    const root = await fixture()
    const storage = AgentStorage.open(root)
    const first = storage.createThread()
    const second = storage.createThread()
    storage.close()
    const firstFile = getAgentConversationDatabaseFile(first.id, root)
    const secondFile = getAgentConversationDatabaseFile(second.id, root)
    const temporary = join(root, 'swap.sqlite')
    await rename(firstFile, temporary)
    await rename(secondFile, firstFile)
    await rename(temporary, secondFile)

    await expect(validateRestoredDataDirectory(root)).rejects.toThrow('Conversation database does not belong to')
  })

  it('rejects a thread whose project is absent from the restored project store', async () => {
    const root = await fixture()
    const storage = AgentStorage.open(root)
    storage.createThread({ projectId: 'missing-project' })
    storage.close()

    await expect(validateRestoredDataDirectory(root)).rejects.toThrow(
      'references missing project missing-project'
    )
  })

  it('rejects invalid project and Skill data', async () => {
    const projectRoot = await fixture()
    await writeText(join(projectRoot, 'projects.json'), JSON.stringify({ version: 4, projects: [{ id: 1 }] }))
    await expect(validateRestoredDataDirectory(projectRoot)).rejects.toThrow('Project 1')

    const skillRoot = await fixture()
    await writeText(join(skillRoot, 'skills', 'broken', 'SKILL.md'), 'missing front matter')
    await expect(validateRestoredDataDirectory(skillRoot)).rejects.toThrow('Invalid skill broken')
  })
})
