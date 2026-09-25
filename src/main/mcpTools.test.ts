import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { McpServerConfig } from './config/appConfig'
import { createMcpClientForServer, mcpConnectionSnapshotForServer, mcpErrorMessage } from './mcpTools'

const stdioServer: McpServerConfig = {
  index: 0,
  name: 'Alpha',
  enabled: true,
  timeoutMs: 1000,
  type: 'stdio',
  id: 'alpha',
  command: 'alpha-server',
  args: ['--serve'],
  workingDir: 'D:/workspace',
  env: {}
}

describe('MCP connection snapshots', () => {
  it.each(['http', 'sse'] as const)('preserves explicit %s transport and disables automatic SSE fallback', (type) => {
    const snapshot = mcpConnectionSnapshotForServer({
      ...stdioServer,
      type,
      command: undefined,
      url: 'https://example.test/mcp'
    })

    expect(snapshot?.connection).toMatchObject({ transport: type, automaticSSEFallback: false })
    expect(snapshot?.identity.transport).toBe(type)
    expect(mcpConnectionSnapshotForServer(stdioServer)?.connection).not.toHaveProperty('automaticSSEFallback')
  })

  it('reports HTTP initialization failure without opening a legacy SSE connection', async () => {
    const methods: Array<string | undefined> = []
    const server = createServer((request, response) => {
      methods.push(request.method)
      response.writeHead(405).end('Method not allowed')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test server address')
    const errors: string[] = []
    const { client } = createMcpClientForServer({
      ...stdioServer,
      type: 'http',
      command: undefined,
      url: `http://127.0.0.1:${address.port}/sse`
    }, {
      onConnectionError: ({ error }) => { errors.push(String(error)) }
    })

    try {
      expect(await client.getTools()).toEqual([])
      expect(errors).toHaveLength(1)
      expect(errors[0]).toContain('Method not allowed')
      expect(methods).toEqual(['POST'])
    } finally {
      await client.close()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('removes the configured credential from error messages and causes', () => {
    const credential = 'mcp-secret-canary'
    const error = new Error(`Request rejected for Bearer ${credential}`, {
      cause: `remote response included ${credential}`
    })

    const message = mcpErrorMessage(error, credential)
    expect(message).not.toContain(credential)
    expect(message).toBe('Request rejected for Bearer [credential] Cause: remote response included [credential]')
  })

  it('derives a secret-safe identity from the same effective stdio environment passed to the client', () => {
    const inheritedEnvKey = 'ANAS_MCP_SNAPSHOT_TEST'
    const previousValue = process.env[inheritedEnvKey]
    try {
      process.env[inheritedEnvKey] = 'first-secret-value'
      const first = mcpConnectionSnapshotForServer(stdioServer)
      expect(first).toBeDefined()
      expect((first?.connection as { env?: Record<string, string> }).env?.[inheritedEnvKey])
        .toBe('first-secret-value')
      expect(JSON.stringify(first?.identity)).not.toContain('first-secret-value')

      process.env[inheritedEnvKey] = 'second-secret-value'
      const second = mcpConnectionSnapshotForServer(stdioServer)
      expect(second).toBeDefined()
      expect(first?.identity.fingerprint).not.toBe(second?.identity.fingerprint)
      expect(first?.identity.endpoint).toEqual({
        command: 'alpha-server',
        argumentCount: 1,
        workingDirectory: 'D:/workspace'
      })
    } finally {
      if (previousValue === undefined) delete process.env[inheritedEnvKey]
      else process.env[inheritedEnvKey] = previousValue
    }
  })

  it('includes the actual remote authorization header in the fingerprint without exposing it', () => {
    const first = mcpConnectionSnapshotForServer({
      ...stdioServer,
      type: 'http',
      command: undefined,
      url: 'https://example.test/mcp',
      apiKey: 'first-api-key'
    })
    const second = mcpConnectionSnapshotForServer({
      ...stdioServer,
      type: 'http',
      command: undefined,
      url: 'https://example.test/mcp',
      apiKey: 'second-api-key'
    })

    expect((first?.connection as { headers?: Record<string, string> }).headers?.Authorization)
      .toBe('Bearer first-api-key')
    expect(first?.identity.fingerprint).not.toBe(second?.identity.fingerprint)
    expect(JSON.stringify(first?.identity)).not.toContain('first-api-key')
    expect(JSON.stringify(second?.identity)).not.toContain('second-api-key')
  })

  it('keeps stdio arguments and remote URL credentials out of the display endpoint', () => {
    const stdioSecret = 'stdio-secret-canary'
    const stdio = mcpConnectionSnapshotForServer({
      ...stdioServer,
      args: ['--token', stdioSecret]
    })
    const changedStdio = mcpConnectionSnapshotForServer({
      ...stdioServer,
      args: ['--token', 'different-secret']
    })
    expect((stdio?.connection as { args?: string[] }).args).toContain(stdioSecret)
    expect(JSON.stringify(stdio?.identity)).not.toContain(stdioSecret)
    expect(stdio?.identity.endpoint).toEqual({
      command: 'alpha-server',
      argumentCount: 2,
      workingDirectory: 'D:/workspace'
    })
    expect(stdio?.identity.fingerprint).not.toBe(changedStdio?.identity.fingerprint)

    const remoteSecret = 'remote-secret-canary'
    const remote = mcpConnectionSnapshotForServer({
      ...stdioServer,
      type: 'http',
      command: undefined,
      url: `https://user:${remoteSecret}@example.test/hooks/${remoteSecret}/mcp?token=${remoteSecret}`
    })
    const changedRemote = mcpConnectionSnapshotForServer({
      ...stdioServer,
      type: 'http',
      command: undefined,
      url: 'https://user:different-secret@example.test/hooks/different-secret/mcp?token=different-secret'
    })
    expect((remote?.connection as { url?: string }).url).toContain(remoteSecret)
    expect(JSON.stringify(remote?.identity)).not.toContain(remoteSecret)
    expect(remote?.identity.endpoint).toEqual({
      origin: 'https://example.test',
      pathSegmentCount: 3
    })
    expect(remote?.identity.fingerprint).not.toBe(changedRemote?.identity.fingerprint)
  })

  it('binds the effective tool timeout into the connection fingerprint', () => {
    const first = mcpConnectionSnapshotForServer(stdioServer)
    const second = mcpConnectionSnapshotForServer({
      ...stdioServer,
      timeoutMs: stdioServer.timeoutMs + 1
    })

    expect(first?.identity.endpoint).toEqual(second?.identity.endpoint)
    expect(first?.identity.fingerprint).not.toBe(second?.identity.fingerprint)
  })
})
