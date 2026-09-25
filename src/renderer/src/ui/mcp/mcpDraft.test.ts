import { describe, expect, it } from 'vitest'
import { validateMcpDraftId, validateMcpDraftIdUnique, type McpDraft } from './mcpDraft'

const t = ((key: string) => key) as Parameters<typeof validateMcpDraftIdUnique>[2]

function draft(update: Partial<McpDraft> = {}): McpDraft {
  return {
    index: 1,
    name: 'Server',
    enabled: false,
    timeoutMs: 30000,
    type: 'stdio',
    url: '',
    apiKey: '',
    id: 'server_two',
    command: 'node',
    argsText: '',
    workingDir: '',
    envText: '',
    ...update
  }
}

describe('MCP draft validation', () => {
  it('rejects invalid and duplicate IDs without silently rewriting them', () => {
    expect(validateMcpDraftId(draft({ id: 'server two' }), t))
      .toBe('settings.mcp_server_id_invalid')
    expect(validateMcpDraftIdUnique(draft(), [
      { index: 0, id: 'server_two' },
      { index: 1, id: 'server_two' }
    ], t)).toBe('settings.mcp_server_id_duplicate')
  })

  it('allows the current server to keep its id', () => {
    expect(validateMcpDraftIdUnique(draft(), [
      { index: 1, id: 'server_two' }
    ], t)).toBeUndefined()
  })
})
