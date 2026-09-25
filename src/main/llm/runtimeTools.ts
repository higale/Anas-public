import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { z } from 'zod/v3'
import { createConfigTools } from './configTools'
import { createHttpRequestTool } from './httpRequestTool'
import {
  describeCommandShellArgument,
  describeCommandShellTool,
  getCommandShell,
  type CommandShellInfo
} from '../shellRuntime'
import {
  commandShellCapabilityId,
  commandShellMetadata,
  commandShellToolName,
  maxCommandTimeoutSeconds
} from '@shared/commandShell'
import { toolSummarySchema } from './toolSummary'
import type { SqliteMemoryStore } from '../agent/memoryStore'
import {
  armCurrentAgentToolEffect,
  currentAgentToolEffectArtifactId
} from '../agent/toolEffectScope'
import type { ManagedCallService } from '../agent/managedCallService'
import { terminalActionSchema, terminalSizeSchema, type TerminalSize } from '@shared/terminal'
import { userInputSchema, type UserInputSource } from '@shared/userInput'
import { userInputService } from '../agent/userInputService'

export type ShellRunner = (input: {
  command: string
  summary?: string
  timeoutSec?: number
  workingDir?: string
  keepProcesses?: boolean
  pty?: TerminalSize
}) => Promise<string>

export interface RuntimeToolOptions {
  enabled: boolean
  primaryFolder: string
  configuration?: boolean
  memory: boolean
  memoryStore?: Pick<SqliteMemoryStore, 'searchMemories' | 'saveMemory' | 'deleteMemory'>
  projectId?: string
  threadId?: string
  runId?: string
  userInputSource?: () => Promise<UserInputSource>
  network: boolean
  backgroundTools?: boolean
  interactiveCustomTools?: boolean
  shell: boolean
  commandShell?: CommandShellInfo
  toolNames?: readonly string[]
  mcp: boolean
  signal?: AbortSignal
  shellRunner?: ShellRunner
  mcpTools?: StructuredToolInterface[]
  managedCalls?: Pick<ManagedCallService, 'read' | 'readOutput' | 'readResult' | 'wait' | 'cancel' | 'start'>
    & Partial<Pick<ManagedCallService, 'writeTerminal'>>
  managedCallSupervision?: boolean
}

type ManagedCallToolOptions = Pick<
  RuntimeToolOptions,
  'managedCalls' | 'threadId' | 'signal'
>

function requireManagedCallContext(options: ManagedCallToolOptions) {
  if (!options.managedCalls || !options.threadId) {
    throw new Error('Background call tools require a conversation runtime.')
  }
  return {
    managedCalls: options.managedCalls,
    threadId: options.threadId
  }
}

export function createManagedCallTools(
  options: ManagedCallToolOptions = {}
): StructuredToolInterface[] {
  return [
    tool(async (input) => {
      const { managedCalls, threadId } = requireManagedCallContext(options)
      return managedCalls.read({
        callId: input.call_id,
        threadId
      })
    }, {
      name: 'read_call',
      description: 'Read background call status without waiting. Pass call_id for one exact call, or omit it to list every call in this conversation that still requires attention. Output content is available through read_call_output.',
      schema: z.object({
        summary: toolSummarySchema,
        call_id: z.string().uuid().optional().describe('Exact background call ID. Omit to list all calls in this conversation that still require attention.')
      })
    }),
    tool(async (input) => {
      const { managedCalls, threadId } = requireManagedCallContext(options)
      const output = managedCalls.readOutput({
        callId: input.call_id,
        threadId,
        offset: input.output_offset,
        length: input.output_length
      })
      const result = input.output_offset === 0 ? await managedCalls.readResult(input.call_id, threadId) : undefined
      const nonText = result && Array.isArray(result.content)
        ? result.content.filter((block) => typeof block !== 'string' && block.type !== 'text') : []
      return [nonText.length ? [{ type: 'text' as const, text: output }, ...nonText] : output, result?.artifact]
    }, {
      name: 'read_call_output',
      responseFormat: 'content_and_artifact',
      description: 'Read one exact character range from the complete persisted output of a background call without waiting. Offset 0 also returns any completed image/resource artifacts. Range reads do not affect call health or completion.',
      schema: z.object({
        summary: toolSummarySchema,
        call_id: z.string().uuid().describe('Exact background call ID.'),
        output_offset: z.number().int().describe('Zero-based character offset from the start. Use a negative value to start relative to the current end, such as -100 for the final 100 characters.'),
        output_length: z.number().int().min(1).max(10_000).describe('Maximum number of characters to return, from 1 through 10000.')
      })
    }),
    tool(async (input) => {
      const { managedCalls, threadId } = requireManagedCallContext(options)
      return managedCalls.wait({
        callId: input.call_id,
        threadId,
        timeoutMs: typeof input.timeout === 'number' ? Math.round(input.timeout * 1000) : undefined,
        signal: options.signal
      })
    }, {
      name: 'wait_call',
      description: 'Wait for one background call until it reaches a terminal state or the requested timeout expires. New output never wakes the wait. The response always includes the current total output size and progress counters; use read_call_output only when details are needed.',
      schema: z.object({
        summary: toolSummarySchema,
        call_id: z.string().uuid().describe('Exact background call ID.'),
        timeout: z.number().int().min(10).max(300).optional().describe('Maximum wait in seconds. Default 30; range 10 through 300.')
      })
    }),
    tool(async (input) => {
      const { managedCalls, threadId } = requireManagedCallContext(options)
      return managedCalls.cancel(input.call_id, threadId)
    }, {
      name: 'cancel_call',
      description: 'Request cancellation of one exact background tool call owned by this conversation. Cancellation is idempotent; remote effects may remain uncertain.',
      schema: z.object({
        summary: toolSummarySchema,
        call_id: z.string().uuid().describe('Exact background call ID to cancel.')
      })
    })
  ]
}

