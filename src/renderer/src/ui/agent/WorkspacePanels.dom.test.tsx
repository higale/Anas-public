import { useRef, useState } from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceProject } from '@shared/types'
import type { AgentRunActivity } from '@shared/agentTypes'
import type { GitChangeReadInput, GitChangeResult } from '@shared/gitChanges'
import { defaultCapabilities } from '@shared/agentCapabilities'
import { referenceFixture } from '../diff/diffTestFixtures'
import { WorkspacePanels } from './WorkspacePanels'
import { useWorkspacePanels, workspacePanelScope } from './useWorkspacePanels'

const { t } = vi.hoisted(() => ({ t: (key: string, options?: { name?: string }) => options?.name ? `${key} ${options.name}` : key }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }))
vi.mock('../notice', () => ({ notice: { success: vi.fn(), error: vi.fn() } }))
vi.mock('../diff/DiffContentView', async () => {
  const { PanelActions } = await import('./PanelActions')
  return { DiffContentView: ({ request }: { request: { input: { filePath: string } } }) => <>
    <PanelActions><button>Diff controls</button></PanelActions><div>{request.input.filePath}</div>
  </> }
})
const git = vi.fn(), cancel = vi.fn()
const project: WorkspaceProject = { id: 'project', kind: 'workspace', name: 'Project', sourceFolders: ['/one', '/two'],
  capabilities: defaultCapabilities, restrictSubagents: false, codingMode: false, advancedSettings: false,
  prompt: '', pinned: false, collapsed: false, createdAt: '', updatedAt: '' }
const activity: AgentRunActivity = { runId: 'run', operation: 'agent', status: 'running', createdAt: '', updatedAt: '',
  models: [], tools: [{ call: { id: 'child-tool', name: 'read_file', args: { path: '/one/file.ts' } },
    subagentId: 'alpha', sequence: 3, status: 'completed', output: 'File content' }], subagents: [
    { id: 'alpha', name: 'Alpha', sequence: 1, status: 'running' },
    { id: 'beta', name: 'Beta', sequence: 2, status: 'completed', result: 'Beta result' }
  ] }
function gitResult(input: GitChangeReadInput): GitChangeResult {
  return { scope: input.scope, sourceFolder: input.sourceFolder, repositoryRoot: input.sourceFolder,
    head: 'b'.repeat(40), baseline: 'a'.repeat(40), baselineLabel: input.baseline, version: 'v1', fileCount: 1, hasMore: false,
    files: [{ path: `${input.sourceFolder}/file.ts`, relativePath: 'file.ts', source: 'tracked', status: 'M',
      patch: '-before\n+after', patchTruncated: false }] }
}
function Harness({ narrow = false, activities = [activity] }: { narrow?: boolean; activities?: AgentRunActivity[] }) {
  const controller = useWorkspacePanels()
  const [thread, setThread] = useState('one')
  const [settings, setSettings] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null), inputRef = useRef<HTMLTextAreaElement>(null)
  const scope = workspacePanelScope(thread, project.id)
  return <>
    <button onClick={() => controller.open(scope, { kind: 'document', documentId: 'USER_GUIDE.en.md' })}>Open help</button>
    <button onClick={() => controller.remove(scope)}>Remove conversation</button>
    <button onClick={() => controller.open(scope, { kind: 'files', projectId: project.id, threadId: thread })}>Open Git</button>
    <button onClick={() => controller.open(scope, { kind: 'files', projectId: project.id, threadId: thread, runId: 'first' })}>Open first changes</button>
    <button onClick={() => controller.open(scope, { kind: 'files', projectId: project.id, threadId: thread, runId: 'second' })}>Open second changes</button>
    <button onClick={() => controller.open(scope, { kind: 'subagent', runId: 'run', subagentId: 'alpha', name: 'Alpha' })}>Open Alpha</button>
    <button onClick={() => controller.open(scope, { kind: 'subagent', runId: 'run', subagentId: 'beta', name: 'Beta' })}>Open Beta</button>
    <button onClick={() => setThread(thread === 'one' ? 'two' : 'one')}>Switch conversation</button>
    <button onClick={() => setSettings(!settings)}>Settings</button>
    <button ref={toggleRef} onClick={() => controller.toggle(scope)}>Toggle panels</button>
    <textarea aria-label="Message" ref={inputRef} />
    {!settings && <WorkspacePanels controller={controller} scope={scope} activities={activities} project={project}
      narrow={narrow} width={480} minWidth={320} maxWidth={700} toggleRef={toggleRef} inputRef={inputRef}
      onWidthCommit={vi.fn()} onOpenSubagent={vi.fn()} />}
  </>
}
beforeEach(() => {
  git.mockReset().mockImplementation(async (input: GitChangeReadInput) => gitResult(input))
  cancel.mockReset()
  Object.defineProperty(window, 'gale', { configurable: true, value: { app: { readHelp: vi.fn(async () => '# User Guide\n\nHelp content') }, agent: { cancel, onEvent: () => () => {}, changes: {
    git, gitReferences: vi.fn(async (input) => referenceFixture(input)), cancelRead: vi.fn(async () => {}),
    rounds: vi.fn(async ({ selectedRunId }) => {
      const rounds = ['second', 'first'].map((runId) => ({ runId, createdAt: '2026-09-13T12:00:00Z', summary: runId, status: 'completed' }))
      return { rounds, hasMore: false, ...(selectedRunId ? { selectedRound: rounds.find((round) => round.runId === selectedRunId) ?? null } : {}) }
    }),
    roundFiles: vi.fn(async ({ runId }) => ({ runId, version: 'a'.repeat(64), files: [{ path: `/round/${runId}.ts`, beforeExists: true, afterExists: true,
      continuity: 'recorded', cancelledOut: false, origins: [] }], pendingRunIds: [], issues: [], hasMore: false }))
  } } } })
})

