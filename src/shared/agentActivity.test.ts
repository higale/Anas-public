import { describe, expect, it } from 'vitest'
import type { AgentRunActivity } from './agentTypes'
import {
  applySubagentActivityUpdate,
  delegationToolForSubagent,
  subagentDescription,
  toolArgumentSummary,
  toolProvidedSummary,
  upsertSubagentActivity,
  visibleToolsForAgent
} from './agentActivity'

function activity(status: AgentRunActivity['status']): AgentRunActivity {
  return {
    runId: 'run-1',
    operation: 'agent',
    status,
    createdAt: '',
    updatedAt: '',
    models: [{
      id: 'model-1',
      messageId: 'message-1',
      sequence: 0,
      status: 'completed',
      text: 'Working',
      reasoning: '',
      toolCallIds: []
    }],
    tools: [],
    subagents: []
  }
}

describe('agent activity presentation', () => {
  it('normalizes model-provided tool summaries without treating raw arguments as summaries', () => {
    const args = {
      summary: '  Read the project\nconfiguration. ',
      path: '/workspace/settings.json'
    }

    expect(toolProvidedSummary(args)).toBe('Read the project configuration.')
    expect(toolProvidedSummary({ path: '/workspace/settings.json' })).toBeUndefined()
    expect(toolArgumentSummary({ path: '/workspace/settings.json' }))
      .toBe('/workspace/settings.json')
  })

  it('separates successful delegations from ordinary tools without hiding failed tasks', () => {
    const run = activity('running')
    run.tools.push({
      call: {
        id: 'start-child-1',
        name: 'start_subagent',
        args: { description: '  Inspect the repository\ncarefully.  ' }
      },
      sequence: 1,
      status: 'completed',
      output: JSON.stringify({ subagent_id: 'child-1' })
    }, {
      call: { id: 'failed-task', name: 'start_subagent', args: { description: 'Never started.' } },
      sequence: 2,
      status: 'completed'
    }, {
      call: { id: 'search-1', name: 'search', args: {} },
      sequence: 3,
      status: 'completed'
    })
    run.subagents.push({
      id: 'child-1',
      name: 'researcher',
      sequence: 2,
      status: 'completed'
    })

    expect(visibleToolsForAgent(run).map((tool) => tool.call.id)).toEqual([
      'failed-task',
      'search-1'
    ])
    expect(subagentDescription(run, run.subagents[0])).toBe(
      'Inspect the repository carefully.'
    )
    expect(delegationToolForSubagent(run, run.subagents[0])?.call.id).toBe('start-child-1')
  })

  it('replaces a live subagent with the complete terminal activity payload', () => {
    const running = {
      id: 'child-1',
      name: 'researcher',
      sequence: 2,
      status: 'running' as const,
      startedAt: '2026-09-04T00:00:00.000Z'
    }
    const failed = {
      ...running,
      status: 'failed' as const,
      error: 'Subagent process failed.',
      completedAt: '2026-09-04T00:00:01.000Z'
    }

    expect(upsertSubagentActivity([running], failed)).toEqual([failed])
    expect(upsertSubagentActivity([], failed)).toEqual([failed])
  })

  it('settles only the terminal subagent live model and tool projections', () => {
    const run = activity('running')
    run.models = [{
      id: 'child-model',
      sequence: 1,
      status: 'running',
      subagentId: 'child-1',
      text: 'Partial child answer',
      reasoning: 'Partial child reasoning',
      toolCallIds: ['child-tool'],
      startedAt: '2026-09-04T00:00:00.000Z'
    }, {
      id: 'sibling-model',
      sequence: 2,
      status: 'running',
      subagentId: 'sibling-1',
      text: '',
      reasoning: '',
      toolCallIds: []
    }]
    run.tools = [{
      call: { id: 'child-tool', name: 'apply_patch', args: {} },
      sequence: 3,
      status: 'running',
      subagentId: 'child-1',
      approval: {
        status: 'pending_approval',
        interruptId: 'approval-1',
        actionIndex: 0
      },
      startedAt: '2026-09-04T00:00:01.000Z'
    }, {
      call: { id: 'sibling-tool', name: 'pwsh', args: {} },
      sequence: 4,
      status: 'running',
      subagentId: 'sibling-1',
      approval: {
        status: 'pending_approval',
        interruptId: 'approval-2',
        actionIndex: 0
      }
    }]
    run.subagents = [{
      id: 'child-1',
      name: 'researcher',
      sequence: 5,
      status: 'running'
    }, {
      id: 'sibling-1',
      name: 'reviewer',
      sequence: 6,
      status: 'running'
    }]
    const completedAt = '2026-09-04T00:00:05.000Z'

    const settled = applySubagentActivityUpdate(run, {
      id: 'child-1',
      name: 'researcher',
      sequence: 5,
      status: 'cancelled',
      completedAt
    })

    expect(settled.models).toEqual([
      expect.objectContaining({
        id: 'child-model',
        status: 'completed',
        text: 'Partial child answer',
        completedAt
      }),
      run.models[1]
    ])
    expect(settled.tools).toEqual([
      expect.objectContaining({
        call: expect.objectContaining({ id: 'child-tool' }),
        status: 'completed',
        completedAt
      }),
      run.tools[1]
    ])
    expect(settled.tools[0]).not.toHaveProperty('approval')
    expect(settled.tools[1]).toHaveProperty('approval')
    expect(settled.subagents).toEqual([
      expect.objectContaining({ id: 'child-1', status: 'cancelled', completedAt }),
      run.subagents[1]
    ])
  })
})
