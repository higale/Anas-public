import { BrowserWindow } from 'electron'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { MultiServerMCPClient } from '@langchain/mcp-adapters'
import { getMcpRuntimeConfigSnapshot, type McpServerConfig } from './config/appConfig'
import {
  createMcpClientForServer,
  mcpErrorMessage,
  type McpConnectionIdentity,
  type McpToolLoadResult
} from './mcpTools'
import { runtimeChannelLog, runtimeLog } from './runtimeLogger'
import { serializeStructuredTool } from './toolSchemaSerialization'
import type { McpMaintenanceResult, McpToolStatus, McpServerType } from '@shared/types'
import { armCurrentAgentToolEffect } from './agent/toolEffectScope'
import { currentToolExecution } from './agent/toolExecutionContext'
import type { ManagedCallControl } from './agent/managedCallService'

type McpRuntimeState = 'idle' | 'starting' | 'ready' | 'degraded' | 'recovering' | 'failed' | 'stopped'
type McpManagerLifecycle = 'open' | 'opening' | 'quiescing' | 'closed'
type McpStartReason = 'startup' | 'config_changed' | 'manual_reload' | 'recovery' | 'tools_changed'
type McpRecoverReason = 'startup_failed' | 'ping_failed' | 'tool_failed' | 'tools_changed' | 'manual_maintenance'

interface McpServerRuntimeStatus {
  id: string
  index: number
  name: string
  type: McpServerType
  state: McpRuntimeState
  toolCount: number
  toolNames: string[]
  lastCheckedAt?: string
  lastError?: string
  lastStartedAt?: string
  nextRetryAt?: string
}

const mcpPingTimeoutMs = 5000
const mcpHealthIntervalMs = 60_000
const mcpHealthJitterMs = 20_000
const mcpOperationWaitMaxMs = 10_000
const mcpRecoveryBaseDelayMs = 2_000
const mcpRecoveryMaxDelayMs = 60_000

function runtimeKey(server: McpServerConfig): string {
  const { enabled: _enabled, index: _index, name: _name, ...runtimeConfig } = server
  return JSON.stringify(runtimeConfig)
}

function serverId(server: Pick<McpServerConfig, 'index'>): string {
  return String(server.index)
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  timer.unref?.()
}

function statusTime(): string {
  return new Date().toISOString()
}

function mcpToolEffectTarget(
  server: Pick<McpServerConfig, 'id' | 'name'>,
  connectionIdentity: McpConnectionIdentity,
  toolName: string,
  args: unknown
): Record<string, unknown> {
  return {
    serverId: server.id,
    serverName: server.name,
    transport: connectionIdentity.transport,
    endpoint: connectionIdentity.endpoint,
    connectionFingerprint: connectionIdentity.fingerprint,
    tool: toolName,
    arguments: args
  }
}

function isEmptyMcpStatus(status: McpToolStatus): boolean {
  return status.servers.length === 0
    && status.loaded.length === 0
    && status.errors.length === 0
    && status.tools.length === 0
    && status.toolNames.length === 0
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    unrefTimer(timer)
  })
}

function mcpServerLog(level: Parameters<typeof runtimeLog>[0], server: McpServerConfig, message: string, data?: unknown): void {
  runtimeChannelLog(level, `mcp_${server.id}`, 'mcp.server', message, {
    id: server.id,
    name: server.name,
    index: server.index,
    type: server.type,
    ...(data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, unknown> : { detail: data })
  })
}

function asMcpToolLoadResult(tools: StructuredToolInterface[], loaded: McpToolLoadResult['loaded'], errors: McpToolLoadResult['errors']): McpToolLoadResult {
  return {
    tools,
    loaded,
    errors,
    ping: async () => {
      await mcpRuntimeManager.pingReadyServers()
    },
    close: async () => {
      await mcpRuntimeManager.shutdown()
    }
  }
}

