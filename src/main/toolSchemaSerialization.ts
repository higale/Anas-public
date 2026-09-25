import { toJsonSchema } from '@langchain/core/utils/json_schema'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { RuntimeToolDefinition } from '@shared/types'
import { commandShellCapabilityId, isCommandShellMetadata } from '@shared/commandShell'

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function jsonSchemaDescription(property: Record<string, unknown> | undefined): string {
  if (!property) return ''
  if (typeof property.description === 'string' && property.description.trim()) return property.description.trim()
  if (typeof property.const === 'string') return `const ${property.const}`
  if (Array.isArray(property.enum) && property.enum.length > 0) return `enum: ${property.enum.map(String).join(', ')}`
  if (typeof property.type === 'string') {
    if (property.type === 'array') return arrayDescription(property)
    return property.type
  }
  if (Array.isArray(property.type) && property.type.length > 0) return property.type.map(String).join(' | ')
  if (Array.isArray(property.anyOf) && property.anyOf.length > 0) return 'anyOf'
  if (Array.isArray(property.oneOf) && property.oneOf.length > 0) return 'oneOf'
  if (Array.isArray(property.allOf) && property.allOf.length > 0) return 'allOf'
  return ''
}

function arrayDescription(property: Record<string, unknown>): string {
  const items = recordOf(property.items)
  const itemType = typeof items?.type === 'string' ? items.type : undefined
  return itemType ? `array<${itemType}>` : 'array'
}

export function schemaParameters(schema: unknown): RuntimeToolDefinition['parameters'] {
  const record = recordOf(schema)
  const properties = recordOf(record?.properties)
  if (!properties) return []
  const required = Array.isArray(record?.required) ? new Set(record.required.filter((item): item is string => typeof item === 'string')) : new Set<string>()
  return Object.entries(properties).map(([name, value]) => {
    const property = recordOf(value)
    const description = jsonSchemaDescription(property)
    return {
      name,
      description: [description, required.has(name) ? 'Required.' : ''].filter(Boolean).join(' '),
      schema: value
    }
  })
}

export function toolInputSchema(schema: unknown): unknown {
  const record = recordOf(schema)
  if (record?.type === 'object' && recordOf(record.properties)) return schema
  try {
    return toJsonSchema(schema as Parameters<typeof toJsonSchema>[0])
  } catch {
    return schema
  }
}

export function serializeStructuredTool(tool: StructuredToolInterface): RuntimeToolDefinition {
  const inputSchema = toolInputSchema((tool as { schema?: unknown }).schema)
  const metadata = recordOf((tool as { metadata?: unknown }).metadata)
  return {
    name: tool.name,
    ...(isCommandShellMetadata(metadata)
      ? { capabilityId: commandShellCapabilityId }
      : {}),
    description: typeof tool.description === 'string' ? tool.description : '',
    parameters: schemaParameters(inputSchema),
    inputSchema
  }
}
