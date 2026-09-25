import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { McpToolStatus, RuntimeToolStatus } from '@shared/types'
import { ToolsSettings } from './ToolsSettings'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

const runtimeToolStatus: RuntimeToolStatus = {
  checkedAt: '',
  tools: [{ name: 'read_call', description: 'Read background call status.', parameters: [] }],
  toolNames: ['read_call']
}

const props = { customTools: [], onConfigChange: vi.fn(), mcpServers: [], mcpStatus: undefined, runtimeToolStatus }

describe('tool catalog', () => {
  it('groups every built-in and framework tool under its matching capability', () => {
    render(<ToolsSettings {...props} />)
    const expected = {
      planning: ['write_todos'],
      request_user_input: ['request_user_input'],
      subagents: ['start_subagent', 'read_subagent', 'wait_subagent', 'cancel_subagent'],
      backgroundTools: ['read_call', 'read_call_output', 'write_call', 'wait_call', 'cancel_call'],
      fileRead: ['list_directory', 'directory_tree', 'get_file_info', 'read_file', 'read_multiple_files', 'view_image', 'view_multiple_images'],
      fileWrite: ['create_directory', 'write_file', 'apply_patch', 'get_file_edit_diff', 'restore_file_edit', 'move_file', 'delete_file'],
      commandExecution: ['run_shell'],
      networkAccess: ['http_request'],
      memory: ['read_memory', 'save_to_memory', 'forget_memory'],
      configuration: ['update_config']
    }
    for (const [group, names] of Object.entries(expected)) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`^settings\\.capability_${group}\\s*${names.length}$`) }))
      expect(screen.getAllByRole('button', { name: /settings.tools_view_details$/ }).map(button => button.textContent)).toEqual(names)
    }
    for (const group of ['profile', 'environment', 'workspaceContext', 'applicationEnvironment', 'skills', 'memory_recall']) {
      expect(screen.queryByText(`settings.capability_${group}`)).not.toBeInTheDocument()
    }
  })

  it('shows the runtime Shell name in the command capability group', () => {
    render(<ToolsSettings {...props} runtimeToolStatus={{ checkedAt: '', toolNames: ['zsh'], tools: [
      { name: 'zsh', capabilityId: 'run_shell', description: 'Run Z shell.', parameters: [] }
    ] }} />)
    fireEvent.click(screen.getByRole('button', { name: /^settings\.capability_commandExecution\s*1$/ }))
    expect(screen.getByRole('button', { name: /^zsh:/ })).toBeEnabled()
    expect(screen.queryByRole('button', { name: /^run_shell:/ })).not.toBeInTheDocument()
  })

  it('retains empty MCP server groups and the unloaded MCP hint', () => {
    const view = render(<ToolsSettings {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /^settings\.mcp\s*0$/ }))
    expect(screen.getByRole('button', { name: /^custom_tools\.title\s*0$/ })).toBeVisible()
    expect(screen.getByText('settings.tools_mcp_empty')).toBeVisible()
    view.rerender(<ToolsSettings {...props} mcpStatus={{ checkedAt: '',
      servers: [{ id: 'empty', index: 0, name: 'Empty MCP', type: 'http', state: 'stopped', toolCount: 0, toolNames: [] }],
      loaded: [], tools: [], toolNames: [], errors: []
    }} />)
    expect(screen.getByText('Empty MCP')).toBeVisible()
    expect(screen.getByText('settings.tools_mcp_server_empty')).toBeVisible()
  })

  it('allows inspecting every catalog entry even before runtime definitions are available', async () => {
    const user = userEvent.setup()
    const view = render(<ToolsSettings {...props} runtimeToolStatus={undefined} />)
    for (const [name, group] of [['start_subagent', 'subagents'], ['write_call', 'backgroundTools'], ['read_call', 'backgroundTools'], ['read_memory', 'memory']]) {
      await user.click(screen.getByRole('button', { name: new RegExp(`^settings\\.capability_${group}\\s*\\d+$`) }))
      const button = screen.getByRole('button', { name: `${name}: settings.tools_view_details` })
      expect(button).toBeEnabled()
      await user.click(button)
      expect(screen.getByRole('dialog')).toHaveTextContent(`"name": "${name}"`)
      await user.keyboard('{Escape}')
    }
    await user.click(screen.getByRole('button', { name: /^settings\.capability_backgroundTools\s*5$/ }))
    await user.click(screen.getByRole('button', { name: 'read_call: settings.tools_view_details' }))
    view.rerender(<ToolsSettings {...props} />)
    expect(screen.getByRole('dialog')).toHaveTextContent('Read background call status.')
  })

  it.each(['stopped', 'failed', 'recovering', 'ready'] as const)('keeps MCP definitions inspectable when the source is %s', async (state) => {
    const status: McpToolStatus = {
      checkedAt: '',
      servers: [{ id: 'source', index: 0, name: 'Source', type: 'http', state, toolCount: 1, toolNames: ['lookup'] }],
      loaded: [{ id: 'source', index: 0, name: 'Source', toolCount: 1, toolNames: ['lookup'] }],
      tools: [{ name: 'lookup', description: 'Look up a record.', parameters: [] }],
      toolNames: ['lookup'], errors: []
    }
    render(<ToolsSettings {...props} mcpStatus={status} />)
    await userEvent.click(screen.getByRole('button', { name: /^settings\.mcp\s*1$/ }))
    const button = screen.getByRole('button', { name: 'lookup: settings.tools_view_details' })
    expect(button).toBeEnabled()
    expect(screen.queryByText('settings.load_failed')).not.toBeInTheDocument()
    expect(screen.queryByText('settings.mcp_state_recovering')).not.toBeInTheDocument()
    await userEvent.click(button)
    expect(screen.getByRole('dialog')).toHaveTextContent('Look up a record.')
  })
})
