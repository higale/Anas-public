import { mkdtemp, mkdir, realpath, rm, symlink, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentAccessMode } from '@shared/agentTypes'
import { bundledSearchEnvironment } from './bundledRipgrep'
import { createShellCommandAuthorization } from './shellCommandAuthorization'
import { runShellCommand, type CommandShellInfo } from './shellRuntime'
import * as skillsStore from './skillsStore'
import { defaultCapabilities } from '@shared/agentCapabilities'

vi.mock('./runtimeLogger', () => ({ runtimeLog: vi.fn() }))
const directories: string[] = []
const shell: CommandShellInfo = { executable: '/bin/zsh', name: 'zsh', family: 'posix' }
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'anas-zsh-read-')))
  directories.push(root)
  const project = join(root, '项目 space'), config = join(root, 'config'), outside = join(root, 'outside')
  await Promise.all([project, config, outside].map((dir) => mkdir(dir)))
  await writeFile(join(project, '文档 notes.txt'), 'needle one\nneedle two\nother\n')
  await writeFile(join(outside, '文档 notes.txt'), 'outside\n')
  const search = await bundledSearchEnvironment({ ...process.env, ZDOTDIR: config, RIPGREP_CONFIG_PATH: '' })
  let mode: AgentAccessMode = 'strict_approval'
  const options = { shell, env: search.env, rgExecutable: search.executable, primaryFolder: project,
    trustedFolders: [project], accessMode: () => mode }
  return { root, project, config, outside, options, search, authorization: createShellCommandAuthorization(options),
    mode: (value: AgentAccessMode) => { mode = value } }
}
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

