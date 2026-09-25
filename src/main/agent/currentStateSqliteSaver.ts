import type Database from 'better-sqlite3'
import { BaseMessage } from '@langchain/core/messages'
import type { RunnableConfig } from '@langchain/core/runnables'
import {
  BaseCheckpointSaver, WRITES_IDX_MAP, copyCheckpoint,
  type ChannelVersions, type Checkpoint, type CheckpointListOptions,
  type CheckpointMetadata, type CheckpointPendingWrite, type CheckpointTuple, type PendingWrite
} from '@langchain/langgraph-checkpoint'
import { CurrentStateMessageCodec, readMessageBody, readMessageBodySync, storedMessageData, type EncodedStateValue, type MessageBody, type MessageReference } from './currentStateMessageCodec'

export const currentStateSqliteSchema = `
  CREATE TABLE IF NOT EXISTS current_state (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,
    v INTEGER NOT NULL,
    ts TEXT NOT NULL,
    channel_versions_json TEXT NOT NULL,
    versions_seen_json TEXT NOT NULL,
    metadata_type TEXT NOT NULL,
    metadata BLOB NOT NULL,
    PRIMARY KEY (thread_id, checkpoint_ns)
  );
  CREATE TABLE IF NOT EXISTS message_bodies (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,
    record_id TEXT NOT NULL,
    message_id TEXT,
    type TEXT NOT NULL,
    value BLOB NOT NULL,
    UNIQUE (thread_id, record_id)
  );
  CREATE INDEX IF NOT EXISTS message_bodies_message_id ON message_bodies(thread_id, message_id);
  CREATE TABLE IF NOT EXISTS state_channels (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL,
    channel TEXT NOT NULL,
    type TEXT NOT NULL,
    value BLOB NOT NULL,
    refs_json TEXT NOT NULL,
    PRIMARY KEY (thread_id, checkpoint_ns, channel),
    FOREIGN KEY (thread_id, checkpoint_ns) REFERENCES current_state(thread_id, checkpoint_ns) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS state_messages (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL,
    position INTEGER NOT NULL,
    record_id TEXT NOT NULL,
    PRIMARY KEY (thread_id, checkpoint_ns, position),
    FOREIGN KEY (thread_id, checkpoint_ns) REFERENCES current_state(thread_id, checkpoint_ns) ON DELETE CASCADE,
    FOREIGN KEY (thread_id, record_id) REFERENCES message_bodies(thread_id, record_id)
  );
  CREATE TABLE IF NOT EXISTS pending_writes (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL,
    checkpoint_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    channel TEXT NOT NULL,
    type TEXT NOT NULL,
    value BLOB NOT NULL,
    refs_json TEXT NOT NULL,
    PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
  );
  CREATE INDEX IF NOT EXISTS state_messages_body ON state_messages(thread_id, record_id);
  CREATE TABLE IF NOT EXISTS message_references (
    thread_id TEXT NOT NULL,
    checkpoint_ns TEXT NOT NULL,
    owner_kind TEXT NOT NULL CHECK (owner_kind IN ('channel', 'write', 'activity')),
    owner_key TEXT NOT NULL,
    record_id TEXT NOT NULL,
    PRIMARY KEY (thread_id, checkpoint_ns, owner_kind, owner_key, record_id),
    FOREIGN KEY (thread_id, record_id) REFERENCES message_bodies(thread_id, record_id)
  );
  CREATE INDEX IF NOT EXISTS message_references_body ON message_references(thread_id, record_id);
`

export interface CurrentStateHead {
  threadId: string
  namespace: string
  checkpointId: string
  version: number
  timestamp: string
  channelVersions: ChannelVersions
  versionsSeen: Checkpoint['versions_seen']
  metadata: CheckpointMetadata
}

export interface CurrentMessageRecord extends MessageBody { position?: number }
export interface MessageWindow { namespace?: string; offset?: number; limit?: number; reverse?: boolean }
export interface PendingWriteRow {
  checkpoint_id: string
  task_id: string
  idx: number
  channel: string
  type: string
  value: Uint8Array
  refs_json: string
}

export interface CurrentStateSqliteSaverOptions {
  onCheckpoint?: (config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata, newVersions: ChannelVersions) => void
  onWrites?: (config: RunnableConfig, writes: PendingWrite[], taskId: string) => void
}

type HeadRow = {
  thread_id: string; checkpoint_ns: string; checkpoint_id: string; v: number; ts: string
  channel_versions_json: string; versions_seen_json: string; metadata_type: string; metadata: Uint8Array
}
type ChannelRow = { channel: string; type: string; value: Uint8Array; refs_json: string }
type BodyRow = { record_id: string; message_id: string | null; type: string; value: Uint8Array; position?: number }
type RetainedThread = { codec: CurrentStateMessageCodec; tuples: Map<string, CheckpointTuple> }

