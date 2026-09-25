import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { runWithoutCurrentAgentToolEffect } from './agent/toolEffectScope'
import { withoutToolExecution } from './agent/toolExecutionContext'
import { runPreparedProcess, type ShellRunResult } from './shellRuntime'

const cacheLifetimeMs = 60_000
const maxCachedEnvironments = 32
const probeOutputLimitBytes = 64 * 1024

export interface RuntimeProbeOptions {
  env?: NodeJS.ProcessEnv
  cwd?: string
  signal?: AbortSignal
}

export type RuntimeProbeRunner = (executable: string, args: string[], options?: RuntimeProbeOptions) => Promise<string | undefined>

export const runRuntimeProbe: RuntimeProbeRunner = async (executable, args, options = {}) => {
  options.signal?.throwIfAborted()
  const outputLimit = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, outputLimit.signal]) : outputLimit.signal
  const outputBytes = { stdout: 0, stderr: 0 }
  let result: ShellRunResult | undefined
  try {
    // As with the Shell environment preflight, discovery must not arm the
    // pending business tool's effect or change its managed execution state.
    await runWithoutCurrentAgentToolEffect(() => withoutToolExecution(() => runPreparedProcess({
      command: executable,
      invocation: { executable, args, windowsHide: true },
      env: options.env && {
        ...Object.fromEntries(Object.keys(process.env).map(key => [key, undefined])),
        ...options.env
      },
      workingDir: options.cwd ?? process.cwd(),
      timeoutSec: 2.5,
      maxStdoutChars: probeOutputLimitBytes,
      logScope: 'runtime-probe',
      logResult: false,
      successMessage: 'Runtime probe completed.',
      failureMessage: 'Runtime probe failed.',
      abortBeforeStartError: 'Runtime probe cancelled before execution.',
      abortError: 'Runtime probe cancelled.',
      timeoutError: 'Runtime probe timed out.'
    }, signal, {
      onOutput: (stream, text) => {
        outputBytes[stream] += Buffer.byteLength(text, 'utf8')
        if (outputBytes[stream] > probeOutputLimitBytes) outputLimit.abort()
      },
      onResult: value => { result = value }
    })))
    options.signal?.throwIfAborted()
    if (!result?.ok || outputLimit.signal.aborted) return undefined
    return result.stdout.trim() ? result.stdout : result.stderr.trim() ? result.stderr : undefined
  } catch {
    options.signal?.throwIfAborted()
    return undefined
  }
}

export interface PythonRuntime {
  executable: string
  version: string
  command: string
}

interface PythonDiscoveryOptions extends RuntimeProbeOptions {
  platform?: NodeJS.Platform
  runProbe?: RuntimeProbeRunner
  cache?: boolean
}

// Use only the built-in sys module so a tool package's json.py cannot shadow a
// probe dependency. A successful probe proves this interpreter can run code.
const pythonIdentityCode = 'import sys; print(".".join(str(n) for n in sys.version_info[:3])); print(sys.executable)'
const pythonCache = new Map<string, { runtime: PythonRuntime; expiresAt: number }>()

export async function discoverPython3(options: PythonDiscoveryOptions = {}): Promise<PythonRuntime | undefined> {
  const platform = options.platform ?? process.platform
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
  const cwd = options.cwd ?? process.cwd()
  const signal = options.signal
  signal?.throwIfAborted()
  const key = options.cache ? createHash('sha256').update(JSON.stringify([
    platform, cwd, Object.entries(env).filter(([, value]) => value !== undefined).sort(([a], [b]) => a.localeCompare(b))
  ])).digest('hex') : undefined
  if (key) {
    const cached = pythonCache.get(key)
    if (cached && cached.expiresAt > Date.now()) {
      try {
        await access(cached.runtime.executable, constants.X_OK)
        signal?.throwIfAborted()
        return { ...cached.runtime }
      } catch { signal?.throwIfAborted() }
    }
    pythonCache.delete(key)
  }
  // Discovery must not ask the Windows Python install manager to install a runtime.
  if (platform === 'win32') env.PYTHON_MANAGER_AUTOMATIC_INSTALL = 'false'
  const candidates = platform === 'win32'
    ? [{ executable: 'python.exe', args: [], command: 'python' },
      { executable: 'py.exe', args: ['-3'], command: 'py -3' },
      { executable: 'python3.exe', args: [], command: 'python3' }]
    : [{ executable: 'python3', args: [], command: 'python3' },
      { executable: 'python', args: [], command: 'python' }]
  const runProbe = options.runProbe ?? runRuntimeProbe
  for (const candidate of candidates) {
    signal?.throwIfAborted()
    const output = await runProbe(candidate.executable, [...candidate.args, '-c', pythonIdentityCode], { env, cwd, signal })
    signal?.throwIfAborted()
    const lines = output?.split(/\r?\n/)
    if (lines?.at(-1) === '') lines.pop()
    if (!lines || lines.length !== 2) continue
    const [version, executable] = lines
    if (!/^3\.\d+\.\d+$/.test(version) || executable.includes('\0') || !(platform === 'win32' ? win32 : posix).isAbsolute(executable)) continue
    // Launch the selected interpreter itself, retaining py -3's version choice
    // without running the launcher again or resolving a bare command a second time.
    const runtime = { executable, version, command: candidate.command }
    if (key) {
      if (pythonCache.size >= maxCachedEnvironments) pythonCache.delete(pythonCache.keys().next().value!)
      pythonCache.set(key, { runtime, expiresAt: Date.now() + cacheLifetimeMs })
    }
    return { ...runtime }
  }
  return undefined
}
