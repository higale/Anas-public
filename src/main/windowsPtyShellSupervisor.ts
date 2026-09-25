import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { terminalActionSchema, terminalInput, type TerminalAction, type TerminalSize } from '@shared/terminal'
import type { ShellTerminalControl } from './ptyShellSupervisor'

const nativeDependency = createRequire(import.meta.url)

// This supervisor stays OUTSIDE the console. The parent puts it in its
// kill-on-close Job before sending dispatch. CreateProcess in node-pty then
// inherits that Job atomically; the managed Job does not permit breakaway.
const program = String.raw`
const pty = require(process.env.ANAS_PTY_MODULE)
let terminal, request, startup, timeout
let started = false, dispatched = false, ended = false, pressure = 0
const send = (message, callback) => {
  if (!process.connected) return false
  return process.send(message, callback)
}
const reportStarted = () => {
  if (!started && terminal && terminal.pid > 0) {
    started = true
    clearInterval(startup)
    send({ type: 'started', pid: terminal.pid })
  }
}
const finish = (exitCode, error) => {
  if (ended) return
  reportStarted()
  ended = true
  clearInterval(startup); clearTimeout(timeout)
  send({ type: 'result', exitCode, timedOut: false, aborted: false, beforeStart: !started, error })
  // Remain alive until the parent terminates the Job, including any remaining
  // descendants. ConPTY exit alone is not proof that the Job is empty.
}
process.on('disconnect', () => process.exit(1))
process.on('message', (message) => {
  if (message.type === 'start' && !request && !ended) {
    request = message
    send({ type: 'dispatching' })
  } else if (message.type === 'dispatch' && request && !dispatched && !ended) {
    dispatched = true
    try {
      const size = JSON.parse(process.env.ANAS_PTY_SIZE)
      terminal = pty.spawn(request.executable, request.args, {
        cwd: request.cwd, env: request.environment, cols: size.columns, rows: size.rows, useConpty: true
      })
      terminal.onData((text) => {
        reportStarted()
        let blocked = false
        const accepted = send({ type: 'output', stream: 'stdout', text }, () => {
          if (blocked && --pressure === 0 && !ended) terminal.resume()
        })
        if (!accepted) { blocked = true; pressure++; terminal.pause() }
      })
      terminal.onExit(({ exitCode }) => finish(exitCode,
        Number.isSafeInteger(exitCode) ? undefined : 'ConPTY did not report a valid exit code.'))
      // node-pty connects asynchronously on Windows; pid is initially zero.
      // Do not require output before exposing control of a silent command.
      startup = setInterval(reportStarted, 10)
      reportStarted()
      if (request.timeoutMs > 0) timeout = setTimeout(() => {
        send({ type: 'termination_started', reason: 'timeout' })
      }, request.timeoutMs)
    } catch (error) { finish(undefined, error.message) }
  } else if (message.type === 'cancel' || message.type === 'termination_ack') {
    send({ type: 'force_required', reason: message.type === 'cancel' ? 'cancel' : 'timeout' })
  } else if (message.type === 'terminal_input') {
    try {
      if (!started || ended) throw new Error('The terminal instance is no longer available.')
      if (message.size) terminal.resize(message.size.columns, message.size.rows)
      else terminal.write(message.text)
      send({ type: 'terminal_ack', id: message.id })
    } catch (error) { send({ type: 'terminal_ack', id: message.id, error: error.message }) }
  }
})
send({ type: 'ready', pid: process.pid })
`

export class WindowsPtyShellSupervisor extends EventEmitter implements ShellTerminalControl {
  readonly id = randomUUID()
  private readonly child: ChildProcess
  private dimensions: TerminalSize
  private ready = false
  private ended = false
  private inputBytes = 0
  private inputWrites = 0
  private readonly pending = new Map<string, { resolve(): void; reject(error: Error): void; timer: NodeJS.Timeout }>()

  constructor(size: TerminalSize) {
    super()
    this.dimensions = { ...size }
    this.child = spawn(process.execPath, ['-e', program], {
      windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ANAS_PTY_MODULE: nativeDependency.resolve('node-pty'), ANAS_PTY_SIZE: JSON.stringify(size) }
    })
    this.child.on('message', (message: any) => {
      if (message.type === 'ready' && message.pid !== this.child.pid) {
        this.emit('error', new Error('Windows PTY supervisor identity mismatch.'))
        return
      }
      if (message.type === 'terminal_ack') {
        const pending = this.pending.get(message.id)
        if (!pending) return
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) pending.reject(new Error(message.error))
        else pending.resolve()
        return
      }
      if (message.type === 'started') this.ready = true
      if (message.type === 'result') this.end()
      this.emit('message', message)
    })
    this.child.once('error', (error) => { this.end(); this.emit('error', error) })
    this.child.once('exit', (code, signal) => { this.end(); this.emit('exit', code, signal) })
    this.child.once('disconnect', () => this.end())
  }

  get pid(): number | undefined { return this.child.pid }
  get connected(): boolean { return this.child.connected }
  get exitCode(): number | null { return this.child.exitCode }
  get signalCode(): NodeJS.Signals | null { return this.child.signalCode }
  get size(): TerminalSize { return { ...this.dimensions } }
  send(message: any, callback?: (error: Error | null) => void): boolean { return this.child.send(message, callback) }
  disconnect(): void { this.child.disconnect() }
  kill(signal?: NodeJS.Signals | number): boolean { return this.child.kill(signal) }

  async apply(input: TerminalAction): Promise<void> {
    const action = terminalActionSchema.parse(input)
    if (!this.ready || this.ended || !this.connected) throw new Error('The terminal instance is no longer available.')
    if (this.pending.size >= 64) throw new Error('Too many pending terminal inputs.')
    const text = action.type === 'resize' ? undefined : terminalInput(action)
    if (text !== undefined) {
      const bytes = Buffer.byteLength(text, 'utf8')
      if (this.inputBytes + bytes > 1024 * 1024 || this.inputWrites >= 4096) throw new Error('Terminal input budget exhausted (1 MiB or 4096 writes per session). Use cancel_call to stop the session; bulk data belongs in files.')
      this.inputBytes += bytes
      this.inputWrites++
    }
    const id = randomUUID()
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => {
        const pending = this.pending.get(id)
        if (!pending) return
        clearTimeout(pending.timer)
        this.pending.delete(id)
        reject(error)
      }
      const timer = setTimeout(() => fail(new Error('Terminal input acknowledgement was lost; do not resend automatically.')), 5000)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ type: 'terminal_input', id, ...(action.type === 'resize' ? { size: { columns: action.columns, rows: action.rows } } : { text }) }, (error) => { if (error) fail(error) })
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))) }
    })
    if (action.type === 'resize') this.dimensions = { columns: action.columns, rows: action.rows }
  }

  private end(): void {
    this.ended = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('The terminal ended before input acknowledgement; do not resend automatically.'))
    }
    this.pending.clear()
  }
}
