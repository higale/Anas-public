import { describe, expect, it } from 'vitest'
import type { AgentRunActivity } from '@shared/agentTypes'
import { mergeActivityPage, mergeSubagentDetails, preserveEarlierActivities } from './activityPagination'

function activity(start: number): AgentRunActivity {
  return { runId: 'run', operation: 'agent', status: 'running', createdAt: '', updatedAt: '',
    models: [{ id: `model-${start}`, sequence: start, status: 'running', text: 'new live value', reasoning: '', toolCallIds: [] }],
    tools: [], subagents: [], activityWindow: { startSequence: start, endSequence: start + 99, totalCount: 300, hasEarlier: start > 0 } }
}

describe('activity pagination', () => {
  it('prepends all activity kinds and keeps newer duplicate values and live events', () => {
    const current = activity(200)
    current.tools = [{ sequence: 202, call: { id: 'live-tool', name: 'test', args: {} }, status: 'running' }]
    const page = activity(100)
    page.models.push({ ...current.models[0], round: 42, text: 'stale page' })
    page.tools = [{ sequence: 101, call: { id: 'old-tool', name: 'test', args: {} }, status: 'completed' }]
    const merged = mergeActivityPage(current, page)
    expect(merged.models.map((item) => item.sequence)).toEqual([100, 200])
    expect(merged.models[1].text).toBe('new live value')
    expect(merged.models[1].round).toBe(42)
    expect(merged.tools.map((item) => item.sequence)).toEqual([101, 202])
    expect(merged.activityWindow).toEqual({ startSequence: 100, endSequence: 299, totalCount: 300, hasEarlier: true })
  })

  it('retains loaded early pages through refreshed tails and accepts authoritative tail changes', () => {
    const loaded = mergeActivityPage(activity(200), activity(0), 200)
    loaded.models[1].round = 42
    const refreshed = activity(200)
    refreshed.models[0].text = 'completed canonical result'
    refreshed.models[0].status = 'completed'
    const merged = preserveEarlierActivities(loaded, refreshed)
    expect(merged.models.map((item) => item.sequence)).toEqual([0, 200])
    expect(merged.models[1].text).toBe('completed canonical result')
    expect(merged.models[1].round).toBe(42)
    expect(merged.activityWindow).toEqual({ startSequence: 0, endSequence: 299, totalCount: 300, hasEarlier: false })
    expect(preserveEarlierActivities(loaded, { ...refreshed, runId: 'new-run' })).toEqual({ ...refreshed, runId: 'new-run' })
  })

  it('fills matching deferred child headers and retains loaded details through tail refreshes', () => {
    const current = activity(200)
    current.subagents = [{ id: 'child', name: 'Child', sequence: 201, status: 'completed', completedAt: 'finished', detailsDeferred: true }]
    const page = activity(0)
    page.subagents = [{ ...current.subagents[0], result: 'complete result', detailsDeferred: false }]
    const merged = mergeActivityPage(current, page)
    expect(merged.subagents[0]).toMatchObject({ result: 'complete result', detailsDeferred: false })
    expect(preserveEarlierActivities(merged, current).subagents[0]).toMatchObject({ result: 'complete result', detailsDeferred: false })
    expect(mergeSubagentDetails({ ...current.subagents[0], completedAt: 'new completion' }, page.subagents[0]).detailsDeferred).toBe(true)
    expect(mergeSubagentDetails({ ...current.subagents[0], status: 'running' }, page.subagents[0]).detailsDeferred).toBe(true)
  })

  it('keeps gaps loadable across refreshed tails and pages them until coverage joins', () => {
    const previous = activity(0)
    const refreshed = preserveEarlierActivities(previous, activity(300))
    expect(refreshed.models.map((item) => item.sequence)).toEqual([0, 300])
    expect(refreshed.activityWindow).toMatchObject({ startSequence: 300, endSequence: 399, hasEarlier: true })
    const firstPage = mergeActivityPage(refreshed, activity(200), 300)
    expect(firstPage.activityWindow).toMatchObject({ startSequence: 200, hasEarlier: true })
    const joined = mergeActivityPage(firstPage, activity(100), 200)
    // The untracked old prefix stays visible; its coverage is confirmed again
    // before claiming there is no more history.
    expect(joined.activityWindow).toMatchObject({ startSequence: 100, hasEarlier: true })
    expect(mergeActivityPage(joined, activity(0), 100).activityWindow)
      .toMatchObject({ startSequence: 0, endSequence: 399, hasEarlier: false })
  })

  it('does not bridge a newer gap with a late page or an empty stale page', () => {
    const oldPage = activity(0)
    const latest = activity(300)
    const merged = mergeActivityPage(latest, oldPage, 100)
    expect(merged.activityWindow).toMatchObject({ startSequence: 300, hasEarlier: true })
    const empty = { ...oldPage, models: [], activityWindow: {
      startSequence: null, endSequence: null, totalCount: 400, hasEarlier: false
    } }
    expect(mergeActivityPage(latest, empty, 100).activityWindow)
      .toMatchObject({ startSequence: 300, hasEarlier: true })
    expect(mergeActivityPage(latest, empty, 300).activityWindow)
      .toMatchObject({ startSequence: 300, hasEarlier: false })
  })
})
