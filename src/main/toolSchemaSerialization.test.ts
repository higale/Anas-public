import { tool } from '@langchain/core/tools'
import { z } from 'zod/v3'
import { describe, expect, it } from 'vitest'
import { commandShellMetadata } from '@shared/commandShell'
import { serializeStructuredTool } from './toolSchemaSerialization'

describe('tool schema serialization', () => {
  it('maps only verified command-shell metadata to the stable capability ID', () => {
    const shell = tool(async () => 'ok', {
      name: 'pwsh',
      description: 'Run PowerShell.',
      metadata: commandShellMetadata(),
      schema: z.object({ command: z.string() })
    })
    const unrelated = tool(async () => 'ok', {
      name: 'external_tool',
      description: 'External tool.',
      metadata: { anasCapabilityId: 'run_shell' },
      schema: z.object({})
    })

    expect(serializeStructuredTool(shell).capabilityId).toBe('run_shell')
    expect(serializeStructuredTool(unrelated).capabilityId).toBeUndefined()
  })
})
