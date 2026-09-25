import { defaultCapabilities, defaultCapabilitySettings } from '@shared/agentCapabilities'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { toAgentMessage, toHumanMessage } from './agent/messageMapper'

const tempDirs: string[] = []

function skillText(name: string, description = `${name} description`, body = `Use ${name}.`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

async function writeSkill(parent: string, name: string): Promise<string> {
  const path = join(parent, name)
  await writeText(join(path, 'SKILL.md'), skillText(name))
  return path
}

async function loadSkillsStore(externalDirectories: unknown[] = []) {
  vi.resetModules()
  const root = await mkdtemp(join(tmpdir(), 'anas-skills-'))
  tempDirs.push(root)
  const bundledDataDir = join(root, 'bundled-data')
  const bundledConfigDir = join(root, 'bundled-config')
  const configDir = join(root, 'config')
  const skillsDir = join(root, 'user-skills')
  const systemDir = join(root, 'skills_system')
  const examplesDir = join(root, 'skills_examples')
  const workspace = join(root, 'workspace')
  const projectCapabilities = structuredClone(defaultCapabilities)
  const defaults = structuredClone(defaultCapabilitySettings)
  const projectSettings = { advancedSettings: true }
  await Promise.all([
    mkdir(join(bundledDataDir, 'skills_system'), { recursive: true }),
    mkdir(join(bundledDataDir, 'skills_examples'), { recursive: true }),
    mkdir(skillsDir, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    writeText(join(bundledConfigDir, 'skills.json'), `${JSON.stringify({ external_directories: externalDirectories, availability: {} }, null, 2)}\n`)
  ])
  vi.doMock('./config/dataDir', () => ({
    skillsConfigFileName: 'skills.json',
    getBundledConfigFile: (name: string) => join(bundledConfigDir, name),
    getBundledDataDir: () => bundledDataDir,
    getConfigFile: (name: string) => join(configDir, name),
    getSkillExamplesDir: () => examplesDir,
    getSkillsDir: () => skillsDir,
    getSystemSkillsDir: () => systemDir
  }))
  vi.doMock('./config/appConfig', () => ({ getAppConfigSnapshot: async () => ({ customTools: [], defaultCapabilities: defaults }) }))
  vi.doMock('./projectStore', () => ({
    getProject: async (id: string) => ({
 capabilities: projectCapabilities, restrictSubagents: false, ...projectSettings, prompt: '', id, kind: 'workspace', name: 'Test', sourceFolders: [workspace] })
  }))
  return {
    projectCapabilities,
    defaults,
    projectSettings,
    root,
    bundledSystemDir: join(bundledDataDir, 'skills_system'),
    bundledExamplesDir: join(bundledDataDir, 'skills_examples'),
    configFile: join(configDir, 'skills.json'),
    examplesDir,
    skillsDir,
    systemDir,
    workspace,
    store: await import('./skillsStore')
  }
}

afterEach(async () => {
  vi.doUnmock('node:fs/promises')
  vi.doUnmock('./config/dataDir')
  vi.doUnmock('./projectStore')
  vi.doUnmock('./config/appConfig')
  vi.resetModules()
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('skillsStore', () => {
  it('persists independent default-off script switches and applies OR to current and changed scripts', async () => {
    const h = await loadSkillsStore()
    const dir = await writeSkill(h.skillsDir, 'query')
    const script = join(dir, 'scripts', 'query.py')
    await writeText(script, 'print(1)')
    const scope = { selection: defaultCapabilities.skills, allowUserInvocation: true }
    const snapshot = await h.store.listSkillSnapshot()
    expect(snapshot.scriptAutoApprove).toBe(false)
    expect(snapshot.skills[0].scriptAutoApprove).toBe(false)
    for (const [global, individual] of [[false, false], [false, true], [true, false], [true, true]]) {
      await h.store.updateSkillScriptApproval(undefined, undefined, global)
      const saved = await h.store.updateSkillScriptApproval(undefined, 'user:query', individual)
      expect(saved.scriptAutoApprove).toBe(global)
      expect(saved.skills[0].scriptAutoApprove).toBe(individual)
      expect(Boolean(await h.store.findSkillScriptExemption(script, scope))).toBe(global || individual)
    }
    await h.store.updateSkillScriptApproval(undefined, undefined, false)
    await writeText(script, 'print(2)')
    await expect(h.store.findSkillScriptExemption(script, scope)).resolves.toMatchObject({ skillId: 'user:query' })
    await writeText(join(dir, 'new.py'), 'print(3)')
    await expect(h.store.findSkillScriptExemption(join(dir, 'new.py'), scope)).resolves.toBeDefined()
    await h.store.updateSkillScriptApproval(undefined, 'user:query', false)
    await expect(h.store.findSkillScriptExemption(script, scope)).resolves.toBeUndefined()
    expect(JSON.parse(await readFile(h.configFile, 'utf8'))).toMatchObject({ script_auto_approve: false, script_auto_approve_skills: [] })
  })

  it('does not grant disabled or shortcut-only Skills autonomous script exemptions', async () => {
    const h = await loadSkillsStore()
    const dir = await writeSkill(h.skillsDir, 'query')
    const script = join(dir, 'query.py')
    await writeText(script, 'print(1)')
    await h.store.updateSkillScriptApproval(undefined, undefined, true)
    await h.store.updateSkillAvailability(undefined, 'user:query', { modelAvailable: false })
    const scope = { selection: defaultCapabilities.skills, allowUserInvocation: true }
    await expect(h.store.findSkillScriptExemption(script, scope)).resolves.toBeUndefined()
    await expect(h.store.findSkillScriptExemption(script, scope, { name: 'query' })).resolves.toMatchObject({ skillId: 'user:query' })
    await expect(h.store.findSkillScriptExemption(script, { ...scope, allowUserInvocation: false }, { name: 'query' })).resolves.toBeUndefined()
    await expect(h.store.findSkillScriptExemption(script, { ...scope, selection: { ...scope.selection, enabled: false } }, { name: 'query' })).resolves.toBeUndefined()
    const selected = { ...scope, selection: { enabled: true, mode: 'custom' as const, project: false,
      entries: [{ id: 'user:query', model: true, shortcut: false }] } }
    await expect(h.store.findSkillScriptExemption(script, selected)).resolves.toBeDefined()
    await expect(h.store.findSkillScriptExemption(script, { ...selected, selection: { ...selected.selection, entries: [] } })).resolves.toBeUndefined()
  })

  it('binds exemption to source identity and actual containment, including directory links', async () => {
    const h = await loadSkillsStore()
    const user = await writeSkill(h.skillsDir, 'duplicate')
    await writeSkill(h.bundledSystemDir, 'duplicate')
    await h.store.listSkillSnapshot()
    const systemScript = join(h.systemDir, 'duplicate', 'query.py')
    const userScript = join(user, 'query.py')
    await writeText(systemScript, 'print(1)')
    await writeText(userScript, 'print(2)')
    await h.store.updateSkillScriptApproval(undefined, 'system:duplicate', true)
    const scope = { selection: defaultCapabilities.skills, allowUserInvocation: true }
    await expect(h.store.findSkillScriptExemption(userScript, scope)).resolves.toBeUndefined()
    await expect(h.store.findSkillScriptExemption(systemScript, scope)).resolves.toBeUndefined()
    await expect(h.store.findSkillScriptExemption(systemScript, scope, { name: 'duplicate', sourceAlias: 'system' })).resolves.toMatchObject({ skillId: 'system:duplicate' })
    await h.store.updateSkillScriptApproval(undefined, 'user:duplicate', true)
    const outside = join(h.root, 'outside')
    await mkdir(outside)
    await writeText(join(outside, 'query.py'), 'print(3)')
    await symlink(outside, join(user, 'linked'), 'junction')
    await expect(h.store.findSkillScriptExemption(join(user, 'linked', 'query.py'), scope)).resolves.toBeUndefined()
    await expect(h.store.findSkillScriptExemption(join(outside, 'query.py'), scope)).resolves.toBeUndefined()
    await expect(h.store.updateSkillScriptApproval(undefined, 'missing', true)).rejects.toThrow('not found')
    await expect(h.store.updateSkillScriptApproval(undefined, undefined, 'true' as never)).rejects.toThrow('boolean')
  })

  it('injects instructions with their resource directory and preserves the exact prompt in the UI projection', async () => {
    const fixture = await loadSkillsStore()
    const directory = join(fixture.skillsDir, 'summarize')
    const contents = skillText('summarize', 'Summary', 'Read references/style.md, then run scripts/run.py.')
    await writeText(join(directory, 'SKILL.md'), contents)
    await writeText(join(directory, 'references', 'style.md'), 'RESOURCE_BODY_ONLY_LOADED_ON_DEMAND')

    const invocation = await fixture.store.buildUserSkillInvocation(undefined, 'summarize', undefined, 'the report')
    expect(invocation.promptText).toContain(`<skill>\n<name>summarize</name>\n<path>${join(directory, 'SKILL.md')}</path>\n${contents}\n</skill>`)
    expect(invocation.promptText.startsWith('/summarize the report\n\n')).toBe(true)
    expect(invocation.promptText).not.toContain('RESOURCE_BODY_ONLY_LOADED_ON_DEMAND')
    const message = toHumanMessage(invocation.promptText, undefined, invocation.displayText)
    const projected = toAgentMessage(message, 'skill-message')
    expect(projected.content).toEqual([{ type: 'text', text: '/summarize the report' }])
    expect(projected.skillInvocation?.promptText).toBe(message.text)
    expect(projected.skillInvocation?.promptText).toBe(invocation.promptText)

    await writeText(join(directory, 'SKILL.md'), skillText('summarize', 'Summary', 'Updated instructions.'))
    const refreshed = await fixture.store.buildUserSkillInvocation(undefined, 'summarize', undefined, 'the report')
    expect(refreshed.promptText).toContain('Updated instructions.')
    expect(refreshed.promptText).not.toContain('Read references/style.md')
  })

  it.each(['\n', '\r\n'])('preserves the entire Skill file and keeps the user request outside it (%j)', async (newline) => {
    const fixture = await loadSkillsStore()
    const contents = '---\nname: arguments\ndescription: Arguments\ncompatibility: Python 3\nmetadata:\n  author: Example\n---\n\n    Keep indentation.\n$ARGUMENTS $0 $1 $ARGUMENTS[0] $HOME <example>\n\n'.replaceAll('\n', newline)
    await writeText(join(fixture.skillsDir, 'arguments', 'SKILL.md'), contents)
    const request = '用户需求  保留空格\n$ARGUMENTS $0 <example>'
    const invocation = await fixture.store.buildUserSkillInvocation(undefined, 'arguments', undefined, request)
    expect(invocation.promptText.endsWith(`\n${contents}\n</skill>`)).toBe(true)
    expect(invocation.promptText.startsWith(`/arguments ${request}\n\n`)).toBe(true)
    const withoutRequest = await fixture.store.buildUserSkillInvocation(undefined, 'arguments', undefined, '')
    expect(withoutRequest.displayText).toBe('/arguments')
    expect(withoutRequest.promptText.endsWith(`\n${contents}\n</skill>`)).toBe(true)
    expect(withoutRequest.promptText).not.toContain('ARGUMENTS:')
  })

  it('rejects empty instructions', async () => {
    const fixture = await loadSkillsStore()
    const path = join(fixture.skillsDir, 'arguments', 'SKILL.md')
    await writeText(path, skillText('arguments', 'Arguments', '   '))
    await expect(fixture.store.buildUserSkillInvocation(undefined, 'arguments', undefined, '')).rejects.toThrow('empty')
  })

  it('exposes absolute file paths for available Skills, without installation configuration', async () => {
    const fixture = await loadSkillsStore()
    await writeSkill(fixture.bundledSystemDir, 'authoring-guide')
    await writeSkill(fixture.skillsDir, 'personal-guide')
    const unusedFolder = join(fixture.root, 'unused-project')
    const prompt = await fixture.store.buildSkillsPrompt(undefined, defaultCapabilities.skills, [fixture.workspace, unusedFolder])
    expect(prompt).toContain('<skills_instructions>')
    expect(prompt).toContain(`(file: ${join(fixture.systemDir, 'authoring-guide', 'SKILL.md')})`)
    expect(prompt).toContain(`(file: ${join(fixture.skillsDir, 'personal-guide', 'SKILL.md')})`)
    expect(prompt).not.toContain(fixture.examplesDir)
    expect(prompt).not.toContain(unusedFolder)
    expect(prompt).not.toContain(fixture.workspace)
    expect(prompt).not.toContain('Anas Settings')
  })

  it('previews draft source folders and preserves skill identity after project creation', async () => {
    const fixture = await loadSkillsStore()
    await writeSkill(join(fixture.workspace, '.agents', 'skills'), 'draft-skill')
    const preview = await fixture.store.listSkillSnapshot(undefined, [fixture.workspace])
    const skill = preview.skills.find((item) => item.name === 'draft-skill')!
    expect(skill).toBeDefined()
    const saved = await fixture.store.listSkillSnapshot('new-project')
    expect(saved.skills.find((item) => item.name === 'draft-skill')?.id).toBe(skill.id)
    const selection = { enabled: true, mode: 'custom' as const, project: false, entries: [{ id: skill.id, shortcut: true, model: true }] }
    await expect(fixture.store.buildSkillsPrompt('new-project', selection)).resolves.toContain('draft-skill')

    const replacement = join(fixture.root, 'replacement')
    await writeSkill(join(replacement, '.agents', 'skills'), 'replacement-skill')
    const edited = await fixture.store.listSkillSnapshot('new-project', [replacement])
    expect(edited.skills.map((item) => item.name)).toContain('replacement-skill')
    expect(edited.skills.map((item) => item.name)).not.toContain('draft-skill')
    const draftPrompt = await fixture.store.buildSkillsPrompt('new-project', defaultCapabilities.skills, [replacement])
    expect(draftPrompt).toContain('replacement-skill')
    expect(draftPrompt).not.toContain('draft-skill')
    const cleared = await fixture.store.listSkillSnapshot('new-project', [])
    expect(cleared.roots.some((root) => root.kind === 'project')).toBe(false)
    await expect(fixture.store.listSkillSnapshot(undefined, ['relative-folder'])).rejects.toThrow('absolute directory paths')
  })

  it('supports project shortcut-only overrides and disables both paths with the Skill capability', async () => {
    const fixture = await loadSkillsStore()
    await writeSkill(fixture.skillsDir, 'shortcut-only')
    const skill = (await fixture.store.listSkillSnapshot()).skills.find((item) => item.name === 'shortcut-only')!
    await fixture.store.updateSkillAvailability(undefined, skill.id, { modelAvailable: false, userAvailable: false })
    fixture.projectCapabilities.skills = { enabled: true, mode: 'custom', project: false, entries: [{ id: skill.id, shortcut: true, model: false }] }
    const invocation = await fixture.store.buildUserSkillInvocation('project-1', skill.name, undefined, 'details')
    expect(invocation).toMatchObject({ handled: true, promptText: expect.stringContaining('SKILL.md') })
    expect(invocation.promptText).toContain(`<path>${join(fixture.skillsDir, 'shortcut-only', 'SKILL.md')}</path>`)
    const shortcutPrompt = await fixture.store.buildSkillsPrompt('project-1', fixture.projectCapabilities.skills)
    expect(shortcutPrompt).toContain('### How to use skills')
    expect(shortcutPrompt).not.toContain('shortcut-only')
    fixture.projectCapabilities.skills.enabled = false
    await expect(fixture.store.buildUserSkillInvocation('project-1', skill.name, undefined, '')).resolves.toMatchObject({ errorCode: 'user_unavailable' })
    await expect(fixture.store.buildSkillsPrompt('project-1', fixture.projectCapabilities.skills)).resolves.toBe('')
  })
  it('shares one configuration initialization across simultaneous catalog and prompt reads', async () => {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let releaseCopy!: () => void
    const copyAllowed = new Promise<void>((resolve) => { releaseCopy = resolve })
    let notifyCopyStarted!: () => void
    const copyStarted = new Promise<void>((resolve) => { notifyCopyStarted = resolve })
    const copyConfig = vi.fn(async (...args: Parameters<typeof fs.copyFile>) => {
      notifyCopyStarted()
      await copyAllowed
      return fs.copyFile(...args)
    })
    const probe = vi.fn(fs.stat)
    vi.doMock('node:fs/promises', () => ({ ...fs, copyFile: copyConfig, stat: probe }))
    const fixture = await loadSkillsStore()
    await writeSkill(fixture.bundledSystemDir, 'system-skill')
    const initialization = fixture.store.initializeSkillsStore()
    await copyStarted
    const settled = Promise.allSettled([
      initialization,
      fixture.store.initializeSkillsStore(),
      fixture.store.listSkillSnapshot(),
      fixture.store.listSkillSnapshot('project-id'),
      fixture.store.buildSkillsPrompt()
    ])
    try {
      releaseCopy()
      const results = await settled
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason
      }
      expect(copyConfig).toHaveBeenCalledOnce()
      expect(probe.mock.calls.filter(([path]) => path === fixture.configFile)).toHaveLength(1)
      expect(results[4]).toMatchObject({ status: 'fulfilled', value: expect.stringContaining('system-skill') })
      expect(JSON.parse(await readFile(fixture.configFile, 'utf8'))).toEqual({ external_directories: [], availability: {} })
    } finally {
      releaseCopy()
      await settled
    }
  })

  it('settles every started mirror before rejecting initialization and allowing a retry', async () => {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    const failure = new Error('Injected configuration copy failure')
    const copyConfig = vi.fn(fs.copyFile).mockRejectedValueOnce(failure)
    let releaseMirror!: () => void
    const mirrorAllowed = new Promise<void>((resolve) => { releaseMirror = resolve })
    let notifyMirrorStarted!: () => void
    const mirrorStarted = new Promise<void>((resolve) => { notifyMirrorStarted = resolve })
    const copySkill = vi.fn(async (...args: Parameters<typeof fs.cp>) => {
      notifyMirrorStarted()
      await mirrorAllowed
      return fs.cp(...args)
    })
    vi.doMock('node:fs/promises', () => ({ ...fs, copyFile: copyConfig, cp: copySkill }))
    const fixture = await loadSkillsStore()
    await writeSkill(fixture.bundledSystemDir, 'system-skill')
    let returned = false
    const initial = fixture.store.initializeSkillsStore().then(
      () => { returned = true; return undefined },
      (reason: unknown) => { returned = true; return reason }
    )
    await mirrorStarted
    const sameAttempt = fixture.store.initializeSkillsStore().catch((reason: unknown) => reason)
    try {
      expect(returned).toBe(false)
      expect(copyConfig).toHaveBeenCalledOnce()
      releaseMirror()
      expect(await initial).toBe(failure)
      expect(await sameAttempt).toBe(failure)
      expect(copyConfig).toHaveBeenCalledOnce()

      await fixture.store.initializeSkillsStore()
      expect(copyConfig).toHaveBeenCalledTimes(2)
      await expect(readFile(join(fixture.systemDir, 'system-skill', 'SKILL.md'), 'utf8')).resolves.toContain('system-skill description')
      await expect(fixture.store.listSkillSnapshot()).resolves.toMatchObject({ skills: [expect.objectContaining({ name: 'system-skill' })] })
    } finally {
      releaseMirror()
      await Promise.allSettled([initial, sameAttempt])
    }
  })

  it('discovers system, Anas user, current-project, and configured external roots', async () => {
    const external = join(tmpdir(), `anas-external-${Date.now()}`)
    tempDirs.push(external)
    const fixture = await loadSkillsStore([{ id: 'external', name: 'External', shortcut_alias: 'external', path: external }])
    await Promise.all([
      writeSkill(fixture.bundledSystemDir, 'shared'),
      writeSkill(fixture.bundledExamplesDir, 'sample'),
      writeSkill(fixture.examplesDir, 'stale'),
      writeSkill(fixture.systemDir, 'stale-system'),
      writeSkill(fixture.skillsDir, 'user-one'),
      writeSkill(join(fixture.workspace, '.agents', 'skills'), 'project-one'),
      writeSkill(external, 'external-one')
    ])

    const snapshot = await fixture.store.listSkillSnapshot('project-id')

    expect(snapshot.roots.map((root) => root.kind)).toEqual(['system', 'user', 'project', 'external'])
    expect(snapshot.skills.map((skill) => [skill.name, skill.source])).toEqual([
      ['project-one', 'project'],
      ['user-one', 'user'],
      ['external-one', 'external'],
      ['shared', 'system']
    ])
    await expect(readFile(join(fixture.examplesDir, 'sample', 'SKILL.md'), 'utf8')).resolves.toContain('sample description')
    await expect(readFile(join(fixture.examplesDir, 'stale', 'SKILL.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(fixture.systemDir, 'stale-system', 'SKILL.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('treats a symlinked Skill directory as a first-class Skill', async () => {
    const fixture = await loadSkillsStore()
    const target = await writeSkill(join(fixture.root, 'targets'), 'linked-skill')
    await symlink(target, join(fixture.skillsDir, 'linked-skill'), 'dir')

    const snapshot = await fixture.store.listSkillSnapshot()
    const skill = snapshot.skills.find((item) => item.name === 'linked-skill')

    expect(skill).toMatchObject({ source: 'user', linked: true, linkTarget: target, resolvedDirPath: await realpath(target) })
    await expect(fixture.store.listSkillFiles(undefined, skill!.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'SKILL.md', kind: 'text' })
    ]))
  })

  it('accepts nested extension metadata that Anas does not consume', async () => {
    const fixture = await loadSkillsStore()
    await writeText(join(fixture.skillsDir, 'nested-metadata', 'SKILL.md'), `---
name: nested-metadata
description: Uses host-specific extension metadata.
metadata:
  version: "1.0.0"
  requires:
    bins: ["example"]
---
Body
`)

    const skill = (await fixture.store.listSkillSnapshot()).skills.find((item) => item.name === 'nested-metadata')

    expect(skill?.loadError).toBeUndefined()
  })

  it('browses file and directory symlinks even when their targets are outside the Skill root', async () => {
    const fixture = await loadSkillsStore()
    const skillDir = await writeSkill(fixture.skillsDir, 'linked-files')
    const outsideFile = join(fixture.root, 'outside', 'notes.txt')
    const outsideDir = join(fixture.root, 'outside', 'docs')
    await Promise.all([writeText(outsideFile, 'outside content'), writeText(join(outsideDir, 'guide.md'), 'guide')])
    await Promise.all([symlink(outsideFile, join(skillDir, 'notes.txt')), symlink(outsideDir, join(skillDir, 'docs'), 'dir')])
    const skill = (await fixture.store.listSkillSnapshot()).skills.find((item) => item.name === 'linked-files')!

    const files = await fixture.store.listSkillFiles(undefined, skill.id)
    expect(files).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'notes.txt', kind: 'symlink', resolvedPath: await realpath(outsideFile), linkDirectory: false }),
      expect.objectContaining({ name: 'docs', kind: 'symlink', resolvedPath: await realpath(outsideDir), linkDirectory: true })
    ]))
    await expect(fixture.store.readSkillFile(undefined, skill.id, 'notes.txt')).resolves.toMatchObject({ content: 'outside content', linkTarget: outsideFile, resolvedPath: await realpath(outsideFile) })
    await expect(fixture.store.listSkillFiles(undefined, skill.id, 'docs')).resolves.toEqual([expect.objectContaining({ name: 'guide.md' })])
  })

  it('resolves duplicate names separately for model and user availability', async () => {
    const external = join(tmpdir(), `anas-external-${Date.now()}`)
    tempDirs.push(external)
    const fixture = await loadSkillsStore([{ id: 'external', name: 'External', shortcut_alias: 'external', path: external }])
    await Promise.all([writeSkill(fixture.bundledSystemDir, 'duplicate'), writeSkill(fixture.skillsDir, 'duplicate'), writeSkill(external, 'duplicate')])
    let snapshot = await fixture.store.listSkillSnapshot()
    const userSkill = snapshot.skills.find((skill) => skill.source === 'user')!
    snapshot = await fixture.store.updateSkillAvailability(undefined, userSkill.id, { modelAvailable: false, userAvailable: true })

    expect(snapshot.skills.find((skill) => skill.source === 'user')).toMatchObject({ shortcut: '/duplicate', modelAvailable: false })
    expect(snapshot.skills.find((skill) => skill.source === 'external')).toMatchObject({ userShadowedBy: 'User' })
    expect(snapshot.skills.find((skill) => skill.source === 'external')?.modelShadowedBy).toBeUndefined()
    expect(JSON.parse(await readFile(fixture.configFile, 'utf8')).availability[userSkill.id]).toEqual({ model_available: false, user_available: true })
  })

  it('merges concurrent availability field updates without losing either change', async () => {
    const fixture = await loadSkillsStore()
    await writeSkill(fixture.skillsDir, 'toggle-skill')
    const skill = (await fixture.store.listSkillSnapshot()).skills.find((candidate) => candidate.name === 'toggle-skill')!

    await Promise.all([
      fixture.store.updateSkillAvailability(undefined, skill.id, { modelAvailable: false }),
      fixture.store.updateSkillAvailability(undefined, skill.id, { userAvailable: false })
    ])

    expect((await fixture.store.listSkillSnapshot()).skills.find((candidate) => candidate.id === skill.id)).toMatchObject({
      modelAvailable: false,
      userAvailable: false
    })
  })

  it('removes the shortcut when user availability is disabled', async () => {
    const fixture = await loadSkillsStore()
    await writeSkill(fixture.bundledSystemDir, 'system-only')
    let snapshot = await fixture.store.listSkillSnapshot()
    const skill = snapshot.skills.find((candidate) => candidate.name === 'system-only')!

    snapshot = await fixture.store.updateSkillAvailability(undefined, skill.id, { modelAvailable: true, userAvailable: false })

    expect(snapshot.skills.find((candidate) => candidate.id === skill.id)?.shortcut).toBeUndefined()
    await expect(fixture.store.buildUserSkillInvocation(undefined, 'system-only', 'system', '')).resolves.toMatchObject({
      handled: true,
      errorCode: 'user_unavailable'
    })
  })

  it('keeps model-hidden Skills out of inherited prompts but allows explicit subagent selection', async () => {
    const fixture = await loadSkillsStore()
    await writeSkill(fixture.skillsDir, 'subagent-only')
    const skill = (await fixture.store.listSkillSnapshot()).skills.find((candidate) => candidate.name === 'subagent-only')!
    await fixture.store.updateSkillAvailability(undefined, skill.id, {
      modelAvailable: false,
      userAvailable: false
    })

    await expect(fixture.store.buildSkillsPrompt()).resolves.not.toContain('subagent-only')
    await expect(fixture.store.buildSkillsPrompt(undefined, { enabled: true, mode: 'custom', project: false, entries: [{ id: skill.id, model: true, shortcut: false }] })).resolves.toContain(
      `(file: ${join(fixture.skillsDir, 'subagent-only', 'SKILL.md')})`
    )
  })

  it('uses default skill choices only while project customization is off', async () => {
    const fixture = await loadSkillsStore()
    await writeSkill(fixture.skillsDir, 'example')
    fixture.projectSettings.advancedSettings = false
    fixture.defaults.capabilities.skills.enabled = false
    await expect(fixture.store.buildUserSkillInvocation('project', 'example', undefined, '')).resolves.toMatchObject({ errorCode: 'user_unavailable' })
    fixture.projectSettings.advancedSettings = true
    await expect(fixture.store.buildUserSkillInvocation('project', 'example', undefined, '')).resolves.toMatchObject({ promptText: expect.stringContaining('SKILL.md') })
  })

  it('supports qualified shortcuts and keeps an unqualified shortcut on the highest-priority user-visible Skill', async () => {
    const external = join(tmpdir(), `anas-external-${Date.now()}`)
    tempDirs.push(external)
    const fixture = await loadSkillsStore([{ id: 'external', name: 'External', shortcut_alias: 'external', path: external }])
    await Promise.all([
      writeText(join(fixture.skillsDir, 'duplicate', 'SKILL.md'), skillText('duplicate', 'User', 'USER_SOURCE $ARGUMENTS')),
      writeText(join(external, 'duplicate', 'SKILL.md'), skillText('duplicate', 'External', 'EXTERNAL_SOURCE $ARGUMENTS'))
    ])

    const unqualified = await fixture.store.buildUserSkillInvocation(undefined, 'duplicate', undefined, 'one')
    const qualified = await fixture.store.buildUserSkillInvocation(undefined, 'duplicate', 'external', 'two')

    expect(unqualified.displayText).toBe('/duplicate one')
    expect(unqualified.promptText).toContain(join(fixture.skillsDir, 'duplicate', 'SKILL.md'))
    expect(unqualified.promptText).toContain('USER_SOURCE $ARGUMENTS')
    expect(unqualified.promptText.startsWith('/duplicate one\n\n')).toBe(true)
    expect(unqualified.promptText).not.toContain('EXTERNAL_SOURCE')
    expect(qualified.displayText).toBe('/duplicate@external two')
    expect(qualified.promptText).toContain(join(external, 'duplicate', 'SKILL.md'))
    expect(qualified.promptText).toContain('EXTERNAL_SOURCE $ARGUMENTS')
    expect(qualified.promptText.startsWith('/duplicate@external two\n\n')).toBe(true)
    expect(qualified.promptText).not.toContain('USER_SOURCE')
  })

  it('distinguishes a missing source from a Skill missing within an existing source', async () => {
    const fixture = await loadSkillsStore()
    await writeSkill(fixture.skillsDir, 'user-only')

    await expect(fixture.store.buildUserSkillInvocation(undefined, 'user-only', 'missing', '')).resolves.toMatchObject({
      handled: true,
      errorCode: 'source_not_found'
    })
    await expect(fixture.store.buildUserSkillInvocation(undefined, 'user-only', 'system', '')).resolves.toMatchObject({
      handled: true,
      errorCode: 'source_skill_not_found'
    })
  })

  it('rejects oversized SKILL.md content without reading it into the catalog', async () => {
    const fixture = await loadSkillsStore()
    await writeText(join(fixture.skillsDir, 'oversized', 'SKILL.md'), `${skillText('oversized')} ${'x'.repeat(1024 * 1024)}`)

    const skill = (await fixture.store.listSkillSnapshot()).skills.find((candidate) => candidate.name === 'oversized')

    expect(skill?.loadError).toMatchObject({ code: 'unreadable_skill_file' })
  })

  it('adds, reorders, and removes external roots without modifying their contents', async () => {
    const fixture = await loadSkillsStore()
    const first = join(fixture.root, 'first-root')
    const second = join(fixture.root, 'second-root')
    await Promise.all([writeSkill(first, 'first-skill'), writeSkill(second, 'second-skill')])

    await fixture.store.addExternalSkillDirectory(first)
    let snapshot = await fixture.store.addExternalSkillDirectory(second)
    const externalRoots = snapshot.roots.filter((root) => root.kind === 'external')
    expect(externalRoots.map((root) => root.path)).toEqual([first, second])

    snapshot = await fixture.store.updateExternalSkillDirectory(externalRoots[1].id, { name: 'Personal Skills', shortcutAlias: 'personal' })
    expect(snapshot.roots.find((root) => root.id === externalRoots[1].id)).toMatchObject({
      name: 'Personal Skills',
      shortcutAlias: 'personal',
      path: second
    })
    expect(JSON.parse(await readFile(fixture.configFile, 'utf8')).external_directories[1]).toMatchObject({
      name: 'Personal Skills',
      shortcut_alias: 'personal',
      path: second
    })
    await expect(fixture.store.buildUserSkillInvocation(undefined, 'second-skill', 'personal', '')).resolves.toMatchObject({
      displayText: '/second-skill@personal',
      promptText: expect.stringContaining(join(second, 'second-skill', 'SKILL.md'))
    })

    snapshot = await fixture.store.moveExternalSkillDirectory(externalRoots[1].id, -1)
    expect(snapshot.roots.filter((root) => root.kind === 'external').map((root) => root.path)).toEqual([second, first])

    snapshot = await fixture.store.removeExternalSkillDirectory(externalRoots[0].id)
    expect(snapshot.roots.filter((root) => root.kind === 'external').map((root) => root.path)).toEqual([second])
    await expect(readFile(join(first, 'first-skill', 'SKILL.md'), 'utf8')).resolves.toContain('first-skill')
  })

  it('imports multiple selected Skill directories into Anas User', async () => {
    const fixture = await loadSkillsStore()
    const first = await writeSkill(join(fixture.root, 'imports'), 'first-import')
    const second = await writeSkill(join(fixture.root, 'imports'), 'second-import')
    await writeText(join(second, 'references', 'guide.md'), 'Imported reference')

    const result = await fixture.store.importSkillDirectories([first, second])

    expect(result.names).toEqual(['first-import', 'second-import'])
    expect(result.snapshot.skills.filter((skill) => skill.source === 'user').map((skill) => skill.name)).toEqual([
      'first-import',
      'second-import'
    ])
    await expect(readFile(join(fixture.skillsDir, 'second-import', 'references', 'guide.md'), 'utf8')).resolves.toBe('Imported reference')
    const firstPath = `(file: ${join(fixture.skillsDir, 'first-import', 'SKILL.md')})`
    const secondPath = `(file: ${join(fixture.skillsDir, 'second-import', 'SKILL.md')})`
    const defaultPrompt = await fixture.store.buildSkillsPrompt()
    expect(defaultPrompt).toContain(firstPath)
    expect(defaultPrompt).toContain(secondPath)
    const customPrompt = await fixture.store.buildSkillsPrompt(undefined, {
      enabled: true, mode: 'custom', project: false,
      entries: [{ id: 'user:first-import', model: true, shortcut: true }]
    })
    expect(customPrompt).toContain(firstPath)
    expect(customPrompt).not.toContain(secondPath)
  })

  it('does not partially import a multi-selection when one Skill already exists', async () => {
    const fixture = await loadSkillsStore()
    await writeSkill(fixture.skillsDir, 'existing')
    const fresh = await writeSkill(join(fixture.root, 'imports'), 'fresh')
    const existing = await writeSkill(join(fixture.root, 'imports'), 'existing')

    const failure = await fixture.store.importSkillDirectories([fresh, existing]).catch((reason) => reason)

    expect(fixture.store.toSkillImportError(failure)).toEqual({ code: 'already_exists', name: 'existing' })
    await expect(readFile(join(fixture.skillsDir, 'fresh', 'SKILL.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('derives a useful source name for a selected directory named skills and keeps shortcut aliases unique', async () => {
    const fixture = await loadSkillsStore()
    const first = join(fixture.root, 'company', 'skills')
    const second = join(fixture.root, 'personal', 'skills')
    await Promise.all([writeSkill(first, 'first-skill'), writeSkill(second, 'second-skill')])

    await fixture.store.addExternalSkillDirectory(first)
    const snapshot = await fixture.store.addExternalSkillDirectory(second)
    const externalRoots = snapshot.roots.filter((root) => root.kind === 'external')

    expect(externalRoots.map((root) => [root.name, root.shortcutAlias])).toEqual([
      ['company', 'company'],
      ['personal', 'personal']
    ])
    await expect(fixture.store.updateExternalSkillDirectory(externalRoots[1].id, {
      name: 'Other company',
      shortcutAlias: 'company'
    })).rejects.toThrow('already in use')
  })

  it('does not add a built-in or current-project Skill root again as an external source', async () => {
    const fixture = await loadSkillsStore()
    const projectSkills = join(fixture.workspace, '.agents', 'skills')
    await writeSkill(projectSkills, 'project-skill')
    await fixture.store.initializeSkillsStore()

    await expect(fixture.store.addExternalSkillDirectory(fixture.skillsDir, 'project-id')).rejects.toThrow('already managed')
    await expect(fixture.store.addExternalSkillDirectory(fixture.systemDir, 'project-id')).rejects.toThrow('already managed')
    await expect(fixture.store.addExternalSkillDirectory(fixture.examplesDir, 'project-id')).rejects.toThrow('already managed')
    await expect(fixture.store.addExternalSkillDirectory(projectSkills, 'project-id')).rejects.toThrow('already managed')
  })

  it('reports a broken Skill-directory link locally without hiding other Skills', async () => {
    const fixture = await loadSkillsStore()
    await writeSkill(fixture.skillsDir, 'healthy')
    await symlink(join(fixture.root, 'missing-target'), join(fixture.skillsDir, 'broken'), 'dir')

    const snapshot = await fixture.store.listSkillSnapshot()

    expect(snapshot.skills.find((skill) => skill.name === 'healthy')?.loadError).toBeUndefined()
    expect(snapshot.skills.find((skill) => skill.name === 'broken')).toMatchObject({ linked: true, loadError: { code: 'missing_skill_file' } })
  })
})
