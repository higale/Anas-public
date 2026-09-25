import { act, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { DiffContents } from '@shared/diffContents'
import { DiffContentView } from './DiffContentView'
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('./ReadonlyDiff', () => ({ ReadonlyDiff: ({ data }: { data: DiffContents }) => <div>{JSON.stringify(data)}</div> }))
const git = vi.fn(), recorded = vi.fn(), cancel = vi.fn(async () => {})
beforeEach(() => {
  git.mockReset(); recorded.mockReset(); cancel.mockClear()
  Object.defineProperty(window, 'gale', { configurable: true, value: { agent: { changes: { gitContents: git, roundContents: recorded, cancelRead: cancel } } } })
})
const input = { projectId: 'project', sourceFolder: '/repo', scope: 'workspace' as const, filePath: '/repo/first' }
it('cancels superseded file reads, ignores late responses, and releases the active read on close', async () => {
  let finish!: (value: DiffContents) => void
  git.mockImplementationOnce(() => new Promise<DiffContents>((resolve) => { finish = resolve }))
  git.mockResolvedValueOnce({ status: 'ready', path: '/repo/second', before: 'original second', after: 'modified second', beforeExists: true, afterExists: true })
  const view = render(<DiffContentView viewKey="one" request={{ kind: 'git', input }} />)
  const firstId = git.mock.calls[0][1]
  view.rerender(<DiffContentView viewKey="two" request={{ kind: 'git', input: { ...input, filePath: '/repo/second', baseline: 'b'.repeat(40) } }} />)
  expect(cancel).toHaveBeenCalledWith(firstId)
  await screen.findByText(/modified second/)
  await act(async () => finish({ status: 'ready', path: '/repo/first', before: 'old first', after: 'late first', beforeExists: true, afterExists: true }))
  expect(screen.queryByText(/late first/)).not.toBeInTheDocument()
  const secondId = git.mock.calls[1][1]
  view.unmount()
  expect(cancel).toHaveBeenCalledWith(secondId)
})
it('uses the recorded-content endpoint and exposes unavailable history without reading current disk', async () => {
  recorded.mockResolvedValue({ status: 'unavailable', path: '/repo/history', reason: 'history_missing' })
  render(<DiffContentView viewKey="history" request={{ kind: 'recorded', input: { threadId: 'thread', runId: 'run', version: 'v1', filePath: '/repo/history', target: 'recorded' } }} />)
  await screen.findByText(/history_missing/)
  expect(git).not.toHaveBeenCalled()
})
