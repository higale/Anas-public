import { defaultCapabilities, } from '@shared/agentCapabilities'
import { describe, expect, it } from 'vitest'
import type { AppConfigSnapshot } from '@shared/types'
import { frameworkToolDefinitions, getRuntimeToolStatus } from './runtimeToolStatus'
import { createFileTools } from './llm/fileTools'
import { serializeStructuredTool } from './toolSchemaSerialization'

const subagents = [{
 capabilities: { ...structuredClone(defaultCapabilities), profile: false, workspace: true,
    memory: true, toolMode: 'all' as const, tools: [], skills: { enabled: true, mode: 'default' as const, project: false, entries: [] } },
  index: 0,
  name: 'general-purpose',
  enabled: true,
  preset: 'general-purpose' as const,
  builtIn: true,
  description: 'General work.',
  systemPrompt: 'Complete the task.',
}]

describe('framework tool status', () => {
  it.each([undefined, 256_000, 1_000_000])('shows the dynamic read contract independently of the default model: %s', async (maxContextTokens) => {
    const status = await getRuntimeToolStatus({ settings: {}, subagents: [],
      ...(maxContextTokens === undefined ? {} : { defaultModel: { maxContextTokens } })
    } as unknown as AppConfigSnapshot)
    const runtimeTools = createFileTools({ primaryFolder: process.cwd(), maxReadBytes: async () => 64000 })
      .map(serializeStructuredTool)
    for (const name of ['read_file', 'read_multiple_files']) {
      expect(status.tools.find(tool => tool.name === name)).toEqual(runtimeTools.find(tool => tool.name === name))
    }
  })

  it('includes the config update tool in the settings catalog', async () => {
    const status = await getRuntimeToolStatus({
      settings: {},
      subagents
    } as unknown as AppConfigSnapshot)

    expect(status.toolNames).toEqual(expect.arrayContaining([
      'write_todos',
      'start_subagent',
      'read_subagent',
      'wait_subagent',
      'cancel_subagent'
    ]))
    expect(status.toolNames).toEqual(expect.arrayContaining([
      'read_call',
      'read_call_output',
      'wait_call',
      'cancel_call',
      'write_call'
    ]))
    expect(status.toolNames).toContain('update_config')
    expect(status.toolNames).not.toContain('update_assistant_profile')
    expect(status.toolNames).not.toContain('update_user_profile')
    const commandShell = status.tools.find((tool) => tool.capabilityId === 'run_shell')
    expect(commandShell).toMatchObject({
      name: expect.not.stringMatching(/^run_shell$/),
      description: expect.stringContaining('expected long duration is not a reason'),
      parameters: expect.arrayContaining([
        expect.objectContaining({ name: 'pty' }),
        expect.objectContaining({
          name: 'timeout',
          description: expect.stringContaining('NEVER infer or add a timeout')
        })
      ])
    })
    expect(status.toolNames).toContain(commandShell?.name)
    expect(new Set(status.toolNames).size).toBe(status.toolNames.length)
    expect(status.tools.find((tool) => tool.name === 'write_call')?.parameters.map((parameter) => parameter.name))
      .toEqual(['summary', 'call_id', 'terminal_id', 'action'])
    expect(status.tools.find((tool) => tool.name === 'update_config')).toMatchObject({
      description: expect.stringContaining('settings'),
      parameters: expect.arrayContaining([
        expect.objectContaining({ name: 'config' }),
        expect.objectContaining({ name: 'key' }),
        expect.objectContaining({
          name: 'value',
          description: expect.stringContaining('a string uses value: "text"')
        })
      ])
    })
    expect(status.tools.find((tool) => tool.name === 'wait_call')).toMatchObject({
      description: expect.stringContaining('terminal state'),
      parameters: expect.arrayContaining([
        expect.objectContaining({ name: 'call_id' }),
        expect.objectContaining({ name: 'timeout' })
      ])
    })
  })

  it('reads the original framework tool descriptions and schemas', () => {
    const tools = frameworkToolDefinitions(subagents)
    expect(tools.map((tool) => tool.name)).toEqual([
      'write_todos',
      'start_subagent',
      'read_subagent',
      'wait_subagent',
      'cancel_subagent'
    ])
    expect(tools.find((tool) => tool.name === 'write_todos')).toMatchObject({
      description: expect.stringContaining('create and manage a structured task list'),
      parameters: [expect.objectContaining({ name: 'todos' })]
    })
    expect(tools.find((tool) => tool.name === 'start_subagent')).toMatchObject({
      description: expect.stringContaining('independent background run'),
      parameters: [
        expect.objectContaining({ name: 'agent' }),
        expect.objectContaining({ name: 'description' })
      ]
    })
  })

  it('keeps control tools but omits start when there is no configured subagent', () => {
    expect(frameworkToolDefinitions([]).map((tool) => tool.name))
      .toEqual(['write_todos', 'read_subagent', 'wait_subagent', 'cancel_subagent'])
  })

  it('reports the same control-only contract in the runtime status preview', async () => {
    const status = await getRuntimeToolStatus({
      settings: {},
      subagents: []
    } as unknown as AppConfigSnapshot)

    expect(status.toolNames).not.toContain('start_subagent')
    expect(status.toolNames).toEqual(expect.arrayContaining([
      'read_subagent',
      'wait_subagent',
      'cancel_subagent'
    ]))
  })

  it('exposes configured subagent selection descriptions', () => {
    const start = frameworkToolDefinitions([
      subagents[0],
      {
        ...subagents[0],
        index: 1,
        name: 'web-researcher',
        description: 'Research current information.'
      }
    ]).find((tool) => tool.name === 'start_subagent')

    expect(start?.description).toContain('- general-purpose: General work.')
    expect(start?.description).toContain('- web-researcher: Research current information.')
    const agent = start?.parameters.find((parameter) => parameter.name === 'agent')
    expect(JSON.stringify(agent)).toContain('general-purpose')
    expect(JSON.stringify(agent)).toContain('web-researcher')
  })
})
