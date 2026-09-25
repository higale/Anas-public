import type {
  AgentEventEnvelope,
  AgentEventSubscription,
  AgentEventSubscriptionRequest,
  AgentRuntimeEvent
} from '@shared/agentTypes'

import { compactToolCallProgress } from '@shared/agentEventReplay'

interface AgentEventIpc {
  invoke(channel: string, request: AgentEventSubscriptionRequest): Promise<unknown>
  on(channel: string, listener: (event: unknown, envelope: AgentEventEnvelope) => void): void
  removeListener(channel: string, listener: (event: unknown, envelope: AgentEventEnvelope) => void): void
}

interface AgentEventSubscriptionOptions {
  synchronize?(): void | Promise<void>
  onError?(message: string): void
}

interface AgentEventConsumer extends AgentEventSubscriptionOptions {
  listener(event: AgentRuntimeEvent): void
  ready: boolean
  syncing: boolean
  disposed: boolean
  lastRevision?: number
  retentionRevision?: number
  retryAttempt: number
  retryTimer?: ReturnType<typeof setTimeout>
}

interface BufferedAgentEvent {
  event: AgentRuntimeEvent
  runId?: string
}

const retryDelayMs = 250
const maximumRetryDelayMs = 5_000

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function asSubscription(value: unknown): AgentEventSubscription {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Agent event subscription returned an invalid response.')
  }
  const candidate = value as Partial<AgentEventSubscription>
  if (
    !Number.isSafeInteger(candidate.revision)
    || (candidate.revision ?? -1) < 0
    || !Array.isArray(candidate.replay)
    || typeof candidate.replayComplete !== 'boolean'
    || candidate.replay.some((envelope, index, replay) => (
      !validEnvelope(envelope)
      || envelope.revision > (candidate.revision ?? -1)
      || (index > 0 && envelope.revision <= replay[index - 1].revision)
    ))
  ) {
    throw new Error('Agent event subscription returned an invalid response.')
  }
  return candidate as AgentEventSubscription
}

function validEnvelope(envelope: AgentEventEnvelope): boolean {
  return Boolean(
    envelope
    && Number.isSafeInteger(envelope.revision)
    && envelope.revision > 0
    && typeof envelope.replayActive === 'boolean'
    && envelope.event
    && typeof envelope.event === 'object'
    && typeof envelope.event.type === 'string'
  )
}

function eventRunId(event: AgentRuntimeEvent): string | undefined {
  return 'run' in event ? event.run.id : 'runId' in event ? event.runId : undefined
}

class AgentEventHub {
  private readonly consumers = new Set<AgentEventConsumer>()
  private readonly history = new Map<number, BufferedAgentEvent>()
  private readonly activeRunIds = new Set<string>()
  private readonly runReplayStateRevisions = new Map<string, number>()
  private connecting = false
  private connected = false
  private reconnectRequested = false
  private retryAttempt = 0
  private retryTimer?: ReturnType<typeof setTimeout>
  private subscriptionRevision?: number
  private lastReceivedRevision?: number

  constructor(private readonly ipc: AgentEventIpc) {
    this.ipc.on('agent:event', this.handleEnvelope)
  }

  add(
    listener: (event: AgentRuntimeEvent) => void,
    options: AgentEventSubscriptionOptions
  ): () => void {
    const consumer: AgentEventConsumer = {
      ...options,
      listener,
      ready: false,
      syncing: false,
      disposed: false,
      retryAttempt: 0
    }
    this.consumers.add(consumer)
    if (this.connected) {
      void this.synchronizeConsumer(consumer)
    } else if (!this.connecting) {
      this.scheduleConnect(true)
    }
    return () => {
      consumer.disposed = true
      consumer.ready = false
      if (consumer.retryTimer) clearTimeout(consumer.retryTimer)
      consumer.retryTimer = undefined
      this.consumers.delete(consumer)
      this.pruneHistory()
    }
  }

