import { describe, expect, it, vi } from 'vitest'
import { runPreparedProcess, shellSupervisorProgram, type ShellRunResult } from './shellRuntime'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ShellTerminalControl } from './ptyShellSupervisor'
import { AgentDatabase } from './agent/agentDatabase'
import { ManagedCallService } from './agent/managedCallService'

vi.mock('./runtimeLogger', () => ({ runtimeLog: vi.fn() }))

// Electron is a GUI executable on Windows, not a console CLI fixture.
const fixtureExecutable = process.platform === 'win32' ? process.env.npm_node_execpath! : process.execPath

function launch(source: string) {
  const controller = new AbortController()
  let terminal: ShellTerminalControl | undefined
  let output = ''
  let result: ShellRunResult | undefined
  const completion = runPreparedProcess({
    command: 'isolated PTY fixture', workingDir: process.cwd(), timeoutSec: 10,
    pty: { columns: 90, rows: 25 }, invocation: { executable: fixtureExecutable,
      args: ['-e', source], env: { ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true },
    logScope: 'test', successMessage: 'ok', failureMessage: 'failed',
    abortBeforeStartError: 'not started', abortError: 'cancelled', timeoutError: 'timeout'
  }, controller.signal, { onTerminal: (value) => { terminal = value },
    onOutput: (_, text) => { output += text }, onResult: (value) => { result = value } })
  return { controller, completion, get terminal() { return terminal! }, get output() { return output }, get result() { return result! } }
}

async function ready(call: ReturnType<typeof launch>) {
  await vi.waitFor(() => {
    expect(call.result?.error).toBeUndefined()
    expect(call.output).toContain('READY')
  }, { timeout: 6_000 })
}

describe('PTY command supervision', () => {
  it.skipIf(process.platform !== 'darwin').each([false, true])('reclaims interactive shell jobs (background=%s)', async (background) => {
    const root = mkdtempSync(join(tmpdir(), 'anas-pty-job-control-'))
    const marker = join(root, 'orphaned')
    const identity = join(root, 'identity')
    const source = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(identity)},String(process.pid));process.on('SIGHUP',()=>{});process.on('SIGTERM',()=>{});console.log('READY');setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'orphan'),4000);setInterval(()=>{},1000)`
    const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
    const command = `${quote(process.execPath)} -e ${quote(source)}${background ? ' &' : ';'} wait`
    const independent = launch(`console.log('READY');setInterval(()=>{},1000)`)
    const call = launch(`require('node:child_process').spawn('/bin/zsh',['-f','-ic',${JSON.stringify(command)}],{stdio:'inherit'});setInterval(()=>{},1000)`)
    let childPid: number | undefined
    try {
      await ready(call)
      await ready(independent)
      childPid = Number(readFileSync(identity, 'utf8'))
      call.controller.abort()
      await call.completion
      await new Promise((resolve) => setTimeout(resolve, 4500))
      expect(existsSync(marker)).toBe(false)
      expect(() => process.kill(childPid!, 0)).toThrow()
      expect(independent.result).toBeUndefined()
      expect(() => independent.terminal.apply({ type: 'resize', columns: 81, rows: 24 })).not.toThrow()
    } finally {
      call.controller.abort(); await call.completion
      independent.controller.abort(); await independent.completion
      if (childPid) { try { process.kill(childPid, 'SIGKILL') } catch { /* Owned probe already gone. */ } }
      rmSync(root, { recursive: true, force: true })
    }
  }, 20000)
  it('drains the real PTY executor through managed-service shutdown', async () => {
    const database = AgentDatabase.open(':memory:')
    const service = new ManagedCallService(database)
    const thread = database.createThread({ title: 'PTY shutdown' })
    const run = database.createRun(thread.id, 'pty-shutdown')
    let result: ShellRunResult | undefined
    const starting = service.start({ kind: 'shell', threadId: thread.id, runId: run.id, summary: 'interactive shutdown',
      execute: (control) => runPreparedProcess({
        command: 'PTY shutdown probe', workingDir: process.cwd(), timeoutSec: 10,
        pty: { columns: 80, rows: 24 }, invocation: { executable: fixtureExecutable,
          args: ['-e', `process.on('SIGTERM',()=>{});console.log('READY');setInterval(()=>{},1000)`],
          windowsHide: true, env: { ELECTRON_RUN_AS_NODE: '1' } },
        logScope: 'test', successMessage: 'ok', failureMessage: 'failed',
        abortBeforeStartError: 'not started', abortError: 'cancelled', timeoutError: 'timeout'
      }, control.signal, { onDispatched: control.markRunning, onTerminal: control.setTerminal,
        onOutput: control.output, onOutcomeUncertain: control.markUncertain,
        onResult: (value) => { result = value; control.setOutcome({ ok: value.ok }) } }) })
    try {
      const callId = service.activeCallIds()[0]
      await vi.waitFor(() => expect(service.readOutput({ callId, threadId: thread.id, offset: 0, length: 1000 })).toContain('READY'), { timeout: 6000 })
      expect(JSON.parse(service.read({ callId, threadId: thread.id }))).toHaveProperty('pty')
      const stopped = await service.shutdown()
      await starting
      expect(stopped, JSON.stringify(database.getManagedCall(callId, thread.id))).toEqual({ uncertainCallIds: [], lingeringCallIds: [] })
      expect(service.activeCallIds()).toEqual([])
      expect(result).toMatchObject({ ok: false, aborted: true })
    } finally { await service.shutdown(); await starting; await service.waitForIdle(); database.close() }
  }, 15_000)
  it.skipIf(process.platform === 'win32').each(['direct', 'foreground', 'background'] as const)('contains a SIGHUP-ignoring %s job after the application is hard-killed', async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'anas-pty-parent-crash-'))
    const marker = join(root, 'orphaned')
    const identity = join(root, 'identity')
    const childIdentity = join(root, 'child-identity')
    let supervisorPid: number | undefined
    let childPid: number | undefined
    try {
      const crashed = spawnSync(process.execPath, [fileURLToPath(new URL('./ptyParentCrashFixture.mjs', import.meta.url)), JSON.stringify({
        root, marker, identity, childIdentity, mode, cache: join(root, 'vite'), program: shellSupervisorProgram
      })], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 15000 })
      expect(crashed.error, crashed.stderr).toBeUndefined()
      expect(crashed.signal, crashed.stderr).toBe('SIGKILL')
      supervisorPid = Number(readFileSync(identity, 'utf8'))
      childPid = Number(readFileSync(childIdentity, 'utf8'))
      expect(supervisorPid).toBeGreaterThan(0)
      await new Promise((resolve) => setTimeout(resolve, 4500))
      expect(existsSync(marker)).toBe(false)
      expect(() => process.kill(supervisorPid!, 0)).toThrow()
      expect(() => process.kill(childPid!, 0)).toThrow()
    } finally {
      if (Number.isSafeInteger(supervisorPid) && supervisorPid! > 0) {
        try { process.kill(-supervisorPid!, 'SIGKILL') } catch { /* Already reclaimed. */ }
      }
      if (childPid) { try { process.kill(childPid, 'SIGKILL') } catch { /* Owned probe already gone. */ } }
      rmSync(root, { recursive: true, force: true })
    }
  }, 25_000)
  it('gives the actual command a TTY, accepts Chinese input and drains final output', async () => {
    const call = launch(`const rl=require('node:readline').createInterface({input:process.stdin,output:process.stdout}); console.log('TTY:'+process.stdin.isTTY+':'+process.stdout.isTTY); rl.question('READY', answer=>{console.log('ANSWER:'+answer);rl.close()})`)
    try {
      await ready(call)
      expect(call.output).toContain('TTY:true:true')
      await call.terminal.apply({ type: 'text', text: '你好 terminal' })
      await call.terminal.apply({ type: 'key', key: 'enter' })
      await call.completion
      expect(call.result.ok, JSON.stringify(call.result)).toBe(true)
      expect(call.output).toContain('ANSWER:你好 terminal')
      await expect(Promise.resolve().then(() => call.terminal.apply({ type: 'text', text: 'stale' }))).rejects.toThrow('no longer available')
    } finally { call.controller.abort(); await call.completion }
  }, 15_000)

  it('keeps all streamed output while bounding only the inline result', async () => {
    const lines = Array.from({ length: 4000 }, (_, index) => `${index.toString().padStart(4, '0')}:${'x'.repeat(45)}`)
    const payload = lines.join('\r\n') + '\r\nFINAL_MARKER'
    // POSIX node-pty enables OPOST | ONLCR: application LF becomes terminal
    // CRLF. Supplying CRLF here would correctly produce CRCRLF on the wire.
    const call = launch(String.raw`process.stdout.write(Array.from({length:4000},(_,i)=>i.toString().padStart(4,'0')+':'+'x'.repeat(45)).join('\n')+'\nFINAL_MARKER')`)
    try {
      await call.completion
      expect(call.result.ok, JSON.stringify(call.result)).toBe(true)
      // ConPTY can repaint lines, so verify every uniquely numbered line,
      // not equality with bytes written by the console application.
      if (process.platform === 'win32') {
        for (const line of lines) expect(call.output).toContain(line)
        expect(call.output).toContain('FINAL_MARKER')
      } else expect(call.output).toBe(payload)
      expect(call.result.stdout.length).toBe(120000)
    } finally { call.controller.abort(); await call.completion }
  }, 15_000)

  it('resizes the current terminal and delivers Ctrl+C without losing supervision', async () => {
    const call = launch(`console.log('READY'); process.on('SIGINT',()=>{console.log('INTERRUPTED');process.exit(0)}); process.stdin.resume(); setInterval(()=>{},1000)`)
    try {
      await ready(call)
      await call.terminal.apply({ type: 'resize', columns: 105, rows: 32 })
      expect(call.terminal.size).toEqual({ columns: 105, rows: 32 })
      await call.terminal.apply({ type: 'key', key: 'ctrl_c' })
      await call.completion
      expect(call.result.ok).toBe(true)
      expect(call.output).toContain('INTERRUPTED')
    } finally { call.controller.abort(); await call.completion }
  }, 15_000)

  it.skipIf(process.platform === 'win32')('sends POSIX EOF to a canonical terminal reader', async () => {
    const call = launch(`console.log('READY'); process.stdin.resume(); process.stdin.on('end',()=>console.log('EOF_RECEIVED'))`)
    try {
      await ready(call)
      await call.terminal.apply({ type: 'eof' })
      await call.completion
      expect(call.result.ok).toBe(true)
      expect(call.output).toContain('EOF_RECEIVED')
    } finally { call.controller.abort(); await call.completion }
  }, 15_000)

  it('cancels a live terminal through the existing process containment path', async () => {
    const call = launch(`console.log('READY'); setInterval(()=>{},1000)`)
    try {
      await ready(call)
      call.controller.abort()
      await call.completion
      expect(call.result).toMatchObject({ ok: false, aborted: true })
    } finally { call.controller.abort(); await call.completion }
  }, 15_000)

  it('bounds native stdin buffering when a raw-mode CLI never consumes input', async () => {
    const call = launch(`process.stdin.setRawMode(true); process.stdin.pause(); console.log('READY'); setInterval(()=>{},1000)`)
    try {
      await ready(call)
      for (let index = 0; index < 64; index++) await call.terminal.apply({ type: 'text', text: 'x'.repeat(16_000) })
      await call.terminal.apply({ type: 'text', text: 'x'.repeat(16_000) })
      await expect(Promise.resolve().then(() => call.terminal.apply({ type: 'text', text: 'x'.repeat(16_000) }))).rejects.toThrow('budget exhausted')
      // Resizing and managed cancellation stay available after input is full.
      await call.terminal.apply({ type: 'resize', columns: 80, rows: 24 })
      call.controller.abort()
      await call.completion
      expect(call.result.aborted).toBe(true)
    } finally { call.controller.abort(); await call.completion }
  }, 15_000)
})