function wrapMcpTool(
  tool: StructuredToolInterface,
  onFailure: (error: unknown) => void,
  enter: () => () => void
): StructuredToolInterface {
  return new Proxy(tool as object, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (property !== 'invoke' || typeof value !== 'function') return value
      return async (...args: unknown[]) => {
        const leave = enter()
        try {
          return await value.apply(target, args)
        } catch (error) {
          const signal = (args[1] as { signal?: AbortSignal } | undefined)?.signal
          // The adapter exposes isError responses as ToolException, not as a
          // ToolMessage. Its explicit server-error response confirms an outcome;
          // transport failures and cancellation do not make that guarantee.
          if (error instanceof Error && error.name === 'ToolException'
            && /^MCP tool '.+' on server '.+' returned an error:/s.test(error.message)) {
            currentToolExecution()?.setOutcome({ remote_failure_confirmed: true })
          }
          if (!signal?.aborted) onFailure(error)
          throw error
        } finally {
          leave()
        }
      }
    }
  }) as StructuredToolInterface
}

class McpServerRuntime {
  private client?: MultiServerMCPClient
  private clients = new Set<MultiServerMCPClient>()
  private clientCloseOperations = new Map<MultiServerMCPClient, Promise<void>>()
  private configKey: string
  private generation = 0
  private healthTimer?: ReturnType<typeof setTimeout>
  private nextRetryAt?: string
  private latestOperation?: Promise<void>
  private operations = new Set<Promise<void>>()
  private recoveryAttempt = 0
  private recoveryTimer?: ReturnType<typeof setTimeout>
  private state: McpRuntimeState = 'idle'
  private tools: StructuredToolInterface[] = []
  private toolNames: string[] = []
  private lastCheckedAt?: string
  private lastError?: string
  private lastStartedAt?: string
  private activeInvocations = 0
  private pendingRecoveryReason?: McpRecoverReason

  constructor(private server: McpServerConfig, private onStatusChanged: () => void) {
    this.configKey = runtimeKey(server)
  }

  get id(): string {
    return serverId(this.server)
  }

  get index(): number {
    return this.server.index
  }

  get isBusy(): boolean {
    return this.operations.size > 0
  }

  get isReady(): boolean {
    return this.state === 'ready'
  }

  matches(server: McpServerConfig): boolean {
    return this.configKey === runtimeKey(server)
  }

  updateServer(server: McpServerConfig): void {
    this.server = server
    this.configKey = runtimeKey(server)
  }

  result(): McpToolLoadResult {
    const loaded = this.state === 'ready'
      ? [{
          id: this.server.id,
          index: this.server.index,
          name: this.server.name,
          toolCount: this.tools.length,
          toolNames: this.toolNames
        }]
      : []
    const errors = this.lastError && (this.state === 'degraded' || this.state === 'failed')
      ? [{
          id: this.server.id,
          index: this.server.index,
          name: this.server.name,
          error: this.lastError
        }]
      : []
    return asMcpToolLoadResult(this.state === 'ready' ? this.tools : [], loaded, errors)
  }

  status(): McpServerRuntimeStatus {
    return {
      id: this.server.id,
      index: this.server.index,
      name: this.server.name,
      type: this.server.type,
      state: this.state,
      toolCount: this.state === 'ready' ? this.tools.length : 0,
      toolNames: this.state === 'ready' ? this.toolNames : [],
      lastCheckedAt: this.lastCheckedAt,
      lastError: this.lastError,
      lastStartedAt: this.lastStartedAt,
      nextRetryAt: this.nextRetryAt
    }
  }

  start(reason: McpStartReason, force = false): Promise<void> {
    if (this.latestOperation && !force) return this.latestOperation
    const generation = this.nextGeneration()
    return this.trackOperation(this.startNow(reason, generation))
  }

  waitForCurrentOperation(): Promise<void> {
    if (this.operations.size === 0) return Promise.resolve()
    return Promise.race([
      this.drainOperations(),
      delayMs(Math.min(Math.max(this.server.timeoutMs, 1000), mcpOperationWaitMaxMs))
    ])
  }

  scheduleMaintenance(): boolean {
    if (this.operations.size > 0) return false
    if (this.state === 'ready') {
      void this.checkHealth('manual_maintenance').catch(() => undefined)
      return true
    }
    this.clearRecoveryTimer()
    return this.scheduleRecovery('manual_maintenance', 0)
  }

