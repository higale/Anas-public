import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { discoverPython3, runRuntimeProbe } from './runtimeDiscovery'
import { runWithCurrentAgentToolEffect } from './agent/toolEffectScope'
import { withToolExecution } from './agent/toolExecutionContext'
import type { ManagedCallControl } from './agent/managedCallService'
import { runtimeLog } from './runtimeLogger'

vi.mock('./runtimeLogger', () => ({ runtimeLog: vi.fn() }))
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
async function directory() {
  const path = await mkdtemp(join(tmpdir(), 'anas-python-discovery-'))
  directories.push(path)
  return path
}

describe('Python runtime discovery', () => {
  it('skips Python 2 and retains the interpreter selected by the Windows launcher', async () => {
    const runProbe = vi.fn(async (executable: string, args: string[]) => {
      if (executable === 'python.exe') return '2.7.18\nC:\\Python2\\python.exe'
      if (executable === 'py.exe' && args[0] === '-3') return '3.13.3\r\nC:\\Program Files\\Python3\\python.exe\r\n'
      return undefined
    })
    const env = { PATH: 'C:\\tools', PYTHON_MANAGER_AUTOMATIC_INSTALL: 'true' }
    expect(await discoverPython3({ platform: 'win32', env, runProbe })).toEqual({
      executable: 'C:\\Program Files\\Python3\\python.exe', version: '3.13.3', command: 'py -3'
    })
    expect(runProbe.mock.calls.map(([executable]) => executable)).toEqual(['python.exe', 'py.exe'])
    expect(runProbe).toHaveBeenLastCalledWith('py.exe', expect.arrayContaining(['-3', '-c']), expect.objectContaining({
      env: expect.objectContaining({ PATH: 'C:\\tools', PYTHON_MANAGER_AUTOMATIC_INSTALL: 'false' })
    }))
    expect(env.PYTHON_MANAGER_AUTOMATIC_INSTALL).toBe('true')
  })

  it.each(['darwin', 'linux'] as const)('uses a working Python 3 on %s after an unavailable preferred command', async platform => {
    const runProbe = vi.fn(async (executable: string) => executable === 'python' ? '3.12.9\n/opt/python/bin/python' : undefined)
    expect(await discoverPython3({ platform, runProbe })).toEqual({ executable: '/opt/python/bin/python', version: '3.12.9', command: 'python' })
  })

  it('preserves spaces and Unicode in the interpreter path', async () => {
    const executable = '/opt/中文 Python/python3 '
    expect((await discoverPython3({ platform: 'darwin', runProbe: async () => `3.13.3\n${executable}\n` }))?.executable).toBe(executable)
  })

  it.each(['Python 3.13.3', '2.7.18\n/usr/bin/python', '3.13.3\npython', '3.13.3\n/usr/bin/python\nnoise', '3.13.3\n/usr/bin/py\0thon'])('rejects an unusable interpreter identity: %j', async output => {
    expect(await discoverPython3({ platform: 'linux', runProbe: async () => output })).toBeUndefined()
  })

  it('caches successes by environment and working directory and refreshes expired entries', async () => {
    const cwd = await directory()
    const now = vi.spyOn(Date, 'now').mockReturnValue(100_000)
    let version = '3.11.0'
    const runProbe = vi.fn(async () => `${version}\n${process.execPath}`)
    const options = { cwd, env: { PATH: 'one', PYTHONPATH: 'a' }, cache: true, runProbe }
    expect((await discoverPython3(options))?.version).toBe(version)
    version = '3.12.0'
    expect((await discoverPython3(options))?.version).toBe('3.11.0')
    expect((await discoverPython3({ ...options, env: { ...options.env, PATH: 'two' } }))?.version).toBe(version)
    expect((await discoverPython3({ ...options, env: { ...options.env, PYTHONPATH: 'b' } }))?.version).toBe(version)
    expect((await discoverPython3({ ...options, cwd: await directory() }))?.version).toBe(version)
    now.mockReturnValue(160_001)
    expect((await discoverPython3(options))?.version).toBe(version)
  })

  it('does not cache missing runtimes or reuse a removed interpreter', async () => {
    const cwd = await directory()
    const executable = join(cwd, 'python')
    await writeFile(executable, '', { mode: 0o755 })
    let output: string | undefined
    const options = { cwd, cache: true, runProbe: async () => output }
    expect(await discoverPython3(options)).toBeUndefined()
    output = `3.12.0\n${executable}`
    expect((await discoverPython3(options))?.executable).toBe(executable)
    await rm(executable)
    output = undefined
    expect(await discoverPython3(options)).toBeUndefined()
  })

  it('stops probing further candidates when cancelled', async () => {
    const controller = new AbortController()
    const runProbe = vi.fn(async () => { controller.abort(); return undefined })
    await expect(discoverPython3({ signal: controller.signal, runProbe })).rejects.toMatchObject({ name: 'AbortError' })
    expect(runProbe).toHaveBeenCalledTimes(1)
    runProbe.mockClear()
    await expect(discoverPython3({ signal: controller.signal, runProbe })).rejects.toMatchObject({ name: 'AbortError' })
    expect(runProbe).not.toHaveBeenCalled()
  })
})

