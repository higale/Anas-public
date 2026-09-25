import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import settings from '../../data/config/settings.json'
import subagents from '../../data/config/subagents.json'
import models from '../../data/config/models.json'
import capabilities from '../../data/config/capabilities.json'
import { DEFAULT_WORKSPACE_PROJECT_ID } from '@shared/types'
import { inspectRecoveryRepair, repairDocument, repairRecoveryData } from './recoveryRepair'
import { preserveRecoveryData } from './recoveryData'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'anas-field-repair-'))
  roots.push(root)
  const data = join(root, 'data')
  await mkdir(join(data, 'config'), { recursive: true })
  for (const file of ['capabilities.json', 'settings.json', 'subagents.json', 'models.json', 'mcp_servers.json', 'tools.json', 'skills.json']) {
    await writeFile(join(data, 'config', file), await readFile(join(process.cwd(), 'data/config', file)))
  }
  return { root, data }
}

describe('field-level recovery', () => {
  it('retains per-server MCP policies and only repairs missing domain defaults on explicit recovery', () => {
    const raw: any = structuredClone(subagents)
    const custom = { default_mode: 'selected', servers: [{ id: 'offline', mode: 'all', tools: ['remembered'] }] }
    raw.subagents[0].capabilities.mcp = custom
    delete raw.subagents[1].capabilities.mcp
    const repaired = repairDocument('subagents.json', raw)
    const agents = repaired.value.subagents as any[]
    expect(agents[0].capabilities.mcp).toEqual(custom)
    expect(agents[1].capabilities.mcp).toEqual(subagents.subagents[1].capabilities.mcp)
    expect(repaired.fields.join('\n')).toContain('subagents[1].capabilities.mcp')
    raw.subagents[0].capabilities.mcp.servers[0].mode = 'invalid'
    expect(() => repairDocument('subagents.json', raw)).toThrow('Invalid MCP server tool mode')
  })

  it.each([undefined, null, 'true', 1, false, true])('repairs invalid coding mode %s only through explicit recovery', (codingMode) => {
    const project = { id: DEFAULT_WORKSPACE_PROJECT_ID, kind: 'workspace', name: 'Keep',
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
      coding_mode: codingMode, advanced_settings: false, capabilities }
    const result = repairDocument('projects.json', { version: 4, projects: [project] })
    expect((result.value.projects as Record<string, unknown>[])[0].coding_mode).toBe(codingMode === true)
    expect(result.fields.some((field) => field.includes('coding_mode'))).toBe(typeof codingMode !== 'boolean')
    expect(project.coding_mode).toBe(codingMode)
  })

  it('repairs missing nested capabilities with each built-in subagent’s own defaults', () => {
    const raw: any = structuredClone(subagents)
    delete raw.subagents[1].capabilities.skills
    raw.subagents[1].capabilities.background_tools = 'true'
    raw.subagents[1].capabilities.environment = false
    raw.subagents[1].description = 'Keep custom description'
    const repaired = repairDocument('subagents.json', raw)
    const agent = (repaired.value.subagents as any[])[1]
    expect(agent.capabilities.skills).toEqual(subagents.subagents[1].capabilities.skills)
    expect(agent.capabilities.background_tools).toBe(true)
    expect(agent.capabilities.profile).toBe(false)
    expect(agent.capabilities.environment).toBe(false)
    expect(agent.description).toBe('Keep custom description')
    expect(repaired.fields.join('\n')).toContain('subagents[1].capabilities.skills')
    expect(raw.subagents[1].capabilities.skills).toBeUndefined()
  })

  it('repairs an invalid capability object and enums without widening a valid custom selection', () => {
    const raw: any = structuredClone(subagents)
    raw.subagents[0].capabilities = false
    raw.subagents[1].capabilities.skills.mode = 'invalid'
    raw.subagents[1].capabilities.tools = ['read_file']
    const repaired: any = repairDocument('subagents.json', raw).value
    expect(repaired.subagents[0].capabilities).toEqual(subagents.subagents[0].capabilities)
    expect(repaired.subagents[1].capabilities.skills.mode).toBe('custom')
    expect(repaired.subagents[1].capabilities.tools).toEqual(['read_file'])
  })

  it('keeps valid false, zero, empty strings, custom parameters and empty lists', () => {
    const raw = { ...settings, sidebar_visible: false, log_retention_days: 0, backup_dir: '' }
    expect(repairDocument('settings.json', raw)).toEqual({ value: raw, fields: [] })
    const rawModels = { ...models, providers: [{
      id: 'provider', name: 'Custom', protocol: 'openai_chat_completions', base_url: 'https://example.com',
      api_key: 'keep-key', parameters: { custom: { value: 0 } }, models: []
    }] }
    const repaired: any = repairDocument('models.json', rawModels).value
    expect(repaired.providers[0].api_key).toBe('keep-key')
    expect(repaired.providers[0].parameters).toEqual({ custom: { value: 0 } })
    expect(repaired.providers[0].models).toEqual([])
  })

  it('repairs setting types, out-of-range values and enums at the field level', () => {
    const raw: any = { ...settings, theme: 'purple', font_size: 900, sidebar_visible: 'false', profile: { assistant: { name: 'Keep me' } } }
    const repaired: any = repairDocument('settings.json', raw).value
    expect(repaired.theme).toBe(settings.theme)
    expect(repaired.font_size).toBe(settings.font_size)
    expect(repaired.sidebar_visible).toBe(settings.sidebar_visible)
    expect(repaired.profile.assistant.name).toBe('Keep me')
    expect(repaired.profile.assistant.role).toBe(settings.profile.assistant.role)
  })

  it('repairs skill availability defaults without enabling an explicitly disabled switch', () => {
    const repaired: any = repairDocument('skills.json', { external_directories: [], availability: {
      example: { model_available: false, user_available: 'broken' }
    } }).value
    expect(repaired.availability.example).toEqual({ model_available: false, user_available: true })
    expect(repaired.external_directories).toEqual([])
  })

  it('reports broken cross-file model references without clearing the saved model choice', async () => {
    const { data } = await fixture()
    const value = { ...settings, default_model_id: 'missing-model' }
    await writeFile(join(data, 'config/settings.json'), JSON.stringify(value))
    const plan = await inspectRecoveryRepair(data)
    expect(plan.issues.join('\n')).toContain('missing-model')
    expect(plan.candidates).toEqual([])
  })

  it('repairs project fields without changing project identities and rejects unidentifiable projects', () => {
    const project: any = {
      id: DEFAULT_WORKSPACE_PROJECT_ID, kind: 'workspace', name: 'Keep project',
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', sourceFolders: ['/keep/path'],
      capabilities: { ...capabilities, workspace: false }, pinned: false
    }
    const repaired: any = repairDocument('projects.json', { version: 4, projects: [project] }).value
    expect(repaired.projects[0]).toMatchObject({ id: project.id, name: project.name, sourceFolders: ['/keep/path'], advanced_settings: false, collapsed: false })
    expect(repaired.projects[0].capabilities.workspace).toBe(false)
    delete project.id
    expect(() => repairDocument('projects.json', { version: 4, projects: [project] })).toThrow('invalid format')
  })

  it('preserves raw files before writing and leaves unparseable files and database untouched', async () => {
    const { root, data } = await fixture()
    const raw: any = structuredClone(subagents)
    delete raw.subagents[0].capabilities
    const before = JSON.stringify(raw)
    await writeFile(join(data, 'config/subagents.json'), before)
    await writeFile(join(data, 'projects.json'), '{broken')
    await mkdir(join(data, 'sqlite'))
    await writeFile(join(data, 'sqlite/agent.sqlite'), 'leave database untouched')
    const result = await repairRecoveryData(data, 'subagents.json', () => preserveRecoveryData(data, root))
    expect(result.repaired.join('\n')).toContain('capabilities')
    expect(result.unresolved).toEqual([])
    expect((await inspectRecoveryRepair(data)).files.find((file) => file.name === 'projects.json')?.error).toBeTruthy()
    expect(await readFile(join(result.preservationPath!, 'data/config/subagents.json'), 'utf8')).toBe(before)
    expect(await readFile(join(data, 'projects.json'), 'utf8')).toBe('{broken')
    expect(await readFile(join(data, 'sqlite/agent.sqlite'), 'utf8')).toBe('leave database untouched')
    expect((await inspectRecoveryRepair(data)).candidates).toEqual([])
  })

  it('never writes after preservation fails or overwrites a file changed during preservation', async () => {
    const { data } = await fixture()
    const path = join(data, 'config/settings.json')
    await writeFile(path, '{}')
    await expect(repairRecoveryData(data, 'settings.json', async () => { throw new Error('disk full') })).rejects.toThrow('disk full')
    expect(await readFile(path, 'utf8')).toBe('{}')
    const result = await repairRecoveryData(data, 'settings.json', async () => { await writeFile(path, '{"changed":true}'); return '/preserved' })
    expect(result.repaired).toEqual([])
    expect(result.unresolved.join('\n')).toContain('File changed')
    expect(await readFile(path, 'utf8')).toBe('{"changed":true}')
    expect((await readdir(join(data, 'config'))).some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('does not back up or rewrite valid files on a repeated repair', async () => {
    const { data } = await fixture()
    const preserve = vi.fn(async () => '/preserved')
    const result = await repairRecoveryData(data, 'settings.json', preserve)
    expect(result.repaired).toEqual([])
    expect(preserve).not.toHaveBeenCalled()
  })

  it('attributes errors to files and repairs only the clicked file even when several need repairs', async () => {
    const { data } = await fixture()
    await writeFile(join(data, 'config/settings.json'), '{}')
    await writeFile(join(data, 'config/subagents.json'), '{}')
    await writeFile(join(data, 'config/models.json'), '{broken')
    const plan = await inspectRecoveryRepair(data)
    expect(plan.files.find((file) => file.name === 'settings.json')?.repairableFields.length).toBeGreaterThan(0)
    expect(plan.files.find((file) => file.name === 'models.json')?.error).toBeTruthy()
    expect(plan.files.find((file) => file.name === 'projects.json')?.error).toContain('missing')
    await repairRecoveryData(data, 'settings.json', async () => '/preserved')
    expect(await readFile(join(data, 'config/subagents.json'), 'utf8')).toBe('{}')
    expect(await readFile(join(data, 'config/models.json'), 'utf8')).toBe('{broken')
    expect(JSON.parse(await readFile(join(data, 'config/settings.json'), 'utf8'))).toEqual(settings)
  })
})
