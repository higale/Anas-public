import { listToolSnapshot } from '../toolsStore'
import { resolveToolSelection } from '@shared/toolPackages'
import { createCustomTools } from './customToolRuntime'
import { defaultSubagentSelection, selectedSubagents, type SubagentSelection } from '@shared/subagentSelection'
import { mkdir } from 'node:fs/promises'
import { currentToolExecution } from './toolExecutionContext'
import { withManagedToolExecution } from './managedToolExecution'
import { basename } from 'node:path'
import { AIMessage, BaseMessage, HumanMessage, SystemMessage } from '@langchain/core/messages'
import { isLangChainTool, type ClientTool, type ServerTool, type StructuredToolInterface } from '@langchain/core/tools'
import {
  createDeepAgent,
  getHarnessProfile,
  StateBackend,
  type BackendRuntime,
  type FileDownloadResponse,
  type WriteResult
} from 'deepagents'
import {
  createMiddleware,
  anthropicPromptCachingMiddleware,
  modelCallLimitMiddleware,
  todoListMiddleware,
  type InterruptOnConfig
} from 'langchain'
import type { AgentThread } from '@shared/agentTypes'
import type { AgentContextStatus } from '@shared/agentTypes'
import { contextCompressionTriggerTokens, projectRuleInputBudget } from '@shared/contextWindow'
import { modelContextKey } from '@shared/modelConfig'
import { builtinToolCatalog, enabledBuiltinFileToolNames, sortToolDefinitions } from '@shared/toolRegistry'
import { assertResolvedCapabilities, capabilityFeatures, defaultCapabilities, effectiveProjectCapabilities, effectiveProjectCapabilitySettings, intersectCapabilities, mcpToolAllowed, resolveSkillSelection, toolAllowed, type AgentCapabilities, type ResolvedAgentCapabilities, type RunConfiguration } from '@shared/agentCapabilities'
import { processEnvironment } from '../config/apiKeys'
import { DEFAULT_WORKSPACE_PROJECT_ID, type AppConfigSnapshot, type AppSettings, type Project, type ResolvedModelConfig, type WorkspaceProject } from '@shared/types'
import { commandShellCapabilityId, commandShellToolName, isCommandShellMetadata } from '@shared/commandShell'
import { bundledSearchEnvironment } from '../bundledRipgrep'
import { createShellCommandAuthorization } from '../shellCommandAuthorization'
import { createShellAuthorizationMiddleware, shellAuthorizationFor, verifyCurrentShellAuthorization } from './shellAuthorization'
import { createToolApprovalMiddleware } from './toolApprovalMiddleware'
import { createToolInputErrorMiddleware, createToolInputValidationMiddleware } from './toolInputErrors'
import { getAppConfigSnapshot } from '../config/appConfig'
import { createAgentModelResolver, resolveModelSelection, resolveThreadModelSelection, ModelSelectionError } from './modelSelection'
import { currentRequestModel, withModelRequest } from './modelRequestContext'
import { assertModelInputFits, assertModelInputSupported, ModelRequestChangedError } from './modelRequestValidation'
import { createPatchAuthorizationMiddleware, isFileEditTool, patchAuthorizationFor } from './patchAuthorization'
import { createFileTools } from '../llm/fileTools'
import { createRuntimeTools } from '../llm/runtimeTools'
import { getCachedMcpRuntime, getLoadedMcpRuntime } from '../mcpRuntimeService'
import { resolveConfiguredLanguage } from '../languageStore'
import { getProject } from '../projectStore'
import { describeCommandShell, getCommandShell, prepareShellCommand, resultText, runShellCommand } from '../shellRuntime'
import { buildSkillsPrompt, listSkillSnapshot } from '../skillsStore'
import { projectSkillMessages } from './messageMapper'
import type { AgentDatabase, AgentSubagentCallRecord } from './agentDatabase'
import {
  createAgentAttachmentProjector,
  stripAgentAttachmentProjection
} from './agentAttachmentProjection'
import { createChatModel, createCompressionChatModel } from './modelFactory'
import { buildAgentSystemPrompt, type AgentSystemPrompt } from './systemPrompt'
import { createSystemPromptCaptureMiddleware } from './systemPromptCapture'
import { approvalToolNames, requiresToolApproval } from './toolAuthorization'
import {
  createAgentContextRuntime,
  effectiveContextMessages,
  type AgentContextRuntime
} from './contextRuntime'
import type { CompressionTrackingCallbacks } from './compressionTracking'
import { createAnasSummarizationMiddleware } from './summarizationMiddleware'
import { agentContextStateSchema } from './contextStateSchema'
import { buildSubagentSystemPrompt } from './subagentPrompt'
import { createAgentRunLifecycleMiddleware } from './runLifecycleMiddleware'
import { createManualContextCompressionMiddleware } from './manualCompressionMiddleware'
import { createAgentToolEffectMiddleware } from './toolEffectMiddleware'
import { isDeveloperHttpTraceEnabled } from './developerHttpTraceState'
import { createAnasModelRetryMiddleware } from './modelRetryPolicy'
import {
  createProviderRequestCaptureFetch,
  type CapturedProviderRequest
} from './providerRequestCapture'
import { buildMemoryRulesPrompt, createMemoryRecallMiddleware, createMemoryRecallProjector } from './memoryPrompt'
import type { MemoryRecallDetails } from './memoryPrompt'
import { configuredServerTools } from './serverTools'
import { createQueuedDirectionMiddleware } from './directionMiddleware'
import type { ManagedCallService } from './managedCallService'
import {
  createManagedCallSupervisionMiddleware
} from './managedCallSupervisionMiddleware'
import { createSubagentTools, type SubagentToolRuntime } from './subagentTools'
import { createSubagentSupervisionMiddleware } from './subagentSupervisionMiddleware'
import { createProjectRulesMiddleware } from './projectRulesMiddleware'
import { codeReviewResponseFormat, createCodeReviewMiddleware, reviewSnapshotForIntent } from './codeReviewMiddleware'
import { modelResponseMessages } from './modelResponseMessages'
import { createToolImageProjectionMiddleware, projectToolImages } from './toolImageProjection'
import { contextRequestKey } from './serverTokenUsage'

export interface AgentInstance {
  // Runtime consumers use graph operations; structured response branding varies
  // by workflow and is projected from checkpoint messages instead.
  agent: Pick<ReturnType<typeof createDeepAgent>, 'invoke' | 'streamEvents'>
  context: AgentContextRuntime
  workspace: WorkspaceContext
  dispose(): Promise<void>
}

