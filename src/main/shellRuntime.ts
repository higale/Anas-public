import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { promisify } from 'node:util'
import { armCurrentAgentToolEffect } from './agent/toolEffectScope'
import { runtimeLog } from './runtimeLogger'
import { resolveWorkspacePath } from './workspacePath'
import { createWindowsKillOnCloseJob, type WindowsProcessJob } from './windowsProcessJob'
import { DetachedWindowsShellSupervisor } from './windowsDetachedShellSupervisor'
import { WindowsPtyShellSupervisor } from './windowsPtyShellSupervisor'
import { commandShellToolName, maxCommandTimeoutSeconds } from '@shared/commandShell'
import { terminalSizeSchema, type TerminalSize } from '@shared/terminal'
import { PtyShellSupervisor, type ShellTerminalControl } from './ptyShellSupervisor'
import { createPosixPtySession } from './posixPtySession'

const defaultShellTimeoutSec = 0
const maxShellOutputChars = 120_000
const forceKillDelayMs = 2_000
const shellVersionProbeTimeoutMs = 3_000
const execFileAsync = promisify(execFile)

export interface PreparedShellCommand {
  env?: NodeJS.ProcessEnv
  pathPrepend?: string
  command: string
  workingDir: string
  timeoutSec: number
  keepProcesses: boolean
  pty?: TerminalSize
}

export interface ProcessInvocation {
  executable: string
  args: string[]
  windowsHide: boolean
  env?: NodeJS.ProcessEnv
}

export interface CommandShellInfo {
  executable: string
  name: string
  version?: string
  family: 'powershell' | 'posix'
}

type ShellVersionProbe = (executable: string, args: string[]) => Promise<string | undefined>

interface CommandShellResolutionOptions {
  platform?: NodeJS.Platform
  environment?: NodeJS.ProcessEnv
  probeVersion?: ShellVersionProbe
}

export interface ShellRunResult {
  ok: boolean
  command: string
  workingDir: string
  timeoutSec: number
  exitCode?: number | null
  signal?: string | null
  timedOut?: boolean
  aborted?: boolean
  stdout: string
  stderr: string
  truncated?: {
    stdout: boolean
    stderr: boolean
  }
  error?: string
}

export interface PreparedProcess {
  command: string
  workingDir: string
  timeoutSec: number
  maxStdoutChars?: number
  keepProcesses?: boolean
  pty?: TerminalSize
  invocation: ProcessInvocation
  env?: NodeJS.ProcessEnv
  effectSource?: Record<string, unknown>
  logScope: string
  /** Application preflights can omit routine results; containment errors still log. */
  logResult?: boolean
  logStart?: Record<string, unknown>
  successMessage: string
  failureMessage: string
  abortBeforeStartError: string
  abortError: string
  timeoutError: string
}

export interface ShellRunCallbacks {
  onTerminal?(terminal: ShellTerminalControl): void
  onDispatched?(): void
  onOutcomeUncertain?(reason: string): void
  onOutput?(stream: 'stdout' | 'stderr', text: string): void
  onResult?(result: ShellRunResult): void
}

type ShellSupervisorMessage =
  | { type: 'ready'; pid: number }
  | { type: 'dispatching' }
  | { type: 'started'; pid: number }
  | { type: 'termination_started'; reason: 'timeout' }
  | { type: 'force_required'; reason: 'cancel' | 'timeout' }
  | { type: 'release_ready' }
  | { type: 'output'; stream: 'stdout' | 'stderr'; text: string }
  | {
      type: 'result'
      exitCode?: number | null
      signal?: string | null
      timedOut: boolean
      aborted: boolean
      beforeStart: boolean
      error?: string
    }

type ShellSupervisorResultMessage = Extract<ShellSupervisorMessage, { type: 'result' }>

function isShellSupervisorResult(message: ShellSupervisorResultMessage): boolean {
  return typeof message.timedOut === 'boolean'
    && typeof message.aborted === 'boolean'
    && typeof message.beforeStart === 'boolean'
    && (
      message.exitCode === undefined
      || message.exitCode === null
      || Number.isSafeInteger(message.exitCode)
    )
    && (
      message.signal === undefined
      || message.signal === null
      || typeof message.signal === 'string'
    )
    && (message.error === undefined || typeof message.error === 'string')
}

const supervisorStartupTimeoutMs = 5_000

