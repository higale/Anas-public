import { app } from 'electron'
import { constants } from 'node:fs'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { getDataDir } from './config/dataDir'

interface ConsoleRestartOptions {
  platform: NodeJS.Platform
  executable: string
  appPath: string
  dataDir: string
  cwd: string
  packaged: boolean
  env: NodeJS.ProcessEnv
}

export interface ConsoleRestartPlan {
  execPath: string
  args: string[]
  dispose(): Promise<void>
}

function shellLiteral(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function powerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

// Start-Process joins ArgumentList without quoting individual arguments.
function windowsArgument(value: string): string {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/g, '$&$&')}"`
}

async function linuxTerminal(env: NodeJS.ProcessEnv): Promise<{ execPath: string; args: string[] }> {
  const candidates = [
    ['x-terminal-emulator', '-e'],
    ['gnome-terminal', '--'],
    ['konsole', '-e'],
    ['xterm', '-e']
  ]
  for (const [name, argument] of candidates) {
    for (const directory of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
      const execPath = join(directory, name!)
      try {
        await access(execPath, constants.X_OK)
        return { execPath, args: [argument!] }
      } catch { /* Try the next installed terminal. */ }
    }
  }
  throw new Error('No supported system terminal was found (x-terminal-emulator, gnome-terminal, konsole or xterm).')
}

export async function prepareConsoleRestart(options: ConsoleRestartOptions): Promise<ConsoleRestartPlan> {
  const { platform, appPath, dataDir, packaged, env } = options
  const executable = packaged && platform === 'win32'
    ? env.PORTABLE_EXECUTABLE_FILE || options.executable
    : packaged && platform === 'linux'
      ? env.APPIMAGE || options.executable
      : options.executable
  const liveDevelopment = !packaged && Boolean(env.ELECTRON_RENDERER_URL)
  // Portable launchers may remove the extracted application's working directory.
  const cwd = liveDevelopment ? appPath : packaged && executable !== options.executable ? dirname(executable) : options.cwd
  await access(executable, constants.X_OK)
  await access(cwd, constants.R_OK)
  if (liveDevelopment) await access(join(appPath, 'node_modules/electron-vite/package.json'))

  const terminal = platform === 'darwin'
    ? { execPath: '/usr/bin/open', args: ['-a', 'Terminal'] }
    : platform === 'win32'
      ? {
          execPath: join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          args: ['-NoLogo', '-NoProfile', '-NoExit', '-ExecutionPolicy', 'Bypass', '-File']
        }
      : await linuxTerminal(env)
  await access(terminal.execPath, constants.X_OK)

  // This must survive the old instance's profile tmp cleanup during shutdown.
  const directory = await mkdtemp(join(tmpdir(), 'anas-console-'))
  const dispose = (): Promise<void> => rm(directory, { recursive: true, force: true })
  try {
    let args = [...(packaged ? [] : [appPath]), '--data-dir', dataDir]
    if (liveDevelopment) {
      const bootstrap = join(directory, 'dev.cjs')
      // Restart the Vite owner as well: its server exits with the old Electron child.
      await writeFile(bootstrap, [
        "const fs = require('node:fs')",
        'fs.unlinkSync(__filename)',
        'fs.rmdirSync(__dirname)',
        'delete process.env.ELECTRON_RUN_AS_NODE',
        'delete process.env.ELECTRON_RENDERER_URL',
        `process.env.ELECTRON_CLI_ARGS = ${JSON.stringify(JSON.stringify(['--data-dir', dataDir]))}`,
        `const fromApp = require('node:module').createRequire(${JSON.stringify(join(appPath, 'package.json'))})`,
        "import(require('node:url').pathToFileURL(fromApp.resolve('electron-vite')).href)",
        `  .then(vite => vite.createServer({ root: ${JSON.stringify(appPath)} }, {}))`,
        '  .catch(error => { console.error(error); process.exitCode = 1 })',
        ''
      ].join('\n'), { mode: 0o600 })
      args = [bootstrap]
    }

    const scriptPath = join(directory, platform === 'win32' ? 'console.ps1' : 'console.command')
    const script = platform === 'win32'
      ? [
          "$ErrorActionPreference = 'Stop'",
          "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
          'Remove-Item -LiteralPath $PSCommandPath',
          ...(!liveDevelopment ? [`Remove-Item -LiteralPath ${powerShellLiteral(directory)}`] : []),
          `Set-Location -LiteralPath ${powerShellLiteral(cwd)}`,
          liveDevelopment
            ? "$env:ELECTRON_RUN_AS_NODE = '1'"
            : "Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue",
          'Remove-Item Env:ELECTRON_NO_ATTACH_CONSOLE -ErrorAction SilentlyContinue',
          `Start-Process -FilePath ${powerShellLiteral(executable)} -ArgumentList ${powerShellLiteral(args.map(windowsArgument).join(' '))} -NoNewWindow -Wait`,
          ''
        ].join('\n')
      : [
          '#!/bin/sh',
          'set -eu',
          'rm -- "$0"',
          ...(!liveDevelopment ? [`rmdir -- ${shellLiteral(directory)}`] : []),
          `cd -- ${shellLiteral(cwd)}`,
          'unset ELECTRON_RUN_AS_NODE ELECTRON_NO_ATTACH_CONSOLE',
          ...(liveDevelopment ? ['export ELECTRON_RUN_AS_NODE=1'] : []),
          `exec ${[executable, ...args].map(shellLiteral).join(' ')}`,
          ''
        ].join('\n')
    // Windows PowerShell 5 requires a BOM to read non-ASCII paths as UTF-8.
    await writeFile(scriptPath, (platform === 'win32' ? '\uFEFF' : '') + script, { mode: 0o700 })
    return { execPath: terminal.execPath, args: [...terminal.args, scriptPath], dispose }
  } catch (error) {
    await dispose()
    throw error
  }
}

let restartPending = false

export async function restartInConsole(): Promise<void> {
  if (restartPending) return
  restartPending = true
  let plan: ConsoleRestartPlan | undefined
  try {
    plan = await prepareConsoleRestart({
      platform: process.platform,
      executable: process.execPath,
      appPath: app.getAppPath(),
      dataDir: getDataDir(),
      cwd: process.cwd(),
      packaged: app.isPackaged,
      env: process.env
    })
    // Electron's relauncher waits for this process to exit and release its lock.
    app.relaunch({ execPath: plan.execPath, args: plan.args })
    app.quit()
  } catch (error) {
    restartPending = false
    await plan?.dispose()
    throw error
  }
}
