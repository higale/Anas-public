import { useState } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuntimeEvent } from '@shared/agentTypes'
import type { RoundFileChangesResult, RoundFileContentInput } from '@shared/fileChanges'
import type { DiffContents } from '@shared/diffContents'
import { AgentChangesPanel } from './AgentChangesPanel'
import { PanelViewState } from './PanelViewState'

const { t } = vi.hoisted(() => ({ t: (key: string) => key }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }))
vi.mock('../notice', () => ({ notice: { success: vi.fn(), error: vi.fn() } } ))
vi.mock('../diff/ReadonlyDiff', () => ({ ReadonlyDiff: ({ data }: { data: DiffContents }) => <div>{data.status === 'ready' ? data.after : data.reason}</div> }))
const rounds = vi.fn(), files = vi.fn(), contents = vi.fn(), cancel = vi.fn(async () => {}), unsubscribe = vi.fn()
let receive: (event: AgentRuntimeEvent) => void
let resync: () => Promise<void>
const newest = { runId: 'run', createdAt: '2026-09-13T10:00:00Z', summary: 'Newest changes', status: 'completed' }
const older = { runId: 'older', createdAt: '2026-09-13T09:00:00Z', summary: 'Older changes', status: 'completed' }
function result(overrides: Partial<RoundFileChangesResult> = {}): RoundFileChangesResult {
  return { runId: 'run', version: 'a'.repeat(64), files: ['/project/one.ts', '/project/two.ts'].map((path) => ({
    path, origins: [{ actor: 'root', threadId: 'thread', runId: 'run', operationId: 'op', entryIndex: 0, direction: 'forward' }],
    beforeExists: true, afterExists: true, continuity: 'recorded', cancelledOut: false
  })), issues: [], pendingRunIds: [], hasMore: false, ...overrides }
}
function Harness({ initialRun = '', onReview = vi.fn(async () => {}) }: { initialRun?: string; onReview?: () => Promise<void> }) {
  const [runId, setRunId] = useState(initialRun), [compareCurrent, setCompareCurrent] = useState(false)
  const [state] = useState(() => new Map<string, unknown>())
  return <PanelViewState state={state}><AgentChangesPanel threadId="thread" runId={runId} onRunChange={setRunId}
    compareCurrent={compareCurrent} onCompareCurrentChange={setCompareCurrent} onReview={onReview} /></PanelViewState>
}
beforeEach(() => {
  rounds.mockReset().mockImplementation(async ({ selectedRunId }) => ({ rounds: [newest, older], hasMore: false,
    ...(selectedRunId ? { selectedRound: [newest, older].find((round) => round.runId === selectedRunId) ?? null } : {}) }))
  files.mockReset().mockImplementation(async ({ runId }) => result({ runId }))
  contents.mockReset().mockImplementation(async (input: RoundFileContentInput) => ({
    status: 'ready', path: input.filePath, before: 'before',
    after: `${input.target}:${input.filePath}:${input.runId}`, beforeExists: true, afterExists: true
  }))
  cancel.mockClear(); unsubscribe.mockClear()
  Object.defineProperty(window, 'gale', { configurable: true, value: { agent: {
    changes: { rounds, roundFiles: files, roundContents: contents, cancelRead: cancel },
    onEvent: (listener: typeof receive, reconnect: typeof resync) => { receive = listener; resync = reconnect; return unsubscribe }
  } } })
})

