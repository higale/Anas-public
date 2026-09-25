import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createServer, type Server, type Socket } from 'node:net'

function powershellSingleQuoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export function windowsDetachedProcessCreateScript(): string {
  return [
    `$startup = ([wmiclass]'Win32_ProcessStartup').CreateInstance()`,
    `$startup.ShowWindow = 0`,
    `$result = ([wmiclass]'Win32_Process').Create($env:ANAS_DETACHED_SUPERVISOR_COMMAND, $null, $startup)`,
    `if ($result.ReturnValue -ne 0) { throw "Win32_Process.Create failed with code $($result.ReturnValue)." }`,
    `[Console]::Out.Write($result.ProcessId)`
  ].join('; ')
}

export class DetachedWindowsShellSupervisor extends EventEmitter {
  private readonly token = randomUUID()
  private readonly pipePath = `\\\\.\\pipe\\anas-shell-supervisor-${randomUUID()}`
  private readonly server: Server
  private socket?: Socket
  private launcherPid?: number
  private exited = false
  private failureEmitted = false
  private supervisorPid?: number
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null

  constructor(program: string) {
    super()
    this.server = createServer((socket) => this.accept(socket))
    this.server.once('error', (error) => this.fail(error))
    this.server.listen(this.pipePath, () => this.launch(program))
  }

  get connected(): boolean {
    return Boolean(this.socket && !this.socket.destroyed)
  }

  get pid(): number | undefined {
    return this.supervisorPid ?? this.launcherPid
  }

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    const socket = this.socket
    if (!socket || socket.destroyed) {
      callback?.(new Error('The detached shell supervisor is not connected.'))
      return false
    }
    try {
      return socket.write(`${JSON.stringify(message)}\n`, () => callback?.(null))
    } catch (reason) {
      callback?.(reason instanceof Error ? reason : new Error(String(reason)))
      return false
    }
  }

  disconnect(): void {
    this.socket?.end()
    try {
      this.server.close()
    } catch {
      // The listener may already be closed after an earlier transport failure.
    }
  }

  kill(): boolean {
    const pid = this.supervisorPid ?? this.launcherPid
    if (!pid) return false
    try {
      spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
        windowsHide: true,
        stdio: 'ignore'
      }).unref()
      return true
    } catch {
      return false
    }
  }

  override on(event: 'message', listener: (message: unknown) => void): this {
    return super.on(event, listener)
  }

  override once(event: 'error', listener: (error: Error) => void): this
  override once(
    event: 'exit',
    listener: (exitCode: number | null, signal: NodeJS.Signals | null) => void
  ): this
  override once(event: string, listener: (...args: any[]) => void): this {
    return super.once(event, listener)
  }

  private accept(socket: Socket): void {
    if (this.socket) {
      socket.destroy()
      return
    }
    this.socket = socket
    socket.setEncoding('utf8')
    let input = ''
    let authenticated = false
    socket.on('data', (chunk) => {
      input += chunk
      while (true) {
        const boundary = input.indexOf('\n')
        if (boundary < 0) break
        const line = input.slice(0, boundary)
        input = input.slice(boundary + 1)
        if (!line) continue
        try {
          const message = JSON.parse(line) as Record<string, unknown>
          if (message.token !== this.token) {
            socket.destroy(new Error('Detached shell supervisor authentication failed.'))
            return
          }
          authenticated = true
          delete message.token
          if (
            message.type === 'ready'
            && Number.isSafeInteger(message.pid)
            && Number(message.pid) > 0
          ) {
            this.supervisorPid = Number(message.pid)
          }
          this.emit('message', message)
        } catch (reason) {
          socket.destroy(reason instanceof Error ? reason : new Error(String(reason)))
          return
        }
      }
    })
    socket.once('error', (error) => this.fail(error))
    socket.once('close', () => {
      if (!authenticated && !this.exited) {
        this.fail(new Error('Detached shell supervisor disconnected before authentication.'))
        return
      }
      this.emitExit()
    })
  }

  private launch(program: string): void {
    const bootstrap = `eval(Buffer.from('${Buffer.from(program, 'utf8').toString('base64')}','base64').toString('utf8'))`
    const detachedScript = [
      `$env:ELECTRON_RUN_AS_NODE='1'`,
      `$env:ANAS_SHELL_SUPERVISOR_PIPE=${powershellSingleQuoted(this.pipePath)}`,
      `$env:ANAS_SHELL_SUPERVISOR_TOKEN=${powershellSingleQuoted(this.token)}`,
      `& ${powershellSingleQuoted(process.execPath)} '-e' ${powershellSingleQuoted(bootstrap)}`
    ].join('; ')
    const commandLine = [
      'powershell.exe -NoLogo -NoProfile -NonInteractive -Command',
      `"${detachedScript}"`
    ].join(' ')
    const launcher = spawn('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      windowsDetachedProcessCreateScript()
    ], {
      windowsHide: true,
      env: {
        ...process.env,
        ANAS_DETACHED_SUPERVISOR_COMMAND: commandLine
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    launcher.stdout.setEncoding('utf8')
    launcher.stderr.setEncoding('utf8')
    launcher.stdout.on('data', (chunk) => { stdout += chunk })
    launcher.stderr.on('data', (chunk) => { stderr += chunk })
    launcher.once('error', (error) => this.fail(error))
    launcher.once('close', (exitCode) => {
      const pid = Number(stdout.trim())
      if (Number.isSafeInteger(pid) && pid > 0) this.launcherPid = pid
      if (exitCode !== 0) {
        this.fail(new Error(
          stderr.trim() || `Could not create the detached shell supervisor (exit ${exitCode}).`
        ))
      }
    })
  }

  private fail(error: Error): void {
    if (this.exited || this.failureEmitted) return
    this.failureEmitted = true
    this.emit('error', error)
  }

  private emitExit(): void {
    if (this.exited) return
    this.exited = true
    try {
      this.server.close()
    } catch {
      // The listener may already be closed after an earlier transport failure.
    }
    this.emit('exit', this.exitCode, this.signalCode)
  }
}