describe('bounded command probes', () => {
  const node = process.env.npm_node_execpath ?? process.execPath
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ANAS_PROBE_MARKER: 'exact environment' }
  it('executes with the supplied environment and directory and accepts stderr version output', async () => {
    const cwd = await directory()
    const output = await runRuntimeProbe(node, ['-e', 'console.error(JSON.stringify({cwd:process.cwd(),marker:process.env.ANAS_PROBE_MARKER}))'], { env, cwd })
    expect(JSON.parse(output!)).toEqual({ cwd: await realpath(cwd), marker: 'exact environment' })
    expect(await runRuntimeProbe(node, ['-e', 'process.exit(1)'], { env })).toBeUndefined()
    expect(await runRuntimeProbe(node, ['-e', 'process.stdout.write("x".repeat(65537))'], { env })).toBeUndefined()
    expect(await runRuntimeProbe(node, ['-e', 'process.stderr.write("中".repeat(21846))'], { env })).toBeUndefined()
    vi.stubEnv('ANAS_PROBE_EXCLUDED', 'host-only')
    try {
      expect(await runRuntimeProbe(node, ['-e', 'console.log(process.env.ANAS_PROBE_EXCLUDED ?? "absent")'], { env })).toBe('absent\n')
    } finally { vi.unstubAllEnvs() }
  })
  it('bounds a stalled probe and cancels an active process', async () => {
    expect(await runRuntimeProbe(node, ['-e', 'setInterval(()=>{},1000)'], { env })).toBeUndefined()
    const controller = new AbortController()
    const pending = runRuntimeProbe(node, ['-e', 'setInterval(()=>{},1000)'], { env, signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  }, 6000)

  it('does not log ordinary probe completion or unavailable commands', async () => {
    expect(await runRuntimeProbe(node, ['-e', 'console.log("version")'], { env })).toBe('version\n')
    expect(await runRuntimeProbe('anas-missing-runtime-probe', [], { env })).toBeUndefined()
    expect(runtimeLog).not.toHaveBeenCalled()
  })

  it.for(['node', 'python'].flatMap(runtime => ['cancel', 'timeout', 'output limit'].map(mode => ({ runtime, mode }))))('reclaims $runtime probe descendants on $mode', { timeout: 12_000 }, async ({ runtime, mode }, { skip }) => {
    const cwd = await directory()
    const controller = new AbortController()
    const python = runtime === 'python' ? await discoverPython3({ env, cwd }) : undefined
    if (runtime === 'python' && !python) return skip('Python 3 is not installed')
    const script = join(cwd, python ? 'launcher.py' : 'launcher.cjs')
    const pidsFile = join(cwd, 'pids.json')
    await writeFile(script, python ? `
import json, os, signal, subprocess, sys, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
child = subprocess.Popen([sys.executable, '-c', 'import signal, time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
with open('pids.json', 'w', encoding='utf-8') as output:
    json.dump([os.getpid(), child.pid], output)
while True:
    ${mode === 'output limit' ? "sys.stdout.write('x' * 65537); sys.stdout.flush()" : 'pass'}
    time.sleep(0.02)
` : `
      const fs = require('node:fs');
      const { spawn } = require('node:child_process');
      process.on('SIGTERM', () => {});
      const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify([process.pid, child.pid]));
      ${mode === 'output limit' ? 'setInterval(() => process.stdout.write("x".repeat(65537)), 20);' : 'setInterval(() => {}, 1000);'}
    `)
    const pending = runRuntimeProbe(python?.executable ?? node, [script], { env, cwd, signal: controller.signal })
    // Attach immediately so a failed fixture cannot leave a rejected promise unobserved.
    const outcome = pending.then(value => ({ value }), error => ({ error }))
    let pids: number[] = []
    const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
    try {
      await expect.poll(async () => {
        try { pids = JSON.parse(await readFile(pidsFile, 'utf8')); return pids.length } catch { return 0 }
      }, { timeout: 5000 }).toBe(2)
      if (mode === 'cancel') controller.abort()
      expect(await outcome).toMatchObject(mode === 'cancel' ? { error: { name: 'AbortError' } } : { value: undefined })
      await expect.poll(() => pids.some(alive), { timeout: 3000 }).toBe(false)
    } finally {
      controller.abort()
      await outcome
      for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL')
    }
  })

  it('keeps discovery outside the pending tool effect and managed execution', async () => {
    const arm = vi.fn()
    const markRunning = vi.fn()
    const markLocalCommit = vi.fn()
    const control = { signal: new AbortController().signal, markRunning, markLocalCommit } as unknown as ManagedCallControl
    const result = await runWithCurrentAgentToolEffect({ arm }, () => withToolExecution(control, true, () =>
      runRuntimeProbe(node, ['-e', 'console.log("probe")'], { env })))
    expect(result).toBe('probe\n')
    expect(arm).not.toHaveBeenCalled()
    expect(markRunning).not.toHaveBeenCalled()
    expect(markLocalCommit).not.toHaveBeenCalled()
  })
})
