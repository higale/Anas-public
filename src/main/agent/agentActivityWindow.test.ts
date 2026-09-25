import Database from 'better-sqlite3'
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { defaultCapabilities } from '@shared/agentCapabilities'
import type { AgentRunActivity } from '@shared/agentTypes'
import type { SubagentConfig } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { AgentDatabase } from './agentDatabase'

async function putMessages(database: AgentDatabase, threadId: string, messages: BaseMessage[]): Promise<void> {
  await database.checkpointer.put({ configurable: { thread_id: threadId, checkpoint_ns: '' } }, {
    v: 4, id: 'current', ts: new Date().toISOString(), channel_values: { messages }, channel_versions: {}, versions_seen: {}
  }, { source: 'update', step: 0, parents: {} })
}

function fullSequences(activity: AgentRunActivity): number[] {
  return [...activity.models, ...activity.tools, ...activity.subagents.filter((entry) => !entry.detailsDeferred),
    ...(activity.summaries ?? []), ...(activity.memoryRecalls ?? [])].map((entry) => entry.sequence).sort((a, b) => a - b)
}

function config(): SubagentConfig {
  return {
    index: 0, name: 'reviewer', enabled: true, builtIn: false, description: 'Review a file.', systemPrompt: 'Review the assigned file.',
    capabilities: { ...structuredClone(defaultCapabilities), profile: false, workspace: true, memory: true, toolMode: 'all', tools: [], skills: { enabled: true, mode: 'default', project: false, entries: [] } }
  }
}

