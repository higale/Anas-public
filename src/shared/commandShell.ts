export const commandShellCapabilityId = 'run_shell'
export const commandShellToolKind = 'command_shell'
// Positive deadlines must fit the process supervisor's millisecond timer.
export const maxCommandTimeoutSeconds = Math.floor(2_147_483_647 / 1000)
const maxCommandShellToolNameLength = 64

const commandShellNames = new Set([
  'bash',
  'csh',
  'dash',
  'fish',
  'ksh',
  'nu',
  'powershell',
  'pwsh',
  'sh',
  'tcsh',
  'zsh'
])

function executableBasename(executable: string): string {
  return executable.replaceAll('\\', '/').split('/').at(-1) ?? ''
}

export function commandShellToolName(executable: string): string {
  const basename = executableBasename(executable)
    .toLowerCase()
    .replace(/\.exe$/i, '')
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (commandShellNames.has(basename)) return basename
  const prefix = 'shell_'
  const suffix = (basename || 'command').slice(0, maxCommandShellToolNameLength - prefix.length)
  return `${prefix}${suffix}`
}

export function isCommandShellToolName(name: string): boolean {
  return commandShellNames.has(name.toLowerCase()) || /^shell_[a-z0-9_-]+$/i.test(name)
}

export function commandShellMetadata(): Record<string, string> {
  return {
    anasCapabilityId: commandShellCapabilityId,
    anasToolKind: commandShellToolKind
  }
}

export function isCommandShellMetadata(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const metadata = value as Record<string, unknown>
  return metadata.anasCapabilityId === commandShellCapabilityId
    && metadata.anasToolKind === commandShellToolKind
}