/** The standalone supervisor runs through process.execPath with ELECTRON_RUN_AS_NODE. */
export const shellSupervisorProgram = String.raw`
'use strict'
const { spawn } = require('node:child_process')
const net = require('node:net')
const forceKillDelayMs = ${forceKillDelayMs}
const coordinationTimeoutMs = ${supervisorStartupTimeoutMs}
let child
let childError
let startRequest
let startAccepted = false
let dispatchAccepted = false
let spawned = false
let settled = false
let timedOut = false
let aborted = false
let parentDisconnected = false
let closing = false
let terminationRequested = false
let terminationReason
let timeoutAwaitingAck = false
let timeoutTimer
let forceKillTimer
let terminationAckTimer
let outputBackpressure = 0
let releaseAccepted = false
let pipeSocket
const pipePath = process.env.ANAS_SHELL_SUPERVISOR_PIPE
const pipeToken = process.env.ANAS_SHELL_SUPERVISOR_TOKEN
const terminalMode = process.env.ANAS_SHELL_SUPERVISOR_PTY === '1'
const ptySession = terminalMode && process.platform !== 'win32'
  ? (${createPosixPtySession.toString()})(require(process.env.ANAS_PTY_NATIVE_MODULE), require('node:fs')) : undefined
const ptySessionLeader = ptySession && ptySession.inspect(process.pid)
if (ptySession && (!ptySessionLeader || ptySessionLeader.session !== process.pid)) throw new Error('PTY session identity is unavailable before dispatch.')
if (terminalMode) {
  // Initialize Node's lazy standard streams while the PTY master is alive.
  // A later diagnostic/shutdown path must not reopen a hung-up terminal.
  process.stdin.on('error', cancelForParentDisconnect)
  process.stdout.on('error', cancelForParentDisconnect)
  process.stderr.on('error', cancelForParentDisconnect)
}
// Ctrl+C belongs to the foreground command, not its containment guardian.
if (terminalMode) process.on('SIGINT', () => {})
if (terminalMode && process.platform !== 'win32') {
  // Closing the last PTY master also sends SIGHUP. Stay alive long enough to
  // reclaim descendants that ignore it when the application crashes.
  process.on('SIGHUP', cancelForParentDisconnect)
  process.on('SIGQUIT', () => {})
  process.on('SIGTSTP', () => {})
}

// The outer process creates a dedicated POSIX process group for this
// supervisor. Keep the supervisor alive during graceful group termination so
// it can report the child's definitive close event.
if (process.platform !== 'win32') process.on('SIGTERM', () => {})

function transportConnected() {
  return pipeSocket ? !pipeSocket.destroyed : process.connected
}

function disconnectTransport() {
  if (pipeSocket) {
    try {
      pipeSocket.end()
    } catch {}
    return
  }
  if (process.connected) {
    try {
      process.disconnect()
    } catch {}
  }
}

function send(message, callback) {
  if (pipeSocket) {
    if (pipeSocket.destroyed) {
      if (callback) callback()
      return false
    }
    try {
      return pipeSocket.write(JSON.stringify({ ...message, token: pipeToken }) + '\n', callback)
    } catch {
      if (callback) callback()
      return false
    }
  }
  if (!process.connected || typeof process.send !== 'function') {
    if (callback) callback()
    return false
  }
  try {
    return process.send(message, () => {
      if (callback) callback()
    })
  } catch {
    if (callback) callback()
    return false
  }
}

function terminateTree(force) {
  if (process.platform !== 'win32') {
    if (ptySession && ptySessionLeader) ptySession.terminate(ptySessionLeader, force)
    try {
      process.kill(-process.pid, force ? 'SIGKILL' : 'SIGTERM')
    } catch {
      if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return
      try {
        child.kill(force ? 'SIGKILL' : 'SIGTERM')
      } catch {}
    }
    return
  }
  if (child && child.pid && child.exitCode === null && child.signalCode === null) {
    const args = ['/pid', String(child.pid), '/t']
    if (force) args.push('/f')
    try {
      spawn('taskkill.exe', args, { windowsHide: true, stdio: 'ignore' }).unref()
    } catch {}
  }
}

function scheduleForcedTermination() {
  if (forceKillTimer) return
  forceKillTimer = setTimeout(() => {
    forceKillTimer = undefined
    if (parentDisconnected || !transportConnected()) {
      terminateTree(true)
      if (process.platform === 'win32') closeSupervisor()
      return
    }
    send({ type: 'force_required', reason: terminationReason })
    // Do not rely on the IPC write callback to arm the fallback. A blocked
    // parent can leave that callback pending indefinitely precisely when the
    // supervisor must remain able to contain the command on its own.
    forceKillTimer = setTimeout(() => {
      forceKillTimer = undefined
      terminateTree(true)
      if (process.platform === 'win32') closeSupervisor()
    }, forceKillDelayMs)
  }, forceKillDelayMs)
}

function requestTermination(reason) {
  if (settled) return
  if (!terminationReason || reason === 'cancel') terminationReason = reason
  if (!terminationRequested) {
    terminationRequested = true
    terminateTree(false)
  }
  scheduleForcedTermination()
}

function beginTimeoutTermination() {
  timedOut = true
  if (parentDisconnected || !transportConnected()) {
    requestTermination('timeout')
    return
  }
  timeoutAwaitingAck = true
  send({ type: 'termination_started', reason: 'timeout' })
  terminationAckTimer = setTimeout(() => {
    if (!timeoutAwaitingAck || settled) return
    timeoutAwaitingAck = false
    // A delayed acknowledgement does not prove that IPC disconnected. Keep
    // the result channel available while independently terminating the tree.
    requestTermination('timeout')
  }, coordinationTimeoutMs)
}

function closeSupervisor() {
  closing = true
  process.exitCode = 0
  disconnectTransport()
}

function finish(details) {
  if (settled) return
  settled = true
  if (timeoutTimer) clearTimeout(timeoutTimer)
  if (forceKillTimer) clearTimeout(forceKillTimer)
  if (terminationAckTimer) clearTimeout(terminationAckTimer)
  const message = {
    type: 'result',
    timedOut,
    aborted,
    beforeStart: !spawned,
    ...details
  }
  if (!spawned) {
    if (!parentDisconnected) send(message, closeSupervisor)
    else closeSupervisor()
    return
  }
  if (parentDisconnected || !transportConnected()) {
    terminateTree(true)
    if (process.platform === 'win32') closeSupervisor()
    return
  }
  // Arm the self-containment deadline before writing to IPC. process.send's
  // callback may never run when the parent event loop or IPC pipe is stuck.
  forceKillTimer = setTimeout(() => {
    forceKillTimer = undefined
    terminateTree(true)
    if (process.platform === 'win32') closeSupervisor()
  }, coordinationTimeoutMs)
  send(message, () => {
    if (parentDisconnected || !transportConnected()) {
      terminateTree(true)
      if (process.platform === 'win32') closeSupervisor()
      return
    }
  })
}

function forward(stream, value) {
  const text = String(value)
  if (!text) return
  let backpressured = false
  const accepted = send({ type: 'output', stream, text }, () => {
    if (!backpressured) return
    outputBackpressure -= 1
    if (outputBackpressure === 0 && child) {
      child.stdout.resume()
      child.stderr.resume()
    }
  })
  if (!accepted) {
    backpressured = true
    outputBackpressure += 1
    if (child) {
      child.stdout.pause()
      child.stderr.pause()
    }
  }
}

function cancelForParentDisconnect() {
  if (closing) return
  parentDisconnected = true
  if (releaseAccepted) {
    closeSupervisor()
    return
  }
  aborted = true
  timeoutAwaitingAck = false
  if (terminationAckTimer) clearTimeout(terminationAckTimer)
  if (settled) {
    terminateTree(true)
    return
  }
  if (!child) {
    settled = true
    closeSupervisor()
    return
  }
  requestTermination('cancel')
}

function startCommand(message) {
  if (settled || child) return
  dispatchAccepted = true
  try {
    child = spawn(message.executable, message.args, {
      cwd: message.cwd,
      windowsHide: message.windowsHide === true,
      shell: false,
      detached: false,
      env: message.environment,
      stdio: terminalMode ? ['inherit', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe']
    })
  } catch (error) {
    finish({ error: error instanceof Error ? error.message : String(error) })
    return
  }
  if (child.pid) {
    spawned = true
    send({ type: 'started', pid: child.pid })
  }
  if (!terminalMode) {
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => forward('stdout', chunk))
    child.stderr.on('data', (chunk) => forward('stderr', chunk))
  }
  child.once('spawn', () => {
    if (!spawned) {
      spawned = true
      send({ type: 'started', pid: child.pid })
    }
    const timeoutMs = Math.max(0, Math.floor(Number(message.timeoutMs) || 0))
    if (timeoutMs > 0) timeoutTimer = setTimeout(beginTimeoutTermination, timeoutMs)
  })
  child.once('error', (error) => {
    childError = error instanceof Error ? error.message : String(error)
  })
  child.once('close', (exitCode, signal) => {
    finish({ exitCode, signal, ...(childError ? { error: childError } : {}) })
  })
}

function handleParentMessage(message) {
  if (!message || typeof message !== 'object') return
  if (message.type === 'prepare_release') {
    if (!settled || !spawned || releaseAccepted) return
    releaseAccepted = true
    if (forceKillTimer) {
      clearTimeout(forceKillTimer)
      forceKillTimer = undefined
    }
    send({ type: 'release_ready' })
    forceKillTimer = setTimeout(closeSupervisor, coordinationTimeoutMs)
    return
  }
  if (message.type === 'release_complete') {
    if (!releaseAccepted) return
    closeSupervisor()
    return
  }
  if (message.type === 'cancel') {
    aborted = true
    timeoutAwaitingAck = false
    if (terminationAckTimer) clearTimeout(terminationAckTimer)
    if (child) requestTermination('cancel')
    else finish({})
    return
  }
  if (message.type === 'termination_ack') {
    if (message.reason !== 'timeout' || !timeoutAwaitingAck || settled) return
    timeoutAwaitingAck = false
    if (terminationAckTimer) clearTimeout(terminationAckTimer)
    requestTermination('timeout')
    return
  }
  if (message.type === 'dispatch') {
    if (!startAccepted || dispatchAccepted || settled || !startRequest) return
    startCommand(startRequest)
    return
  }
  if (message.type !== 'start' || startAccepted || settled) return
  startAccepted = true
  if (
    typeof message.executable !== 'string'
    || !Array.isArray(message.args)
    || message.args.some((value) => typeof value !== 'string')
    || typeof message.cwd !== 'string'
    || !message.environment
    || typeof message.environment !== 'object'
  ) {
    finish({ error: 'Invalid shell supervisor start request.' })
    return
  }
  startRequest = message
  send({ type: 'dispatching' })
}

if (pipePath && pipeToken) {
  pipeSocket = net.createConnection(pipePath)
  let input = ''
  pipeSocket.setEncoding('utf8')
  pipeSocket.on('data', (chunk) => {
    input += chunk
    while (true) {
      const boundary = input.indexOf('\n')
      if (boundary < 0) break
      const line = input.slice(0, boundary)
      input = input.slice(boundary + 1)
      if (!line) continue
      try {
        handleParentMessage(JSON.parse(line))
      } catch {}
    }
  })
  pipeSocket.once('connect', () => send({ type: 'ready', pid: process.pid }))
  pipeSocket.once('close', cancelForParentDisconnect)
  pipeSocket.once('error', cancelForParentDisconnect)
} else {
  process.once('disconnect', cancelForParentDisconnect)
  process.on('message', handleParentMessage)
  send({ type: 'ready', pid: process.pid })
}
`

function clampShellTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return defaultShellTimeoutSec
  return Math.max(0, Math.min(maxCommandTimeoutSeconds, Math.round(value as number)))
}

function appendLimited(current: string, chunk: string, limit: number): { text: string; truncated: boolean } {
  const remaining = Math.max(0, limit - current.length)
  return { text: current + chunk.slice(0, remaining), truncated: chunk.length > remaining }
}

export async function prepareShellCommand(
  input: { command: string; timeoutSec?: number; workingDir?: string; keepProcesses?: boolean; pty?: TerminalSize },
  defaultWorkingDir: string
): Promise<PreparedShellCommand | ShellRunResult> {
  const command = input.command
  const timeoutSec = clampShellTimeout(input.timeoutSec)
  let requestedWorkingDir: string
  try {
    requestedWorkingDir = resolveWorkspacePath(input.workingDir?.trim() || defaultWorkingDir, defaultWorkingDir)
  } catch (error) {
    return {
      ok: false,
      command,
      workingDir: input.workingDir?.trim() || defaultWorkingDir,
      timeoutSec,
      stdout: '',
      stderr: '',
      error: error instanceof Error ? error.message : 'working_dir is invalid'
    }
  }

  try {
    const stats = await stat(requestedWorkingDir)
    if (!stats.isDirectory()) {
      return {
        ok: false,
        command,
        workingDir: requestedWorkingDir,
        timeoutSec,
        stdout: '',
        stderr: '',
        error: 'working_dir is not a directory'
      }
    }
  } catch (error) {
    return {
      ok: false,
      command,
      workingDir: requestedWorkingDir,
      timeoutSec,
      stdout: '',
      stderr: '',
      error: error instanceof Error ? error.message : 'working_dir is not accessible'
    }
  }

  return {
    command,
    workingDir: requestedWorkingDir,
    timeoutSec,
    keepProcesses: input.keepProcesses === true,
    ...(input.pty ? { pty: terminalSizeSchema.parse(input.pty) } : {})
  }
}

export function resultText(result: ShellRunResult): string {
  const truncated = Boolean(result.truncated?.stdout || result.truncated?.stderr)
  const needsStatusEnvelope = !result.ok
    || result.stdout.length === 0
    || result.stderr.length > 0
    || truncated
    || Boolean(result.timedOut)
    || Boolean(result.aborted)
    || Boolean(result.error)
  return needsStatusEnvelope ? JSON.stringify(result) : result.stdout
}

async function probeShellVersion(executable: string, args: string[]): Promise<string | undefined> {
  try {
    const result = await execFileAsync(executable, args, {
      encoding: 'utf8',
      timeout: shellVersionProbeTimeoutMs,
      windowsHide: true
    })
    const version = result.stdout.trim().split(/\r?\n/, 1)[0]
    return version || undefined
  } catch {
    return undefined
  }
}

const powershellVersionArgs = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-Command',
  '$PSVersionTable.PSVersion.ToString()'
]

