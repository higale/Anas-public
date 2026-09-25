import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import { mkdtempSync, rmdirSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type IPty } from 'node-pty'
import koffi from 'koffi'
import { createPosixPtySession } from './posixPtySession'
import { terminalActionSchema, terminalInput, type TerminalAction, type TerminalSize } from '@shared/terminal'

const nativeDependency = createRequire(import.meta.url)

export interface ShellTerminalControl {
  readonly id: string
  readonly size: TerminalSize
  apply(action: TerminalAction): void | Promise<void>
}

/** On POSIX the command guardian is the PTY session leader. Its control channel
 * is separate from terminal bytes; no command runs until its normal dispatch
 * handshake. This preserves parent-death containment without a second registry. */
export class PtyShellSupervisor extends EventEmitter implements ShellTerminalControl {
  readonly id = randomUUID()
  private readonly token = randomUUID()
  private readonly session = createPosixPtySession(koffi, fs)
  private readonly directory = mkdtempSync(join(tmpdir(), 'anas-pty-'))
  private readonly pipePath = join(this.directory, 'control')
  private readonly server: Server
  private socket?: Socket
  private terminal?: IPty
  private sessionLeader?: NonNullable<ReturnType<ReturnType<typeof createPosixPtySession>['inspect']>>
  private containmentConfirmed = false
  private result?: unknown
  private exited = false
  private failed = false
  private ready = false
  private dimensions: TerminalSize
  private inputBytes = 0
  private inputWrites = 0
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null

  constructor(program: string, size: TerminalSize) {
    super()
    this.dimensions = { ...size }
    this.server = createServer((socket) => this.accept(socket))
    this.server.once('error', (error) => this.fail(error))
    this.server.listen(this.pipePath, () => {
      try {
        this.terminal = spawn(process.execPath, ['-e', program], {
          name: 'xterm-256color', cols: size.columns, rows: size.rows,
          cwd: process.cwd(),
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ANAS_SHELL_SUPERVISOR_PIPE: this.pipePath,
            ANAS_SHELL_SUPERVISOR_TOKEN: this.token, ANAS_SHELL_SUPERVISOR_PTY: '1', ANAS_PTY_NATIVE_MODULE: nativeDependency.resolve('koffi') }
        })
        this.sessionLeader = this.session.inspect(this.terminal.pid)
        this.terminal.onData((text) => this.emit('message', { type: 'output', stream: 'stdout', text }))
        this.terminal.onExit(({ exitCode }) => {
          const contained = this.kill()
          this.containmentConfirmed = contained
          this.exited = true
          this.exitCode = exitCode
          this.disposeTransport()
          if (!contained) this.emit('error', new Error('Could not confirm cleanup of the PTY session.'))
          // node-pty drains its output before onExit. Never publish the result
          // from the separate control pipe before those final terminal bytes.
          if (this.result) this.emit('message', this.result)
          this.emit('exit', exitCode, null)
        })
      } catch (error) {
        this.disposeTransport()
        this.fail(error)
      }
    })
  }

  get connected(): boolean { return Boolean(this.socket && !this.socket.destroyed && !this.exited) }
  get pid(): number | undefined { return this.terminal?.pid }
  get size(): TerminalSize { return { ...this.dimensions } }

  apply(input: TerminalAction): void {
    const action = terminalActionSchema.parse(input)
    if (!this.terminal || !this.ready || this.exited || this.result || !this.connected) throw new Error('The terminal instance is no longer available.')
    if (action.type === 'resize') {
      this.terminal.resize(action.columns, action.rows)
      this.dimensions = { columns: action.columns, rows: action.rows }
    } else {
      const text = terminalInput(action)
      const bytes = Buffer.byteLength(text, 'utf8')
      // node-pty queues stdin internally and exposes no drain acknowledgement.
      // Bound its worst-case queue even if the CLI never reads stdin. Use files
      // for bulk data, not a terminal paste stream. Cancellation remains usable.
      if (this.inputBytes + bytes > 1024 * 1024 || this.inputWrites >= 4096) throw new Error('Terminal input budget exhausted (1 MiB or 4096 writes per session). Use cancel_call to stop the session; bulk data belongs in files.')
      this.inputBytes += bytes
      this.inputWrites += 1
      this.terminal.write(text)
    }
  }

  send(message: unknown, callback?: (error: Error | null) => void): boolean {
    if (!this.socket || !this.connected) {
      callback?.(new Error('The PTY command supervisor is disconnected.'))
      return false
    }
    return this.socket.write(`${JSON.stringify(message)}\n`, () => callback?.(null))
  }

  disconnect(): void { this.socket?.end() }

  kill(signal: NodeJS.Signals | number = 'SIGKILL'): boolean {
    if (!['SIGTERM', 'SIGKILL', 15, 9].includes(signal)) return false
    if (!this.terminal) return false
    if (this.exited) return this.containmentConfirmed
    try {
      const contained = Boolean(this.sessionLeader && this.session.terminate(this.sessionLeader, signal === 'SIGKILL' || signal === 9))
      const ended = Boolean(this.sessionLeader && this.session.signalMember(this.sessionLeader, signal === 'SIGKILL' || signal === 9 ? 'SIGKILL' : 'SIGTERM'))
      if (!contained || !ended) return false
      if (signal === 'SIGKILL' || signal === 9) this.containmentConfirmed = true
      return true
    } catch (error) {
      return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH')
    }
  }

  private accept(socket: Socket): void {
    if (this.socket || this.exited) { socket.destroy(); return }
    this.socket = socket
    let input = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      input += chunk
      if (input.length > 65_536) { this.fail(new Error('PTY supervisor control message exceeds its budget.')); return }
      for (;;) {
        const boundary = input.indexOf('\n')
        if (boundary < 0) break
        const line = input.slice(0, boundary)
        input = input.slice(boundary + 1)
        try {
          const message = JSON.parse(line)
          if (message.token !== this.token) throw new Error('PTY supervisor identity mismatch.')
          if (message.type === 'ready' && message.pid !== this.pid) throw new Error('PTY supervisor process identity mismatch.')
          if (message.type === 'ready') {
            this.sessionLeader = this.session.inspect(message.pid)
            if (!this.sessionLeader || this.sessionLeader.session !== message.pid) throw new Error('PTY session identity could not be captured before dispatch.')
          }
          if (message.type === 'started') this.ready = true
          if (message.type === 'result') {
            this.result = message
            if (!this.kill()) this.fail(new Error('Could not terminate the completed PTY session.'))
          } else this.emit('message', message)
        } catch (error) { this.fail(error); return }
      }
    })
    socket.once('error', (error) => this.fail(error))
    socket.once('close', () => {
      // A killed guardian closes its control pipe before node-pty drains and
      // reports exit. Reclaim the session, then let the common runner classify
      // that exit: confirmed cancellation versus an unexpected lost result.
      if (!this.result && !this.exited && !this.kill()) this.fail(new Error('Could not contain the disconnected PTY supervisor.'))
    })
  }

  private disposeTransport(): void {
    this.socket?.destroy()
    this.server.close(() => {
      try { rmdirSync(this.directory) } catch { /* No recursive deletion; only our empty socket directory. */ }
    })
  }

  private fail(reason: unknown): void {
    if (this.failed || this.exited) return
    this.failed = true
    this.kill()
    if (!this.terminal) this.disposeTransport()
    this.emit('error', reason instanceof Error ? reason : new Error(String(reason)))
  }
}
