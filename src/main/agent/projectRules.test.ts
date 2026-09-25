import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createProjectRulesSnapshot, discoverProjectRules, mutationDirectories,
  projectRuleLimits, projectRulesText, ruleScopeIds
} from './projectRules'

const roots: string[] = []
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'anas-project-rules-')))
  roots.push(root)
  return root
}
async function file(root: string, path: string, text: string) {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), text)
}
const reader = () => ({ authorizeRead: vi.fn() })
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

describe('project rule discovery', () => {
  it('loads only the git root-to-cwd chain, using the same-directory override', async () => {
    const root = await fixture()
    await file(root, '.git', 'gitdir: /unused/worktree/metadata')
    await file(root, 'AGENTS.md', 'ROOT RULE')
    await file(root, 'src/AGENTS.md', 'IGNORED RULE')
    await file(root, 'src/AGENTS.override.md', 'SRC RULE')
    await file(root, 'sibling/AGENTS.md', 'SIBLING RULE')
    const snapshot = await createProjectRulesSnapshot('run', [join(root, 'src')])
    snapshot.activeScopes = await discoverProjectRules(snapshot, join(root, 'src'), reader())
    const text = projectRulesText(snapshot)
    expect(text).toContain('ROOT RULE')
    expect(text).toContain('SRC RULE')
    expect(text).not.toContain('IGNORED RULE')
    expect(text).not.toContain('SIBLING RULE')
    expect(snapshot.roots[0].boundary).toBe(root)
  })

  it('bounds non-git projects at the configured source directory', async () => {
    const root = await fixture()
    await file(root, 'AGENTS.md', 'OUTSIDE')
    await file(root, 'project/AGENTS.md', 'INSIDE')
    const folder = join(root, 'project')
    const snapshot = await createProjectRulesSnapshot('run', [folder])
    snapshot.activeScopes = await discoverProjectRules(snapshot, folder, reader())
    expect(projectRulesText(snapshot)).toContain('INSIDE')
    expect(projectRulesText(snapshot)).not.toContain('OUTSIDE')
  })

  it('deduplicates linked roots and rule contents but preserves independent scopes', async () => {
    const root = await fixture()
    await file(root, 'one/AGENTS.md', 'SHARED')
    await mkdir(join(root, 'two'))
    await symlink(join(root, 'one/AGENTS.md'), join(root, 'two/AGENTS.md'))
    await symlink(join(root, 'one'), join(root, 'alias'))
    const snapshot = await createProjectRulesSnapshot('run', [join(root, 'one'), join(root, 'alias'), join(root, 'two')])
    for (const source of snapshot.roots) snapshot.activeScopes.push(...await discoverProjectRules(snapshot, source.folder, reader()))
    expect(snapshot.roots).toHaveLength(2)
    expect(snapshot.documents).toHaveLength(1)
    expect(ruleScopeIds(snapshot)).toHaveLength(2)
    expect(projectRulesText(snapshot).match(/SHARED/g)).toHaveLength(1)
  })

  it('freezes contents and absence across serialization and incremental discovery', async () => {
    const root = await fixture()
    await file(root, 'AGENTS.md', 'ORIGINAL')
    await mkdir(join(root, 'child'))
    let snapshot = await createProjectRulesSnapshot('run', [root])
    snapshot.activeScopes = await discoverProjectRules(snapshot, join(root, 'child'), reader())
    snapshot = JSON.parse(JSON.stringify(snapshot))
    await file(root, 'AGENTS.md', 'CHANGED')
    await file(root, 'child/AGENTS.md', 'ADDED LATER')
    snapshot.activeScopes = await discoverProjectRules(snapshot, join(root, 'child/deeper'), reader())
    expect(projectRulesText(snapshot)).toContain('ORIGINAL')
    expect(projectRulesText(snapshot)).not.toContain('CHANGED')
    expect(projectRulesText(snapshot)).not.toContain('ADDED LATER')
    const fresh = await createProjectRulesSnapshot('next', [root])
    fresh.activeScopes = await discoverProjectRules(fresh, join(root, 'child'), reader())
    expect(projectRulesText(fresh)).toContain('CHANGED')
    expect(projectRulesText(fresh)).toContain('ADDED LATER')
  })

  it.each(['cycle', 'oversized', 'invalid-utf8', 'directory'])('rejects %s rules without partial adoption', async (kind) => {
    const root = await fixture()
    const path = join(root, 'AGENTS.md')
    if (kind === 'cycle') await symlink(path, path)
    if (kind === 'oversized') await writeFile(path, 'x'.repeat(projectRuleLimits.fileBytes + 1))
    if (kind === 'invalid-utf8') await writeFile(path, Buffer.from([0xff]))
    if (kind === 'directory') await mkdir(path)
    const snapshot = await createProjectRulesSnapshot('run', [root])
    await expect(discoverProjectRules(snapshot, root, reader())).rejects.toThrow('Project rules cannot be applied')
    expect(snapshot.documents).toEqual([])
  })

  it('requests authorization for the real rule file and honors cancellation before reading', async () => {
    const root = await fixture()
    await file(root, 'outside/rules.md', 'EXTERNAL')
    await mkdir(join(root, 'project'))
    await symlink(join(root, 'outside/rules.md'), join(root, 'project/AGENTS.md'))
    const snapshot = await createProjectRulesSnapshot('run', [join(root, 'project')])
    const authorizeRead = vi.fn(() => { throw new Error('denied') })
    await expect(discoverProjectRules(snapshot, join(root, 'project'), { authorizeRead })).rejects.toThrow('denied')
    expect(authorizeRead).toHaveBeenCalledWith(join(root, 'outside/rules.md'))
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(discoverProjectRules(snapshot, join(root, 'project'), { authorizeRead, signal: controller.signal })).rejects.toThrow('cancelled')
    expect(snapshot.documents).toEqual([])
  })

  it('checks descendant source/destination scopes for atomic directory moves without following links', async () => {
    const root = await fixture()
    await mkdir(join(root, 'source/child'), { recursive: true })
    await symlink(join(root, 'source'), join(root, 'source/child/loop'))
    const directories = await mutationDirectories(join(root, 'source'), join(root, 'target'))
    expect(directories).toEqual(expect.arrayContaining([root, join(root, 'source'), join(root, 'source/child'), join(root, 'target'), join(root, 'target/child')]))
    expect(directories.some((path) => path.includes('loop'))).toBe(false)
  })
})
