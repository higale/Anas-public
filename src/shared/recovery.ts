export const resettableConfigFiles = ['capabilities.json', 'settings.json', 'models.json', 'tools.json', 'mcp_servers.json', 'skills.json', 'subagents.json'] as const
export type ResettableConfigFile = typeof resettableConfigFiles[number]
export type RecoveryFile = ResettableConfigFile | 'projects.json'

export interface RecoveryFileStatus {
  name: RecoveryFile
  path: string
  error?: string
  repairableFields: string[]
}

export interface RecoverySnapshot {
  dataDir: string
  logDir: string
  catalogPath: string
  conversationsPath: string
  preservationParent: string
  startupError: string
  stopError?: string
  canModify: boolean
  files: RecoveryFileStatus[]
  lastPreservationPath?: string
}

export interface RecoveryResult {
  preservationPath: string
}

export interface RecoveryRepairResult {
  preservationPath?: string
  repaired: string[]
  unresolved: string[]
}

export interface RecoveryApi {
  enter(detail: string): Promise<void>
  inspect(): Promise<RecoverySnapshot>
  openDirectory(kind: 'data' | 'log' | 'preservation'): Promise<void>
  reset(file: ResettableConfigFile): Promise<RecoveryResult>
  resetProjects(): Promise<RecoveryResult>
  repair(file: RecoveryFile): Promise<RecoveryRepairResult>
  restart(): Promise<void>
}

export function errorDetail(reason: unknown, fallback = 'Unknown error'): string {
  const seen = new Set<unknown>()
  function describe(value: unknown, depth: number): string {
    if (depth > 5 || seen.has(value)) return ''
    seen.add(value)
    if (value instanceof Error) {
      const nested = value instanceof AggregateError ? value.errors : value.cause ? [value.cause] : []
      const details = nested.slice(0, 8).map((item) => describe(item, depth + 1))
        .filter((detail) => detail && !value.message.includes(detail))
      return [value.message, ...details].filter(Boolean).join('\n')
    }
    return typeof value === 'string' ? value : ''
  }
  return (describe(reason, 0).trim() || fallback).slice(0, 32_000)
}
