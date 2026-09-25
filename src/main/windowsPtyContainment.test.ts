import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { runPreparedProcess, type PreparedProcess, type ShellRunResult } from './shellRuntime'
import { WindowsProcessJob } from './windowsProcessJob'
import type { ShellTerminalControl } from './ptyShellSupervisor'

vi.mock('./runtimeLogger', () => ({ runtimeLog: vi.fn() }))

// Stringified into both probes so each publishes its own kernel creation time.
// These are process handles only: retaining the Job would change kill-on-close.
function windowsProcessProbe(native: typeof import('koffi').default) {
  const kernel = native.load('kernel32.dll')
  const open = kernel.func('__stdcall', 'OpenProcess', 'void*', ['uint32', 'int', 'uint32'])
  const current = kernel.func('__stdcall', 'GetCurrentProcess', 'void*', [])
  const times = kernel.func('__stdcall', 'GetProcessTimes', 'int', ['void*', 'void*', 'void*', 'void*', 'void*'])
  const wait = kernel.func('__stdcall', 'WaitForSingleObject', 'uint32', ['void*', 'uint32'])
  const terminate = kernel.func('__stdcall', 'TerminateProcess', 'int', ['void*', 'uint32'])
  const close = kernel.func('__stdcall', 'CloseHandle', 'int', ['void*'])
  const lastError = kernel.func('__stdcall', 'GetLastError', 'uint32', [])
  const failure = (api: string) => new Error(`${api} failed (Win32 ${lastError()}).`)
  const birth = (handle: unknown): string => {
    const data = Buffer.alloc(32)
    if (!times(handle, data, data.subarray(8), data.subarray(16), data.subarray(24))) throw failure('GetProcessTimes')
    return data.readBigUInt64LE().toString()
  }
  const exited = (handle: unknown): boolean => {
    const result = wait(handle, 0)
    if (result === 0) return true // WAIT_OBJECT_0
    if (result === 0x102) return false // WAIT_TIMEOUT
    throw failure('WaitForSingleObject')
  }
  const release = (handle: unknown): void => { if (!close(handle)) throw failure('CloseHandle') }
  return {
    identity: () => ({ pid: process.pid, birth: birth(current()) }),
    capture(expected: { pid: number; birth: string }): unknown {
      if (!Number.isSafeInteger(expected.pid) || expected.pid <= 0 || !/^\d+$/.test(expected.birth)) throw new Error('Invalid process identity.')
      // SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE.
      const handle = open(0x0010_0000 | 0x1000 | 0x0001, 0, expected.pid)
      if (handle === null || handle === undefined || handle === 0n) throw failure('OpenProcess')
      try {
        if (birth(handle) !== expected.birth) throw new Error(`Process ${expected.pid} was replaced before capture.`)
        return handle
      } catch (error) { release(handle); throw error }
    },
    exited,
    terminate(handle: unknown): void {
      if (!exited(handle) && !terminate(handle, 1) && !exited(handle)) throw failure('TerminateProcess')
    },
    close: release
  }
}

function prepared(root: string, source: string): PreparedProcess {
  return {
    command: 'Windows PTY containment probe', workingDir: root, timeoutSec: 10,
    pty: { columns: 90, rows: 25 }, invocation: { executable: process.env.npm_node_execpath!, args: ['-e', source], windowsHide: true },
    logScope: 'test', successMessage: 'done', failureMessage: 'failed',
    abortBeforeStartError: 'not started', abortError: 'cancelled', timeoutError: 'timeout'
  }
}

