import { afterEach, expect, it, vi } from 'vitest'
import { AgentDatabase } from './agentDatabase'
import type { AgentSubagentCallRecord } from './agentDatabase'
import { defaultCapabilities } from '@shared/agentCapabilities'
import { randomUUID } from 'node:crypto'
import { ManagedCallService } from './managedCallService'
import { cleanupUnresolvedBackgroundTasks, hasUnresolvedBackgroundTasks } from './backgroundTaskCleanup'
import { backgroundCallsCancelling, backgroundCleanupCompleted, backgroundCleanupUnconfirmed, backgroundSubagentsCancelling } from '@shared/backgroundCleanup'

vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
afterEach(() => vi.useRealTimers())

it.each(['none', 'initial', 'all'] as const)('cancels executors even when cleanup handoff writes fail (%s)', async (failure) => {
  vi.useFakeTimers()
  const database = AgentDatabase.open(':memory:')
  const thread = database.createThread()
  const run = database.createRun(thread.id, 'handoff-failure')
  const service = new ManagedCallService(database)
  let aborted = false
  const starting = service.start({ kind: 'shell', threadId: thread.id, runId: run.id, summary: 'Stop this call',
    execute: async (control) => {
      control.markRunning()
      await new Promise<void>((resolve) => control.signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }))
      return 'Stopped'
    } })
  try {
    await vi.advanceTimersByTimeAsync(10_000)
    const { call_id: callId } = JSON.parse(await starting)
    const handoff = vi.spyOn(database, 'handoffBackgroundTasksToCleanup')
    const fail = () => { throw new Error('Cannot persist cleanup handoff') }
    if (failure === 'initial') handoff.mockImplementationOnce(fail)
    if (failure === 'all') handoff.mockImplementation(fail)
    const reports: Array<{ status: string; report: string }> = []
    await cleanupUnresolvedBackgroundTasks({ database, managedCalls: service, threadId: thread.id, runId: run.id,
      cancelSubagents: async () => {}, subagentIsActive: () => false, report: (cleanup) => { reports.push(cleanup) } })
    expect(aborted).toBe(true)
    expect(service.hasActiveForThread(thread.id)).toBe(false)
    expect(database.getManagedCall(callId, thread.id)).toMatchObject({ status: 'cancelled', result: 'Stopped' })
    expect(reports.at(-1)?.status).toBe(failure === 'none' ? 'completed' : 'unconfirmed')
    expect(hasUnresolvedBackgroundTasks(database, thread.id)).toBe(failure === 'all')
    if (failure !== 'none') expect(reports.at(-1)?.report).toContain('Cannot persist cleanup handoff')
  } finally { await service.shutdown(); await service.waitForIdle(); database.close() }
})

it('removes noncooperative executors from model supervision while retaining cancellation ownership and records', async () => {
  vi.useFakeTimers()
  const database = AgentDatabase.open(':memory:')
  const thread = database.createThread({ title: 'Cancellation remains pending' })
  const run = database.createRun(thread.id, 'pending-cancellation-run')
  const service = new ManagedCallService(database)
  let finish!: () => void
  const starting = service.start({
    kind: 'mcp', threadId: thread.id, runId: run.id, summary: 'Noncooperative remote operation', uncertainWhenCancelledAfterDispatch: true,
    execute: async (control) => {
      control.markRunning()
      await new Promise<void>((resolve) => { finish = resolve })
      return 'Executor finally stopped'
    }
  })
  try {
    await vi.advanceTimersByTimeAsync(10_000)
    const id = (JSON.parse(await starting) as { call_id: string }).call_id
    const reports: string[] = []
    const cleanup = cleanupUnresolvedBackgroundTasks({
      database, managedCalls: service, threadId: thread.id, runId: run.id,
      cancelSubagents: async () => {}, subagentIsActive: () => false,
      report: (message) => { reports.push(message.report) }
    })
    await vi.advanceTimersByTimeAsync(10_000)
    await cleanup
    expect(reports.at(-1)).toContain(backgroundCallsCancelling)
    expect(reports.join('\n')).not.toContain(backgroundSubagentsCancelling)
    expect(reports.at(-1)).toContain(`call_id=${id}: unconfirmed`)
    expect(reports.at(-1)).toContain(backgroundCleanupUnconfirmed)
    expect(service.activeCallIds()).toEqual([id])
    expect(database.listUnresolvedManagedCallsForThread(thread.id)).toEqual([])
    expect(hasUnresolvedBackgroundTasks(database, thread.id)).toBe(false)
    expect(database.getManagedCall(id, thread.id)?.status).toBe('running')
    finish()
    await service.waitForIdle()
    expect(database.listUnresolvedManagedCallsForThread(thread.id)).toEqual([])
    expect(database.getManagedCall(id, thread.id)).toMatchObject({ status: 'uncertain', result: 'Executor finally stopped' })
  } finally {
    finish?.()
    await service.waitForIdle()
    database.close()
  }
})

