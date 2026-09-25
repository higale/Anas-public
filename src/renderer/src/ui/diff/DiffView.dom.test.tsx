import { useState } from 'react'
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it, vi } from 'vitest'
import type { DiffContents } from '@shared/diffContents'
import { diffViewSettingsFixture } from '../../../../test/diffViewSettingsFixture'
import { PanelActionsTarget } from '../agent/PanelActions'
import { DiffContentView } from './DiffContentView'
import { DiffPreferences, DiffView, type DiffViewSettings } from './DiffView'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../notice', () => ({ notice: { error: vi.fn() } }))
vi.mock('./ReadonlyDiff', () => ({ ReadonlyDiff: ({ data }: { data: DiffContents }) => <div>{JSON.stringify(data)}</div> }))
const read = vi.fn()
beforeEach(() => {
  read.mockReset()
  Object.defineProperty(window, 'gale', { configurable: true, value: { agent: { changes: {
    gitContents: read, cancelRead: vi.fn(async () => {})
  } } } })
})

function Harness({ file }: { file: string }) {
  const [settings, setSettings] = useState<DiffViewSettings>(diffViewSettingsFixture)
  const [firstTarget, setFirstTarget] = useState<HTMLDivElement | null>(null)
  const [secondTarget, setSecondTarget] = useState<HTMLDivElement | null>(null)
  return <DiffPreferences.Provider value={{ ...settings, onChange: async (update) => setSettings((current) => ({ ...current, ...update })) }}>
    <div role="toolbar" aria-label="First diff" ref={setFirstTarget} />
    <PanelActionsTarget.Provider value={firstTarget}>
      <DiffView><DiffContentView viewKey={file} request={{ kind: 'git', input: {
        projectId: 'project', sourceFolder: '/repo', scope: 'workspace', filePath: `/repo/${file}`
      } }} /></DiffView>
    </PanelActionsTarget.Provider>
    <div role="toolbar" aria-label="Second diff" ref={setSecondTarget} />
    <PanelActionsTarget.Provider value={secondTarget}><DiffView><p>Another diff panel</p></DiffView></PanelActionsTarget.Provider>
  </DiffPreferences.Provider>
}

it('keeps the same toolbar through file loading and failures, with preferences shared across panels', async () => {
  const user = userEvent.setup()
  read.mockResolvedValueOnce({ status: 'ready', path: '/repo/first', before: '', after: 'first text', beforeExists: true, afterExists: true })
  let fail!: (error: Error) => void
  read.mockImplementationOnce(() => new Promise<DiffContents>((_, reject) => { fail = reject }))
  read.mockResolvedValueOnce({ status: 'unavailable', path: '/repo/binary', reason: 'binary' })
  const view = render(<Harness file="first" />)
  await screen.findByText(/first text/)
  const first = within(screen.getByRole('toolbar', { name: 'First diff' }))
  const second = within(screen.getByRole('toolbar', { name: 'Second diff' }))
  const buttons = first.getAllByRole('button')
  await user.click(first.getByRole('button', { name: 'diff.side_by_side' }))
  await user.click(first.getByRole('button', { name: 'diff.fold' }))
  await user.click(first.getByRole('button', { name: 'diff.word_wrap' }))
  const check = () => {
    expect(first.getAllByRole('button')).toEqual(buttons)
    for (const toolbar of [first, second]) {
      expect(toolbar.getByRole('button', { name: 'diff.side_by_side' })).toHaveAttribute('aria-pressed', 'true')
      expect(toolbar.getByRole('button', { name: 'diff.fold' })).toHaveAttribute('aria-pressed', 'false')
      expect(toolbar.getByRole('button', { name: 'diff.word_wrap' })).toHaveAttribute('aria-pressed', 'true')
    }
  }
  view.rerender(<Harness file="pending" />)
  expect(screen.getByRole('status')).toHaveTextContent('common.loading')
  check()
  await act(async () => fail(new Error('Read failed')))
  expect(await screen.findByRole('alert')).toHaveTextContent('Read failed')
  check()
  view.rerender(<Harness file="binary" />)
  await screen.findByText(/binary/)
  check()
  await user.click(second.getByRole('button', { name: 'diff.fold' }))
  expect(first.getByRole('button', { name: 'diff.fold' })).toHaveAttribute('aria-pressed', 'true')
  await user.click(second.getByRole('button', { name: 'diff.side_by_side' }))
  for (const toolbar of [first, second]) {
    expect(toolbar.getByRole('button', { name: 'diff.side_by_side' })).toHaveAttribute('aria-pressed', 'false')
  }
})
