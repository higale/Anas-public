import { createHash, randomUUID } from 'node:crypto'
import { AIMessage, BaseMessage, ToolMessage, mapStoredMessageToChatMessage, type StoredMessage } from '@langchain/core/messages'
import * as NativeMessages from '@langchain/core/messages'
import { isDeepStrictEqual } from 'node:util'
import stableStringify from 'fast-json-stable-stringify'
import type { SerializerProtocol } from '@langchain/langgraph-checkpoint'

export interface MessageBody {
  recordId: string
  messageId: string | null
  type: string
  value: Uint8Array
}

export interface MessageReference {
  path: Array<string | number>
  records: string[]
  array?: true
  toolCallIndex?: number
}

export interface EncodedStateValue {
  type: string
  value: Uint8Array
  references: MessageReference[]
}

type MessageEnvelope = { messageType: string; message: BaseMessage; artifact?: unknown }

function messageEnvelope(message: BaseMessage): MessageEnvelope {
  if (!ToolMessage.isInstance(message) || message.artifact === undefined) return { messageType: message.getType(), message }
  // Serializable.toJSON traverses an artifact before JsonPlus sees it, losing
  // typed arrays/Map/Set. Keep the artifact alongside its message in the SAME
  // body record, so JsonPlus handles it once using its native value codec.
  const withoutArtifact = Object.assign(Object.create(Object.getPrototypeOf(message)), message, {
    artifact: undefined, lc_kwargs: { ...message.lc_kwargs, artifact: undefined }
  }) as BaseMessage
  return { messageType: message.getType(), message: withoutArtifact, artifact: message.artifact }
}

function reviveStoredValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reviveStoredValue)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  if (Object.keys(record).length === 1 && '__lc_escaped__' in record) return record.__lc_escaped__
  if (record.lc === 2 && record.type === 'undefined') return undefined
  if (record.lc === 2 && record.type === 'constructor' && Array.isArray(record.id) && record.id.length === 1 && Array.isArray(record.args)) {
    const args = record.args.map(reviveStoredValue)
    if (record.id[0] === 'Uint8Array' && Array.isArray(args[0])) return Uint8Array.from(args[0] as number[])
    if (record.id[0] === 'Set' && Array.isArray(args[0])) return new Set(args[0])
    if (record.id[0] === 'Map' && Array.isArray(args[0])) return new Map(args[0] as Array<[unknown, unknown]>)
    if (record.id[0] === 'RegExp' && typeof args[0] === 'string' && typeof args[1] === 'string') return new RegExp(args[0], args[1])
    if (record.id[0] === 'Error' && typeof args[0] === 'string') return new Error(args[0])
  }
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, reviveStoredValue(child)]))
}

/** Synchronous native-message projection for bounded UI reads, without loading a whole state. */
export function storedMessageData(body: MessageBody): StoredMessage {
  if (body.type !== 'json') throw new Error('A complete message body must use JSON encoding.')
  const envelope = JSON.parse(Buffer.from(body.value).toString('utf8')) as {
    messageType: string; message: { lc?: number; type?: string; kwargs?: unknown }; artifact?: unknown
  }
  if (!envelope.messageType || envelope.message?.lc !== 1 || envelope.message.type !== 'constructor' || !envelope.message.kwargs) {
    throw new Error('Invalid complete message body.')
  }
  const data = reviveStoredValue(envelope.message.kwargs) as StoredMessage['data']
  if ('artifact' in envelope) (data as unknown as Record<string, unknown>).artifact = reviveStoredValue(envelope.artifact)
  return { type: envelope.messageType, data }
}

export function readMessageBodySync(body: MessageBody): BaseMessage {
  const stored = storedMessageData(body)
  const envelope = JSON.parse(Buffer.from(body.value).toString('utf8')) as { message: { id?: string[] } }
  const name = envelope.message.id?.at(-1)
  const constructor = name ? (NativeMessages as unknown as Record<string, unknown>)[name] : undefined
  if (typeof constructor === 'function' && Object.prototype.isPrototypeOf.call(BaseMessage.prototype, constructor.prototype)) {
    return Reflect.construct(constructor, [stored.data]) as BaseMessage
  }
  return mapStoredMessageToChatMessage(stored)
}