export async function createRuntimeTools(options: RuntimeToolOptions): Promise<StructuredToolInterface[]> {
  if (!options.enabled) return []
  const tools: StructuredToolInterface[] = []
  const selectedToolNames = options.toolNames ? new Set(options.toolNames) : undefined
  const includesTool = (name: string) => !selectedToolNames || selectedToolNames.has(name)
  if (includesTool('request_user_input')) tools.push(tool(async (input, config) => {
    if (!options.threadId || !options.runId || !options.userInputSource) throw new Error('User input requires an active agent run and its source.')
    const signals = [options.signal, config?.signal].filter((signal): signal is AbortSignal => Boolean(signal))
    return JSON.stringify(await userInputService.request(input, {
      threadId: options.threadId, runId: options.runId,
      source: await options.userInputSource(),
      signal: signals.length ? AbortSignal.any(signals) : undefined
    }))
  }, {
    name: 'request_user_input',
    description: 'Ask the user to choose options or enter an Other answer in a dialog. Returns answered, cancelled, or timed_out. This tool waits inline and never becomes a background call. Default answer timeout is 60 seconds; timeout_seconds allows 30–600 seconds. User interaction cancels the timeout so they can finish answering. Use require_response=true cautiously, only when an answer is essential to continue. After timeout or cancellation, continue from known information or explain what is missing; do not immediately repeat the same question.',
    schema: userInputSchema
  }))
  const terminalEnabled = options.shell && includesTool(commandShellCapabilityId) && options.backgroundTools

  if (options.shell && includesTool(commandShellCapabilityId)) {
    const commandShell = options.commandShell ?? await getCommandShell()
    const toolName = commandShellToolName(commandShell.executable)
    tools.push(tool(async (input) => {
      if (!options.shellRunner) return JSON.stringify({ ok: false, error: `${toolName} is not connected to an executor.` })
      return options.shellRunner({
        command: input.command,
        summary: typeof input.summary === 'string' ? input.summary : undefined,
        timeoutSec: typeof input.timeout === 'number' ? input.timeout : undefined,
        workingDir: typeof input.working_dir === 'string' ? input.working_dir : undefined,
        keepProcesses: input.keep_processes === true,
        ...(input.pty ? { pty: terminalSizeSchema.parse(input.pty) } : {})
      })
    }, {
      name: toolName,
      description: `${describeCommandShellTool(commandShell)} Use the current shell's syntax for pipes and redirection. ${terminalEnabled
        ? 'For commands that require interactive input, explicitly request pty at launch; use write_call for subsequent input. A non-PTY process cannot be converted into an interactive terminal later.'
        : 'Interactive terminal input is unavailable. Use non-interactive command options or supply required input within the command. You cannot send follow-up input or attach a PTY after launch. Non-interactive mode does not guarantee completion; a command may still wait indefinitely until the user stops it.'} OMIT timeout for normal commands; expected long duration is not a reason to set one. Only provide timeout when the user explicitly requests a finite deadline or a known external deadline must be enforced. Child processes are cleaned up by default; set keep_processes to true for commands that launch an application, service, daemon, or any other process that must keep running after the command returns.`,
      metadata: commandShellMetadata(),
      schema: z.object({
        ...(terminalEnabled ? { pty: terminalSizeSchema.optional().describe('Explicitly allocate a PTY for a CLI that needs terminal input. stdout/stderr are merged UTF-8 terminal text, including control sequences. Use read_call to obtain terminal_id, then write_call; cannot combine with keep_processes. Omit for ordinary commands.') } : {}),
        command: z.string().refine(value => value.trim().length > 0, 'command must contain non-whitespace text.').describe(describeCommandShellArgument(commandShell)),
        summary: toolSummarySchema,
        timeout: z.number().int().min(0).max(maxCommandTimeoutSeconds).optional().describe('Exceptional hard execution deadline in seconds. OMIT for normal commands; omission means no time limit. NEVER infer or add a timeout merely because a command may take a long time. Supply a positive value only for an explicitly requested or externally required finite deadline. Use 0 only to explicitly request no limit.'),
        working_dir: z.string().optional().describe('Execution directory, absolute or relative to the primary/default folder. Defaults to that folder.'),
        keep_processes: z.boolean().optional().describe('Keep child processes running after a successful command. Defaults to false, which cleans up every remaining child process. MUST be true for commands that launch an application, service, daemon, or any other process that must continue running after the shell command returns. Failures, cancellation, and timeouts always clean up child processes.')
      }).superRefine((input, context) => {
        if (input.pty && input.keep_processes) context.addIssue({ code: z.ZodIssueCode.custom,
          path: ['keep_processes'], message: 'PTY execution cannot keep processes after completion. Omit keep_processes or set it to false.' })
      })
    }))
  }

  if (terminalEnabled || (options.backgroundTools && options.interactiveCustomTools)) {
    tools.push(tool(async (input) => {
      options.signal?.throwIfAborted()
      const { managedCalls, threadId } = requireManagedCallContext(options)
      if (!managedCalls.writeTerminal) throw new Error('Terminal input is not connected to an executor.')
      return managedCalls.writeTerminal(input.call_id, threadId, input.terminal_id, input.action)
    }, {
      name: 'write_call',
      description: 'Send input or resize an exact live PTY owned by this conversation. Obtain terminal_id from read_call, never guess or reuse a replaced terminal. Text is literal (add enter explicitly); keys/EOF can execute pending commands and require the current Shell approval policy. EOF sends Ctrl+D on POSIX or Ctrl+Z then Enter on Windows, not a guaranteed half-close in raw-mode CLIs. Ctrl+C interrupts the foreground command; use cancel_call to stop the whole session. Input acceptance does not mean completion. Output remains in read_call_output. Input is bounded to 16000 characters per call and cumulatively 1 MiB/4096 writes per session; use files for bulk data.',
      schema: z.object({ summary: toolSummarySchema, call_id: z.string().uuid(), terminal_id: z.string().uuid(), action: terminalActionSchema })
    }))
  }

  if (options.network && includesTool('http_request')) {
    tools.push(createHttpRequestTool({
      primaryFolder: options.primaryFolder,
      signal: options.signal
    }))
  }

  // Preview and execution must advertise the same definitions. The service and
  // conversation binding are required only when a tool is actually invoked.
  if (options.backgroundTools || options.managedCallSupervision) {
    tools.push(...createManagedCallTools(options))
  }

  if (options.configuration) {
    tools.push(...createConfigTools(options.primaryFolder))
  }

  if (options.memory) {
    if (!options.memoryStore || !options.projectId) {
      throw new Error('Memory tools require a connected store and project.')
    }
    const memoryStore = options.memoryStore
    const searchAccessibleMemories = async (input: {
      query?: string
      scope?: 'all' | 'global' | 'project'
      kind?: 'all' | 'preference' | 'fact' | 'experience'
      limit?: number
    }) => {
      const scope = input.scope ?? 'all'
      const limit = input.limit ?? 10
      if (scope !== 'all') {
        return memoryStore.searchMemories({
          query: input.query,
          scope,
          ...(scope === 'project' ? { projectId: options.projectId } : {}),
          kind: input.kind,
          limit
        })
      }
      const [global, project] = await Promise.all([
        memoryStore.searchMemories({ query: input.query, scope: 'global', kind: input.kind, limit }),
        memoryStore.searchMemories({
          query: input.query,
          scope: 'project',
          projectId: options.projectId,
          kind: input.kind,
          limit
        })
      ])
      const items = [...global.items, ...project.items]
        .sort((left, right) => {
          const score = (right.score ?? 0) - (left.score ?? 0)
          return score !== 0 ? score : right.updatedAt.localeCompare(left.updatedAt)
        })
        .slice(0, limit)
      return { items, total: global.total + project.total }
    }
    if (includesTool('read_memory')) tools.push(tool(async (input) => {
      return JSON.stringify({ ok: true, ...await searchAccessibleMemories(input) })
    }, {
      name: 'read_memory',
      description: 'Search or list durable memory records available to the current project. Use a focused query when looking for prior preferences, facts, or experience.',
      schema: z.object({
        summary: toolSummarySchema,
        query: z.string().max(2_000).optional().describe('Optional text query. Omit to list the most recently updated records.'),
        scope: z.enum(['all', 'global', 'project']).optional().describe('Search global records, current-project records, or both. Default both.'),
        kind: z.enum(['all', 'preference', 'fact', 'experience']).optional().describe('Optional record kind filter.'),
        limit: z.number().int().min(1).max(50).optional().describe('Maximum records to return. Default 10.')
      })
    }))

    if (includesTool('save_to_memory')) {
      tools.push(tool(async (input) => {
        const id = input.memory_id ?? currentAgentToolEffectArtifactId('memory-record')
        if (!id) throw new Error('Memory writes require a durable tool-effect identity.')
        armCurrentAgentToolEffect({
          kind: 'memory_write',
          target: { id },
          recoveryMode: 'idempotent'
        })
        const memory = await memoryStore.saveMemory({
          ...(input.memory_id ? { id: input.memory_id } : {}),
          scope: input.scope,
          ...(input.scope === 'project' ? { projectId: options.projectId } : {}),
          kind: input.kind,
          content: input.content,
          keywords: input.keywords,
          importance: input.importance
        }, {
          accessProjectId: options.projectId,
          origin: 'agent',
          newId: id,
          sourceThreadId: options.threadId,
          sourceRunId: options.runId
        })
        return JSON.stringify({ ok: true, memory })
      }, {
        name: 'save_to_memory',
        description: 'Create a durable memory record, or update one by memory_id. Prefer revising an existing record over creating duplicates.',
        schema: z.object({
          summary: toolSummarySchema,
          memory_id: z.string().uuid().optional().describe('Existing record ID to update. Omit only when creating a new record.'),
          scope: z.enum(['global', 'project']).describe('Global applies across projects; project applies only to the current project.'),
          kind: z.enum(['preference', 'fact', 'experience']).describe('The kind of durable context being stored.'),
          content: z.string().min(1).max(12_000).describe('Concise, self-contained memory content.'),
          keywords: z.array(z.string().min(1).max(64)).max(20).default([]).describe('Short search terms, names, or identifiers that improve retrieval.'),
          importance: z.number().int().min(1).max(5).default(3).describe('Retrieval importance from 1 (low) to 5 (high).')
        })
      }))
    }

    if (includesTool('forget_memory')) {
      tools.push(tool(async (input) => {
        armCurrentAgentToolEffect({
          kind: 'memory_delete',
          target: { id: input.memory_id },
          recoveryMode: 'idempotent'
        })
        await memoryStore.deleteMemory(input.memory_id, options.projectId)
        return JSON.stringify({ ok: true, memory_id: input.memory_id })
      }, {
        name: 'forget_memory',
        description: 'Permanently delete a durable memory record by ID when the user asks to forget it or the record is known to be stale.',
        schema: z.object({
          summary: toolSummarySchema,
          memory_id: z.string().uuid().describe('The exact memory record ID to delete. Search memory first if needed.')
        })
      }))
    }
  }

  if (options.mcp) tools.push(...(options.mcpTools ?? []))
  return tools
}