export interface AgentInstanceContext extends CompressionTrackingCallbacks {
  requestId?: string
  configuration?: RunConfiguration
  parentConfiguration?: RunConfiguration
  onConfigurationResolved?(value: RunConfiguration): void
  signal?: AbortSignal
  prepareWorkspace?: boolean
  onContextStatus?(status: AgentContextStatus): void
  onMemoryRecall?(details: MemoryRecallDetails & { agentName?: string }): void
  takeDirectionMessages?(afterToolCallIds: string[]): BaseMessage[] | Promise<BaseMessage[]>
  managedCalls?: Pick<
    ManagedCallService,
    | 'read'
    | 'readOutput'
    | 'readResult'
    | 'wait'
    | 'cancel'
    | 'start'
    | 'cancelRun'
    | 'unresolvedForThread'
    | 'resolveObservedCall'
  >
  subagents?: SubagentToolRuntime
  subagentCall?: AgentSubagentCallRecord
}

export interface WorkspaceContext {
  trustedFolders: string[]
  primaryFolder: string
  description: string
}

export function createAgentAccessModeResolver(
  database: Pick<AgentDatabase, 'getThread'>,
  threadId: string,
  subagentCall?: Pick<AgentSubagentCallRecord, 'ownerThreadId'>
): () => AgentThread['accessMode'] {
  const accessModeOwnerId = subagentCall?.ownerThreadId ?? threadId
  return () => database.getThread(accessModeOwnerId)?.accessMode ?? 'read_only_allowed'
}

export function shouldIncludeCommandShell(
  platform: NodeJS.Platform,
  settings: AppSettings,
  features: ReturnType<typeof capabilityFeatures> = capabilityFeatures(defaultCapabilities)
): boolean {
  if (!features.environment) return false
  return platform === 'win32'
    ? settings.environmentContext.powerShell
    : features.commandExecution && settings.environmentContext.operatingSystem
}

interface AgentAssemblyOptions {
  project?: Project
  captureProviderRequest?: (request: CapturedProviderRequest, model: ResolvedModelConfig) => void
  captureSystemPrompt?: (content: string) => void
  loadAttachments: boolean
  persistCheckpoints: boolean
  prepareWorkspace: boolean
  contextPreview?: boolean
}

export function createPlanningMiddleware(enabled: boolean) {
  if (!enabled) return createMiddleware({ name: 'todoListMiddleware' })

  const middleware = todoListMiddleware()
  // Anas owns the complete system prompt. Keep the framework's todo state,
  // tool, and parallel-call guard without its system-message augmentation.
  middleware.wrapModelCall = undefined
  return middleware
}

function toolOrderId(tool: ClientTool | ServerTool): string | undefined {
  if (!isLangChainTool(tool)) return undefined
  return isCommandShellMetadata((tool as { metadata?: unknown }).metadata) ? commandShellCapabilityId : tool.name
}

function simpleChatMetadata(message: BaseMessage): Record<string, unknown> {
  return Object.fromEntries(
    ['anas_run_id', 'anas_created_at', 'anas_model_context_key', 'anas_context_request_key',
      'anas_attachment_projection', 'anas_attachment_block_count']
      .filter((key) => message.additional_kwargs[key] !== undefined)
      .map((key) => [key, message.additional_kwargs[key]])
  )
}

function simpleChatAssistantMetadata(message: AIMessage): Record<string, unknown> {
  return {
    ...simpleChatMetadata(message),
    ...(message.additional_kwargs.reasoning !== undefined
      ? { reasoning: message.additional_kwargs.reasoning }
      : {}),
    ...(message.additional_kwargs.refusal !== undefined
      ? { refusal: message.additional_kwargs.refusal }
      : {})
  }
}

function simpleChatHumanMessage(message: HumanMessage): HumanMessage {
  if (message.additional_kwargs.lc_source === 'summarization') return message
  const displayText = message.additional_kwargs.anas_display_text
  if (typeof displayText !== 'string' || !displayText || message.additional_kwargs.anas_code_review_scope !== undefined) return message
  if (typeof message.content === 'string') {
    return new HumanMessage({
      id: message.id,
      content: displayText,
      additional_kwargs: simpleChatMetadata(message)
    })
  }
  let replaced = false
  const content = message.content.map((block) => {
    if (
      !replaced
      && block
      && typeof block === 'object'
      && 'type' in block
      && block.type === 'text'
      && 'text' in block
    ) {
      replaced = true
      return { ...block, text: displayText }
    }
    return block
  })
  if (!replaced) content.unshift({ type: 'text', text: displayText })
  return new HumanMessage({
    id: message.id,
    content,
    additional_kwargs: simpleChatMetadata(message)
  })
}

function isClientToolCallBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object' || !('type' in block)) return false
  if (block.type === 'non_standard' && 'value' in block) return isClientToolCallBlock(block.value)
  return ['tool_call', 'tool_call_chunk', 'invalid_tool_call', 'tool_use', 'function_call', 'custom_tool_call'].includes(String(block.type))
}

function simpleChatReasoningProjection(message: AIMessage) {
  const content = Array.isArray(message.content) ? message.content : []
  const output = Array.isArray(message.response_metadata.output) ? message.response_metadata.output : []
  const removesCalls = Boolean(message.tool_calls?.length || message.invalid_tool_calls?.length
    || content.some(isClientToolCallBlock) || output.some(isClientToolCallBlock))
  const detachedIds = new Map<string, boolean>()
  function item(block: unknown): Record<string, unknown> | undefined {
    if (!block || typeof block !== 'object' || !('type' in block)) return undefined
    return block.type === 'non_standard' && 'value' in block ? item(block.value) : block as Record<string, unknown>
  }
  if (removesCalls) {
    // A Responses reasoning ID references its original following output item.
    // Prefer the complete provider output: visible content can omit server tools
    // and would otherwise detach reasoning that still has its original successor.
    for (const blocks of [output, content]) {
      let following: unknown
      for (let index = blocks.length - 1; index >= 0; index--) {
        const block = item(blocks[index])
        if (block?.type === 'reasoning') {
          if (typeof block.id === 'string' && !detachedIds.has(block.id)) {
            detachedIds.set(block.id, following === undefined || isClientToolCallBlock(following))
          }
        } else following = blocks[index]
      }
    }
    const reasoning = item(message.additional_kwargs.reasoning)
    if (typeof reasoning?.id === 'string' && !detachedIds.has(reasoning.id)) detachedIds.set(reasoning.id, true)
  }
  return function project<T>(block: T): T {
    if (!block || typeof block !== 'object' || !('type' in block)) return block
    if (block.type === 'non_standard' && 'value' in block) return { ...block, value: project(block.value) }
    if (block.type !== 'reasoning' || !('id' in block) || typeof block.id !== 'string' || !detachedIds.get(block.id)) return block
    const { id: _id, ...reasoning } = block
    return reasoning as T
  }
}