  async stop(reason: 'disabled' | 'deleted' | 'shutdown' | 'config_changed'): Promise<void> {
    this.pendingRecoveryReason = undefined
    this.nextGeneration()
    this.clearHealthTimer()
    this.clearRecoveryTimer()
    this.state = 'stopped'
    this.nextRetryAt = undefined
    this.tools = []
    this.toolNames = []
    this.lastError = undefined
    mcpServerLog('info', this.server, 'Stopping MCP server runtime.', { reason })
    const hadPendingOperations = this.operations.size > 0
    const clientsToClose = new Set(this.clients)
    const firstCloseFailures = await this.closeClients(clientsToClose)
    // Forced reloads may overlap. Drain the complete, stable operation set so
    // an older start cannot publish a connection after shutdown has returned.
    await this.drainOperations()
    for (const client of this.clients) clientsToClose.add(client)
    const closeFailures = hadPendingOperations || firstCloseFailures.length > 0
      ? await this.closeClients(clientsToClose)
      : []
    this.onStatusChanged()
    if (closeFailures.length > 0) {
      throw new AggregateError(closeFailures, `Failed to stop MCP server ${this.server.name}.`)
    }
  }

  checkHealth(reason: McpRecoverReason | 'scheduled'): Promise<void> {
    return this.trackOperation(this.ping(reason))
  }

  private async ping(reason: McpRecoverReason | 'scheduled'): Promise<void> {
    // A server may serialize requests. A busy tool is not evidence of a dead
    // connection, even when the server cannot answer ping until it completes.
    if (this.activeInvocations > 0) {
      this.scheduleHealthCheck()
      return
    }
    if (this.state !== 'ready' || !this.client) {
      this.scheduleRecovery(reason === 'scheduled' ? 'ping_failed' : reason)
      return
    }

    const generation = this.generation
    try {
      const client = await this.client.getClient(this.server.id)
      if (!client) throw new Error('MCP server client is not connected.')
      await client.ping({ timeout: mcpPingTimeoutMs })
      if (!this.isCurrentGeneration(generation)) return
      this.lastCheckedAt = statusTime()
      this.lastError = undefined
      this.recoveryAttempt = 0
      this.nextRetryAt = undefined
      mcpServerLog('debug', this.server, 'MCP server ping succeeded.', { reason })
      this.onStatusChanged()
      this.scheduleHealthCheck()
    } catch (error) {
      if (!this.isCurrentGeneration(generation)) return
      // A tool may have started after this probe was sent. Its work can delay
      // the ping response, so the old probe cannot justify interrupting it.
      if (this.activeInvocations > 0) {
        this.scheduleHealthCheck()
        return
      }
      this.markDegraded('MCP server ping failed.', error)
      this.scheduleRecovery('ping_failed')
    }
  }

