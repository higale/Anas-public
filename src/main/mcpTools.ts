import { MultiServerMCPClient, type ClientConfig, type Connection } from '@langchain/mcp-adapters'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { createHash } from 'node:crypto'
import { processEnvironment } from './config/apiKeys'
import type { McpServerConfig } from './config/appConfig'
import type { McpServerType } from '@shared/types'

export interface McpToolLoadResult {
  tools: StructuredToolInterface[]
  loaded: Array<{ id: string; index: number; name: string; toolCount: number; toolNames: string[] }>
  errors: Array<{ id: string; index: number; name: string; error: string }>
  ping(): Promise<void>
  close(): Promise<void>
}

export type McpConnectionEndpoint = Readonly<{
  command: string
  argumentCount: number
  workingDirectory?: string
} | {
  origin: string
  pathSegmentCount: number
}>

export interface McpConnectionIdentity {
  readonly transport: McpServerType
  readonly endpoint: McpConnectionEndpoint
  readonly fingerprint: string
}

export interface McpConnectionSnapshot {
  readonly connection: Connection
  readonly identity: McpConnectionIdentity
}

export interface McpClientForServer {
  readonly client: MultiServerMCPClient
  readonly connectionIdentity: McpConnectionIdentity
}

type McpClientHooks = Partial<Pick<
  ClientConfig,
  'afterToolCall' | 'beforeToolCall' | 'onConnectionError' | 'onMessage' | 'onProgress' | 'onToolsListChanged'
>>

const stdioMcpRestart = {
  enabled: true,
  maxAttempts: 3,
  delayMs: 1000
}

const remoteMcpReconnect = {
  enabled: true,
  maxAttempts: 5,
  delayMs: 2000
}

function processEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(processEnvironment(true)).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

function authHeaders(apiKey?: string): Record<string, string> | undefined {
  if (!apiKey) return undefined
  return {
    Authorization: `Bearer ${apiKey}`
  }
}

function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    return Object.fromEntries(Object.entries(item as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
  })
  if (serialized === undefined) throw new Error('MCP connection identity cannot be serialized.')
  return serialized
}

function connectionFingerprint(value: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')
}

export function mcpErrorMessage(error: unknown, credential?: string): string {
  let message: string
  if (error instanceof Error) {
    const detail = 'cause' in error && error.cause ? ` Cause: ${String(error.cause)}` : ''
    message = `${error.message}${detail}`
  } else if (typeof error === 'string') {
    message = error
  } else {
    try {
      message = JSON.stringify(error)
    } catch {
      message = String(error)
    }
  }
  return credential ? message.replaceAll(credential, '[credential]') : message
}

export function mcpConnectionSnapshotForServer(server: McpServerConfig): McpConnectionSnapshot | undefined {
  if (server.type === 'stdio') {
    if (!server.command) return undefined
    const connection = {
      transport: 'stdio',
      command: server.command,
      args: [...server.args],
      cwd: server.workingDir,
      env: {
        ...processEnv(),
        ...server.env
      },
      stderr: 'inherit',
      restart: stdioMcpRestart,
      defaultToolTimeout: server.timeoutMs
    } satisfies Connection
    const endpoint = Object.freeze({
      command: connection.command,
      argumentCount: connection.args.length,
      ...(connection.cwd ? { workingDirectory: connection.cwd } : {})
    })
    return Object.freeze({
      connection,
      identity: Object.freeze({
        transport: 'stdio',
        endpoint,
        fingerprint: connectionFingerprint({
          transport: connection.transport,
          command: connection.command,
          arguments: connection.args,
          workingDirectory: connection.cwd,
          environment: connection.env,
          defaultToolTimeout: connection.defaultToolTimeout
        })
      })
    })
  }

  if (!server.url) return undefined
  const connection = {
    transport: server.type,
    automaticSSEFallback: false,
    url: server.url,
    headers: authHeaders(server.apiKey),
    reconnect: remoteMcpReconnect,
    defaultToolTimeout: server.timeoutMs
  } satisfies Connection
  let endpoint: McpConnectionEndpoint
  try {
    const parsed = new URL(connection.url)
    endpoint = Object.freeze({
      origin: parsed.origin,
      pathSegmentCount: parsed.pathname.split('/').filter(Boolean).length
    })
  } catch {
    endpoint = Object.freeze({
      origin: 'configured remote endpoint',
      pathSegmentCount: 0
    })
  }
  return Object.freeze({
    connection,
    identity: Object.freeze({
      transport: server.type,
      endpoint,
      fingerprint: connectionFingerprint({
        transport: connection.transport,
        automaticSSEFallback: connection.automaticSSEFallback,
        url: connection.url,
        headers: connection.headers ?? {},
        defaultToolTimeout: connection.defaultToolTimeout
      })
    })
  })
}

export function createMcpClientForServer(server: McpServerConfig, hooks: McpClientHooks = {}): McpClientForServer {
  const snapshot = mcpConnectionSnapshotForServer(server)
  if (!snapshot) {
    throw new Error(server.type === 'stdio' ? 'Missing command.' : 'Missing URL.')
  }

  return Object.freeze({
    client: new MultiServerMCPClient({
      mcpServers: {
        [server.id]: snapshot.connection
      },
      throwOnLoadError: false,
      prefixToolNameWithServerName: true,
      additionalToolNamePrefix: 'mcp',
      useStandardContentBlocks: true,
      ...hooks
    }),
    connectionIdentity: snapshot.identity
  })
}