export function simpleChatHistory(messages: BaseMessage[]): BaseMessage[] {
  const plain: BaseMessage[] = []
  for (const message of messages) {
    if (HumanMessage.isInstance(message)) {
      plain.push(simpleChatHumanMessage(message))
      continue
    }
    if (!AIMessage.isInstance(message)) continue
    // Providers may replay client calls from standard content blocks or raw
    // response output even when tool_calls is empty. Their results are absent
    // from plain chat, so remove every representation of those client calls.
    const projectReasoning = simpleChatReasoningProjection(message)
    const content = Array.isArray(message.content) ? message.content.filter(block => !isClientToolCallBlock(block)).map(projectReasoning) : message.content
    const responseMetadata = { ...message.response_metadata }
    if (Array.isArray(responseMetadata.output)) responseMetadata.output = responseMetadata.output.filter(block => !isClientToolCallBlock(block)).map(projectReasoning)
    const metadata = simpleChatAssistantMetadata(message)
    if (metadata.reasoning) metadata.reasoning = projectReasoning(metadata.reasoning)
    if (!content.length && !metadata.reasoning && !metadata.refusal
      && !(Array.isArray(responseMetadata.output) && responseMetadata.output.length)) continue
    plain.push(new AIMessage({
      id: message.id,
      content,
      additional_kwargs: metadata,
      response_metadata: responseMetadata,
      tool_calls: [],
      usage_metadata: message.usage_metadata
    }))
  }
  return plain
}

class SummaryOnlyBackend extends StateBackend {
  override downloadFiles(paths: string[]): FileDownloadResponse[] {
    return paths.map((path) => ({ path, content: null, error: 'file_not_found' }))
  }

  override write(): WriteResult {
    return { error: 'Conversation history offloading is disabled.' }
  }
}

function workspaceContext(project: WorkspaceProject): WorkspaceContext {
  const workspaceFolders = project.sourceFolders
  const description = [
    '<workspace_context>',
    `The active project is "${project.name}".`,
    '',
    'Project folders (absolute host paths):',
    ...workspaceFolders.map((folder, index) =>
      `- ${index === 0 ? 'Primary/default' : 'Additional'} folder "${basename(folder)}": \`${folder}\``
    ),
    '',
    'Path rules:',
    '1. Built-in tool file paths accept absolute paths and paths relative to the primary/default folder.',
    '2. Resolve every relative path from the primary/default folder shown above.',
    '3. In a multi-folder project, relative paths refer only to the primary/default folder; use an absolute path for an additional folder.',
    '4. Listed project folders can be read and written directly. Other host paths, including the app data directory, may require user approval.',
    '5. Shell commands run in the primary/default folder unless working_dir is supplied; a relative working_dir also resolves from that folder.',
    '</workspace_context>'
  ].join('\n')
  return {
    trustedFolders: workspaceFolders,
    primaryFolder: workspaceFolders[0],
    description
  }
}

async function memoryPrompt(enabled: boolean): Promise<string> {
  if (!enabled) return ''
  const rules = await buildMemoryRulesPrompt()
  return [
    '<memory>',
    rules,
    '</memory>'
  ].join('\n')
}

export async function prepareAgentSystemPrompt(
  thread: AgentThread,
  config: AppConfigSnapshot,
  capabilities?: AgentCapabilities,
  codingMode?: boolean,
  toolsEnabled = true,
  projectDraft?: Project
): Promise<{
  workspace: WorkspaceContext
  systemPrompt: ReturnType<typeof buildAgentSystemPrompt>
  simpleChatPrompt?: string
}> {
  const project = projectDraft ?? await getProject(thread.projectId)
  const effective = capabilities ?? (project.kind === 'workspace' ? effectiveProjectCapabilities(project, config.defaultCapabilities) : defaultCapabilities)
  const features = capabilityFeatures(effective)
  if (project.kind === 'simple_chat') {
    const defaultWorkspace = await getProject(DEFAULT_WORKSPACE_PROJECT_ID)
    if (defaultWorkspace.kind !== 'workspace') throw new Error('The default workspace project is invalid.')
    const workspace = workspaceContext(defaultWorkspace)
    return {
      workspace,
      systemPrompt: buildAgentSystemPrompt(config, {
        workspace: '',
        memory: '',
        skills: '',
        simpleChatPrompt: project.prompt
      }, features),
      simpleChatPrompt: project.prompt
    }
  }
  if (project.sourceFolders.length === 0) throw new Error(`Project ${project.id} has no source folders.`)
  const workspace = workspaceContext(project)
  const [memory, skills, commandShell] = await Promise.all([
    memoryPrompt(features.memory),
    features.skills ? buildSkillsPrompt(project.id, effective.skills, project.sourceFolders) : Promise.resolve(''),
    shouldIncludeCommandShell(process.platform, config.settings, features)
      ? getCommandShell().then(describeCommandShell)
      : Promise.resolve(undefined)
  ])
  return {
    workspace,
    systemPrompt: buildAgentSystemPrompt(config, {
      workspace: features.workspaceContext ? workspace.description : '',
      memory,
      skills,
      projectPrompt: project.advancedSettings ? project.prompt : '',
      codingMode: codingMode ?? project.codingMode,
      toolsEnabled,
      commandShell
    }, features)
  }
}

async function loadMcpTools(config: AppConfigSnapshot, simpleChat: boolean, capabilities: AgentCapabilities, preview = false): Promise<StructuredToolInterface[]> {
  if (
    simpleChat
    || !capabilityFeatures(capabilities).mcp
    || !config.mcpServers.some((server) => server.enabled)
  ) return []
  const runtime = preview ? getLoadedMcpRuntime() : await getCachedMcpRuntime()
  const names = config.mcpServers.filter((server) => server.enabled).flatMap((server) =>
    runtime.loaded.filter((loaded) => loaded.id === server.id).flatMap((loaded) =>
      loaded.toolNames.filter((name) => mcpToolAllowed(capabilities, server.id, name))))
  const selected = new Set(names)
  return sortToolDefinitions(runtime.tools.filter((tool) => selected.has(tool.name)), toolOrderId, names)
}