export async function resolveCommandShell(
  options: CommandShellResolutionOptions = {}
): Promise<CommandShellInfo> {
  const platform = options.platform ?? process.platform
  const environment = options.environment ?? process.env
  const probeVersion = options.probeVersion ?? probeShellVersion
  if (platform === 'win32') {
    const pwshVersion = await probeVersion('pwsh.exe', powershellVersionArgs)
    if (pwshVersion) {
      return {
        executable: 'pwsh.exe',
        name: 'PowerShell',
        version: pwshVersion,
        family: 'powershell'
      }
    }
    const windowsPowerShellVersion = await probeVersion('powershell.exe', powershellVersionArgs)
    return {
      executable: 'powershell.exe',
      name: 'Windows PowerShell',
      ...(windowsPowerShellVersion ? { version: windowsPowerShellVersion } : {}),
      family: 'powershell'
    }
  }
  const executable = environment.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  return {
    executable,
    name: basename(executable),
    family: 'posix'
  }
}

let commandShellPromise: Promise<CommandShellInfo> | undefined

export function getCommandShell(): Promise<CommandShellInfo> {
  commandShellPromise ??= resolveCommandShell()
  return commandShellPromise
}

export function describeCommandShell(shell: CommandShellInfo): string {
  return `${shell.name}${shell.version ? ` ${shell.version}` : ''} (${shell.executable})`
}

export function describeCommandShellTool(shell: CommandShellInfo): string {
  const toolName = commandShellToolName(shell.executable)
  const version = shell.version ? ` ${shell.version}` : ''
  switch (toolName) {
    case 'pwsh':
      return `Run a PowerShell${version} command with pwsh when no dedicated tool fits. Returns stdout on clean success, otherwise JSON status.`
    case 'powershell':
      return `Run a Windows PowerShell${version} command with powershell.exe when no dedicated tool fits. Returns stdout on clean success, otherwise JSON status.`
    case 'bash':
      return `Run a Bash command with ${shell.executable} when no dedicated tool fits. Returns stdout on clean success, otherwise JSON status.`
    case 'zsh':
      return `Run a Z shell command with ${shell.executable} when no dedicated tool fits. Returns stdout on clean success, otherwise JSON status.`
    default:
      return `Run a command with ${describeCommandShell(shell)} when no dedicated tool fits. Returns stdout on clean success, otherwise JSON status.`
  }
}

export function describeCommandShellArgument(shell: CommandShellInfo): string {
  const toolName = commandShellToolName(shell.executable)
  switch (toolName) {
    case 'pwsh':
      return 'Complete command in PowerShell 7+ syntax, executed by pwsh.'
    case 'powershell':
      return 'Complete command in Windows PowerShell syntax, executed by powershell.exe.'
    case 'bash':
      return 'Complete command in Bash syntax, executed with bash -lc.'
    case 'zsh':
      return 'Complete command in Z shell syntax, executed with zsh -lc.'
    default:
      return `Complete command in ${shell.name} syntax, executed by ${shell.executable}.`
  }
}

const powershellUtf8Output = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)'

// Use PowerShell's parser for declaration placement instead of rewriting its
// grammar in JavaScript. Ordinary command statements do not need this probe.
const powershellEncodingPlacementScript = String.raw`
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($env:ANAS_POWERSHELL_SOURCE, [ref]$tokens, [ref]$parseErrors)
$offset = 0
$beginBlock = $false
foreach ($statement in $ast.UsingStatements) { $offset = [Math]::Max($offset, $statement.Extent.EndOffset) }
if ($ast.ParamBlock) { $offset = [Math]::Max($offset, $ast.ParamBlock.Extent.EndOffset) }
$initialBlock = if ($ast.DynamicParamBlock) { $ast.DynamicParamBlock } else { $ast.BeginBlock }
if ($initialBlock) {
  $openingBrace = $tokens | Where-Object { $_.Kind -eq 'LCurly' -and $_.Extent.StartOffset -ge $initialBlock.Extent.StartOffset } | Select-Object -First 1
  $offset = $openingBrace.Extent.EndOffset
} elseif ($ast.ProcessBlock -or $ast.CleanBlock -or ($ast.EndBlock -and -not $ast.EndBlock.Unnamed)) {
  $beginBlock = $true
}
[ordered]@{ offset = $offset; beginBlock = $beginBlock } | ConvertTo-Json -Compress
`

async function powershellCommandWithUtf8Output(
  command: string,
  executable: string,
  signal?: AbortSignal
): Promise<string> {
  let offset = 0
  let beginBlock = false
  if (!signal?.aborted && /\b(?:using|param|dynamicparam|begin|process|end|clean)\b/i.test(command)) {
    try {
      const { stdout } = await execFileAsync(executable, [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', powershellEncodingPlacementScript
      ], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: shellVersionProbeTimeoutMs,
        signal,
        env: { ...process.env, ANAS_POWERSHELL_SOURCE: command }
      })
      const placement = JSON.parse(stdout) as { offset: number; beginBlock: boolean }
      if (
        !Number.isSafeInteger(placement.offset) || placement.offset < 0 || placement.offset > command.length
        || typeof placement.beginBlock !== 'boolean'
      ) throw new Error('PowerShell returned an invalid encoding initialization position.')
      offset = placement.offset
      beginBlock = placement.beginBlock
    } catch (error) {
      // runPreparedProcess owns the normal before-start cancellation result.
      if (!signal?.aborted) throw error
    }
  }
  const initialization = beginBlock ? `begin { ${powershellUtf8Output} }` : powershellUtf8Output
  return `${command.slice(0, offset)}${offset ? '\n' : ''}${initialization}\n${command.slice(offset)}`
}

export async function resolveShellInvocation(
  command: string,
  shell: CommandShellInfo,
  signal?: AbortSignal
): Promise<ProcessInvocation> {
  if (shell.family === 'powershell') {
    return {
      executable: shell.executable,
      args: [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        // File decoding is independent of the stdout/stderr transport. Match
        // the supervisor's UTF-8 decoder without adding a script-block scope
        // that would hide a failed command's exit status.
        await powershellCommandWithUtf8Output(command, shell.executable, signal)
      ],
      windowsHide: true
    }
  }
  return {
    executable: shell.executable,
    args: ['-lc', command],
    windowsHide: false
  }
}

function hasErrnoCode(reason: unknown, code: string): boolean {
  return reason instanceof Error && 'code' in reason && reason.code === code
}

function terminatePosixProcessGroup(pid: number, force: boolean): boolean {
  const terminationSignal = force ? 'SIGKILL' : 'SIGTERM'
  try {
    process.kill(-pid, terminationSignal)
    return true
  } catch (groupError) {
    if (!hasErrnoCode(groupError, 'ESRCH')) return false
    try {
      process.kill(pid, 0)
    } catch (processError) {
      // No group and no leader means the containment boundary is already empty.
      return hasErrnoCode(processError, 'ESRCH')
    }
    // A detached supervisor must remain its process-group leader. A live PID
    // here may already be a reused identity, so never signal it by number.
    return false
  }
}

