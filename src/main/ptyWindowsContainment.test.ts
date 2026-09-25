import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { runPreparedProcess } from './shellRuntime'

const mocks = vi.hoisted(() => ({
  current: undefined as unknown,
  addProcess: vi.fn(), terminate: vi.fn(), close: vi.fn(), release: vi.fn()
}))
vi.mock('./runtimeLogger', () => ({ runtimeLog: vi.fn() }))
vi.mock('./windowsProcessJob', () => ({ createWindowsKillOnCloseJob: () => mocks }))
vi.mock('./windowsPtyShellSupervisor', async () => {
  const { EventEmitter } = await import('node:events')
  return { WindowsPtyShellSupervisor: class extends EventEmitter {
    connected = true
    pid = 12345
    exitCode = null
    signalCode = null
    constructor() { super(); mocks.current = this }
    send() { return true }
    disconnect() { this.connected = false }
    kill() { return true } // ConPTY exit alone cannot prove Job cleanup.
  } }
})

afterEach(() => { mocks.current = undefined })

it.each([false, true])('checks the Windows Job after PTY exits (Job failure=%s)', async (fails) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  mocks.terminate.mockImplementation(() => { if (fails) throw new Error('Job termination failed') })
  mocks.close.mockImplementation(() => { if (fails) throw new Error('Job close failed') })
  const controller = new AbortController()
  const uncertain = vi.fn()
  const completion = runPreparedProcess({
    command: 'fixture', workingDir: process.cwd(), timeoutSec: 0,
    pty: { columns: 80, rows: 24 }, invocation: { executable: 'fixture.exe', args: [], windowsHide: true },
    logScope: 'test', successMessage: 'ok', failureMessage: 'failed',
    abortBeforeStartError: 'not started', abortError: 'cancelled', timeoutError: 'timeout'
  }, controller.signal, { onOutcomeUncertain: uncertain })
  const supervisor = mocks.current as EventEmitter
  supervisor.emit('message', { type: 'ready', pid: 12345 })
  supervisor.emit('message', { type: 'dispatching' })
  supervisor.emit('message', { type: 'started', pid: 12346 })
  controller.abort()
  supervisor.emit('exit', 1, null)
  const result = JSON.parse(await completion)
  expect(mocks.addProcess).toHaveBeenCalledWith(12345)
  expect(mocks.terminate).toHaveBeenCalledOnce()
  expect(mocks.close).toHaveBeenCalled()
  expect(result.ok).toBe(false)
  if (fails) expect(uncertain).toHaveBeenCalled()
  else { expect(uncertain).not.toHaveBeenCalled(); expect(result.aborted).toBe(true) }
})