export function createInterruptPolicy(options: {
  availableTools: readonly string[]
  commandShellToolName?: string
  primaryFolder: string
  trustedFolders: string[]
  accessMode(): AgentThread['accessMode']
  shellCommandAuthorization?: ReturnType<typeof createShellCommandAuthorization>
  requestId?: string
}): Record<string, InterruptOnConfig> {
  const available = new Set(options.availableTools)
  return Object.fromEntries(approvalToolNames(options.commandShellToolName)
    .filter((name) => available.has(name))
    .map((name) => [
      name,
      {
        allowedDecisions: ['approve', 'reject'],
        description: name === options.commandShellToolName
          ? `Run a command with ${name}.`
          : name === 'update_config'
            ? 'Modify application configuration.'
            : name === 'write_call'
              ? 'Send input to the selected live terminal. Input may execute a pending command.'
            : 'Access a host file path outside the project folders.',
        when: async (request) => {
          const rules = (request.state as { anasProjectRules?: { runId: string; blockedCalls: string[] } } | undefined)?.anasProjectRules
          if (rules?.runId === options.requestId && rules?.blockedCalls.includes(request.toolCall.id!)) return false
          const args = request.toolCall.args as Record<string, unknown>
          const accessMode = options.accessMode()
          if (name === options.commandShellToolName && options.shellCommandAuthorization) {
            const receipt = shellAuthorizationFor(request.state, request.toolCall, options.requestId)
            return accessMode !== 'full_access' && (!receipt || receipt.requiresApproval)
          }
          if (isFileEditTool(name)) {
            const receipt = patchAuthorizationFor(request.state, request.toolCall, options.requestId)
            return accessMode !== 'full_access' && !!receipt && !receipt.error && receipt.requiresApproval
          }
          return await requiresToolApproval({
            toolName: name,
            args,
            primaryFolder: options.primaryFolder,
            trustedFolders: options.trustedFolders,
            accessMode,
            commandShellToolName: options.commandShellToolName
          })
        }
      } satisfies InterruptOnConfig
    ]))
}

