import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { prepareConsoleRestart, type ConsoleRestartPlan } from './consoleRestart'

const electron = vi.hoisted(() => ({
  isPackaged: false, getAppPath: vi.fn(), relaunch: vi.fn(), quit: vi.fn()
}))
vi.mock('electron', () => ({ app: electron }))
vi.mock('./config/dataDir', () => ({ getDataDir: () => '/tmp/anas console profile' }))

const temporaryDirectories: string[] = []
const plans: ConsoleRestartPlan[] = []

afterEach(async () => {
  await Promise.all(plans.splice(0).map(plan => plan.dispose()))
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "anas console 中文 '$` %!-"))
  temporaryDirectories.push(directory)
  const executable = join(directory, 'fixture')
  await writeFile(executable, '#!/bin/sh\nprintf "raw stdout 中文\\n"\nprintf "raw stderr 中文\\n" >&2\nprintf "%s\\n" "$@"\nprintf "cwd=%s\\n" "$PWD"\n', { mode: 0o700 })
  return { directory, executable }
}

function run(command: string, args: string[], env = process.env): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.once('error', reject)
    child.once('close', code => resolve({ stdout, stderr, code }))
  })
}

describe.runIf(process.platform === 'darwin')('console restart launch scripts', () => {
  it('launches the packaged executable with raw stdout/stderr and the exact profile, then removes its script', async () => {
    const { directory, executable } = await fixture()
    const dataDir = join(directory, 'profile $(touch SHOULD_NOT_EXIST)')
    const plan = await prepareConsoleRestart({
      platform: 'darwin', executable, appPath: '/irrelevant/app.asar',
      cwd: directory, dataDir, packaged: true, env: {}
    })
    plans.push(plan)
    expect(plan.execPath).toBe('/usr/bin/open')
    expect(plan.args.slice(0, 2)).toEqual(['-a', 'Terminal'])
    const script = plan.args.at(-1)!
    const result = await run('/bin/sh', [script])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`raw stdout 中文\n--data-dir\n${dataDir}\n`)
    expect(result.stdout).toContain(`cwd=${directory}`)
    expect(result.stderr).toBe('raw stderr 中文\n')
    await expect(access(dirname(script))).rejects.toThrow()
    expect(await readdir(directory)).toEqual(['fixture'])
  })

  it('includes the app entry for an unpackaged preview without carrying runtime inspector flags', async () => {
    const { directory, executable } = await fixture()
    const plan = await prepareConsoleRestart({
      platform: 'darwin', executable, appPath: directory, cwd: directory,
      dataDir: join(directory, 'profile'), packaged: false, env: {}
    })
    plans.push(plan)
    const result = await run('/bin/sh', [plan.args.at(-1)!], { ...process.env, ELECTRON_RUN_AS_NODE: '1' })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain(`raw stdout 中文\n${directory}\n--data-dir\n`)
  })

  it('restarts the Vite owner for live development rather than reusing its dying renderer server', async () => {
    const { directory } = await fixture()
    const viteDirectory = join(directory, 'node_modules', 'electron-vite')
    await mkdir(viteDirectory, { recursive: true })
    await writeFile(join(directory, 'package.json'), '{}')
    await writeFile(join(viteDirectory, 'package.json'), JSON.stringify({ main: 'index.cjs' }))
    await writeFile(join(viteDirectory, 'index.cjs'), `exports.createServer = async options => console.log(JSON.stringify({
      options, args: JSON.parse(process.env.ELECTRON_CLI_ARGS), cwd: process.cwd(),
      runAsNode: process.env.ELECTRON_RUN_AS_NODE, rendererUrl: process.env.ELECTRON_RENDERER_URL
    }))`)
    const plan = await prepareConsoleRestart({
      platform: 'darwin', executable: process.execPath, appPath: directory, cwd: directory,
      dataDir: directory, packaged: false, env: { ELECTRON_RENDERER_URL: 'http://localhost:15173' }
    })
    plans.push(plan)
    const script = plan.args.at(-1)!
    const result = await run('/bin/sh', [script], { ...process.env, ELECTRON_RENDERER_URL: 'http://localhost:15173' })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({
      options: { root: directory }, args: ['--data-dir', directory], cwd: await realpath(directory)
    })
    await expect(access(dirname(script))).rejects.toThrow()
  })

  it('fails preparation before scheduling an exit if the executable is missing', async () => {
    await expect(prepareConsoleRestart({
      platform: 'darwin', executable: '/nonexistent/Anas', appPath: process.cwd(),
      cwd: process.cwd(), dataDir: '/tmp/anas', packaged: true, env: {}
    })).rejects.toThrow()
    expect(electron.relaunch).not.toHaveBeenCalled()
    expect(electron.quit).not.toHaveBeenCalled()
  })

  it('schedules only one relaunch for repeated clicks and uses the normal quit lifecycle', async () => {
    vi.resetModules()
    const { restartInConsole } = await import('./consoleRestart')
    electron.getAppPath.mockReturnValue(process.cwd())
    electron.relaunch.mockImplementation(({ execPath, args }: ConsoleRestartPlan) => {
      expect(execPath).toBe('/usr/bin/open')
      expect(electron.quit).not.toHaveBeenCalled()
      temporaryDirectories.push(dirname(args.at(-1)!))
    })
    await Promise.all([restartInConsole(), restartInConsole()])
    expect(electron.relaunch).toHaveBeenCalledOnce()
    expect(electron.quit).toHaveBeenCalledOnce()
  })
})

describe('console restart platform selection', () => {
  it('keeps the app running when no Linux system terminal is installed', async () => {
    await expect(prepareConsoleRestart({
      platform: 'linux', executable: process.execPath, appPath: process.cwd(),
      cwd: process.cwd(), dataDir: '/tmp/anas', packaged: true, env: { PATH: '' }
    })).rejects.toThrow('No supported system terminal')
  })
})

describe('Windows console restart', () => {
  it('uses a visible console with inherited streams and the portable launcher when present', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'anas-console-windows-'))
    temporaryDirectories.push(directory)
    const systemRoot = join(directory, 'Windows')
    const powerShellDirectory = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')
    await mkdir(powerShellDirectory, { recursive: true })
    await writeFile(join(powerShellDirectory, 'powershell.exe'), '', { mode: 0o700 })
    const dataDir = join(directory, "中文 %! ' profile")
    const plan = await prepareConsoleRestart({
      platform: 'win32', executable: '/unused/extracted/Anas.exe', appPath: process.cwd(),
      cwd: directory, dataDir, packaged: true,
      env: { ...process.env, SystemRoot: systemRoot, PORTABLE_EXECUTABLE_FILE: process.execPath }
    })
    plans.push(plan)
    const script = await readFile(plan.args.at(-1)!, 'utf8')
    expect(script.charCodeAt(0)).toBe(0xFEFF)
    expect(script).toContain('-NoNewWindow -Wait')
    expect(script).toContain(process.execPath.replaceAll("'", "''"))
    expect(script).toContain(dataDir.replaceAll("'", "''"))
    expect(script).not.toContain('RedirectStandard')
  })
})
