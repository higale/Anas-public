import { appendFileSync } from 'node:fs'
import { HumanMessage, ToolMessage } from '@langchain/core/messages'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { Command, END, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph'
import { createDeepAgent } from 'deepagents'
import { createAgent, FakeToolCallingModel } from 'langchain'
import { z } from 'zod/v3'
import { commandShellMetadata } from '@shared/commandShell'
import { FileEditStore } from '../fileEditStore'
import { createFileTools } from '../llm/fileTools'
import {
  AgentDatabase,
  type AgentToolEffectKey,
  type AgentToolEffectPreparation,
  type AgentToolEffectResultInput,
  type AgentToolEffectRow
} from './agentDatabase'
import { createAgentToolEffectMiddleware } from './toolEffectMiddleware'
import { armCurrentAgentToolEffect } from './toolEffectScope'

export const toolEffectHardCrashExitCode = 83
const commandShellFixtureName = 'pwsh'

export type ToolEffectHardCrashScenario =
  | 'single'
  | 'parallel'
  | 'nested'
  | 'host_file_hitl'
  | 'file_write'
  | 'file_write_content'
  | 'file_replace'
  | 'file_restore_existing'
  | 'file_restore_created'

export type ToolEffectHardCrashFault =
  | 'none'
  | 'before_prepare'
  | 'after_prepare'
  | 'after_arm'
  | 'after_effect'
  | 'after_result'
  | 'after_pending_write'
  | 'parallel_result_pending_sibling_intent'
  | 'patch_before_metadata'
  | 'patch_before_postimage'
  | 'patch_after_partial'
  | 'patch_after_applied'
  | 'patch_after_finalized'
  | 'patch_before_history'
  | 'patch_after_history'

export type ToolEffectHardCrashInvocation =
  | 'initial'
  | 'continue'
  | 'approve'
  | 'reject'

export interface ToolEffectHardCrashFileOptions {
  databaseFile: string
  attachmentsDirectory: string
  threadId: string
  runId: string
  scenario: ToolEffectHardCrashScenario
  invocation: ToolEffectHardCrashInvocation
  fault: ToolEffectHardCrashFault
  effectLogFile: string
  traceLogFile: string
  viteCacheDirectory: string
  fileEditRecordsDirectory: string
  fileWorkspaceDirectory: string
  faultToolName?: string
  resumeInterruptId?: string
  restoreOperationId?: string
  restoreRequestId?: string
}

interface ToolEffectHardCrashOptions extends Omit<
  ToolEffectHardCrashFileOptions,
  'databaseFile' | 'attachmentsDirectory' | 'viteCacheDirectory'
> {
  database: AgentDatabase
}

interface JournalTrace {
  event: string
  toolName: string
  runId: string
  checkpointId: string
  checkpointNs: string
  writeCheckpointNs?: string
  taskId: string
  callKey: string
  inputHash: string
}

function trace(
  options: ToolEffectHardCrashOptions,
  event: string,
  input: AgentToolEffectPreparation | AgentToolEffectRow | AgentToolEffectKey,
  toolName?: string
): void {
  const value = input as Partial<AgentToolEffectPreparation>
  const row: JournalTrace = {
    event,
    toolName: toolName ?? value.toolName ?? '',
    runId: input.runId,
    checkpointId: input.checkpointId,
    checkpointNs: input.checkpointNs,
    ...(value.writeCheckpointNs === undefined
      ? {}
      : { writeCheckpointNs: value.writeCheckpointNs }),
    taskId: input.taskId,
    callKey: input.callKey,
    inputHash: input.inputHash
  }
  appendFileSync(options.traceLogFile, `${JSON.stringify(row)}\n`, 'utf8')
}

function crash(): never {
  process.exit(toolEffectHardCrashExitCode)
}

function selectedTool(options: ToolEffectHardCrashOptions, toolName: string): boolean {
  const defaultToolName = options.scenario === 'host_file_hitl'
    ? 'delete_file'
    : options.scenario === 'file_write_content'
      ? 'write_file'
    : options.scenario === 'file_write'
      ? 'apply_patch'
    : options.scenario === 'file_replace'
      ? 'apply_patch'
      : options.scenario === 'file_restore_existing'
        || options.scenario === 'file_restore_created'
        ? 'restore_file_edit'
        : commandShellFixtureName
  return toolName === (options.faultToolName ?? defaultToolName)
}

function createFaultFileEditStore(options: ToolEffectHardCrashOptions): FileEditStore {
  const store = new FileEditStore(options.fileEditRecordsDirectory)
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, target)
      if (property === 'writeManagedText') {
        return async (requestId: string, operationId: string, name: string, text: string, replace: boolean) => {
          if (name !== 'record.json') return value.call(receiver, requestId, operationId, name, text, replace)
          const record = JSON.parse(text)
          const applied = record.transaction.entries.every((entry: { state: string }) => entry.state === 'applied')
          const partial = record.transaction.entries.some((entry: { state: string }) => entry.state === 'applied')
          const selected = requestId === options.runId
          if (selected && record.revision === 0 && options.fault === 'patch_before_metadata') crash()
          if (selected && partial && options.fault === 'patch_before_postimage') crash()
          await value.call(receiver, requestId, operationId, name, text, replace)
          appendFileSync(options.traceLogFile, JSON.stringify({ event: 'patch:saved', operationId, effectState: record.transaction.state }) + '\n')
          if (selected && options.fault === 'patch_after_partial' && partial && !applied) crash()
          if (selected && options.fault === 'patch_after_applied' && record.transaction.state === 'applied') crash()
          if (options.fault === 'patch_after_finalized' && record.transaction.recovery?.state === 'complete') crash()
        }
      }
      return typeof value === 'function' ? value.bind(receiver) : value
    }
  })
}