async function prepareAgentInstanceFromConfig(
  thread: AgentThread,
  database: AgentDatabase,
  config: AppConfigSnapshot,
  context: AgentInstanceContext,
  options: AgentAssemblyOptions
): Promise<{ context: AgentContextRuntime; create(): AgentInstance }> {
  const boundSelection = options.persistCheckpoints || options.contextPreview
  const resolveModel = boundSelection
    ? createAgentModelResolver(thread.id, database)
    : async () => resolveModelSelection(thread, config, { allowDefault: true })
  const initialModel = resolveModelSelection(
    boundSelection ? resolveThreadModelSelection(thread.id, database) : thread,
    config, { allowDefault: !boundSelection }
  )
  const developerHttpTrace = isDeveloperHttpTraceEnabled()
  const checkpointThreadId = thread.id

  const activeSubagent = context.subagentCall?.config
  let runConfiguration = context.configuration
  if (!runConfiguration) {
    const project = options.project ?? await getProject(thread.projectId)
    const projectPolicy = project.kind === 'workspace' ? effectiveProjectCapabilitySettings(project, config.defaultCapabilities) : undefined
    const ownCapabilities = activeSubagent?.capabilities ?? projectPolicy?.capabilities ?? defaultCapabilities
    const parentLimit = activeSubagent ? context.parentConfiguration?.subagentLimit : undefined
    const catalog = project.kind === 'workspace' && ownCapabilities.skills.enabled && (!parentLimit || parentLimit.skills.enabled)
      ? await listSkillSnapshot(thread.projectId, project.sourceFolders)
      : { skills: [] }
    const toolCatalog = project.kind === 'workspace' ? await listToolSnapshot(project.sourceFolders) : { tools: [] }
    const resolve = (value: AgentCapabilities): ResolvedAgentCapabilities => ({ ...value,
      customTools: resolveToolSelection(value.customTools, toolCatalog.tools.filter(tool => !tool.definition?.interactive || value.backgroundTools), Boolean(activeSubagent), false),
      skills: resolveSkillSelection(value.skills, catalog.skills, true, Boolean(activeSubagent)) })
    let capabilities = resolve(ownCapabilities)
    if (activeSubagent && parentLimit) {
      assertResolvedCapabilities(parentLimit)
      capabilities = intersectCapabilities(capabilities, parentLimit)
    }
    // Apply the root ceiling before resolving duplicate names, so an excluded
    // project override cannot hide an allowed tool from another source.
    capabilities = { ...capabilities, customTools: resolveToolSelection(capabilities.customTools,
      toolCatalog.tools.filter(tool => !tool.definition?.interactive || capabilities.backgroundTools)) }
    const subagentLimit = activeSubagent ? parentLimit : projectPolicy?.restrictSubagents ? capabilities : undefined
    const rootSelection = activeSubagent
      ? context.parentConfiguration?.subagentSelectionLimit ?? context.parentConfiguration?.subagentSelection ?? defaultSubagentSelection
      : projectPolicy?.subagentSelection
    const rootSubagents = selectedSubagents(config.subagents, rootSelection)
    const subagentSelection: SubagentSelection = {
      mode: 'custom',
      names: (activeSubagent ? selectedSubagents(rootSubagents, activeSubagent.subagentSelection) : rootSubagents).map((subagent) => subagent.name)
    }
    runConfiguration = {
      subagentSelection,
      customTools: structuredClone(project.kind === 'workspace'
        ? toolCatalog.tools.filter(tool => capabilities.customTools.entries.includes(tool.id)).map(tool => tool.definition!) : []),
      ...(activeSubagent ? { subagentSelectionLimit: structuredClone(rootSelection) } : {}),
      codingMode: activeSubagent
        ? context.parentConfiguration?.codingMode === true
        : project.kind === 'workspace' && project.codingMode,
      capabilities,
      ...(subagentLimit ? { subagentLimit } : {})
    }
    context.onConfigurationResolved?.(runConfiguration)
  }
  const capabilities = runConfiguration.capabilities
  const features = capabilityFeatures(capabilities)
  const { workspace, systemPrompt: rootSystemPrompt, simpleChatPrompt } = await prepareAgentSystemPrompt(
    thread, config, capabilities, !activeSubagent && runConfiguration.codingMode, true, options.project
  )
  const simpleChat = simpleChatPrompt !== undefined
  const toolsEnabled = !simpleChat
  const review = !activeSubagent && context.requestId
    ? reviewSnapshotForIntent(database.getRunInputIntent(context.requestId)) : undefined
  if (review && (!toolsEnabled || !initialModel.capabilities.toolUse)) throw new ModelSelectionError('Code review requires an agent project and a model with tool use enabled.')
  const hasUnresolvedManagedCalls = (options.persistCheckpoints || options.contextPreview)
    && database.hasUnresolvedManagedCallsForThread(thread.id)
  if (hasUnresolvedManagedCalls && (!toolsEnabled || !initialModel.capabilities.toolUse)) {
    throw new ModelSelectionError(
      'This conversation has unresolved background calls. Continue it in an agent project with a model that supports tool use so those calls can be supervised.'
    )
  }
  if (hasUnresolvedManagedCalls && options.persistCheckpoints && !context.managedCalls) {
    throw new Error('Background call supervision is unavailable for this conversation.')
  }
  const hasUnresolvedSubagents = Boolean(
    context.requestId
    && database.listUnresolvedSubagentCallsForRun(context.requestId, 1).length > 0
  )
  if (hasUnresolvedSubagents && (!toolsEnabled || !initialModel.capabilities.toolUse || !features.subagents)) {
    throw new ModelSelectionError(
      'This conversation has unresolved background subagents. Re-enable subagents and continue it with a model that supports tool use so they can be supervised.'
    )
  }
  const availableSubagents = toolsEnabled && features.subagents
    ? selectedSubagents(config.subagents, runConfiguration.subagentSelection)
    : []
  // Resolved selections apply only to new launches. A running child owns the
  // immutable definition captured when it was created, so config edits cannot
  // change or strand a recoverable execution.
  const [mcpTools, outputLanguage] = await Promise.all([
    loadMcpTools(config, simpleChat, capabilities, options.contextPreview),
    resolveConfiguredLanguage(config.settings.language)
  ])
  const commandShell = toolsEnabled && features.commandExecution
    ? await getCommandShell()
    : undefined
  const shellEnvironment = commandShell && !options.contextPreview
    ? await bundledSearchEnvironment(processEnvironment(capabilities.applicationEnvironment))
    : undefined
  const shellCommandAuthorization = commandShell && shellEnvironment ? createShellCommandAuthorization({
    shell: commandShell, env: shellEnvironment.env, rgExecutable: shellEnvironment.executable,
    primaryFolder: workspace.primaryFolder, trustedFolders: workspace.trustedFolders,
    skills: { projectId: thread.projectId, sourceFolders: options.project?.kind === 'workspace' ? options.project.sourceFolders : undefined,
      selection: capabilities.skills, allowUserInvocation: !activeSubagent },
    accessMode: createAgentAccessModeResolver(database, thread.id, context.subagentCall), signal: context.signal
  }) : undefined
  const activeToolNames = capabilities.toolMode !== 'all'
    ? [...builtinToolCatalog.filter((tool) => toolAllowed(capabilities, tool.id)).map((tool) => tool.id), ...mcpTools.map((tool) => tool.name)]
    : undefined
  const activeMcpTools = mcpTools
  const activeMemory = features.memory
  const systemPrompt = activeSubagent
    ? {
        ...rootSystemPrompt,
        text: buildSubagentSystemPrompt(activeSubagent, rootSystemPrompt)
      }
    : rootSystemPrompt
  if (options.prepareWorkspace && !simpleChat) {
    await Promise.all([...new Set([workspace.primaryFolder, ...workspace.trustedFolders])]
      .map((folder) => mkdir(folder, { recursive: true })))
  }
  const shellRunner = async (input: {
    command: string
    summary?: string
    timeoutSec?: number
    workingDir?: string
    keepProcesses?: boolean
    pty?: import('@shared/terminal').TerminalSize
  }): Promise<string> => {
    const prepared = await prepareShellCommand(input, workspace.primaryFolder)
    if ('ok' in prepared) return resultText(prepared)
    prepared.env = shellEnvironment?.env
    prepared.pathPrepend = shellEnvironment?.directory
    if (!commandShell) return resultText({
      ok: false,
      command: prepared.command,
      workingDir: prepared.workingDir,
      timeoutSec: prepared.timeoutSec,
      stdout: '',
      stderr: '',
      error: 'Command shell is unavailable.'
    })
    const control = currentToolExecution()
    await verifyCurrentShellAuthorization()
    return runShellCommand(prepared, commandShell, control?.signal ?? context.signal, {
      onDispatched: control?.markRunning,
      onOutcomeUncertain: control?.markUncertain,
      onOutput: control?.output,
      onTerminal: control?.setTerminal,
      onResult: (result) => control?.setOutcome({
        ok: result.ok,
        ...(result.exitCode === undefined ? {} : { exit_code: result.exitCode }),
        ...(result.signal === undefined ? {} : { signal: result.signal }),
        ...(result.timedOut === undefined ? {} : { timed_out: result.timedOut }),
        ...(result.aborted === undefined ? {} : { aborted: result.aborted }),
        ...(result.error === undefined ? {} : { error: result.error })
      })
    })
  }
  const runtimeTools = await createRuntimeTools({
    enabled: toolsEnabled,
    primaryFolder: workspace.primaryFolder,
    configuration: toolsEnabled && features.configuration,
    memory: toolsEnabled && ['read_memory', 'save_to_memory', 'forget_memory'].some((id) => toolAllowed(capabilities, id)),
    memoryStore: database.memoryStore,
    projectId: thread.projectId,
    threadId: thread.id,
    runId: context.requestId,
    userInputSource: async () => {
      const ownerThreadId = context.subagentCall?.ownerThreadId ?? thread.id
      const owner = database.getThread(ownerThreadId)
      if (!owner) throw new Error(`User input conversation ${ownerThreadId} was not found.`)
      const project = await getProject(owner.projectId)
      return { projectName: project.name, threadTitle: owner.title,
        ...(context.subagentCall ? { agentName: context.subagentCall.agentName } : {}) }
    },
    network: toolsEnabled && features.networkAccess,
    shell: toolsEnabled && features.commandExecution,
    commandShell,
    mcp: toolsEnabled && features.mcp && activeMcpTools.length > 0,
    signal: context.signal,
    mcpTools: activeMcpTools,
    toolNames: activeToolNames,
    shellRunner,
    managedCalls: context.managedCalls,
    backgroundTools: capabilities.backgroundTools,
    interactiveCustomTools: runConfiguration.customTools.some((tool) => tool.interactive),
    managedCallSupervision: hasUnresolvedManagedCalls
  })
  const fileTools = toolsEnabled
    ? createFileTools({
        maxReadBytes: async () => (await resolveModel()).maxContextTokens,
        toolNames: enabledBuiltinFileToolNames(features, activeToolNames),
        signal: context.signal,
        fileChanges: database.fileChanges,
        requestId: context.requestId,
        primaryFolder: workspace.primaryFolder
      })
    : []
  const subagentTools = toolsEnabled && features.subagents
    ? createSubagentTools({
        runtime: context.subagents,
        subagents: availableSubagents,
        signal: context.signal,
        includeStartForRecovery: Boolean(
          context.requestId
          && database.listSubagentCallsForParentRun(context.requestId).length > 0
        )
      })
    : []
  const manage = (tool: StructuredToolInterface) => withManagedToolExecution(tool, {
    database,
    service: context.managedCalls,
    threadId: thread.id,
    runId: context.requestId,
    allowBackground: capabilities.backgroundTools,
    signal: context.signal
  })
  const customTools = toolsEnabled ? createCustomTools(runConfiguration.customTools, {
    env: processEnvironment(capabilities.applicationEnvironment),
    backgroundTools: capabilities.backgroundTools,
    signal: context.signal, preview: !options.persistCheckpoints
  }) : []
  const managedCustomTools = customTools.map(manage)
  const managedRuntimeTools = runtimeTools.map(manage)
  const managedFileTools = fileTools.map(manage)
  const filesystemMiddleware = createMiddleware({
    name: 'FilesystemMiddleware',
    tools: managedFileTools
  })
  const availableToolNames = [
    ...runtimeTools.map((tool) => tool.name),
    ...customTools.map((tool) => tool.name),
    ...fileTools.map((tool) => tool.name),
    ...subagentTools.map((tool) => tool.name)
  ]
  const extensionToolOrder = [...customTools, ...activeMcpTools].map((tool) => tool.name)
  const allTools = sortToolDefinitions([...managedRuntimeTools, ...managedFileTools, ...subagentTools, ...managedCustomTools], toolOrderId, extensionToolOrder)
  const todoMiddleware = createPlanningMiddleware(toolsEnabled && features.planning)
  const requestSystemPrompt = (model: ResolvedModelConfig): AgentSystemPrompt => {
    const provider = model.protocol === 'anthropic_messages' ? 'anthropic' : 'openai'
    const suffix = simpleChat ? undefined : getHarnessProfile(`${provider}:${model.model}`)?.systemPromptSuffix
    return suffix ? {
      text: [systemPrompt.text, suffix].filter(Boolean).join('\n\n'),
      sections: [...systemPrompt.sections, { kind: 'system_instruction', content: suffix }]
    } : systemPrompt
  }
  const reviewFormat = review ? codeReviewResponseFormat(review) : undefined
  const responseTools = reviewFormat?.map((strategy) => strategy.tool) ?? []
  const modelTools = (model: ResolvedModelConfig, tools: Array<ClientTool | ServerTool>): Array<StructuredToolInterface | ServerTool> => {
    try {
      const serverTools = configuredServerTools(model)
      if (!toolsEnabled || !model.capabilities.toolUse) return []
      return [
        ...tools.filter((tool): tool is StructuredToolInterface => isLangChainTool(tool)
          && (model.capabilities.vision || !['view_image', 'view_multiple_images'].includes(tool.name))),
        ...serverTools
      ]
    } catch (cause) {
      throw new ModelSelectionError(`The selected model has invalid tool parameters: ${cause instanceof Error ? cause.message : String(cause)}. Correct its settings and send again.`, { cause })
    }
  }
  const attachmentProjector = createAgentAttachmentProjector({
    artifacts: options.loadAttachments
      ? database.listAttachmentsForThread(thread.id)
      : [],
    currentRunId: context.requestId,
    textMaxChars: config.settings.attachmentTextMaxChars,
    textOverflow: config.settings.attachmentTextOverflow
  })
  const memoryRecallOptions = {
    enabled: capabilities.memory && !simpleChat,
    store: database.memoryStore,
    projectId: thread.projectId,
    onRecall: activeSubagent && context.onMemoryRecall
      ? (details: MemoryRecallDetails) => context.onMemoryRecall?.({ ...details, agentName: activeSubagent.name })
      : context.onMemoryRecall
  }
  const projectRecalledMemory = createMemoryRecallProjector(memoryRecallOptions)
  const contextRuntime = createAgentContextRuntime({
    codingMode: runConfiguration.codingMode,
    includeProjectRules: !simpleChat && runConfiguration.codingMode,
    developerHttpTrace,
    resolveModel,
    outputLanguage,
    requestId: context.requestId,
    systemPrompt: requestSystemPrompt,
    projectSystemMessage: projectRecalledMemory,
    tools: (model) => [...modelTools(model, [...allTools, ...(todoMiddleware.tools ?? [])]), ...responseTools],
    projectHistory: simpleChat ? simpleChatHistory : undefined,
    projectMessages: (messages, model) => attachmentProjector.project(messages, model.capabilities.vision)
  })
  return { context: contextRuntime, create: () => {
    const requestChatModel = (model: ResolvedModelConfig) => createChatModel(model, {
      compressionTracking: context,
      developerHttpTrace,
      providerFetch: options.captureProviderRequest
        ? createProviderRequestCaptureFetch((request) => options.captureProviderRequest?.(request, model))
        : undefined,
      requestId: context.requestId,
      requestRole: activeSubagent ? 'subagent' : 'main'
    })
    const requestCompressionModel = (model: ResolvedModelConfig) => createCompressionChatModel(model, {
      beforeRequest: async () => {
        if (JSON.stringify(model) !== JSON.stringify(await resolveModel())) {
          throw new ModelRequestChangedError()
        }
      },
      compressionTracking: context,
      developerHttpTrace,
      requestId: context.requestId,
      requestRole: activeSubagent ? 'subagent-compression' : 'compression',
      signal: context.signal
    })
    const getInputCapacityTokens = () => {
      const model = currentRequestModel()
      return model.maxContextTokens - model.maxOutputTokens
    }
    const getModelTokenCountingOptions = () => {
      const { protocol, parameters } = currentRequestModel()
      return { protocol, parameters }
    }
    const projectRules = !simpleChat && runConfiguration.codingMode
      ? createProjectRulesMiddleware({
          runId: context.requestId,
          folders: workspace.trustedFolders,
          primaryFolder: workspace.primaryFolder,
          getInputCapacityTokens,
          getModelTokenCountingOptions,
          responseTools,
          allowInterrupts: options.persistCheckpoints,
          accessMode: createAgentAccessModeResolver(database, thread.id, context.subagentCall),
          signal: context.signal
        })
      : undefined
    const summaryMiddleware = createAnasSummarizationMiddleware({
          codingMode: runConfiguration.codingMode,
          responseTools,
          backend: (runtime: BackendRuntime) => new SummaryOnlyBackend(runtime),
          outputLanguage,
          resolveRequest: () => {
            const model = currentRequestModel()
            const inputCapacityTokens = getInputCapacityTokens()
            const trigger = contextCompressionTriggerTokens(model.maxContextTokens, model.maxOutputTokens, model.contextCompressionThreshold)
            return {
              model: requestCompressionModel(model) as never,
              modelContextKey: modelContextKey(model),
              protocol: model.protocol,
              parameters: model.parameters,
              enabled: !simpleChat && model.contextCompressionEnabled,
              inputCapacityTokens,
              threshold: projectRules ? Math.min(trigger, projectRuleInputBudget(inputCapacityTokens)) : trigger
            }
          }
        })
    const contextStatusMiddleware = createMiddleware({
      name: 'AnasContextStatusMiddleware',
      wrapModelCall: async (request, handler) => {
        const model = currentRequestModel()
        const requestContext = { systemMessage: request.systemMessage, tools: [...request.tools, ...responseTools] }
        const status = contextRuntime.statusFromMessages(request.messages, model, requestContext)
        const withoutAttachments = contextRuntime.statusFromMessages(
          stripAgentAttachmentProjection(request.messages), model, requestContext
        )
        status.breakdown.attachmentTokens = Math.max(
          0,
          status.breakdown.messageTokens - withoutAttachments.breakdown.messageTokens
        )
        status.breakdown.messageTokens = withoutAttachments.breakdown.messageTokens
        context.onContextStatus?.(status)
        return handler(request)
      }
    })
    const attachmentProjectionMiddleware = createMiddleware({
      name: 'AnasAttachmentProjectionMiddleware',
      stateSchema: agentContextStateSchema,
      wrapModelCall: async (request, handler) => {
        const included = new Set(effectiveContextMessages(request.messages, request.state).flatMap((message) => message.id ? [message.id] : []))
        return handler({
          ...request,
          messages: await attachmentProjector.project(request.messages, currentRequestModel().capabilities.vision, included)
        })
      }
    })
    const messageMetadataMiddleware = createMiddleware({
      name: 'AnasMessageMetadataMiddleware',
      wrapModelCall: async (request, handler) => {
        const requestKey = contextRequestKey({
          messages: request.messages, protocol: currentRequestModel().protocol,
          systemMessage: request.systemMessage, tools: [...request.tools, ...responseTools]
        })
        const response = await handler(request)
        for (const message of modelResponseMessages(response)) {
          message.additional_kwargs = {
            ...message.additional_kwargs,
            anas_model_context_key: modelContextKey(currentRequestModel()),
            anas_context_request_key: requestKey,
            ...(context.requestId ? { anas_run_id: context.requestId } : {}),
            anas_created_at: new Date().toISOString()
          }
        }
        return response
      }
    })
    const simpleChatMiddleware = simpleChat
      ? createMiddleware({
          name: 'AnasSimpleChatMiddleware',
          wrapModelCall: async (request, handler) => handler({
            ...request,
            messages: simpleChatHistory(request.messages),
            systemMessage: new SystemMessage(simpleChatPrompt),
            tools: []
          })
        })
      : createMiddleware({ name: 'AnasSimpleChatMiddleware' })
    const toolInterruptPolicy = createInterruptPolicy({
      availableTools: availableToolNames,
      shellCommandAuthorization,
      commandShellToolName: commandShell
        ? commandShellToolName(commandShell.executable)
        : undefined,
      primaryFolder: workspace.primaryFolder,
      trustedFolders: workspace.trustedFolders,
      accessMode: createAgentAccessModeResolver(database, thread.id, context.subagentCall),
      requestId: context.requestId
    })
    // Override Deep Agents' built-in synchronous subagent middleware. Anas exposes
    // only the durable asynchronous subagent tools assembled above.
    const subagentMiddleware = createMiddleware({ name: 'subAgentMiddleware' })
    const managedCallObserverRunId = context.requestId
    const dynamicModelMiddleware = createMiddleware({
      name: 'AnasModelSelectionMiddleware',
      stateSchema: agentContextStateSchema,
      wrapModelCall: async (request, handler) => {
        const model = await resolveModel()
        const requiresTools = Boolean(review || options.persistCheckpoints && (
          database.hasUnresolvedManagedCallsForThread(thread.id)
          || context.requestId && database.listUnresolvedSubagentCallsForRun(context.requestId, 1).length > 0
        ))
        // Product permissions own the graph's tools. Model capabilities only
        // select which of those tools can be offered in this request.
        const effectiveMessages = effectiveContextMessages(projectToolImages(request.messages), request.state)
        assertModelInputSupported(model, simpleChat ? simpleChatHistory(effectiveMessages) : effectiveMessages, requiresTools)
        const prompt = requestSystemPrompt(model).text
        return withModelRequest(model, () => handler({
          ...request,
          model: requestChatModel(model),
          systemMessage: new SystemMessage(prompt!),
          tools: modelTools(model, request.tools)
        }))
      }
    })
    const modelInputGuard = createMiddleware({
      name: 'AnasModelInputGuard',
      wrapModelCall: async (request, handler) => {
        const model = currentRequestModel()
        // Preparation can include a remote summary. Re-enter preparation when
        // selection/settings changed while it was pending, before any main call.
        if (JSON.stringify(model) !== JSON.stringify(await resolveModel())) throw new ModelRequestChangedError()
        assertModelInputSupported(model, request.messages, Boolean(review))
        assertModelInputFits(model, [request.systemMessage, ...request.messages], [...request.tools, ...responseTools])
        return handler(request)
      }
    })

    const agent = createDeepAgent({
      name: 'anas',
      model: requestChatModel(initialModel),
      ...(reviewFormat ? { responseFormat: reviewFormat } : {}),
      tools: [...managedRuntimeTools, ...managedCustomTools, ...subagentTools],
      systemPrompt: { base: systemPrompt.text },
      checkpointer: options.persistCheckpoints ? database.checkpointer : undefined,
      store: activeMemory ? database.memoryStore : undefined,
      middleware: [
        // afterAgent hooks execute in reverse middleware order. Keep the run
        // lifecycle first so its completed marker is the root graph's last node.
        createAgentRunLifecycleMiddleware(context.requestId),
        createAnasModelRetryMiddleware({ runId: context.requestId, signal: context.signal }),
        dynamicModelMiddleware,
        createToolInputErrorMiddleware(),
        createSubagentSupervisionMiddleware({
          unresolved: (limit) => context.subagents?.unresolvedForRun(limit) ?? [],
          resolve: (subagentId) => context.subagents?.resolveObserved(subagentId)
        }),
        createManagedCallSupervisionMiddleware({
          unresolvedCalls: (limit) => (
            context.managedCalls?.unresolvedForThread(thread.id, limit) ?? []
          ),
          resolveObservedCall: context.managedCalls && managedCallObserverRunId
            ? (callId) => context.managedCalls?.resolveObservedCall(
                callId,
                thread.id,
                managedCallObserverRunId
              )
            : undefined
        }),
        createMiddleware({
          name: 'AnasInitialContextStatusMiddleware',
          stateSchema: agentContextStateSchema,
          beforeAgent: async (state) => {
            if (context.onContextStatus) {
              context.onContextStatus(await contextRuntime.projectedStatus(state))
            }
          }
        }),
        createManualContextCompressionMiddleware({
          context: contextRuntime,
          callbacks: context,
          runId: context.requestId
        }),
        todoMiddleware,
        subagentMiddleware,
        attachmentProjectionMiddleware,
        createToolImageProjectionMiddleware(),
        // Deep Agents places overrides of its default summarizer at the front.
        // Disable that slot and install our summarizer below rule projection.
        createMiddleware({ name: 'SummarizationMiddleware' }),
        createQueuedDirectionMiddleware({
          takeDirectionMessages: async (afterToolCallIds) => {
            const messages = await context.takeDirectionMessages?.(afterToolCallIds) ?? []
            for (const message of messages) {
              if (!message.id) continue
              attachmentProjector.addArtifacts(
                database.listAttachmentsForMessage(thread.id, message.id)
              )
            }
            return messages
          }
        }),
        createToolApprovalMiddleware(toolInterruptPolicy, allTools),
        ...(shellCommandAuthorization && commandShell ? [createShellAuthorizationMiddleware({
          runId: context.requestId, toolName: commandShellToolName(commandShell.executable), analyzer: shellCommandAuthorization,
          accessMode: createAgentAccessModeResolver(database, thread.id, context.subagentCall)
        })] : []),
        ...(context.requestId ? [createPatchAuthorizationMiddleware({ runId: context.requestId,
          primaryFolder: workspace.primaryFolder, folders: workspace.trustedFolders,
          accessMode: createAgentAccessModeResolver(database, thread.id, context.subagentCall) })] : []),
        // Recall must precede budget checks and compression so the same required
        // system context is included in every prepared-request calculation.
        createMemoryRecallMiddleware(memoryRecallOptions, projectRecalledMemory),
        ...(projectRules ? [projectRules.middleware] : []),
        createToolInputValidationMiddleware([...allTools, ...(todoMiddleware.tools ?? [])]),
        { ...summaryMiddleware, name: 'AnasSummarizationMiddleware' },
        simpleChatMiddleware,
        ...(review ? [createCodeReviewMiddleware(review, context.requestId!, getInputCapacityTokens, getModelTokenCountingOptions)] : []),
        createMiddleware({
          name: 'AnasSkillMessageProjectionMiddleware',
          wrapModelCall: (request, handler) => handler({
            ...request,
            messages: projectSkillMessages(request.messages)
          })
        }),
        contextStatusMiddleware,
        messageMetadataMiddleware,
        createAgentToolEffectMiddleware({
          database,
          runId: context.requestId,
          threadId: thread.id,
          checkpointThreadId,
          tools: allTools
        }),
        filesystemMiddleware,
        ...(config.settings.maxModelCallsPerRun > 0 && !activeSubagent
          ? [modelCallLimitMiddleware({
              runLimit: config.settings.maxModelCallsPerRun,
              exitBehavior: 'error'
            })]
          : []),
        ...(projectRules ? [projectRules.guard] : []),
        // Install provider-aware caching independently of the initial model.
        anthropicPromptCachingMiddleware({ unsupportedModelBehavior: 'ignore', minMessagesToCache: 1 }),
        createMiddleware({
          name: 'AnasToolOrderMiddleware',
          wrapModelCall: (request, handler) => handler({
            ...request,
            tools: sortToolDefinitions(request.tools, toolOrderId, extensionToolOrder)
          })
        }),
        modelInputGuard,
        ...(options.captureSystemPrompt
          ? [createSystemPromptCaptureMiddleware(options.captureSystemPrompt)]
          : [])
      ]
    })
    return {
      agent,
      context: contextRuntime,
      workspace,
      async dispose() {}
    }
  } }
}

