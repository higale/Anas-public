import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentAccessMode } from '@shared/agentTypes'
import { bundledSearchEnvironment, withExecutableDirectory } from './bundledRipgrep'
import { getCommandShell, prepareShellCommand, resolveShellInvocation } from './shellRuntime'
import { createShellCommandAuthorization } from './shellCommandAuthorization'
import { parsePowerShellCommands } from './powershellCommandAnalysis'
import * as skillsStore from './skillsStore'
import { defaultCapabilities } from '@shared/agentCapabilities'

const execFileAsync = promisify(execFile)
const directories: string[] = []
async function fixture(accessMode: AgentAccessMode = 'strict_approval') {
  const root = await mkdtemp(join(tmpdir(), 'anas-shell-analysis-'))
  directories.push(root)
  const project = join(root, 'project space 中文')
  const outside = join(root, 'outside')
  await mkdir(project); await mkdir(outside)
  await writeFile(join(project, 'notes.txt'), 'needle one\nneedle two\nother\n')
  await writeFile(join(outside, 'secret.txt'), 'outside\n')
  const shell = await getCommandShell()
  const search = await bundledSearchEnvironment(process.env)
  const options = { shell, env: search.env, rgExecutable: search.executable, primaryFolder: project,
    trustedFolders: [project], accessMode: () => accessMode }
  return { ...options, project, outside, search, authorization: createShellCommandAuthorization(options) }
}
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

