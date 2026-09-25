import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { defaultCapabilities, mcpToolAllowed, toolAllowed, type AgentCapabilities } from '@shared/agentCapabilities'
import type { SkillSnapshot, McpToolStatus } from '@shared/types'
import { CapabilityEditor } from './CapabilityEditor'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const skills: SkillSnapshot = { scriptAutoApprove: false, roots: [{ id: 'user', kind: 'user', name: 'User', path: '/skills', shortcutAlias: 'user', removable: false, available: true }], skills: [{ scriptAutoApprove: false, id: 'user:private', rootId: 'user', name: 'private', description: 'Private skill', modelAvailable: false, userAvailable: false, linked: false, dirPath: '/skills/private', relativePath: 'private', source: 'user', rootName: 'User', shortcutAlias: 'user' }] }
function Harness({ subagent = false, onChange = vi.fn(), mcpStatus, initial }: { subagent?: boolean; onChange?: (value: AgentCapabilities) => void; mcpStatus?: McpToolStatus; initial?: AgentCapabilities }) {
  const [value, setValue] = useState<AgentCapabilities>(() => initial ?? ({ ...structuredClone(defaultCapabilities), skills: { enabled: true, mode: 'custom', project: false, entries: [] } }))
  return <CapabilityEditor value={value} skills={skills} subagent={subagent} mcpStatus={mcpStatus} onChange={(next) => { setValue(next); onChange(next) }} />
}
describe('shared capability editor', () => {
  it.each([false, true])('controls user input independently in subagent mode %s', async (subagent) => {
    const onChange = vi.fn()
    render(<Harness subagent={subagent} onChange={onChange} />)
    const user = userEvent.setup()
    const toggle = screen.getByRole('checkbox', { name: 'settings.capability_request_user_input' })
    expect(toggle).toBeChecked()
    await user.click(toggle)
    expect(toggle).not.toBeChecked()
    expect(toolAllowed(onChange.mock.lastCall![0], 'request_user_input')).toBe(false)
    expect(toolAllowed(onChange.mock.lastCall![0], 'run_shell')).toBe(true)
    await user.click(screen.getByRole('button', { name: 'settings.capabilities_disable_all' }))
    await user.click(toggle)
    expect(onChange.mock.lastCall![0].tools).toEqual(['request_user_input'])
    expect(toolAllowed(onChange.mock.lastCall![0], 'request_user_input')).toBe(true)
    expect(onChange.mock.lastCall![0].backgroundTools).toBe(false)
    await user.click(screen.getByRole('button', { name: 'settings.capabilities_enable_all' }))
    expect(toggle).toBeChecked()
  })

  const emptyMcp: McpToolStatus = { checkedAt: '', servers: [], loaded: [], errors: [], tools: [], toolNames: [] }

  const readyMcp: McpToolStatus = { ...emptyMcp, servers: [{ id: 'alpha', name: 'Alpha MCP', index: 0, type: 'stdio', state: 'ready', toolCount: 2, toolNames: ['search', 'read'] }] }

  it.each([false, true])('collapses MCP tools independently from selection in subagent mode %s', async (subagent) => {
    const onChange = vi.fn()
    const initial: AgentCapabilities = { ...structuredClone(defaultCapabilities), mcp: { defaultMode: 'all', servers: [{ id: 'alpha', mode: 'selected', tools: ['search'] }] } }
    render(<Harness initial={initial} subagent={subagent} mcpStatus={readyMcp} onChange={onChange} />)
    const user = userEvent.setup()
    const heading = screen.getByRole('button', { name: 'Alpha MCP' })
    const all = screen.getByRole('checkbox', { name: 'Alpha MCP capabilities.use_all_tools' })
    const search = screen.getByRole('checkbox', { name: 'Alpha MCP search' })
    expect(heading).toHaveAttribute('aria-expanded', 'true')
    await user.click(heading)
    expect(heading).toHaveAttribute('aria-expanded', 'false')
    expect(search).not.toBeVisible()
    expect(all).toBeVisible()
    expect(onChange).not.toHaveBeenCalled()
    await user.click(all)
    expect(all).toBeChecked()
    expect(screen.queryByRole('button', { name: 'Alpha MCP' })).toBeNull()
    expect(mcpToolAllowed(onChange.mock.lastCall![0], 'alpha', 'new_tool')).toBe(true)
    await user.click(all)
    expect(all).not.toBeChecked()
    expect(screen.queryByRole('checkbox', { name: 'Alpha MCP search' })).toBeNull()
    const restoredHeading = screen.getByRole('button', { name: 'Alpha MCP' })
    expect(restoredHeading).toHaveAttribute('aria-expanded', 'false')
    restoredHeading.focus()
    await user.keyboard('{Enter}')
    expect(restoredHeading).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('checkbox', { name: 'Alpha MCP search' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Alpha MCP read' })).not.toBeChecked()
  })

  it.each([false, true])('separates all mode from selecting every current tool in subagent mode %s', async (subagent) => {
    const onChange = vi.fn()
    const { rerender } = render(<Harness subagent={subagent} mcpStatus={readyMcp} onChange={onChange} />)
    const all = screen.getByRole('checkbox', { name: 'Alpha MCP capabilities.use_all_tools' })
    expect(screen.queryByRole('checkbox', { name: 'Alpha MCP' })).toBeNull()
    expect(all).toBeChecked()
    expect(screen.queryByRole('button', { name: 'Alpha MCP' })).toBeNull()
    expect(screen.queryByText('search')).toBeNull()
    await userEvent.click(all)
    expect(screen.getByRole('button', { name: 'Alpha MCP' })).toHaveAttribute('aria-expanded', 'true')
    const search = screen.getByRole('checkbox', { name: 'Alpha MCP search' })
    expect(search).not.toBeChecked()
    await userEvent.click(search)
    await userEvent.click(screen.getByRole('checkbox', { name: 'Alpha MCP read' }))
    expect(all).not.toBeChecked()
    expect(onChange.mock.lastCall?.[0].mcp.servers).toEqual([{ id: 'alpha', mode: 'selected', tools: ['search', 'read'] }])
    const added: McpToolStatus = { ...readyMcp, servers: [{ ...readyMcp.servers[0], toolCount: 3, toolNames: ['search', 'read', 'new_tool'] }] }
    rerender(<Harness subagent={subagent} mcpStatus={added} onChange={onChange} />)
    expect(screen.getByRole('checkbox', { name: 'Alpha MCP new_tool' })).not.toBeChecked()
    await userEvent.click(all)
    expect(screen.queryByText('new_tool')).toBeNull()
    expect(mcpToolAllowed(onChange.mock.lastCall![0], 'alpha', 'new_tool')).toBe(true)
    await userEvent.click(all)
    expect(screen.getByRole('checkbox', { name: 'Alpha MCP search' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Alpha MCP read' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Alpha MCP new_tool' })).not.toBeChecked()
  })

  it.each([false, true])('keeps the all mode switch usable and shows empty catalog guidance only when enabled (%s)', async (enabled) => {
    function Offline() {
      const [value, setValue] = useState(structuredClone(defaultCapabilities))
      return <CapabilityEditor value={value} mcpServers={[{ id: 'alpha', name: 'Offline MCP', enabled }]} onChange={(next) => { setValue(next); onChange(next) }} />
    }
    const onChange = vi.fn()
    render(<Offline />)
    const all = screen.getByRole('checkbox', { name: 'Offline MCP capabilities.use_all_tools' })
    expect(all).toBeChecked()
    expect(screen.queryByRole('button', { name: 'Offline MCP' })).toBeNull()
    expect(all.closest('[data-mcp-server-id]')).toHaveTextContent('capabilities.inactive')
    await userEvent.click(all)
    expect(all).not.toBeChecked()
    if (enabled) expect(screen.getByText('capabilities.no_known_mcp_tools')).toBeVisible()
    else expect(screen.queryByText('capabilities.no_known_mcp_tools')).toBeNull()
    expect(onChange.mock.lastCall?.[0].mcp.servers).toEqual([{ id: 'alpha', mode: 'selected', tools: [] }])
  })

  it.each([false, true])('removes missing server records after clearing their last tool in subagent mode %s', async (subagent) => {
    const initial: AgentCapabilities = { ...structuredClone(defaultCapabilities), mcp: { defaultMode: 'all', servers: [{ id: 'alpha', mode: 'selected', tools: ['search'] }] } }
    const onChange = vi.fn()
    render(<Harness subagent={subagent} initial={initial} mcpStatus={emptyMcp} onChange={onChange} />)
    const search = screen.getByRole('checkbox', { name: 'alpha search' })
    expect(search).toBeChecked()
    expect(search.closest('label')).not.toHaveTextContent('capabilities.inactive')
    expect(search.closest('[data-mcp-server-id]')).toHaveTextContent('capabilities.inactive')
    await userEvent.click(search)
    expect(onChange.mock.lastCall?.[0].mcp.servers).toEqual([])
    expect(screen.queryByRole('checkbox', { name: 'alpha capabilities.use_all_tools' })).toBeNull()
  })

  it.each([false, true])('shows inactive state at the server or individual tool level in subagent mode %s', (subagent) => {
    const initial: AgentCapabilities = { ...structuredClone(defaultCapabilities), mcp: { defaultMode: 'all', servers: [{ id: 'alpha', mode: 'selected', tools: ['search', 'removed'] }] } }
    const offline: McpToolStatus = { ...readyMcp, servers: [{ ...readyMcp.servers[0], state: 'idle' }] }
    const { rerender } = render(<Harness initial={initial} subagent={subagent} mcpStatus={offline} />)
    expect(screen.queryByRole('button', { name: 'Alpha MCP' })).toBeNull()
    expect(screen.getByRole('checkbox', { name: 'Alpha MCP removed' }).closest('label')).not.toHaveTextContent('capabilities.inactive')
    expect(screen.getAllByText('capabilities.inactive')).toHaveLength(1)
    rerender(<Harness initial={initial} subagent={subagent} mcpStatus={readyMcp} />)
    expect(screen.getByRole('button', { name: 'Alpha MCP' })).not.toHaveTextContent('capabilities.inactive')
    expect(screen.getByRole('checkbox', { name: 'Alpha MCP search' }).closest('label')).not.toHaveTextContent('capabilities.inactive')
    const removed = screen.getByRole('checkbox', { name: 'Alpha MCP removed' })
    expect(removed).toBeChecked()
    expect(removed).toBeEnabled()
    expect(removed.closest('label')).toHaveTextContent('capabilities.inactive')
    expect(screen.getAllByText('capabilities.inactive')).toHaveLength(1)
    const restored: McpToolStatus = { ...readyMcp, servers: [{ ...readyMcp.servers[0], toolCount: 3, toolNames: ['search', 'read', 'removed'] }] }
    rerender(<Harness initial={initial} subagent={subagent} mcpStatus={restored} />)
    expect(screen.queryByText('capabilities.inactive')).toBeNull()
  })

  it('keeps saved tool selections accessible when a collapsed MCP becomes inactive', async () => {
    const initial: AgentCapabilities = { ...structuredClone(defaultCapabilities), mcp: { defaultMode: 'all', servers: [{ id: 'alpha', mode: 'selected', tools: ['search'] }] } }
    const { rerender } = render(<Harness initial={initial} mcpStatus={readyMcp} />)
    await userEvent.click(screen.getByRole('button', { name: 'Alpha MCP' }))
    expect(screen.queryByRole('checkbox', { name: 'Alpha MCP search' })).toBeNull()
    const offline: McpToolStatus = { ...readyMcp, servers: [{ ...readyMcp.servers[0], state: 'idle' }] }
    rerender(<Harness initial={initial} mcpStatus={offline} />)
    expect(screen.queryByRole('button', { name: 'Alpha MCP' })).toBeNull()
    expect(screen.getByRole('checkbox', { name: 'Alpha MCP search' })).toBeChecked()
    rerender(<Harness initial={initial} mcpStatus={readyMcp} />)
    expect(screen.getByRole('button', { name: 'Alpha MCP' })).toHaveAttribute('aria-expanded', 'false')
  })

  it('removes a missing server after turning off all tools and hides already empty records', async () => {
    const initial: AgentCapabilities = { ...structuredClone(defaultCapabilities), mcp: { defaultMode: 'all', servers: [
      { id: 'empty', mode: 'selected', tools: [] }, { id: 'alpha', mode: 'all', tools: [] }
    ] } }
    const onChange = vi.fn()
    render(<Harness initial={initial} mcpStatus={emptyMcp} onChange={onChange} />)
    expect(screen.queryByText('empty')).toBeNull()
    await userEvent.click(screen.getByRole('checkbox', { name: 'alpha capabilities.use_all_tools' }))
    expect(onChange.mock.lastCall?.[0].mcp.servers).toEqual([])
    expect(screen.queryByText('alpha')).toBeNull()
  })

  it('uses all and none defaults for newly configured servers after the global actions', async () => {
    const onChange = vi.fn()
    const { rerender } = render(<Harness mcpStatus={emptyMcp} onChange={onChange} />)
    await userEvent.click(screen.getByRole('button', { name: 'settings.capabilities_disable_all' }))
    rerender(<Harness mcpStatus={readyMcp} onChange={onChange} />)
    const all = screen.getByRole('checkbox', { name: 'Alpha MCP capabilities.use_all_tools' })
    expect(all).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Alpha MCP search' })).not.toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: 'settings.capabilities_enable_all' }))
    expect(all).toBeChecked()
    expect(onChange.mock.lastCall?.[0].mcp.defaultMode).toBe('all')
    expect(screen.queryByText('search')).toBeNull()
  })

  it('allows a removed builtin tool exclusion to be restored and honors the editor disabled state', async () => {
    const onChange = vi.fn()
    const value: AgentCapabilities = { ...structuredClone(defaultCapabilities), toolMode: 'except', tools: ['removed_tool'] }
    const { rerender } = render(<CapabilityEditor value={value} disabled onChange={onChange} />)
    await userEvent.click(screen.getByText('capabilities.other_tools'))
    const checkbox = screen.getByRole('checkbox', { name: 'removed_tool' })
    expect(checkbox).toBeDisabled()
    expect(checkbox).not.toBeChecked()
    rerender(<CapabilityEditor value={value} onChange={onChange} />)
    await userEvent.click(checkbox)
    expect(onChange.mock.lastCall?.[0]).toEqual({ ...value, toolMode: 'all', tools: [] })
  })

  it.each([false, true])('shows unloadable and missing skills with saved checkbox values in subagent mode %s', async (subagent) => {
    const broken = { ...skills.skills[0], id: 'user:broken', name: 'broken', loadError: { code: 'missing_frontmatter' as const } }
    const orphan = { ...skills.skills[0], id: 'orphan:skill', rootId: 'deleted-root', name: 'orphan' }
    const fixture: SkillSnapshot = { ...skills, skills: [...skills.skills, broken, orphan] }
    const selected = { shortcut: !subagent, model: true }
    const retained = { id: skills.skills[0].id, ...selected }
    const onChange = vi.fn()
    function MissingSkills({ snapshot }: { snapshot?: SkillSnapshot }) {
      const [value, setValue] = useState<AgentCapabilities>({ ...structuredClone(defaultCapabilities),
        skills: { enabled: true, mode: 'custom', project: true, entries: [retained, { id: broken.id, ...selected }, { id: orphan.id, ...selected }, { id: 'deleted:skill', ...selected }] } })
      return <CapabilityEditor value={value} skills={snapshot} subagent={subagent} onChange={(next) => { setValue(next); onChange(next) }} />
    }
    const { rerender } = render(<MissingSkills />)
    expect(screen.getByRole('checkbox', { name: 'deleted:skill capabilities.model' })).toBeChecked()
    rerender(<MissingSkills snapshot={fixture} />)
    expect(screen.getByText('settings.skill_group_user').closest('.ui-form-section')).toContainElement(screen.getByText('broken'))
    expect(onChange).not.toHaveBeenCalled()
    for (const name of ['broken', 'orphan', 'deleted:skill']) {
      const checkbox = screen.getByRole('checkbox', { name: `${name} capabilities.model` })
      expect(checkbox).toBeChecked()
      expect(checkbox.closest('.ui-capability-skill')).toHaveTextContent('capabilities.inactive')
      await userEvent.click(checkbox)
      expect(checkbox).not.toBeChecked()
      if (!subagent) await userEvent.click(screen.getByRole('checkbox', { name: `${name} capabilities.shortcut` }))
    }
    expect(onChange.mock.lastCall?.[0].skills).toEqual({ enabled: true, mode: 'custom', project: true, entries: [retained,
      ...[broken.id, orphan.id, 'deleted:skill'].map((id) => ({ id, shortcut: false, model: false }))] })
    const recovered: SkillSnapshot = { ...fixture, skills: fixture.skills.map((skill) => skill.id === broken.id ? { ...skill, loadError: undefined } : skill) }
    rerender(<MissingSkills snapshot={recovered} />)
    expect(screen.getByRole('checkbox', { name: 'broken capabilities.model' })).not.toBeChecked()
    expect(screen.getByText('broken').closest('.ui-capability-skill')).not.toHaveTextContent('capabilities.inactive')
  })

  it.each([0, 2])('shows one project-skill rule for subagents with %s project roots', async (count) => {
    const projectRoots: SkillSnapshot['roots'] = Array.from({ length: count }, (_, index) => ({
      ...skills.roots[0], id: `project-${index}`, kind: 'project', name: `Source ${index}`
    }))
    const fixture: SkillSnapshot = { scriptAutoApprove: false, roots: [...skills.roots, ...projectRoots], skills: [
      ...skills.skills, ...projectRoots.map((root) => ({ ...skills.skills[0], id: `${root.id}:skill`, rootId: root.id, source: root.kind, name: 'project-only' }))
    ] }
    function ProjectHarness() {
      const [value, setValue] = useState<AgentCapabilities>({ ...structuredClone(defaultCapabilities), toolMode: 'selected', tools: [],
        skills: { enabled: true, mode: 'custom', project: false, entries: [] } })
      return <CapabilityEditor subagent value={value} skills={fixture} onChange={(next) => { setValue(next); onChange(next) }} />
    }
    const onChange = vi.fn()
    render(<ProjectHarness />)
    const project = screen.getByRole('checkbox', { name: 'capabilities.project_skills' })
    expect(project).not.toBeChecked()
    expect(screen.queryByText('project-only')).toBeNull()
    expect(screen.queryByText('Source 0')).toBeNull()
    await userEvent.click(project)
    expect(project).toBeChecked()
    expect(onChange.mock.lastCall?.[0].skills).toMatchObject({ project: true, entries: [] })
    const summary = screen.getByText('settings.capability_skills').closest('.ui-form-row')?.querySelector('small')
    expect(summary).toHaveTextContent('0 + settings.skill_group_project')
    await userEvent.click(screen.getByRole('checkbox', { name: 'private capabilities.model' }))
    expect(summary).toHaveTextContent('1 + settings.skill_group_project')
    await userEvent.click(project)
    expect(summary).toHaveTextContent(/^1$/)
    await userEvent.click(project)
    expect(document.querySelector('.settings-status-indicator')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('checkbox', { name: 'settings.capability_skills' }))
    expect(project).toBeDisabled()
  })

  it.each([1, 2])('groups skills by localized source with %s project directories', async (count) => {
    const roots: SkillSnapshot['roots'] = [
      { ...skills.roots[0], id: 'system', kind: 'system', name: 'System' },
      ...skills.roots,
      ...Array.from({ length: count }, (_, index) => ({ ...skills.roots[0], id: `project-${index}`, kind: 'project' as const, name: `Source ${index}` })),
      { ...skills.roots[0], id: 'external', kind: 'external', name: 'Custom directory' }
    ]
    const fixture: SkillSnapshot = { scriptAutoApprove: false, roots, skills: roots.map((root) => ({ ...skills.skills[0],
      id: `${root.id}:skill`, rootId: root.id, source: root.kind, name: `${root.id}-skill` })) }
    const onChange = vi.fn()
    render(<CapabilityEditor value={{ ...structuredClone(defaultCapabilities), skills: { enabled: true, mode: 'custom', project: false, entries: [] } }} skills={fixture} onChange={onChange} />)
    for (const kind of ['system', 'user', 'project']) expect(screen.getByText(`settings.skill_group_${kind}`)).toBeInTheDocument()
    expect(screen.getByText('Custom directory')).toBeInTheDocument()
    expect(screen.queryByText('System')).toBeNull()
    expect(screen.queryByText('User')).toBeNull()
    expect(Boolean(screen.queryByText('Source 0'))).toBe(count > 1)
    await userEvent.click(screen.getByRole('checkbox', { name: 'project-0-skill capabilities.model' }))
    expect(onChange.mock.lastCall?.[0].skills.entries).toEqual([{ id: 'project-0:skill', model: true, shortcut: false }])
    await userEvent.type(screen.getByRole('searchbox'), 'project-0')
    expect(screen.queryByText('settings.skill_group_user')).toBeNull()
    expect(screen.getByText('settings.skill_group_project')).toBeInTheDocument()
  })

  it('keeps MCP enabled when its catalog arrives after an unrelated checkbox edit', async () => {
    const { rerender } = render(<Harness />)
    await userEvent.click(screen.getByRole('checkbox', { name: 'settings.capability_networkAccess' }))
    const status: McpToolStatus = { checkedAt: '', loaded: [], errors: [], tools: [], toolNames: ['search'], servers: [{ id: 'server', index: 0, name: 'Delayed MCP', type: 'stdio', state: 'ready', toolCount: 1, toolNames: ['search'] }] }
    rerender(<Harness mcpStatus={status} />)
    expect(screen.getByRole('checkbox', { name: 'Delayed MCP capabilities.use_all_tools' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'settings.capability_networkAccess' })).not.toBeChecked()
  })
  it('visually groups the complete subagent capability controls under one heading', () => {
    render(<Harness subagent />)
    const group = screen.getByRole('group', { name: 'settings.capabilities' })
    expect(group).toHaveClass('ui-surface-flat')
    expect(group).toContainElement(screen.getByText('settings.capabilities'))
    expect(group).toContainElement(screen.getByRole('button', { name: 'settings.capabilities_enable_all' }))
    expect(group).toContainElement(screen.getByRole('checkbox', { name: 'settings.capability_skills' }))
  })
  it.each([false, true])('enables skills with global defaults when enabling all in subagent mode %s', async (subagent) => {
    const onChange = vi.fn()
    render(<Harness subagent={subagent} onChange={onChange} />)
    await userEvent.click(screen.getByRole('button', { name: 'settings.capabilities_disable_all' }))
    await userEvent.click(screen.getByRole('button', { name: 'settings.capabilities_enable_all' }))
    expect(onChange.mock.lastCall?.[0]).toMatchObject({ toolMode: 'all', skills: { enabled: true, mode: 'default' } })
    expect(screen.getByRole('checkbox', { name: 'settings.capability_skills' })).toBeChecked()
    expect(screen.getByRole('combobox', { name: 'capabilities.skill_selection' })).toHaveValue('capabilities.default')
    expect(screen.queryByRole('searchbox')).toBeNull()
  })
  it.each([
    ['networkAccess', 'http_request'],
    ['commandExecution', 'run_shell'],
    ['configuration', 'update_config']
  ])('renders the single-tool %s capability as a direct toggle', async (feature, toolId) => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const label = screen.getByText(`settings.capability_${feature}`)
    expect(label.closest('summary')).toBeNull()
    expect(screen.queryByText(toolId)).toBeNull()
    const checkbox = screen.getByRole('checkbox', { name: `settings.capability_${feature}` })
    expect(checkbox).toBeChecked()
    await userEvent.click(label)
    expect(checkbox).not.toBeChecked()
    expect(toolAllowed(onChange.mock.lastCall![0], toolId)).toBe(false)
    await userEvent.click(label)
    expect(checkbox).toBeChecked()
    expect(toolAllowed(onChange.mock.lastCall![0], toolId)).toBe(true)
  })
  it('controls all background tools with one direct switch and no child controls', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const label = screen.getByText('settings.capability_backgroundTools')
    const ids = ['read_call', 'read_call_output', 'write_call', 'wait_call', 'cancel_call']
    expect(label.closest('details')).toBeNull()
    for (const id of ids) expect(screen.queryByRole('checkbox', { name: id })).toBeNull()
    await userEvent.click(screen.getByRole('checkbox', { name: 'settings.capability_commandExecution' }))
    // Terminal input also serves custom PTY tools; the runtime checks whether a terminal source exists.
    expect(toolAllowed(onChange.mock.lastCall![0], 'write_call')).toBe(true)
    expect(toolAllowed(onChange.mock.lastCall![0], 'read_call')).toBe(true)
    await userEvent.click(screen.getByRole('checkbox', { name: 'settings.capability_commandExecution' }))
    expect(toolAllowed(onChange.mock.lastCall![0], 'write_call')).toBe(true)
    await userEvent.click(screen.getByRole('checkbox', { name: 'settings.capability_backgroundTools' }))
    for (const id of ids) {
      expect(toolAllowed(onChange.mock.lastCall![0], id)).toBe(false)
    }
    await userEvent.click(screen.getByRole('checkbox', { name: 'settings.capability_backgroundTools' }))
    for (const id of ids) expect(toolAllowed(onChange.mock.lastCall![0], id)).toBe(true)
  })
  it.each([false, true])('uses the shared picker and search field in subagent mode %s', async (subagent) => {
    render(<Harness subagent={subagent} />)
    const picker = screen.getByRole('combobox', { name: 'capabilities.skill_selection' })
    expect(picker).toHaveClass('searchable-option-input')
    expect(picker.closest('.ui-form-row')).toContainElement(screen.getByRole('checkbox', { name: 'settings.capability_skills' }))
    expect(screen.queryByText('capabilities.skill_selection')).toBeNull()
    expect(screen.getByRole('searchbox', { name: 'capabilities.search_skills' })).toHaveClass('ui-input')
    await userEvent.click(picker)
    await userEvent.click(screen.getByRole('option', { name: 'capabilities.default' }))
    expect(picker).toHaveValue('capabilities.default')
    expect(screen.queryByRole('searchbox')).toBeNull()
    await userEvent.click(screen.getByRole('checkbox', { name: 'settings.capability_skills' }))
    expect(picker).toBeDisabled()
  })
  it.each([false, true])('selects recall and memory tools independently with one aggregate checkbox (subagent %s)', async (subagent) => {
    const onChange = vi.fn()
    render(<Harness subagent={subagent} onChange={onChange} />)
    const user = userEvent.setup()
    const all = screen.getByRole('checkbox', { name: 'settings.capability_memory' })
    await user.click(screen.getByText('settings.capability_memory'))
    const recall = screen.getByRole('checkbox', { name: 'settings.capability_memory_recall' })
    const tools = ['read_memory', 'save_to_memory', 'forget_memory'].map((name) => screen.getByRole('checkbox', { name }))
    expect(all).toBeChecked()
    await user.click(recall)
    expect(onChange.mock.lastCall![0].memory).toBe(false)
    expect(all).toBePartiallyChecked()
    for (const checkbox of tools) {
      expect(checkbox).toBeEnabled()
      expect(checkbox).toBeChecked()
      await user.click(checkbox)
    }
    expect(all).not.toBeChecked()
    expect(all).not.toBePartiallyChecked()
    await user.click(recall)
    expect(all).toBePartiallyChecked()
    expect(onChange.mock.lastCall![0].memory).toBe(true)
    expect(toolAllowed(onChange.mock.lastCall![0], 'read_memory')).toBe(false)
    await user.click(all)
    for (const checkbox of [recall, ...tools]) expect(checkbox).toBeChecked()
    await user.click(all)
    for (const checkbox of [recall, ...tools]) {
      expect(checkbox).not.toBeChecked()
      expect(checkbox).toBeEnabled()
    }
    await user.click(tools[0])
    expect(all).toBePartiallyChecked()
    expect(recall).not.toBeChecked()
    expect(toolAllowed(onChange.mock.lastCall![0], 'read_memory')).toBe(true)
  })
  it('keeps individual file tools selectable and displays a mixed group', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await userEvent.click(screen.getByText('settings.capability_fileRead'))
    await userEvent.click(screen.getByRole('checkbox', { name: 'read_multiple_files' }))
    expect(screen.getByRole('checkbox', { name: 'read_file' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'read_multiple_files' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'settings.capability_fileRead' })).toBePartiallyChecked()
    expect(onChange.mock.lastCall?.[0].toolMode).toBe('except')
  })
  it('supports shortcut-only project skills even when globally disabled', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await userEvent.click(screen.getByRole('checkbox', { name: 'private capabilities.shortcut' }))
    expect(screen.getByRole('checkbox', { name: 'private capabilities.model' })).not.toBeChecked()
    expect(onChange.mock.lastCall?.[0].skills.entries).toEqual([{ id: 'user:private', shortcut: true, model: false }])
  })
  it('shows only model availability in subagents and keeps selections when disabled', async () => {
    render(<Harness subagent />)
    expect(screen.queryByRole('checkbox', { name: 'private capabilities.shortcut' })).toBeNull()
    await userEvent.click(screen.getByRole('checkbox', { name: 'private capabilities.model' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'settings.capability_skills' }))
    expect(screen.getByRole('checkbox', { name: 'private capabilities.model' })).toBeDisabled()
    await userEvent.click(screen.getByRole('checkbox', { name: 'settings.capability_skills' }))
    expect(screen.getByRole('checkbox', { name: 'private capabilities.model' })).toBeChecked()
  })
})
