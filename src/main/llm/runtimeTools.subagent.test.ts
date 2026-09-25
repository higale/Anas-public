import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tool } from '@langchain/core/tools'
import { toJsonSchema, type JsonSchema7ObjectType } from '@langchain/core/utils/json_schema'
import { z } from 'zod/v3'
import { supportsManagedTool } from '../agent/managedToolExecution'

const memoryMocks = vi.hoisted(() => ({
  searchMemories: vi.fn(),
  saveMemory: vi.fn(),
  deleteMemory: vi.fn(),
  armEffect: vi.fn()
}))

vi.mock('../agent/toolEffectScope', async (importOriginal) => ({
  ...await importOriginal<typeof import('../agent/toolEffectScope')>(),
  armCurrentAgentToolEffect: memoryMocks.armEffect,
  currentAgentToolEffectArtifactId: () => '11111111-1111-8111-8111-111111111111'
}))

import { createRuntimeTools } from './runtimeTools'

const pwsh = {
  executable: 'pwsh.exe',
  name: 'PowerShell',
  version: '7.6.4',
  family: 'powershell' as const
}

function toolNames(tools: Awaited<ReturnType<typeof createRuntimeTools>>): string[] {
  return tools.map((tool) => tool.name)
}

beforeEach(() => {
  memoryMocks.searchMemories.mockReset()
  memoryMocks.searchMemories.mockResolvedValue({ items: [], total: 0 })
  memoryMocks.saveMemory.mockReset()
  memoryMocks.saveMemory.mockResolvedValue({
    id: '11111111-1111-8111-8111-111111111111',
    scope: 'project',
    projectId: 'project-1',
    kind: 'fact',
    content: 'Durable fact',
    keywords: [],
    importance: 3,
    origin: 'agent',
    createdAt: '2026-08-26T00:00:00.000Z',
    updatedAt: '2026-08-26T00:00:00.000Z'
  })
  memoryMocks.deleteMemory.mockReset()
})