  private async startNow(reason: McpStartReason, generation: number): Promise<void> {
    this.clearHealthTimer()
    this.clearRecoveryTimer()
    this.pendingRecoveryReason = undefined
    this.state = reason === 'recovery' ? 'recovering' : 'starting'
    this.nextRetryAt = undefined
    this.lastStartedAt = statusTime()
    this.onStatusChanged()
    mcpServerLog('info', this.server, 'Starting MCP server runtime.', { reason })
    await this.closeClient()
    if (!this.isCurrentGeneration(generation)) return

    let client: MultiServerMCPClient | undefined
    try {
      const connectionErrors: Array<{ id: string; name: string; error: string }> = []
      // The adapter preserves each invocation's args object in its progress closure.
      // Object identity keeps simultaneous identical calls separate without changing MCP.
      const progressOwners = new WeakMap<object, ManagedCallControl>()
      // eslint-disable-next-line prefer-const -- The hooks close over identity before client construction returns it.
      let connectionIdentity: McpConnectionIdentity | undefined
      const created = createMcpClientForServer(this.server, {
        onConnectionError: ({ serverName, error }) => {
          connectionErrors.push({
            id: serverName,
            name: this.server.name,
            error: mcpErrorMessage(error, this.server.apiKey)
          })
        },
        onMessage: (message) => {
          mcpServerLog('debug', this.server, 'MCP server log message.', message)
        },
        onProgress: (progress, source) => {
          mcpServerLog('trace', this.server, 'MCP tool progress.', { progress, source })
          const owner = source.type === 'tool' && source.args ? progressOwners.get(source.args) : undefined
          if (owner && !owner.signal.aborted) {
            owner.progress(progress.progress, 'mcp', progress.total)
            if (progress.message) owner.output('progress', `${progress.message}\n`)
          }
        },
        onToolsListChanged: () => {
          if (!this.isCurrentGeneration(generation)) return
          mcpServerLog('info', this.server, 'MCP server tools changed; scheduling refresh.')
          this.scheduleRecovery('tools_changed', 0)
        },
        beforeToolCall: ({ name, args }) => {
          if (!this.isCurrentGeneration(generation)) {
            throw new Error(`MCP server ${this.server.name} runtime changed before tool ${name} could start.`)
          }
          if (!connectionIdentity) {
            throw new Error(`MCP server ${this.server.name} connection identity is not initialized.`)
          }
          armCurrentAgentToolEffect({
            kind: 'mcp_tool_call',
            target: mcpToolEffectTarget(this.server, connectionIdentity, name, args)
          })
          const owner = currentToolExecution()
          if (owner && args && typeof args === 'object') progressOwners.set(args, owner)
          mcpServerLog('debug', this.server, 'MCP tool call started.', { tool: name, args })
        },
        afterToolCall: ({ name, args }) => {
          if (args && typeof args === 'object') progressOwners.delete(args)
          if (!this.isCurrentGeneration(generation)) return
          this.lastCheckedAt = statusTime()
          mcpServerLog('debug', this.server, 'MCP tool call completed.', { tool: name })
        }
      })
      connectionIdentity = created.connectionIdentity
      client = created.client
      this.clients.add(client)
      this.client = client
      const byServer = await client.initializeConnections()
      if (!this.isCurrentGeneration(generation)) {
        await this.closeClient(client)
        return
      }
      const tools = byServer[this.server.id] ?? []
      if (connectionErrors.length > 0) {
        throw new Error(connectionErrors.map((item) => item.error).join('\n'))
      }
      this.tools = tools.map((tool) => wrapMcpTool(tool as StructuredToolInterface,
        (error) => this.handleToolFailure(error, generation),
        () => {
          this.activeInvocations += 1
          return () => {
            this.activeInvocations -= 1
            if (this.activeInvocations === 0 && this.pendingRecoveryReason) {
              const reason = this.pendingRecoveryReason
              this.pendingRecoveryReason = undefined
              this.scheduleRecovery(reason, 0)
            }
          }
        }))
      this.toolNames = this.tools.map((tool) => tool.name)
      this.state = 'ready'
      this.lastError = undefined
      this.recoveryAttempt = 0
      this.nextRetryAt = undefined
      this.lastCheckedAt = statusTime()
      mcpServerLog('info', this.server, 'MCP server runtime ready.', {
        reason,
        toolCount: this.tools.length,
        toolNames: this.toolNames
      })
      runtimeLog('info', 'mcp', 'MCP server runtime ready.', {
        id: this.server.id,
        name: this.server.name,
        reason,
        toolCount: this.tools.length
      })
      this.onStatusChanged()
      this.scheduleHealthCheck()
    } catch (error) {
      if (client) await this.closeClient(client)
      if (!this.isCurrentGeneration(generation)) return
      this.markFailed(error, 'startup_failed')
    }
  }

  private handleToolFailure(error: unknown, generation: number): void {
    if (!this.isCurrentGeneration(generation)) return
    mcpServerLog('debug', this.server, 'MCP tool failed; checking the connection before recovery.', {
      error: mcpErrorMessage(error, this.server.apiKey)
    })
    queueMicrotask(() => {
      if (this.isCurrentGeneration(generation) && this.operations.size === 0) {
        void this.checkHealth('tool_failed').catch(() => undefined)
      }
    })
  }

  private markDegraded(message: string, error: unknown): void {
    this.state = 'degraded'
    this.lastCheckedAt = statusTime()
    this.lastError = mcpErrorMessage(error, this.server.apiKey)
    this.tools = []
    this.toolNames = []
    mcpServerLog('warn', this.server, message, { error: this.lastError })
    runtimeLog('warn', 'mcp', message, {
      id: this.server.id,
      name: this.server.name,
      error: this.lastError
    })
    this.onStatusChanged()
  }

