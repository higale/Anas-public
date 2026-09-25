import type { McpServerConfigDetail, McpServerConfigSave, McpServerType } from '@shared/types'
import { asRecord, type RawMcpServer } from './rawAppConfig'

export interface McpServerConfig {
  index: number
  name: string
  enabled: boolean
  timeoutMs: number
  type: McpServerType
  url?: string
  apiKey?: string
  id: string
  command?: string
  args: string[]
  workingDir?: string
  env: Record<string, string>
}

const mcpServerIdPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

function normalizeMcpServerId(value: unknown): string {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!mcpServerIdPattern.test(id)) {
    throw new Error('Config value mcp_server.id must be 1-64 letters, numbers, underscores, or hyphens.')
  }
  return id
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function stringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value)
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

function normalizeMcpType(value: string | undefined, hasCommand: boolean): McpServerType {
  if (value === 'stdio' || value === 'http' || value === 'sse') return value
  return hasCommand ? 'stdio' : 'http'
}

export function normalizeMcpServer(raw: unknown, index: number): McpServerConfig {
  const server = asRecord(raw) as RawMcpServer
  const command = server.command?.trim() || undefined
  const type = normalizeMcpType(server.type?.trim(), Boolean(command))
  return {
    index,
    name: server.name?.trim() || `MCP Server ${index}`,
    enabled: server.enabled ?? false,
    timeoutMs: server.timeout_ms ?? 30000,
    type,
    url: server.url?.trim() || undefined,
    apiKey: server.api_key?.trim() || undefined,
    id: normalizeMcpServerId(server.id),
    command,
    args: stringArray(server.args),
    workingDir: server.working_dir?.trim() || undefined,
    env: stringRecord(server.env)
  }
}

export function mcpServerConfigDetail(raw: unknown, index: number): McpServerConfigDetail {
  const server = normalizeMcpServer(raw, index)
  return {
    index: server.index,
    name: server.name,
    enabled: server.enabled,
    type: server.type,
    url: server.url ?? '',
    id: server.id,
    command: server.command ?? '',
    args: server.args,
    workingDir: server.workingDir ?? '',
    timeoutMs: server.timeoutMs,
    apiKey: server.apiKey,
    env: server.env
  }
}

export function rawMcpServerFromSave(server: McpServerConfigSave, existing?: RawMcpServer): RawMcpServer {
  const id = normalizeMcpServerId(server.id)
  const apiKey = server.apiKey === undefined
    ? existing?.api_key
    : server.apiKey === null
      ? ''
      : server.apiKey
  return {
    ...existing,
    name: server.name,
    enabled: server.enabled,
    timeout_ms: server.timeoutMs,
    type: server.type,
    url: server.type === 'stdio' ? '' : server.url ?? '',
    api_key: apiKey,
    id,
    command: server.type === 'stdio' ? server.command ?? '' : '',
    args: server.type === 'stdio' ? server.args : [],
    working_dir: server.type === 'stdio' ? server.workingDir ?? '' : '',
    env: server.type === 'stdio' ? server.env : {}
  }
}
