import { toolPackageFixture, selectedTools } from '../../../../test/toolPackageFixture'
import type { ToolPackage } from '@shared/toolPackages'
import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { customToolDefaults, type CustomToolDefinition } from '@shared/customTools'
import { defaultCapabilities } from '@shared/agentCapabilities'
import { CustomToolsGroup } from './CustomToolsGroup'
import { CustomToolEditor } from './CustomToolEditor'
import { CapabilityEditor } from '../CapabilityEditor'
import { notice } from '../notice'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../notice', () => ({ notice: { success: vi.fn(), error: vi.fn() } }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const definition: CustomToolDefinition = { ...customToolDefaults, id: 'stable', name: 'submit_result', description: 'Submit data.', inputSchema: { type: 'object', properties: {} } }

const toolApi = { get: vi.fn(async () => ({ roots: [{ id: 'user', name: 'User', source: 'user', path: '/tools' }], tools: [] })) }
beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal('gale', { tools: toolApi }) })
function Harness() {
  const [tools, setTools] = useState<ToolPackage[]>([])
  return <CustomToolsGroup tools={tools} onConfigChange={(config) => setTools(config.customTools)} />
}

describe('custom tool settings', () => {
  it('imports tool packages and selects the first imported tool', async () => {
    const imported = toolPackageFixture(definition)
    const importDirectories = vi.fn(async () => ({ status: 'imported', ids: [imported.id], names: [imported.name], config: { customTools: [imported] } }))
    vi.stubGlobal('gale', { tools: { ...toolApi, importDirectories } })
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'custom_tools.import' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'submit_result', pressed: true })).toBeVisible())
    expect(notice.success).toHaveBeenCalledWith('custom_tools.imported')
    expect(screen.getByRole('button', { name: 'custom_tools.edit' })).toBeEnabled()
  })
  it.each(['cancelled', 'error'])('preserves the current list when import is %s', async status => {
    const change = vi.fn()
    const importDirectories = vi.fn(async () => ({ status, error: { code: 'already_exists', name: 'submit_result' } }))
    vi.stubGlobal('gale', { tools: { ...toolApi, importDirectories } })
    render(<CustomToolsGroup tools={[toolPackageFixture(definition)]} onConfigChange={change} />)
    fireEvent.click(screen.getByRole('button', { name: 'custom_tools.import' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'custom_tools.import' })).toBeEnabled())
    expect(change).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'submit_result' })).toBeVisible()
    if (status === 'error') expect(notice.error).toHaveBeenCalledWith('custom_tools.import_error_already_exists', { description: undefined })
    else expect(notice.error).not.toHaveBeenCalled()
  })
  it.each([false, true])('selects individual tools and toggles the whole group (subagent %s)', subagent => {
    function Capabilities() {
      const [value, setValue] = useState(structuredClone(defaultCapabilities))
      return <CapabilityEditor subagent={subagent} value={value} onChange={setValue}
        customTools={[toolPackageFixture(definition), toolPackageFixture({ ...definition, id: 'other', name: 'other_tool' })]} />
    }
    render(<Capabilities />)
    const group = screen.getByRole('checkbox', { name: 'custom_tools.title' })
    expect(group).not.toBeChecked()
    fireEvent.click(screen.getByText('custom_tools.title', { selector: 'summary' }))
    const first = screen.getByRole('checkbox', { name: 'User submit_result' })
    const second = screen.getByRole('checkbox', { name: 'User other_tool' })
    expect(first).not.toBeChecked()
    expect(second).not.toBeChecked()
    fireEvent.click(first)
    expect(group).toBePartiallyChecked()
    fireEvent.click(group)
    expect(first).toBeChecked()
    expect(second).toBeChecked()
    if (subagent) expect(screen.getByRole('checkbox', { name: 'custom_tools.project_tools' })).toBeChecked()
    fireEvent.click(group)
    expect(first).not.toBeChecked()
    expect(second).not.toBeChecked()
    if (subagent) expect(screen.getByRole('checkbox', { name: 'custom_tools.project_tools' })).not.toBeChecked()
  })
  it.each([['', 0], ['0', 0], ['7200', 7200]] as const)('saves the timeout draft %s as %s seconds', async (value, timeoutSeconds) => {
    const onSave = vi.fn(async () => {})
    const onClose = vi.fn()
    render(<CustomToolEditor tool={{ ...definition, timeoutSeconds: 120 }} onSave={onSave} onClose={onClose} />)
    const field = screen.getByRole('spinbutton', { name: 'custom_tools.timeout' })
    expect(field).toHaveValue(120)
    fireEvent.change(field, { target: { value } })
    if (timeoutSeconds === 0) expect(field).toHaveValue(null)
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ timeoutSeconds }))
  })
  it('explains the missing background dependency without losing the saved selection', () => {
    const props = { value: { ...defaultCapabilities, backgroundTools: false, customTools: selectedTools(['stable']) },
      customTools: [toolPackageFixture({ ...definition, interactive: true })], onChange: vi.fn() }
    const view = render(<CapabilityEditor {...props} />)
    fireEvent.click(screen.getByText('custom_tools.title', { selector: 'summary' }))
    expect(screen.getByRole('checkbox', { name: 'User submit_result' })).toBeChecked()
    expect(screen.getByText('custom_tools.requires_background')).toBeVisible()
    view.rerender(<CapabilityEditor {...props} value={{ ...props.value, backgroundTools: true }} />)
    expect(screen.queryByText('custom_tools.requires_background')).toBeNull()
    expect(screen.getByRole('checkbox', { name: 'User submit_result' })).toBeChecked()
  })
  it('does not mark a usable tool shadowed by an interactive tool whose dependency is disabled', () => {
    const projectTool: ToolPackage = { ...toolPackageFixture({ ...definition, id: 'project-tool', interactive: true }),
      source: 'project', rootId: 'project', rootName: 'Project' }
    const props = { value: { ...defaultCapabilities, backgroundTools: false, customTools: selectedTools(['project-tool', 'stable']) },
      customTools: [projectTool, toolPackageFixture(definition)], onChange: vi.fn() }
    const view = render(<CapabilityEditor {...props} />)
    fireEvent.click(screen.getByText('custom_tools.title', { selector: 'summary' }))
    expect(screen.queryByText('custom_tools.shadowed')).toBeNull()
    expect(screen.getByRole('checkbox', { name: 'User submit_result' })).toBeChecked()
    view.rerender(<CapabilityEditor {...props} value={{ ...props.value, backgroundTools: true }} />)
    expect(screen.getByText('custom_tools.shadowed')).toBeVisible()
  })
  it('selects on click and edits only through the edit button or a double click', async () => {
    const user = userEvent.setup()
    const other = toolPackageFixture({ ...definition, id: 'other', name: 'other_tool' })
    const view = render(<CustomToolsGroup tools={[toolPackageFixture(definition), other]} onConfigChange={vi.fn()} />)
    const edit = screen.getByRole('button', { name: 'custom_tools.edit' })
    expect(edit).toBeDisabled()
    expect(screen.getByRole('button', { name: 'custom_tools.delete' })).toBeDisabled()

    await user.click(screen.getByRole('button', { name: 'submit_result' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'submit_result', pressed: true })).toBeVisible()
    expect(edit).toBeEnabled()
    expect(screen.getByRole('button', { name: 'custom_tools.delete' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'common.move_down' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'common.move_up' })).toBeDisabled()
    await user.click(edit)
    expect(screen.getByLabelText('custom_tools.name')).toHaveValue('submit_result')
    await user.click(screen.getByRole('button', { name: 'common.cancel' }))

    await user.dblClick(screen.getByRole('button', { name: 'other_tool' }))
    expect(screen.getByLabelText('custom_tools.name')).toHaveValue('other_tool')
    await user.click(screen.getByRole('button', { name: 'common.cancel' }))
    expect(screen.getByRole('button', { name: 'submit_result', pressed: false })).toBeVisible()
    expect(screen.getByRole('button', { name: 'other_tool', pressed: true })).toBeVisible()

    view.rerender(<CustomToolsGroup tools={[toolPackageFixture(definition)]} onConfigChange={vi.fn()} />)
    expect(edit).toBeDisabled()
  })
  it('keeps unsaved input when the backdrop is clicked and still allows explicit cancellation', async () => {
    const user = userEvent.setup()
    const save = vi.fn()
    vi.stubGlobal('gale', { tools: toolApi, config: { saveCustomTool: save } })
    render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'custom_tools.add' }))
    await user.type(screen.getByLabelText('custom_tools.name'), 'draft_tool')
    const command = 'python "tools/submit.py"\n --data {{args}}'
    fireEvent.change(screen.getByLabelText('custom_tools.command'), { target: { value: command } })
    await user.click(document.querySelector('.ui-backdrop') as HTMLElement)
    expect(screen.getByRole('dialog')).toBeVisible()
    expect(screen.getByLabelText('custom_tools.name')).toHaveValue('draft_tool')
    expect(screen.getByLabelText('custom_tools.command')).toHaveValue(command)
    expect(save).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'common.cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
  it('adds a tool with the current textarea draft and keeps backend validation failures editable', async () => {
    const save = vi.fn().mockRejectedValueOnce(new Error('Schema required must be an array.')).mockImplementation(async (tool) => ({ customTools: [toolPackageFixture({ ...tool, id: 'new-id' })] }))
    vi.stubGlobal('gale', { tools: toolApi, config: { saveCustomTool: save } })
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: 'custom_tools.add' }))
    expect(screen.getByRole('checkbox', { name: 'custom_tools.interactive' })).not.toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: 'custom_tools.interactive' }))
    fireEvent.change(screen.getByLabelText('custom_tools.name'), { target: { value: 'submit_result' } })
    fireEvent.change(screen.getByLabelText('custom_tools.description'), { target: { value: '提交结果' } })
    fireEvent.change(screen.getByLabelText('custom_tools.schema'), { target: { value: '{"type":"object","required":"bad"}' } })
    const command = 'python "script with spaces.py"\n  --mode validate --data {{args}} --verbose'
    fireEvent.change(screen.getByLabelText('custom_tools.command'), { target: { value: command } })
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Schema required')
    expect(screen.getByLabelText('custom_tools.name')).toHaveValue('submit_result')
    fireEvent.change(screen.getByLabelText('custom_tools.schema'), { target: { value: '{"type":"object","properties":{}}' } })
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(save.mock.lastCall?.[0]).toMatchObject({ name: 'submit_result', description: '提交结果', command, interactive: true, inputSchema: { type: 'object', properties: {} } })
    expect(screen.getByRole('button', { name: 'submit_result' })).toBeVisible()
  })
  it.each([false, true])('preserves explicit capability selection through rename and deletion (subagent %s)', async (subagent) => {
    const onChange = vi.fn()
    const props = { subagent, value: { ...defaultCapabilities, customTools: selectedTools(['stable']) }, onChange }
    const { rerender } = render(<CapabilityEditor {...props} customTools={[toolPackageFixture(definition)]} />)
    fireEvent.click(screen.getByText('custom_tools.title', { selector: 'summary' }))
    expect(screen.getByRole('checkbox', { name: 'User submit_result' })).toBeChecked()
    rerender(<CapabilityEditor {...props} customTools={[toolPackageFixture({ ...definition, name: 'renamed' }), toolPackageFixture({ ...definition, id: 'new', name: 'new_tool' })]} />)
    expect(screen.getByRole('checkbox', { name: 'User renamed' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'User new_tool' })).not.toBeChecked()
    rerender(<CapabilityEditor {...props} customTools={[]} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /stable/ }))
    expect(onChange.mock.lastCall?.[0].customTools).toEqual(selectedTools())
  })
})
