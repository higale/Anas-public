import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { FakeListChatModel } from '@langchain/core/utils/testing'
import { AIMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages'
import { FakeToolCallingModel } from 'langchain'
import { afterAll, describe, expect, it, vi, type TestContext } from 'vitest'
import type { AgentAccessMode, AgentRuntimeEvent } from '@shared/agentTypes'
import { defaultCapabilities } from '@shared/agentCapabilities'
import { isCommandShellToolName } from '@shared/commandShell'
import { configureDataRuntime, getDataDir } from '../main/config/dataDir'
import { createProject } from '../main/projectStore'
import { AgentDatabase } from '../main/agent/agentDatabase'
import { AgentRuntime } from '../main/agent/agentRuntime'
import * as modelFactory from '../main/agent/modelFactory'
import { invokeWithCompressionTracking } from '../main/agent/compressionTracking'
import { captureCodeReview } from '../main/agent/codeReview'
import { codeReviewResponseFormat } from '../main/agent/codeReviewMiddleware'
import { queryGitChanges } from '../main/gitChanges'
import { codingTasks, pendingCodingEvaluations, type CodingTask } from './codingTasks'
import { changedSources, checkModelRequest, checkTaskFiles, codingDiagnostic, fingerprint, fixturePath, scriptBinding, scoreReview, toolResultsFromMessages, snapshotFiles, sourceFingerprints, toolOutputFailed, writeFixture, type CodingEvaluationResult } from './codingResults'
import packageInfo from '../../package.json'
import { getResolvedModelConfig, saveSubagent } from '../main/config/appConfig'
import { CodingModelTraceCollector } from './codingModelTrace'
import { checkSearchOutput, type SearchExpectation } from './codingSearch'

// The desktop host is substituted; only scripted suites substitute the model.
// Both entries use production configuration, graph, tools and SQLite code.
const desktop = vi.hoisted(() => ({ documents: '' }))
vi.mock('electron', () => ({ app: {
  isPackaged: false,
  getAppPath: () => process.cwd(),
  getPath: () => {
    if (!desktop.documents) throw new Error('Evaluation data directory has not been initialized.')
    return desktop.documents
  },
  setPath: () => {},
  getLocale: () => 'en'
} }))
vi.mock('../main/runtimeLogger', () => ({ runtimeLog: () => {} }))

export type CodingSuiteOptions = { kind: 'scripted-runtime' } | {
  kind: 'provider-runtime'
  configDirectory: string
  modelId?: string
  repeats?: number
}

export async function defineCodingSuite(options: CodingSuiteOptions): Promise<void> {
  const providerSource = options.kind === 'provider-runtime' ? {
    models: await readFile(join(options.configDirectory, 'models.json'), 'utf8'),
    settings: await readFile(join(options.configDirectory, 'settings.json'), 'utf8')
  } : undefined
  const configuredModelId = options.kind === 'provider-runtime'
    ? options.modelId ?? JSON.parse(providerSource!.settings).default_model_id : undefined
  if (providerSource && (!configuredModelId || !JSON.parse(providerSource.models).providers
    .some((provider: { models: Array<{ id: string }> }) => provider.models.some((model) => model.id === configuredModelId)))) {
    throw new Error('Select an existing model in the explicitly supplied evaluation configuration.')
  }
  const repeats = options.kind === 'provider-runtime' ? options.repeats ?? 1 : 1
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw new Error('Evaluation repetitions must be between 1 and 5.')
  const tasks = options.kind === 'scripted-runtime' ? codingTasks : codingTasks.filter((task) =>
    ['empty-sum', 'rename-export', 'merge-settings', 'diagnose-range', 'compression-resume', 'review-regression', 'review-clean'].includes(task.id))
  const results: CodingEvaluationResult[] = []
  const modes = [false, true] as const
  const accessModes: AgentAccessMode[] = options.kind === 'provider-runtime'
    ? ['read_only_allowed'] : ['strict_approval', 'read_only_allowed', 'full_access']
  // POSIX has no read-only Shell analyzer yet. Do not auto-approve its interrupts
  // or describe unexecuted permission combinations as successful search samples.
  const taskAccessModes = (task: CodingTask) => task.tools?.includes('run_shell') && process.platform !== 'win32'
    ? accessModes.filter((mode) => mode === 'full_access') : accessModes
  const reportRoot = resolve('out/evaluations', `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`)
  const suiteStartedAt = new Date().toISOString()
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim())
  function evaluationSourceFiles(): string[] {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z', '--',
      'src/evaluation', 'src/main', 'src/shared', 'data/config', 'data/lang', 'patches',
      'vitest.config.ts', 'vitest.evaluation.config.ts', 'vitest.evaluation.live.config.ts', 'package.json', 'package-lock.json'
    ], { encoding: 'utf8' }).split('\0').filter(Boolean)
  }
  const sourcesAtStart = await sourceFingerprints(process.cwd(), evaluationSourceFiles())
  let cancellationDiagnostic: 'not-run' | 'passed' = 'not-run'

  async function prepareConfig(root: string, task: CodingTask): Promise<void> {
    desktop.documents = join(root, 'documents')
    configureDataRuntime(['electron', 'coding-evaluation', '--data-dir', join(root, 'data')])
    const configDir = join(getDataDir(), 'config')
    await cp(resolve('data/config'), configDir, { recursive: true })
    const models = JSON.parse(providerSource?.models ?? await readFile(join(configDir, 'models.json'), 'utf8'))
    if (!providerSource) models.providers = [{
      ...models.provider_defaults,
      id: 'eval-provider', name: 'Scripted evaluation only', protocol: 'openai_chat_completions',
      base_url: 'https://scripted-evaluation.invalid/v1', api_key: 'not-a-real-credential',
      models: [{ ...models.model_defaults, id: 'eval-model', model: 'scripted-runtime-v1', parameter_preset_mode: 'none',
        stream: false, max_context_tokens: task.modelContextTokens ?? 128000, max_output_tokens: 4096 }]
    }]
    await writeFile(join(configDir, 'models.json'), JSON.stringify(models))
    const settings = JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8'))
    settings.default_model_id = configuredModelId ?? 'eval-model'
    settings.language = 'en'
    settings.max_model_calls_per_run = 16
    settings.environment_context = {
      operating_system: false, power_shell: false, bundled_commands: false, current_date: false,
      application_data_directory: false, user_home_directory: false,
      custom_information_enabled: false, custom_information: ''
    }
    await writeFile(join(configDir, 'settings.json'), JSON.stringify(settings))
  }

  async function evaluate(task: CodingTask, codingMode: boolean, accessMode: AgentAccessMode, signal: AbortSignal,
    beforeGenerate?: () => void | Promise<void>, sample = 1): Promise<CodingEvaluationResult> {
    const start = performance.now()
    const result: CodingEvaluationResult = {
      taskId: task.id, category: task.category, taskFingerprint: fingerprint(task),
      mode: codingMode ? 'coding' : 'ordinary', accessMode, sample,
      status: 'failed', evidence: options.kind,
      model: { name: 'langchain/FakeToolCallingModel', parameters: {}, protocol: null },
      shellEnabled: task.tools?.includes('run_shell') ?? false, startedAt: new Date().toISOString(), elapsedMs: 0,
      modelCalls: 0, toolCalls: 0, toolErrors: 0, approvalRequests: 0, interruptions: [],
      tokens: null, modelTrace: null, modelQuality: null, agentExecutedTests: null,
      evaluatorTests: null, reviewScore: null,
      compression: task.compression ? 'failed' : 'not-requested', checkpointReopened: false,
      toolOutputs: [], searchOutputs: [], checks: [], unrelatedChanges: [], errors: []
    }
    const expectation = task.modeExpectations?.[result.mode]
    const expectedRunFailures: string[] = []
    let root: string | undefined
    let searchWorkspace: string | undefined
    let runtime: AgentRuntime | undefined
    let database: AgentDatabase | undefined
    const modelTrace = options.kind === 'provider-runtime' ? new CodingModelTraceCollector() : undefined
    const observedRuns = new Map<string, string>()
    const recordedToolResults = new Set<string>()
    const failedToolResults = new Set<string>()
    const searchCalls = new Map<string, SearchExpectation>()
    const executedToolsByActor = new Map<string, Set<string>>()
    function recordToolResult(id: string, name: string, output: unknown, source: 'tool-event' | 'checkpoint', failed = false) {
      if ((failed || toolOutputFailed(output)) && !failedToolResults.has(id)) {
        failedToolResults.add(id)
        result.toolErrors += 1
      }
      if (recordedToolResults.has(id)) return
      recordedToolResults.add(id)
      const search = searchCalls.get(id)
      if (search && searchWorkspace && source === 'tool-event') {
        const evidence = checkSearchOutput(searchWorkspace, output, search)
        result.searchOutputs.push({ callId: id, name, ...evidence,
          passed: evidence.passed && !failed && isCommandShellToolName(name) })
      }
      const text = typeof output === 'string' ? output : JSON.stringify(output) ?? String(output)
      result.toolOutputs.push({ name, excerpt: text.slice(0, 4000), source })
    }
    const enabledTools = task.tools ?? ['read_file', 'read_multiple_files', 'apply_patch', 'list_directory']
    const bindings = new Map<string, 'patch' | 'subagent'>()
    let externalChangeInjected = false
    let cancellation: Promise<unknown> | undefined
    const abort = () => {
      result.errors.push(`Evaluation cancelled: ${String(signal.reason)}`)
      // The runtime owns cancellation and drains its graph/tools. Observe the
      // promise immediately, including errors while the sample is unwinding.
      cancellation = runtime?.shutdown().catch((error) => { result.errors.push(`Cancellation: ${String(error)}`) })
    }
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      root = await mkdtemp(join(tmpdir(), 'anas-coding-eval-'))
      root = await realpath(root)
      const workspace = join(root, 'workspace')
      searchWorkspace = workspace
      signal.throwIfAborted()
      await prepareConfig(root, task)
      if (configuredModelId) {
        const model = await getResolvedModelConfig(configuredModelId)
        if (!model) throw new Error('The evaluation model cannot be resolved.')
        result.model = { name: model.model, protocol: model.protocol, parameters: {
          providerId: model.providerId, configId: model.id, parameters: model.parameters,
          parameterPresetMode: model.parameterPresetMode, defaultParameterPresetId: model.defaultParameterPresetId,
          parameterPresets: model.parameterPresets, stream: model.stream,
          maxContextTokens: model.maxContextTokens, maxOutputTokens: model.maxOutputTokens,
          contextCompressionThreshold: model.contextCompressionThreshold, contextCompressionEnabled: model.contextCompressionEnabled
        } }
      }
      await mkdir(workspace)
      await writeFixture(workspace, task.files)
      const before = await snapshotFiles(workspace)
      const capabilities = (tools: string[], subagents = false) => ({
        ...structuredClone(defaultCapabilities), profile: false, environment: false,
        applicationEnvironment: false, memory: false, backgroundTools: false,
        subagents, planning: false, skills: { enabled: false, mode: 'custom' as const, project: false, entries: [] },
        toolMode: 'selected' as const, tools
      })
      if (task.subagent) await saveSubagent({
        name: task.subagent.name, enabled: true, description: 'Isolated file capability evaluation.',
        systemPrompt: 'Perform the assigned file operation using your available tools.',
        capabilities: capabilities(task.subagent.tools)
      })
      const project = await createProject({
        kind: 'workspace', name: 'Fixed coding evaluation', sourceFolders: [workspace],
        codingMode, advancedSettings: true, restrictSubagents: task.subagent?.restrict ?? false, prompt: '',
        capabilities: capabilities(enabledTools, Boolean(task.subagent))
      })
      const databaseFile = join(getDataDir(), 'eval.sqlite')
      const attachments = join(getDataDir(), 'attachments')
      database = AgentDatabase.open(databaseFile, attachments)
      const thread = database.createThread({ title: task.id, projectId: project.id, accessMode })
      signal.throwIfAborted()
      runtime = new AgentRuntime(database, undefined, join(root, 'temporary'))
      const modelSpy = options.kind === 'scripted-runtime' ? vi.spyOn(modelFactory, 'createChatModel') : undefined
      if (modelTrace) {
        const { createChatModel, createCompressionChatModel } = modelFactory
        vi.spyOn(modelFactory, 'createChatModel').mockImplementation((config, overrides) =>
          createChatModel(config, { ...overrides, callbacks: modelTrace.callbacks(overrides, overrides?.callbacks) }))
        vi.spyOn(modelFactory, 'createCompressionChatModel').mockImplementation((config, overrides) =>
          createCompressionChatModel(config, { ...overrides,
            callbacks: modelTrace.callbacks({ requestRole: 'compression', ...overrides }, overrides?.callbacks) }))
      }
      if (modelSpy) vi.spyOn(modelFactory, 'createCompressionChatModel').mockImplementation((_config, overrides) => {
        const model = new FakeListChatModel({ responses: [
          `Task: ${task.prompt} Resume from the retained tool results. Preserve unrelated files.`
        ] })
        const invoke = model.invoke.bind(model)
        vi.spyOn(model, 'invoke').mockImplementation((input, options) => invokeWithCompressionTracking(
          input, options, overrides?.compressionTracking ?? {}, (trackedOptions) => invoke(input, trackedOptions)
        ))
        return model
      })
      const modelRoles = new WeakMap<FakeToolCallingModel['toolCalls'], 'main' | 'subagent'>()
      const makeScript = (calls: CodingTask['calls'], role: 'main' | 'subagent') => {
        const scriptedCalls = structuredClone(calls).map((batch, batchIndex) => batch.map((call, index) => {
          const id = `eval-${randomUUID()}-${batchIndex}-${index}`
          if (call.binding) bindings.set(id, call.binding)
          if (call.search) searchCalls.set(id, call.search)
          return { name: call.name, args: call.args, id }
        }))
        const model = new FakeToolCallingModel({ toolCalls: [...scriptedCalls, []] })
        // bindTools clones the framework fake while retaining this script and index.
        modelRoles.set(model.toolCalls, role)
        return model
      }
      const useScript = (calls: CodingTask['calls']) => {
        if (!modelSpy) return
        const mainModel = makeScript(calls, 'main')
        const childModels = new Map<string, FakeToolCallingModel>()
        modelSpy.mockImplementation((_config, overrides) => {
          if (overrides?.requestRole === 'main') return mainModel
          if (overrides?.requestRole !== 'subagent' || !task.subagent || !overrides.requestId) {
            throw new Error('Unexpected model role or missing subagent evaluation script.')
          }
          let model = childModels.get(overrides.requestId)
          if (!model) {
            model = makeScript(task.subagent.calls, 'subagent')
            childModels.set(overrides.requestId, model)
          }
          return model
        })
      }
      const boundToolNames = new WeakMap<object, string[]>()
      const bindTools = FakeToolCallingModel.prototype.bindTools
      if (modelSpy) vi.spyOn(FakeToolCallingModel.prototype, 'bindTools').mockImplementation(function (this: FakeToolCallingModel, tools) {
        const bound = bindTools.call(this, tools)
        boundToolNames.set(bound, [...(boundToolNames.get(this) ?? []), ...tools.map((tool) => tool.name)])
        return bound
      })
      // The framework fake numbers messages from zero on each binding/run;
      // replayed IDs replace checkpoint history instead of appending new messages.
      const generate = FakeToolCallingModel.prototype._generate
      const modelChecks = (task.modelChecks ?? []).filter((check) => check.mode === result.mode)
      const observedModelChecks = new Set<number>()
      const scriptedModelCalls = { main: 0, subagent: 0 }
      if (modelSpy) vi.spyOn(FakeToolCallingModel.prototype, '_generate').mockImplementation(async function (this: FakeToolCallingModel, ...args) {
        await beforeGenerate?.()
        signal.throwIfAborted()
        const role = modelRoles.get(this.toolCalls)
        if (!role) throw new Error('The active model is not a registered evaluation script.')
        const names = boundToolNames.get(this)
        const actualToolName = (name: string) => {
          if (name !== 'run_shell') return name
          const shells = names?.filter(isCommandShellToolName) ?? []
          if (shells.length !== 1) throw new Error('Expected exactly one bound command shell for the search script.')
          if (result.shellToolName && result.shellToolName !== shells[0]) throw new Error('Bound command shell changed during the evaluation.')
          result.shellToolName = shells[0]
          return shells[0]
        }
        scriptedModelCalls[role] += 1
        // Observe the actual model input before generating another write. Runtime
        // event delivery can lag this boundary, so it cannot provide this counter.
        for (const [index, check] of modelChecks.entries()) if ((check.role ?? 'main') === role && check.call === scriptedModelCalls[role]) {
          const systemText = args[0].filter(SystemMessage.isInstance).map((message) => message.text).join('\n\n')
          const conversationText = args[0].filter((message) => !SystemMessage.isInstance(message)).map((message) => message.text).join('\n\n')
          result.checks.push(...await checkModelRequest({ ...check,
            toolsInclude: check.toolsInclude?.map(actualToolName),
            toolsExclude: check.toolsExclude?.flatMap((name) => name === 'run_shell'
              ? [name, ...names?.filter(isCommandShellToolName) ?? []] : [name])
          }, workspace, { systemText, conversationText, toolNames: names }))
          observedModelChecks.add(index)
        }
        const response = await generate.apply(this, args)
        for (const generation of response.generations) {
          generation.message.id = randomUUID()
          // The framework fake echoes all input, which otherwise doubles history
          // on every tool step and measures synthetic echo growth instead of tools.
          generation.message.content = 'Scripted evaluation step.'
          generation.text = 'Scripted evaluation step.'
          for (const call of AIMessage.isInstance(generation.message) ? generation.message.tool_calls ?? [] : []) {
            call.name = actualToolName(call.name)
            const binding = call.id ? bindings.get(call.id) : undefined
            if (binding) call.args = { ...call.args, ...scriptBinding(args[0], binding) }
          }
        }
        return response
      })
      async function collect(events: AsyncIterable<AgentRuntimeEvent>): Promise<void> {
        for await (const event of events) {
          if ('run' in event) observedRuns.set(event.run.id, event.run.status)
          if (event.type === 'model_started') result.modelCalls += 1
          if (event.type === 'tool_started') result.toolCalls += 1
          if (event.type === 'tool_approval_requested') result.approvalRequests += 1
          if (event.type === 'run_interrupted') for (const interrupt of event.interrupts) result.interruptions.push({
            runId: event.run.id, interruptId: interrupt.id, value: codingDiagnostic(interrupt.value),
            pathPreviews: codingDiagnostic(interrupt.pathPreviews ?? [])
          })
          if (event.type === 'tool_completed') {
            // Forwarded child events carry the parent thread/run IDs for UI
            // delivery; subagentId identifies the actual executing actor.
            const actor = event.subagentId ?? 'main'
            const executed = executedToolsByActor.get(actor) ?? new Set<string>()
            executed.add(event.call.name)
            executedToolsByActor.set(actor, executed)
            recordToolResult(event.call.id, event.call.name, event.output, 'tool-event')
            if (task.externalChange && !externalChangeInjected && result.toolOutputs.length === task.externalChange.afterTool) {
              for (const [name, content] of Object.entries(task.externalChange.files)) await writeFile(fixturePath(workspace, name), content)
              externalChangeInjected = true
            }
          }
          if (event.type === 'context_compression_completed') result.compression = 'completed'
          if (event.type === 'run_failed' && expectation?.ruleFailure && event.error.includes(expectation.ruleFailure)) {
            expectedRunFailures.push(event.error)
          } else if (event.type === 'run_failed' || event.type === 'run_recovery_failed') result.errors.push(event.error)
          if (event.type === 'run_interrupted' || event.type === 'run_cancelled') result.errors.push(`Unexpected ${event.type}; no evaluation approvals are granted automatically.`)
        }
        signal.throwIfAborted()
        // Preflight errors are native ToolMessages produced before tool dispatch;
        // they have no tool-completed event. Capture their checkpoint evidence
        // after each run, before a later compression can remove old messages.
        for (const threadId of [thread.id, ...database!.listSubagentCalls(thread.id).map((call) => call.childThreadId)]) {
          const snapshot = await runtime!.getSnapshot(threadId)
          for (const activity of snapshot.activities) for (const tool of activity.tools) {
            if (tool.status === 'completed' && tool.output !== undefined) {
              recordToolResult(tool.call.id, tool.call.name, tool.output, 'checkpoint')
            }
          }
          const checkpoint = await database!.checkpointer.getTuple({ configurable: {
            thread_id: threadId, checkpoint_ns: ''
          } })
          const messages = checkpoint?.checkpoint.channel_values.messages as BaseMessage[] | undefined
          for (const tool of toolResultsFromMessages(messages ?? [])) {
            recordToolResult(tool.id, tool.name, tool.output, 'checkpoint', tool.failed)
          }
        }
      }
      if (task.review) {
        const hooksPath = join(root, 'no-hooks')
        const git = (args: string[]) => execFileSync('git', ['-C', workspace, '-c', 'core.autocrlf=false', '-c', `core.hooksPath=${hooksPath}`, ...args], { encoding: 'utf8', timeout: 15000 })
        git(['init', '--quiet', '--template='])
        for (const [name, content] of Object.entries(task.review.baseline)) await writeFile(fixturePath(workspace, name), content)
        git(['add', '.'])
        git(['-c', 'user.name=Anas Evaluation', '-c', 'user.email=evaluation@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fixed review baseline'])
        for (const [name, content] of Object.entries(task.files)) await writeFile(fixturePath(workspace, name), content)
        const changes = await queryGitChanges({ sourceFolder: workspace, scope: 'workspace' })
        const scope = await captureCodeReview(database, {
          kind: 'git', projectId: project.id, sourceFolder: workspace, scope: 'workspace', version: changes.version
        }, project.id)
        const report = {
          scope_id: scope.id, summary: task.review.targets.length ? 'The change breaks empty input.' : 'No concrete regressions.',
          findings: task.review.targets.length ? [{ priority: 'P2', title: 'Empty arrays now throw', file_id: scope.files[0].id,
            side: 'after', start_line: 2, end_line: 2, condition: 'Calling sum([]).',
            impact: 'An empty input throws TypeError instead of returning zero.',
            evidence: 'reduce has no initial accumulator and an empty array has no first element.' }] : [], limitations: []
        }
        useScript([[{ name: codeReviewResponseFormat(scope)[0].name, args: report }]])
        await collect(runtime.startRun({ threadId: thread.id, runId: randomUUID(), text: task.prompt, codeReview: scope }))
        const snapshot = await runtime.getSnapshot(thread.id)
        const review = snapshot.messages.flatMap((message) => message.codeReview ? [message.codeReview] : []).at(-1)
        result.checks.push({ name: 'structured-review-persisted', passed: review?.report.scope_id === scope.id
          && review.locations.every((location) => location.valid) })
        if (review) {
          result.reviewReport = review
          result.reviewScore = scoreReview(scope, review.report, task.review.targets.map((target) => ({ ...target, path: fixturePath(workspace, target.path) })))
          result.checks.push({ name: 'review-location-rubric', passed: result.reviewScore.scopeMatched
            && result.reviewScore.unmatchedFindings === 0 && result.reviewScore.missedFindings === 0 })
        }
      } else if (task.compression === 'manual') {
        useScript(task.calls.slice(0, 1))
        await collect(runtime.startRun({ threadId: thread.id, runId: randomUUID(), text: task.prompt }))
        result.checks.push({ name: 'compression-preparation-read-only', passed: fingerprint(await snapshotFiles(workspace)) === fingerprint(before) })
        await collect(runtime.startCompression(thread.id))
        useScript(task.calls.slice(1))
        await collect(runtime.startRun({ threadId: thread.id, runId: randomUUID(), text: 'Continue and implement the previously requested fix.' }))
      } else {
        useScript(task.calls)
        await collect(runtime.startRun({ threadId: thread.id, runId: randomUUID(), text: task.prompt }))
      }
      const oracle = await checkTaskFiles(expectation ? { ...task, expected: expectation.expected } : task, workspace, before, signal)
      if (task.compression) result.checks.push({ name: 'compression-completed', passed: result.compression === 'completed' })
      if (modelChecks.length) result.checks.push({ name: 'all-model-request-checks-observed',
        passed: observedModelChecks.size === modelChecks.length })
      if (expectation?.modelCalls !== undefined) result.checks.push({ name: 'scripted-model-call-count',
        passed: scriptedModelCalls.main === expectation.modelCalls })
      result.evaluatorTests = oracle.behavior
      result.checks.push(...oracle.checks)
      if (options.kind === 'scripted-runtime' || task.expectedToolErrors !== undefined) {
        result.checks.push({ name: 'expected-tool-errors', passed: result.toolErrors === (expectation?.toolErrors ?? task.expectedToolErrors ?? 0) })
      }
      result.unrelatedChanges = oracle.unrelatedChanges
      if (task.externalChange) result.checks.push({ name: 'external-change-injected', passed: externalChangeInjected })
      for (const check of (task.outputChecks ?? []).filter((check) => !check.mode || check.mode === result.mode)) result.checks.push({ name: `tool-output:${check.name}`,
        passed: result.toolOutputs.some((output) => output.name === check.name && check.includes.every((text) => output.excerpt.includes(text))) })
      if (task.requireAllSelectedTools) result.checks.push({ name: 'all-selected-tools-executed',
        passed: enabledTools.every((name) => executedToolsByActor.get('main')?.has(name === 'run_shell' ? result.shellToolName! : name)) })
      if (searchCalls.size) result.checks.push({ name: 'all-search-results-verified',
        passed: result.searchOutputs.length === searchCalls.size && result.searchOutputs.every((output) => output.passed) })
      result.checks.push({ name: 'shell-capability-matches', passed: result.shellEnabled === Boolean(result.shellToolName) })
      result.checks.push({ name: 'fixed-input-unmodified', passed: fingerprint(task) === result.taskFingerprint })
      const snapshot = await runtime.getSnapshot(thread.id)
      result.checks.push({ name: expectation?.ruleFailure ? 'terminal-rule-failure' : 'terminal-completed',
        passed: observedRuns.size > 0 && [...observedRuns.values()].every((status) => status === (expectation?.ruleFailure ? 'failed' : 'completed'))
          && (!expectation?.ruleFailure || expectedRunFailures.length === 1) })
      result.checks.push({ name: 'run-configuration-matches', passed: [...observedRuns.keys()].every((runId) => {
        const configuration = database!.getRunConfiguration(runId)
        return configuration?.codingMode === codingMode
          && configuration.capabilities.toolMode === 'selected'
          && fingerprint(configuration.capabilities.tools) === fingerprint(enabledTools)
          && !configuration.capabilities.applicationEnvironment && !configuration.capabilities.skills.enabled
      }) })
      const childSnapshots = new Map<string, string>()
      if (task.subagent) {
        const calls = database.listSubagentCalls(thread.id)
        result.checks.push({ name: 'one-subagent-completed-and-observed', passed: calls.length === 1
          && calls[0].agentName === task.subagent.name && calls[0].status === 'completed'
          && database.listUnresolvedSubagentCallsForRun(calls[0].parentRunId).length === 0 })
        for (const call of calls) {
          if (task.subagent.requireAllSelectedTools) result.checks.push({ name: 'all-subagent-selected-tools-executed',
            passed: task.subagent.expectedTools.every((name) => executedToolsByActor.get(call.id)?.has(name)) })
          const configuration = database.getRunConfiguration(call.childRunId)
          result.checks.push({ name: 'subagent-run-configuration-matches', passed:
            configuration?.codingMode === codingMode && configuration.capabilities.toolMode === 'selected'
            && fingerprint([...configuration.capabilities.tools].sort()) === fingerprint([...task.subagent.expectedTools].sort())
            && !configuration.capabilities.subagents && !configuration.capabilities.skills.enabled
            && !configuration.capabilities.applicationEnvironment
            && database.getThread(call.childThreadId)?.accessMode === accessMode
            && database.getRun(call.childRunId)?.status === 'completed' })
          childSnapshots.set(call.childThreadId, fingerprint((await runtime.getSnapshot(call.childThreadId)).messages))
        }
      }
      await runtime.shutdown()
      signal.throwIfAborted()
      runtime = undefined
      database.close()
      database = AgentDatabase.open(databaseFile, attachments)
      runtime = new AgentRuntime(database, undefined, join(root, 'temporary'))
      const reopened = await runtime.getSnapshot(thread.id)
      signal.throwIfAborted()
      result.checkpointReopened = fingerprint(reopened.messages) === fingerprint(snapshot.messages) && reopened.messages.length > 0
      result.checks.push({ name: 'checkpoint-reopened', passed: result.checkpointReopened })
      for (const [childThreadId, messages] of childSnapshots) result.checks.push({ name: 'subagent-checkpoint-reopened',
        passed: fingerprint((await runtime.getSnapshot(childThreadId)).messages) === messages })
      if (expectation?.ruleFailure) {
        const checkpoint = await database.checkpointer.getTuple({ configurable: {
          thread_id: thread.id, checkpoint_ns: ''
        } })
        const rules = checkpoint?.checkpoint.channel_values.anasProjectRules as { fatalError?: string } | undefined
        result.checks.push({ name: 'rule-failure-checkpointed', passed: typeof rules?.fatalError === 'string'
          && rules.fatalError.includes(expectation.ruleFailure) })
      }
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : String(error))
    } finally {
      try {
        await cancellation
        if (runtime) await runtime.shutdown()
        database?.close()
        if (root) await rm(root, { recursive: true, force: true })
      } catch (error) {
        result.errors.push(`Cleanup: ${String(error)}`)
      }
      signal.removeEventListener('abort', abort)
      vi.restoreAllMocks()
    }
    result.elapsedMs = Math.round(performance.now() - start)
    if (expectation?.ruleFailure) result.expectedRunFailures = expectedRunFailures
    if (modelTrace) {
      const evidence = modelTrace.snapshot()
      result.modelTrace = evidence.trace
      result.tokens = evidence.tokens
      result.checks.push({ name: 'model-trace-completed', passed: evidence.trace.calls.length > 0
        && !evidence.trace.callsTruncated && evidence.trace.calls.every((call) => call.status !== 'running') })
    }
    result.status = result.errors.length === 0 && result.checks.length > 0 && result.checks.every((check) => check.passed) ? 'passed' : 'failed'
    return result
  }

  function settledSample(context: TestContext, execute: () => Promise<CodingEvaluationResult>,
    record?: (result: CodingEvaluationResult) => Promise<void>): Promise<CodingEvaluationResult> {
    const sample = execute()
    // Vitest's timeout rejects its wrapper, not the underlying async function.
    // Keep its native finish hook waiting until cancellation, cleanup and result
    // persistence settle before another sample can change the global data path.
    context.onTestFinished(async () => {
      const result = await sample
      if (context.signal.aborted && result.status === 'passed') {
        result.status = 'failed'
        result.errors.push(`Evaluation cancelled: ${String(context.signal.reason)}`)
      }
      await record?.(result)
    }, 0)
    return sample
  }

  afterAll(async () => {
    await mkdir(reportRoot, { recursive: true })
    const expectedSamples = tasks.reduce((count, task) => count + modes.length * taskAccessModes(task).length * repeats, 0)
    const configurationStable = !providerSource || options.kind !== 'provider-runtime' || fingerprint(providerSource) === fingerprint({
      models: await readFile(join(options.configDirectory, 'models.json'), 'utf8'),
      settings: await readFile(join(options.configDirectory, 'settings.json'), 'utf8')
    })
    const sourcesAtEnd = await sourceFingerprints(process.cwd(), evaluationSourceFiles())
    const changedSourceFiles = changedSources(sourcesAtStart, sourcesAtEnd)
    const report = {
      schemaVersion: 5, startedAt: suiteStartedAt, completedAt: new Date().toISOString(),
      appVersion: packageInfo.version, revision, dirty,
      environment: { platform: process.platform, architecture: process.arch, node: process.version, electron: process.versions.electron },
      suiteFingerprint: fingerprint(tasks), sourceFingerprints: sourcesAtStart,
      configurationFingerprint: providerSource ? fingerprint(providerSource) : null, configurationStable,
      changedSourceFiles, sourcesStable: changedSourceFiles.length === 0, cancellationDiagnostic, tasks,
      expectedSamples, completedSamples: results.length,
      complete: results.length === expectedSamples,
      passedSamples: results.filter((result) => result.status === 'passed').length,
      excludedCombinations: tasks.flatMap((task) => accessModes.filter((mode) => !taskAccessModes(task).includes(mode))
        .map((accessMode) => ({ taskId: task.id, accessMode, modes: ['ordinary', 'coding'],
          reason: 'This platform has no read-only Shell analyzer; no evaluation approvals are granted automatically.' }))),
      evidence: options.kind, repeats,
      pending: pendingCodingEvaluations, results
    }
    await writeFile(join(reportRoot, 'results.json'), `${JSON.stringify(report, null, 2)}\n`)
    console.info(`Coding evaluation report: ${join(reportRoot, 'results.json')}`)
    expect(changedSourceFiles, 'Evaluation source changed during the run; results do not describe a fixed revision.').toEqual([])
    expect(configurationStable, 'Provider configuration changed during the evaluation.').toBe(true)
  })

  describe(`M9 fixed coding tasks: ${options.kind}`, () => {
    for (const task of tasks) for (const codingMode of modes) for (const accessMode of taskAccessModes(task)) for (let sample = 1; sample <= repeats; sample++) {
      it(`${task.id} / ${codingMode ? 'coding' : 'ordinary'} / ${accessMode} / ${sample}`, async (context) => {
        const result = await settledSample(context, () => evaluate(task, codingMode, accessMode, context.signal, undefined, sample), async (result) => {
          results.push(result)
          // Persist each completed sample, so an interrupted suite retains its evidence.
          await mkdir(reportRoot, { recursive: true })
          await writeFile(join(reportRoot, `${task.id}-${result.mode}-${accessMode}-${sample}.json`), `${JSON.stringify(result, null, 2)}\n`)
        })
        expect(result, JSON.stringify(result)).toMatchObject({ status: 'passed' })
      })
    }
    if (options.kind === 'scripted-runtime') it('drains a cancelled model call before running the next isolated sample', async (context) => {
      const cancellationTask = codingTasks.find((task) => task.id === 'empty-sum')!
      const controller = new AbortController()
      const cancelled = await settledSample(context, () => evaluate(cancellationTask, false, 'strict_approval',
        AbortSignal.any([controller.signal, context.signal]), () => { controller.abort(new Error('Injected evaluation cancellation')) }))
      expect(cancelled.status).toBe('failed')
      expect(cancelled.errors.join('\n')).toContain('Injected evaluation cancellation')
      await expect(readFile(join(getDataDir(), 'eval.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
      const next = await settledSample(context, () => evaluate(cancellationTask, false, 'strict_approval', context.signal))
      expect(next.status, JSON.stringify(next)).toBe('passed')
      cancellationDiagnostic = 'passed'
    })
  })
}