export async function readMessageBody(body: MessageBody, serde: SerializerProtocol): Promise<BaseMessage> {
  const envelope = await serde.loadsTyped(body.type, body.value) as MessageEnvelope
  if (!BaseMessage.isInstance(envelope.message)) throw new Error('Stored body did not restore a native message.')
  if ('artifact' in envelope) {
    if (!ToolMessage.isInstance(envelope.message)) throw new Error('Only tool result messages can own an artifact.')
    envelope.message.artifact = envelope.artifact
    envelope.message.lc_kwargs.artifact = envelope.artifact
  }
  return envelope.message
}

type CachedMessage = {
  body: Omit<MessageBody, 'value'>
  snapshot: BaseMessage
}

// Structured cloning drops native message/Send prototypes. Copy their data
// without calling constructors, which may mutate supplied content arrays.
// Strings remain shared immutable values; large text/base64 is never encoded
// again just to compare or copy a previously submitted message.
function copyValue<T>(value: T, messageCopy?: (message: BaseMessage) => BaseMessage, copied = new WeakMap<object, unknown>()): T {
  if (!value || typeof value !== 'object') return value
  if (copied.has(value)) return copied.get(value) as T
  if (messageCopy && BaseMessage.isInstance(value)) {
    const result = messageCopy(value)
    copied.set(value, result)
    return result as T
  }
  if (Buffer.isBuffer(value)) return Buffer.from(value) as T
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return structuredClone(value)
  if (value instanceof Date) return new Date(value.getTime()) as T
  if (value instanceof RegExp) {
    const result = new RegExp(value.source, value.flags)
    result.lastIndex = value.lastIndex
    return result as T
  }
  if (value instanceof Map) {
    const result = new Map()
    copied.set(value, result)
    for (const [key, item] of value) result.set(copyValue(key, messageCopy, copied), copyValue(item, messageCopy, copied))
    return result as T
  }
  if (value instanceof Set) {
    const result = new Set()
    copied.set(value, result)
    for (const item of value) result.add(copyValue(item, messageCopy, copied))
    return result as T
  }
  const result = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value))
  copied.set(value, result)
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    Object.defineProperty(result, key, {
      value: copyValue(Reflect.get(value, key), messageCopy, copied),
      enumerable: descriptor.enumerable, writable: true, configurable: true
    })
  }
  if (Array.isArray(value)) result.length = value.length
  return result
}

/** References are out-of-band paths, so provider content can never be mistaken for a storage marker. */
export class CurrentStateMessageCodec {
  private readonly messages = new WeakMap<BaseMessage, CachedMessage>()
  private readonly calls = new WeakMap<object, { message: BaseMessage; index: number }>()
  private readonly decoded = new Map<string, WeakRef<BaseMessage>>()
  readonly preparedBodies = new Map<string, MessageBody>()
  encodedMessageBytes = 0

  constructor(private readonly serde: SerializerProtocol) {}

  private registerCalls(message: BaseMessage): void {
    if (!AIMessage.isInstance(message)) return
    for (const [index, call] of (message.tool_calls ?? []).entries()) this.calls.set(call, { message, index })
  }

  remember(message: BaseMessage, body: MessageBody): void {
    const snapshot = copyValue(message)
    const cached = { body: { recordId: body.recordId, messageId: body.messageId, type: body.type }, snapshot }
    this.decoded.set(body.recordId, new WeakRef(snapshot))
    this.messages.set(message, cached)
    this.messages.set(snapshot, cached)
    this.registerCalls(message)
    this.registerCalls(snapshot)
  }

  /** Capture already encoded messages; only storage may own these snapshots. */
  capture<T>(value: T): T {
    return copyValue(value, (message) => this.messages.get(message)?.snapshot ?? copyValue(message))
  }

  /** Return mutable native instances while preserving their encoding-cache identity. */
  copyForRead<T>(value: T): T {
    return copyValue(value, (message) => {
      const result = copyValue(message)
      const cached = this.messages.get(message)
      if (cached) this.messages.set(result, cached)
      this.registerCalls(result)
      return result
    })
  }

  recalled(recordId: string): BaseMessage | undefined { return this.decoded.get(recordId)?.deref() }

  forget(recordIds: string[]): void {
    for (const id of recordIds) this.decoded.delete(id)
  }

