import { describe, expect, it } from 'vitest'
import type { AgentRuntimeEvent } from './agentTypes'
import { compactToolCallProgress } from './agentEventReplay'

function progress(modelId: string, subagentId?: string): { event: AgentRuntimeEvent } {
  return { event: { type: 'model_tool_calls', runId: 'run', threadId: 'thread', modelId, subagentId, progress: [] } }
}

describe('tool argument replay compaction', () => {
  it('retains only the newest model snapshot, including its final clear, without crossing agent scopes', () => {
    const history = new Map<number, { event: AgentRuntimeEvent }>([
      [1, progress('a')], [2, progress('a')], [3, progress('b')], [4, progress('a', 'child')],
      [5, { event: { type: 'model_delta', runId: 'run', threadId: 'thread', modelId: 'a', delta: { type: 'text', text: 'keep' } } }],
      [7, progress('a')], [6, progress('a')]
    ])
    compactToolCallProgress(history)
    expect([...history.keys()]).toEqual([3, 4, 5, 7])
    for (let i = 8; i < 1000; i++) {
      history.set(i, progress('a'))
      compactToolCallProgress(history)
    }
    expect(history.size).toBe(4)
    expect(history.has(999)).toBe(true)
  })
})