  private markFailed(error: unknown, recoverReason: McpRecoverReason): void {
    this.state = 'failed'
    this.lastCheckedAt = statusTime()
    this.lastError = mcpErrorMessage(error, this.server.apiKey)
    this.tools = []
    this.toolNames = []
    mcpServerLog('warn', this.server, 'MCP server runtime failed.', { error: this.lastError, recoverReason })
    runtimeLog('warn', 'mcp', 'MCP server runtime failed.', {
      id: this.server.id,
      name: this.server.name,
      error: this.lastError,
      recoverReason
    })
    this.onStatusChanged()
    this.scheduleRecovery(recoverReason)
  }

  private scheduleHealthCheck(): void {
    this.clearHealthTimer()
    if (this.state !== 'ready') return
    const delay = mcpHealthIntervalMs + Math.floor(Math.random() * mcpHealthJitterMs)
    this.healthTimer = setTimeout(() => {
      this.healthTimer = undefined
      void this.checkHealth('scheduled').catch(() => undefined)
    }, delay)
    unrefTimer(this.healthTimer)
  }

  private scheduleRecovery(reason: McpRecoverReason, overrideDelayMs?: number): boolean {
    if (this.state === 'stopped' || this.recoveryTimer) return false
    const waitForInvocations = reason === 'tools_changed' || reason === 'ping_failed' || reason === 'tool_failed'
    if (waitForInvocations && this.activeInvocations > 0) {
      this.pendingRecoveryReason = reason
      return true
    }
    if (this.operations.size > 0 && reason === 'tools_changed') return false
    this.clearHealthTimer()
    this.recoveryAttempt += 1
    const delay = overrideDelayMs ?? Math.min(mcpRecoveryMaxDelayMs, mcpRecoveryBaseDelayMs * 2 ** Math.min(this.recoveryAttempt - 1, 5))
    this.nextRetryAt = new Date(Date.now() + delay).toISOString()
    mcpServerLog('info', this.server, 'MCP server recovery scheduled.', {
      reason,
      attempt: this.recoveryAttempt,
      delayMs: delay,
      nextRetryAt: this.nextRetryAt
    })
    this.onStatusChanged()
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined
      if (waitForInvocations && this.activeInvocations > 0) {
        this.pendingRecoveryReason = reason
        return
      }
      void this.start(reason === 'tools_changed' ? 'tools_changed' : 'recovery', true)
    }, delay)
    unrefTimer(this.recoveryTimer)
    return true
  }

  private nextGeneration(): number {
    this.generation += 1
    return this.generation
  }

  private isCurrentGeneration(generation: number): boolean {
    return this.generation === generation && this.state !== 'stopped'
  }

  private clearHealthTimer(): void {
    if (!this.healthTimer) return
    clearTimeout(this.healthTimer)
    this.healthTimer = undefined
  }

  private clearRecoveryTimer(): void {
    if (!this.recoveryTimer) return
    clearTimeout(this.recoveryTimer)
    this.recoveryTimer = undefined
    this.nextRetryAt = undefined
  }

  private trackOperation(operation: Promise<void>): Promise<void> {
    this.operations.add(operation)
    this.latestOperation = operation
    void operation.then(
      () => this.finishOperation(operation),
      () => this.finishOperation(operation)
    )
    return operation
  }

  private finishOperation(operation: Promise<void>): void {
    this.operations.delete(operation)
    if (this.latestOperation !== operation) return
    this.latestOperation = Array.from(this.operations).at(-1)
  }

  private async drainOperations(): Promise<void> {
    while (this.operations.size > 0) {
      await Promise.allSettled(Array.from(this.operations))
    }
  }

  private async closeClients(clients: Iterable<MultiServerMCPClient>): Promise<unknown[]> {
    const closed = await Promise.allSettled(Array.from(clients).map((client) => (
      this.closeClient(client, true)
    )))
    return closed.flatMap((result) => (
      result.status === 'rejected' ? [result.reason] : []
    ))
  }

  private async closeClient(client = this.client, strict = false): Promise<void> {
    if (!client) return
    let operation = this.clientCloseOperations.get(client)
    if (!operation) {
      operation = Promise.resolve().then(() => client.close())
      this.clientCloseOperations.set(client, operation)
      void operation.then(
        () => {
          this.clientCloseOperations.delete(client)
          if (this.client === client) this.client = undefined
          this.clients.delete(client)
        },
        () => {
          this.clientCloseOperations.delete(client)
          // A failed close must stay discoverable even if a newer generation
          // has already installed another current client. A later stop retries
          // every retained client instead of leaking the stale transport.
          this.clients.add(client)
        }
      )
    }
    try {
      await operation
    } catch (error) {
      mcpServerLog(strict ? 'warn' : 'debug', this.server, strict
        ? 'MCP server close failed.'
        : 'Ignoring MCP server close failure.', { error })
      if (strict) throw error
    }
  }
}

