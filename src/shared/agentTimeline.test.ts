import { describe, expect, it } from 'vitest'
import type { AgentMessage, AgentRunActivity } from './agentTypes'
import { projectRunActivityItems, projectTurnTimeline } from './agentTimeline'
import { backgroundTasksPendingError } from './backgroundCleanup'

const messages: AgentMessage[] = [{
  id: 'user-1',
  role: 'user',
  runId: 'run-1',
  content: [{ type: 'text', text: 'Question' }]
}, {
  id: 'assistant-1',
  role: 'assistant',
  runId: 'run-1',
  content: [{ type: 'text', text: 'Final' }]
}]

function completedRun(): AgentRunActivity {
  return {
    runId: 'run-1',
    operation: 'agent',
    status: 'completed',
    createdAt: '',
    updatedAt: '',
    models: [{
      id: 'model-1',
      sequence: 1,
      status: 'completed',
      text: 'Intermediate',
      reasoning: '',
      toolCallIds: ['tool-1']
    }, {
      id: 'model-2',
      messageId: 'assistant-1',
      sequence: 4,
      status: 'completed',
      text: 'Final',
      reasoning: 'Final reasoning',
      toolCallIds: []
    }],
    tools: [{
      call: { id: 'tool-1', name: 'search', args: {} },
      sequence: 2,
      status: 'completed',
      output: 'result'
    }],
    subagents: [{
      id: 'subagent-1',
      name: 'researcher',
      sequence: 3,
      status: 'completed'
    }]
  }
}

