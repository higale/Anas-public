import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpRuntimeConfigSnapshot, McpServerConfig } from './config/appConfig'

const server: McpServerConfig = {
  index: 0,
  name: 'Alpha',
  enabled: true,
  timeoutMs: 1000,
  type: 'stdio',
  id: 'alpha',
  command: 'alpha-server',
  args: [],
  env: {}
}

const mcpTool = {
  name: 'mcp_alpha_ping',
  description: 'Ping Alpha.',
  schema: { type: 'object', properties: {} },
  invoke: vi.fn(async () => 'pong')
}

type McpRuntimeService = typeof import('./mcpRuntimeService')

interface Harness {
  clients: Array<{
    close: ReturnType<typeof vi.fn>
    getClient: ReturnType<typeof vi.fn>
    initializeConnections: ReturnType<typeof vi.fn>
  }>
  closeClient: ReturnType<typeof vi.fn>
  createClient: ReturnType<typeof vi.fn>
  getClient: ReturnType<typeof vi.fn>
  initializeConnections: ReturnType<typeof vi.fn>
  runtimeLog: ReturnType<typeof vi.fn>
  service: McpRuntimeService
  toolEffectScope: typeof import('./agent/toolEffectScope')
  setConfig(config: McpRuntimeConfigSnapshot): void
}

let activeService: McpRuntimeService | undefined

async function loadHarness(
  initialize?: () => Promise<Record<string, unknown[]>>,
  getClientImplementation?: () => Promise<{ ping(input: { timeout: number }): Promise<void> } | undefined>
): Promise<Harness> {
  vi.resetModules()
  let config: McpRuntimeConfigSnapshot = { enabled: true, servers: [server] }
  const initializeConnections = vi.fn(initialize ?? (async () => ({ alpha: [mcpTool] })))
  const closeClient = vi.fn(async () => {})
  const getClient = vi.fn(getClientImplementation ?? (async () => ({ ping: vi.fn(async () => {}) })))
  const clients: Harness['clients'] = []
  let connectionSnapshotForServer: typeof import('./mcpTools').mcpConnectionSnapshotForServer | undefined
  const createClient = vi.fn((clientServer: McpServerConfig, _hooks: unknown) => {
    const snapshot = connectionSnapshotForServer?.(clientServer)
    if (!snapshot) throw new Error('Missing MCP connection in test harness.')
    const client = {
      close: vi.fn(() => closeClient()),
      getClient,
      initializeConnections
    }
    clients.push(client)
    return {
      client,
      connectionIdentity: snapshot.identity
    }
  })
  const runtimeLog = vi.fn()

  vi.doMock('electron', () => ({
    app: undefined,
    BrowserWindow: { getAllWindows: () => [] }
  }))
  vi.doMock('./config/appConfig', () => ({
    getMcpRuntimeConfigSnapshot: vi.fn(async () => config)
  }))
  vi.doMock('./mcpTools', async () => {
    const actual = await vi.importActual<typeof import('./mcpTools')>('./mcpTools')
    connectionSnapshotForServer = actual.mcpConnectionSnapshotForServer
    return {
      ...actual,
      createMcpClientForServer: createClient,
      mcpErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error)
    }
  })
  vi.doMock('./runtimeLogger', () => ({
    runtimeChannelLog: vi.fn(),
    runtimeLog
  }))

  const service = await import('./mcpRuntimeService')
  const toolEffectScope = await import('./agent/toolEffectScope')
  activeService = service
  return {
    clients,
    closeClient,
    createClient,
    getClient,
    initializeConnections,
    runtimeLog,
    service,
    toolEffectScope,
    setConfig(nextConfig) {
      config = nextConfig
    }
  }
}

afterEach(async () => {
  await activeService?.closeCachedMcpRuntime()
  activeService = undefined
  vi.doUnmock('electron')
  vi.doUnmock('./config/appConfig')
  vi.doUnmock('./mcpTools')
  vi.doUnmock('./runtimeLogger')
  vi.resetModules()
})