  private readonly handleEnvelope = (_event: unknown, envelope: AgentEventEnvelope): void => {
    if (!validEnvelope(envelope)) return
    const current = this.lastReceivedRevision
    if (current !== undefined && envelope.revision <= current) return
    this.bufferEnvelope(envelope)
    if (!this.connected) {
      this.pruneHistory()
      return
    }
    if (current !== undefined && envelope.revision !== current + 1) {
      this.pauseConsumers()
      this.connected = false
      this.scheduleConnect(true)
      return
    }
    this.lastReceivedRevision = envelope.revision
    for (const consumer of this.consumers) {
      if (consumer.ready) this.deliver(consumer, envelope.revision, envelope.event)
    }
    this.pruneHistory()
  }

  private pauseConsumers(): void {
    for (const consumer of this.consumers) consumer.ready = false
  }

  private reportError(consumer: AgentEventConsumer, reason: unknown): void {
    try {
      consumer.onError?.(errorMessage(reason))
    } catch (callbackError) {
      console.error('Failed to report an Agent event subscription error.', callbackError)
    }
  }

  private reportAll(reason: unknown): void {
    for (const consumer of this.consumers) this.reportError(consumer, reason)
  }

  private deliver(
    consumer: AgentEventConsumer,
    revision: number,
    event: AgentRuntimeEvent
  ): void {
    consumer.lastRevision = revision
    try {
      consumer.listener(event)
    } catch (reason) {
      this.reportError(consumer, reason)
    }
  }

  private bufferEnvelope(envelope: AgentEventEnvelope): void {
    const runId = eventRunId(envelope.event)
    this.history.set(envelope.revision, { event: envelope.event, runId })
    if (!runId) return
    const stateRevision = this.runReplayStateRevisions.get(runId)
    if (stateRevision !== undefined && stateRevision >= envelope.revision) return
    this.runReplayStateRevisions.set(runId, envelope.revision)
    if (envelope.replayActive) this.activeRunIds.add(runId)
    else this.activeRunIds.delete(runId)
  }

