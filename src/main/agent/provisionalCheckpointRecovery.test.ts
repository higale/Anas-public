import Database from 'better-sqlite3'
import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph'
import { HumanMessage, type BaseMessage } from '@langchain/core/messages'
import { createDeepAgent } from 'deepagents'
import { createMiddleware, FakeToolCallingModel } from 'langchain'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CurrentStateSqliteSaver } from './currentStateSqliteSaver'

const connections: Database.Database[] = []
const temporaryRoots: string[] = []
const config = { configurable: { thread_id: 'thread' }, durability: 'sync' as const }
const State = Annotation.Root({ events: Annotation<string[]>({ reducer: (current, update) => [...current, ...update], default: () => [] }) })

function open(file = ':memory:') {
  const connection = new Database(file)
  connection.pragma('foreign_keys = ON')
  connections.push(connection)
  const saver = new CurrentStateSqliteSaver(connection)
  saver.retainRun('run', 'thread')
  return { connection, saver }
}

afterEach(() => {
  for (const connection of connections.splice(0)) if (connection.open) connection.close()
  for (const root of temporaryRoots.splice(0)) {
    if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}anas-nested-current-`)) throw new Error('Unsafe test cleanup path.')
    rmSync(root, { recursive: true, force: true })
  }
})

describe('current namespace state and handled failures', () => {
  it.each([false, true])('keeps sequential child approvals separate while preserving completed siblings (reopen=%s)', async (reopen) => {
    const root = mkdtempSync(join(tmpdir(), 'anas-nested-current-'))
    temporaryRoots.push(root)
    const file = join(root, 'current.sqlite')
    let { connection, saver } = open(file)
    let completedSibling = 0
    let completedChild = 0
    const create = () => {
      const child = new StateGraph(State)
        .addNode('approve', () => {
          const first = interrupt<string, string>('first')
          const second = interrupt<string, string>('second')
          completedChild += 1
          return { events: [`child:${first}:${second}`] }
        })
        .addEdge(START, 'approve').addEdge('approve', END).compile()
      return new StateGraph(State)
        .addNode('child', child)
        .addNode('sibling', () => { completedSibling += 1; return { events: ['sibling'] } })
        .addNode('after', () => ({ events: ['after'] }))
        .addEdge(START, 'child').addEdge(START, 'sibling')
        .addEdge(['child', 'sibling'], 'after').addEdge('after', END).compile({ checkpointer: saver })
    }
    let graph = create()
    await graph.invoke({ events: [] }, config)
    const first = (await graph.getState(config)).tasks.flatMap((task) => task.interrupts)[0]
    expect(first.value).toBe('first')
    await graph.invoke(new Command({ resume: { [first.id!]: 'A' } }), config)
    const second = (await graph.getState(config)).tasks.flatMap((task) => task.interrupts)[0]
    expect(second.value).toBe('second')
    expect(completedSibling).toBe(1)
    expect(completedChild).toBe(0)
    if (reopen) {
      await saver.releaseRun('run')
      connection.close()
      ;({ connection, saver } = open(file))
      graph = create()
    }
    const result = await graph.invoke(new Command({ resume: { [second.id!]: 'B' } }), config)
    expect(result.events).toEqual(['child:A:B', 'sibling', 'after'])
    expect(completedSibling).toBe(1)
    expect(completedChild).toBe(1)
    const groups = connection.prepare('SELECT checkpoint_ns,count(*) AS count FROM current_state GROUP BY checkpoint_ns').all() as Array<{ checkpoint_ns: string; count: number }>
    expect(groups.length).toBeGreaterThan(1)
    expect(groups.every((group) => group.count === 1)).toBe(true)
  })

  it('persists a parallel failure without disguising it as a successful approval pause', async () => {
    const { saver } = open()
    const graph = new StateGraph(State)
      .addNode('approval', () => ({ events: [interrupt<string, string>('approve')] }))
      .addNode('failure', () => { throw new Error('parallel sibling failed') })
      .addEdge(START, 'approval').addEdge(START, 'failure')
      .addEdge('approval', END).addEdge('failure', END).compile({ checkpointer: saver })
    await expect(graph.invoke({ events: [] }, config)).rejects.toThrow('parallel sibling failed')
    const pending = await saver.getPendingWrites('thread', '', ['__interrupt__', '__error__'])
    expect(pending.some(([, channel]) => channel === '__interrupt__')).toBe(true)
    expect(pending.some(([, channel]) => channel === '__error__')).toBe(true)
    await saver.releaseRun('run')
    const restored = await saver.getPendingWrites('thread', '', ['__error__'])
    expect(restored[0][2]).toMatchObject({ message: 'parallel sibling failed' })
  })

  it('lets the framework handle a node error once and persists the resulting current state', async () => {
    const { saver } = open()
    const calls = { source: 0, handler: 0, after: 0 }
    const graph = new StateGraph(State)
      .addNode('source', () => { calls.source += 1; throw new Error('source failed') }, {
        errorHandler: (_state, error) => {
          calls.handler += 1
          return new Command({ update: { events: [`handled:${error.error.message}`] }, goto: 'after' })
        }
      })
      .addNode('after', () => { calls.after += 1; return { events: ['after'] } })
      .addEdge(START, 'source').addEdge('source', 'after').addEdge('after', END).compile({ checkpointer: saver })
    const output = await graph.invoke({ events: [] }, config)
    expect(output.events).toEqual(['handled:source failed', 'after'])
    expect(calls).toEqual({ source: 1, handler: 1, after: 1 })
    await saver.releaseRun('run')
    expect(await saver.readChannel('thread', 'events')).toEqual(output.events)
  })

  it('accepts a new user turn after a handled application failure without replaying old input', async () => {
    const { saver } = open()
    const calls = { old: 0, fresh: 0 }
    const makeAgent = () => createDeepAgent({
      checkpointer: saver,
      model: new FakeToolCallingModel({ toolCalls: [[]] }),
      middleware: [
        createMiddleware({ name: 'FailOldInput', beforeAgent: (state) => {
          if (state.messages.at(-1)?.text === 'old') { calls.old += 1; throw new Error('old input failed') }
        } }),
        createMiddleware({ name: 'CountFreshModel', wrapModelCall: async (request, handler) => {
          calls.fresh += 1
          return handler(request)
        } })
      ]
    })
    await expect(makeAgent().invoke({ messages: [new HumanMessage({ id: 'old', content: 'old' })] }, config)).rejects.toThrow('old input failed')
    await saver.releaseRun('run')
    saver.retainRun('fresh-run', 'thread')
    const output = await makeAgent().invoke({ messages: [new HumanMessage({ id: 'fresh', content: 'fresh' })] }, config)
    expect(calls).toEqual({ old: 1, fresh: 1 })
    await saver.releaseRun('fresh-run')
    const restored = await saver.getTuple(config)
    expect((restored?.checkpoint.channel_values.messages as BaseMessage[]).map((message) => message.id)).toEqual(output.messages.map((message) => message.id))
    expect((restored?.checkpoint.channel_values.messages as BaseMessage[]).filter((message) => message.getType() === 'human').map((message) => message.content)).toEqual(['old', 'fresh'])
  })
})