function scope(config: RunnableConfig): { threadId: string; namespace: string; checkpointId?: string } {
  const threadId = config.configurable?.thread_id
  const namespace = config.configurable?.checkpoint_ns ?? ''
  const checkpointId = config.configurable?.checkpoint_id
  if (typeof threadId !== 'string' || !threadId) throw new Error('Current state requires a thread_id.')
  if (typeof namespace !== 'string') throw new Error('Current state checkpoint_ns must be a string.')
  if (checkpointId !== undefined && (typeof checkpointId !== 'string' || !checkpointId)) throw new Error('Invalid checkpoint_id.')
  return { threadId, namespace, checkpointId }
}

function encoded(row: { type: string; value: Uint8Array; refs_json: string }): EncodedStateValue {
  return { type: row.type, value: row.value, references: JSON.parse(row.refs_json) as MessageReference[] }
}

function bodyRecord(row: BodyRow): CurrentMessageRecord {
  return { recordId: row.record_id, messageId: row.message_id, type: row.type, value: row.value,
    ...(row.position === undefined ? {} : { position: row.position }) }
}

function tupleCopy(tuple: CheckpointTuple, codec: CurrentStateMessageCodec): CheckpointTuple {
  return {
    config: { configurable: { ...tuple.config.configurable } },
    checkpoint: { ...copyCheckpoint(tuple.checkpoint), channel_values: codec.copyForRead(tuple.checkpoint.channel_values) },
    metadata: tuple.metadata ? structuredClone(tuple.metadata) : undefined,
    pendingWrites: codec.copyForRead(tuple.pendingWrites)
  }
}

/** Current-only, framework-native state storage. Complete message bodies are shared by current channels and task inputs. */
export class CurrentStateSqliteSaver extends BaseCheckpointSaver {
  private queue: Promise<unknown> = Promise.resolve()
  private readonly retainedRuns = new Map<string, string>()
  private readonly retainedThreads = new Map<string, RetainedThread>()
  private activeOperations = 0
  private encodedBytes = 0
  private commitDepth = 0

  constructor(private readonly database: Database.Database, private readonly options: CurrentStateSqliteSaverOptions = {}) {
    super()
    this.initialize()
  }

  initialize(): void { this.database.exec(currentStateSqliteSchema) }

  retainRun(runId: string, threadId: string): void {
    if (!runId || !threadId) throw new Error('Retained runs require run and thread IDs.')
    const existing = this.retainedRuns.get(runId)
    if (existing && existing !== threadId) throw new Error('A retained run cannot change threads.')
    this.retainedRuns.set(runId, threadId)
    if (!this.retainedThreads.has(threadId)) this.retainedThreads.set(threadId, this.newRetainedThread())
  }

  async releaseRun(runId: string): Promise<void> {
    await this.serial(async () => {
      const threadId = this.retainedRuns.get(runId)
      this.retainedRuns.delete(runId)
      if (threadId && ![...this.retainedRuns.values()].includes(threadId)) {
        this.commitTransaction(() => {
          const unused = this.database.prepare(`SELECT w.checkpoint_ns,w.checkpoint_id,w.task_id,w.idx
            FROM pending_writes w WHERE w.thread_id = ? AND NOT EXISTS (
              SELECT 1 FROM current_state c WHERE c.thread_id = w.thread_id
              AND c.checkpoint_ns = w.checkpoint_ns AND c.checkpoint_id = w.checkpoint_id
            )`).all(threadId) as Array<{ checkpoint_ns: string; checkpoint_id: string; task_id: string; idx: number }>
          for (const row of unused) {
            this.replaceReferences(threadId, row.checkpoint_ns, 'write', JSON.stringify([row.checkpoint_id, row.task_id, row.idx]), [])
            this.database.prepare('DELETE FROM pending_writes WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ? AND task_id = ? AND idx = ?').run(threadId, row.checkpoint_ns, row.checkpoint_id, row.task_id, row.idx)
          }
          this.collectBodies(threadId)
        })
        this.retainedThreads.delete(threadId)
      }
    })
  }

  hasRetainedRun(threadId: string): boolean { return [...this.retainedRuns.values()].includes(threadId) }
  async flush(): Promise<void> { await this.queue }
  get encodedMessageBytes(): number { return this.encodedBytes }

