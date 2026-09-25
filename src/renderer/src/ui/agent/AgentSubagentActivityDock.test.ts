import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { AgentRunActivity } from '@shared/agentTypes'
import {
  activeSubagentsForRun,
  AgentSubagentActivityTrigger,
  AgentSubagentStatusIcon,
  subagentActivityPhase,
  subagentActivityDetails,
  subagentStatusLabel
} from './AgentSubagentActivityDock'

const run: AgentRunActivity = {
  runId: 'run-1',
  operation: 'agent',
  status: 'running',
  createdAt: '2026-08-02T10:00:00.000Z',
  updatedAt: '2026-08-02T10:00:01.000Z',
  models: [{
    id: 'model-1',
    sequence: 3,
    status: 'running',
    subagentId: 'subagent-b',
    text: 'Live reply',
    reasoning: 'Inspecting current implementation.',
    toolCallIds: []
  }],
  tools: [{
    call: {
      id: 'start-subagent-b',
      name: 'start_subagent',
      args: { description: '  Inspect the repository\nfor unfinished work.  ' }
    },
    sequence: 1,
    status: 'completed',
    output: JSON.stringify({ subagent_id: 'subagent-b' })
  }, {
    call: {
      id: 'tool-1',
      name: 'search',
      args: { summary: '  Search the project\nsource. ' }
    },
    sequence: 4,
    status: 'running',
    subagentId: 'subagent-b'
  }],
  subagents: [{
    id: 'subagent-a',
    name: 'completed-agent',
    sequence: 1,
    status: 'completed'
  }, {
    id: 'subagent-b',
    name: 'second-agent',
    sequence: 2,
    status: 'running'
  }, {
    id: 'subagent-c',
    name: 'first-agent',
    sequence: 0,
    status: 'running'
  }, {
    id: 'subagent-waiting',
    name: 'approval-agent',
    sequence: 4,
    status: 'interrupted'
  }, {
    id: 'subagent-child',
    name: 'child-agent',
    sequence: 5,
    status: 'completed',
    parentSubagentId: 'subagent-b'
  }]
}

describe('AgentSubagentActivityDock', () => {
  it('shows running and approval-blocked subagents in activity order', () => {
    expect(activeSubagentsForRun(run).map((subagent) => subagent.id)).toEqual([
      'subagent-c',
      'subagent-b',
      'subagent-waiting'
    ])
  })

  it('summarizes activity owned by the selected subagent', () => {
    expect(subagentActivityDetails(run, 'subagent-b')).toEqual({
      childSubagentCount: 1,
      currentToolName: 'search',
      currentToolSummary: 'Search the project source.',
      description: 'Inspect the repository for unfinished work.',
      modelCount: 1,
      recoveryError: false,
      replying: true,
      activeChildSubagentCount: 0,
      runningToolCount: 1,
      thinking: false,
      toolCount: 1
    })
  })

  it('distinguishes streamed reasoning from reply text', () => {
    const thinkingRun: AgentRunActivity = {
      ...run,
      models: run.models.map((model) => ({ ...model, text: '' })),
      tools: run.tools.filter((tool) => !tool.subagentId)
    }

    expect(subagentActivityDetails(thinkingRun, 'subagent-b')).toMatchObject({
      currentToolName: undefined,
      currentToolSummary: undefined,
      replying: false,
      runningToolCount: 0,
      thinking: true
    })
  })

  it('uses the current tool summary and reports additional parallel tools', () => {
    const parallelRun: AgentRunActivity = {
      ...run,
      tools: [
        ...run.tools,
        {
          call: { id: 'tool-2', name: 'read_file', args: {} },
          sequence: 5,
          status: 'running',
          subagentId: 'subagent-b'
        },
        {
          call: {
            id: 'tool-3',
            name: 'pwsh',
            args: { summary: 'Run repository checks' }
          },
          sequence: 6,
          status: 'running',
          subagentId: 'subagent-b'
        }
      ]
    }
    const details = subagentActivityDetails(parallelRun, 'subagent-b')

    expect(subagentActivityPhase(details, 'running')).toBe('Run repository checks · +2')
    expect(subagentActivityPhase({
      ...details,
      currentToolName: 'read_file',
      currentToolSummary: undefined,
      runningToolCount: 1
    }, 'running')).toBe('call read_file')
  })

  it.each([
    ['running', 'Running', 'Preparing'],
    ['interrupted', 'Waiting for approval', 'Waiting for approval'],
    ['completed', 'Completed', 'Completed'],
    ['failed', 'Failed', 'Failed'],
    ['cancelled', 'Cancelled', 'Cancelled']
  ] as const)('presents the %s state explicitly', (status, label, phase) => {
    const details = subagentActivityDetails({ ...run, models: [], tools: [] }, 'subagent-c')
    expect(subagentStatusLabel(status)).toBe(label)
    expect(subagentActivityPhase(details, status)).toBe(phase)
  })

  it.each([
    ['interrupted', 'Waiting for approval', 'lucide-shield-alert'],
    ['failed', 'Failed', 'lucide-circle-x'],
    ['cancelled', 'Cancelled', 'lucide-ban']
  ] as const)('renders the %s state without treating it as completed', (status, label, icon) => {
    const statusRun: AgentRunActivity = {
      ...run,
      subagents: [{
        id: 'status-agent',
        name: 'status-agent',
        sequence: 0,
        status
      }]
    }
    const trigger = renderToStaticMarkup(createElement(AgentSubagentActivityTrigger, {
      run: statusRun,
      subagentId: 'status-agent',
      variant: 'labeled',
      onOpenSubagent: () => undefined
    }))
    const indicator = renderToStaticMarkup(createElement(AgentSubagentStatusIcon, { status }))

    expect(trigger).toContain(`data-status="${status}"`)
    expect(trigger).toContain(label)
    expect(trigger).not.toContain('Completed')
    expect(indicator).toContain(icon)
  })

  it('surfaces a recoverable runtime error without changing the durable status', () => {
    const statusRun: AgentRunActivity = {
      ...run,
      subagents: [{
        id: 'recovering-agent',
        name: 'recovering-agent',
        sequence: 0,
        status: 'running',
        error: 'RECOVERY_FAILURE'
      }]
    }
    const details = subagentActivityDetails(statusRun, 'recovering-agent')
    const trigger = renderToStaticMarkup(createElement(AgentSubagentActivityTrigger, {
      run: statusRun,
      subagentId: 'recovering-agent',
      variant: 'labeled',
      onOpenSubagent: () => undefined
    }))

    expect(details.recoveryError).toBe(true)
    expect(subagentActivityPhase(details, 'running')).toBe('Recovery error')
    expect(trigger).toContain('data-status="running"')
    expect(trigger).toContain('data-recovery-error=""')
    expect(trigger).toContain('Recovery error')
  })
})
