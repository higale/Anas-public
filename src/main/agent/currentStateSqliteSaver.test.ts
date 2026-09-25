import Database from 'better-sqlite3'
import { AIMessage, AIMessageChunk, BaseMessage, HumanMessage, RemoveMessage, ToolMessage } from '@langchain/core/messages'
import { Annotation, Command, END, START, Send, StateGraph, interrupt, messagesStateReducer } from '@langchain/langgraph'
import { emptyCheckpoint, type Checkpoint, type CheckpointMetadata } from '@langchain/langgraph-checkpoint'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CurrentStateSqliteSaver } from './currentStateSqliteSaver'
import { createDeepAgent } from 'deepagents'
import { FakeToolCallingModel, tool } from 'langchain'
import { z } from 'zod'

const databases: Database.Database[] = []
const temporaryDirectories: string[] = []
const metadata: CheckpointMetadata = { source: 'loop', step: 0, parents: {} }

function open(file = ':memory:') {
  const database = new Database(file)
  database.pragma('foreign_keys = ON')
  databases.push(database)
  return database
}

function fixture() {
  const database = open()
  const saver = new CurrentStateSqliteSaver(database)
  saver.retainRun('run', 'thread')
  return { database, saver }
}

function state(id: string, messages: BaseMessage[], other: Record<string, unknown> = {}): Checkpoint {
  return {
    ...emptyCheckpoint(), id, channel_values: { messages, ...other },
    channel_versions: Object.fromEntries(['messages', ...Object.keys(other)].map((key) => [key, id])),
    versions_seen: { model: { messages: id } }
  }
}

async function put(saver: CurrentStateSqliteSaver, checkpoint: Checkpoint, threadId = 'thread', namespace = '') {
  return saver.put({ configurable: { thread_id: threadId, checkpoint_ns: namespace } }, checkpoint, metadata, checkpoint.channel_versions)
}