describe('recorded changes panel', () => {
  it('selects the newest changed run and reads only the selected file', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await screen.findByText('recorded:/project/one.ts:run')
    expect((screen.getByRole('combobox', { name: 'agent.changes_select_round' }) as HTMLInputElement).value).toContain('Newest changes')
    expect(contents).toHaveBeenCalledTimes(1)
    expect(contents).toHaveBeenLastCalledWith(expect.objectContaining({ runId: 'run', filePath: '/project/one.ts', target: 'recorded' }), expect.any(String))
    const listReads = files.mock.calls.length
    await user.click(screen.getByRole('button', { name: /\/project\/two.ts/ }))
    await screen.findByText('recorded:/project/two.ts:run')
    expect(files).toHaveBeenCalledTimes(listReads)
  })

  it('keeps current comparison across file and run selection and sends the same target to review', async () => {
    const user = userEvent.setup(), review = vi.fn(async () => {})
    render(<Harness onReview={review} />)
    await screen.findByText('recorded:/project/one.ts:run')
    await user.click(screen.getByRole('checkbox', { name: 'agent.changes_compare_current' }))
    await screen.findByText('current:/project/one.ts:run')
    await user.click(screen.getByRole('button', { name: /\/project\/two.ts/ }))
    await screen.findByText('current:/project/two.ts:run')
    await user.click(screen.getByRole('combobox', { name: 'agent.changes_select_round' }))
    await user.click(screen.getByRole('option', { name: /Older changes/ }))
    await screen.findByText('current:/project/one.ts:older')
    expect(screen.getByRole('checkbox', { name: 'agent.changes_compare_current' })).toBeChecked()
    await user.click(screen.getByRole('button', { name: 'agent.review_start' }))
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ runId: 'older', filePath: '/project/one.ts', target: 'current' }))
  })

  it('retains the selected older run and its label when new changes refresh recent candidates', async () => {
    const user = userEvent.setup()
    let newestRound = newest
    rounds.mockImplementation(async ({ after, selectedRunId }) => ({ rounds: after ? [older] : [newestRound], hasMore: !after, nextAfter: after ? undefined : 20,
      ...(selectedRunId ? { selectedRound: [newestRound, newest, older].find((round) => round.runId === selectedRunId) ?? null } : {}) }))
    render(<Harness />)
    await screen.findByText('recorded:/project/one.ts:run')
    await user.click(screen.getByRole('combobox', { name: 'agent.changes_select_round' }))
    await user.click(screen.getByRole('button', { name: 'agent.changes_more_rounds' }))
    await user.click(await screen.findByRole('option', { name: /Older changes/ }))
    await screen.findByText('recorded:/project/one.ts:older')
    const roundReads = rounds.mock.calls.length
    newestRound = { ...newest, runId: 'newer', summary: 'Newest now' }
    act(() => receive({ type: 'file_changes', threadId: 'thread', runId: 'newer' }))
    await waitFor(() => expect(rounds.mock.calls.length).toBeGreaterThan(roundReads))
    await screen.findByText('recorded:/project/one.ts:older')
    expect((screen.getByRole('combobox', { name: 'agent.changes_select_round' }) as HTMLInputElement).value).toContain('Older changes')
    expect(files).toHaveBeenLastCalledWith(expect.objectContaining({ runId: 'older' }), expect.any(String))
    expect(rounds).toHaveBeenLastCalledWith(expect.objectContaining({ selectedRunId: 'older' }), expect.any(String))
  })

  it('removes a deleted selected run and selects the newest surviving run after invalidation', async () => {
    const user = userEvent.setup()
    let deleted = false
    rounds.mockImplementation(async ({ selectedRunId }) => {
      const available = deleted ? [older] : [newest, older]
      return { rounds: available, hasMore: false,
        ...(selectedRunId ? { selectedRound: available.find((round) => round.runId === selectedRunId) ?? null } : {}) }
    })
    render(<Harness />)
    await screen.findByText('recorded:/project/one.ts:run')
    await user.click(screen.getByRole('checkbox', { name: 'agent.changes_compare_current' }))
    deleted = true
    act(() => receive({ type: 'file_changes', threadId: 'thread', runId: 'run' }))
    await screen.findByText('current:/project/one.ts:older')
    expect((screen.getByRole('combobox', { name: 'agent.changes_select_round' }) as HTMLInputElement).value).toContain('Older changes')
    expect(screen.getByRole('checkbox', { name: 'agent.changes_compare_current' })).toBeChecked()
    await user.click(screen.getByRole('combobox', { name: 'agent.changes_select_round' }))
    expect(screen.queryByRole('option', { name: /Newest changes/ })).not.toBeInTheDocument()
  })

  it('clears a deleted selected run when no changed runs remain', async () => {
    render(<Harness />)
    await screen.findByText('recorded:/project/one.ts:run')
    rounds.mockImplementation(async ({ selectedRunId }) => ({ rounds: [], hasMore: false,
      ...(selectedRunId ? { selectedRound: null } : {}) }))
    act(() => receive({ type: 'file_changes', threadId: 'thread', runId: 'run' }))
    expect(await screen.findByText('agent.changes_no_rounds')).toBeVisible()
    expect(screen.queryByText('recorded:/project/one.ts:run')).not.toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'agent.changes_select_round' })).toHaveValue('')
    expect(screen.queryByRole('button', { name: 'agent.review_start' })).not.toBeInTheDocument()
  })

  it('pins file paging to its version and refreshes from the first page after a stale read', async () => {
    const user = userEvent.setup()
    files.mockResolvedValueOnce(result({ hasMore: true, nextAfter: '/project/two.ts' }))
    render(<Harness />)
    await screen.findByRole('button', { name: 'agent.changes_next' })
    files.mockRejectedValueOnce(new Error('Records changed'))
    await user.click(screen.getByRole('button', { name: 'agent.changes_next' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Records changed')
    expect(files).toHaveBeenLastCalledWith(expect.objectContaining({ after: '/project/two.ts', version: 'a'.repeat(64) }), expect.any(String))
    expect(screen.getByRole('button', { name: 'agent.review_start' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'common.refresh' }))
    await screen.findByText('recorded:/project/one.ts:run')
    expect(files.mock.lastCall![0]).not.toHaveProperty('after')
  })

  it('restarts at the first file page without the stale version when a paged run changes', async () => {
    const user = userEvent.setup()
    const firstPage = Array.from({ length: 20 }, (_, index) => ({ ...result().files[0], path: `/project/${String(index).padStart(2, '0')}.ts` }))
    let currentVersion = 'a'.repeat(64)
    files.mockImplementation(async (input) => {
      if (input.version && input.version !== currentVersion) throw new Error('Records changed')
      return result({ version: currentVersion,
        files: input.after ? [{ ...result().files[0], path: '/project/20.ts' }] : firstPage,
        hasMore: !input.after, ...(!input.after ? { nextAfter: '/project/19.ts' } : {}) })
    })
    render(<Harness />)
    await screen.findByText('recorded:/project/00.ts:run')
    const checkbox = screen.getByRole('checkbox', { name: 'agent.changes_compare_current' })
    await user.click(checkbox)
    await user.click(screen.getByRole('button', { name: 'agent.changes_next' }))
    await screen.findByText('current:/project/20.ts:run')
    expect(files).toHaveBeenLastCalledWith(expect.objectContaining({ after: '/project/19.ts', version: 'a'.repeat(64) }), expect.any(String))
    const readsBeforeChange = files.mock.calls.length
    currentVersion = 'b'.repeat(64)
    act(() => receive({ type: 'file_changes', threadId: 'thread', runId: 'run' }))
    await screen.findByText('current:/project/00.ts:run')
    expect(files.mock.calls.slice(readsBeforeChange).map(([input]) => input)).toEqual([
      { threadId: 'thread', runId: 'run', limit: 20 }
    ])
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'agent.changes_previous' })).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'agent.changes_compare_current' })).toBe(checkbox)
    expect(checkbox).toBeChecked()
    expect((screen.getByRole('combobox', { name: 'agent.changes_select_round' }) as HTMLInputElement).value).toContain('Newest changes')
    expect(contents).toHaveBeenLastCalledWith(expect.objectContaining({ version: 'b'.repeat(64), target: 'current' }), expect.any(String))
  })

  it('cancels a pending old run read and ignores its late response', async () => {
    const user = userEvent.setup()
    let finish!: (value: RoundFileChangesResult) => void
    files.mockImplementationOnce(() => new Promise<RoundFileChangesResult>((resolve) => { finish = resolve }))
    render(<Harness />)
    await waitFor(() => expect(files).toHaveBeenCalledOnce())
    const oldRequest = files.mock.calls[0][1]
    await user.click(screen.getByRole('combobox', { name: 'agent.changes_select_round' }))
    await user.click(screen.getByRole('option', { name: /Older changes/ }))
    await screen.findByText('recorded:/project/one.ts:older')
    expect(cancel).toHaveBeenCalledWith(oldRequest)
    await act(async () => finish(result()))
    expect(screen.queryByText('recorded:/project/one.ts:run')).not.toBeInTheDocument()
  })

  it('ignores other conversations and progress-only subagent updates, and refreshes after resync', async () => {
    render(<Harness />)
    await screen.findByText('recorded:/project/one.ts:run')
    const reads = rounds.mock.calls.length
    act(() => receive({ type: 'file_changes', threadId: 'other', runId: 'run' }))
    act(() => receive({ type: 'subagent_updated', threadId: 'thread', runId: 'run', subagent: { id: 'child', name: 'Child', sequence: 1, status: 'running' } }))
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)))
    expect(rounds).toHaveBeenCalledTimes(reads)
    await act(async () => resync())
    await waitFor(() => expect(rounds).toHaveBeenCalledTimes(reads + 1))
  })

  it('keeps review unavailable while a selected file read fails or has unavailable contents', async () => {
    const user = userEvent.setup()
    contents.mockResolvedValueOnce({ status: 'unavailable', path: '/project/one.ts', reason: 'history_missing' })
    render(<Harness />)
    await screen.findByText('history_missing')
    expect(screen.getByRole('button', { name: 'agent.review_start' })).toBeDisabled()
    contents.mockRejectedValueOnce(new Error('File is changing'))
    await user.click(screen.getByRole('button', { name: /\/project\/two.ts/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('File is changing')
    expect(screen.getByRole('button', { name: 'agent.review_start' })).toBeDisabled()
  })

  it('distinguishes list failure from no recorded runs and releases event subscriptions', async () => {
    rounds.mockRejectedValueOnce(new Error('Database unavailable'))
    const view = render(<Harness />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Database unavailable')
    expect(files).not.toHaveBeenCalled()
    view.unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })
})