class McpRuntimeManager {
  private runtimes = new Map<string, McpServerRuntime>()
  private cachedStatus?: McpToolStatus
  private mutationTail: Promise<void> = Promise.resolve()
  private lifecycle: McpManagerLifecycle = 'open'
  private lifecycleGeneration = 0
  private reopenTask?: Promise<void>
  private shutdownTask?: Promise<void>

  get status(): McpToolStatus | null {
    return this.cachedStatus ?? null
  }

  currentTools(): McpToolLoadResult {
    return this.aggregate()
  }

  shutdown(): Promise<void> {
    if (this.lifecycle === 'quiescing' && this.shutdownTask) return this.shutdownTask
    if (this.lifecycle === 'closed' && !this.reopenTask) return Promise.resolve()
    const generation = ++this.lifecycleGeneration
    this.lifecycle = 'quiescing'
    const task = this.enqueueMutation(async () => {
      await this.stopAll('shutdown')
      this.broadcast()
      if (this.lifecycleGeneration === generation) this.lifecycle = 'closed'
    })
    this.shutdownTask = task
    void task.catch(() => {
      if (this.shutdownTask === task) this.shutdownTask = undefined
    })
    return task
  }

  reopen(): Promise<void> {
    if (this.lifecycle === 'open') return Promise.resolve()
    if (this.lifecycle === 'opening' && this.reopenTask) return this.reopenTask
    const generation = ++this.lifecycleGeneration
    this.lifecycle = 'opening'
    const task = this.enqueueMutation(async () => {
      if (this.lifecycleGeneration !== generation) return
      this.lifecycle = 'open'
      this.shutdownTask = undefined
    })
    this.reopenTask = task
    void task.then(
      () => {
        if (this.reopenTask === task) this.reopenTask = undefined
      },
      () => {
        if (this.reopenTask === task) this.reopenTask = undefined
      }
    )
    return task
  }

  async stopServerIndex(index: number): Promise<void> {
    this.assertOpen()
    await this.enqueueMutation(async () => {
      await this.stopServerIndexNow(index)
      this.broadcast()
    })
  }

  async loadFromCurrentConfig(forceReload = false): Promise<McpToolStatus> {
    this.assertOpen()
    const application = await this.enqueueMutation(() => this.applyCurrentConfig(
      forceReload,
      forceReload ? 'manual_reload' : 'startup'
    ))
    if (!forceReload || application.waitFor.length === 0) return application.status
    await this.waitForRuntimes(application.waitFor)
    return this.enqueueMutation(async () => this.broadcast())
  }

  async runtimeFromCurrentConfig(forceReload = false): Promise<McpToolLoadResult> {
    this.assertOpen()
    const application = await this.enqueueMutation(() => this.applyCurrentConfig(
      forceReload,
      forceReload ? 'manual_reload' : 'startup',
      false
    ))
    await this.waitForRuntimes(application.waitFor)
    return this.enqueueMutation(async () => this.aggregate())
  }

  async reloadServerIndex(index: number): Promise<McpToolStatus> {
    this.assertOpen()
    const application = await this.enqueueMutation(async () => {
      const config = await getMcpRuntimeConfigSnapshot()
      if (!config.enabled) {
        await this.stopAll('disabled')
        return { status: this.broadcast(), runtime: undefined }
      }

      await this.reconcileServers(config.servers)
      const server = config.servers.find((item) => item.index === index)
      if (!server) {
        return { status: this.broadcast(), runtime: undefined }
      }

      const runtime = this.runtimes.get(serverId(server))
      if (!runtime) return { status: this.broadcast(), runtime: undefined }
      runtime.updateServer(server)
      runtime.start('manual_reload', true)
      return { status: this.broadcast(), runtime }
    })
    if (!application.runtime) return application.status
    await this.waitForRuntimes([application.runtime])
    return this.enqueueMutation(async () => this.broadcast())
  }

