import { describe, expect, it } from 'vitest'
import { z } from 'zod/v3'

type PrivateExports = {
  schemaParameters(schema: unknown): Array<{ name: string; description: string }>
}

describe('MCP tool schema serialization', () => {
  it('extracts parameters from JSON Schema properties', async () => {
    const { schemaParameters } = await import('./toolSchemaSerialization') as unknown as PrivateExports

    expect(schemaParameters({
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'File path to read.' },
        limit: { type: 'number', description: 'Maximum entries.' }
      }
    })).toEqual([
      { name: 'path', description: 'File path to read. Required.', schema: { type: 'string', description: 'File path to read.' } },
      { name: 'limit', description: 'Maximum entries.', schema: { type: 'number', description: 'Maximum entries.' } }
    ])
  })

  it('falls back to JSON Schema type when parameter descriptions are missing', async () => {
    const { schemaParameters } = await import('./toolSchemaSerialization') as unknown as PrivateExports

    expect(schemaParameters({
      type: 'object',
      required: ['source', 'destination'],
      properties: {
        source: { type: 'string' },
        destination: { type: 'string' }
      }
    })).toEqual([
      { name: 'source', description: 'string Required.', schema: { type: 'string' } },
      { name: 'destination', description: 'string Required.', schema: { type: 'string' } }
    ])
  })

  it('summarizes array item types while preserving the schema', async () => {
    const { schemaParameters } = await import('./toolSchemaSerialization') as unknown as PrivateExports

    expect(schemaParameters({
      type: 'object',
      properties: {
        excludePatterns: {
          type: 'array',
          items: { type: 'string' }
        }
      }
    })).toEqual([
      {
        name: 'excludePatterns',
        description: 'array<string>',
        schema: {
          type: 'array',
          items: { type: 'string' }
        }
      }
    ])
  })

  it('serializes Zod enum parameters to JSON Schema', async () => {
    const { toolInputSchema, schemaParameters } = await import('./toolSchemaSerialization')
    const inputSchema = toolInputSchema(z.object({
      runner: z.enum(['auto', 'python']).describe('How to run the script.')
    }))

    expect(schemaParameters(inputSchema)).toEqual([
      {
        name: 'runner',
        description: 'How to run the script. Required.',
        schema: {
          type: 'string',
          enum: ['auto', 'python'],
          description: 'How to run the script.'
        }
      }
    ])
  })
})
