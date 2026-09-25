import { spawn } from 'node:child_process'
import { userInfo } from 'node:os'
import { runtimeLog } from './runtimeLogger'

const shellEnvTimeoutMs = 5000
const maxShellEnvOutputBytes = 1024 * 1024
const envStartMarker = '__ANAS_ENV_START__'
const envEndMarker = '__ANAS_ENV_END__'

const protectedEnvKeys = new Set([
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_RENDERER_URL',
  'NODE_ENV',
  'NODE_ENV_ELECTRON_VITE',
  'npm_node_execpath'
])

const ignoredShellEnvKeys = new Set([
  '_',
  'OLDPWD',
  'PWD',
  'SHLVL'
])

function userShellPath(): string | undefined {
  if (process.platform === 'win32') return undefined
  return process.env.SHELL || userInfo().shell || undefined
}

function baseShellEnv(shell: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: process.env.HOME,
    LANG: process.env.LANG,
    LOGNAME: process.env.LOGNAME || process.env.USER,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    SHELL: shell,
    TMPDIR: process.env.TMPDIR,
    USER: process.env.USER
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key === 'LC_ALL' || key.startsWith('LC_')) env[key] = value
  }
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

function parseNullSeparatedEnv(output: Buffer): Record<string, string> {
  const parts = output.toString('utf8').split('\0')
  const start = parts.indexOf(envStartMarker)
  const end = parts.indexOf(envEndMarker)
  if (start < 0 || end <= start) throw new Error('User shell environment markers were not found.')

  const env: Record<string, string> = {}
  for (const entry of parts.slice(start + 1, end)) {
    const index = entry.indexOf('=')
    if (index <= 0) continue
    const key = entry.slice(0, index)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    env[key] = entry.slice(index + 1)
  }
  return env
}

function readUserShellEnvironment(shell: string): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let outputBytes = 0
    let stderr = ''
    let settled = false
    const command = `/usr/bin/printf '%s\\0' ${envStartMarker}; /usr/bin/env -0; /usr/bin/printf '%s\\0' ${envEndMarker}`
    const child = spawn(shell, ['-i', '-l', '-c', command], {
      env: baseShellEnv(shell),
      shell: false,
      windowsHide: true
    })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGTERM')
      reject(new Error('Reading user shell environment timed out.'))
    }, shellEnvTimeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      if (outputBytes >= maxShellEnvOutputBytes) return
      const remaining = maxShellEnvOutputBytes - outputBytes
      chunks.push(chunk.length > remaining ? chunk.subarray(0, remaining) : chunk)
      outputBytes += Math.min(chunk.length, remaining)
    })

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 4000) stderr += chunk.toString('utf8')
    })

    child.on('error', (reason) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(reason)
    })

    child.on('close', (exitCode) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (exitCode !== 0) {
        reject(new Error(stderr.trim() || `User shell exited with code ${exitCode}.`))
        return
      }
      try {
        resolve(parseNullSeparatedEnv(Buffer.concat(chunks)))
      } catch (reason) {
        reject(reason)
      }
    })
  })
}

function applyUserShellEnvironment(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    if (ignoredShellEnvKeys.has(key)) continue
    if (protectedEnvKeys.has(key) && process.env[key] !== undefined) continue
    process.env[key] = value
  }
}

export async function initializeUserShellEnvironment(): Promise<void> {
  const shell = userShellPath()
  if (!shell) return

  try {
    const env = await readUserShellEnvironment(shell)
    applyUserShellEnvironment(env)
    runtimeLog('info', 'runtime', 'Loaded user shell environment.', {
      shell,
      path: process.env.PATH
    })
  } catch (reason) {
    runtimeLog('warn', 'runtime', 'Failed to load user shell environment.', {
      shell,
      error: reason
    })
  }
}
