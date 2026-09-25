import { selectedSubagents } from '@shared/subagentSelection'
import { DEFAULT_WORKSPACE_PROJECT_ID, type AppConfigSnapshot, type RuntimeToolStatus } from '@shared/types'
import { todoListMiddleware } from 'langchain'
import { createFileTools } from './llm/fileTools'
import { createRuntimeTools } from './llm/runtimeTools'
import { serializeStructuredTool } from './toolSchemaSerialization'
import { createSubagentTools } from './agent/subagentTools'
import { runtimeToolSelectionId, sortToolDefinitions } from '@shared/toolRegistry'

export function frameworkToolDefinitions(
  subagents: AppConfigSnapshot['subagents'] = []
): RuntimeToolStatus['tools'] {
  const todoTools = todoListMiddleware().tools ?? []
  const subagentTools = createSubagentTools({ subagents })
  return [...todoTools, ...subagentTools].map(serializeStructuredTool)
}

export async function getRuntimeToolStatus(
  config: AppConfigSnapshot
): Promise<RuntimeToolStatus> {
  const runtimeTools = await createRuntimeTools({
    enabled: true,
    primaryFolder: process.cwd(),
    configuration: true,
    memory: true,
    memoryStore: {
      searchMemories: async () => ({ items: [], total: 0 }),
      saveMemory: async () => {
        throw new Error('Memory writes are unavailable in the settings tool preview.')
      },
      deleteMemory: async () => {
        throw new Error('Memory deletion is unavailable in the settings tool preview.')
      }
    },
    projectId: DEFAULT_WORKSPACE_PROJECT_ID,
    network: true,
    shell: true,
    backgroundTools: true,
    mcp: false,
    shellRunner: async () => JSON.stringify({
      ok: false,
      error: 'The command shell is not connected in the settings preview.'
    })
  })
  const tools = sortToolDefinitions([
    ...frameworkToolDefinitions(
      selectedSubagents(config.subagents)
    ),
    ...runtimeTools.map(serializeStructuredTool),
    ...createFileTools({
      maxReadBytes: null,
      primaryFolder: process.cwd()
    })
      .map(serializeStructuredTool)
  ], runtimeToolSelectionId)
  return {
    checkedAt: new Date().toISOString(),
    tools,
    toolNames: tools.map((tool) => tool.name)
  }
}
