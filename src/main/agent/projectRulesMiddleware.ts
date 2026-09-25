import { randomUUID } from 'node:crypto'
import { AIMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'
import { interrupt } from '@langchain/langgraph'
import { createMiddleware } from 'langchain'
import { z } from 'zod'
import { projectRuleInputBudget } from '@shared/contextWindow'
import type { AgentAccessMode } from '@shared/agentTypes'
import type { FileEditStore } from '../fileEditStore'
import { isSameOrInsideDirectory } from '../pathContainment'
import { countMessagesApproximately, type LocalTokenCountingOptions } from './localTokenCounting'
import { modelResponseMessages } from './modelResponseMessages'
import { latestUserInputMessages } from './messageMapper'
import { prepareToolPathAuthorization } from './toolAuthorization'
import { toolPathArguments } from './toolPathArguments'
import { pendingModelToolCalls } from './toolInputErrors'
import {
  createProjectRulesSnapshot, discoverProjectRules, mutationDirectories,
  ProjectRulesError, ProjectRulesRequestBudgetError, projectRulesSchema, projectRulesText, ruleScopeIds, projectRuleTargetDirectory, isProjectRulesError,
  type ProjectRulesReader, type ProjectRulesSnapshot
} from './projectRules'

const receiptKey = 'anas_project_rules_receipt'
const receiptSchema = z.object({ runId: z.string(), scopes: z.array(z.string()), minimumTokens: z.number(), budget: z.number() })
const stateSchema = z.object({ anasProjectRules: projectRulesSchema.optional() })

export interface ProjectRulesOptions {
  runId?: string
  folders: string[]
  primaryFolder: string
  getInputCapacityTokens(): number
  getModelTokenCountingOptions(): LocalTokenCountingOptions
  responseTools?: Record<string, unknown>[]
  accessMode(): AgentAccessMode
  signal?: AbortSignal
  allowInterrupts?: boolean
  fileEditStore?: Pick<FileEditStore, 'loadOperationRecord'>
}

function snapshotFrom(state: unknown): ProjectRulesSnapshot | undefined {
  return (state as { anasProjectRules?: ProjectRulesSnapshot })?.anasProjectRules
}

export function checkpointProjectRulesText(state: unknown): string {
  const snapshot = snapshotFrom(state)
  return snapshot ? projectRulesText(snapshot) : ''
}

function ruleTokens(snapshot: ProjectRulesSnapshot, scopes: string[]): number {
  const text = projectRulesText(snapshot, scopes)
  return text ? countMessagesApproximately([new SystemMessage(text)]) : 0
}

export function createProjectRulesMiddleware(options: ProjectRulesOptions) {
  const runId = options.runId ?? randomUUID()
  const reader = (snapshot: ProjectRulesSnapshot): ProjectRulesReader => ({
    signal: options.signal,
    authorizeRead: async (path) => {
      if (options.accessMode() !== 'strict_approval' || snapshot.trustedFolders.some((folder) => isSameOrInsideDirectory(folder, path))) return
      if (options.allowInterrupts === false) throw new ProjectRulesError(`Rules outside project folders need read approval and cannot be included in this preview: ${path}.`)
      // Reuse the framework's approval protocol for external reads, not for
      // discovering that a write needs new context.
      const response = interrupt({
        actionRequests: [{ name: 'read_file', args: { path }, description: `Read project rules: ${path}` }],
        reviewConfigs: [{ actionName: 'read_file', allowedDecisions: ['approve', 'reject'] }]
      }) as { decisions?: Array<{ type: string }> }
      if (response.decisions?.length !== 1 || response.decisions[0].type !== 'approve') {
        throw new ProjectRulesError(`Reading required rules was not approved: ${path}.`)
      }
    }
  })
  const middleware = createMiddleware({
    name: 'AnasProjectRulesMiddleware',
    stateSchema,
    beforeModel: async (state) => {
      if (state.anasProjectRules?.runId === runId) {
        if (state.anasProjectRules.fatalError) throw new ProjectRulesError(state.anasProjectRules.fatalError)
        return
      }
      const snapshot = await createProjectRulesSnapshot(runId, options.folders, options.signal)
      try {
        for (const root of [...snapshot.roots]) {
          const scopes = await discoverProjectRules(snapshot, root.folder, reader(snapshot))
          // Freeze every source root, but initially project only the primary
          // cwd's chain. Other roots become active when a tool targets them.
          if (snapshot.initialScopes.length === 0) snapshot.initialScopes = scopes
        }
        snapshot.initialScopes = [...new Set(snapshot.initialScopes)]
        snapshot.activeScopes = snapshot.initialScopes
      } catch (error) {
        if (!isProjectRulesError(error)) throw error
        snapshot.fatalError = String(error)
      }
      return { anasProjectRules: snapshot }
    },
    wrapModelCall: async (request, handler) => {
      const budget = projectRuleInputBudget(options.getInputCapacityTokens())
      const snapshot = request.state.anasProjectRules
      if (!snapshot || snapshot.runId !== runId) throw new ProjectRulesError('The current run has no rule snapshot.')
      if (snapshot.fatalError) throw new ProjectRulesError(snapshot.fatalError)
      const text = projectRulesText(snapshot)
      const systemMessage = text ? request.systemMessage.concat(`\n\n${text}`) : request.systemMessage
      const task = latestUserInputMessages(request.messages)
      const minimum = countMessagesApproximately(
        [systemMessage, ...task], request.tools as unknown as Record<string, unknown>[],
        options.getModelTokenCountingOptions()
      )
      if (minimum > budget) throw new ProjectRulesError(`Rules for ${snapshot.activeScopes.join(', ')} plus system instructions, tools and required task context need about ${minimum} input tokens; safe capacity is ${budget}.`)
      return handler({ ...request, systemMessage })
    },
    afterModel: async (state) => {
      const { message: last, calls: pending, answered } = pendingModelToolCalls(state.messages)
      if (!last || !pending.length) return
      const snapshot = structuredClone(state.anasProjectRules)
      if (!snapshot || snapshot.runId !== runId) throw new ProjectRulesError('Missing rule snapshot before tool dispatch.')
      if (snapshot.fatalError) throw new ProjectRulesError(snapshot.fatalError)
      try {
        const parsedReceipt = receiptSchema.safeParse(last.additional_kwargs[receiptKey])
        if (!parsedReceipt.success || parsedReceipt.data.runId !== runId) throw new ProjectRulesError('Missing verified model-request rule receipt.')
        const receipt = parsedReceipt.data
        const budget = receipt.budget
        const calls = structuredClone(last.tool_calls!)
        const writes: Array<{ id: string; scopes: string[] }> = []
        snapshot.checkedWrites = []
        snapshot.rejectedCalls = []
        const active = new Set<string>()
        for (const call of calls) {
          if (answered.has(call.id!)) continue
          // Patch paths live in parsed text. Let shared preflight parse them and
          // retain its actionable syntax diagnostics instead of treating a
          // malformed patch as a missing JSON path property.
          if (call.name !== 'apply_patch') {
            const arguments_ = toolPathArguments(call.name, call.args)
            if (!arguments_ || arguments_.some((argument) => typeof argument.value !== 'string' || !argument.value.trim())) {
              snapshot.rejectedCalls.push({ id: call.id!, reason: 'NOT EXECUTED: Invalid file path arguments. Correct the arguments and decide again.' })
              continue
            }
            if (!arguments_.length && call.name !== 'restore_file_edit') continue
          }
          let prepared: Awaited<ReturnType<typeof prepareToolPathAuthorization>>
          try {
            prepared = await prepareToolPathAuthorization({
              toolName: call.name, args: call.args, primaryFolder: options.primaryFolder,
              trustedFolders: options.folders, accessMode: options.accessMode(), requestId: options.runId, fileEditStore: options.fileEditStore
            })
          } catch (error) {
            snapshot.rejectedCalls.push({ id: call.id!, reason: `NOT EXECUTED: Cannot resolve the file targets: ${String(error)}. Correct the paths and decide again.` })
            continue
          }
          const scopes = new Set<string>()
          const fileTargets = prepared.targets.filter((target) => !target.kind || target.kind === 'file')
          for (const target of fileTargets) {
            let directories = [await projectRuleTargetDirectory(target.canonicalPath)]
            if (target.access === 'write' && (call.name === 'delete_file' || call.name === 'move_file')) {
              directories = await mutationDirectories(target.canonicalPath,
                call.name === 'move_file' && target.locator[0] === 'source' ? String(call.args.destination) : undefined,
                reader(snapshot))
            } else if (call.name === 'create_directory') directories.push(target.canonicalPath)
            for (const directory of directories) {
              for (const scope of await discoverProjectRules(snapshot, directory, reader(snapshot))) {
                scopes.add(scope)
                active.add(scope)
              }
            }
          }
          const required = [...scopes]
          if (receipt.minimumTokens + ruleTokens(snapshot, required) > budget) {
            throw new ProjectRulesError(`The indivisible ${call.name} operation (${required.join(', ')}) cannot fit its complete rules and required context within ${budget} input tokens.`)
          }
          if (prepared.targets.some((target) => target.access === 'write')) {
            snapshot.checkedWrites.push({ id: call.id!, paths: fileTargets.map((target) => target.canonicalPath) })
            writes.push({ id: call.id!, scopes: required })
          }
        }
        const unionTooLarge = receipt.minimumTokens + ruleTokens(snapshot, [...active]) > budget
        const unseen = writes.some((write) => ruleScopeIds(snapshot, write.scopes).some((id) => !receipt.scopes.includes(id)))
        snapshot.blockedCalls = [...snapshot.rejectedCalls.map((call) => call.id), ...(unionTooLarge || unseen ? writes.map((write) => write.id) : [])]
        snapshot.blockedReason = unionTooLarge
          ? 'NOT EXECUTED: The complete rule union for this batch exceeds the request budget. Reduce the batch to independent operations with smaller scopes. Do not split an indivisible operation or bypass rules using shell.'
          : 'NOT EXECUTED: Newly discovered scoped project rules were not in the request that generated this batch. Read the complete rules in the next system context and decide again; no original write has been replayed.'
        snapshot.activeScopes = unionTooLarge || active.size === 0 ? snapshot.initialScopes : [...active]
        return { anasProjectRules: snapshot, messages: [new AIMessage({ ...last, tool_calls: calls })] }
      } catch (error) {
        if (!isProjectRulesError(error)) throw error
        // Commit the terminal decision before leaving the tools boundary. A
        // restored graph cannot reread changed disk rules to retry this batch.
        snapshot.fatalError = String(error)
        snapshot.blockedCalls = pending.map((call) => call.id!)
        snapshot.blockedReason = `NOT EXECUTED: ${snapshot.fatalError}`
        return { anasProjectRules: snapshot }
      }
    },
    wrapToolCall: async (request, handler) => {
      const snapshot = snapshotFrom(request.state)
      if (snapshot?.blockedCalls.includes(request.toolCall.id!)) {
        const reason = !snapshot.fatalError && snapshot.rejectedCalls.find((call) => call.id === request.toolCall.id)?.reason
        return new ToolMessage({ name: request.toolCall.name, tool_call_id: request.toolCall.id!, content: reason || snapshot.blockedReason, status: 'error' })
      }
      const checked = snapshot?.checkedWrites.find((call) => call.id === request.toolCall.id)
      if (checked) {
        const prepared = await prepareToolPathAuthorization({ toolName: request.toolCall.name,
          args: request.toolCall.args, primaryFolder: options.primaryFolder, trustedFolders: options.folders, accessMode: options.accessMode(),
          requestId: options.runId, fileEditStore: options.fileEditStore })
        if (JSON.stringify(prepared.targets.filter((target) => !target.kind || target.kind === 'file').map((target) => target.canonicalPath)) !== JSON.stringify(checked.paths)) {
          return new ToolMessage({ name: request.toolCall.name, tool_call_id: request.toolCall.id!, content: 'NOT EXECUTED: The resolved file targets changed after rule preflight. Inspect the current paths and decide again.', status: 'error' })
        }
      }
      const response = await handler(request)
      if (snapshot?.blockedReason.includes('rule union') && ToolMessage.isInstance(response)) {
        response.content = typeof response.content === 'string'
          ? `${response.content}\n\nRule context notice: ${snapshot.blockedReason}`
          : [...response.content, { type: 'text', text: `Rule context notice: ${snapshot.blockedReason}` }]
      }
      return response
    }
  })

  // Install inside compression and retry middleware: every actual model send,
  // including overflow recovery, receives a fresh completeness/budget check.
  const guard = createMiddleware({
    name: 'AnasProjectRulesRequestGuard',
    stateSchema,
    wrapModelCall: async (request, handler) => {
      const budget = projectRuleInputBudget(options.getInputCapacityTokens())
      const snapshot = request.state.anasProjectRules
      if (!snapshot) throw new ProjectRulesError('Missing rules at model boundary.')
      if (snapshot.fatalError) throw new ProjectRulesError(snapshot.fatalError)
      const text = projectRulesText(snapshot)
      if (text && !request.systemMessage.text.includes(text)) throw new ProjectRulesError('Complete project rules were removed from the final model request.')
      const tools = [...request.tools, ...(options.responseTools ?? [])] as unknown as Record<string, unknown>[]
      const tokenCountingOptions = options.getModelTokenCountingOptions()
      const total = countMessagesApproximately([request.systemMessage, ...request.messages], tools, tokenCountingOptions)
      if (total > budget) throw new ProjectRulesRequestBudgetError(total, budget)
      const task = latestUserInputMessages(request.messages)
      const withoutRules = text ? request.systemMessage.text.replace(`\n\n${text}`, '') : request.systemMessage.text
      const minimumTokens = countMessagesApproximately([new SystemMessage(withoutRules), ...task], tools, tokenCountingOptions)
      const response = await handler(request)
      for (const message of modelResponseMessages(response)) {
        message.additional_kwargs = { ...message.additional_kwargs, [receiptKey]: { runId, scopes: ruleScopeIds(snapshot), minimumTokens, budget } }
      }
      return response
    }
  })
  return { middleware, guard }
}