describe('Workspace panels', () => {
  it('middle-clicks inactive and active tabs closed without selecting a background tab or cancelling a task', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByText('Open Alpha'))
    await user.click(screen.getByText('Open Beta'))
    const alpha = screen.getByRole('tab', { name: /Alpha/ })
    await user.pointer({ target: alpha, keys: '[MouseRight]' })
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    await user.pointer({ target: alpha, keys: '[MouseMiddle>]' })
    expect(screen.getByRole('tab', { name: /Beta/ })).toHaveAttribute('aria-selected', 'true')
    await user.pointer({ target: alpha, keys: '[/MouseMiddle]' })
    expect(screen.queryByRole('tab', { name: /Alpha/ })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /Beta/ })).toHaveAttribute('aria-selected', 'true')
    await user.click(screen.getByText('Open Alpha'))
    await user.pointer({ target: screen.getByRole('tab', { name: /Alpha/ }), keys: '[MouseMiddle]' })
    expect(screen.getByRole('tab', { name: /Beta/ })).toHaveAttribute('aria-selected', 'true')
    await user.pointer({ target: screen.getByRole('button', { name: 'agent.close_panel Beta' }), keys: '[MouseMiddle]' })
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Toggle panels')).toHaveFocus())
    expect(cancel).not.toHaveBeenCalled()
  })

  it('shares help across conversations, preserves scroll and closes it everywhere without removing conversation panels', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByText('Open Alpha'))
    await user.click(screen.getByText('Open help'))
    await screen.findByRole('heading', { name: 'User Guide' })
    fireEvent.scroll(document.querySelector('.ui-document-panel')!, { target: { scrollTop: 120 } })
    await user.click(screen.getByText('Open help'))
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(document.querySelector('.ui-document-panel')!.scrollTop).toBe(120)
    await user.click(screen.getByText('Switch conversation'))
    await screen.findByRole('heading', { name: 'User Guide' })
    expect(document.querySelector('.ui-document-panel')!.scrollTop).toBe(120)
    expect(screen.getAllByRole('tab')).toHaveLength(1)
    await user.click(screen.getByText('Remove conversation'))
    expect(screen.getByRole('heading', { name: 'User Guide' })).toBeVisible()
    await user.click(screen.getByText('Settings'))
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    await user.click(screen.getByText('Settings'))
    await screen.findByRole('heading', { name: 'User Guide' })
    await user.click(screen.getByRole('button', { name: 'agent.close_panel User Guide' }))
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    await user.click(screen.getByText('Switch conversation'))
    expect(screen.getByRole('tab', { name: /Alpha/ })).toBeVisible()
    expect(screen.queryByRole('tab', { name: 'User Guide' })).not.toBeInTheDocument()
  })

  it('opens message changes in the same file tab and keeps its toolbar and current-file preference', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByText('Open Git'))
    await screen.findByText(/\/one\/file.ts/)
    const toolbarButton = screen.getByRole('button', { name: 'diff.side_by_side' })
    await user.click(screen.getByText('Open first changes'))
    await screen.findByRole('button', { name: /\/round\/first.ts/ })
    await user.click(screen.getByRole('checkbox', { name: 'agent.changes_compare_current' }))
    await user.click(screen.getByText('Open second changes'))
    await screen.findByRole('button', { name: /\/round\/second.ts/ })
    expect(screen.getAllByRole('tab')).toHaveLength(1)
    expect(screen.getByRole('checkbox', { name: 'agent.changes_compare_current' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'diff.side_by_side' })).toBe(toolbarButton)
    await user.click(screen.getByRole('button', { name: 'agent.changes_mode' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'diff.scope_workspace' }))
    await screen.findByText(/\/one\/file.ts/)
    await user.click(screen.getByText('Open second changes'))
    await screen.findByRole('button', { name: /\/round\/second.ts/ })
    expect(screen.getAllByRole('tab')).toHaveLength(1)
    expect(screen.getByRole('checkbox', { name: 'agent.changes_compare_current' })).toBeChecked()
    expect(screen.getByRole('button', { name: 'diff.side_by_side' })).toBe(toolbarButton)
  })

  it('does not reapply a message shortcut when restoring a manually changed run after settings', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByText('Open first changes'))
    await screen.findByRole('button', { name: /\/round\/first.ts/ })
    await user.click(screen.getByRole('combobox', { name: 'agent.changes_select_round' }))
    await user.click(screen.getByRole('option', { name: /second/ }))
    await screen.findByRole('button', { name: /\/round\/second.ts/ })
    await user.click(screen.getByText('Settings'))
    await user.click(screen.getByText('Settings'))
    await screen.findByRole('button', { name: /\/round\/second.ts/ })
    expect(screen.queryByRole('button', { name: /\/round\/first.ts/ })).not.toBeInTheDocument()
    await user.click(screen.getByText('Open first changes'))
    await screen.findByRole('button', { name: /\/round\/first.ts/ })
  })

  it.each(['Git mode', 'settings'])('reads a fresh first file page after missing changes while in %s', async (destination) => {
    const user = userEvent.setup()
    const readFiles = vi.mocked(window.gale.agent.changes.roundFiles)
    let version = 'a'.repeat(64)
    readFiles.mockImplementation(async ({ runId, after, version: expectedVersion }) => {
      if (expectedVersion && expectedVersion !== version) throw new Error('Records changed')
      const indexes = after ? [20] : Array.from({ length: 20 }, (_, index) => index)
      return { runId, version, files: indexes.map((index) => ({ path: `/round/${index}.ts`, beforeExists: true,
        afterExists: true, continuity: 'recorded', cancelledOut: false, origins: [] })),
        pendingRunIds: [], issues: [], hasMore: !after, ...(!after ? { nextAfter: '/round/19.ts' } : {}) }
    })
    render(<Harness />)
    await user.click(screen.getByText('Open first changes'))
    await screen.findByRole('button', { name: /\/round\/0.ts/ })
    await user.click(screen.getByRole('checkbox', { name: 'agent.changes_compare_current' }))
    await user.click(screen.getByRole('button', { name: 'agent.changes_next' }))
    await screen.findByRole('button', { name: /\/round\/20.ts/ })
    const switchMode = async (mode: string) => {
      await user.click(screen.getByRole('button', { name: 'agent.changes_mode' }))
      await user.click(screen.getByRole('menuitemradio', { name: `diff.scope_${mode}` }))
    }
    if (destination === 'settings') await user.click(screen.getByText('Settings'))
    else { await switchMode('workspace'); await screen.findByText(/\/one\/file.ts/) }
    version = 'b'.repeat(64)
    const previousReads = readFiles.mock.calls.length
    if (destination === 'settings') await user.click(screen.getByText('Settings'))
    else await switchMode('recorded')
    await screen.findByRole('button', { name: /\/round\/0.ts/ })
    expect(readFiles.mock.calls.slice(previousReads).map(([input]) => input)).toEqual([
      { threadId: 'one', runId: 'first', limit: 20 }
    ])
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'agent.changes_previous' })).not.toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: 'agent.changes_compare_current' })).toBeChecked()
    expect((screen.getByRole('combobox', { name: 'agent.changes_select_round' }) as HTMLInputElement).value).toContain('first')
  })

  it('deduplicates tabs, selects an adjacent tab on close, and never cancels a task', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByText('Open Alpha'))
    await user.click(screen.getByText('Open Beta'))
    await user.click(screen.getByText('Open Alpha'))
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    expect(screen.getByRole('tab', { name: /Alpha/ })).toHaveAttribute('aria-selected', 'true')
    await user.click(screen.getByRole('button', { name: 'agent.close_panel Alpha' }))
    expect(screen.getByRole('tab', { name: /Beta/ })).toHaveAttribute('aria-selected', 'true')
    await user.click(screen.getByRole('button', { name: 'agent.close_panel Beta' }))
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('Toggle panels')).toHaveFocus())
    expect(cancel).not.toHaveBeenCalled()
  })

  it('shows only the active panel actions in the toolbar and removes them when collapsed', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByText('Open Git'))
    await screen.findByRole('button', { name: 'Diff controls' })
    const toolbar = document.querySelector<HTMLElement>('.ui-panel-toolbar')!
    expect(within(toolbar).getByRole('button', { name: 'agent.changes_mode' })).toBeVisible()
    expect(within(toolbar).getByRole('button', { name: 'Diff controls' })).toBeVisible()
    await user.click(screen.getByText('Open Alpha'))
    expect(screen.queryByRole('button', { name: 'Diff controls' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'agent.file_changes' }))
    await screen.findByRole('button', { name: 'Diff controls' })
    expect(screen.getAllByRole('button', { name: 'Diff controls' })).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'agent.hide_panels' }))
    expect(screen.queryByRole('button', { name: 'Diff controls' })).not.toBeInTheDocument()
  })

  it('restores Git source folder and scroll after switching views', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByText('Open Git'))
    await screen.findByText(/\/one\/file.ts/)
    await user.click(screen.getByRole('combobox', { name: 'project.source_folders' }))
    await user.click(screen.getByRole('option', { name: '/two' }))
    await screen.findByText(/\/two\/file.ts/)
    const body = document.querySelector<HTMLElement>('.ui-diff-file-list')!
    body.scrollTop = 175
    fireEvent.scroll(body)
    await user.click(screen.getByText('Open Alpha'))
    await user.click(screen.getByRole('tab', { name: 'agent.file_changes' }))
    await screen.findByText(/\/two\/file.ts/)
    await waitFor(() => expect(document.querySelector('.ui-diff-file-list')?.scrollTop).toBe(175))
    expect(git).toHaveBeenLastCalledWith(expect.objectContaining({ sourceFolder: '/two' }), expect.any(String))
  })

  it('preserves subagent tool disclosures and reading position across tabs', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByText('Open Alpha'))
    const tool = document.querySelector<HTMLDetailsElement>('.agent-activity-tool')!
    await user.click(tool.querySelector('summary')!)
    const args = document.querySelector<HTMLDetailsElement>('.agent-activity-arguments')!
    await user.click(args.querySelector('summary')!)
    const body = document.querySelector<HTMLElement>('.agent-subagent-panel-body')!
    Object.defineProperties(body, { scrollHeight: { configurable: true, value: 1000 }, clientHeight: { configurable: true, value: 200 } })
    fireEvent.wheel(body)
    body.scrollTop = 125
    fireEvent.scroll(body)
    await user.click(screen.getByText('Open Beta'))
    await user.click(screen.getByRole('tab', { name: /Alpha/ }))
    expect(document.querySelector<HTMLDetailsElement>('.agent-activity-tool')?.open).toBe(true)
    expect(document.querySelector<HTMLDetailsElement>('.agent-activity-arguments')?.open).toBe(true)
    expect(document.querySelector('.agent-subagent-panel-body')?.scrollTop).toBe(125)
  })

  it('keeps separate conversation tabs and restores them after settings and collapse', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByText('Open Alpha'))
    await user.click(screen.getByText('Switch conversation'))
    expect(screen.queryByRole('tab')).not.toBeInTheDocument()
    await user.click(screen.getByText('Open Beta'))
    await user.click(screen.getByText('Switch conversation'))
    expect(screen.getByRole('tab', { name: /Alpha/ })).toBeVisible()
    expect(screen.queryByRole('tab', { name: /Beta/ })).not.toBeInTheDocument()
    await user.click(screen.getByText('Settings'))
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    await user.click(screen.getByText('Settings'))
    expect(screen.getByRole('tab', { name: /Alpha/ })).toBeVisible()
    await user.click(screen.getByText('Toggle panels'))
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    await user.click(screen.getByText('Toggle panels'))
    expect(screen.getByRole('tab', { name: /Alpha/ })).toBeVisible()
  })

  it('isolates Git filters when both conversations have the same project tab active', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByText('Open Git'))
    await user.click(screen.getByRole('combobox', { name: 'project.source_folders' }))
    await user.click(screen.getByRole('option', { name: '/two' }))
    await screen.findByText(/\/two\/file.ts/)
    await user.click(screen.getByText('Switch conversation'))
    await user.click(screen.getByText('Open Git'))
    await screen.findByText(/\/one\/file.ts/)
    await user.click(screen.getByText('Switch conversation'))
    await screen.findByText(/\/two\/file.ts/)
    await user.click(screen.getByText('Switch conversation'))
    await screen.findByText(/\/one\/file.ts/)
  })

  it('updates background status without switching tabs and supports keyboard navigation', async () => {
    const user = userEvent.setup()
    const view = render(<Harness />)
    await user.click(screen.getByText('Open Alpha'))
    await user.click(screen.getByText('Open Beta'))
    view.rerender(<Harness activities={[{ ...activity, subagents: activity.subagents.map((item) => ({ ...item, status: 'completed' })) }]} />)
    expect(screen.getByRole('tab', { name: /Beta/ })).toHaveAttribute('aria-selected', 'true')
    expect(within(screen.getByRole('tab', { name: /Alpha/ })).getByRole('img', { name: 'Completed' })).toBeVisible()
    screen.getByRole('tab', { name: /Beta/ }).focus()
    await user.keyboard('{ArrowLeft}')
    expect(screen.getByRole('tab', { name: /Alpha/ })).toHaveFocus()
    await user.keyboard('{Delete}')
    await waitFor(() => expect(screen.getByRole('tab', { name: /Beta/ })).toHaveFocus())
  })

  it('preserves maximized viewing across tabs and settings, and restores normal size after collapse', async () => {
    const user = userEvent.setup()
    render(<Harness />)
    await user.click(screen.getByText('Open Alpha'))
    await user.click(screen.getByRole('button', { name: 'agent.maximize_panels' }))
    expect(screen.getByRole('button', { name: 'agent.restore_panels' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('separator', { name: 'agent.resize_panels' })).not.toBeInTheDocument()
    await user.click(screen.getByText('Open Beta'))
    expect(screen.getByRole('button', { name: 'agent.restore_panels' })).toBeVisible()
    await user.click(screen.getByText('Settings'))
    await user.click(screen.getByText('Settings'))
    expect(screen.getByRole('button', { name: 'agent.restore_panels' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'agent.hide_panels' }))
    await waitFor(() => expect(screen.getByText('Toggle panels')).toHaveFocus())
    await user.click(screen.getByText('Toggle panels'))
    expect(screen.getByRole('button', { name: 'agent.maximize_panels' })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('separator', { name: 'agent.resize_panels' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'agent.maximize_panels' }))
    await user.click(screen.getByRole('button', { name: 'agent.close_panel Beta' }))
    await user.click(screen.getByRole('button', { name: 'agent.close_panel Alpha' }))
    await user.click(screen.getByText('Open Alpha'))
    expect(screen.getByRole('button', { name: 'agent.maximize_panels' })).toBeVisible()
  })

  it('uses a non-blocking drawer on narrow windows and keeps tabs when Escape collapses it', async () => {
    const user = userEvent.setup()
    render(<Harness narrow />)
    await user.click(screen.getByText('Open Alpha'))
    expect(screen.getByRole('dialog')).toBeVisible()
    await user.click(screen.getByRole('textbox', { name: 'Message' }))
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Continue working')
    expect(screen.getByRole('dialog')).toBeVisible()
    await user.click(screen.getByRole('tab', { name: /Alpha/ }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByText('Toggle panels'))
    expect(screen.getByRole('tab', { name: /Alpha/ })).toBeVisible()
  })
})