  async scheduleMaintenance(): Promise<McpMaintenanceResult> {
    this.assertOpen()
    return this.enqueueMutation(async () => {
      const checkedAt = statusTime()
      const config = await getMcpRuntimeConfigSnapshot()
      if (!config.enabled) {
        await this.stopAll('disabled')
        this.broadcast()
        return { checkedAt, scheduled: false, alreadyRunning: false, reason: 'disabled' }
      }

      if (config.servers.length === 0) {
        await this.reconcileServers([])
        this.broadcast()
        return { checkedAt, scheduled: false, alreadyRunning: false, reason: 'no_servers' }
      }

      await this.reconcileServers(config.servers)
      const scheduled: Array<{ id: string; name: string }> = []
      const alreadyRunning: Array<{ id: string; name: string }> = []
      for (const server of config.servers) {
        const runtime = this.runtimes.get(serverId(server))
        if (!runtime) continue
        if (!runtime.matches(server)) {
          runtime.updateServer(server)
          void runtime.start('config_changed', true)
          scheduled.push({ id: server.id, name: server.name })
          continue
        }
        runtime.updateServer(server)
        if (runtime.scheduleMaintenance()) {
          scheduled.push({ id: server.id, name: server.name })
        } else {
          alreadyRunning.push({ id: server.id, name: server.name })
        }
      }

      runtimeLog('info', 'mcp', 'MCP server maintenance operations scheduled.', {
        scheduled,
        alreadyRunning
      })
      this.broadcast(false)
      return {
        checkedAt,
        scheduled: scheduled.length > 0,
        alreadyRunning: scheduled.length === 0 && alreadyRunning.length > 0
      }
    })
  }

  async pingReadyServers(): Promise<void> {
    if (this.lifecycle !== 'open') return
    await Promise.all(Array.from(this.runtimes.values()).filter((runtime) => runtime.isReady).map((runtime) => runtime.checkHealth('scheduled')))
  }

  private async ensureServers(
    servers: McpServerConfig[],
    options: { forceReload: boolean; reason: McpStartReason }
  ): Promise<McpServerRuntime[]> {
    await this.reconcileServers(servers)

    const waitFor: McpServerRuntime[] = []
    for (const server of servers) {
      const runtime = this.runtimes.get(serverId(server))
      if (!runtime) continue
      const requiresRestart = options.forceReload || !runtime.matches(server)
      runtime.updateServer(server)
      if (requiresRestart) {
        runtime.start(options.forceReload ? 'manual_reload' : 'config_changed', true)
        waitFor.push(runtime)
      } else if (runtime.status().state === 'idle') {
        runtime.start(options.reason)
        waitFor.push(runtime)
      } else if (runtime.isBusy) {
        waitFor.push(runtime)
      }
    }

    return waitFor
  }

  private async applyCurrentConfig(forceReload: boolean, reason: McpStartReason, logStatus = true): Promise<{ status: McpToolStatus; waitFor: McpServerRuntime[] }> {
    const config = await getMcpRuntimeConfigSnapshot()
    if (!config.enabled) {
      await this.stopAll('disabled')
      return { status: this.broadcast(logStatus), waitFor: [] }
    }

    const waitFor = await this.ensureServers(config.servers, { forceReload, reason })
    return { status: this.broadcast(logStatus), waitFor }
  }

  private async reconcileServers(servers: McpServerConfig[]): Promise<void> {
    const activeIds = new Set(servers.map(serverId))
    const stale = Array.from(this.runtimes.values()).filter((runtime) => !activeIds.has(runtime.id))
    await Promise.all(stale.map(async (runtime) => {
      await runtime.stop('deleted')
      if (this.runtimes.get(runtime.id) === runtime) this.runtimes.delete(runtime.id)
    }))

    for (const server of servers) {
      let runtime = this.runtimes.get(serverId(server))
      if (!runtime) {
        runtime = new McpServerRuntime(server, () => this.broadcast(false))
        this.runtimes.set(runtime.id, runtime)
      }
    }
  }