function containsToolResult(
  writes: Parameters<AgentDatabase['checkpointer']['putWrites']>[1]
): boolean {
  return writes.some(([channel, value]) => (
    channel === 'messages'
    && (
      ToolMessage.isInstance(value)
      || (Array.isArray(value) && value.some((item) => ToolMessage.isInstance(item)))
    )
  ))
}

function createFaultDatabase(
  options: ToolEffectHardCrashOptions,
  onShellResultStored: () => void
): AgentDatabase {
  const database = options.database
  const targetTaskIds = new Set<string>()
  const taskIdsByTool = new Map<string, string>()
  const originalPutWrites = database.checkpointer.putWrites.bind(database.checkpointer)

  if (
    options.fault === 'after_pending_write'
    || options.fault === 'parallel_result_pending_sibling_intent'
  ) {
    database.checkpointer.putWrites = async (config, writes, taskId) => {
      if (
        options.fault === 'parallel_result_pending_sibling_intent'
        && taskIdsByTool.get(commandShellFixtureName) === taskId
        && containsToolResult(writes)
      ) {
        appendFileSync(options.traceLogFile, `${JSON.stringify({
          event: 'pending_write:blocked',
          taskId,
          checkpointId: config.configurable?.checkpoint_id,
          checkpointNs: config.configurable?.checkpoint_ns
        })}\n`, 'utf8')
        await new Promise<never>(() => undefined)
      }
      const result = await originalPutWrites(config, writes, taskId)
      if (targetTaskIds.has(taskId) && containsToolResult(writes)) {
        appendFileSync(options.traceLogFile, `${JSON.stringify({
          event: 'pending_write:after',
          taskId,
          checkpointId: config.configurable?.checkpoint_id,
          checkpointNs: config.configurable?.checkpoint_ns
        })}\n`, 'utf8')
        crash()
      }
      return result
    }
  }

  return new Proxy(database, {
    get(target, property) {
      if (property === 'fileChanges') return new Proxy(target.fileChanges, {
        get(ledger, member) {
          if (member === 'persist') return (...args: Parameters<typeof ledger.persist>) => {
            const partial = args[0].transaction.entries.some((entry) => entry.state === 'applied')
            if (partial && options.fault === 'patch_before_history') crash()
            ledger.persist(...args)
            if (partial && options.fault === 'patch_after_history') crash()
          }
          const value = Reflect.get(ledger, member, ledger) as unknown
          return typeof value === 'function' ? value.bind(ledger) : value
        }
      })
      if (property === 'prepareToolEffect') {
        return (input: AgentToolEffectPreparation): AgentToolEffectRow => {
          trace(options, 'prepare:before', input)
          if (selectedTool(options, input.toolName)) {
            targetTaskIds.add(input.taskId)
            if (options.fault === 'before_prepare') crash()
          }
          taskIdsByTool.set(input.toolName, input.taskId)
          const row = target.prepareToolEffect(input)
          trace(options, 'prepare:after', row)
          if (selectedTool(options, input.toolName) && options.fault === 'after_prepare') crash()
          return row
        }
      }
      if (property === 'armToolEffect') {
        return (...args: Parameters<AgentDatabase['armToolEffect']>): AgentToolEffectRow => {
          const row = target.armToolEffect(...args)
          trace(options, 'arm:after', row)
          if (
            options.fault === 'parallel_result_pending_sibling_intent'
            && row.toolName === 'save_to_memory'
          ) crash()
          if (selectedTool(options, row.toolName) && options.fault === 'after_arm') crash()
          return row
        }
      }
      if (property === 'storeToolEffectResult') {
        return async (
          key: AgentToolEffectKey,
          result: AgentToolEffectResultInput
        ): Promise<AgentToolEffectRow> => {
          const row = await target.storeToolEffectResult(key, result)
          trace(options, 'result:after', row)
          if (row.toolName === commandShellFixtureName) onShellResultStored()
          if (selectedTool(options, row.toolName) && options.fault === 'after_result') crash()
          return row
        }
      }
      const value = Reflect.get(target, property, target) as unknown
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

function effectTool(
  options: ToolEffectHardCrashOptions,
  name: string,
  label: string,
  beforeEffect?: Promise<void>
): StructuredToolInterface {
  return tool(async () => {
    if (beforeEffect) await beforeEffect
    armCurrentAgentToolEffect({
      kind: 'hard_crash_fixture',
      target: { label }
    })
    appendFileSync(options.effectLogFile, `${label}\n`, 'utf8')
    if (selectedTool(options, name) && options.fault === 'after_effect') crash()
    return `${label}:completed`
  }, {
    name,
    description: `Execute the ${label} crash-recovery fixture effect.`,
    ...(name === commandShellFixtureName ? { metadata: commandShellMetadata() } : {}),
    schema: z.object({})
  })
}

function hostFileEffectTool(options: ToolEffectHardCrashOptions): StructuredToolInterface {
  return tool(async ({ path }) => {
    armCurrentAgentToolEffect({
      kind: 'hard_crash_fixture_host_file',
      target: { path }
    })
    appendFileSync(options.effectLogFile, `host-file:${path}\n`, 'utf8')
    if (selectedTool(options, 'delete_file') && options.fault === 'after_effect') crash()
    return `host-file:${path}:completed`
  }, {
    name: 'delete_file',
    description: 'Execute the host-file approval crash-recovery fixture effect.',
    schema: z.object({ path: z.string() })
  })
}

function isFileEditScenario(
  scenario: ToolEffectHardCrashScenario
): scenario is 'file_write' | 'file_write_content' | 'file_replace' | 'file_restore_existing' | 'file_restore_created' {
  return scenario === 'file_write'
    || scenario === 'file_write_content'
    || scenario === 'file_replace'
    || scenario === 'file_restore_existing'
    || scenario === 'file_restore_created'
}

function fileEditToolName(
  scenario: 'file_write' | 'file_write_content' | 'file_replace' | 'file_restore_existing' | 'file_restore_created'
): 'apply_patch' | 'write_file' | 'restore_file_edit' {
  if (scenario === 'file_write_content') return 'write_file'
  if (scenario === 'file_write') return 'apply_patch'
  if (scenario === 'file_replace') return 'apply_patch'
  return 'restore_file_edit'
}

function initialToolCalls(
  options: ToolEffectHardCrashOptions
): Array<{ id: string; name: string; args: Record<string, unknown> }> {
  const { scenario } = options
  if (scenario === 'parallel') {
    return [
      { id: 'left-call', name: commandShellFixtureName, args: {} },
      { id: 'right-call', name: 'save_to_memory', args: {} }
    ]
  }
  if (scenario === 'host_file_hitl') {
    return [{
      id: 'hitl-call',
      name: 'delete_file',
      args: { path: '/host/outside-workspace/fixture.txt' }
    }]
  }
  if (scenario === 'file_write_content') {
    return [{ id: 'write-content', name: 'write_file', args: { path: 'target.txt', content: 'write after\n', overwrite: true, summary: 'Replace complete content' } }]
  }
  if (scenario === 'file_write') {
    return [{
      id: 'file-edit-call',
      name: 'apply_patch',
      args: {
        summary: 'Write the crash recovery fixture',
        patch: [
          '*** Begin Patch',
          '*** Update File: target.txt',
          '@@',
          '-write before',
          '+write after',
          '*** Add File: second.txt',
          '+second',
          '*** End Patch'
        ].join('\n')
      }
    }]
  }
  if (scenario === 'file_replace') {
    return [{
      id: 'file-edit-call',
      name: 'apply_patch',
      args: {
        summary: 'Replace the crash recovery fixture',
        patch: [
          '*** Begin Patch',
          '*** Update File: target.txt',
          '@@',
          '-replace before value',
          '+replace after value',
          '*** Add File: second.txt',
          '+second',
          '*** End Patch'
        ].join('\n')
      }
    }]
  }
  if (scenario === 'file_restore_existing' || scenario === 'file_restore_created') {
    if (!options.restoreOperationId || !options.restoreRequestId) {
      throw new Error('File restore crash fixtures require an operation and origin request ID.')
    }
    return [{
      id: 'file-restore-call',
      name: 'restore_file_edit',
      args: {
        summary: 'Restore the crash recovery fixture',
        operation_id: options.restoreOperationId,
        request_id: options.restoreRequestId
      }
    }]
  }
  return [{ id: 'single-call', name: commandShellFixtureName, args: {} }]
}

function invocationInput(options: ToolEffectHardCrashOptions): unknown {
  if (options.invocation === 'initial') {
    return { messages: [new HumanMessage('Run the durable effect fixture.')] }
  }
  if (options.invocation === 'continue') return null
  const response = options.invocation === 'approve'
    ? { decisions: [{ type: 'approve' }] }
    : {
        decisions: [{
          type: 'reject',
          message: 'Do not repeat the uncertain operation.'
        }]
      }
  if (!options.resumeInterruptId) {
    throw new Error('Approval and rejection fixtures require a durable interrupt ID.')
  }
  return new Command({
    resume: { [options.resumeInterruptId]: response }
  })
}

export async function runToolEffectHardCrashHarness(
  options: ToolEffectHardCrashOptions
): Promise<unknown> {
  let shellResultStored!: () => void
  // Coordinate the mixed-state crash fixture at the durable result boundary.
  const shellResult = new Promise<void>((resolve) => { shellResultStored = resolve })
  const database = createFaultDatabase(options, shellResultStored)
  const calls = initialToolCalls(options)
  const tools = isFileEditScenario(options.scenario)
    ? createFileTools({ maxReadBytes: 1_000_000,
        primaryFolder: options.fileWorkspaceDirectory,
        requestId: options.runId,
        fileEditStore: createFaultFileEditStore(options),
        authorizePatch: async () => {},
        toolNames: [fileEditToolName(options.scenario)]
      })
    : options.scenario === 'parallel'
      ? [
          effectTool(options, commandShellFixtureName, 'left'),
          effectTool(options, 'save_to_memory', 'right',
            options.fault === 'parallel_result_pending_sibling_intent' ? shellResult : undefined)
        ]
      : options.scenario === 'host_file_hitl'
        ? [hostFileEffectTool(options)]
        : [effectTool(options, commandShellFixtureName, options.scenario === 'nested' ? 'child' : 'single')]
  const model = new FakeToolCallingModel({
    toolCalls: options.invocation === 'initial' ? [calls, []] : [[]]
  })
  const middleware = createAgentToolEffectMiddleware({
    database,
    runId: options.runId,
    threadId: options.threadId,
    tools
  })
  const config = {
    configurable: { thread_id: options.threadId },
    durability: 'sync' as const
  }
  const input = invocationInput(options)

  if (options.scenario === 'host_file_hitl') {
    const agent = createDeepAgent({
      name: 'hard-crash-host-file-fixture',
      model,
      tools,
      systemPrompt: { base: 'Execute the requested hard-crash fixture tool.' },
      checkpointer: database.checkpointer,
      interruptOn: {
        delete_file: {
          allowedDecisions: ['approve', 'reject'],
          description: 'Access a host file path outside the project folders.'
        }
      },
      middleware: [middleware]
    })
    return agent.invoke(input as Parameters<typeof agent.invoke>[0], config)
  }

  const agent = createAgent({
    model,
    tools,
    ...(options.scenario === 'nested' ? {} : { checkpointer: database.checkpointer }),
    middleware: [middleware]
  })

  if (options.scenario !== 'nested') {
    return agent.invoke(input as Parameters<typeof agent.invoke>[0], config)
  }

  const parent = new StateGraph(MessagesAnnotation)
    .addNode('child_agent', agent.graph)
    .addEdge(START, 'child_agent')
    .addEdge('child_agent', END)
    .compile({ checkpointer: database.checkpointer })
  return parent.invoke(input as Parameters<typeof parent.invoke>[0], config)
}

export async function runToolEffectHardCrashHarnessFromFile(
  options: ToolEffectHardCrashFileOptions
): Promise<unknown> {
  const database = AgentDatabase.open(
    options.databaseFile,
    options.attachmentsDirectory
  )
  try {
    return await runToolEffectHardCrashHarness({ ...options, database })
  } finally {
    database.close()
  }
}
