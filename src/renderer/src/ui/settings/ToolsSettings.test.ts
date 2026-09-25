import { describe, expect, it } from 'vitest'
import { builtinToolCatalog, runtimeToolSelectionId } from '@shared/toolRegistry'
import { mcpToolDisplayGroups, toolDefinitionText } from './ToolsSettings'

describe('tool definition JSON', () => {
  it('formats the model-facing name, description, and input schema', () => {
    expect(JSON.parse(toolDefinitionText({
      name: 'lookup',
      description: 'Find a record.',
      parameters: [],
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query']
      }
    }))).toEqual({
      name: 'lookup',
      description: 'Find a record.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query']
      }
    })
  })
})

describe('individual tool state', () => {
  it('maps a concrete shell name back to the stable command capability', () => {
    expect(runtimeToolSelectionId({ name: 'pwsh', capabilityId: 'run_shell' }))
      .toBe('run_shell')
    expect(runtimeToolSelectionId({ name: 'http_request' })).toBe('http_request')
  })

  it('maps capability-dependent tools to their controlling features', () => {
    expect(builtinToolCatalog.find((tool) => tool.id === 'run_shell'))
      .toMatchObject({ feature: 'commandExecution' })
    expect(builtinToolCatalog.find((tool) => tool.id === 'http_request'))
      .toMatchObject({ feature: 'networkAccess' })
    for (const name of ['read_call', 'read_call_output', 'wait_call', 'cancel_call']) {
      expect(builtinToolCatalog.find((tool) => tool.id === name)).toMatchObject({
        feature: 'backgroundTools'
      })
    }
    expect(builtinToolCatalog.find((tool) => tool.id === 'read_file'))
      .toMatchObject({ feature: 'fileRead' })
    expect(builtinToolCatalog.find((tool) => tool.id === 'apply_patch'))
      .toMatchObject({ feature: 'fileWrite' })
    expect(builtinToolCatalog.find((tool) => tool.id === 'get_file_edit_diff'))
      .toMatchObject({ feature: 'fileWrite' })
    expect(builtinToolCatalog.find((tool) => tool.id === 'update_config'))
      .toMatchObject({ feature: 'configuration' })
    expect(builtinToolCatalog.some((tool) => tool.id === ('update_assistant_profile' as never)))
      .toBe(false)
    expect(builtinToolCatalog.some((tool) => tool.id === ('update_user_profile' as never)))
      .toBe(false)
    expect(builtinToolCatalog.find((tool) => tool.id === 'read_memory'))
      .toMatchObject({ feature: 'memory' })
  })

})

describe('MCP tool source groups', () => {
  it('uses each loaded server tool list and preserves unmatched tools', () => {
    const groups = mcpToolDisplayGroups({
      checkedAt: '2026-07-28T00:00:00.000Z',
      servers: [
        {
          id: 'alpha',
          index: 0,
          name: 'Alpha',
          type: 'stdio',
          state: 'ready',
          toolCount: 1,
          toolNames: ['lookup']
        },
        {
          id: 'beta',
          index: 1,
          name: 'Beta',
          type: 'http',
          state: 'ready',
          toolCount: 1,
          toolNames: ['lookup']
        }
      ],
      loaded: [
        { id: 'alpha', index: 0, name: 'Alpha', toolCount: 1, toolNames: ['lookup'] },
        { id: 'beta', index: 1, name: 'Beta', toolCount: 1, toolNames: ['lookup'] }
      ],
      errors: [],
      tools: [
        { name: 'lookup', description: 'Alpha lookup', parameters: [] },
        { name: 'lookup', description: 'Beta lookup', parameters: [] },
        { name: 'orphan', description: 'Unknown source', parameters: [] }
      ],
      toolNames: ['lookup', 'lookup', 'orphan']
    }, [])

    expect(groups.map((group) => ({
      id: group.id,
      tools: group.tools.map((tool) => tool.description)
    }))).toEqual([
      { id: 'alpha:0', tools: ['Alpha lookup'] },
      { id: 'beta:1', tools: ['Beta lookup'] },
      { id: 'other', tools: ['Unknown source'] }
    ])
  })
})