  async message(message: BaseMessage): Promise<Omit<MessageBody, 'value'>> {
    // The native reducer assigns missing IDs too. Assign before pending-write
    // serialization so a completed tool result keeps the same identity when
    // it is later incorporated into the messages channel or resumed.
    if (!message.id) { message.id = randomUUID(); message.lc_kwargs.id = message.id }
    const cached = this.messages.get(message)
    if (cached && this.decoded.has(cached.body.recordId)
      && isDeepStrictEqual(message, cached.snapshot)) return cached.body
    const [type, encoded] = await this.serde.dumpsTyped(messageEnvelope(message))
    // Native constructors can restore kwargs in a different property order.
    // Normalize the already serialized JSON so the same complete message keeps
    // its body identity after a disk round trip, including mutable artifacts.
    const value = type === 'json'
      ? new Uint8Array(Buffer.from(stableStringify(JSON.parse(Buffer.from(encoded).toString('utf8')))))
      : new Uint8Array(encoded)
    const recordId = createHash('sha256').update(type).update('\0').update(value).digest('base64url')
    const body = { recordId, messageId: message.id ?? null, type, value }
    this.encodedMessageBytes += value.byteLength
    this.preparedBodies.set(recordId, body)
    this.remember(message, body)
    return body
  }

  async encode(value: unknown): Promise<EncodedStateValue> {
    const references: MessageReference[] = []
    const visiting = new WeakSet<object>()
    const replace = async (item: unknown, path: Array<string | number>): Promise<unknown> => {
      if (BaseMessage.isInstance(item)) {
        references.push({ path, records: [(await this.message(item)).recordId] })
        return null
      }
      if (!item || typeof item !== 'object') return item
      if ('lg_tool_call' in item && 'messages' in item && Array.isArray(item.messages)
        && item.lg_tool_call && typeof item.lg_tool_call === 'object') {
        // Send normalizes/clones its input object graph. Match that one routed
        // call against its own AIMessage instead of serializing large args again.
        for (const message of [...item.messages].reverse()) if (AIMessage.isInstance(message)) {
          const index = message.tool_calls?.findIndex((candidate) => isDeepStrictEqual(candidate, item.lg_tool_call)) ?? -1
          if (index >= 0) { this.calls.set(item.lg_tool_call, { message, index }); break }
        }
      }
      const call = this.calls.get(item)
      if (call && isDeepStrictEqual(item, (call.message as AIMessage).tool_calls?.[call.index])) {
        references.push({ path, records: [(await this.message(call.message)).recordId], toolCallIndex: call.index })
        return null
      }
      if (Array.isArray(item) && item.length > 0 && item.every(BaseMessage.isInstance)) {
        const records: string[] = []
        for (const message of item) records.push((await this.message(message)).recordId)
        references.push({ path, records, array: true })
        return null
      }
      if (visiting.has(item)) throw new Error('Current state contains a circular value.')
      if (item instanceof Map || item instanceof Set || item instanceof Date || ArrayBuffer.isView(item) || item instanceof RegExp || item instanceof Error) return item
      visiting.add(item)
      const output: Record<string, unknown> | unknown[] = Array.isArray(item) ? [] : Object.create(Object.getPrototypeOf(item))
      for (const [key, child] of Object.entries(item)) {
        Object.defineProperty(output, key, {
          value: await replace(child, [...path, Array.isArray(item) ? Number(key) : key]),
          enumerable: true, writable: true, configurable: true
        })
      }
      visiting.delete(item)
      return output
    }
    const replaced = await replace(value, [])
    const [type, bytes] = await this.serde.dumpsTyped(replaced)
    return { type, value: new Uint8Array(bytes), references }
  }

  async decode(
    value: EncodedStateValue,
    load: (recordIds: string[]) => Promise<Map<string, BaseMessage>>
  ): Promise<unknown> {
    let result = await this.serde.loadsTyped(value.type, value.value)
    const messages = await load([...new Set(value.references.flatMap((reference) => reference.records))])
    for (const reference of value.references) {
      const resolved = reference.records.map((id) => {
        const message = messages.get(id)
        if (!message) throw new Error(`Current state references missing message ${id}.`)
        return message
      })
      let replacement: unknown = reference.array ? resolved : resolved[0]
      if (reference.toolCallIndex !== undefined) {
        const message = resolved[0]
        if (!AIMessage.isInstance(message) || !message.tool_calls?.[reference.toolCallIndex]) {
          throw new Error('Current task references a missing model tool call.')
        }
        replacement = message.tool_calls[reference.toolCallIndex]
      }
      if (reference.path.length === 0) result = replacement
      else {
        let parent = result as Record<string | number, unknown>
        for (const key of reference.path.slice(0, -1)) {
          if (!parent || typeof parent !== 'object') throw new Error('Invalid current state message reference path.')
          parent = parent[key] as Record<string | number, unknown>
        }
        Object.defineProperty(parent, reference.path.at(-1)!, {
          value: replacement, enumerable: true, writable: true, configurable: true
        })
      }
    }
    return result
  }
}
