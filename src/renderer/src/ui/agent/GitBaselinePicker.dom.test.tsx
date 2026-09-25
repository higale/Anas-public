import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import { GitBaselinePicker } from './GitBaselinePicker'
import { referenceFixture } from '../diff/diffTestFixtures'
const { t } = vi.hoisted(() => ({ t: (key: string) => key }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }))
const refs = vi.fn(), cancel = vi.fn(async () => {})
beforeEach(() => {
  refs.mockReset().mockImplementation(async (input) => referenceFixture(input)); cancel.mockClear()
  Object.defineProperty(window, 'gale', { configurable: true, value: { agent: { changes: { gitReferences: refs, cancelRead: cancel } } } })
})
it('loads history only on demand and validates a pasted hash before selecting it', async () => {
  const user = userEvent.setup(), change = vi.fn()
  render(<GitBaselinePicker projectId="project" sourceFolder="/repo" onChange={change} />)
  await waitFor(() => expect(change).toHaveBeenCalled())
  expect(refs.mock.calls.map(([input]) => input.kind)).toEqual(['refs'])
  await user.click(screen.getByRole('combobox', { name: 'diff.baseline' }))
  await user.click(screen.getByRole('button', { name: 'diff.load_commits' }))
  await screen.findByRole('option', { name: /Example commit/ })
  expect(refs).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'history', ref: 'b'.repeat(40), after: 0 }), expect.any(String))
  await user.type(screen.getByPlaceholderText('diff.search_refs'), 'abcdef1234')
  await user.click(screen.getByRole('button', { name: 'diff.verify_hash' }))
  await waitFor(() => expect(change).toHaveBeenLastCalledWith(expect.objectContaining({ commit: 'abcdef1234' })))
  expect(refs).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'resolve', ref: 'abcdef1234' }), expect.any(String))
})
it('revalidates a pinned selection without silently following its moving branch', async () => {
  const change = vi.fn()
  render(<GitBaselinePicker projectId="project" sourceFolder="/repo" onChange={change}
    value={{ value: 'refs/heads/main', label: 'main', repositoryRoot: '/repo', commit: 'd'.repeat(40) }} />)
  await waitFor(() => expect(change).toHaveBeenCalledWith(expect.objectContaining({ commit: 'd'.repeat(40), value: 'refs/heads/main' })))
  expect(refs).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'resolve', ref: 'd'.repeat(40) }), expect.any(String))
})
it('does not select an invalid hash and cancels outstanding reads on unmount', async () => {
  const user = userEvent.setup(), change = vi.fn()
  const view = render(<GitBaselinePicker projectId="project" sourceFolder="/repo" onChange={change} />)
  await waitFor(() => expect(change).toHaveBeenCalled())
  refs.mockImplementation(async (input) => { if (input.kind === 'resolve') throw new Error('Invalid hash'); return referenceFixture(input) })
  await user.click(screen.getByRole('combobox', { name: 'diff.baseline' }))
  await waitFor(() => expect(refs.mock.calls.at(-1)![0].kind).toBe('refs'))
  change.mockClear()
  await user.type(screen.getByPlaceholderText('diff.search_refs'), 'bad-hash{Enter}')
  expect(await screen.findByRole('alert')).toHaveTextContent('agent.git_invalid_commit')
  expect(change).not.toHaveBeenCalled()
  view.unmount(); expect(cancel).toHaveBeenCalledWith(refs.mock.calls.at(-1)![1])
})