  private scheduleConnect(immediate = false): void {
    if (this.consumers.size === 0 || this.connecting) {
      if (this.connecting) this.reconnectRequested = true
      return
    }
    if (this.retryTimer) return
    const delay = immediate
      ? 0
      : Math.min(
          maximumRetryDelayMs,
          retryDelayMs * (2 ** Math.max(0, this.retryAttempt - 1))
        )
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      void this.connect()
    }, delay)
  }

  private async connect(): Promise<void> {
    if (this.consumers.size === 0 || this.connecting) return
    this.connecting = true
    this.reconnectRequested = false
    try {
      const cursor = this.lastReceivedRevision
      const response = asSubscription(await this.ipc.invoke('agent:events:subscribe', {
        ...(cursor === undefined ? {} : { afterRevision: cursor })
      }))
      for (const envelope of response.replay) {
        if (validEnvelope(envelope)) this.bufferEnvelope(envelope)
      }
      if (this.subscriptionRevision === undefined) {
        const firstReplayRevision = response.replay[0]?.revision
        this.subscriptionRevision = firstReplayRevision === undefined
          ? response.revision
          : firstReplayRevision - 1
      }
      if (cursor !== undefined && response.revision < cursor) {
        throw new Error('Agent event subscription revision moved backwards.')
      }
      const postSubscriptionRevisions = [...this.history.keys()]
        .filter((revision) => revision > response.revision)
        .sort((left, right) => left - right)
      let lastReceivedRevision = response.revision
      for (const revision of postSubscriptionRevisions) {
        if (revision !== lastReceivedRevision + 1) {
          throw new Error('Agent event subscription missed a live event.')
        }
        lastReceivedRevision = revision
      }
      this.lastReceivedRevision = lastReceivedRevision
      this.connected = true
      this.retryAttempt = 0
      if (!response.replayComplete) {
        console.warn('Agent event replay was incomplete; consumers were refreshed from snapshots.')
      }
      await Promise.all([...this.consumers].map((consumer) => this.synchronizeConsumer(consumer)))
    } catch (reason) {
      this.connected = false
      this.pauseConsumers()
      this.retryAttempt += 1
      this.reportAll(reason)
      this.reconnectRequested = true
    } finally {
      this.connecting = false
      this.pruneHistory()
      if (this.reconnectRequested) this.scheduleConnect()
    }
  }

  private async synchronizeConsumer(consumer: AgentEventConsumer): Promise<void> {
    if (consumer.disposed || consumer.syncing || !this.connected) return
    consumer.syncing = true
    consumer.ready = false
    consumer.retentionRevision = this.lastReceivedRevision
    try {
      await consumer.synchronize?.()
      if (consumer.disposed || !this.connected) return
      const subscriptionRevision = this.subscriptionRevision
      if (subscriptionRevision === undefined || this.lastReceivedRevision === undefined) {
        throw new Error('Agent event subscription has no synchronization revision.')
      }
      let cursor = consumer.lastRevision ?? subscriptionRevision
      const oldestRevision = this.history.size > 0
        ? Math.min(...this.history.keys())
        : undefined
      if (oldestRevision !== undefined && cursor < oldestRevision - 1) {
        cursor = oldestRevision - 1
      }
      // No event handler can interleave with the synchronous replay itself,
      // but a listener may synchronously enqueue more work. Drain to a stable
      // revision before making this consumer eligible for live delivery.
      while (!consumer.disposed && this.connected) {
        const targetRevision: number = this.lastReceivedRevision
        for (const [revision, buffered] of [...this.history.entries()]
          .filter(([revision]) => revision > cursor && revision <= targetRevision)
          .sort(([left], [right]) => left - right)) {
          this.deliver(consumer, revision, buffered.event)
        }
        cursor = targetRevision
        consumer.lastRevision = targetRevision
        if (targetRevision === this.lastReceivedRevision) break
      }
      if (consumer.disposed || !this.connected) return
      consumer.retryAttempt = 0
      consumer.ready = true
      this.pruneHistory()
    } catch (reason) {
      if (consumer.disposed) return
      consumer.retryAttempt += 1
      this.reportError(consumer, reason)
      this.scheduleConsumerRetry(consumer)
    } finally {
      consumer.syncing = false
      consumer.retentionRevision = undefined
      this.pruneHistory()
      if (!consumer.disposed && !consumer.ready && this.connected && !consumer.retryTimer) {
        this.scheduleConsumerRetry(consumer)
      }
    }
  }

  private scheduleConsumerRetry(consumer: AgentEventConsumer): void {
    if (consumer.disposed || consumer.retryTimer) return
    const delay = Math.min(
      maximumRetryDelayMs,
      retryDelayMs * (2 ** Math.max(0, consumer.retryAttempt - 1))
    )
    consumer.retryTimer = setTimeout(() => {
      consumer.retryTimer = undefined
      void this.synchronizeConsumer(consumer)
    }, delay)
  }

  private pruneHistory(): void {
    const activeConsumers = [...this.consumers].filter((consumer) => !consumer.disposed)
    const retentionRevisions = activeConsumers.flatMap((consumer) => {
      if (consumer.ready && consumer.lastRevision !== undefined) {
        return [consumer.lastRevision]
      }
      if (consumer.syncing && consumer.retentionRevision !== undefined) {
        return [consumer.retentionRevision]
      }
      return []
    })
    const deliveredThrough = retentionRevisions.length === 0
      ? this.lastReceivedRevision ?? -1
      : Math.min(...retentionRevisions)
    if (deliveredThrough < 0) return
    for (const [revision, buffered] of this.history) {
      if (
        revision <= deliveredThrough
        && (!buffered.runId || !this.activeRunIds.has(buffered.runId))
      ) {
        this.history.delete(revision)
      }
    }
    // Connection handshakes check receipt continuity using these revisions.
    // Compact only after that check, never while collecting its live suffix.
    if (this.connecting || !this.connected) return
    compactToolCallProgress(this.history)
    for (const [runId, revision] of this.runReplayStateRevisions) {
      if (!this.activeRunIds.has(runId) && revision <= deliveredThrough) {
        this.runReplayStateRevisions.delete(runId)
      }
    }
  }
}

const eventHubs = new WeakMap<object, AgentEventHub>()

export function subscribeAgentRuntimeEvents(
  ipc: AgentEventIpc,
  listener: (event: AgentRuntimeEvent) => void,
  options: AgentEventSubscriptionOptions = {}
): () => void {
  let hub = eventHubs.get(ipc as object)
  if (!hub) {
    hub = new AgentEventHub(ipc)
    eventHubs.set(ipc as object, hub)
  }
  return hub.add(listener, options)
}