describe('projectTurnTimeline', () => {
  it('projects cleanup separately from a completed run and retains its explicit outcome', () => {
    for (const status of ['running', 'completed', 'unconfirmed'] as const) {
      const run = { ...completedRun(), backgroundCleanup: { status, report: backgroundTasksPendingError } }
      const entries = projectTurnTimeline(messages, [run]).entries
      expect(entries.at(-1)).toMatchObject({ type: 'cleanup', cleanup: { status } })
      expect(entries.some((entry) => entry.type === 'error')).toBe(false)
      expect(entries.find((entry) => entry.type === 'activity-range')).toMatchObject({ run: { status: 'completed' } })
    }
  })
  it('retains registered model rounds when earlier pages are prepended', () => {
    const run = completedRun()
    run.models[0].round = 101
    run.models[1].round = 102
    const models = (activity: AgentRunActivity) => projectRunActivityItems(activity, new Map(), [])
      .filter((item) => item.type === 'model').map((item) => [item.model.id, item.round])
    expect(models(run)).toEqual([['model-1', 101], ['model-2', 102]])
    const withEarlier = { ...run, models: [
      { ...run.models[0], id: 'earlier-model', sequence: 0, round: 100 }, ...run.models
    ] }
    expect(models(withEarlier)).toEqual([['earlier-model', 100], ['model-1', 101], ['model-2', 102]])
    expect(models({ ...run, models: [{ ...run.models[0], round: undefined }] })).toEqual([['model-1', undefined]])
  })

  it('keeps parallel previews in their own agent round without counting them as executed tools', () => {
    const run = completedRun()
    run.status = 'running'
    run.tools = []
    run.models = [{
      ...run.models[0], status: 'running', toolCallIds: [],
      toolCallProgress: [0, 1].map((index) => ({
        index, callId: `draft-${index}`, name: 'apply_patch', characterCount: 2,
        complete: false
      }))
    }, {
      ...run.models[1], status: 'running', subagentId: 'subagent-1',
      toolCallProgress: [{ index: 0, callId: 'draft-0', name: 'read_file', characterCount: 2, complete: false }]
    }]
    run.subagents[0].status = 'running'
    const root = projectRunActivityItems(run, new Map(), [])
    expect(root.filter((item) => item.type === 'tool').map((item) => item.tool.call.name)).toEqual(['apply_patch', 'apply_patch'])
    const range = projectTurnTimeline(messages.slice(0, 1), [run]).entries.find((entry) => entry.type === 'activity-range')
    expect(range?.toolCount).toBe(0)
    run.status = 'completed'
    expect(projectRunActivityItems(run, new Map(), []).filter((item) => item.type === 'tool')).toEqual([])
    const child = projectRunActivityItems(run, new Map(), [], 'subagent-1')
    expect(child.filter((item) => item.type === 'tool').map((item) => item.tool.call.name)).toEqual(['read_file'])
    run.subagents[0].status = 'cancelled'
    expect(projectRunActivityItems(run, new Map(), [], 'subagent-1').filter((item) => item.type === 'tool')).toEqual([])
  })

  it('places one collapsible activity range between the user and final message', () => {
    const timeline = projectTurnTimeline(messages, [completedRun()])
    expect(timeline.entries.map((entry) => entry.type)).toEqual([
      'message',
      'activity-range',
      'message'
    ])
    const range = timeline.entries[1]
    expect(range.type).toBe('activity-range')
    if (range.type !== 'activity-range') return
    expect(range.startsExpanded).toBe(false)
    expect(range.finalMessageId).toBe('assistant-1')
    expect(range.items.map((item) => item.type)).toEqual([
      'model',
      'tool',
      'subagent',
      'model'
    ])
    const finalModel = range.items.at(-1)
    expect(finalModel?.type).toBe('model')
    if (finalModel?.type === 'model') expect(finalModel.showText).toBe(false)
  })

  it('places an applied direction after its corresponding tool instead of after the turn input', () => {
    const direction: AgentMessage = {
      id: 'direction-1',
      role: 'user',
      runId: 'run-1',
      content: [{ type: 'text', text: 'Use the result to check another case.' }],
      directionAfterToolCallIds: ['tool-1']
    }
    const timeline = projectTurnTimeline([
      messages[0],
      direction,
      messages[1]
    ], [completedRun()])

    expect(timeline.entries.map((entry) => entry.type)).toEqual([
      'message',
      'activity-range',
      'message'
    ])
    const range = timeline.entries[1]
    expect(range.type).toBe('activity-range')
    if (range.type !== 'activity-range') return
    expect(range.items.map((item) => item.type)).toEqual([
      'model',
      'tool',
      'direction',
      'subagent',
      'model'
    ])
    expect(range.items[2]).toMatchObject({
      type: 'direction',
      message: { id: 'direction-1' }
    })
  })

  it('projects recalled memory at its durable activity sequence', () => {
    const run = completedRun()
    run.memoryRecalls = [{
      id: 'recall-1',
      sequence: 0,
      query: 'Question',
      promptText: '<relevant_memories>MEMORY</relevant_memories>',
      memoryCount: 1,
      createdAt: '2026-08-26T00:00:00.000Z'
    }]

    expect(projectRunActivityItems(run, new Map(), messages).at(0)).toMatchObject({
      type: 'memory',
      recall: { id: 'recall-1', promptText: expect.stringContaining('MEMORY') }
    })
  })

  it('keeps a live candidate expanded after its user input', () => {
    const run = completedRun()
    run.status = 'running'
    run.models = [{
      ...run.models[0],
      id: 'live-model',
      status: 'running',
      text: 'Live',
      toolCallIds: []
    }]
    run.tools = []
    run.subagents = []
    const timeline = projectTurnTimeline(messages.slice(0, 1), [], run)
    const range = timeline.entries[1]
    expect(range.type).toBe('activity-range')
    if (range.type === 'activity-range') {
      expect(range.startsExpanded).toBe(true)
      expect(range.finalMessageId).toBeUndefined()
      expect(range.items[0]).toMatchObject({ type: 'model', showText: true })
    }
  })

  it.each(['running', 'failed', 'cancelled', 'interrupted', 'completed'] as const)(
    'shows a checkpoint reply once when its run is %s', (status) => {
      const run = { ...completedRun(), status, error: 'Cleanup report' }
      const visibleTexts = (loadedMessages: AgentMessage[]) => projectTurnTimeline(loadedMessages, [run]).entries
        .flatMap((entry) => entry.type === 'message'
          ? entry.message.content.flatMap((block) => block.type === 'text' ? [block.text] : [])
          : entry.type === 'activity-range'
            ? entry.items.flatMap((item) => item.type === 'model' && item.showText ? [item.model.text] : [])
            : [])
      expect(visibleTexts(messages.slice(0, 1)).filter((text) => text === 'Final')).toHaveLength(1)
      expect(visibleTexts(messages).filter((text) => text === 'Final')).toHaveLength(1)
      const range = projectTurnTimeline(messages, [run]).entries.find((entry) => entry.type === 'activity-range')
      expect(range?.items).toContainEqual(expect.objectContaining({
        type: 'model', showText: false, model: expect.objectContaining({ reasoning: 'Final reasoning' })
      }))
      expect(projectTurnTimeline(messages, [run]).entries.at(-1))
        .toMatchObject({ type: 'error', message: 'Cleanup report' })
      // A reply in a different run must not hide this run's activity text.
      expect(projectRunActivityItems(run, new Map(), [{ ...messages[1], runId: 'other-run' }]))
        .toContainEqual(expect.objectContaining({ type: 'model', showText: true,
          model: expect.objectContaining({ messageId: messages[1].id }) }))
    }
  )

  it.each([true, false])('keeps errors after their own reply and before the next turn (checkpoint loaded: %s)', (loaded) => {
    const run = { ...completedRun(), status: 'failed' as const, error: 'Cleanup failed' }
    const nextMessage: AgentMessage = { id: 'next-user', role: 'user', runId: 'next-run',
      content: [{ type: 'text', text: 'Next question' }] }
    const timeline = projectTurnTimeline([...(loaded ? messages : messages.slice(0, 1)), nextMessage], [run])
    const errorIndex = timeline.entries.findIndex((entry) => entry.type === 'error')
    const nextIndex = timeline.entries.findIndex((entry) => entry.type === 'message' && entry.message.id === nextMessage.id)
    const replyIndex = timeline.entries.findIndex((entry) => loaded
      ? entry.type === 'message' && entry.message.id === messages[1].id
      : entry.type === 'activity-range' && entry.items.some((item) => item.type === 'model' && item.showText))
    expect(errorIndex).toBeGreaterThan(replyIndex)
    expect(errorIndex).toBeLessThan(nextIndex)
    expect(timeline.entries.filter((entry) => entry.type === 'error')).toHaveLength(1)
  })

  it('does not add a collapsed row when the turn only contains the final reply', () => {
    const run = completedRun()
    run.models = [{
      ...run.models[1],
      reasoning: ''
    }]
    run.tools = []
    run.subagents = []
    const timeline = projectTurnTimeline(messages, [run])
    expect(timeline.entries.map((entry) => entry.type)).toEqual(['message', 'message'])
  })

  it('keeps an unconfirmed completed candidate visible when its checkpoint message is absent', () => {
    const run = completedRun()
    run.models = [{
      ...run.models[1],
      reasoning: ''
    }]
    run.tools = []
    run.subagents = []
    const timeline = projectTurnTimeline(messages.slice(0, 1), [run])
    const range = timeline.entries[1]
    expect(range.type).toBe('activity-range')
    if (range.type === 'activity-range') {
      expect(range.startsExpanded).toBe(true)
      expect(range.finalMessageId).toBeUndefined()
      expect(range.items[0]).toMatchObject({ type: 'model', showText: true })
    }
  })

  it('shows a terminal run without a final message even when it has no activity', () => {
    const run = completedRun()
    run.models = []
    run.tools = []
    run.subagents = []
    const timeline = projectTurnTimeline(messages.slice(0, 1), [run])
    expect(timeline.entries[1]).toMatchObject({
      type: 'activity-range',
      startsExpanded: true,
      items: []
    })
  })

  it('projects subagent content independently without root activity', () => {
    const run = completedRun()
    run.models.push({
      id: 'child-model',
      subagentId: 'subagent-1',
      sequence: 5,
      status: 'completed',
      text: 'Child result',
      reasoning: '',
      toolCallIds: []
    })
    expect(projectRunActivityItems(run, new Map(), [], 'subagent-1'))
      .toMatchObject([{ type: 'model', showText: true }])
  })

  it('projects a successful task delegation as one subagent item at the tool position', () => {
    const run = completedRun()
    run.tools = [{
      call: {
        id: 'start-subagent-1',
        name: 'start_subagent',
        args: { description: '  Research the latest\nproject news.  ' }
      },
      sequence: 2,
      status: 'completed',
      output: JSON.stringify({ subagent_id: 'subagent-1' })
    }]
    run.subagents[0].sequence = 3

    const timeline = projectTurnTimeline(messages, [run])
    const range = timeline.entries[1]
    expect(range.type).toBe('activity-range')
    if (range.type !== 'activity-range') return
    expect(range.toolCount).toBe(0)
    expect(range.subagentCount).toBe(1)
    expect(range.items.map((item) => item.type)).toEqual([
      'model',
      'subagent',
      'model'
    ])
    expect(range.items[1]).toMatchObject({ type: 'subagent' })
  })

  it('keeps an unmatched task call visible when no subagent starts', () => {
    const run = completedRun()
    run.subagents = []
    run.tools = [{
      call: { id: 'failed-task', name: 'start_subagent', args: { description: 'Delegate work.' } },
      sequence: 2,
      status: 'completed',
      output: 'Subagent failed to start'
    }]

    const timeline = projectTurnTimeline(messages, [run])
    const range = timeline.entries[1]
    expect(range.type).toBe('activity-range')
    if (range.type !== 'activity-range') return
    expect(range.toolCount).toBe(1)
    expect(range.subagentCount).toBe(0)
    expect(range.items.some((item) => item.type === 'tool')).toBe(true)
  })

  it('keeps persisted compression summaries at their message boundary', () => {
    const run = completedRun()
    run.summaries = [{
      id: 'summary-1',
      sequence: 0,
      status: 'completed',
      summaryText: 'Summary',
      coveredThroughMessageId: 'user-1',
      firstPreservedMessageId: 'assistant-1',
      createdAt: ''
    }]
    const timeline = projectTurnTimeline(messages, [run])
    expect(timeline.entries.map((entry) => entry.type)).toEqual([
      'message',
      'summary',
      'activity-range',
      'message'
    ])
  })
})