describe.skipIf(process.platform !== 'win32')('Windows Shell read authorization', () => {
  it('recognizes one Skill invocation outside the project, executes the original command, and observes revocation', async () => {
    const h = await fixture()
    const nodeExecutable = (await execFileAsync('node', ['-p', 'process.execPath'], { encoding: 'utf8', windowsHide: true })).stdout.trim()
    const script = join(h.outside, 'query.js')
    await writeFile(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
    const grant = { skillId: 'user:query', root: await realpath(h.outside), script: await realpath(script) }
    const exemption = vi.spyOn(skillsStore, 'findSkillScriptExemption').mockResolvedValue(grant)
    const scope = { selection: defaultCapabilities.skills, allowUserInvocation: true }
    const analyzer = createShellCommandAuthorization({ ...h, skills: scope })
    const command = `& '${nodeExecutable}' '${script}' --month 2026-09 --text 'a; b && c 中文'`
    const args = Object.freeze({ command, working_dir: h.project })
    const plan = await analyzer.inspect(args, { name: 'query', sourceAlias: 'user' })
    expect(plan?.skillScript).toMatchObject({ ...grant, executor: await realpath(nodeExecutable) })
    expect(exemption).toHaveBeenCalledWith(grant.script, scope, { name: 'query', sourceAlias: 'user' })
    expect(args).toEqual({ command, working_dir: h.project })
    const invocation = await resolveShellInvocation(command, h.shell)
    const result = await execFileAsync(invocation.executable, invocation.args, { cwd: h.project, env: h.search.env,
      windowsHide: true, encoding: 'utf8', timeout: 3000 })
    expect(JSON.parse(result.stdout)).toEqual(['--month', '2026-09', '--text', 'a; b && c 中文'])
    exemption.mockResolvedValue(undefined)
    expect(await analyzer.requiresApproval(args)).toBe(true)
  })

  it('does not use Skill approval for sequences, expansions, preloads or other execution modes', async () => {
    const h = await fixture()
    const nodeExecutable = (await execFileAsync('node', ['-p', 'process.execPath'], { encoding: 'utf8', windowsHide: true })).stdout.trim()
    const script = join(h.outside, 'query.js')
    await writeFile(script, 'process.stdout.write("ok")')
    const exemption = vi.spyOn(skillsStore, 'findSkillScriptExemption').mockResolvedValue({
      skillId: 'user:query', root: h.outside, script })
    const analyzer = createShellCommandAuthorization({ ...h, skills: { selection: defaultCapabilities.skills, allowUserInvocation: false } })
    const call = `& '${nodeExecutable}' '${script}'`
    for (const command of [
      `${call}; Get-Date`, `${call} | Select-Object -First 1`, `${call} > result.txt`, `${call} && Get-Date`,
      `${call} $(Get-Date)`, `${call} @args`, `${call} $env:HOME`,
      `& '${nodeExecutable}' -e 'console.log(1)' '${script}'`,
      `& '${nodeExecutable}' --require other.js '${script}'`,
      `Set-Location '${h.outside}'; ${call}`
    ]) {
      const args = Object.freeze({ command })
      expect(await analyzer.requiresApproval(args), command).toBe(true)
      expect(args.command).toBe(command)
    }
    expect(exemption).not.toHaveBeenCalled()
    expect(await analyzer.requiresApproval({ command: call, pty: { columns: 80, rows: 24 } })).toBe(true)
    expect(await analyzer.requiresApproval({ command: call, keep_processes: true })).toBe(true)
    expect(await h.authorization.requiresApproval({ command: call })).toBe(true)
  })

  it.each([null, [], 'wrong', 3])('leaves malformed arguments %j to tool validation without crashing preflight', async args => {
    const h = await fixture()
    await expect(h.authorization.inspect(args as unknown as Record<string, unknown>)).resolves.toBeUndefined()
  })

  it.each([
    'rg -n needle notes.txt',
    'rg --files -g "*.txt"',
    'rg -n needle notes.txt | Select-Object -First 1',
    "Get-Content -LiteralPath 'notes.txt' | Select-String -Pattern needle | Select-Object -First 1",
    "Get-Content notes.txt -TotalCount 2; Test-Path notes.txt",
    'Get-ChildItem | Select-Object -First 1',
    'Get-Content notes.txt | Sort-Object -Unique | Measure-Object -Line'
  ])('auto-approves and actually executes a deterministic read: %s', async (command) => {
    const h = await fixture()
    const args = Object.freeze({ command })
    expect(await h.authorization.requiresApproval(args)).toBe(false)
    expect(args).toEqual({ command })
    const prepared = await prepareShellCommand({ command: args.command }, h.project)
    if ('ok' in prepared) throw new Error(prepared.error)
    const invocation = await resolveShellInvocation(prepared.command, h.shell)
    const output = await execFileAsync(invocation.executable, invocation.args, { cwd: prepared.workingDir,
      env: h.search.env, windowsHide: true, encoding: 'utf8', timeout: 3000 })
    expect(output.stderr).toBe('')
    expect(output.stdout.trim()).not.toBe('')
  })
  it.each([
    'rg --pre helper needle .', 'rg -L needle .', 'rg needle . > result.txt',
    'rg needle . | Set-Content result.txt', 'rg needle . | ForEach-Object { $_ }',
    'Get-ChildItem | Select-String -Pattern needle', 'Get-Item notes.txt | Select-String -Pattern needle',
    'Get-Content $env:ANAS_TEST_PATH', 'Get-Content $(Write-Output notes.txt)',
    'Get-Content *.txt', 'Get-ChildItem -Recurse', 'Remove-Item notes.txt',
    'node script.js', '. ./script.ps1', 'rg --% needle .', 'rg needle . && rg two .',
    'function rg { Remove-Item notes.txt }; rg needle .', 'begin { Get-Content notes.txt }',
    'Get-Content -Raw:$true notes.txt', 'rg --unknown-option needle .', '#requires -Version 99\nGet-Content notes.txt',
    'Get-Content notes.txt | toString', 'Microsoft.PowerShell.Utility\\Get-Content notes.txt',
    'Microsoft.PowerShell.Management\\rg needle .'
  ])('leaves an unproven command unchanged for human authorization: %s', async (command) => {
    const h = await fixture()
    const args = { command }
    expect(await h.authorization.requiresApproval(args)).toBe(true)
    expect(args).toEqual({ command })
  })
  it('checks all targets, including pattern/ignore files and every statement', async () => {
    const h = await fixture()
    for (const command of [
      'rg needle ../outside', 'rg -f ../outside/secret.txt .', 'rg --ignore-file=../outside/secret.txt needle .',
      'Get-Content notes.txt; Get-Content ../outside/secret.txt'
    ]) expect(await h.authorization.requiresApproval({ command })).toBe(true)
    const readOnly = createShellCommandAuthorization({ ...h, accessMode: () => 'read_only_allowed' })
    expect(await readOnly.requiresApproval({ command: 'Get-Content ../outside/secret.txt' })).toBe(false)
    expect(await h.authorization.requiresApproval({ command: 'rg --version', working_dir: h.outside })).toBe(true)
  })
  it('resolves linked targets and rejects retargeting before dispatch', async () => {
    const h = await fixture()
    const link = join(h.project, 'link')
    await symlink(h.outside, link, 'junction')
    expect(await h.authorization.requiresApproval({ command: 'Get-Content link/secret.txt' })).toBe(true)
    const directory = join(h.project, 'data')
    await mkdir(directory)
    await writeFile(join(directory, 'secret.txt'), 'inside')
    const args: Record<string, unknown> = { command: 'Get-Content data/secret.txt' }
    expect(await h.authorization.requiresApproval(args)).toBe(false)
    await rm(directory, { recursive: true })
    await symlink(h.outside, directory, 'junction')
    expect(await h.authorization.requiresApproval(args)).toBe(true)
    expect(args).toEqual({ command: 'Get-Content data/secret.txt' })
  })
  it('parses without executing embedded code and fails closed when the parser fails', async () => {
    const h = await fixture()
    const target = join(h.project, 'notes.txt').replaceAll("'", "''")
    expect(await parsePowerShellCommands(`$(Set-Content '${target}' 'changed')`, h.shell.executable, h.search.env)).toBeUndefined()
    expect(await readFile(join(h.project, 'notes.txt'), 'utf8')).toContain('needle')
    const unavailable = createShellCommandAuthorization({ ...h, shell: { ...h.shell, executable: 'anas-nonexistent-shell.exe' } })
    expect(await unavailable.requiresApproval({ command: 'rg needle .' })).toBe(true)
  })
  it('can inspect original arguments after the runtime is recreated without changing them', async () => {
    const h = await fixture()
    const args: Record<string, unknown> = { command: 'rg -n needle notes.txt' }
    expect(await h.authorization.requiresApproval(args)).toBe(false)
    const resumed = createShellCommandAuthorization(h)
    expect(await resumed.requiresApproval(args)).toBe(false)
    expect(args).toEqual({ command: 'rg -n needle notes.txt' })
    await rm(join(h.project, 'notes.txt'))
    expect(await createShellCommandAuthorization(h).requiresApproval(args)).toBe(true)
  })
  it('rechecks a changed access mode at execution', async () => {
    const h = await fixture()
    let mode: AgentAccessMode = 'read_only_allowed'
    const authorization = createShellCommandAuthorization({ ...h, accessMode: () => mode })
    const args: Record<string, unknown> = { command: 'Get-Content ../outside/secret.txt' }
    expect(await authorization.requiresApproval(args)).toBe(false)
    mode = 'strict_approval'
    expect(await authorization.requiresApproval(args)).toBe(true)
  })
  it('preserves explicit rg output formatting and resolves bundled rg on the unmodified Shell PATH', async () => {
    const h = await fixture()
    const args: Record<string, unknown> = { command: 'rg --color always needle notes.txt' }
    expect(await h.authorization.requiresApproval(args)).toBe(false)
    expect(args).toEqual({ command: 'rg --color always needle notes.txt' })
    const invocation = await resolveShellInvocation('(Get-Command rg).Source', h.shell)
    const result = await execFileAsync(invocation.executable, invocation.args, { cwd: h.project, env: h.search.env,
      windowsHide: true, encoding: 'utf8', timeout: 3000 })
    expect(result.stdout.trim()).toBe(h.search.executable)
  })
  it('round-trips typographic quotes in literal filenames and patterns', async () => {
    const h = await fixture()
    const filename = 'notes\u2018\u2019\u201a\u201b.txt'
    await writeFile(join(h.project, filename), 'match\u2019here\n')
    for (const command of [`Get-Content "${filename}"`, `rg "match\u2019here" "${filename}"`]) {
      const args: Record<string, unknown> = { command }
      expect(await h.authorization.requiresApproval(args)).toBe(false)
      expect(args).toEqual({ command })
      const invocation = await resolveShellInvocation(command, h.shell)
      const result = await execFileAsync(invocation.executable, invocation.args, { cwd: h.project, env: h.search.env,
        windowsHide: true, encoding: 'utf8', timeout: 3000 })
      expect(result.stdout.trim()).toBe('match\u2019here')
    }
  })
  it('analyzes and executes with Windows PowerShell 5.1 as well as PowerShell 7', async () => {
    const h = await fixture()
    const shell = { executable: 'powershell.exe', name: 'Windows PowerShell', family: 'powershell' as const }
    const authorization = createShellCommandAuthorization({ ...h, shell })
    for (const command of ['Get-Content notes.txt -TotalCount 1', 'rg -n needle notes.txt | Select-Object -First 1']) {
      const args: Record<string, unknown> = { command }
      expect(await authorization.requiresApproval(args)).toBe(false)
      expect(args).toEqual({ command })
      const invocation = await resolveShellInvocation(command, shell)
      const result = await execFileAsync(invocation.executable, invocation.args, { cwd: h.project, env: h.search.env,
        windowsHide: true, encoding: 'utf8', timeout: 3000 })
      expect(result.stdout).toContain('needle one')
    }
  })
  it('preserves full access and rejects keeping processes as an auto-approved read', async () => {
    const h = await fixture()
    expect(await h.authorization.requiresApproval({ command: 'rg needle .', keep_processes: true })).toBe(true)
    const full = createShellCommandAuthorization({ ...h, accessMode: () => 'full_access' })
    const args = { command: 'node arbitrary-script.js' }
    expect(await full.requiresApproval(args)).toBe(false)
    expect(args.command).toBe('node arbitrary-script.js')
  })

  it('preserves parent ignore rules, relative output paths, comments, whitespace and working_dir', async () => {
    const h = await fixture()
    await writeFile(join(h.project, '..', '.ignore'), 'ignored.txt\n')
    await writeFile(join(h.project, 'ignored.txt'), 'needle ignored\n')
    const command = '# original comment\n  rg --no-require-git -n needle .  '
    const args = Object.freeze({ command, working_dir: '.', summary: 'Search' })
    expect(await h.authorization.requiresApproval(args)).toBe(false)
    expect(args).toEqual({ command, working_dir: '.', summary: 'Search' })
    const invocation = await resolveShellInvocation(args.command, h.shell)
    const result = await execFileAsync(invocation.executable, invocation.args, {
      cwd: h.project, env: h.search.env, windowsHide: true, encoding: 'utf8', timeout: 3000
    })
    expect(result.stdout).toContain('notes.txt:1:needle one')
    expect(result.stdout).not.toContain(h.project)
    expect(result.stdout).not.toContain('ignored.txt')
  })

  it('requests approval for implicit rg config without disabling it, but respects explicit --no-config', async () => {
    const h = await fixture()
    const config = join(h.project, 'rg-config')
    await writeFile(config, '--count\n')
    const env = { ...h.search.env, RIPGREP_CONFIG_PATH: config }
    const authorization = createShellCommandAuthorization({ ...h, env })
    const args = Object.freeze({ command: 'rg needle notes.txt' })
    expect(await authorization.requiresApproval(args)).toBe(true)
    expect(args.command).toBe('rg needle notes.txt')
    expect(await authorization.requiresApproval({ command: "rg -e '--no-config' notes.txt" })).toBe(true)
    const invocation = await resolveShellInvocation(args.command, h.shell)
    expect((await execFileAsync(invocation.executable, invocation.args, {
      cwd: h.project, env, windowsHide: true, encoding: 'utf8', timeout: 3000
    })).stdout.trim()).toBe('2')
    const explicit = Object.freeze({ command: 'rg --no-config needle notes.txt' })
    expect(await authorization.requiresApproval(explicit)).toBe(false)
    expect(explicit.command).toBe('rg --no-config needle notes.txt')
  })

  it('does not substitute bundled rg for another command resolved from PATH', async () => {
    const h = await fixture()
    await writeFile(join(h.outside, 'rg.cmd'), '@echo different\r\n')
    const authorization = createShellCommandAuthorization({ ...h, env: withExecutableDirectory(h.search.env, h.outside) })
    const args = Object.freeze({ command: 'rg needle notes.txt' })
    expect(await authorization.requiresApproval(args)).toBe(true)
    expect(args.command).toBe('rg needle notes.txt')
  })
})

it('does not mutate the host environment when adding bundled programs', () => {
  const env = { PATH: 'original', CUSTOM_VALUE: 'unchanged' }
  const next = withExecutableDirectory(env, 'bundled')
  expect(env.PATH).toBe('original')
  expect(next.PATH?.startsWith('bundled')).toBe(true)
  expect(next.CUSTOM_VALUE).toBe('unchanged')
})

it.skipIf(process.platform !== 'win32')('preserves Node process PATH precedence for differently cased environment keys', async () => {
  const env = { Path: 'host-path', PATH: 'configured-path', ELECTRON_RUN_AS_NODE: '1' }
  const baseline = await execFileAsync(process.execPath, ['-e', 'process.stdout.write(process.env.PATH)'], {
    env, windowsHide: true, encoding: 'utf8', timeout: 3000
  })
  expect(baseline.stdout).toBe('configured-path')
  expect(withExecutableDirectory(env, 'bundled').PATH).toBe(`bundled;${baseline.stdout}`)
  expect(withExecutableDirectory({ Path: 'host-path', PATH: '' }, 'bundled').PATH).toBe('bundled')
  expect(withExecutableDirectory({ Path: 'host-path', PATH: undefined }, 'bundled').PATH).toBe('bundled')
})
