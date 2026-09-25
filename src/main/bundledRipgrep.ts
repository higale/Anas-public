import { dirname, delimiter, sep } from 'node:path'

export async function bundledRipgrepPath(): Promise<string> {
  const { rgPath } = await import('@vscode/ripgrep')
  return rgPath.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`)
}

export function withExecutableDirectory(env: NodeJS.ProcessEnv, directory: string): NodeJS.ProcessEnv {
  const result = { ...env }
  // Match child_process on Windows: the first lexicographically sorted key
  // wins case-insensitively, including an intentionally empty PATH.
  const keys = Object.keys(result).filter((key) => process.platform === 'win32' ? key.toLowerCase() === 'path' : key === 'PATH').sort()
  const previous = keys.length ? result[keys[0]] ?? '' : ''
  for (const key of keys) delete result[key]
  result.PATH = [directory, previous].filter(Boolean).join(delimiter)
  return result
}

export async function bundledSearchEnvironment(env: NodeJS.ProcessEnv) {
  const executable = await bundledRipgrepPath()
  return { executable, directory: dirname(executable), env: withExecutableDirectory(env, dirname(executable)) }
}