async function createAgentInstanceFromConfig(
  thread: AgentThread,
  database: AgentDatabase,
  config: AppConfigSnapshot,
  context: AgentInstanceContext,
  options: AgentAssemblyOptions
): Promise<AgentInstance> {
  return (await prepareAgentInstanceFromConfig(thread, database, config, context, options)).create()
}

/** Reuse request definitions without constructing or running an agent graph. */
export async function projectAgentContextStatus(
  thread: AgentThread,
  database: AgentDatabase,
  values: unknown,
  context: AgentInstanceContext = {}
): Promise<AgentContextStatus> {
  const prepared = await prepareAgentInstanceFromConfig(thread, database, await getAppConfigSnapshot(), context, {
    contextPreview: true, loadAttachments: true, persistCheckpoints: false, prepareWorkspace: false
  })
  return prepared.context.projectedStatus(values)
}

export async function createAgentInstance(
  thread: AgentThread,
  database: AgentDatabase,
  context: AgentInstanceContext = {}
): Promise<AgentInstance> {
  let config: AppConfigSnapshot
  try {
    config = await getAppConfigSnapshot()
  } catch (cause) {
    throw new ModelSelectionError(`The current model configuration could not be loaded. The run was stopped. Correct its settings and send again. ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
  return createAgentInstanceFromConfig(
    thread,
    database,
    config,
    context,
    {
      loadAttachments: true,
      persistCheckpoints: true,
      prepareWorkspace: context.prepareWorkspace !== false
    }
  )
}

export async function captureAgentSystemPrompt(
  thread: AgentThread,
  database: AgentDatabase,
  config: AppConfigSnapshot,
  project?: Project
): Promise<string> {
  let captured: string | undefined
  const instance = await createAgentInstanceFromConfig(
    thread,
    database,
    config,
    {},
    {
      captureSystemPrompt: (content) => {
        captured = content
      },
      project,
      loadAttachments: false,
      persistCheckpoints: false,
      prepareWorkspace: false
    }
  )
  try {
    await instance.agent.invoke({
      messages: [new HumanMessage('hello world')]
    })
  } finally {
    await instance.dispose()
  }
  if (captured === undefined) throw new Error('The final system prompt was not captured.')
  return captured
}

export async function captureAgentModelRequest(
  thread: AgentThread,
  database: AgentDatabase,
  config: AppConfigSnapshot,
  managedCalls: NonNullable<AgentInstanceContext['managedCalls']>,
  project?: Project
): Promise<string> {
  const simulatedInput = 'hello world'
  let captured: { request: CapturedProviderRequest; model: ResolvedModelConfig } | undefined
  const instance = await createAgentInstanceFromConfig(
    thread,
    database,
    config,
    { managedCalls },
    {
      captureProviderRequest: (request, model) => {
        captured = { request, model }
      },
      project,
      loadAttachments: false,
      persistCheckpoints: false,
      prepareWorkspace: false
    }
  )
  try {
    await instance.agent.invoke({
      messages: [new HumanMessage(simulatedInput)]
    })
  } catch (reason) {
    if (!captured) throw reason
  } finally {
    await instance.dispose()
  }
  if (!captured) throw new Error('The provider request was not captured.')
  return JSON.stringify({
    simulated: true,
    simulated_input: simulatedInput,
    provider: {
      id: captured.model.providerId,
      name: captured.model.providerName,
      protocol: captured.model.protocol
    },
    model: {
      config_id: captured.model.id,
      name: captured.model.model
    },
    request: captured.request
  }, null, 2)
}
