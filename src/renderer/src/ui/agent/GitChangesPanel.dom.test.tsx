import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultCapabilities } from '@shared/agentCapabilities'
import type { WorkspaceProject } from '@shared/types'
import type { GitChangeReadInput, GitChangeResult } from '@shared/gitChanges'
import { referenceFixture } from '../diff/diffTestFixtures'
import { FileChangesPanel } from './FileChangesPanel'

const { t } = vi.hoisted(() => ({ t: (key: string) => key }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }))
vi.mock('../notice', () => ({ notice: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../diff/DiffContentView', () => ({ DiffContentView: ({ request }: { request: { input: { filePath: string } } }) => <div>{request.input.filePath}</div> }))
const get = vi.fn(), refs = vi.fn()
const project: WorkspaceProject = { id: 'project', kind: 'workspace', name: 'Project', sourceFolders: ['/one', '/two'],
  capabilities: defaultCapabilities, restrictSubagents: false, codingMode: false, advancedSettings: false, prompt: '', pinned: false, collapsed: false, createdAt: '', updatedAt: '' }
function result(input: GitChangeReadInput): GitChangeResult {
  return { scope: input.scope, sourceFolder: input.sourceFolder, repositoryRoot: input.sourceFolder,
    baseline: 'a'.repeat(40), head: 'b'.repeat(40), baselineLabel: input.baseline, version: 'c'.repeat(64), fileCount: 1,
    hasMore: false, files: [{ path: `${input.sourceFolder}/file`, relativePath: 'file', source: 'tracked', status: 'M',
      patch: '-old\n+new', patchTruncated: false, addedLines: 1, removedLines: 1 }] }
}
beforeEach(() => {
  get.mockReset().mockImplementation(async (input: GitChangeReadInput) => result(input))
  refs.mockReset().mockImplementation(async (input) => referenceFixture(input))
  Object.defineProperty(window, 'gale', { configurable: true, value: { agent: { onEvent: () => () => {}, changes: {
    git: get, gitReferences: refs, cancelRead: vi.fn(async () => {}), rounds: vi.fn(async () => ({ rounds: [], hasMore: false }))
  } } } })
})

describe('Git changes panel', () => {
  it('keeps run changes accessible without a source folder or a Git repository', async () => {
    const user = userEvent.setup()
    const view = render(<FileChangesPanel request={{ threadId: 'thread' }} project={{ ...project, sourceFolders: [] }} />)
    expect(screen.getByText('agent.git_no_folder')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'agent.changes_mode' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'diff.scope_recorded' }))
    expect(await screen.findByText('agent.changes_no_rounds')).toBeVisible()
    expect(screen.getByRole('checkbox', { name: 'agent.changes_compare_current' })).not.toBeChecked()
    expect(get).not.toHaveBeenCalled()
    view.unmount()
    refs.mockResolvedValueOnce({ error: 'not_repository' })
    render(<FileChangesPanel request={{ threadId: 'thread' }} project={project} />)
    await screen.findByText('agent.git_not_repository')
    await user.click(screen.getByRole('button', { name: 'agent.changes_mode' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'diff.scope_recorded' }))
    expect(await screen.findByText('agent.changes_no_rounds')).toBeVisible()
    expect(screen.queryByText('agent.git_not_repository')).not.toBeInTheDocument()
  })

  it('ends loading for a non-Git folder and detects an initialized repository on refresh', async () => {
    const user = userEvent.setup()
    refs.mockResolvedValueOnce({ error: 'not_repository' })
    render(<FileChangesPanel request={{}} project={project} onReview={vi.fn()} />)
    expect(await screen.findByText('agent.git_not_repository')).toBeVisible()
    expect(screen.queryByText('agent.git_loading')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'diff.baseline' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'agent.changes_mode' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'agent.review_start' })).not.toBeInTheDocument()
    expect(get).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'common.refresh' }))
    expect(await screen.findByText(/\/one\/file/)).toBeVisible()
    expect(screen.queryByText('agent.git_not_repository')).not.toBeInTheDocument()
  })

  it('localizes a reference request rejection and retries reference loading on refresh', async () => {
    const user = userEvent.setup()
    refs.mockRejectedValueOnce(new Error('Error invoking remote method: Git failed'))
    render(<FileChangesPanel request={{}} project={project} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('agent.git_read_failed')
    expect(screen.queryByText('agent.git_loading')).not.toBeInTheDocument()
    expect(screen.queryByText(/Error invoking/)).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'common.refresh' }))
    expect(await screen.findByText(/\/one\/file/)).toBeVisible()
  })

  it('handles a non-Git directory in unstaged scope without relying on the baseline picker', async () => {
    const user = userEvent.setup()
    render(<FileChangesPanel request={{}} project={project} />)
    await screen.findByText(/\/one\/file/)
    get.mockResolvedValueOnce({ error: 'not_repository' })
    await user.click(screen.getByRole('button', { name: 'agent.changes_mode' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'diff.scope_unstaged' }))
    expect(await screen.findByText('agent.git_not_repository')).toBeVisible()
    expect(screen.queryByText('agent.git_loading')).not.toBeInTheDocument()
    await user.click(screen.getByRole('combobox', { name: 'project.source_folders' }))
    await user.click(screen.getByRole('option', { name: '/two' }))
    expect(await screen.findByText(/\/two\/file/)).toBeVisible()
  })

  it('ends loading and localizes a change-list transport error', async () => {
    get.mockRejectedValueOnce(new Error('Error invoking remote method: Git failed'))
    render(<FileChangesPanel request={{}} project={project} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('agent.git_read_failed')
    expect(screen.queryByText('agent.git_loading')).not.toBeInTheDocument()
    expect(screen.queryByText(/Error invoking/)).not.toBeInTheDocument()
  })

  it('selects comparison scopes from a checked menu and restores keyboard focus', async () => {
    const user = userEvent.setup()
    render(<FileChangesPanel request={{}} project={project} />)
    await screen.findByText(/\/one\/file/)
    const trigger = screen.getByRole('button', { name: 'agent.changes_mode' })
    expect(trigger).toHaveTextContent('diff.scope_workspace')
    await user.click(trigger)
    expect(screen.getByRole('menuitemradio', { name: 'diff.scope_workspace' })).toBeChecked()
    await user.click(screen.getByRole('menuitemradio', { name: 'diff.scope_unstaged' }))
    await screen.findByText(/\/one\/file/)
    expect(trigger).toHaveTextContent('diff.scope_unstaged')
    expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'unstaged', after: 0 }), expect.any(String))
    expect(get.mock.lastCall![0]).not.toHaveProperty('baseline')
    expect(screen.queryByRole('combobox', { name: 'diff.baseline' })).not.toBeInTheDocument()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    trigger.focus()
    await user.keyboard('{Enter}')
    expect(screen.getByRole('menuitemradio', { name: 'diff.scope_unstaged' })).toBeChecked()
    await user.keyboard('{Escape}')
    expect(trigger).toHaveFocus()
    await user.click(trigger)
    await user.click(screen.getByRole('menuitemradio', { name: 'diff.scope_baseline' }))
    await screen.findByText(/\/one\/file/)
    expect(screen.getByRole('combobox', { name: 'diff.baseline' })).toBeVisible()
    expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ scope: 'baseline', baseline: 'b'.repeat(40), after: 0 }), expect.any(String))
  })

  it('submits the exact selected scope and version, not just the visible page', async () => {
    const onReview = vi.fn(async () => {}), user = userEvent.setup()
    render(<FileChangesPanel request={{}} project={project} onReview={onReview} />)
    await screen.findByText(/\/one\/file/)
    await user.click(screen.getByRole('button', { name: 'agent.review_start' }))
    expect(onReview).toHaveBeenCalledExactlyOnceWith({ kind: 'git', projectId: 'project', sourceFolder: '/one', scope: 'workspace', version: 'c'.repeat(64), filePath: '/one/file', baseline: 'a'.repeat(40) })
  })
  it('keeps source folder choices explicit', async () => {
    const user = userEvent.setup()
    render(<FileChangesPanel request={{}} project={project} />)
    expect(await screen.findByText(/\/one\/file/)).toBeVisible()
    await user.click(screen.getByRole('combobox', { name: 'project.source_folders' }))
    await user.click(screen.getByRole('option', { name: '/two' }))
    await screen.findByText(/\/two\/file/)
    expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ sourceFolder: '/two', after: 0 }), expect.any(String))
    expect(screen.queryByText(/\/one\/file/)).not.toBeInTheDocument()
  })

  it('selects a grouped branch without freehand entry and sends its resolved commit', async () => {
    const user = userEvent.setup()
    render(<FileChangesPanel request={{}} project={project} />)
    await screen.findByText(/\/one\/file/)
    await user.click(screen.getByRole('combobox', { name: 'diff.baseline' }))
    expect(screen.getByText('diff.group_local')).toBeVisible()
    expect(screen.getByText('diff.group_remote')).toBeVisible()
    await user.click(screen.getByRole('option', { name: /main · diff.current_branch/ }))
    await screen.findByText(/\/one\/file/)
    expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ baseline: 'a'.repeat(40), after: 0, includePatch: false }), expect.any(String))
  })

  it('pins paging to a version and offers refresh after stale results are rejected', async () => {
    const user = userEvent.setup()
    get.mockImplementationOnce(async (input: GitChangeReadInput) => ({ ...result(input), hasMore: true, nextAfter: 5 }))
    render(<FileChangesPanel request={{}} project={project} />)
    await screen.findByRole('button', { name: 'agent.changes_next' })
    get.mockResolvedValueOnce({ error: 'stale' })
    await user.click(screen.getByRole('button', { name: 'agent.changes_next' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('agent.git_stale')
    expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ after: 5, version: 'c'.repeat(64) }), expect.any(String))
    expect(screen.getByRole('button', { name: 'agent.changes_previous' })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'common.refresh' }))
    await screen.findByText(/\/one\/file/)
    expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ after: 0 }), expect.any(String))
  })

  it('ignores a response from the previous selected folder', async () => {
    const user = userEvent.setup()
    let finish!: (value: GitChangeResult) => void
    get.mockImplementationOnce(() => new Promise<GitChangeResult>((resolve) => { finish = resolve }))
    render(<FileChangesPanel request={{}} project={project} />)
    await user.click(screen.getByRole('combobox', { name: 'project.source_folders' }))
    await user.click(screen.getByRole('option', { name: '/two' }))
    await screen.findByText(/\/two\/file/)
    await act(async () => finish(result({ projectId: 'project', sourceFolder: '/one', scope: 'workspace' })))
    expect(screen.queryByText(/\/one\/file/)).not.toBeInTheDocument()
  })

  it('shows a missing source folder without pretending that the repository is clean', () => {
    render(<FileChangesPanel request={{}} project={{ ...project, sourceFolders: [] }} />)
    expect(screen.getByText('agent.git_no_folder')).toBeVisible()
    expect(screen.queryByText('agent.git_empty')).not.toBeInTheDocument()
    expect(get).not.toHaveBeenCalled()
  })

  it('discards a removed source-folder selection when project folders change', async () => {
    const view = render(<FileChangesPanel request={{}} project={project} />)
    await screen.findByText(/\/one\/file/)
    view.rerender(<FileChangesPanel request={{}} project={{ ...project, sourceFolders: ['/three'] }} />)
    await screen.findByText(/\/three\/file/)
    expect(get).toHaveBeenLastCalledWith(expect.objectContaining({ sourceFolder: '/three', after: 0 }), expect.any(String))
    expect(screen.queryByText(/\/one\/file/)).not.toBeInTheDocument()
  })

})
