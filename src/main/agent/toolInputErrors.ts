import { isLangChainTool, ToolInputParsingException, type ClientTool, type ServerTool } from '@langchain/core/tools'
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { interopSafeParseAsync, isInteropZodSchema } from '@langchain/core/utils/types'
import { validate, type Schema } from '@cfworker/json-schema'
import { createMiddleware, MiddlewareError, toolErrorMiddleware, ToolInvocationError } from 'langchain'
import { z } from 'zod'
import { isCustomToolMetadata, maxCustomToolInputBytes } from '@shared/customTools'

/** The checkpoint's messages own which calls still need preflight/execution. */
export function pendingModelToolCalls(messages: readonly BaseMessage[]) {
  let index = messages.length - 1
  while (index >= 0 && !AIMessage.isInstance(messages[index])) index--
  const message = index < 0 ? undefined : messages[index] as AIMessage
  const answered = new Set(messages.slice(index + 1).filter(ToolMessage.isInstance).map(item => item.tool_call_id))
  return { message, answered, calls: message?.tool_calls?.filter(call => !answered.has(call.id!)) ?? [] }
}

function validateToolArgumentValues(args: unknown): void {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new ToolInputParsingException('Tool arguments must be a JSON object.')
  }
  const pending = [{ value: args as unknown, path: '' }]
  const visited = new WeakSet<object>()
  while (pending.length) {
    const { value, path } = pending.pop()!
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new ToolInputParsingException(`Invalid number at ${path}: expected a finite number, received ${String(value)}.`)
    }
    if (!value || typeof value !== 'object' || visited.has(value)) continue
    visited.add(value)
    for (const [key, child] of Object.entries(value)) {
      pending.push({ value: child, path: `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}` })
    }
  }
}

/** Validate model arguments before hashing, preflight or dispatch.
 * Keep original arguments intact; native tool invocation owns transformations. */
export async function validateAgentToolInput(tool: ClientTool | ServerTool | undefined, args: unknown): Promise<void> {
  validateToolArgumentValues(args)
  // Native tool routing reports unknown/dynamically supplied tool names.
  if (!isLangChainTool(tool)) return
  if (isCustomToolMetadata((tool as { metadata?: unknown }).metadata) && Buffer.byteLength(JSON.stringify(args), 'utf8') > maxCustomToolInputBytes) {
    throw new ToolInputParsingException('Custom tool arguments exceed 1 MiB. Reduce the submitted data.')
  }
  if (isInteropZodSchema(tool.schema)) {
    const result = await interopSafeParseAsync(tool.schema, args)
    if (!result.success) throw new ToolInputParsingException(z.prettifyError(result.error))
  } else {
    const result = validate(args, tool.schema as Schema)
    if (!result.valid) throw new ToolInputParsingException(result.errors
      .map(error => `${error.instanceLocation || '/'}: ${error.error} (${error.keywordLocation})`).join('\n'))
  }
}

/** Only explicitly identified tool-input errors are safe for model correction. */
export function formatAgentToolInputError(error: unknown, toolName: string): string | undefined {
  let cause = error
  const wrappers = new Set<unknown>()
  while (MiddlewareError.isInstance(cause) && !wrappers.has(cause)) {
    wrappers.add(cause)
    cause = cause.cause
  }
  const inputError = ToolInvocationError.isInstance(cause) ? cause.toolError
    : cause instanceof ToolInputParsingException ? cause : undefined
  if (!inputError) return undefined
  const detail = inputError.message.trim()
  return [
    `Tool '${toolName}' received invalid input${detail ? ':' : '.'}`,
    detail,
    'Correct the arguments and try again.'
  ].filter(Boolean).join('\n')
}

export function createToolInputErrorMiddleware() {
  const middleware = toolErrorMiddleware({
    onError: (error, request) => {
      request.runtime.signal?.throwIfAborted()
      return formatAgentToolInputError(error, request.toolCall.name)
    }
  })
  return createMiddleware({
    ...middleware,
    wrapToolCall: (request, handler) => middleware.wrapToolCall!(request, async next => {
      await validateAgentToolInput(next.tool, next.toolCall.args)
      return handler(next)
    })
  })
}

/** Install after product preflight middleware: afterModel hooks run in reverse. */
export function createToolInputValidationMiddleware(tools: readonly (ClientTool | ServerTool)[]) {
  const available = new Map(tools.filter(isLangChainTool).map(tool => [tool.name, tool]))
  return createMiddleware({
    name: 'AnasToolInputValidationMiddleware',
    afterModel: async (state, runtime) => {
      const { calls } = pendingModelToolCalls(state.messages)
      const errors: ToolMessage[] = []
      for (const call of calls) {
        runtime.signal?.throwIfAborted()
        try {
          await validateAgentToolInput(available.get(call.name), call.args)
        } catch (error) {
          runtime.signal?.throwIfAborted()
          const content = formatAgentToolInputError(error, call.name)
          if (content === undefined || !call.id) throw error
          errors.push(new ToolMessage({ tool_call_id: call.id, name: call.name, status: 'error', content }))
        }
      }
      if (errors.length) return { messages: errors }
    }
  })
}