describe.runIf(process.platform === 'win32')('Windows PTY dispatch containment', () => {
  it.each(['job', 'effect'] as const)('never starts the command when the %s boundary fails', async (boundary) => {
    const root = mkdtempSync(join(tmpdir(), 'anas-pty-dispatch-'))
    const marker = join(root, 'executed')
    const spy = boundary === 'job' ? vi.spyOn(WindowsProcessJob.prototype, 'addProcess').mockImplementation(() => { throw new Error('job rejected') }) : undefined
    try {
      const result = await runPreparedProcess(prepared(root, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')`), undefined, {
        onDispatched: () => { if (boundary === 'effect') throw new Error('effect rejected') }
      })
      expect(result).toContain(`${boundary} rejected`)
      expect(existsSync(marker)).toBe(false)
    } finally { spy?.mockRestore(); rmSync(root, { recursive: true, force: true }) }
  })

  it('can cancel a silent CLI without waiting for its first output', async () => {
    const controller = new AbortController()
    let result: ShellRunResult | undefined
    await runPreparedProcess(prepared(process.cwd(), 'setInterval(()=>{},1000)'), controller.signal, {
      onTerminal: () => controller.abort(), onResult: (value) => { result = value }
    })
    expect(result).toMatchObject({ ok: false, aborted: true })
  }, 10000)

  it('reclaims the actual command and detached descendants when the application is hard-killed', async () => {
    const dependency = createRequire(import.meta.url)
    const native = windowsProcessProbe(dependency('koffi'))
    const probeSource = `(${windowsProcessProbe.toString()})(require(${JSON.stringify(dependency.resolve('koffi'))}))`
    const root = mkdtempSync(join(tmpdir(), 'anas-pty-crash-'))
    const identity = join(root, 'identity')
    const commandIdentity = join(root, 'command-identity')
    const captured = join(root, 'captured')
    const marker = join(root, 'survived')
    const childSource = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(identity)},JSON.stringify(${probeSource}.identity()));const armed=setInterval(()=>{if(fs.existsSync(${JSON.stringify(captured)})){clearInterval(armed);setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'orphaned'),3000)}},10);setInterval(()=>{},1000)`
    const source = `require('node:fs').writeFileSync(${JSON.stringify(commandIdentity)},JSON.stringify(${probeSource}.identity()));require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{detached:true,stdio:'inherit'});setInterval(()=>{},1000)`
    const handles: unknown[] = []
    const parent = spawn(process.execPath, [fileURLToPath(new URL('./windowsPtyParentCrashFixture.mjs', import.meta.url)), JSON.stringify({
      root, captured, source, executable: process.env.npm_node_execpath, cache: join(root, 'vite')
    })], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], timeout: 15000 })
    let parentError: Error | undefined, stderr = '', crashing = false
    parent.once('error', (error) => { parentError = error })
    parent.stderr!.on('data', (data) => { stderr += String(data) })
    parent.on('message', (message) => { if (message && typeof message === 'object' && 'type' in message && message.type === 'crashing') crashing = true })
    const parentExited = () => parent.exitCode !== null || parent.signalCode !== null
    const errors: unknown[] = []
    try {
      let identities: Array<{ pid: number; birth: string }> = []
      await vi.waitFor(() => {
        expect(parentError, stderr).toBeUndefined()
        expect(parentExited(), stderr).toBe(false)
        identities = [commandIdentity, identity].map((path) => JSON.parse(readFileSync(path, 'utf8')))
      }, { timeout: 15000 })
      for (const expected of identities) {
        const handle = native.capture(expected)
        handles.push(handle)
        expect(native.exited(handle), `Probe ${expected.pid} exited before the application crash.`).toBe(false)
      }
      // The fixture may crash only after both exact process objects are held.
      // The descendant's survival timer starts at this same boundary.
      writeFileSync(captured, 'captured')
      await vi.waitFor(() => {
        expect(parentError, stderr).toBeUndefined()
        expect(crashing, stderr).toBe(true)
        expect(parentExited(), stderr).toBe(true)
        expect(parent.exitCode, stderr).not.toBe(0)
        expect(parent.exitCode, stderr).not.toBe(2)
        for (const handle of handles) expect(native.exited(handle)).toBe(true)
      }, { timeout: 3500 })
      expect(existsSync(marker)).toBe(false)
    } catch (error) {
      errors.push(error)
    } finally {
      try { if (!parentExited()) parent.kill('SIGKILL') } catch (error) { errors.push(error) }
      for (const handle of handles) { try { native.terminate(handle) } catch (error) { errors.push(error) } }
      try {
        await vi.waitFor(() => {
          expect(parentExited()).toBe(true)
          for (const handle of handles) expect(native.exited(handle)).toBe(true)
        }, { timeout: 3500 })
      } catch (error) { errors.push(error) }
      for (const handle of handles) { try { native.close(handle) } catch (error) { errors.push(error) } }
      try { rmSync(root, { recursive: true, force: true }) } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'Windows PTY containment probe or cleanup failed.')
  }, 25000) // Includes the cleanup budget after readiness and exit deadlines.

  it('delivers Chinese input to a PowerShell foreground child and keeps the shell usable after Ctrl+C', async () => {
    const controller = new AbortController()
    let terminal: ShellTerminalControl | undefined
    let output = ''
    let result: ShellRunResult | undefined
    const command = prepared(process.cwd(), '')
    command.timeoutSec = 20
    command.invocation = { executable: 'pwsh.exe', args: ['-NoLogo', '-NoProfile'], windowsHide: true }
    const completion = runPreparedProcess(command, controller.signal, {
      onTerminal: (value) => { terminal = value }, onOutput: (_, text) => { output += text }, onResult: (value) => { result = value }
    })
    try {
      await vi.waitFor(() => expect(terminal).toBeDefined(), { timeout: 5000 })
      const source = "console.log('CHILD_READY');require('node:readline').createInterface({input:process.stdin}).question('',v=>{console.log('HEX:'+Buffer.from(v).toString('hex'));process.exit(0)})"
      const quote = (text: string) => `'${text.replaceAll("'", "''")}'`
      await terminal!.apply({ type: 'text', text: `& ${quote(process.env.npm_node_execpath!)} -e ${quote(source)}\r` })
      // The command echo contains CHILD_READY too. Wait for its own output line.
      await vi.waitFor(() => expect(stripVTControlCharacters(output)).toMatch(/(?:^|\r?\n)CHILD_READY\r?\n/), { timeout: 5000 })
      await terminal!.apply({ type: 'text', text: 'cafeé 漢字\r' })
      await vi.waitFor(() => expect(output).toContain(`HEX:${Buffer.from('cafeé 漢字').toString('hex')}`), { timeout: 5000 })
      output = ''
      await terminal!.apply({ type: 'text', text: 'ping.exe -4 -t 127.0.0.1\r' })
      await vi.waitFor(() => expect(output).toContain('TTL='), { timeout: 5000 })
      output = ''
      await terminal!.apply({ type: 'key', key: 'ctrl_c' })
      await vi.waitFor(() => expect(output).toContain('PS '), { timeout: 5000 })
      await terminal!.apply({ type: 'text', text: "Write-Output ('SHELL_'+'ALIVE'); exit 0\r" })
      await completion
      expect(result, JSON.stringify({ result, output: output.slice(-2000) })).toMatchObject({ ok: true })
      expect(output).toContain('SHELL_ALIVE')
    } finally { controller.abort(); await completion }
  }, 25000)
})
