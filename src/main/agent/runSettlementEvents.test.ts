import { describe, expect, it } from 'vitest'
import type { AgentRun, AgentRuntimeEvent } from '@shared/agentTypes'
import { appendRunSettledEvent } from './runSettlementEvents'

const run: AgentRun = {
  id: 'run-1',
  threadId: 'thread-1',
  operation: 'agent',
  status: 'completed',
  createdAt: '2026-08-29T00:00:00.000Z',
  updatedAt: '2026-08-29T00:00:01.000Z'
}

async function collect(events: AsyncIterable<AgentRuntimeEvent>): Promise<AgentRuntimeEvent[]> {
  const collected: AgentRuntimeEvent[] = []
  for await (const event of events) collected.push(event)
  return collected
}

async function *source(...events: AgentRuntimeEvent[]): AsyncGenerator<AgentRuntimeEvent> {
  yield * events
}

describe('appendRunSettledEvent', () => {
  it('emits settlement only after the runtime iterable has released the run', async () => {
    const events = await collect(appendRunSettledEvent(source(
      { type: 'run_started', run: { ...run, status: 'running' }, newUserTurn: false },
      { type: 'run_completed', run }
    )))

    expect(events.map((event) => event.type)).toEqual([
      'run_started',
      'run_completed',
      'run_settled'
    ])
    expect(events.at(-1)).toEqual({
      type: 'run_settled',
      runId: 'run-1',
      threadId: 'thread-1',
      operation: 'agent',
      status: 'completed'
    })
  })

  it('settles an interrupted execution after its runtime iterable releases the run handle', async () => {
    const interrupted = { ...run, status: 'interrupted' as const }
    const events = await collect(appendRunSettledEvent(source({
      type: 'run_interrupted',
      run: interrupted,
      interrupts: []
    })))

    expect(events.map((event) => event.type)).toEqual([
      'run_interrupted',
      'run_settled'
    ])
    expect(events.at(-1)).toMatchObject({
      type: 'run_settled',
      runId: run.id,
      status: 'interrupted'
    })
  })
})