it('bounds unconfirmed subagent cancellation and excludes later user turns from its continuing scope', async () => {
  vi.useFakeTimers()
  const database = AgentDatabase.open(':memory:')
  const thread = database.createThread()
  const run = database.createRun(thread.id, 'old-subagent-parent')
  const createChild = (parentRunId: string, parent?: AgentSubagentCallRecord) => database.createSubagentCall({
    id: randomUUID(), ownerThreadId: thread.id, parentThreadId: parent?.childThreadId ?? thread.id,
    parentRunId, ...(parent ? { parentSubagentId: parent.id } : {}),
    childThreadId: randomUUID(), childRunId: randomUUID(),
    config: { name: 'worker', index: 0, enabled: true, builtIn: false, description: 'Worker',
      systemPrompt: 'Complete the assigned task.', capabilities: structuredClone(defaultCapabilities) },
    description: 'Slow subagent', childThread: { title: 'Child' }
  })
  const child = createChild(run.id)
  let finish!: () => void
  const stopping = new Promise<void>((resolve) => { finish = resolve })
  let listScope!: () => AgentSubagentCallRecord[]
  const reports: string[] = []
  try {
    const cleanup = cleanupUnresolvedBackgroundTasks({
      database, managedCalls: new ManagedCallService(database), threadId: thread.id, runId: run.id,
      cancelSubagents: (list) => { listScope = list; return stopping },
      subagentIsActive: () => true, report: (message) => { reports.push(message.report) }
    })
    await vi.advanceTimersByTimeAsync(5_000)
    await cleanup
    expect(reports.at(-1)).toContain(backgroundSubagentsCancelling)
    expect(reports.join('\n')).not.toContain(backgroundCallsCancelling)
    expect(reports.at(-1)).toContain(`subagent_id=${child.id}: unconfirmed`)
    expect(reports.at(-1)).toContain(backgroundCleanupUnconfirmed)
    expect(database.listUnresolvedSubagentCallsForRun(run.id)).toEqual([])
    expect(hasUnresolvedBackgroundTasks(database, thread.id)).toBe(false)

    database.finishRun(run.id, 'failed', reports.at(-1))
    const nextRun = database.createRun(thread.id, 'new-user-turn')
    const nextChild = createChild(nextRun.id)
    const lateGrandchild = createChild(child.childRunId, child)
    expect(listScope().map((call) => call.id).sort()).toEqual([child.id, lateGrandchild.id].sort())
    expect(database.listUnresolvedSubagentCallsForRun(nextRun.id).map((call) => call.id)).toEqual([nextChild.id])
  } finally {
    finish()
    await stopping
    database.close()
  }
})

it('reports only retained results when all pending calls have already failed and no subagents exist', async () => {
  const database = AgentDatabase.open(':memory:')
  try {
    const thread = database.createThread()
    const run = database.createRun(thread.id, 'terminal-call-cleanup')
    for (const id of ['failed-search', 'failed-directory-search']) {
      database.createManagedCall({ id, threadId: thread.id, runId: run.id, kind: 'shell', summary: 'Search' })
      database.markManagedCallDetached(id, thread.id)
      database.finishManagedCall({ callId: id, threadId: thread.id, status: 'failed', error: 'Search failed' })
    }
    const reports: string[] = []
    await cleanupUnresolvedBackgroundTasks({
      database, managedCalls: new ManagedCallService(database), threadId: thread.id, runId: run.id,
      cancelSubagents: async () => { throw new Error('No subagent executor exists') },
      subagentIsActive: () => false, report: (message) => { reports.push(message.report) }
    })
    expect(reports.join('\n')).not.toMatch(/cancell|subagent/i)
    expect(reports.at(-1)).toContain('call_id=failed-search: failed; Search; Search failed')
    expect(reports.at(-1)).toContain('call_id=failed-directory-search: failed; Search; Search failed')
    expect(reports.at(-1)?.endsWith(backgroundCleanupCompleted)).toBe(true)
    expect(hasUnresolvedBackgroundTasks(database, thread.id)).toBe(false)
  } finally {
    database.close()
  }
})