interface ShellSupervisorProcess {
  readonly connected: boolean
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  readonly pid?: number
  disconnect(): void
  kill(signal?: NodeJS.Signals | number): boolean
  send(message: unknown, callback?: (error: Error | null) => void): boolean
  on(event: 'message', listener: (message: unknown) => void): this
  once(event: 'error', listener: (error: Error) => void): this
  once(
    event: 'exit',
    listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void
  ): this
}

function terminateProcessTree(child: ShellSupervisorProcess, force: boolean): boolean {
  if (child instanceof PtyShellSupervisor) return child.kill(force ? 'SIGKILL' : 'SIGTERM')
  if (!child.pid) return false
  if (process.platform !== 'win32') {
    return terminatePosixProcessGroup(child.pid, force)
  }
  if (child.exitCode !== null || child.signalCode !== null) return false
  try {
    // Before a Windows Job Object is attached, only the supervisor exists.
    // Kill through Node's owned child handle instead of launching an
    // asynchronous PID-based taskkill and treating its launch as containment.
    return child.kill(force ? 'SIGKILL' : 'SIGTERM')
  } catch {
    return false
  }
}

function effectiveProcessEnvironment(prepared: PreparedProcess): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries({
    ...process.env,
    ...prepared.invocation.env,
    ...prepared.env
  }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

function processEnvironmentFingerprint(environment: NodeJS.ProcessEnv): string {
  return createHash('sha256')
    .update(JSON.stringify(Object.entries(environment).sort(([left], [right]) => (
      left < right ? -1 : left > right ? 1 : 0
    ))))
    .digest('hex')
}

export function runPreparedProcess(
  prepared: PreparedProcess,
  signal?: AbortSignal,
  callbacks: ShellRunCallbacks = {}
): Promise<string> {
  const maxStdoutChars = prepared.maxStdoutChars ?? maxShellOutputChars
  if (!Number.isSafeInteger(maxStdoutChars) || maxStdoutChars <= 0) throw new Error('stdout limit must be a positive safe integer.')
  if (prepared.pty && prepared.keepProcesses) throw new Error('PTY sessions cannot keep processes after the command ends. Use non-interactive execution for detached services.')
  if (prepared.pty) terminalSizeSchema.parse(prepared.pty)
  if (signal?.aborted) {
    return Promise.resolve(resultText({
      ok: false,
      command: prepared.command,
      workingDir: prepared.workingDir,
      timeoutSec: prepared.timeoutSec,
      aborted: true,
      stdout: '',
      stderr: '',
      error: prepared.abortBeforeStartError
    }))
  }

  const environment = effectiveProcessEnvironment(prepared)

  armCurrentAgentToolEffect({
    kind: 'process_spawn',
    target: {
      command: prepared.command,
      workingDirectory: prepared.workingDir,
      executable: prepared.invocation.executable,
      arguments: prepared.invocation.args,
      environmentFingerprint: processEnvironmentFingerprint(environment),
      keepProcesses: prepared.keepProcesses === true,
      ...(prepared.pty ? { pty: prepared.pty } : {}),
      ...(prepared.effectSource ? { source: prepared.effectSource } : {})
    }
  })

  if (signal?.aborted) {
    return Promise.resolve(resultText({
      ok: false,
      command: prepared.command,
      workingDir: prepared.workingDir,
      timeoutSec: prepared.timeoutSec,
      aborted: true,
      stdout: '',
      stderr: '',
      error: prepared.abortBeforeStartError
    }))
  }

  return new Promise((resolveCommand) => {
    let stdout = ''
    let stderr = ''
    let stdoutTruncated = false
    let stderrTruncated = false
    let settled = false
    let aborted = false
    let ready = false
    let dispatched = false
    let started = false
    let resultReceived = false
    let releasePendingResult: ShellRunResult | undefined
    let terminationRequested = false
    let expectedTermination: 'cancel' | 'timeout' | undefined
    let forcedContainmentConfirmed = false
    let forceKillTimer: NodeJS.Timeout | undefined
    let outcomeUncertainReason: string | undefined
    const handshakeTimer: { current?: NodeJS.Timeout } = {}
    let supervisor: ShellSupervisorProcess
    let windowsJob: WindowsProcessJob | undefined
    let windowsJobAttached = false

    const finish = (result: ShellRunResult): void => {
      if (settled) return
      settled = true
      if (handshakeTimer.current) clearTimeout(handshakeTimer.current)
      signal?.removeEventListener('abort', abortCommand)
      if (prepared.logResult !== false) runtimeLog(result.ok ? 'info' : 'warn', prepared.logScope, result.ok ? prepared.successMessage : prepared.failureMessage, {
        ...prepared.logStart,
        command: result.command,
        workingDir: result.workingDir,
        timeoutSec: result.timeoutSec,
        keepProcesses: prepared.keepProcesses === true,
        executable: prepared.invocation.executable,
        args: prepared.invocation.args,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        aborted: result.aborted,
        stdoutLength: result.stdout.length,
        stderrLength: result.stderr.length,
        error: result.error
      })
      const completed = {
        ...result,
        truncated: {
          stdout: stdoutTruncated,
          stderr: stderrTruncated
        }
      }
      callbacks.onResult?.(completed)
      resolveCommand(resultText(completed))
    }

    const disposeWindowsJob = (terminateMembers: boolean): boolean => {
      const job = windowsJob
      if (!job) return false
      let terminated = false
      let closed = false
      if (terminateMembers) {
        try {
          job.terminate()
          terminated = true
        } catch (error) {
          runtimeLog('error', prepared.logScope, 'Could not terminate the Windows command Job Object.', {
            ...prepared.logStart,
            command: prepared.command,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
      try {
        job.close()
        closed = true
        windowsJob = undefined
        windowsJobAttached = false
      } catch (error) {
        runtimeLog('error', prepared.logScope, 'Could not close the Windows command Job Object.', {
          ...prepared.logStart,
          command: prepared.command,
          error: error instanceof Error ? error.message : String(error)
        })
      }
      return terminated || closed
    }

    const releaseWindowsJob = (): boolean => {
      const job = windowsJob
      if (!job) return process.platform !== 'win32'
      try {
        job.release()
        windowsJob = undefined
        windowsJobAttached = false
        return true
      } catch (error) {
        runtimeLog('error', prepared.logScope, 'Could not release the Windows command Job Object.', {
          ...prepared.logStart,
          command: prepared.command,
          error: error instanceof Error ? error.message : String(error)
        })
        return false
      }
    }

    const forceSupervisorTermination = (): boolean => {
      if (forcedContainmentConfirmed) return true
      const contained = process.platform === 'win32' && windowsJobAttached
        ? disposeWindowsJob(true)
        : terminateProcessTree(supervisor, true)
      if (process.platform === 'win32' && windowsJobAttached && !contained) {
        // ChildProcess.kill uses the process handle owned by Node. It cannot
        // prove descendant cleanup, but it prevents the supervisor itself
        // from lingering while the Job Object close is retried on exit.
        supervisor.kill('SIGKILL')
      }
      forcedContainmentConfirmed ||= contained
      return forcedContainmentConfirmed
    }

    const clearForceKillTimer = (): void => {
      if (!forceKillTimer) return
      clearTimeout(forceKillTimer)
      forceKillTimer = undefined
    }

    const markOutcomeUncertain = (reason: string): void => {
      if (outcomeUncertainReason) return
      outcomeUncertainReason = reason
      try {
        callbacks.onOutcomeUncertain?.(reason)
      } catch (error) {
        runtimeLog('error', prepared.logScope, 'Could not persist an uncertain shell outcome.', {
          ...prepared.logStart,
          command: prepared.command,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }

    const requestSupervisorTermination = (
      expectedReason?: 'cancel' | 'timeout'
    ): void => {
      terminationRequested = true
      if (expectedReason === 'cancel' || !expectedTermination) {
        expectedTermination = expectedReason
      }
      if (settled) return
      if (supervisor.connected) {
        try {
          supervisor.send({ type: 'cancel' })
        } catch {
          if (process.platform === 'win32') forceSupervisorTermination()
          else terminateProcessTree(supervisor, false)
        }
      } else {
        if (process.platform === 'win32') forceSupervisorTermination()
        else terminateProcessTree(supervisor, false)
        try {
          supervisor.disconnect()
        } catch {
          // The supervisor transport is already disconnected.
        }
      }
      scheduleForcedTermination()
    }

    const scheduleForcedTermination = (): void => {
      if (forceKillTimer) return
      forceKillTimer = setTimeout(() => {
        forceKillTimer = undefined
        const contained = forceSupervisorTermination()
        if (expectedTermination && !contained) {
          expectedTermination = undefined
          markOutcomeUncertain(
            'The command containment boundary could not confirm forced termination; the final outcome is unknown.'
          )
        }
      }, forceKillDelayMs)
      forceKillTimer.unref()
    }

    const abortCommand = (): void => {
      aborted = true
      expectedTermination = 'cancel'
      if (ready) requestSupervisorTermination('cancel')
    }

    const armHandshakeDeadline = (error: string): void => {
      if (handshakeTimer.current) clearTimeout(handshakeTimer.current)
      handshakeTimer.current = setTimeout(() => {
        if (settled) return
        aborted = true
        requestSupervisorTermination()
        if (dispatched) {
          markOutcomeUncertain(
            'Command supervisor stopped responding after dispatch was authorized; the final outcome is unknown.'
          )
        }
        finish({
          ok: false,
          command: prepared.command,
          workingDir: prepared.workingDir,
          timeoutSec: prepared.timeoutSec,
          aborted: true,
          stdout,
          stderr,
          error
        })
      }, supervisorStartupTimeoutMs)
      handshakeTimer.current.unref()
    }

    if (process.platform === 'win32') {
      try {
        windowsJob = createWindowsKillOnCloseJob()
      } catch (reason) {
        finish({
          ok: false,
          command: prepared.command,
          workingDir: prepared.workingDir,
          timeoutSec: prepared.timeoutSec,
          stdout,
          stderr,
          error: `Could not establish the Windows command containment boundary: ${reason instanceof Error ? reason.message : String(reason)}`
        })
        return
      }
    }

    try {
      supervisor = prepared.pty ? process.platform === 'win32'
        ? new WindowsPtyShellSupervisor(prepared.pty) : new PtyShellSupervisor(shellSupervisorProgram, prepared.pty)
        : process.platform === 'win32' && prepared.keepProcesses === true
        ? new DetachedWindowsShellSupervisor(shellSupervisorProgram)
        : spawn(process.execPath, ['-e', shellSupervisorProgram], {
            windowsHide: true,
            shell: false,
            detached: process.platform !== 'win32',
            env: {
              ...process.env,
              ELECTRON_RUN_AS_NODE: '1'
            },
            stdio: ['ignore', 'ignore', 'ignore', 'ipc']
          }) as ShellSupervisorProcess
    } catch (reason) {
      disposeWindowsJob(false)
      finish({
        ok: false,
        command: prepared.command,
        workingDir: prepared.workingDir,
        timeoutSec: prepared.timeoutSec,
        stdout,
        stderr,
        error: reason instanceof Error ? reason.message : String(reason)
      })
      return
    }

    supervisor.on('message', (rawMessage: unknown) => {
      if (!rawMessage || typeof rawMessage !== 'object' || !('type' in rawMessage)) return
      const message = rawMessage as ShellSupervisorMessage
      if (message.type === 'ready') {
        if (ready || settled) return
        if (!Number.isSafeInteger(message.pid) || message.pid <= 0) {
          requestSupervisorTermination()
          finish({
            ok: false,
            command: prepared.command,
            workingDir: prepared.workingDir,
            timeoutSec: prepared.timeoutSec,
            stdout,
            stderr,
            error: 'Command supervisor returned an invalid process ID.'
          })
          return
        }
        if (process.platform === 'win32') {
          try {
            windowsJob!.addProcess(message.pid)
            windowsJobAttached = true
          } catch (reason) {
            const error = `Could not attach the command supervisor to its Windows containment boundary: ${reason instanceof Error ? reason.message : String(reason)}`
            try {
              supervisor.disconnect()
            } catch {
              // The process may have exited between the connected check and disconnect.
            }
            supervisor.kill('SIGKILL')
            disposeWindowsJob(false)
            finish({
              ok: false,
              command: prepared.command,
              workingDir: prepared.workingDir,
              timeoutSec: prepared.timeoutSec,
              stdout,
              stderr,
              error
            })
            return
          }
        }
        ready = true
        if (signal?.aborted || aborted) {
          aborted = true
          requestSupervisorTermination('cancel')
          return
        }
        try {
          armHandshakeDeadline('Command supervisor did not accept the start request.')
          supervisor.send({
            type: 'start',
            executable: prepared.invocation.executable,
            args: prepared.invocation.args,
            cwd: prepared.workingDir,
            windowsHide: prepared.invocation.windowsHide,
            environment,
            timeoutMs: prepared.timeoutSec * 1000
          }, (error) => {
            if (!error || settled) return
            requestSupervisorTermination()
            finish({
              ok: false,
              command: prepared.command,
              workingDir: prepared.workingDir,
              timeoutSec: prepared.timeoutSec,
              aborted,
              stdout,
              stderr,
              error: error.message
            })
          })
        } catch (reason) {
          requestSupervisorTermination()
          finish({
            ok: false,
            command: prepared.command,
            workingDir: prepared.workingDir,
            timeoutSec: prepared.timeoutSec,
            aborted,
            stdout,
            stderr,
            error: reason instanceof Error ? reason.message : String(reason)
          })
        }
        return
      }
      if (message.type === 'dispatching') {
        if (dispatched || settled) return
        if (signal?.aborted || aborted) {
          aborted = true
          requestSupervisorTermination()
          return
        }
        try {
          callbacks.onDispatched?.()
        } catch (reason) {
          requestSupervisorTermination()
          finish({
            ok: false,
            command: prepared.command,
            workingDir: prepared.workingDir,
            timeoutSec: prepared.timeoutSec,
            aborted,
            stdout,
            stderr,
            error: reason instanceof Error ? reason.message : String(reason)
          })
          return
        }
        dispatched = true
        try {
          armHandshakeDeadline('Command supervisor did not report that the command started.')
          supervisor.send({ type: 'dispatch' }, (error) => {
            if (!error || settled) return
            forceSupervisorTermination()
            clearForceKillTimer()
            markOutcomeUncertain(
              'Command dispatch acknowledgement failed; the final outcome is unknown.'
            )
            finish({
              ok: false,
              command: prepared.command,
              workingDir: prepared.workingDir,
              timeoutSec: prepared.timeoutSec,
              aborted,
              stdout,
              stderr,
              error: error.message
            })
          })
        } catch (reason) {
          forceSupervisorTermination()
          clearForceKillTimer()
          markOutcomeUncertain(
            'Command dispatch acknowledgement failed; the final outcome is unknown.'
          )
          finish({
            ok: false,
            command: prepared.command,
            workingDir: prepared.workingDir,
            timeoutSec: prepared.timeoutSec,
            aborted,
            stdout,
            stderr,
            error: reason instanceof Error ? reason.message : String(reason)
          })
        }
        return
      }
      if (message.type === 'termination_started') {
        if (message.reason !== 'timeout' || !dispatched || settled) return
        terminationRequested = true
        if (!aborted) expectedTermination = 'timeout'
        scheduleForcedTermination()
        try {
          supervisor.send({ type: 'termination_ack', reason: 'timeout' }, (error) => {
            if (!error || settled) return
            const contained = forceSupervisorTermination()
            clearForceKillTimer()
            if (!contained) {
              expectedTermination = undefined
              markOutcomeUncertain(
                'The command timeout acknowledgement failed and forced termination could not be confirmed; the final outcome is unknown.'
              )
            }
          })
        } catch {
          const contained = forceSupervisorTermination()
          clearForceKillTimer()
          if (!contained) {
            expectedTermination = undefined
            markOutcomeUncertain(
              'The command timeout acknowledgement failed and forced termination could not be confirmed; the final outcome is unknown.'
            )
          }
        }
        return
      }
      if (message.type === 'force_required') {
        if (
          (message.reason !== 'cancel' && message.reason !== 'timeout')
          || !dispatched
          || settled
        ) return
        terminationRequested = true
        if (message.reason === 'cancel') aborted = true
        expectedTermination = aborted ? 'cancel' : message.reason
        const contained = forceSupervisorTermination()
        clearForceKillTimer()
        if (!contained) {
          expectedTermination = undefined
          markOutcomeUncertain(
            'The command containment boundary could not confirm forced termination; the final outcome is unknown.'
          )
        }
        return
      }
      if (message.type === 'release_ready') {
        if (!releasePendingResult || settled) return
        if (handshakeTimer.current) {
          clearTimeout(handshakeTimer.current)
          handshakeTimer.current = undefined
        }
        if (!releaseWindowsJob()) {
          const contained = forceSupervisorTermination()
          clearForceKillTimer()
          if (!contained) {
            markOutcomeUncertain(
              'The command ended, but its Windows containment boundary could neither be released nor terminated; the final outcome is unknown.'
            )
          }
          finish({
            ...releasePendingResult,
            ok: false,
            error: outcomeUncertainReason
              ?? 'The command completed, but its child processes could not be kept running.'
          })
          return
        }
        try {
          supervisor.send({ type: 'release_complete' })
        } catch {
          // The supervisor accepted release ownership already. Its disconnect
          // handler now exits without terminating the requested processes.
        }
        finish(releasePendingResult)
        return
      }
      if (message.type === 'started') {
        if (started || settled) return
        if (!Number.isSafeInteger(message.pid) || message.pid <= 0) return
        if (handshakeTimer.current) {
          clearTimeout(handshakeTimer.current)
          handshakeTimer.current = undefined
        }
        started = true
        if (supervisor instanceof PtyShellSupervisor || supervisor instanceof WindowsPtyShellSupervisor) {
          try { callbacks.onTerminal?.(supervisor) } catch (error) {
            requestSupervisorTermination()
            markOutcomeUncertain(`Terminal control could not be registered: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        return
      }
      if (message.type === 'output') {
        if (settled) return
        if (
          (message.stream !== 'stdout' && message.stream !== 'stderr')
          || typeof message.text !== 'string'
        ) return
        try {
          callbacks.onOutput?.(message.stream, message.text)
        } catch (reason) {
          requestSupervisorTermination()
          markOutcomeUncertain(
            'Command output could not be persisted; the final outcome is unknown.'
          )
          finish({
            ok: false,
            command: prepared.command,
            workingDir: prepared.workingDir,
            timeoutSec: prepared.timeoutSec,
            aborted,
            stdout,
            stderr,
            error: reason instanceof Error ? reason.message : String(reason)
          })
          return
        }
        if (message.stream === 'stdout') {
          const next = appendLimited(stdout, message.text, maxStdoutChars)
          stdout = next.text
          stdoutTruncated ||= next.truncated
        } else {
          const next = appendLimited(stderr, message.text, maxShellOutputChars)
          stderr = next.text
          stderrTruncated ||= next.truncated
        }
        return
      }
      if (message.type !== 'result' || settled) return
      if (!isShellSupervisorResult(message)) {
        requestSupervisorTermination()
        if (dispatched) {
          markOutcomeUncertain(
            'Command supervisor returned an invalid result; the final outcome is unknown.'
          )
        }
        finish({
          ok: false,
          command: prepared.command,
          workingDir: prepared.workingDir,
          timeoutSec: prepared.timeoutSec,
          aborted,
          stdout,
          stderr,
          error: 'Command supervisor returned an invalid result.'
        })
        return
      }
      const resultAborted = aborted || message.aborted
      const cleanSuccess = message.exitCode === 0
        && !message.timedOut
        && !resultAborted
        && !message.error
        && !outcomeUncertainReason
      const result: ShellRunResult = {
        ok: cleanSuccess,
        command: prepared.command,
        workingDir: prepared.workingDir,
        timeoutSec: prepared.timeoutSec,
        exitCode: message.exitCode,
        signal: message.signal,
        timedOut: message.timedOut,
        aborted: resultAborted,
        stdout,
        stderr,
        error: outcomeUncertainReason ?? (
          resultAborted
            ? message.beforeStart ? prepared.abortBeforeStartError : prepared.abortError
            : message.timedOut
              ? prepared.timeoutError
              : message.error
        )
      }
      resultReceived = true
      if (cleanSuccess && prepared.keepProcesses === true) {
        releasePendingResult = result
        try {
          armHandshakeDeadline('Command supervisor did not accept the request to keep child processes running.')
          supervisor.send({ type: 'prepare_release' }, (error) => {
            if (!error || settled) return
            requestSupervisorTermination()
            finish({
              ...result,
              ok: false,
              error: 'The command completed, but its child processes could not be kept running.'
            })
          })
        } catch {
          requestSupervisorTermination()
          finish({
            ...result,
            ok: false,
            error: 'The command completed, but its child processes could not be kept running.'
          })
        }
        return
      }
      const contained = forceSupervisorTermination()
      clearForceKillTimer()
      if (!contained) {
        markOutcomeUncertain(
          'The command ended, but cleanup of its containment boundary could not be confirmed; the final outcome is unknown.'
        )
      }
      finish({ ...result, ok: result.ok && !outcomeUncertainReason })
    })
    supervisor.once('error', (reason) => {
      if (settled) return
      forceSupervisorTermination()
      clearForceKillTimer()
      disposeWindowsJob(false)
      try {
        supervisor.disconnect()
      } catch {
        // The supervisor transport failed before it could be closed cleanly.
      }
      if (dispatched) {
        markOutcomeUncertain(
          'Command supervisor failed after dispatch was authorized; the final outcome is unknown.'
        )
      }
      finish({
        ok: false,
        command: prepared.command,
        workingDir: prepared.workingDir,
        timeoutSec: prepared.timeoutSec,
        aborted,
        stdout,
        stderr,
        error: reason.message
      })
    })
    supervisor.once('exit', (exitCode, supervisorSignal) => {
      clearForceKillTimer()
      const terminateRemainingCommand = (): boolean => {
        if (process.platform === 'win32') {
          return forcedContainmentConfirmed
            || (windowsJobAttached && disposeWindowsJob(true))
        }
        if (supervisor instanceof PtyShellSupervisor) return supervisor.kill('SIGKILL')
        if (supervisor.pid) {
          return terminatePosixProcessGroup(supervisor.pid, true)
        }
        return false
      }
      if (settled) {
        if (terminationRequested && !resultReceived) terminateRemainingCommand()
        disposeWindowsJob(false)
        return
      }
      let contained = true
      if (dispatched || terminationRequested) {
        contained = forcedContainmentConfirmed || terminateRemainingCommand()
      } else {
        disposeWindowsJob(false)
      }
      const jobReleased = process.platform === 'win32' && windowsJob
        ? disposeWindowsJob(false)
        : false
      contained ||= jobReleased
      if (expectedTermination && contained && !outcomeUncertainReason) {
        const timedOut = expectedTermination === 'timeout'
        const cancelled = expectedTermination === 'cancel'
        finish({
          ok: false,
          command: prepared.command,
          workingDir: prepared.workingDir,
          timeoutSec: prepared.timeoutSec,
          exitCode,
          signal: supervisorSignal,
          timedOut,
          aborted: cancelled,
          stdout,
          stderr,
          error: timedOut
            ? prepared.timeoutError
            : dispatched ? prepared.abortError : prepared.abortBeforeStartError
        })
        return
      }
      if (dispatched) {
        markOutcomeUncertain(
          'Command supervisor exited after dispatch was authorized; the final outcome is unknown.'
        )
      }
      finish({
        ok: false,
        command: prepared.command,
        workingDir: prepared.workingDir,
        timeoutSec: prepared.timeoutSec,
        exitCode,
        signal: supervisorSignal,
        aborted,
        stdout,
        stderr,
        error: outcomeUncertainReason ?? (
          aborted
            ? dispatched ? prepared.abortError : prepared.abortBeforeStartError
            : 'Command supervisor exited before reporting the command result.'
        )
      })
    })
    armHandshakeDeadline('Command supervisor did not become ready.')

    signal?.addEventListener('abort', abortCommand, { once: true })
    if (signal?.aborted) abortCommand()
  })
}

export async function runShellCommand(
  command: PreparedShellCommand,
  shell: CommandShellInfo,
  signal?: AbortSignal,
  callbacks?: ShellRunCallbacks
): Promise<string> {
  // Login shells may replace PATH; inject the bundled executable directory
  // after startup files, without changing the user's/global environment.
  const source = shell.family === 'posix' && command.pathPrepend
    ? `export PATH='${command.pathPrepend.replaceAll("'", "'\\''")}':"$PATH"\n${command.command}`
    : command.command
  const invocation = await resolveShellInvocation(source, shell, signal)
  if (command.pty && shell.family === 'powershell') invocation.args = invocation.args.filter((arg) => arg !== '-NonInteractive')
  return runPreparedProcess({
    command: command.command,
    workingDir: command.workingDir,
    timeoutSec: command.timeoutSec,
    keepProcesses: command.keepProcesses,
    pty: command.pty,
    env: command.env,
    invocation,
    logScope: 'shell',
    successMessage: 'Shell command finished.',
    failureMessage: 'Shell command failed.',
    abortBeforeStartError: 'Command was cancelled before it started.',
    abortError: 'Command was cancelled.',
    timeoutError: `Command timed out after ${command.timeoutSec} seconds.`
  }, signal, callbacks)
}
