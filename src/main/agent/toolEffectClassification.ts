import { isCustomToolMetadata } from '@shared/customTools'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { builtinToolCatalog } from '@shared/toolRegistry'
import type { AgentToolEffectRecoveryMode } from './toolEffectScope'
import { isCommandShellMetadata } from '@shared/commandShell'

export interface AgentToolEffectClassification {
  recoveryMode: AgentToolEffectRecoveryMode
}

type BuiltinToolName = typeof builtinToolCatalog[number]['id']
type StaticBuiltinToolName = Exclude<BuiltinToolName, 'run_shell'>
type BuiltinEffectPolicy = 'read' | 'confirm' | 'idempotent' | 'conditional'

export const builtinToolEffectPolicies = {
  request_user_input: 'read',
  http_request: 'conditional',
  read_call: 'read',
  read_call_output: 'read',
  wait_call: 'read',
  cancel_call: 'idempotent',
  write_call: 'conditional',
  read_file: 'read',
  view_image: 'read',
  view_multiple_images: 'read',
  read_multiple_files: 'read',
  list_directory: 'read',
  directory_tree: 'read',
  get_file_info: 'read',
  apply_patch: 'conditional',
  write_file: 'confirm',
  restore_file_edit: 'conditional',
  get_file_edit_diff: 'read',
  create_directory: 'idempotent',
  move_file: 'confirm',
  delete_file: 'confirm',
  update_config: 'idempotent',
  read_memory: 'read',
  save_to_memory: 'confirm',
  forget_memory: 'idempotent'
} as const satisfies Record<StaticBuiltinToolName, BuiltinEffectPolicy>

type McpAnnotations = {
  readOnlyHint?: unknown
  idempotentHint?: unknown
}

function toolMetadata(tool: StructuredToolInterface | undefined): Record<string, unknown> | undefined {
  const metadata = (tool as { metadata?: unknown } | undefined)?.metadata
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : undefined
}

function mcpAnnotations(
  toolName: string,
  tool: StructuredToolInterface | undefined
): McpAnnotations | undefined {
  const metadata = toolMetadata(tool)
  const isMcpTool = toolName.startsWith('mcp_')
    || (metadata !== undefined && Object.hasOwn(metadata, 'annotations'))
  if (!isMcpTool) return undefined
  const annotations = metadata?.annotations
  return annotations && typeof annotations === 'object' && !Array.isArray(annotations)
    ? annotations as McpAnnotations
    : {}
}

function hasHttpBody(args: Record<string, unknown>): boolean {
  return typeof args.body === 'string'
    || (typeof args.body_file === 'string' && args.body_file.trim().length > 0)
    || args.form_fields !== undefined
    || args.form_files !== undefined
}

function hasIdempotencyKey(args: Record<string, unknown>): boolean {
  if (!args.headers || typeof args.headers !== 'object' || Array.isArray(args.headers)) return false
  return Object.entries(args.headers).some(([name, value]) =>
    name.toLowerCase() === 'idempotency-key'
    && (typeof value === 'string' || typeof value === 'number')
    && String(value).trim().length > 0
  )
}

function classifyHttpRequest(args: Record<string, unknown>): AgentToolEffectClassification | undefined {
  const defaultMethod = hasHttpBody(args) ? 'POST' : 'GET'
  const method = typeof args.method === 'string'
    ? args.method.trim().toUpperCase() || defaultMethod
    : defaultMethod
  const writesFile = typeof args.output_path === 'string' && args.output_path.trim().length > 0

  if (!writesFile && (method === 'GET' || method === 'HEAD' || method === 'OPTIONS')) {
    return undefined
  }
  if (method === 'PUT' || method === 'DELETE' || hasIdempotencyKey(args)) {
    return { recoveryMode: 'idempotent' }
  }
  return { recoveryMode: 'confirm' }
}

export function classifyAgentToolEffect(
  toolName: string,
  args: Record<string, unknown>,
  tool?: StructuredToolInterface
): AgentToolEffectClassification | undefined {
  if (toolName === 'start_subagent' || toolName === 'cancel_subagent') {
    return { recoveryMode: 'idempotent' }
  }
  if (isCommandShellMetadata(toolMetadata(tool)) || isCustomToolMetadata(toolMetadata(tool))) {
    return { recoveryMode: 'confirm' }
  }
  const annotations = mcpAnnotations(toolName, tool)
  if (annotations) {
    if (annotations.readOnlyHint === true) return undefined
    return {
      recoveryMode: annotations.idempotentHint === true ? 'idempotent' : 'confirm'
    }
  }
  const policy = builtinToolEffectPolicies[toolName as StaticBuiltinToolName]
  if (policy === 'read') return undefined
  if (policy === 'idempotent') return { recoveryMode: 'idempotent' }
  if (policy === 'confirm') return { recoveryMode: 'confirm' }
  if (toolName === 'http_request') return classifyHttpRequest(args)
  if (toolName === 'write_call') return { recoveryMode: args.action && typeof args.action === 'object' && 'type' in args.action && args.action.type === 'resize' ? 'idempotent' : 'confirm' }
  if (toolName === 'apply_patch' || toolName === 'restore_file_edit') {
    return args.dry_run === true ? undefined : { recoveryMode: 'confirm' }
  }
  return undefined
}
