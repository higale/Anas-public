import { isCustomToolMetadata } from '@shared/customTools'
import { ToolMessage } from '@langchain/core/messages'
import { isCommand } from '@langchain/langgraph'
import { DynamicStructuredTool, type StructuredToolInterface } from '@langchain/core/tools'
import { isCommandShellMetadata } from '@shared/commandShell'
import { builtinToolCatalog } from '@shared/toolRegistry'
import type { AgentDatabase, AgentManagedCallKind } from './agentDatabase'
import type { ManagedCallService } from './managedCallService'
import { classifyAgentToolEffect } from './toolEffectClassification'
import { decodeManagedToolResult, encodeManagedToolResult, isManagedToolResultReference, managedToolText } from './managedToolResult'
import { toolLocalCommitStarted, withToolExecution } from './toolExecutionContext'

const managementTools = new Set(['read_call', 'read_call_output', 'wait_call', 'cancel_call', 'write_call'])
const builtinTools = new Set<string>(builtinToolCatalog.map(({ id }) => id))
const fileMutations = new Set(['apply_patch', 'write_file', 'restore_file_edit', 'create_directory', 'move_file', 'delete_file'])

interface ManagedToolOptions {
  database: AgentDatabase
  service?: Pick<ManagedCallService, 'start'>
  threadId: string
  runId?: string
  allowBackground: boolean
  signal?: AbortSignal
}

export function supportsManagedTool(tool: StructuredToolInterface): boolean {
  if (tool.name === 'request_user_input') return false
  return !managementTools.has(tool.name) && (
    builtinTools.has(tool.name) || isCustomToolMetadata((tool as { metadata?: unknown }).metadata) || isCommandShellMetadata((tool as { metadata?: unknown }).metadata) || tool.name.startsWith('mcp_')
  )
}

/** A native facade owns the framework tool-call stream and returns the handle.
 * The adapter/executor owns its actual result; its late callbacks must not
 * overwrite the already-finished facade invocation. */
export function withManagedToolExecution(tool: StructuredToolInterface, options: ManagedToolOptions): StructuredToolInterface {
  if (!supportsManagedTool(tool)) return tool
  const kind: AgentManagedCallKind = isCommandShellMetadata((tool as { metadata?: unknown }).metadata)
    ? 'shell' : isCustomToolMetadata((tool as { metadata?: unknown }).metadata) ? 'custom' : tool.name === 'http_request' ? 'http' : tool.name.startsWith('mcp_') ? 'mcp' : 'builtin'
  const target = tool
  return new DynamicStructuredTool({
    name: tool.name,
    schema: tool.schema,
    verboseParsingErrors: true,
    metadata: (tool as { metadata?: Record<string, unknown> }).metadata,
    description: tool.description + (options.allowBackground
      ? ' Calls queue automatically when execution capacity is busy. After 10 seconds waiting or executing, this tool may return a background call_id instead of its final result; do not resubmit a queued call. Wait for dependent work with wait_call; inspect details with read_call_output. No output or progress does not by itself indicate a stalled call.'
      : ''),
    func: async (args: Record<string, unknown>, _runManager, config) => {
      const { service, runId } = options
      if (!service || !runId) throw new Error('Tool execution requires an active agent run.')
      const callId = (config as { toolCall?: { id?: string } } | undefined)?.toolCall?.id ?? ''
      const invocation = { type: 'tool_call' as const, id: callId, name: tool.name, args: { ...args } }
      const effectful = Boolean(classifyAgentToolEffect(target.name, args, target))
      const localCommit = kind === 'builtin' && effectful
      const result = await service.start({
        kind,
        threadId: options.threadId,
        runId,
        summary: typeof args.summary === 'string' ? args.summary : target.name,
        parentSignal: options.signal && config?.signal
          ? AbortSignal.any([options.signal, config.signal])
          : options.signal ?? config?.signal,
        allowBackground: options.allowBackground,
        retainInlineResult: effectful,
        // The Shell supervisor confirms process termination itself and calls
        // markUncertain only when that confirmation is unavailable.
        uncertainWhenCancelledAfterDispatch: effectful && kind !== 'shell' && kind !== 'custom',
        serialGroup: fileMutations.has(target.name) ? 'filesystem-writes'
          : target.name === 'update_config' ? 'configuration'
            : target.name === 'save_to_memory' || target.name === 'forget_memory' ? 'memory-writes' : undefined,
        execute: (control) => withToolExecution(control, localCommit, async () => {
          control.signal.throwIfAborted()
          if (!effectful) control.markRunning()
          control.setOutcome({ tool_name: target.name })
          try {
            // tool() races its function against config.signal. Built-ins must
            // settle their actual executor/cleanup before releasing the call;
            // they receive cancellation through ToolExecutionContext instead.
            // MCP's adapter passes the request signal directly to the SDK.
            const signal = kind === 'mcp' ? control.signal : new AbortController().signal
            const output = await target.invoke(invocation, { ...config, signal, callbacks: [] })
            if (isCommand(output)) throw new Error('Graph-state tools must execute natively, not as background calls.')
            const message = ToolMessage.isInstance(output) ? output : new ToolMessage({
              name: target.name,
              tool_call_id: invocation.id ?? '',
              content: typeof output === 'string' ? output : JSON.stringify(output)
            })
            if (kind === 'custom' && control.outcome?.ok === false) message.status = 'error'
            const text = managedToolText(message)
            // Result content is opaque; execution status comes from the tool or executor.
            control.setOutcome({
              ok: typeof control.outcome?.ok === 'boolean' ? control.outcome.ok : message.status !== 'error',
              result_format: 'langchain',
              ...(kind !== 'shell' ? { result_output_chars: text.length } : {}),
              ...(toolLocalCommitStarted() ? { local_commit_completed: true } : {})
            })
            return encodeManagedToolResult(options.database, message, { threadId: options.threadId, runId })
          } catch (error) {
            if (effectful && control.dispatched && !control.outcome?.remote_failure_confirmed
              && (kind === 'mcp' || toolLocalCommitStarted())) {
              control.markUncertain('The tool did not return a confirmed outcome after dispatch.')
            }
            throw error
          }
        })
      })
      const value = JSON.parse(result) as { ok?: boolean }
      if (isManagedToolResultReference(value)) {
        return decodeManagedToolResult(options.database, result, options.threadId)
      }
      return new ToolMessage({
        name: target.name,
        tool_call_id: invocation.id ?? '',
        content: result,
        status: value.ok === false ? 'error' : 'success'
      })
    }
  })
}