  private newRetainedThread(): RetainedThread { return { codec: new CurrentStateMessageCodec(this.serde), tuples: new Map() } }
  private context(threadId: string): RetainedThread { return this.retainedThreads.get(threadId) ?? this.newRetainedThread() }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    this.activeOperations += 1
    const result = this.queue.then(operation)
    this.queue = result.catch(() => undefined).finally(() => { this.activeOperations -= 1 })
    return result
  }

  private resetRetained(threadId: string): void {
    if (this.retainedThreads.has(threadId)) this.retainedThreads.set(threadId, this.newRetainedThread())
  }

  private commitTransaction<T>(operation: () => T): T {
    return this.database.transaction(() => {
      this.commitDepth += 1
      try { return operation() } finally { this.commitDepth -= 1 }
    })()
  }

  getCurrentHead(threadId: string, namespace = ''): CurrentStateHead | undefined {
    const row = this.database.prepare('SELECT * FROM current_state WHERE thread_id = ? AND checkpoint_ns = ?').get(threadId, namespace) as HeadRow | undefined
    if (!row) return undefined
    if (row.metadata_type !== 'json') throw new Error('Current checkpoint metadata must use JSON.')
    return {
      threadId: row.thread_id, namespace: row.checkpoint_ns, checkpointId: row.checkpoint_id,
      version: row.v, timestamp: row.ts,
      channelVersions: JSON.parse(row.channel_versions_json) as ChannelVersions,
      versionsSeen: JSON.parse(row.versions_seen_json) as Checkpoint['versions_seen'],
      metadata: JSON.parse(Buffer.from(row.metadata).toString('utf8')) as CheckpointMetadata
    }
  }

  getPendingWriteIdentities(threadId: string, namespace = ''): Array<{ task_id: string; channel: string }> {
    return this.database.prepare(`
      SELECT w.task_id, w.channel FROM pending_writes w JOIN current_state c
        ON c.thread_id = w.thread_id AND c.checkpoint_ns = w.checkpoint_ns AND c.checkpoint_id = w.checkpoint_id
      WHERE w.thread_id = ? AND w.checkpoint_ns = ? ORDER BY w.task_id, w.idx
    `).all(threadId, namespace) as Array<{ task_id: string; channel: string }>
  }

  getPendingWriteRows(threadId: string, namespace = '', channels?: readonly string[]): PendingWriteRow[] {
    if (channels?.length === 0) return []
    const filter = channels ? ` AND w.channel IN (${channels.map(() => '?').join(',')})` : ''
    return this.database.prepare(`
      SELECT w.checkpoint_id, w.task_id, w.idx, w.channel, w.type, w.value, w.refs_json
      FROM pending_writes w JOIN current_state c
        ON c.thread_id = w.thread_id AND c.checkpoint_ns = w.checkpoint_ns AND c.checkpoint_id = w.checkpoint_id
      WHERE w.thread_id = ? AND w.checkpoint_ns = ? ${filter}
      ORDER BY w.task_id, w.idx
    `).all(threadId, namespace, ...(channels ?? [])) as PendingWriteRow[]
  }

  async getPendingWrites(threadId: string, namespace = '', channels?: readonly string[]): Promise<CheckpointPendingWrite[]> {
    return this.serial(async () => {
      const context = this.context(threadId)
      const cached = context.tuples.get(namespace)
      if (cached) return context.codec.copyForRead((cached.pendingWrites ?? []).filter(([, channel]) => !channels || channels.includes(channel)))
      return this.decodeWrites(threadId, this.getPendingWriteRows(threadId, namespace, channels), context.codec)
    })
  }

  countMessages(threadId: string, namespace = ''): number {
    return (this.database.prepare('SELECT count(*) AS count FROM state_messages WHERE thread_id = ? AND checkpoint_ns = ?').get(threadId, namespace) as { count: number }).count
  }

  readMessageRecords(threadId: string, window: MessageWindow = {}): CurrentMessageRecord[] {
    const offset = window.offset ?? 0
    const limit = window.limit ?? 100
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 0) throw new Error('Invalid message window.')
    return (this.database.prepare(`
      SELECT b.record_id, b.message_id, b.type, b.value, s.position
      FROM state_messages s JOIN message_bodies b ON b.thread_id = s.thread_id AND b.record_id = s.record_id
      WHERE s.thread_id = ? AND s.checkpoint_ns = ?
      ORDER BY s.position ${window.reverse ? 'DESC' : 'ASC'} LIMIT ? OFFSET ?
    `).all(threadId, window.namespace ?? '', limit, offset) as BodyRow[]).map(bodyRecord)
  }

  getMessageRecord(threadId: string, messageId: string, namespace = ''): CurrentMessageRecord | undefined {
    const row = this.database.prepare(`
      SELECT b.record_id, b.message_id, b.type, b.value, s.position
      FROM state_messages s JOIN message_bodies b ON b.thread_id = s.thread_id AND b.record_id = s.record_id
      WHERE s.thread_id = ? AND s.checkpoint_ns = ? AND b.message_id = ? ORDER BY s.position DESC LIMIT 1
    `).get(threadId, namespace, messageId) as BodyRow | undefined
    return row ? bodyRecord(row) : undefined
  }

  getLatestMessageRecord(threadId: string, messageId: string): CurrentMessageRecord | undefined {
    const row = this.database.prepare('SELECT record_id,message_id,type,value FROM message_bodies WHERE thread_id = ? AND message_id = ? ORDER BY sequence DESC LIMIT 1').get(threadId, messageId) as BodyRow | undefined
    return row ? bodyRecord(row) : undefined
  }

  getMessageRecordById(threadId: string, recordId: string): CurrentMessageRecord | undefined {
    const row = this.database.prepare('SELECT record_id,message_id,type,value FROM message_bodies WHERE thread_id = ? AND record_id = ?').get(threadId, recordId) as BodyRow | undefined
    return row ? bodyRecord(row) : undefined
  }

  getStoredMessageData(record: MessageBody): ReturnType<typeof storedMessageData> { return storedMessageData(record) }
  readMessageRecordSync(record: MessageBody): BaseMessage { return readMessageBodySync(record) }

  async readMessages(threadId: string, window: MessageWindow = {}): Promise<BaseMessage[]> {
    return this.serial(async () => {
      const context = this.context(threadId)
      const records = this.readMessageRecords(threadId, window)
      return Promise.all(records.map((body) => this.decodeMessage(body, context.codec)))
    })
  }

  async getMessage(threadId: string, messageId: string, namespace = ''): Promise<BaseMessage | undefined> {
    return this.serial(async () => {
      const record = this.getMessageRecord(threadId, messageId, namespace)
      return record ? this.decodeMessage(record, this.context(threadId).codec) : undefined
    })
  }

  async getMessageByRecordId(threadId: string, recordId: string): Promise<BaseMessage | undefined> {
    return this.serial(async () => {
      const body = this.getMessageRecordById(threadId, recordId)
      return body ? this.decodeMessage(body, this.context(threadId).codec) : undefined
    })
  }

  async saveReferencedValue(threadId: string, value: unknown, ownerKey: string, namespace = '', commit?: (encoded: EncodedStateValue) => void): Promise<EncodedStateValue> {
    if (!threadId || !ownerKey) throw new Error('A referenced value requires its thread and owner.')
    return this.serial(async () => {
      const context = this.context(threadId)
      const beforeBytes = context.codec.encodedMessageBytes
      try {
        const result = await context.codec.encode(value)
        this.commitTransaction(() => {
          this.persistBodies(threadId, context.codec)
          this.replaceReferences(threadId, namespace, 'activity', ownerKey, result.references.flatMap((reference) => reference.records))
          commit?.(result)
          this.collectBodies(threadId)
        })
        return result
      } catch (error) { this.resetRetained(threadId); throw error }
      finally { this.encodedBytes += context.codec.encodedMessageBytes - beforeBytes; context.codec.preparedBodies.clear() }
    })
  }

  async readReferencedValue(threadId: string, value: EncodedStateValue): Promise<unknown> {
    return this.serial(async () => {
      const context = this.context(threadId)
      return context.codec.decode(value, (ids) => this.loadBodies(threadId, ids, context.codec))
    })
  }

  async readChannel(threadId: string, channel: string, namespace = ''): Promise<unknown> {
    return this.serial(async () => {
      const context = this.context(threadId)
      const cached = context.tuples.get(namespace)
      if (cached) return context.codec.copyForRead(cached.checkpoint.channel_values[channel])
      const row = this.database.prepare('SELECT channel,type,value,refs_json FROM state_channels WHERE thread_id = ? AND checkpoint_ns = ? AND channel = ?').get(threadId, namespace, channel) as ChannelRow | undefined
      if (!row) return undefined
      if (row.type === 'messages') return this.loadCurrentMessages(threadId, namespace, context.codec)
      return context.codec.decode(encoded(row), (ids) => this.loadBodies(threadId, ids, context.codec))
    })
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { threadId, namespace, checkpointId } = scope(config)
    return this.serial(async () => {
      const context = this.context(threadId)
      const cached = context.tuples.get(namespace)
      if (cached) return !checkpointId || cached.checkpoint.id === checkpointId ? tupleCopy(cached, context.codec) : undefined
      const head = this.getCurrentHead(threadId, namespace)
      if (!head || (checkpointId && head.checkpointId !== checkpointId)) return undefined
      const channelValues: Record<string, unknown> = {}
      const rows = this.database.prepare('SELECT channel,type,value,refs_json FROM state_channels WHERE thread_id = ? AND checkpoint_ns = ?').all(threadId, namespace) as ChannelRow[]
      for (const row of rows) {
        channelValues[row.channel] = row.type === 'messages'
          ? await this.loadCurrentMessages(threadId, namespace, context.codec)
          : await context.codec.decode(encoded(row), (ids) => this.loadBodies(threadId, ids, context.codec))
      }
      const tuple: CheckpointTuple = {
        config: { configurable: { thread_id: threadId, checkpoint_ns: namespace, checkpoint_id: head.checkpointId } },
        checkpoint: { v: head.version, id: head.checkpointId, ts: head.timestamp, channel_values: channelValues,
          channel_versions: head.channelVersions, versions_seen: head.versionsSeen },
        metadata: head.metadata,
        pendingWrites: await this.decodeWrites(threadId, this.getPendingWriteRows(threadId, namespace), context.codec)
      }
      if (this.retainedThreads.has(threadId)) context.tuples.set(namespace, {
        ...tuple, checkpoint: { ...tuple.checkpoint, channel_values: context.codec.capture(channelValues) },
        pendingWrites: context.codec.capture(tuple.pendingWrites)
      })
      return tuple
    })
  }

  async *list(config: RunnableConfig, options: CheckpointListOptions = {}): AsyncGenerator<CheckpointTuple> {
    await this.flush()
    const where: string[] = []
    const args: unknown[] = []
    if (config.configurable?.thread_id !== undefined) { where.push('thread_id = ?'); args.push(config.configurable.thread_id) }
    if (config.configurable?.checkpoint_ns !== undefined) { where.push('checkpoint_ns = ?'); args.push(config.configurable.checkpoint_ns) }
    if (config.configurable?.checkpoint_id !== undefined) { where.push('checkpoint_id = ?'); args.push(config.configurable.checkpoint_id) }
    const rows = this.database.prepare(`SELECT thread_id,checkpoint_ns,checkpoint_id FROM current_state ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY checkpoint_id DESC`).all(...args) as Array<{ thread_id: string; checkpoint_ns: string; checkpoint_id: string }>
    let count = 0
    for (const row of rows) {
      if (options.limit !== undefined && count >= options.limit) return
      if (options.before?.configurable?.checkpoint_id && row.checkpoint_id >= options.before.configurable.checkpoint_id) continue
      const tuple = await this.getTuple({ configurable: row })
      if (!tuple || (options.filter && Object.entries(options.filter).some(([key, value]) => JSON.stringify(tuple.metadata?.[key as keyof CheckpointMetadata]) !== JSON.stringify(value)))) continue
      count += 1
      yield tuple
    }
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata, newVersions: ChannelVersions = checkpoint.channel_versions): Promise<RunnableConfig> {
    return this.putCurrent(config, checkpoint, metadata, newVersions)
  }

  async replaceCurrentState(threadId: string, checkpoint: Checkpoint, metadata: CheckpointMetadata, commit: () => void): Promise<void> {
    await this.putCurrent({ configurable: { thread_id: threadId, checkpoint_ns: '' } }, checkpoint, metadata, checkpoint.channel_versions, commit)
  }

  private async putCurrent(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata, newVersions: ChannelVersions, replace?: () => void): Promise<RunnableConfig> {
    const { threadId, namespace } = scope(config)
    return this.serial(async () => {
      const context = this.context(threadId)
      const beforeBytes = context.codec.encodedMessageBytes
      try {
        const existing = this.getCurrentHead(threadId, namespace)
        const channels = new Map<string, EncodedStateValue>()
        let messageIds: string[] | undefined
        // Messages are reconciled by identity even if a caller omits newVersions.
        // Other channels use the framework's explicit channel-version contract.
        for (const [name, value] of Object.entries(checkpoint.channel_values)) {
          if (name === 'messages' && Array.isArray(value) && value.every(BaseMessage.isInstance)) {
            messageIds = []
            for (const message of value) messageIds.push((await context.codec.message(message)).recordId)
            channels.set(name, { type: 'messages', value: new Uint8Array(), references: [] })
          } else if (replace || !existing || name in newVersions || !(name in existing.channelVersions)) channels.set(name, await context.codec.encode(value))
        }
        const [metadataType, metadataValue] = await this.serde.dumpsTyped(metadata)
        if (metadataType !== 'json') throw new Error('Checkpoint metadata must be JSON.')
        this.commitTransaction(() => {
          this.persistBodies(threadId, context.codec)
          if (replace) this.clearStateRows(threadId)
          this.database.prepare(`INSERT INTO current_state
            (thread_id,checkpoint_ns,checkpoint_id,v,ts,channel_versions_json,versions_seen_json,metadata_type,metadata)
            VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(thread_id,checkpoint_ns) DO UPDATE SET
            checkpoint_id=excluded.checkpoint_id,v=excluded.v,ts=excluded.ts,channel_versions_json=excluded.channel_versions_json,
            versions_seen_json=excluded.versions_seen_json,metadata_type=excluded.metadata_type,metadata=excluded.metadata
          `).run(threadId, namespace, checkpoint.id, checkpoint.v, checkpoint.ts, JSON.stringify(checkpoint.channel_versions), JSON.stringify(checkpoint.versions_seen), metadataType, metadataValue)
          const previousChannels = this.database.prepare('SELECT channel FROM state_channels WHERE thread_id = ? AND checkpoint_ns = ?').all(threadId, namespace) as Array<{ channel: string }>
          for (const { channel } of previousChannels) if (!(channel in checkpoint.channel_values)) {
            this.database.prepare('DELETE FROM state_channels WHERE thread_id = ? AND checkpoint_ns = ? AND channel = ?').run(threadId, namespace, channel)
            this.replaceReferences(threadId, namespace, 'channel', channel, [])
          }
          for (const [channel, value] of channels) {
            this.database.prepare(`INSERT INTO state_channels(thread_id,checkpoint_ns,channel,type,value,refs_json) VALUES (?,?,?,?,?,?)
              ON CONFLICT(thread_id,checkpoint_ns,channel) DO UPDATE SET type=excluded.type,value=excluded.value,refs_json=excluded.refs_json
            `).run(threadId, namespace, channel, value.type, value.value, JSON.stringify(value.references))
            this.replaceReferences(threadId, namespace, 'channel', channel, value.references.flatMap((ref) => ref.records))
          }
          this.reconcileMessages(threadId, namespace, messageIds ?? [])
          this.removePreviousWrites(threadId, namespace, checkpoint.id, [existing?.checkpointId, config.configurable?.checkpoint_id])
          replace?.()
          this.options.onCheckpoint?.(config, checkpoint, metadata, newVersions)
          this.collectBodies(threadId)
        })
        const sameHeadWrites = !replace && context.tuples.get(namespace)?.checkpoint.id === checkpoint.id
          ? context.tuples.get(namespace)?.pendingWrites : undefined
        if (replace) context.tuples.clear()
        if (this.retainedThreads.has(threadId)) context.tuples.set(namespace, {
          config: { configurable: { thread_id: threadId, checkpoint_ns: namespace, checkpoint_id: checkpoint.id } },
          checkpoint: { ...copyCheckpoint(checkpoint), channel_values: context.codec.capture(checkpoint.channel_values) }, metadata: structuredClone(metadata),
          pendingWrites: sameHeadWrites ?? context.codec.capture(await this.decodeWrites(threadId, this.getPendingWriteRows(threadId, namespace), context.codec))
        })
        return { configurable: { thread_id: threadId, checkpoint_ns: namespace, checkpoint_id: checkpoint.id } }
      } catch (error) { this.resetRetained(threadId); throw error }
      finally { this.encodedBytes += context.codec.encodedMessageBytes - beforeBytes; context.codec.preparedBodies.clear() }
    })
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const { threadId, namespace, checkpointId } = scope(config)
    if (!checkpointId || !taskId) throw new Error('Pending writes require checkpoint and task IDs.')
    return this.serial(async () => {
      const context = this.context(threadId)
      const beforeBytes = context.codec.encodedMessageBytes
      try {
        // LangGraph chains put calls separately from putWrites. A task write
        // can arrive before its head has committed, even with sync durability.
        // Preserve those current task updates until their matching put arrives.
        const allSpecial = writes.every(([channel]) => channel in WRITES_IDX_MAP)
        const cached = context.tuples.get(namespace)
        const previousValues = new Map<string, CheckpointPendingWrite>()
        if (cached?.checkpoint.id === checkpointId) {
          for (const [index, row] of this.getPendingWriteRows(threadId, namespace).entries()) {
            const value = cached.pendingWrites?.[index]
            if (value) previousValues.set(JSON.stringify([row.task_id, row.idx]), value)
          }
        }
        const prepared: Array<{ idx: number; channel: string; value: EncodedStateValue }> = []
        for (const [index, [channel, value]] of writes.entries()) prepared.push({ idx: WRITES_IDX_MAP[channel] ?? index, channel, value: await context.codec.encode(value) })
        const committed = new Map<number, PendingWrite>()
        this.commitTransaction(() => {
          this.persistBodies(threadId, context.codec)
          for (const row of prepared) {
            const result = this.database.prepare(`INSERT ${allSpecial ? 'OR REPLACE' : 'OR IGNORE'} INTO pending_writes
              (thread_id,checkpoint_ns,checkpoint_id,task_id,idx,channel,type,value,refs_json) VALUES (?,?,?,?,?,?,?,?,?)
            `).run(threadId, namespace, checkpointId, taskId, row.idx, row.channel, row.value.type, row.value.value, JSON.stringify(row.value.references))
            if (result.changes) {
              this.replaceReferences(threadId, namespace, 'write', JSON.stringify([checkpointId, taskId, row.idx]), row.value.references.flatMap((ref) => ref.records))
              const sourceIndex = prepared.indexOf(row)
              committed.set(row.idx, writes[sourceIndex])
            }
          }
          this.options.onWrites?.(config, writes, taskId)
          this.collectBodies(threadId)
        })
        if (cached?.checkpoint.id === checkpointId) {
          // Capture only newly committed values. Existing task inputs already
          // have storage-owned snapshots and never need to reload their bodies.
          const existingRows = this.getPendingWriteRows(threadId, namespace)
          cached.pendingWrites = existingRows.map((row) => {
            const updated = row.task_id === taskId ? committed.get(row.idx) : undefined
            if (updated) return [row.task_id, updated[0], context.codec.capture(updated[1])]
            const prior = previousValues.get(JSON.stringify([row.task_id, row.idx]))
            if (!prior) throw new Error('Current pending write is missing its retained framework value.')
            return prior
          })
        }
      } catch (error) { this.resetRetained(threadId); throw error }
      finally { this.encodedBytes += context.codec.encodedMessageBytes - beforeBytes; context.codec.preparedBodies.clear() }
    })
  }

  clearThreadCurrentStateSync(threadId: string): void {
    if (this.activeOperations && this.commitDepth === 0) throw new Error('Flush pending state operations before clearing a thread.')
    this.commitTransaction(() => {
      this.clearStateRows(threadId)
      this.collectBodies(threadId)
    })
    this.resetRetained(threadId)
  }

  deleteThreadSync(threadId: string): void {
    if (this.activeOperations && this.commitDepth === 0) throw new Error('Flush pending state operations before deleting a thread.')
    this.commitTransaction(() => {
      this.clearStateRows(threadId)
      this.database.prepare('DELETE FROM message_references WHERE thread_id = ?').run(threadId)
      this.database.prepare('DELETE FROM message_bodies WHERE thread_id = ?').run(threadId)
    })
    this.resetRetained(threadId)
  }
  async clearThreadCurrentState(threadId: string): Promise<void> { await this.flush(); this.clearThreadCurrentStateSync(threadId) }
  async deleteThread(threadId: string): Promise<void> { await this.flush(); this.deleteThreadSync(threadId) }

  private clearStateRows(threadId: string): void {
    this.database.prepare("DELETE FROM message_references WHERE thread_id = ? AND owner_kind <> 'activity'").run(threadId)
    this.database.prepare('DELETE FROM pending_writes WHERE thread_id = ?').run(threadId)
    this.database.prepare('DELETE FROM state_messages WHERE thread_id = ?').run(threadId)
    this.database.prepare('DELETE FROM state_channels WHERE thread_id = ?').run(threadId)
    this.database.prepare('DELETE FROM current_state WHERE thread_id = ?').run(threadId)
  }

  private persistBodies(threadId: string, codec: CurrentStateMessageCodec): void {
    const insert = this.database.prepare('INSERT OR IGNORE INTO message_bodies(thread_id,record_id,message_id,type,value) VALUES (?,?,?,?,?)')
    for (const body of codec.preparedBodies.values()) insert.run(threadId, body.recordId, body.messageId, body.type, body.value)
  }

  private reconcileMessages(threadId: string, namespace: string, ids: string[]): void {
    const previous = this.database.prepare('SELECT position,record_id FROM state_messages WHERE thread_id = ? AND checkpoint_ns = ? ORDER BY position').all(threadId, namespace) as Array<{ position: number; record_id: string }>
    const upsert = this.database.prepare(`INSERT INTO state_messages(thread_id,checkpoint_ns,position,record_id) VALUES (?,?,?,?)
      ON CONFLICT(thread_id,checkpoint_ns,position) DO UPDATE SET record_id=excluded.record_id`)
    for (const [position, id] of ids.entries()) if (previous[position]?.record_id !== id) upsert.run(threadId, namespace, position, id)
    if (previous.length > ids.length) this.database.prepare('DELETE FROM state_messages WHERE thread_id = ? AND checkpoint_ns = ? AND position >= ?').run(threadId, namespace, ids.length)
  }

  private replaceReferences(threadId: string, namespace: string, kind: 'channel' | 'write' | 'activity', key: string, ids: string[]): void {
    if (!ids.length) {
      this.database.prepare('DELETE FROM message_references WHERE thread_id = ? AND checkpoint_ns = ? AND owner_kind = ? AND owner_key = ?').run(threadId, namespace, kind, key)
      return
    }
    const previous = this.database.prepare('SELECT record_id FROM message_references WHERE thread_id = ? AND checkpoint_ns = ? AND owner_kind = ? AND owner_key = ?')
      .all(threadId, namespace, kind, key) as Array<{ record_id: string }>
    const additions = new Set(ids)
    const remove = this.database.prepare('DELETE FROM message_references WHERE thread_id = ? AND checkpoint_ns = ? AND owner_kind = ? AND owner_key = ? AND record_id = ?')
    for (const row of previous) {
      if (!additions.delete(row.record_id)) remove.run(threadId, namespace, kind, key, row.record_id)
    }
    const insert = this.database.prepare('INSERT INTO message_references(thread_id,checkpoint_ns,owner_kind,owner_key,record_id) VALUES (?,?,?,?,?)')
    for (const id of additions) insert.run(threadId, namespace, kind, key, id)
  }

  private removePreviousWrites(threadId: string, namespace: string, checkpointId: string, previous: Array<string | undefined>): void {
    const replaced = [...new Set(previous.filter((id): id is string => typeof id === 'string' && id !== checkpointId))]
    if (!replaced.length) return
    const placeholders = replaced.map(() => '?').join(',')
    const rows = this.database.prepare(`SELECT checkpoint_id,task_id,idx FROM pending_writes WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id IN (${placeholders})`).all(threadId, namespace, ...replaced) as Array<{ checkpoint_id: string; task_id: string; idx: number }>
    for (const row of rows) this.replaceReferences(threadId, namespace, 'write', JSON.stringify([row.checkpoint_id, row.task_id, row.idx]), [])
    this.database.prepare(`DELETE FROM pending_writes WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id IN (${placeholders})`).run(threadId, namespace, ...replaced)
  }

  private collectBodies(threadId: string): void {
    const removed = this.database.prepare(`DELETE FROM message_bodies AS b WHERE b.thread_id = ?
      AND NOT EXISTS(SELECT 1 FROM state_messages s WHERE s.thread_id = b.thread_id AND s.record_id = b.record_id)
      AND NOT EXISTS(SELECT 1 FROM message_references r WHERE r.thread_id = b.thread_id AND r.record_id = b.record_id)
      RETURNING record_id
    `).all(threadId) as Array<{ record_id: string }>
    this.retainedThreads.get(threadId)?.codec.forget(removed.map((row) => row.record_id))
  }

  private async decodeMessage(body: MessageBody, codec: CurrentStateMessageCodec): Promise<BaseMessage> {
    const message = await readMessageBody(body, this.serde)
    codec.remember(message, body)
    return message
  }

  private async loadBodies(threadId: string, ids: string[], codec: CurrentStateMessageCodec): Promise<Map<string, BaseMessage>> {
    const result = new Map<string, BaseMessage>()
    const missing: string[] = []
    for (const id of ids) {
      const cached = codec.recalled(id)
      if (cached) result.set(id, codec.copyForRead(cached))
      else missing.push(id)
    }
    // SQLite variable limits are bounded; each chunk is one query, not one query per message.
    for (let start = 0; start < missing.length; start += 500) {
      const chunk = missing.slice(start, start + 500)
      const rows = this.database.prepare(`SELECT record_id,message_id,type,value FROM message_bodies WHERE thread_id = ? AND record_id IN (${chunk.map(() => '?').join(',')})`).all(threadId, ...chunk) as BodyRow[]
      for (const row of rows) result.set(row.record_id, await this.decodeMessage(bodyRecord(row), codec))
    }
    return result
  }

  private async loadCurrentMessages(threadId: string, namespace: string, codec: CurrentStateMessageCodec): Promise<BaseMessage[]> {
    const rows = this.readMessageRecords(threadId, { namespace, limit: Number.MAX_SAFE_INTEGER })
    const messages: BaseMessage[] = []
    for (const row of rows) messages.push(await this.decodeMessage(row, codec))
    return messages
  }

  private async decodeWrites(threadId: string, rows: PendingWriteRow[], codec: CurrentStateMessageCodec): Promise<CheckpointPendingWrite[]> {
    const output: CheckpointPendingWrite[] = []
    for (const row of rows) output.push([row.task_id, row.channel, await codec.decode(encoded(row), (ids) => this.loadBodies(threadId, ids, codec))])
    return output
  }
}