  private aggregate(): McpToolLoadResult {
    const results = Array.from(this.runtimes.values()).map((runtime) => runtime.result())
    return asMcpToolLoadResult(
      results.flatMap((result) => result.tools),
      results.flatMap((result) => result.loaded),
      results.flatMap((result) => result.errors)
    )
  }

  private async stopAll(reason: 'disabled' | 'shutdown'): Promise<void> {
    const current = Array.from(this.runtimes.values())
    const stopped = await Promise.allSettled(current.map((runtime) => runtime.stop(reason)))
    stopped.forEach((result, index) => {
      const runtime = current[index]
      if (result.status === 'fulfilled' && runtime && this.runtimes.get(runtime.id) === runtime) {
        this.runtimes.delete(runtime.id)
      }
    })
    const failures = stopped.flatMap((result) => (
      result.status === 'rejected' ? [result.reason] : []
    ))
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Failed to stop every MCP server runtime.')
    }
  }

  private async stopServerIndexNow(index: number): Promise<void> {
    const runtimes = Array.from(this.runtimes.values()).filter((runtime) => runtime.index === index)
    await Promise.all(runtimes.map(async (runtime) => {
      await runtime.stop('deleted')
      if (this.runtimes.get(runtime.id) === runtime) this.runtimes.delete(runtime.id)
    }))
  }

  private async waitForRuntimes(runtimes: McpServerRuntime[]): Promise<void> {
    await Promise.all(Array.from(new Set(runtimes)).map((runtime) => runtime.waitForCurrentOperation()))
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(operation, operation)
    this.mutationTail = result.then(() => undefined, () => undefined)
    return result
  }

  private assertOpen(): void {
    if (this.lifecycle !== 'open') {
      throw new Error('MCP runtime is unavailable while application data is closing.')
    }
  }

  private currentStatus(): McpToolStatus {
    const result = this.aggregate()
    return {
      checkedAt: statusTime(),
      servers: Array.from(this.runtimes.values()).map((runtime) => runtime.status()),
      loaded: result.loaded,
      errors: result.errors,
      tools: result.tools.map(serializeStructuredTool),
      toolNames: result.tools.map((tool) => tool.name)
    }
  }

  private broadcast(logStatus = true): McpToolStatus {
    const status = this.currentStatus()
    const previousStatus = this.cachedStatus
    this.cachedStatus = status
    if (logStatus && !(previousStatus && isEmptyMcpStatus(previousStatus) && isEmptyMcpStatus(status))) {
      runtimeLog(status.errors.length > 0 ? 'warn' : 'info', 'mcp', 'MCP runtime status updated.', {
        servers: status.servers,
        toolCount: status.toolNames.length
      })
    }
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('mcp:status', status)
    }
    return status
  }
}

const mcpRuntimeManager = new McpRuntimeManager()

export async function closeCachedMcpRuntime(): Promise<void> {
  await mcpRuntimeManager.shutdown()
}

export async function reopenCachedMcpRuntime(): Promise<void> {
  await mcpRuntimeManager.reopen()
}

export async function closeCachedMcpServerIndex(index: number): Promise<void> {
  await mcpRuntimeManager.stopServerIndex(index)
}

export async function getCachedMcpRuntime(forceReload = false): Promise<McpToolLoadResult> {
  return mcpRuntimeManager.runtimeFromCurrentConfig(forceReload)
}

/** Read available definitions without connecting, waiting, or changing servers. */
export function getLoadedMcpRuntime(): McpToolLoadResult {
  return mcpRuntimeManager.currentTools()
}

export async function loadMcpRuntimeForCurrentConfig(forceReload = false): Promise<McpToolStatus> {
  return mcpRuntimeManager.loadFromCurrentConfig(forceReload)
}

export async function reloadMcpRuntimeForServer(index: number): Promise<McpToolStatus> {
  return mcpRuntimeManager.reloadServerIndex(index)
}

export async function pingAndReloadFailedMcpServers(): Promise<McpMaintenanceResult> {
  return mcpRuntimeManager.scheduleMaintenance()
}

export function getCachedMcpStatus(): McpToolStatus | null {
  return mcpRuntimeManager.status
}
