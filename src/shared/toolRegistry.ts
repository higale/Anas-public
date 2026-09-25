import type { AgentFeatures, RuntimeToolDefinition } from './types'

export interface BuiltinToolCatalogEntry {
  id: string
  feature?: keyof AgentFeatures
}

/** Tool catalog and model request order; capability controls have their own layout. */
export const toolGroupOrder = [
  'planning', 'request_user_input', 'subagents', 'backgroundTools',
  'fileRead', 'fileWrite', 'commandExecution', 'networkAccess',
  'memory', 'configuration', 'customTools', 'mcp'
] as const

export const frameworkToolCatalog = [
  { id: 'write_todos', feature: 'planning' },
  { id: 'start_subagent', feature: 'subagents' },
  { id: 'read_subagent', feature: 'subagents' },
  { id: 'wait_subagent', feature: 'subagents' },
  { id: 'cancel_subagent', feature: 'subagents' }
] as const satisfies readonly BuiltinToolCatalogEntry[]

export const builtinToolCatalog = [
  { id: 'request_user_input', feature: undefined },
  { id: 'run_shell', feature: 'commandExecution' },
  { id: 'http_request', feature: 'networkAccess' },
  { id: 'read_call', feature: 'backgroundTools' },
  { id: 'read_call_output', feature: 'backgroundTools' },
  { id: 'write_call', feature: 'backgroundTools' },
  { id: 'wait_call', feature: 'backgroundTools' },
  { id: 'cancel_call', feature: 'backgroundTools' },
  { id: 'read_file', feature: 'fileRead' },
  { id: 'read_multiple_files', feature: 'fileRead' },
  { id: 'view_image', feature: 'fileRead' },
  { id: 'view_multiple_images', feature: 'fileRead' },
  { id: 'list_directory', feature: 'fileRead' },
  { id: 'directory_tree', feature: 'fileRead' },
  { id: 'get_file_info', feature: 'fileRead' },
  { id: 'apply_patch', feature: 'fileWrite' },
  { id: 'write_file', feature: 'fileWrite' },
  { id: 'restore_file_edit', feature: 'fileWrite' },
  { id: 'get_file_edit_diff', feature: 'fileWrite' },
  { id: 'create_directory', feature: 'fileWrite' },
  { id: 'move_file', feature: 'fileWrite' },
  { id: 'delete_file', feature: 'fileWrite' },
  { id: 'update_config', feature: 'configuration' },
  { id: 'read_memory', feature: 'memory' },
  { id: 'save_to_memory', feature: 'memory' },
  { id: 'forget_memory', feature: 'memory' }
] as const satisfies readonly BuiltinToolCatalogEntry[]

const catalogToolOrder: Partial<Record<typeof toolGroupOrder[number], readonly string[]>> = {
  backgroundTools: ['read_call', 'read_call_output', 'write_call', 'wait_call', 'cancel_call'],
  fileRead: ['list_directory', 'directory_tree', 'get_file_info', 'read_file', 'read_multiple_files', 'view_image', 'view_multiple_images'],
  fileWrite: ['create_directory', 'write_file', 'apply_patch', 'get_file_edit_diff', 'restore_file_edit', 'move_file', 'delete_file']
}

export const orderedToolCatalog = toolGroupOrder.flatMap((group) => {
  const tools = [...builtinToolCatalog, ...frameworkToolCatalog].filter((tool) => (tool.feature ?? tool.id) === group)
  const ids = catalogToolOrder[group]
  return ids ? tools.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id)) : tools
})

/** Keep tool objects and extension order intact; only reorder the request list. */
export function sortToolDefinitions<T>(
  tools: readonly T[],
  identify: (tool: T) => string | undefined,
  extensionOrder: readonly string[] = []
): T[] {
  const order = new Map<string, number>([...orderedToolCatalog.map((tool) => tool.id), ...extensionOrder]
    .map((id, index) => [id, index]))
  const rank = (tool: T) => order.get(identify(tool) ?? '') ?? order.size
  return [...tools].sort((left, right) => rank(left) - rank(right))
}

export const builtinFileToolNames = builtinToolCatalog
  .filter((tool) => tool.feature === 'fileRead' || tool.feature === 'fileWrite')
  .map((tool) => tool.id)

export function runtimeToolSelectionId(
  tool: Pick<RuntimeToolDefinition, 'name' | 'capabilityId'>
): string {
  return tool.capabilityId ?? tool.name
}

export function enabledBuiltinFileToolNames(
  features: AgentFeatures,
  selectedToolNames?: readonly string[]
): string[] {
  const selected = selectedToolNames ? new Set(selectedToolNames) : undefined
  return builtinToolCatalog
    .filter((tool) => tool.feature === 'fileRead' || tool.feature === 'fileWrite')
    .filter((tool) => features[tool.feature])
    .filter((tool) => !selected || selected.has(tool.id))
    .map((tool) => tool.id)
}
