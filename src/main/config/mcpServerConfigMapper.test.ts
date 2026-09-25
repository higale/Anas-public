import { describe, expect, it } from 'vitest'
import { rawMcpServerFromSave } from './mcpServerConfigMapper'

describe('MCP server configuration', () => {
  it('allows changing the server ID used as the tool-name namespace', () => {
    expect(rawMcpServerFromSave({
      index: 0,
      name: 'Search',
      enabled: true,
      timeoutMs: 30_000,
      type: 'stdio',
      id: 'clear_search',
      command: 'node',
      args: [],
      env: {}
    }, {
      id: 'mcp_server_1',
      name: 'Search',
      enabled: false,
      type: 'stdio',
      command: 'node'
    })).toMatchObject({
      id: 'clear_search',
      name: 'Search'
    })
  })
})