describe('subagent runtime tool scopes', () => {
  it.each(['background', 'supervision'] as const)('advertises %s management tools without an execution service', async (mode) => {
    const tools = await createRuntimeTools({ enabled: true, primaryFolder: process.cwd(), memory: false,
      network: false, shell: false, mcp: false, toolNames: [],
      backgroundTools: mode === 'background', managedCallSupervision: mode === 'supervision' })
    expect(toolNames(tools)).toEqual(['read_call', 'read_call_output', 'wait_call', 'cancel_call'])
    expect(tools.every((tool) => Object.keys(toJsonSchema(tool.schema)).length > 0)).toBe(true)
    await expect(tools[0].invoke({})).rejects.toThrow('require a conversation runtime')
  })
  it.each([false, true])('gates custom terminal input on background tools (%s), independently of Shell selection', async (backgroundTools) => {
    const tools = await createRuntimeTools({ enabled: true, primaryFolder: process.cwd(), memory: false,
      network: false, shell: false, mcp: false, backgroundTools, interactiveCustomTools: true, toolNames: [] })
    expect(toolNames(tools).includes('write_call')).toBe(backgroundTools)
    expect(toolNames(tools)).not.toContain('pwsh')
  })
  it('exposes PTY only with enabled input and supervision, preserving explicit sizing', async () => {
    const shellRunner = vi.fn(async () => 'running')
    const managedCalls = { read: vi.fn(), readOutput: vi.fn(), readResult: vi.fn(), wait: vi.fn(), cancel: vi.fn(), start: vi.fn(), writeTerminal: vi.fn(async () => 'accepted') }
    const options = { enabled: true, primaryFolder: process.cwd(), memory: false, network: false, shell: true,
      commandShell: pwsh, mcp: false, backgroundTools: true, managedCalls, shellRunner, threadId: 'thread' }
    const tools = await createRuntimeTools(options)
    const shell = tools.find((item) => item.name === 'pwsh')!
    await shell.invoke({ command: 'Read-Host', pty: { columns: 100, rows: 30 } })
    expect(shellRunner).toHaveBeenCalledWith(expect.objectContaining({ pty: { columns: 100, rows: 30 } }))
    const write = tools.find((item) => item.name === 'write_call')!
    const id = '22222222-2222-4222-8222-222222222222'
    await write.invoke({ call_id: id, terminal_id: id, action: { type: 'text', text: '你好\r' } })
    expect(managedCalls.writeTerminal).toHaveBeenCalledWith(id, 'thread', id, { type: 'text', text: '你好\r' })
    await expect(shell.invoke({ command: 'Read-Host', pty: { columns: 100, rows: 30 }, keep_processes: true })).rejects.toThrow('cannot keep')
    const shellOnlySelection = await createRuntimeTools({ ...options, toolNames: ['run_shell'] })
    expect(toolNames(shellOnlySelection)).toEqual(expect.arrayContaining(['read_call', 'read_call_output', 'write_call', 'wait_call', 'cancel_call']))
    for (const scoped of [{ ...options, shell: false }, { ...options, backgroundTools: false }, { ...options, toolNames: ['write_call'] }]) {
      const selected = await createRuntimeTools(scoped)
      expect(toolNames(selected)).not.toContain('write_call')
      const selectedShell = selected.find((item) => item.name === 'pwsh')
      if (selectedShell) {
        expect((toJsonSchema(selectedShell.schema) as JsonSchema7ObjectType).properties).not.toHaveProperty('pty')
        expect(selectedShell.description).toContain('Interactive terminal input is unavailable')
        expect(selectedShell.description).toContain('does not guarantee completion')
      }
    }
  })
  it('offers an optional localized display summary on ordinary execution tools', async () => {
    const tools = await createRuntimeTools({
      enabled: true,
      primaryFolder: process.cwd(),
      configuration: true,
      memory: true,
      memoryStore: memoryMocks,
      projectId: 'project-1',
      network: true,
      shell: true,
      commandShell: pwsh,
      mcp: false
    })

    for (const runtimeTool of tools.filter(supportsManagedTool)) {
      const schema = toJsonSchema(runtimeTool.schema) as JsonSchema7ObjectType
      expect(schema.properties.summary?.description).toContain("user's language")
      expect(schema.required ?? []).not.toContain('summary')
    }
  })

  it('registers command and network tools independently', async () => {
    const commandOnly = await createRuntimeTools({
      enabled: true,
      primaryFolder: process.cwd(),
      memory: false,
      network: false,
      shell: true,
      commandShell: pwsh,
      mcp: false
    })
    const networkOnly = await createRuntimeTools({
      enabled: true,
      primaryFolder: process.cwd(),
      memory: false,
      network: true,
      shell: false,
      mcp: false
    })

    expect(toolNames(commandOnly)).toContain('pwsh')
    expect(toolNames(commandOnly)).not.toContain('http_request')
    expect(toolNames(networkOnly)).toContain('http_request')
    expect(toolNames(networkOnly)).not.toContain('pwsh')
  })

  it('adds call supervision tools when background execution is enabled', async () => {
    const managedCalls = {
      start: vi.fn(),
      read: vi.fn(),
      readOutput: vi.fn(),
      readResult: vi.fn(),
      wait: vi.fn(),
      cancel: vi.fn()
    }
    const managed = await createRuntimeTools({
      enabled: true,
      toolNames: ['http_request'],
      primaryFolder: process.cwd(),
      memory: false,
      network: true,
      shell: false,
      threadId: 'thread-1',
      runId: 'run-1',
      managedCalls,
      backgroundTools: true,
      mcp: false
    })
    expect(toolNames(managed)).toEqual([
      'http_request',
      'read_call',
      'read_call_output',
      'wait_call',
      'cancel_call'
    ])

    const unmanaged = await createRuntimeTools({
      enabled: true,
      toolNames: ['http_request'],
      primaryFolder: process.cwd(),
      memory: false,
      network: true,
      shell: false,
      mcp: false
    })
    expect(toolNames(unmanaged)).toEqual(['http_request'])
  })

  it('keeps call supervision available for unresolved calls when their executors are disabled', async () => {
    const managedCalls = {
      start: vi.fn(),
      read: vi.fn().mockResolvedValue('call status'),
      readOutput: vi.fn().mockResolvedValue('call output'),
      readResult: vi.fn(),
      wait: vi.fn().mockResolvedValue('waited'),
      cancel: vi.fn()
    }
    const tools = await createRuntimeTools({
      enabled: true,
      primaryFolder: process.cwd(),
      memory: false,
      network: false,
      shell: false,
      threadId: 'thread-1',
      runId: 'run-1',
      managedCalls,
      managedCallSupervision: true,
      toolNames: [],
      mcp: false
    })

    expect(toolNames(tools)).toEqual([
      'read_call',
      'read_call_output',
      'wait_call',
      'cancel_call'
    ])
    await expect(tools[0].invoke({
      call_id: '11111111-1111-8111-8111-111111111111'
    })).resolves.toBe('call status')
    expect(managedCalls.read).toHaveBeenCalledWith({
      callId: '11111111-1111-8111-8111-111111111111',
      threadId: 'thread-1'
    })
    await expect(tools[1].invoke({
      call_id: '11111111-1111-8111-8111-111111111111',
      output_offset: -100,
      output_length: 100
    })).resolves.toBe('call output')
    expect(managedCalls.readOutput).toHaveBeenCalledWith({
      callId: '11111111-1111-8111-8111-111111111111',
      threadId: 'thread-1',
      offset: -100,
      length: 100
    })
    await expect(tools[2].invoke({
      call_id: '11111111-1111-8111-8111-111111111111',
      timeout: 30
    })).resolves.toBe('waited')
    expect(managedCalls.wait).toHaveBeenCalledWith({
      callId: '11111111-1111-8111-8111-111111111111',
      threadId: 'thread-1',
      timeoutMs: 30_000,
      signal: undefined
    })
    await expect(tools[2].invoke({ timeout: 30 })).rejects.toThrow()
    expect(managedCalls.wait).toHaveBeenCalledOnce()

    const noUnresolvedCall = await createRuntimeTools({
      enabled: true,
      primaryFolder: process.cwd(),
      memory: false,
      network: false,
      shell: false,
      threadId: 'thread-1',
      runId: 'run-1',
      managedCalls,
      managedCallSupervision: false,
      toolNames: [],
      mcp: false
    })
    expect(noUnresolvedCall).toEqual([])
  })

  it('keeps the MCP adapter tool intact until the common executor binds it', async () => {
    const mcpTool = tool(async () => 'mcp result', {
      name: 'mcp_remote_operation',
      description: 'Remote MCP operation.',
      schema: z.object({})
    })
    const tools = await createRuntimeTools({
      enabled: true,
      primaryFolder: process.cwd(),
      memory: false,
      network: false,
      shell: false,
      threadId: 'thread-1',
      runId: 'run-1',
      managedCalls: {
        start: vi.fn(),
        read: vi.fn(),
        readOutput: vi.fn(),
        readResult: vi.fn(),
        wait: vi.fn(),
        cancel: vi.fn()
      },
      mcp: true,
      toolNames: [],
      mcpTools: [mcpTool]
    })

    expect(tools).toEqual([mcpTool])
    await expect(tools[0].invoke({})).resolves.toBe('mcp result')
  })

  it('exposes the config tool only in the explicitly enabled main scope', async () => {
    const mainTools = await createRuntimeTools({
      enabled: true,
      primaryFolder: process.cwd(),
      configuration: true,
      memory: false,
      network: false,
      shell: false,
      toolNames: [],
      mcp: false
    })
    const subagentTools = await createRuntimeTools({
      enabled: true,
      primaryFolder: process.cwd(),
      configuration: false,
      memory: false,
      network: false,
      shell: false,
      toolNames: [],
      mcp: false
    })
    const disabledTools = await createRuntimeTools({
      enabled: false,
      primaryFolder: process.cwd(),
      configuration: true,
      memory: false,
      network: false,
      shell: false,
      mcp: false
    })

    expect(toolNames(mainTools)).toEqual(['update_config'])
    expect(toolNames(subagentTools)).toEqual([])
    expect(toolNames(disabledTools)).toEqual([])
  })

  it.each(Array.from({ length: 8 }, (_, mask) => ({
    selected: ['read_memory', 'save_to_memory', 'forget_memory'].filter((_, index) => mask & (1 << index))
  })))('exposes exactly the selected memory tools: $selected', async ({ selected }) => {
    const tools = await createRuntimeTools({
      enabled: true,
      primaryFolder: process.cwd(),
      memory: true,
      toolNames: selected,
      memoryStore: memoryMocks,
      projectId: 'project-1',
      network: false,
      shell: false,
      mcp: false
    })

    expect(toolNames(tools)).toEqual(selected)
  })

  it('writes a structured durable memory record', async () => {
    const tools = await createRuntimeTools({
      enabled: true,
      primaryFolder: process.cwd(),
      memory: true,
      memoryStore: memoryMocks,
      projectId: 'project-1',
      threadId: 'thread-1',
      runId: 'run-1',
      network: false,
      shell: false,
      mcp: false
    })

    expect(toolNames(tools)).not.toContain('log_daily')
    const saveMemory = tools.find((item) => item.name === 'save_to_memory')
    expect(saveMemory).toBeDefined()

    await expect(saveMemory!.invoke({
      summary: 'Save durable memory',
      content: 'Durable fact'
    })).rejects.toThrow()

    const result = await saveMemory!.invoke({
      summary: 'Save durable memory',
      scope: 'project',
      kind: 'fact',
      content: 'Durable fact'
    })
    expect(JSON.parse(result as string)).toMatchObject({ ok: true, memory: { content: 'Durable fact' } })
    expect(memoryMocks.saveMemory).toHaveBeenCalledWith({
      scope: 'project',
      projectId: 'project-1',
      kind: 'fact',
      content: 'Durable fact',
      keywords: [],
      importance: 3
    }, {
      accessProjectId: 'project-1',
      origin: 'agent',
      newId: '11111111-1111-8111-8111-111111111111',
      sourceThreadId: 'thread-1',
      sourceRunId: 'run-1'
    })
  })

  it('keeps the generic shell tool independent of Skills', async () => {
    const shellRunner = vi.fn().mockResolvedValue('ok')
    const tools = await createRuntimeTools({
      enabled: true,
      primaryFolder: process.cwd(),
      memory: false,
      network: false,
      shell: true,
      commandShell: pwsh,
      shellRunner,
      mcp: false
    })

    const shellTool = tools.find((item) => item.name === 'pwsh')
    expect(shellTool?.description).toContain('PowerShell 7.6.4 command with pwsh')
    expect(shellTool?.description).toContain('set keep_processes to true')
    expect(shellTool?.description).not.toContain('skill')
    expect((shellTool as { metadata?: unknown } | undefined)?.metadata).toMatchObject({
      anasCapabilityId: 'run_shell',
      anasToolKind: 'command_shell'
    })
    const shellSchema = toJsonSchema(shellTool!.schema) as JsonSchema7ObjectType
    expect(shellSchema.properties.command.description).toContain('PowerShell 7+ syntax')
    expect(shellSchema.properties.keep_processes.description).toContain('MUST be true')
    expect(shellSchema.properties.keep_processes.description).toContain('Defaults to false')
    expect(shellSchema.properties.summary.description).toContain("user's language")
    await expect(shellTool!.invoke({
      command: 'curl wttr.in/Shanghai',
      summary: 'Query Shanghai weather via wttr.in'
    })).resolves.toBe('ok')
    expect(shellRunner).toHaveBeenCalledWith({
      command: 'curl wttr.in/Shanghai',
      summary: 'Query Shanghai weather via wttr.in',
      timeoutSec: undefined,
      workingDir: undefined,
      keepProcesses: false
    })
    await expect(shellTool!.invoke({
      command: 'Start-Process calc',
      summary: 'Open Calculator',
      keep_processes: true
    })).resolves.toBe('ok')
    expect(shellRunner).toHaveBeenLastCalledWith({
      command: 'Start-Process calc',
      summary: 'Open Calculator',
      timeoutSec: undefined,
      workingDir: undefined,
      keepProcesses: true
    })
    await expect(shellTool!.invoke({ command: 'pwd' })).resolves.toBe('ok')
    const original = '\n  # original comment\n rg -n needle .  \n'
    await expect(shellTool!.invoke({ command: original })).resolves.toBe('ok')
    expect(shellRunner).toHaveBeenLastCalledWith(expect.objectContaining({ command: original }))
    const beforeBlank = shellRunner.mock.calls.length
    await expect(shellTool!.invoke({ command: ' \n\t' })).rejects.toThrow()
    expect(shellRunner.mock.calls.length).toBe(beforeBlank)
    await expect(shellTool!.invoke({ command: 'pwd', summary: '   ' })).rejects.toThrow()
  })

  it('uses the concrete POSIX program name and syntax in the tool definition', async () => {
    const tools = await createRuntimeTools({
      enabled: true,
      primaryFolder: process.cwd(),
      memory: false,
      network: false,
      shell: true,
      commandShell: {
        executable: '/bin/bash',
        name: 'bash',
        family: 'posix'
      },
      mcp: false
    })
    const bash = tools.find((item) => item.name === 'bash')
    const schema = toJsonSchema(bash!.schema) as JsonSchema7ObjectType

    expect(bash?.description).toContain('Bash command with /bin/bash')
    expect(schema.properties.command.description).toContain('Bash syntax')
  })
})