function count(database: Database.Database, table: string): number {
  return (database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count
}

afterEach(() => {
  for (const database of databases.splice(0)) if (database.open) database.close()
  for (const directory of temporaryDirectories.splice(0)) {
    if (!resolve(directory).startsWith(`${resolve(tmpdir())}${sep}anas-current-state-`)) throw new Error('Unsafe test cleanup path.')
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('CurrentStateSqliteSaver', () => {
  it('round trips complete native messages and all native message fields', async () => {
    const { database, saver } = fixture()
    const messages = [
      new HumanMessage({ id: 'user', content: [{ type: 'text', text: 'question' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }),
      new AIMessage({ id: 'model', content: [{ type: 'text', text: 'working' }, { type: 'reasoning', reasoning: 'reason', signature: 'signed' }],
        additional_kwargs: { opaque: { lc: 1, type: 'constructor', id: ['not', 'a', 'message'] } },
        response_metadata: { provider: 'test' },
        usage_metadata: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
        tool_calls: [{ id: 'call1', name: 'first', args: { text: 'large parameters' } }, { id: 'call2', name: 'second', args: { flag: true } }] }),
      new ToolMessage({ id: 'result1', tool_call_id: 'call1', content: 'visible result', artifact: { bytes: new Uint8Array([1, 2, 3]), full: 'full result' }, status: 'success' }),
      new ToolMessage({ id: 'result2', tool_call_id: 'call2', content: 'failure', status: 'error' })
    ]
    await put(saver, state('one', messages, { summary: { text: 'short', count: 4 }, tags: new Set(['a']) }))
    await saver.releaseRun('run')
    const restored = await saver.getTuple({ configurable: { thread_id: 'thread' } })
    const actual = restored?.checkpoint.channel_values.messages as BaseMessage[]
    expect(actual.map((message) => message.toDict())).toEqual(messages.map((message) => message.toDict()))
    expect((actual[2] as ToolMessage).artifact.bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(restored?.checkpoint.channel_values.tags).toEqual(new Set(['a']))
    expect(count(database, 'message_bodies')).toBe(4)
    expect(saver.getMessageRecord('thread', 'model')?.messageId).toBe('model')
    expect((await saver.readMessages('thread', { offset: 1, limit: 2 })).map((message) => message.id)).toEqual(['model', 'result1'])
    expect((await saver.readMessages('thread', { reverse: true, limit: 1 }))[0].id).toBe('result2')
    for (const record of saver.readMessageRecords('thread')) {
      const syncMessage = saver.readMessageRecordSync(record)
      expect(syncMessage.toDict()).toEqual(messages.find((message) => message.id === record.messageId)?.toDict())
      if (ToolMessage.isInstance(syncMessage) && syncMessage.artifact) expect(syncMessage.artifact.bytes).toBeInstanceOf(Uint8Array)
    }
  })

  it.each([1000, 10000])('only encodes appended message bodies with %s retained messages', async (size) => {
    const { database, saver } = fixture()
    const messages = Array.from({ length: size }, (_, index) => new HumanMessage({ id: `m${index}`, content: 'x'.repeat(4096) }))
    await put(saver, state('first', messages))
    const encodedBefore = saver.encodedMessageBytes
    const changedRowsBefore = (database.prepare('SELECT total_changes() AS count').get() as { count: number }).count
    const bytesBefore = (database.prepare('SELECT sum(length(value)) AS size FROM message_bodies').get() as { size: number }).size
    const appended = new AIMessage({ id: 'new', content: 'new response' })
    await put(saver, state('second', [...messages, appended]))
    const changedRows = (database.prepare('SELECT total_changes() AS count').get() as { count: number }).count - changedRowsBefore
    expect(changedRows).toBeLessThan(20)
    const additionalEncoded = saver.encodedMessageBytes - encodedBefore
    const bytesAfter = (database.prepare('SELECT sum(length(value)) AS size FROM message_bodies').get() as { size: number }).size
    expect(additionalEncoded).toBeGreaterThan(0)
    expect(additionalEncoded).toBeLessThan(2000)
    expect(bytesAfter - bytesBefore).toBe(additionalEncoded)
    expect(count(database, 'current_state')).toBe(1)
    expect(count(database, 'message_bodies')).toBe(size + 1)
    expect(saver.countMessages('thread')).toBe(size + 1)
    expect((database.prepare('SELECT length(value) AS size FROM state_channels WHERE channel = ?').get('messages') as { size: number }).size).toBe(0)
  })

  it('shares message bodies and tool arguments with Send task inputs', async () => {
    const { database, saver } = fixture()
    const model = new AIMessage({ id: 'model', content: 'reasoning', tool_calls: [{ id: 'call', name: 'tool', args: { text: 'PARAMETER'.repeat(25000) } }] })
    const task = new Send('tools', { messages: [model], lg_tool_call: model.tool_calls![0] })
    const config = await put(saver, state('one', [model], { __pregel_tasks: [task] }))
    await saver.putWrites(config, [['__pregel_tasks', task]], 'task')
    expect(count(database, 'message_bodies')).toBe(1)
    const duplicated = database.prepare(`SELECT sum(size) AS size FROM (
      SELECT length(value) + length(refs_json) AS size FROM state_channels UNION ALL
      SELECT length(value) + length(refs_json) AS size FROM pending_writes
    )`).get() as { size: number }
    expect(duplicated.size).toBeLessThan(2500)
    await saver.releaseRun('run')
    const restored = await saver.getTuple(config)
    const tasks = restored?.checkpoint.channel_values.__pregel_tasks as Array<{ args: { messages: BaseMessage[]; lg_tool_call: unknown } }>
    expect(tasks[0].args.messages[0]).toBeInstanceOf(AIMessage)
    expect(tasks[0].args.lg_tool_call).toEqual(model.tool_calls![0])
    expect(restored?.pendingWrites?.[0][2]).toMatchObject({ node: 'tools', args: { lg_tool_call: model.tool_calls![0] } })
  })

  it('replaces a message ID while preserving the input of an existing current task', async () => {
    const { database, saver } = fixture()
    const original = new HumanMessage({ id: 'same', content: 'original' })
    await put(saver, state('one', [original], { task: new Send('tool', { messages: [original] }) }))
    const replacement = new HumanMessage({ id: 'same', content: 'replacement' })
    await put(saver, state('two', [replacement], { task: new Send('tool', { messages: [original] }) }))
    expect(count(database, 'message_bodies')).toBe(2)
    await saver.releaseRun('run')
    const restored = await saver.getTuple({ configurable: { thread_id: 'thread' } })
    expect((restored?.checkpoint.channel_values.messages as BaseMessage[])[0].content).toBe('replacement')
    expect((restored?.checkpoint.channel_values.task as { args: { messages: BaseMessage[] } }).args.messages[0].content).toBe('original')
    await put(saver, state('three', [replacement]))
    expect(count(database, 'message_bodies')).toBe(1)
    expect(await saver.getTuple({ configurable: { thread_id: 'thread', checkpoint_id: 'two' } })).toBeUndefined()
    const listed: unknown[] = []
    for await (const tuple of saver.list({ configurable: { thread_id: 'thread' } })) listed.push(tuple)
    expect(listed.length).toBe(1)
  })

  it('recognizes top-level mutation of the same message instance', async () => {
    const { saver } = fixture()
    const message = new HumanMessage({ id: 'same', content: 'before' })
    await put(saver, state('one', [message]))
    message.content = 'after'
    await put(saver, state('two', [message]))
    await saver.releaseRun('run')
    expect((await saver.getMessage('thread', 'same'))?.content).toBe('after')
  })

  it('detects nested mutations without freezing framework-owned message fields', async () => {
    const { saver } = fixture()
    const message = new AIMessage({ id: 'mutable', content: [{ type: 'text', text: 'before' }],
      additional_kwargs: { nested: { flag: false } }, tool_calls: [{ id: 'call', name: 'lookup', args: { nested: { query: 'before' } } }] })
    await put(saver, state('one', [message]))
    ;(message.content as Array<{ type: 'text'; text: string }>)[0].text = 'after'
    ;(message.additional_kwargs.nested as { flag: boolean }).flag = true
    ;(message.tool_calls![0].args.nested as { query: string }).query = 'after'
    await put(saver, state('two', [message]))
    await saver.releaseRun('run')
    const restored = await saver.getMessage('thread', 'mutable') as AIMessage
    expect(restored.content).toEqual([{ type: 'text', text: 'after' }])
    expect(restored.additional_kwargs.nested).toEqual({ flag: true })
    expect(restored.tool_calls![0].args.nested).toEqual({ query: 'after' })
  })

  it('keeps current pending and effect references independent of mutated framework messages', async () => {
    const { saver } = fixture()
    const message = new ToolMessage({ id: 'same', tool_call_id: 'call', content: 'first', artifact: { nested: { value: 1 } } })
    const config = await put(saver, state('one', []))
    await saver.putWrites(config, [['messages', [message]]], 'task')
    const effect = await saver.saveReferencedValue('thread', message, 'effect:call')
    message.content = 'second'
    message.artifact.nested.value = 2
    await saver.saveReferencedValue('thread', message, 'effect:another-call')
    const pending = await saver.getPendingWrites('thread')
    expect((pending[0][2] as ToolMessage[])[0]).toMatchObject({ content: 'first', artifact: { nested: { value: 1 } } })
    const firstRead = await saver.readReferencedValue('thread', effect) as ToolMessage
    expect(firstRead).toMatchObject({ content: 'first', artifact: { nested: { value: 1 } } })
    firstRead.content = 'caller mutation'
    firstRead.artifact.nested.value = 100
    ;(pending[0][2] as ToolMessage[])[0].artifact.nested.value = 200
    expect(await saver.readReferencedValue('thread', effect)).toMatchObject({ content: 'first', artifact: { nested: { value: 1 } } })
    expect(((await saver.getPendingWrites('thread'))[0][2] as ToolMessage[])[0].artifact.nested.value).toBe(1)
  })

  it('keeps retained current channels independent of callers before the next commit', async () => {
    const { saver } = fixture()
    const message = new HumanMessage({ id: 'input', content: [{ type: 'text', text: 'saved' }] })
    const todos = [{ task: 'saved', complete: false }]
    const config = await put(saver, state('one', [message], { todos }))
    todos[0].complete = true
    ;(message.content as Array<{ text: string }>)[0].text = 'uncommitted'
    const tuple = (await saver.getTuple(config))!
    expect((tuple.checkpoint.channel_values.messages as BaseMessage[])[0].content).toEqual([{ type: 'text', text: 'saved' }])
    expect(tuple.checkpoint.channel_values.todos).toEqual([{ task: 'saved', complete: false }])
    ;(tuple.checkpoint.channel_values.todos as typeof todos)[0].task = 'caller change'
    const channel = await saver.readChannel('thread', 'todos') as typeof todos
    expect(channel).toEqual([{ task: 'saved', complete: false }])
    channel[0].complete = true
    expect(await saver.readChannel('thread', 'todos')).toEqual([{ task: 'saved', complete: false }])
  })

  it.each([1000, 10000])('keeps incremental encoding across repeated mutable tuple reads with %s messages', async (size) => {
    const { database, saver } = fixture()
    await put(saver, state('initial', Array.from({ length: size }, (_, index) => new HumanMessage({ id: `m${index}`, content: 'x'.repeat(4096) }))))
    const beforeBytes = saver.encodedMessageBytes
    const beforeChanges = (database.prepare('SELECT total_changes() AS count').get() as { count: number }).count
    for (let index = 0; index < 3; index++) {
      const tuple = (await saver.getTuple({ configurable: { thread_id: 'thread' } }))!
      const messages = tuple.checkpoint.channel_values.messages as BaseMessage[]
      messages.push(new AIMessage({ id: `new-${index}`, content: 'new response' }))
      await put(saver, state(`next-${index}`, messages))
    }
    expect(saver.encodedMessageBytes - beforeBytes).toBeLessThan(6000)
    expect((database.prepare('SELECT total_changes() AS count').get() as { count: number }).count - beforeChanges).toBeLessThan(60)
    expect(saver.countMessages('thread')).toBe(size + 3)
  })

  it('rolls back messages, current state, and synchronous product hooks together', async () => {
    const database = open()
    database.exec('CREATE TABLE commits (checkpoint_id TEXT)')
    const saver = new CurrentStateSqliteSaver(database, { onCheckpoint: (_config, checkpoint) => {
      database.prepare('INSERT INTO commits VALUES (?)').run(checkpoint.id)
      if (checkpoint.id === 'bad') throw new Error('Product commit failed')
    } })
    saver.retainRun('run', 'thread')
    await put(saver, state('good', [new HumanMessage({ id: 'first', content: 'first' })]))
    await expect(put(saver, state('bad', [new HumanMessage({ id: 'second', content: 'second' })]))).rejects.toThrow('Product commit failed')
    expect(saver.getCurrentHead('thread')?.checkpointId).toBe('good')
    expect(count(database, 'commits')).toBe(1)
    expect(count(database, 'message_bodies')).toBe(1)
    expect((await saver.readMessages('thread'))[0].id).toBe('first')
  })

  it('applies native reducer replacement and removal without retaining prior states', async () => {
    const { database, saver } = fixture()
    const State = Annotation.Root({ messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }) })
    const graph = new StateGraph(State).addNode('pass', () => ({})).addEdge(START, 'pass').addEdge('pass', END).compile({ checkpointer: saver })
    const config = { configurable: { thread_id: 'thread' }, durability: 'sync' as const }
    await graph.invoke({ messages: [new HumanMessage({ id: 'one', content: 'one' }), new HumanMessage({ id: 'two', content: 'two' })] }, config)
    await graph.updateState(config, { messages: [new HumanMessage({ id: 'one', content: 'changed' }), new RemoveMessage({ id: 'two' })] })
    expect((await saver.readMessages('thread')).map((message) => [message.id, message.content])).toEqual([['one', 'changed']])
    expect(count(database, 'current_state')).toBe(1)
    expect(count(database, 'message_bodies')).toBe(1)
  })

  it.each([false, true])('resumes parallel approval without repeating the completed tool (reopen=%s)', async (reopen) => {
    const directory = mkdtempSync(join(tmpdir(), 'anas-current-state-'))
    temporaryDirectories.push(directory)
    const file = join(directory, 'current.sqlite')
    let database = open(file)
    let saver = new CurrentStateSqliteSaver(database)
    saver.retainRun('approval-run', 'thread')
    const completed = vi.fn(() => ({ messages: [new ToolMessage({ id: 'fast-result', tool_call_id: 'fast-call', content: 'fast' })] }))
    const State = Annotation.Root({ messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }) })
    const create = () => new StateGraph(State)
      .addNode('model', () => ({ messages: [new AIMessage({ id: 'calls', content: '', tool_calls: [{ id: 'fast-call', name: 'fast', args: {} }, { id: 'approval-call', name: 'approval', args: {} }] })] }))
      .addNode('fast', completed)
      .addNode('approval', () => ({ messages: [new ToolMessage({ id: 'approved-result', tool_call_id: 'approval-call', content: interrupt<string, string>('approve') })] }))
      .addNode('answer', () => ({ messages: [new AIMessage({ id: 'answer', content: 'done' })] }))
      .addEdge(START, 'model').addEdge('model', 'fast').addEdge('model', 'approval')
      .addEdge(['fast', 'approval'], 'answer').addEdge('answer', END).compile({ checkpointer: saver })
    let graph = create()
    const config = { configurable: { thread_id: 'thread' }, durability: 'sync' as const }
    await graph.invoke({ messages: [new HumanMessage({ id: 'user', content: 'go' })] }, config)
    expect(completed).toHaveBeenCalledTimes(1)
    const pending = await saver.getPendingWrites('thread', '', ['__interrupt__'])
    expect(pending.length).toBe(1)
    if (reopen) {
      await saver.releaseRun('approval-run')
      database.close()
      database = open(file)
      saver = new CurrentStateSqliteSaver(database)
      saver.retainRun('approval-run', 'thread')
      graph = create()
    } else {
      const loads = vi.spyOn(saver.serde, 'loadsTyped')
      await saver.getTuple(config)
      expect(loads).not.toHaveBeenCalled()
      loads.mockRestore()
    }
    const output = await graph.invoke(new Command({ resume: 'approved' }), config)
    expect(output.messages.at(-1)?.content).toBe('done')
    expect(completed).toHaveBeenCalledTimes(1)
    expect(saver.countMessages('thread')).toBe(5)
    expect(count(database, 'current_state')).toBe(1)
    await saver.releaseRun('approval-run')
    expect(saver.hasRetainedRun('thread')).toBe(false)
  })

  it('keeps child threads and namespaces independent, and deletes only the selected thread', async () => {
    const { database, saver } = fixture()
    await put(saver, state('root', [new HumanMessage({ id: 'same', content: 'root' })]))
    await put(saver, state('child', [new HumanMessage({ id: 'same', content: 'child' })]), 'child')
    await put(saver, state('nested', [new HumanMessage({ id: 'same', content: 'nested' })]), 'thread', 'nested')
    expect((await saver.getMessage('thread', 'same', 'nested'))?.content).toBe('nested')
    await saver.deleteThread('thread')
    expect(saver.getCurrentHead('thread')).toBeUndefined()
    expect((await saver.getMessage('child', 'same'))?.content).toBe('child')
    expect(count(database, 'message_bodies')).toBe(1)
  })

  it('atomically replaces a message prefix and child state together with product metadata', async () => {
    const { database, saver } = fixture()
    database.exec('CREATE TABLE product_metadata (value TEXT)')
    const first = new HumanMessage({ id: 'first', content: 'keep' })
    await put(saver, state('before', [first, new AIMessage({ id: 'discard', content: 'discard' })], { todos: ['old'], summary: 'old summary' }))
    await put(saver, state('child', [new HumanMessage({ id: 'child', content: 'child' })]), 'child')
    const replacement = state('after', [first], { todos: [], summary: null })
    await expect(saver.replaceCurrentState('thread', replacement, metadata, () => {
      saver.deleteThreadSync('child')
      database.prepare('INSERT INTO product_metadata VALUES (?)').run('bad')
      throw new Error('rollback')
    })).rejects.toThrow('rollback')
    expect(saver.getCurrentHead('thread')?.checkpointId).toBe('before')
    expect(saver.getCurrentHead('child')?.checkpointId).toBe('child')
    expect(count(database, 'product_metadata')).toBe(0)
    await saver.replaceCurrentState('thread', replacement, metadata, () => {
      saver.deleteThreadSync('child')
      database.prepare('INSERT INTO product_metadata VALUES (?)').run('committed')
    })
    expect(saver.getCurrentHead('thread')?.checkpointId).toBe('after')
    expect(saver.getCurrentHead('child')).toBeUndefined()
    expect(await saver.readChannel('thread', 'todos')).toEqual([])
    expect(await saver.readChannel('thread', 'summary')).toBeNull()
    expect(count(database, 'message_bodies')).toBe(1)
    expect(count(database, 'product_metadata')).toBe(1)
  })

  it('preserves bodies referenced by product activity until that reference is removed', async () => {
    const { database, saver } = fixture()
    const message = new AIMessage({ id: 'visible', content: 'visible message' })
    await put(saver, state('one', [message]))
    const record = saver.getMessageRecord('thread', 'visible')!
    database.prepare('INSERT INTO message_references VALUES (?,?,?,?,?)').run('thread', '', 'activity', 'run:model', record.recordId)
    await put(saver, state('two', []))
    expect(saver.getMessageRecord('thread', 'visible')).toBeUndefined()
    expect(saver.getMessageRecordById('thread', record.recordId)).toBeDefined()
    database.prepare("DELETE FROM message_references WHERE owner_kind = 'activity'").run()
    await put(saver, state('three', []))
    expect(saver.getMessageRecordById('thread', record.recordId)).toBeUndefined()
  })

  it('keeps duplicate pending channel entries distinct and applies special replacements', async () => {
    const { saver } = fixture()
    const config = await put(saver, state('one', []))
    await saver.putWrites(config, [['custom', 'a'], ['custom', 'b']], 'task')
    await saver.putWrites(config, [['__error__', 'failure']], 'other-task')
    await saver.putWrites(config, [['__error__', 'updated failure']], 'other-task')
    expect(await saver.getPendingWrites('thread')).toEqual([
      ['other-task', '__error__', 'updated failure'], ['task', 'custom', 'a'], ['task', 'custom', 'b']
    ])
    await saver.releaseRun('run')
    expect(await saver.getPendingWrites('thread')).toEqual([
      ['other-task', '__error__', 'updated failure'], ['task', 'custom', 'a'], ['task', 'custom', 'b']
    ])
  })

  it('preserves the concrete class of complete AI chunks in synchronous UI reads', async () => {
    const { saver } = fixture()
    const message = new AIMessageChunk({ id: 'chunk', content: 'complete chunk', tool_call_chunks: [] })
    await put(saver, state('one', [message]))
    expect(saver.readMessageRecordSync(saver.getMessageRecord('thread', 'chunk')!)).toBeInstanceOf(AIMessageChunk)
  })

  it('runs the actual Deep Agents model/tool loop with its native task messages', async () => {
    const { database, saver } = fixture()
    const payload = 'large argument'.repeat(5000)
    const agent = createDeepAgent({
      checkpointer: saver,
      model: new FakeToolCallingModel({ toolCalls: [[{ id: 'native-call', name: 'length', args: { text: payload } }], []] }),
      tools: [tool(({ text }: { text: string }) => String(text.length), { name: 'length', description: 'Returns the text length', schema: z.object({ text: z.string() }) })]
    })
    const output = await agent.invoke({ messages: [new HumanMessage({ id: 'user', content: 'measure' })] }, { configurable: { thread_id: 'thread' }, durability: 'sync' })
    expect(output.messages.some((message) => ToolMessage.isInstance(message) && message.content === String(payload.length))).toBe(true)
    expect(count(database, 'current_state')).toBe(1)
    await saver.releaseRun('run')
    const restored = await saver.getTuple({ configurable: { thread_id: 'thread' } })
    expect((restored?.checkpoint.channel_values.messages as BaseMessage[]).map((message) => message.toDict())).toEqual(output.messages.map((message) => message.toDict()))
  })

  it('does not re-encode large completed tool text and MCP base64 image blocks', async () => {
    const { saver } = fixture()
    const data = 'aGVsbG8='.repeat(200000)
    const messages = [
      new ToolMessage({ id: 'text', tool_call_id: 'text-call', content: 'output '.repeat(200000) }),
      new ToolMessage({ id: 'image', tool_call_id: 'image-call', content: 'image result', artifact: { content: [{ type: 'image', data, mimeType: 'image/png' }] } })
    ]
    await put(saver, state('one', messages))
    const before = saver.encodedMessageBytes
    await put(saver, state('two', [...messages, new AIMessage({ id: 'next', content: 'next' })]))
    expect(saver.encodedMessageBytes - before).toBeLessThan(2000)
  })

  it('keeps mutable binary artifacts correct when their contents change', async () => {
    const { saver } = fixture()
    const bytes = new Uint8Array([1, 2, 3])
    const message = new ToolMessage({ id: 'bytes', tool_call_id: 'call', content: 'binary', artifact: { bytes } })
    await put(saver, state('one', [message]))
    bytes[0] = 4
    await put(saver, state('two', [message]))
    await saver.releaseRun('run')
    const restored = await saver.getMessage('thread', 'bytes') as ToolMessage
    expect(restored.artifact.bytes).toEqual(new Uint8Array([4, 2, 3]))
  })

  it('preserves task writes that arrive before their matching current head', async () => {
    const { database, saver } = fixture()
    await put(saver, state('one', []))
    const result = new ToolMessage({ id: 'result', tool_call_id: 'call', content: 'complete result' })
    await saver.putWrites({ configurable: { thread_id: 'thread', checkpoint_id: 'three' } }, [['messages', [result]]], 'tool')
    await put(saver, state('two', []))
    expect(count(database, 'message_bodies')).toBe(1)
    expect(await saver.getPendingWrites('thread')).toEqual([])
    await put(saver, state('three', []))
    expect((await saver.getPendingWrites('thread'))[0][2]).toEqual([result])
    await put(saver, state('four', [result]))
    expect(count(database, 'message_bodies')).toBe(1)
    expect(await saver.getPendingWrites('thread')).toEqual([])
  })

  it('persists a complete managed result once before the graph incorporates it', async () => {
    const { database, saver } = fixture()
    const message = new ToolMessage({ tool_call_id: 'managed-call', content: 'complete result', artifact: { full: 'full result' } })
    const saved = await saver.saveReferencedValue('thread', message, 'managed:call')
    const recordId = saved.references[0].records[0]
    expect(message.id).toBeTruthy()
    expect((await saver.getMessageByRecordId('thread', recordId))?.toDict()).toEqual(message.toDict())
    const before = saver.encodedMessageBytes
    const config = await put(saver, state('one', []))
    await saver.putWrites(config, [['messages', [message]]], 'managed-task')
    await put(saver, state('two', [message]))
    expect(saver.encodedMessageBytes).toBe(before)
    expect(count(database, 'message_bodies')).toBe(1)
    expect(saver.getMessageRecord('thread', message.id!)?.recordId).toBe(recordId)
  })

  it('rolls back a failing pending-write product hook', async () => {
    const database = open()
    const saver = new CurrentStateSqliteSaver(database, { onWrites: () => { throw new Error('write projection failed') } })
    const config = await put(saver, state('one', []))
    await expect(saver.putWrites(config, [['messages', [new AIMessage({ id: 'failed', content: 'result' })]]], 'task')).rejects.toThrow('write projection failed')
    expect(count(database, 'pending_writes')).toBe(0)
    expect(count(database, 'message_bodies')).toBe(0)
    expect(saver.getCurrentHead('thread')?.checkpointId).toBe('one')
  })

  it('stores message and Command effect values as references and preserves native values after reopen', async () => {
    const { database, saver } = fixture()
    const message = new ToolMessage({ id: 'effect-result', tool_call_id: 'call', content: 'result'.repeat(10000), artifact: { bytes: new Uint8Array([1, 2]) } })
    // Command.toJSON deliberately omits graph; product effect envelopes retain
    // its constructor fields while the codec handles nested native messages.
    const command = { update: { messages: [message], handled: true }, goto: 'next', graph: Command.PARENT }
    const value = await saver.saveReferencedValue('thread', { kind: 'command', command }, 'effect:call')
    expect(value.value.byteLength).toBeLessThan(2000)
    expect(count(database, 'message_bodies')).toBe(1)
    await saver.releaseRun('run')
    const decoded = await saver.readReferencedValue('thread', value) as { kind: string; command: typeof command }
    const restored = new Command(decoded.command)
    expect(restored.graph).toBe(Command.PARENT)
    expect((restored.update as { messages: ToolMessage[] }).messages[0].artifact).toEqual(message.artifact)
    expect((restored.update as { messages: ToolMessage[] }).messages[0].content).toBe(message.content)
    const originalRecordId = value.references[0].records[0]
    const second = await saver.saveReferencedValue('thread', decoded, 'effect:call')
    expect(second.references[0].records[0]).toBe(originalRecordId)
    expect(count(database, 'message_bodies')).toBe(1)
    await saver.saveReferencedValue('thread', null, 'effect:call')
    expect(count(database, 'message_bodies')).toBe(0)
  })

  it('can reintroduce the same native message object after its final reference was removed', async () => {
    const { database, saver } = fixture()
    const message = new ToolMessage({ id: 'temporary', tool_call_id: 'call', content: 'result' })
    const value = await saver.saveReferencedValue('thread', message, 'effect:call')
    await saver.saveReferencedValue('thread', null, 'effect:call')
    expect(count(database, 'message_bodies')).toBe(0)
    const again = await saver.saveReferencedValue('thread', message, 'effect:call')
    expect(again.references).toEqual(value.references)
    expect(count(database, 'message_bodies')).toBe(1)
    expect(await saver.readReferencedValue('thread', again)).toEqual(message)
  })

  it('rolls back a referenced value and owner replacement with its product commit', async () => {
    const { database, saver } = fixture()
    database.exec('CREATE TABLE effect(id TEXT PRIMARY KEY, payload TEXT NOT NULL)')
    const first = await saver.saveReferencedValue('thread', new ToolMessage({ id: 'first', tool_call_id: 'call', content: 'first' }), 'effect:call', '', () => {
      database.prepare('INSERT INTO effect VALUES (?, ?)').run('call', 'first')
    })
    await expect(saver.saveReferencedValue('thread', new ToolMessage({ id: 'second', tool_call_id: 'call', content: 'second' }), 'effect:call', '', () => {
      database.prepare('UPDATE effect SET payload = ?').run('second')
      throw new Error('commit rejected')
    })).rejects.toThrow('commit rejected')
    expect(database.prepare('SELECT payload FROM effect').get()).toEqual({ payload: 'first' })
    expect(count(database, 'message_bodies')).toBe(1)
    expect((await saver.readReferencedValue('thread', first) as ToolMessage).content).toBe('first')
  })

  it('bounds pending checkpoint anchors across a long native graph loop', async () => {
    const database = open()
    let maximumPendingAnchors = 0
    const observe = () => {
      const row = database.prepare('SELECT count(DISTINCT checkpoint_id) AS count FROM pending_writes').get() as { count: number }
      maximumPendingAnchors = Math.max(maximumPendingAnchors, row.count)
    }
    const saver = new CurrentStateSqliteSaver(database, { onCheckpoint: observe, onWrites: observe })
    saver.retainRun('run', 'thread')
    const LoopState = Annotation.Root({
      messages: Annotation<BaseMessage[]>({ reducer: messagesStateReducer, default: () => [] }),
      steps: Annotation<number>({ reducer: (_current, update) => update, default: () => 0 })
    })
    const agent = new StateGraph(LoopState)
      .addNode('model', (value) => ({ messages: [new AIMessage({ id: `model-${value.steps}`, content: '', tool_calls: [{ id: `call-${value.steps}`, name: 'step', args: {} }] })] }))
      .addNode('tools', (value) => ({ messages: [new ToolMessage({ id: `tool-${value.steps}`, tool_call_id: `call-${value.steps}`, content: 'done' })], steps: value.steps + 1 }))
      .addEdge(START, 'model').addEdge('model', 'tools')
      .addConditionalEdges('tools', (value) => value.steps < 100 ? 'model' : END)
      .compile({ checkpointer: saver })
    const result = await agent.invoke({ messages: [new HumanMessage('continue')], steps: 0 }, {
      configurable: { thread_id: 'thread' }, durability: 'sync', recursionLimit: 250
    })
    expect(result.steps).toBe(100)
    expect(result.messages.filter(ToolMessage.isInstance)).toHaveLength(100)
    expect(maximumPendingAnchors).toBeLessThanOrEqual(2)
    expect(count(database, 'current_state')).toBe(1)
    await saver.releaseRun('run')
    expect(saver.hasRetainedRun('thread')).toBe(false)
    expect(count(database, 'pending_writes')).toBe(0)
  })
})