describe('run activity windows', () => {
  it('gives every visible run its own bounded window', () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const runIds: string[] = []
      for (const id of ['first-run', 'second-run']) {
        const run = database.createRun(thread.id, id)
        runIds.push(run.id)
        for (let index = 0; index < 120; index += 1) database.recordMemoryRecall(run.id, { id: `recall-${index}`, query: 'query', promptText: `${id}-${index}`, memoryCount: 1 })
        database.finishRun(run.id, 'failed', 'The provider stopped.')
      }
      const pages = database.getActivitiesForRuns(thread.id, runIds)
      expect(pages).toHaveLength(2)
      expect(pages.map(fullSequences)).toEqual([Array.from({ length: 100 }, (_, index) => index + 20), Array.from({ length: 100 }, (_, index) => index + 20)])
      expect(pages.map((page) => page.activityWindow)).toEqual([
        { startSequence: 20, endSequence: 119, totalCount: 120, hasEarlier: true },
        { startSequence: 20, endSequence: 119, totalCount: 120, hasEarlier: true }
      ])
    } finally { database.close() }
  })

  it('pages all activity kinds in shared sequence order without losing earlier native bodies', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'long-run')
      const messages: BaseMessage[] = []
      for (let index = 0; index < 65; index += 1) {
        const call = { id: `call-${index}`, name: 'lookup', args: { index } }
        database.recordModelActivity(run.id, { id: `model-${index}`, messageId: `model-message-${index}`, status: 'completed', text: '', reasoning: '', toolCallIds: [call.id] })
        database.recordToolActivity(run.id, call, 'completed')
        database.recordMemoryRecall(run.id, { id: `recall-${index}`, query: `query-${index}`, promptText: `memory-${index}`, memoryCount: 1 })
        database.recordContextSummaryStarted(run.id, `summary-${index}`)
        database.stageContextSummary(run.id, `summary-${index}`, { summaryText: `summary body-${index}` })
        database.recordSubagentActivity(run.id, `subagent-${index}`, 'reviewer', 'completed')
        messages.push(new AIMessage({ id: `model-message-${index}`, content: `model body-${index}`, tool_calls: [call], additional_kwargs: { anas_run_id: run.id } }))
        messages.push(new ToolMessage({ id: `tool-message-${index}`, tool_call_id: call.id, content: `tool body-${index}`, additional_kwargs: { anas_run_id: run.id } }))
      }
      await putMessages(database, thread.id, messages)
      let page = database.getActivitiesForRuns(thread.id, [run.id])[0]
      expect(fullSequences(page)).toHaveLength(100)
      expect(page.activityWindow).toMatchObject({ totalCount: 325, hasEarlier: true })
      expect(page.models[0].text).toBe('model body-45')
      expect(page.models[0].round).toBe(46)
      const all = [page]
      while (page.activityWindow!.hasEarlier) {
        const before = page.activityWindow!.startSequence!
        page = database.getRunActivityWindow(run.id, { beforeSequence: before })
        expect(fullSequences(page).every((sequence) => sequence < before)).toBe(true)
        all.push(page)
      }
      expect(all.map((entry) => fullSequences(entry).length)).toEqual([100, 100, 100, 25])
      expect(all.flatMap(fullSequences).sort((a, b) => a - b)).toEqual(Array.from({ length: 325 }, (_, index) => index))
      expect(all.at(-1)!.models[0].text).toBe('model body-0')
      expect(all.at(-1)!.models[0].round).toBe(1)
      expect(all.at(-1)!.tools[0].output).toBe('tool body-0')
      expect(all.at(-1)!.summaries![0].summaryText).toBe('summary body-0')
      expect(all.at(-1)!.memoryRecalls![0].promptText).toBe('memory-0')
      expect(database.getRunActivityWindow(run.id, { beforeSequence: 0 }).activityWindow).toEqual({ startSequence: null, endSequence: null, totalCount: 325, hasEarlier: false })
      expect(() => database.getRunActivityWindow(run.id, { beforeSequence: -1 })).toThrow()
      expect(() => database.getRunActivityWindow(run.id, { beforeSequence: 1.5 })).toThrow()
    } finally { database.close() }
  })

  it('does not decode an older message body until its SQL window is requested', async () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'body-window')
      const messages = Array.from({ length: 130 }, (_, index) => new AIMessage({ id: `answer-${index}`, content: `answer body-${index}`, additional_kwargs: { anas_run_id: run.id } }))
      await putMessages(database, thread.id, messages)
      const raw = (database as unknown as { database: Database.Database }).database
      raw.prepare('UPDATE message_bodies SET value=? WHERE message_id=?').run(Buffer.from('not valid message JSON'), 'answer-0')
      const latest = database.getRunActivityWindow(run.id)
      expect(latest.models).toHaveLength(100)
      expect(latest.models[0].text).toBe('answer body-30')
      expect(latest.models[0].round).toBe(31)
      expect(() => database.getRunActivityWindow(run.id, { beforeSequence: latest.activityWindow!.startSequence! })).toThrow()
    } finally { database.close() }
  })

  it('keeps model rounds stable across windows, precise reads, and live updates for each agent', () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'rounds-run')
      for (let index = 0; index < 110; index += 1) {
        for (const subagentId of [undefined, 'child']) {
          const model = database.recordModelActivity(run.id, { id: `${subagentId ?? 'root'}-${index}`, subagentId, status: 'running', text: '', reasoning: '', toolCallIds: [] })
          expect(model.round).toBe(index + 1)
        }
      }
      const latest = database.getRunActivityWindow(run.id)
      for (const subagentId of [undefined, 'child']) {
        const models = latest.models.filter((model) => model.subagentId === subagentId)
        expect(models.map((model) => model.round)).toEqual(Array.from({ length: 50 }, (_, index) => index + 61))
        expect(database.getModelActivity(run.id, `${subagentId ?? 'root'}-0`)?.round).toBe(1)
        const updated = database.recordModelActivity(run.id, { id: `${subagentId ?? 'root'}-109`, subagentId, status: 'completed', text: 'Completed', reasoning: '', toolCallIds: [], round: 1 })
        expect(updated.round).toBe(110)
        expect(database.getModelActivity(run.id, updated.id)?.round).toBe(110)
        const appended = database.recordModelActivity(run.id, { id: `${subagentId ?? 'root'}-110`, subagentId, status: 'running', text: '', reasoning: '', toolCallIds: [] })
        expect(appended.round).toBe(111)
      }
      const earlier = database.getRunActivityWindow(run.id, { beforeSequence: latest.activityWindow!.startSequence! })
      for (const subagentId of [undefined, 'child']) {
        expect(earlier.models.filter((model) => model.subagentId === subagentId).map((model) => model.round)).toEqual(Array.from({ length: 50 }, (_, index) => index + 11))
      }
      expect(database.getRunActivityWindow(run.id).models.find((model) => model.id === 'root-109')?.round).toBe(110)
      database.finishRun(run.id, 'failed', 'Stopped.')
      const nextRun = database.createRun(thread.id, 'next-rounds-run')
      expect(database.recordModelActivity(nextRun.id, { id: 'new-root', status: 'running', text: '', reasoning: '', toolCallIds: [] }).round).toBe(1)
    } finally { database.close() }
  })

  it('keeps active children and the visible parent chain as deferred headers without loading old results', () => {
    const database = AgentDatabase.open(':memory:')
    try {
      const thread = database.createThread()
      const run = database.createRun(thread.id, 'subagent-window')
      const parent = database.createSubagentCall({
        id: 'parent', ownerThreadId: thread.id, parentThreadId: thread.id, parentRunId: run.id,
        childThreadId: 'parent-thread', childRunId: 'parent-run', config: config(), description: 'Review parent.', childThread: { title: 'Parent', projectId: thread.projectId }
      })
      const child = database.createSubagentCall({
        id: 'child', ownerThreadId: thread.id, parentThreadId: parent.childThreadId, parentRunId: parent.childRunId,
        parentSubagentId: parent.id, childThreadId: 'child-thread', childRunId: 'child-run', config: config(), description: 'Review child.', childThread: { title: 'Child', projectId: thread.projectId }
      })
      database.recordSubagentActivity(run.id, child.id, child.agentName, 'running', parent.id)
      database.finishSubagentCall({ subagentId: parent.id, ownerThreadId: thread.id, status: 'completed', result: 'large result '.repeat(10000) })
      for (let index = 0; index < 110; index += 1) database.recordMemoryRecall(run.id, { id: `recall-${index}`, query: 'query', promptText: 'memory', memoryCount: 1 })
      const latest = database.getRunActivityWindow(run.id)
      expect(fullSequences(latest)).toHaveLength(100)
      expect(latest.subagents).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: parent.id, status: 'completed', detailsDeferred: true }),
        expect.objectContaining({ id: child.id, parentSubagentId: parent.id, status: 'running', detailsDeferred: true })
      ]))
      expect(latest.subagents.every((entry) => entry.result === undefined)).toBe(true)
      expect(database.getSubagentActivity(run.id, parent.id)).toMatchObject({ result: 'large result '.repeat(10000) })
      const earlier = database.getRunActivityWindow(run.id, { beforeSequence: latest.activityWindow!.startSequence! })
      expect(earlier.subagents.find((entry) => entry.id === parent.id)).toMatchObject({ result: 'large result '.repeat(10000) })
      expect(earlier.subagents.find((entry) => entry.id === parent.id)?.detailsDeferred).toBeUndefined()
    } finally { database.close() }
  })
})
