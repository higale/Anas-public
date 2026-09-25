import type { ServerTool } from '@langchain/core/tools'
import type { ResolvedModelConfig } from '@shared/types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function configuredServerTools(model: ResolvedModelConfig): ServerTool[] {
  const value = model.parameters.tools
  if (value === undefined) return []
  if (model.protocol !== 'openai_responses') {
    throw new Error('The model parameter "tools" is only supported by the OpenAI Responses protocol.')
  }
  if (!Array.isArray(value)) {
    throw new Error('The OpenAI Responses model parameter "tools" must be an array.')
  }
  return value.map((tool, index) => {
    if (!isRecord(tool) || typeof tool.type !== 'string' || !tool.type.trim()) {
      throw new Error(`OpenAI Responses model parameter tools[${index}] must have a non-empty type.`)
    }
    if (tool.type === 'function' || tool.type === 'custom') {
      throw new Error(
        `OpenAI Responses model parameter tools[${index}] cannot declare a client-executed ${tool.type} tool.`
      )
    }
    return { ...tool }
  })
}