describe.skipIf(process.platform !== 'darwin')('macOS original-command read authorization', () => {
  it('requires approval when physical and normalized script paths differ, including after retargeting a link', async () => {
    const h = await fixture()
    const script = join(h.project, 'query.sh')
    await writeFile(script, 'printf INSIDE')
    await writeFile(join(h.outside, 'query.sh'), 'printf OUTSIDE')
    await mkdir(join(h.project, 'child'))
    await mkdir(join(h.outside, 'child'))
    const link = join(h.project, 'link')
    await symlink(join(h.project, 'child'), link)
    vi.spyOn(skillsStore, 'findSkillScriptExemption').mockImplementation(async target =>
      target === script ? { skillId: 'user:query', root: h.project, script } : undefined)
    const analyzer = createShellCommandAuthorization({ ...h.options, skills: { selection: defaultCapabilities.skills, allowUserInvocation: true } })
    const args = Object.freeze({ command: `/bin/sh '${h.project}/link/../query.sh'` })
    expect((await analyzer.inspect(args))?.skillScript?.script).toBe(script)
    await rm(link)
    await symlink(join(h.outside, 'child'), link)
    for (const operand of ['link/../query.sh', `${h.project}/link/../query.sh`]) {
      const command = `/bin/sh '${operand}'`
      expect(await analyzer.requiresApproval({ command })).toBe(true)
      let output = ''
      await runShellCommand({ command, workingDir: h.project, env: h.search.env, timeoutSec: 5, keepProcesses: false }, shell, undefined,
        { onResult: result => { expect(result.ok).toBe(true); output = result.stdout } })
      expect(output).toBe('OUTSIDE')
    }
    // The inverse traversal must also remain manual: some interpreters open a
    // normalized entry path while others open the literal physical path.
    await symlink(join(h.project, 'child'), join(h.outside, 'link'))
    expect(await analyzer.requiresApproval({ command: `/bin/sh '${h.outside}/link/../query.sh'` })).toBe(true)
  })

  it('resolves the actual executable through parent traversal without changing the command', async () => {
    const h = await fixture()
    await mkdir(join(h.outside, 'child'))
    await symlink(join(h.outside, 'child'), join(h.project, 'link'))
    for (const [directory, marker] of [[h.project, 'INSIDE'], [h.outside, 'OUTSIDE']]) {
      await writeFile(join(directory, 'sh'), `#!/bin/sh\nprintf '${marker}:'\nexec /bin/sh "$@"\n`, { mode: 0o755 })
    }
    const script = join(h.project, 'query.sh')
    await writeFile(script, 'printf SCRIPT')
    vi.spyOn(skillsStore, 'findSkillScriptExemption').mockResolvedValue({ skillId: 'user:query', root: h.project, script })
    const analyzer = createShellCommandAuthorization({ ...h.options, skills: { selection: defaultCapabilities.skills, allowUserInvocation: true } })
    const command = `'${h.project}/link/../sh' '${script}'`
    const args = Object.freeze({ command })
    expect((await analyzer.inspect(args))?.skillScript?.executor).toBe(join(h.outside, 'sh'))
    let output = ''
    await runShellCommand({ command, workingDir: h.project, env: h.search.env, timeoutSec: 5, keepProcesses: false }, shell, undefined,
      { onResult: result => { expect(result.ok).toBe(true); output = result.stdout } })
    expect(output).toBe('OUTSIDE:SCRIPT')
    expect(args.command).toBe(command)
  })

  it('applies project read boundaries to the physical target of parent traversal', async () => {
    const h = await fixture()
    await mkdir(join(h.outside, 'child'))
    await symlink(join(h.outside, 'child'), join(h.project, 'link'))
    const args = { command: "cat 'link/../文档 notes.txt'" }
    expect(await h.authorization.requiresApproval(args)).toBe(true)
    h.mode('read_only_allowed')
    expect((await h.authorization.inspect(args))?.paths).toContain(join(h.outside, '文档 notes.txt'))
  })

  it('binds a literal Skill script and preserves arguments while rejecting extra commands and revocation', async () => {
    const h = await fixture()
    const script = join(h.outside, 'query.sh')
    await writeFile(script, 'printf "%s\\n" "$@"\n')
    const grant = vi.spyOn(skillsStore, 'findSkillScriptExemption').mockResolvedValue({ skillId: 'user:query', root: h.outside, script })
    const analyzer = createShellCommandAuthorization({ ...h.options, skills: { selection: defaultCapabilities.skills, allowUserInvocation: true } })
    for (const interpreter of ['/bin/sh', 'sh']) {
      const command = `${interpreter} '${script}' --month 2026-09 'a; b && c'`
      const args = Object.freeze({ command })
      expect((await analyzer.inspect(args))?.skillScript).toMatchObject({ skillId: 'user:query', script })
      let output = ''
      await runShellCommand({ command, workingDir: h.project, env: h.search.env, timeoutSec: 5, keepProcesses: false }, shell, undefined,
        { onResult: result => { expect(result.ok).toBe(true); output = result.stdout } })
      expect(output).toBe('--month\n2026-09\na; b && c\n')
      for (const extra of ['; true', ' | head -n 1', ' > output', ' $(true)']) {
        expect(await analyzer.requiresApproval({ command: command + extra })).toBe(true)
      }
    }
    grant.mockResolvedValue(undefined)
    expect(await analyzer.requiresApproval({ command: `/bin/sh '${script}'` })).toBe(true)
  })

  it.each([
    "cat '文档 notes.txt'", 'head -n 2 "文档 notes.txt"', "tail -n 1 '文档 notes.txt'",
    "wc -l '文档 notes.txt'", "cat '文档 notes.txt' | head -n 2 | wc -l",
    "rg -n needle '文档 notes.txt' | head -n 1", "rg --files -g '*.txt'",
    "rg 'needle (one|two)$' '文档 notes.txt'", 'rg needle .', 'rg --files .'
  ])('auto-approves and executes unchanged: %s', async (command) => {
    const h = await fixture()
    const args = Object.freeze({ command })
    expect(await h.authorization.requiresApproval(args)).toBe(false)
    expect(args).toEqual({ command })
    let stdout = '', ok = false
    await runShellCommand({ command: args.command, workingDir: h.project, env: h.search.env,
      pathPrepend: h.search.directory, timeoutSec: 5, keepProcesses: false }, shell, undefined, {
      onResult: (result) => { stdout = result.stdout; ok = result.ok }
    })
    expect(ok).toBe(true)
    expect(stdout.trim()).not.toBe('')
  })

  it.each([
    "cat *(e:'touch marker':)", 'cat ~root/file', 'cat =file', 'cat $HOME/file',
    'cat $(touch marker)', 'cat `touch marker`', 'cat <(touch marker)', 'cat *.txt',
    'cat file > marker', 'cat file; touch marker', 'cat file && touch marker', 'cat file &',
    'cat file |', 'cat "unterminated', 'cat file\nrm marker', 'cat file # comment',
    'rg --pre helper needle .', 'rg -L needle .', 'rg --unknown needle .',
    'tail -f file', 'head -n nope file', 'wc --files0-from file', 'sort -o marker file',
    'cat', 'cat file | cat other', 'command cat file', 'A=value cat file', 'cat file || cat other'
  ])('keeps unproven syntax intact for HITL: %s', async (command) => {
    const h = await fixture()
    const args = Object.freeze({ command })
    expect(await h.authorization.requiresApproval(args)).toBe(true)
    expect(args).toEqual({ command })
  })

  it.each(["alias cat='touch marker'", "function cat() { touch marker; }", "function /bin/cat() { touch marker; }",
    "alias -g needle='> marker'", 'setopt rcquotes', 'setopt cshjunkiequotes', 'cd /'])(
    'detects changed login bindings without running the requested command: %s', async (startup) => {
    const h = await fixture()
    const args = Object.freeze({ command: "cat '文档 notes.txt'" })
    expect(await h.authorization.requiresApproval(args)).toBe(false)
    await writeFile(join(h.config, '.zshenv'), startup + '\n')
    expect(await h.authorization.requiresApproval(args)).toBe(true)
    await expect(readFile(join(h.project, 'marker'))).rejects.toThrow()
  })

  it('requires review for startup-injected rg config instead of overriding it', async () => {
    const h = await fixture()
    await writeFile(join(h.config, '.zprofile'), "export RIPGREP_CONFIG_PATH=/tmp/custom-rg-config\n")
    expect(await h.authorization.requiresApproval({ command: 'rg needle .' })).toBe(true)
    expect(await h.authorization.requiresApproval({ command: "rg -e '--no-config' ." })).toBe(true)
    expect(await h.authorization.requiresApproval({ command: 'rg --no-config needle .' })).toBe(false)
  })

  it('rechecks canonical targets and access mode without changing original arguments', async () => {
    const h = await fixture()
    h.mode('read_only_allowed')
    const args = Object.freeze({ command: "cat '../outside/文档 notes.txt'" })
    expect(await h.authorization.requiresApproval(args)).toBe(false)
    h.mode('strict_approval')
    expect(await createShellCommandAuthorization(h.options).requiresApproval(args)).toBe(true)
    await rm(join(h.project, '文档 notes.txt'))
    await symlink(join(h.outside, '文档 notes.txt'), join(h.project, '文档 notes.txt'))
    expect(await h.authorization.requiresApproval({ command: "cat '文档 notes.txt'" })).toBe(true)
  })

  it('retains manual approval for PTY, retained processes and Bash, and honors cancellation', async () => {
    const h = await fixture()
    for (const extra of [{ pty: { columns: 80, rows: 24 } }, { keep_processes: true }]) {
      expect(await h.authorization.requiresApproval({ command: "cat '文档 notes.txt'", ...extra })).toBe(true)
    }
    expect(await createShellCommandAuthorization({ ...h.options, shell: { ...shell, executable: '/bin/bash' } })
      .requiresApproval({ command: "cat '文档 notes.txt'" })).toBe(true)
    const controller = new AbortController()
    controller.abort()
    await expect(createShellCommandAuthorization({ ...h.options, signal: controller.signal })
      .requiresApproval({ command: "cat '文档 notes.txt'" })).rejects.toThrow()
  })
})