describe('MCP runtime lifecycle', () => {
  it('routes equal-argument progress to the invocation that owns the exact args object', async () => {
    const harness = await loadHarness()
    await harness.service.getCachedMcpRuntime()
    const { withToolExecution } = await import('./agent/toolExecutionContext')
    const hooks = harness.createClient.mock.calls[0][1] as {
      beforeToolCall(info: { name: string; args: object }): void
      afterToolCall(info: { name: string; args: object }): void
      onProgress(progress: { progress: number; total?: number; message?: string }, source: { type: string; name: string; args: object }): void
    }
    const control = () => ({ signal: new AbortController().signal, markRunning: vi.fn(), markLocalCommit: vi.fn(), markUncertain: vi.fn(),
      progress: vi.fn(), output: vi.fn(), setOutcome: vi.fn() })
    const a = control()
    const b = control()
    const argsA = { query: 'same' }
    const argsB = { query: 'same' }
    withToolExecution(a, false, () => hooks.beforeToolCall({ name: 'search', args: argsA }))
    withToolExecution(b, false, () => hooks.beforeToolCall({ name: 'search', args: argsB }))
    hooks.onProgress({ progress: 0.5, total: 2, message: 'second' }, { type: 'tool', name: 'search', args: argsB })
    expect(a.progress).not.toHaveBeenCalled()
    expect(b.progress).toHaveBeenCalledWith(0.5, 'mcp', 2)
    expect(b.output).toHaveBeenCalledWith('progress', 'second\n')
    hooks.afterToolCall({ name: 'search', args: argsB })
    hooks.onProgress({ progress: 1 }, { type: 'tool', name: 'search', args: argsB })
    expect(b.progress).toHaveBeenCalledOnce()
  })

  it('distinguishes a confirmed MCP isError result from a transport failure', async () => {
    const harness = await loadHarness()
    const runtime = await harness.service.getCachedMcpRuntime()
    const { withToolExecution } = await import('./agent/toolExecutionContext')
    const control = { signal: new AbortController().signal, markRunning: vi.fn(), markLocalCommit: vi.fn(), markUncertain: vi.fn(),
      progress: vi.fn(), output: vi.fn(), setOutcome: vi.fn() }
    const error = new Error("MCP tool 'ping' on server 'alpha' returned an error: unavailable")
    error.name = 'ToolException'
    mcpTool.invoke.mockRejectedValueOnce(error)
    await expect(withToolExecution(control, false, () => runtime.tools[0].invoke({}))).rejects.toThrow('unavailable')
    expect(control.setOutcome).toHaveBeenCalledWith({ remote_failure_confirmed: true })
    expect(harness.closeClient).not.toHaveBeenCalled()
  })

  it('does not reconnect for a normal tool error on a healthy connection', async () => {
    const harness = await loadHarness()
    const runtime = await harness.service.getCachedMcpRuntime()
    mcpTool.invoke.mockRejectedValueOnce(new Error('application error'))
    await expect(runtime.tools[0].invoke({})).rejects.toThrow('application error')
    await harness.service.getCachedMcpRuntime()
    expect(harness.service.getCachedMcpStatus()?.servers[0].state).toBe('ready')
    expect(harness.closeClient).not.toHaveBeenCalled()
    expect(harness.clients).toHaveLength(1)
  })

  it('does not probe a busy connection or reconnect when its tool is cancelled', async () => {
    const harness = await loadHarness()
    const runtime = await harness.service.getCachedMcpRuntime()
    let finish!: (value: string) => void
    const done = new Promise<string>((resolve) => { finish = resolve })
    mcpTool.invoke.mockImplementationOnce(() => done)
    const active = runtime.tools[0].invoke({})
    await runtime.ping()
    expect(harness.getClient).not.toHaveBeenCalled()
    expect(harness.closeClient).not.toHaveBeenCalled()
    finish('done')
    await active
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    mcpTool.invoke.mockRejectedValueOnce(controller.signal.reason)
    await expect(runtime.tools[0].invoke({}, { signal: controller.signal })).rejects.toThrow('cancelled')
    expect(harness.getClient).not.toHaveBeenCalled()
    expect(harness.closeClient).not.toHaveBeenCalled()
  })

  it('defers tools-list refresh until every active invocation has settled', async () => {
    vi.useFakeTimers()
    try {
      const harness = await loadHarness()
      const runtime = await harness.service.getCachedMcpRuntime()
      const hooks = harness.createClient.mock.calls[0][1] as { onToolsListChanged(): void }
      let finish!: (value: string) => void
      const done = new Promise<string>((resolve) => { finish = resolve })
      mcpTool.invoke.mockImplementationOnce(() => done)
      const active = runtime.tools[0].invoke({})
      hooks.onToolsListChanged()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(harness.clients).toHaveLength(1)
      expect(harness.closeClient).not.toHaveBeenCalled()
      finish('done')
      await active
      await vi.advanceTimersByTimeAsync(1)
      expect(harness.clients).toHaveLength(2)
    } finally { vi.useRealTimers() }
  })

  it('does not degrade a connection when a tool starts while an earlier ping is pending', async () => {
    vi.useFakeTimers()
    let finish!: (value: string) => void
    try {
      let rejectPing!: (reason: Error) => void
      const ping = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectPing = reject }))
      const harness = await loadHarness(undefined, async () => ({ ping }))
      const runtime = await harness.service.getCachedMcpRuntime()
      const probing = runtime.ping()
      await vi.advanceTimersByTimeAsync(0)
      expect(ping).toHaveBeenCalledOnce()

      mcpTool.invoke.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve }))
      const active = runtime.tools[0].invoke({})
      rejectPing(new Error('Ping timed out while a tool was running'))
      await probing
      await vi.advanceTimersByTimeAsync(10_000)
      expect(harness.service.getCachedMcpStatus()?.servers[0].state).toBe('ready')
      expect(harness.closeClient).not.toHaveBeenCalled()

      finish('done')
      await active
      ping.mockImplementationOnce(async () => {})
      await runtime.ping()
      expect(harness.clients).toHaveLength(1)
    } finally {
      finish?.('done')
      vi.useRealTimers()
    }
  })

  it('defers a scheduled health recovery if a tool starts before its timer fires', async () => {
    vi.useFakeTimers()
    let finish!: (value: string) => void
    try {
      const ping = vi.fn(async () => { throw new Error('Temporary ping failure') })
      const harness = await loadHarness(undefined, async () => ({ ping }))
      const runtime = await harness.service.getCachedMcpRuntime()
      await runtime.ping()
      expect(harness.service.getCachedMcpStatus()?.servers[0].state).toBe('degraded')

      mcpTool.invoke.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve }))
      const active = runtime.tools[0].invoke({})
      await vi.advanceTimersByTimeAsync(10_000)
      expect(harness.closeClient).not.toHaveBeenCalled()
      expect(harness.clients).toHaveLength(1)

      finish('done')
      await active
      await vi.advanceTimersByTimeAsync(1)
      expect(harness.clients).toHaveLength(2)
      expect(harness.closeClient).toHaveBeenCalledOnce()
    } finally {
      finish?.('done')
      vi.useRealTimers()
    }
  })

  it('still closes an explicitly disabled server while automatic recovery is waiting for a call', async () => {
    vi.useFakeTimers()
    let finish!: (value: string) => void
    try {
      const harness = await loadHarness()
      const runtime = await harness.service.getCachedMcpRuntime()
      const hooks = harness.createClient.mock.calls[0][1] as { onToolsListChanged(): void }
      mcpTool.invoke.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve }))
      const active = runtime.tools[0].invoke({})
      hooks.onToolsListChanged()

      harness.setConfig({ enabled: false, servers: [] })
      await harness.service.loadMcpRuntimeForCurrentConfig(false)
      expect(harness.closeClient).toHaveBeenCalledOnce()
      finish('done')
      await active
      await vi.advanceTimersByTimeAsync(10_000)
      expect(harness.clients).toHaveLength(1)
    } finally {
      finish?.('done')
      vi.useRealTimers()
    }
  })

  it('does not create clients when either master switch is disabled', async () => {
    const harness = await loadHarness()
    harness.setConfig({ enabled: false, servers: [] })

    const runtime = await harness.service.getCachedMcpRuntime()

    expect(runtime.tools).toEqual([])
    expect(runtime.loaded).toEqual([])
    expect(harness.createClient).not.toHaveBeenCalled()
    expect(harness.service.getCachedMcpStatus()?.servers).toEqual([])
  })

  it('does not repeat logs for an unchanged empty status', async () => {
    const harness = await loadHarness()
    harness.setConfig({ enabled: true, servers: [] })

    await harness.service.loadMcpRuntimeForCurrentConfig(false)
    await harness.service.loadMcpRuntimeForCurrentConfig(false)

    expect(harness.runtimeLog).toHaveBeenCalledTimes(1)
    expect(harness.runtimeLog).toHaveBeenCalledWith(
      'info',
      'mcp',
      'MCP runtime status updated.',
      { servers: [], toolCount: 0 }
    )
  })

  it('loads tools from the current atomic configuration snapshot', async () => {
    const harness = await loadHarness()

    const runtime = await harness.service.getCachedMcpRuntime()

    expect(runtime.errors).toEqual([])
    expect(runtime.tools.map((tool) => tool.name)).toEqual(['mcp_alpha_ping'])
    expect(runtime.loaded).toEqual([expect.objectContaining({ id: 'alpha', toolCount: 1 })])
    expect(harness.createClient).toHaveBeenCalledTimes(1)
    expect(harness.initializeConnections).toHaveBeenCalledTimes(1)
  })

  it('arms the journal from the MCP hook immediately before a remote tool call', async () => {
    const harness = await loadHarness()
    await harness.service.getCachedMcpRuntime()
    const hooks = harness.createClient.mock.calls[0]?.[1] as {
      beforeToolCall(input: { name: string; args: Record<string, unknown> }): void
    }
    const effects: import('./agent/toolEffectScope').AgentToolEffectArm[] = []

    harness.toolEffectScope.runWithCurrentAgentToolEffect({
      arm: (effect) => effects.push(effect)
    }, () => hooks.beforeToolCall({
      name: 'publish',
      args: { target: 'release' }
    }))

    expect(effects).toEqual([expect.objectContaining({
      kind: 'mcp_tool_call',
      target: expect.objectContaining({
        serverId: 'alpha',
        serverName: 'Alpha',
        transport: 'stdio',
        connectionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        tool: 'publish',
        arguments: { target: 'release' }
      })
    })])

    await harness.service.closeCachedMcpRuntime()
    expect(() => hooks.beforeToolCall({
      name: 'publish',
      args: { target: 'release' }
    })).toThrow('runtime changed before tool publish could start')
    expect(effects).toHaveLength(1)
  })

  it('changes the durable MCP target identity when the configured endpoint changes', async () => {
    const harness = await loadHarness()
    const effects: import('./agent/toolEffectScope').AgentToolEffectArm[] = []
    const invokeHook = (callIndex: number): void => {
      const hooks = harness.createClient.mock.calls[callIndex]?.[1] as {
        beforeToolCall(input: { name: string; args: Record<string, unknown> }): void
      }
      harness.toolEffectScope.runWithCurrentAgentToolEffect({
        arm: (effect) => effects.push(effect)
      }, () => hooks.beforeToolCall({
        name: 'publish',
        args: { target: 'release' }
      }))
    }

    harness.setConfig({
      enabled: true,
      servers: [{
        ...server,
        type: 'http',
        command: undefined,
        url: 'https://first.example.test/mcp'
      }]
    })
    await harness.service.loadMcpRuntimeForCurrentConfig(false)
    invokeHook(0)

    harness.setConfig({
      enabled: true,
      servers: [{
        ...server,
        type: 'http',
        command: undefined,
        url: 'https://second.example.test/mcp'
      }]
    })
    await harness.service.loadMcpRuntimeForCurrentConfig(false)
    invokeHook(1)

    expect(effects).toHaveLength(2)
    expect(effects[0].target).toMatchObject({
      endpoint: { origin: 'https://first.example.test', pathSegmentCount: 1 }
    })
    expect(effects[1].target).toMatchObject({
      endpoint: { origin: 'https://second.example.test', pathSegmentCount: 1 }
    })
    expect((effects[0].target as { connectionFingerprint: string }).connectionFingerprint)
      .not.toBe((effects[1].target as { connectionFingerprint: string }).connectionFingerprint)
  })

  it('freezes the effective connection identity and rejects a stale hook after inherited environment drift', async () => {
    const inheritedEnvKey = 'ANAS_MCP_EFFECT_IDENTITY_TEST'
    const previousValue = process.env[inheritedEnvKey]
    try {
      process.env[inheritedEnvKey] = 'first-runtime'
      const harness = await loadHarness()
      const effects: import('./agent/toolEffectScope').AgentToolEffectArm[] = []
      const invokeHook = (hook: { beforeToolCall(input: { name: string; args: Record<string, unknown> }): void }): void => {
        harness.toolEffectScope.runWithCurrentAgentToolEffect({
          arm: (effect) => effects.push(effect)
        }, () => hook.beforeToolCall({
          name: 'publish',
          args: { target: 'release' }
        }))
      }

      await harness.service.getCachedMcpRuntime()
      const firstHooks = harness.createClient.mock.calls[0]?.[1] as {
        beforeToolCall(input: { name: string; args: Record<string, unknown> }): void
      }
      invokeHook(firstHooks)

      process.env[inheritedEnvKey] = 'second-runtime'
      await harness.service.loadMcpRuntimeForCurrentConfig(true)
      const secondHooks = harness.createClient.mock.calls[1]?.[1] as {
        beforeToolCall(input: { name: string; args: Record<string, unknown> }): void
      }

      expect(() => invokeHook(firstHooks)).toThrow('runtime changed before tool publish could start')
      expect(effects).toHaveLength(1)
      invokeHook(secondHooks)

      expect(effects).toHaveLength(2)
      expect((effects[0].target as { connectionFingerprint: string }).connectionFingerprint)
        .not.toBe((effects[1].target as { connectionFingerprint: string }).connectionFingerprint)
    } finally {
      if (previousValue === undefined) delete process.env[inheritedEnvKey]
      else process.env[inheritedEnvKey] = previousValue
    }
  })

  it('reconciles an unchanged configuration without restarting its client', async () => {
    const harness = await loadHarness()

    await harness.service.getCachedMcpRuntime()
    await harness.service.loadMcpRuntimeForCurrentConfig(false)

    expect(harness.createClient).toHaveBeenCalledTimes(1)
    expect(harness.initializeConnections).toHaveBeenCalledTimes(1)
  })

  it('lets a disable operation supersede an in-flight connection start', async () => {
    let resolveInitialization: ((value: Record<string, unknown[]>) => void) | undefined
    const initialization = new Promise<Record<string, unknown[]>>((resolve) => {
      resolveInitialization = resolve
    })
    const harness = await loadHarness(() => initialization)

    const loading = harness.service.getCachedMcpRuntime()
    await vi.waitFor(() => expect(harness.initializeConnections).toHaveBeenCalledTimes(1))

    try {
      harness.setConfig({ enabled: false, servers: [] })
      const disabling = harness.service.loadMcpRuntimeForCurrentConfig(false)
      let disabled = false
      void disabling.then(() => { disabled = true })
      await vi.waitFor(() => expect(harness.closeClient).toHaveBeenCalled())
      expect(disabled).toBe(false)

      resolveInitialization?.({ alpha: [mcpTool] })
      const disabledStatus = await disabling
      const runtime = await loading

      expect(disabledStatus.servers).toEqual([])
      expect(runtime.tools).toEqual([])
      expect(harness.service.getCachedMcpStatus()?.servers).toEqual([])
      expect(harness.createClient).toHaveBeenCalledTimes(1)
    } finally {
      resolveInitialization?.({ alpha: [] })
    }
  })

  it('drains every overlapping forced start before shutdown completes', async () => {
    const resolvers: Array<(value: Record<string, unknown[]>) => void> = []
    const harness = await loadHarness(() => new Promise((resolve) => {
      resolvers.push(resolve)
    }))

    const firstLoad = harness.service.getCachedMcpRuntime()
    await vi.waitFor(() => expect(harness.initializeConnections).toHaveBeenCalledTimes(1))
    const forcedLoad = harness.service.loadMcpRuntimeForCurrentConfig(true)
    await vi.waitFor(() => expect(harness.initializeConnections).toHaveBeenCalledTimes(2))

    let stopped = false
    const shutdown = harness.service.closeCachedMcpRuntime().then(() => {
      stopped = true
    })
    await vi.waitFor(() => expect(harness.closeClient).toHaveBeenCalled())

    resolvers[1]?.({ alpha: [mcpTool] })
    await Promise.resolve()
    expect(stopped).toBe(false)

    resolvers[0]?.({ alpha: [mcpTool] })
    await Promise.all([firstLoad, forcedLoad, shutdown])
    expect(stopped).toBe(true)
    expect(harness.service.getCachedMcpStatus()?.servers).toEqual([])
  })

  it('tracks a health reconnect as shutdown work and closes its adapter again afterwards', async () => {
    let releaseHealthCheck: ((client: { ping(input: { timeout: number }): Promise<void> }) => void) | undefined
    const healthClient = { ping: vi.fn(async () => {}) }
    const harness = await loadHarness(undefined, () => new Promise((resolve) => {
      releaseHealthCheck = resolve
    }))
    const runtime = await harness.service.getCachedMcpRuntime()

    const healthCheck = runtime.ping()
    await vi.waitFor(() => expect(harness.getClient).toHaveBeenCalledTimes(1))
    let stopped = false
    const shutdown = harness.service.closeCachedMcpRuntime().then(() => {
      stopped = true
    })
    await vi.waitFor(() => expect(harness.closeClient).toHaveBeenCalledTimes(1))
    expect(stopped).toBe(false)

    releaseHealthCheck?.(healthClient)
    await Promise.all([healthCheck, shutdown])
    expect(stopped).toBe(true)
    expect(harness.closeClient.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('does not let an older reopen race reopen a newer shutdown', async () => {
    const harness = await loadHarness()
    await harness.service.getCachedMcpRuntime()
    await harness.service.closeCachedMcpRuntime()

    const reopening = harness.service.reopenCachedMcpRuntime()
    const closing = harness.service.closeCachedMcpRuntime()
    await Promise.all([reopening, closing])

    await expect(harness.service.loadMcpRuntimeForCurrentConfig(false)).rejects.toThrow(
      'MCP runtime is unavailable'
    )
  })

  it('retains a client whose close failed so shutdown can be retried', async () => {
    const harness = await loadHarness()
    await harness.service.getCachedMcpRuntime()
    harness.closeClient
      .mockRejectedValueOnce(new Error('first close failed'))
      .mockRejectedValueOnce(new Error('retry within stop failed'))

    await expect(harness.service.closeCachedMcpRuntime()).rejects.toThrow(
      'Failed to stop every MCP server runtime'
    )
    await expect(harness.service.closeCachedMcpRuntime()).resolves.toBeUndefined()
    expect(harness.service.getCachedMcpStatus()?.servers).toEqual([])
  })

  it('retains a stale client whose close failed during a forced reload', async () => {
    const harness = await loadHarness()
    await harness.service.getCachedMcpRuntime()
    const staleClient = harness.clients[0]
    expect(staleClient).toBeDefined()
    staleClient!.close.mockRejectedValueOnce(new Error('reload close failed'))

    await harness.service.loadMcpRuntimeForCurrentConfig(true)
    expect(harness.clients).toHaveLength(2)
    expect(staleClient!.close).toHaveBeenCalledTimes(1)

    await harness.service.closeCachedMcpRuntime()
    expect(staleClient!.close.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})
