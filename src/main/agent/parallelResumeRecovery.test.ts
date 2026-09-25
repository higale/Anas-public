import Database from 'better-sqlite3'
import { Annotation, Command, END, START, StateGraph, interrupt, type StateSnapshot } from '@langchain/langgraph'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CurrentStateSqliteSaver } from './currentStateSqliteSaver'
import { AgentDatabase } from './agentDatabase'

const connections: Database.Database[] = []
const temporaryRoots: string[] = []
const config = { configurable: { thread_id: 'parallel' }, durability: 'sync' as const }

function open(file: string) {
  const connection = new Database(file)
  connection.pragma('foreign_keys = ON')
  connections.push(connection)
  const saver = new CurrentStateSqliteSaver(connection)
  saver.retainRun('run', 'parallel')
  return { connection, saver }
}

function createGraph(saver: CurrentStateSqliteSaver, calls: { left: number; right: number; after: number }) {
  const State = Annotation.Root({
    results: Annotation<string[]>({ reducer: (current, update) => [...current, ...update], default: () => [] }),
    anasRunLifecycle: Annotation<{ runId: string; status: 'running' | 'completed' }>()
  })
  return new StateGraph(State)
    .addNode('start', () => ({ anasRunLifecycle: { runId: 'run', status: 'running' as const } }))
    .addNode('left', () => {
      const answer = interrupt<{ branch: string }, string>({ branch: 'left' })
      calls.left += 1
      return { results: [`left:${answer}`] }
    })
    .addNode('right', () => {
      const answer = interrupt<{ branch: string }, string>({ branch: 'right' })
      calls.right += 1
      return { results: [`right:${answer}`] }
    })
    .addNode('after', () => {
      calls.after += 1
      return { anasRunLifecycle: { runId: 'run', status: 'completed' as const } }
    })
    .addEdge(START, 'start').addEdge('start', 'left').addEdge('start', 'right')
    .addEdge(['left', 'right'], 'after').addEdge('after', END).compile({ checkpointer: saver })
}

function decisions(state: StateSnapshot, completed = new Set<string>()): Record<string, string> {
  return Object.fromEntries(state.tasks.filter((task) => !completed.has(task.id)).flatMap((task) => task.interrupts).map((item) => {
    const branch = (item.value as { branch: string }).branch
    if (!item.id || !['left', 'right'].includes(branch)) throw new Error('Expected a current parallel approval.')
    return [item.id, branch === 'left' ? 'L' : 'R']
  }))
}

afterEach(() => {
  for (const connection of connections.splice(0)) if (connection.open) connection.close()
  for (const root of temporaryRoots.splice(0)) {
    if (!resolve(root).startsWith(`${resolve(tmpdir())}${sep}anas-parallel-current-`)) throw new Error('Unsafe test cleanup path.')
    rmSync(root, { recursive: true, force: true })
  }
})

describe('parallel approval with current state only', () => {
  it.each([false, true])('retains a completed branch while the other branch still needs approval (reopen=%s)', async (reopen) => {
    const root = mkdtempSync(join(tmpdir(), 'anas-parallel-current-'))
    temporaryRoots.push(root)
    const file = join(root, 'current.sqlite')
    let { connection, saver } = open(file)
    const calls = { left: 0, right: 0, after: 0 }
    let graph = createGraph(saver, calls)
    await graph.invoke({ results: [] }, config)
    const initial = await graph.getState(config)
    const answers = decisions(initial)
    expect(Object.keys(answers)).toHaveLength(2)
    const leftId = Object.entries(answers).find(([, answer]) => answer === 'L')![0]
    await graph.invoke(new Command({ resume: { [leftId]: 'L' } }), config)
    expect(calls).toEqual({ left: 1, right: 0, after: 0 })
    const waiting = await graph.getState(config)
    const completed = new Set(saver.getPendingWriteRows('parallel', '', ['results']).map((row) => row.task_id))
    const remaining = decisions(waiting, completed)
    expect(Object.values(remaining)).toEqual(['R'])
    if (reopen) {
      await saver.releaseRun('run')
      connection.close()
      ;({ connection, saver } = open(file))
      graph = createGraph(saver, calls)
    }
    const output = await graph.invoke(new Command({ resume: remaining }), config)
    expect(output.results).toEqual(['left:L', 'right:R'])
    expect(calls).toEqual({ left: 1, right: 1, after: 1 })
    expect((connection.prepare('SELECT count(*) AS count FROM current_state').get() as { count: number }).count).toBe(1)
    expect(await saver.getTuple({ configurable: { thread_id: 'parallel', checkpoint_id: initial.config.configurable?.checkpoint_id } })).toBeUndefined()
  })

  it('resumes both current decisions together and commits the terminal lifecycle', async () => {
    const { saver } = open(':memory:')
    const calls = { left: 0, right: 0, after: 0 }
    const graph = createGraph(saver, calls)
    await graph.invoke({ results: [] }, config)
    const output = await graph.invoke(new Command({ resume: decisions(await graph.getState(config)) }), config)
    expect(output.results).toEqual(['left:L', 'right:R'])
    expect(calls).toEqual({ left: 1, right: 1, after: 1 })
    expect(await saver.readChannel('parallel', 'anasRunLifecycle')).toEqual({ runId: 'run', status: 'completed' })
    expect((await graph.getState(config)).tasks).toEqual([])
  })

  it('projects a normal approval and completion into application run metadata', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'run')
      const calls = { left: 0, right: 0, after: 0 }
      const graph = createGraph(database.checkpointer, calls)
      const applicationConfig = { configurable: { thread_id: thread.id }, durability: 'sync' as const }
      await graph.invoke({ results: [] }, applicationConfig)
      expect(database.finishRun(run.id, 'interrupted').status).toBe('interrupted')
      const state = await graph.getState(applicationConfig)
      const intent = decisions(state)
      database.resumeRun(run.id, Object.entries(intent).map(([interruptId, response]) => ({ interruptId, response })))
      const output = await graph.invoke(new Command({ resume: intent }), applicationConfig)
      expect(output.results).toEqual(['left:L', 'right:R'])
      expect(database.finishRun(run.id, 'completed').status).toBe('completed')
    } finally { database.close() }
  })
})
