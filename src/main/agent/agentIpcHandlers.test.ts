import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../config/dataDir', () => ({ getDataDir: () => '/isolated-agent-ipc-data' }))

function runtimeForStorage<T extends object>(storage: { conversationForThread: (threadId: string) => object }, runtime: T) {
  return Object.assign(runtime, {
    databaseForThread: storage.conversationForThread,
    storageForOperation: () => storage,
    useStorage: (operation: (storage: object) => unknown) => operation(storage)
  })
}

function conversationStorage<T extends object>(database: T) {
  return { ...database, conversationForThread: () => database, conversationForRun: () => database, previewDatabase: () => database }
}

afterEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
})

describe('agent IPC recovery', () => {
  it('allows model changes during a run and rejects deleted selections when submitting again', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const handle = vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler) })
    const thread = { id: 'thread', status: 'running', modelConfigId: 'model' as string | undefined, modelParameterPresetId: 'removed-preset' }
    const database = { getThread: vi.fn(() => thread) }
    const runtime = {
      updateThread: vi.fn((_id, update) => ({ ...thread, ...update })),
      getRunSubmission: vi.fn(), submitRunWithAttachments: vi.fn()
    }
    const selectedModel = { id: 'model', capabilities: { vision: true }, parameterPresets: [] }
    const findResolvedModelConfig = vi.fn((_config, id) => id === 'model' ? selectedModel : undefined)
    vi.doMock('../ipcSecurity', () => ({ handleMainIpc: handle }))
    vi.doMock('./agentStorage', () => ({ AgentStorage: { open: vi.fn(() => conversationStorage(database)) } }))
    vi.doMock('./agentRuntimeCoordinator', () => ({ AgentRuntimeCoordinator: vi.fn(function (storage) { return runtimeForStorage(storage, runtime) }) }))
    vi.doMock('../config/appConfig', () => ({ getAppConfigSnapshot: vi.fn(async () => ({ defaultModelId: 'model' })), findResolvedModelConfig }))
    vi.doMock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
    const module = await import('./agentIpcHandlers')
    module.registerAgentIpcHandlers()
    const update = handlers.get('agent:threads:update')!
    await expect(update({}, thread.id, { modelConfigId: 'model', modelParameterPresetId: null })).resolves.toMatchObject({ status: 'running' })
    expect(runtime.updateThread).toHaveBeenCalledExactlyOnceWith(thread.id, { modelConfigId: 'model', modelParameterPresetId: null })
    const submit = handlers.get('agent:runs:submit')!
    const input = { requestId: '718b5ec8-dbb4-4bd2-8dd0-d9073f14185d', threadId: thread.id, text: 'Continue' }
    await expect(submit({}, input)).rejects.toThrow('Model parameter preset not found: removed-preset')
    thread.modelConfigId = 'deleted'
    await expect(submit({}, input)).rejects.toThrow('selected model or its provider no longer exists: deleted')
    thread.modelConfigId = undefined
    await expect(submit({}, input)).rejects.toThrow('No model is selected')
    expect(runtime.submitRunWithAttachments).not.toHaveBeenCalled()
  })

  it('validates activity cursors and confines subagent details to the selected run and thread', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const handle = vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler) })
    const loadEarlierActivities = vi.fn(() => ({ runId: 'run', models: [], tools: [], subagents: [] }))
    const database = {
      getRun: vi.fn((id: string) => id === 'run' ? { threadId: 'thread' } : undefined),
      getSubagentActivity: vi.fn((_runId: string, id: string) => id === 'child' ? { id: 'child', result: 'complete result' } : undefined)
    }
    vi.doMock('../ipcSecurity', () => ({ handleMainIpc: handle }))
    vi.doMock('./agentStorage', () => ({ AgentStorage: { open: vi.fn(() => conversationStorage(database)) } }))
    vi.doMock('./agentRuntimeCoordinator', () => ({ AgentRuntimeCoordinator: vi.fn(function (storage) { return runtimeForStorage(storage, { loadEarlierActivities }) }) }))
    vi.doMock('../config/appConfig', () => ({ getAppConfigSnapshot: vi.fn(), findResolvedModelConfig: vi.fn() }))
    vi.doMock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
    const module = await import('./agentIpcHandlers')
    module.registerAgentIpcHandlers()
    const earlier = handlers.get('agent:activities:loadEarlier')!
    expect(earlier({}, { threadId: 'thread', runId: 'run', beforeSequence: 120 })).toEqual({ runId: 'run', models: [], tools: [], subagents: [] })
    expect(loadEarlierActivities).toHaveBeenCalledExactlyOnceWith({ threadId: 'thread', runId: 'run', beforeSequence: 120 })
    for (const beforeSequence of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => earlier({}, { threadId: 'thread', runId: 'run', beforeSequence })).toThrow()
    }
    const detail = handlers.get('agent:activities:subagent')!
    const input = { threadId: 'thread', runId: 'run', subagentId: 'child' }
    expect(detail({}, input)).toEqual({ id: 'child', result: 'complete result' })
    expect(() => detail({}, { ...input, threadId: 'other' })).toThrow('another conversation')
    expect(() => detail({}, { ...input, runId: 'missing' })).toThrow('another conversation')
    expect(() => detail({}, { ...input, subagentId: 'missing' })).toThrow('not found')
    expect(database.getSubagentActivity).toHaveBeenCalledTimes(2)
  })

  it('captures a review once before submission and ignores renderer-supplied snapshots', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const handle = vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler) })
    const scope = { id: 'main-owned-snapshot' }
    const capture = vi.fn(async () => scope)
    const database = { getThread: vi.fn(() => ({ id: 'thread', projectId: 'project', modelConfigId: 'model' })) }
    let committed = false
    const result = { thread: { id: 'thread' }, run: { id: 'run' } }
    const runtime = { getRunSubmission: vi.fn(() => committed ? result : undefined), submitRunWithAttachments: vi.fn(async () => { committed = true; return result }) }
    vi.doMock('../ipcSecurity', () => ({ handleMainIpc: handle }))
    vi.doMock('./agentStorage', () => ({ AgentStorage: { open: vi.fn(() => conversationStorage(database)) } }))
    vi.doMock('./agentRuntimeCoordinator', () => ({ AgentRuntimeCoordinator: vi.fn(function (storage) { return runtimeForStorage(storage, runtime) }) }))
    vi.doMock('./codeReview', () => ({ captureCodeReview: capture, codeReviewPrompt: () => 'main-owned review prompt' }))
    vi.doMock('../config/appConfig', () => ({ getAppConfigSnapshot: vi.fn(async () => ({})), findResolvedModelConfig: vi.fn(() => ({ id: 'model', capabilities: { toolUse: true } })) }))
    vi.doMock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
    try {
      const module = await import('./agentIpcHandlers')
      module.registerAgentIpcHandlers()
      const submit = handlers.get('agent:runs:submit')!
      const review = { kind: 'recorded', threadId: 'thread', runId: 'source-run', version: 'a'.repeat(64), target: 'recorded' }
      const input = { requestId: '718b5ec8-dbb4-4bd2-8dd0-d9073f14185d', threadId: 'thread', text: 'Code review', displayText: 'Short title', review, codeReview: { id: 'renderer-owned' } }
      await expect(submit({}, input)).resolves.toEqual(result)
      await expect(submit({}, input)).resolves.toEqual(result)
      expect(capture).toHaveBeenCalledExactlyOnceWith(database, review, 'project')
      expect(runtime.submitRunWithAttachments).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ codeReview: scope, text: 'main-owned review prompt' }))
      expect(runtime.submitRunWithAttachments).not.toHaveBeenCalledWith(expect.objectContaining({ displayText: expect.any(String) }))
    } finally { vi.doUnmock('./codeReview') }
  })
  it('restricts Git reads to a selected source folder of the actual workspace project', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const handle = vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler) })
    const queryGitChanges = vi.fn(async () => ({ scope: 'workspace' }))
    const getProject = vi.fn(async () => ({ kind: 'workspace', sourceFolders: ['/project'] }))
    vi.doMock('electron', () => ({ ipcMain: { handle } }))
    vi.doMock('../ipcSecurity', () => ({ handleMainIpc: handle }))
    vi.doMock('../gitChanges', () => ({ queryGitChanges }))
    vi.doMock('../projectStore', () => ({ getProject, recoverProjectDeletion: vi.fn() }))
    vi.doMock('./agentStorage', () => ({ AgentStorage: { open: vi.fn() } }))
    vi.doMock('./agentRuntimeCoordinator', () => ({ AgentRuntimeCoordinator: vi.fn(function (storage) { return runtimeForStorage(storage, {}) }) }))
    vi.doMock('../config/appConfig', () => ({ getAppConfigSnapshot: vi.fn(), findResolvedModelConfig: vi.fn() }))
    vi.doMock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
    const module = await import('./agentIpcHandlers')
    module.registerAgentIpcHandlers()
    const read = handlers.get('agent:changes:git')!
    const event = { sender: { once: vi.fn() } }
    const requestId = '718b5ec8-dbb4-4bd2-8dd0-d9073f14185d'
    const input = { projectId: 'project', sourceFolder: '/project', scope: 'workspace' }
    await expect(read(event, input, requestId)).resolves.toEqual({ scope: 'workspace' })
    expect(queryGitChanges).toHaveBeenCalledExactlyOnceWith(input, expect.any(AbortSignal))
    await expect(read(event, { ...input, sourceFolder: '/outside' }, requestId)).rejects.toThrow('does not belong')
    await expect(read(event, { ...input, limit: 21 }, requestId)).rejects.toThrow()
    await expect(read(event, { ...input, force: true }, requestId)).rejects.toThrow()
    getProject.mockResolvedValueOnce({ kind: 'simple_chat', sourceFolders: ['/project'] })
    await expect(read(event, input, requestId)).rejects.toThrow('does not belong')
    expect(queryGitChanges).toHaveBeenCalledTimes(1)
    const { GitReadError } = await import('@shared/gitChanges')
    queryGitChanges.mockRejectedValueOnce(new GitReadError('not_repository', 'fatal: not a git repository'))
    await expect(read(event, input, requestId)).resolves.toEqual({ error: 'not_repository' })
    queryGitChanges.mockRejectedValueOnce(new Error('Git executable unavailable'))
    await expect(read(event, input, requestId)).resolves.toEqual({ error: 'read_failed' })
  })

  it('validates recorded-change scope and queries only runs owned by the selected conversation', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const handle = vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => { handlers.set(channel, handler) })
    const query = vi.fn(() => ({ runId: 'run', files: [] }))
    const database = { getRun: vi.fn((id: string) => id === 'run' ? { threadId: 'thread' } : undefined), fileChanges: { queryRoundFiles: query } }
    vi.doMock('electron', () => ({ ipcMain: { handle } }))
    vi.doMock('../ipcSecurity', () => ({ handleMainIpc: handle }))
    vi.doMock('./agentStorage', () => ({ AgentStorage: { open: vi.fn(() => conversationStorage(database)) } }))
    vi.doMock('./agentRuntimeCoordinator', () => ({ AgentRuntimeCoordinator: vi.fn(function (storage) { return runtimeForStorage(storage, {}) }) }))
    vi.doMock('../config/appConfig', () => ({ getAppConfigSnapshot: vi.fn(), findResolvedModelConfig: vi.fn() }))
    vi.doMock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
    const module = await import('./agentIpcHandlers')
    module.registerAgentIpcHandlers()
    const read = handlers.get('agent:changes:roundFiles')!
    const event = { sender: { once: vi.fn() } }
    const requestId = '718b5ec8-dbb4-4bd2-8dd0-d9073f14185d'
    const input = { threadId: 'thread', runId: 'run', filePath: '/project/one', limit: 5 }
    expect(await read(event, input, requestId)).toEqual({ runId: 'run', files: [] })
    expect(query).toHaveBeenCalledExactlyOnceWith(input)
    for (const invalid of [
      { ...input, threadId: 'other' }, { ...input, runId: 'missing' },
      { ...input, limit: 101 }, { ...input, after: -1 }, { ...input, version: 'invalid' },
      { ...input, maxChars: 40001 }, { ...input, extra: true }
    ]) await expect(Promise.resolve().then(() => read(event, invalid, requestId))).rejects.toThrow()
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('serializes workspace writes and waits for them before closing the database', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const handle = vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    let releaseFirstProject!: () => void
    const firstProject = new Promise<void>((resolve) => {
      releaseFirstProject = resolve
    })
    const getProject = vi.fn()
      .mockImplementationOnce(async () => firstProject)
      .mockResolvedValue({ id: 'project-2' })
    const setWorkspaceState = vi.fn()
    const close = vi.fn()
    const database = { close, setWorkspaceState }

    vi.doMock('electron', () => ({ ipcMain: { handle } }))
    vi.doMock('../ipcSecurity', () => ({ handleMainIpc: handle }))
    vi.doMock('./agentStorage', () => ({ AgentStorage: { open: vi.fn(() => conversationStorage(database)) } }))
    vi.doMock('./agentRuntimeCoordinator', () => ({ AgentRuntimeCoordinator: vi.fn(function (storage) { return runtimeForStorage(storage, {}) }) }))
    vi.doMock('../config/appConfig', () => ({
      getAppConfigSnapshot: vi.fn(),
      findResolvedModelConfig: vi.fn()
    }))
    vi.doMock('../projectStore', () => ({
      getProject,
      recoverProjectDeletion: vi.fn()
    }))
    vi.doMock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))

    const module = await import('./agentIpcHandlers')
    module.registerAgentIpcHandlers()
    const save = handlers.get('agent:workspace:set')
    if (!save) throw new Error('agent:workspace:set was not registered.')
    const firstState = {
      mode: 'new_thread',
      projectId: 'project-1',
      modelParameterPresetId: null
    }
    const secondState = {
      mode: 'new_thread',
      projectId: 'project-2',
      modelParameterPresetId: null
    }

    const firstWrite = save({}, firstState) as Promise<void>
    const secondWrite = save({}, secondState) as Promise<void>
    await vi.waitFor(() => expect(getProject).toHaveBeenCalledTimes(1))
    const closing = module.closeAgentRuntime()
    expect(close).not.toHaveBeenCalled()

    releaseFirstProject()
    await Promise.all([firstWrite, secondWrite, closing])

    expect(setWorkspaceState).toHaveBeenNthCalledWith(1, firstState)
    expect(setWorkspaceState).toHaveBeenNthCalledWith(2, secondState)
    expect(close).toHaveBeenCalledOnce()
  })

  it('coalesces duplicate submissions and returns the durable thread and run without forwarding twice', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const handle = vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    const durable = {
      thread: {
        id: 'thread-1',
        title: 'Only once',
        pinned: false,
        accessMode: 'read_only_allowed',
        status: 'running',
        userTurnCount: 1,
        createdAt: '2026-08-11T00:00:00.000Z',
        updatedAt: '2026-08-11T00:00:00.000Z'
      },
      run: {
        id: 'run-main-owned',
        threadId: 'thread-1',
        operation: 'agent',
        status: 'running',
        createdAt: '2026-08-11T00:00:00.000Z',
        updatedAt: '2026-08-11T00:00:00.000Z'
      },
      userMessage: {
        id: 'run-main-owned:input',
        role: 'user',
        runId: 'run-main-owned',
        content: [{ type: 'text', text: 'Send once' }]
      }
    } as const
    const forwardedEvent = {
      type: 'run_started' as const,
      run: durable.run,
      newUserTurn: false
    }
    const events = (async function *() { yield forwardedEvent })()
    let committed = false
    const getRunSubmission = vi.fn(() => committed ? durable : undefined)
    const submitRunWithAttachments = vi.fn(async () => {
      await barrier
      committed = true
      return { ...durable, events }
    })
    const runtime = { getRunSubmission, submitRunWithAttachments }
    const database = { close: vi.fn() }
    const AgentRuntime = vi.fn(function AgentRuntimeMock(storage) {
      return runtimeForStorage(storage, runtime)
    })
    const firstSender = {
      id: 1,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn()
    }
    const selectedModel = {
      id: 'model-1',
      capabilities: { vision: true },
      parameterPresets: [{ id: 'thinking-on', name: 'Thinking on', parameters: { enable_thinking: true } }],
      defaultParameterPresetId: 'thinking-on'
    }
    const getAppConfigSnapshot = vi.fn(async () => ({ defaultModelId: selectedModel.id }))
    const findResolvedModelConfig = vi.fn(() => selectedModel)

    vi.doMock('electron', () => ({ ipcMain: { handle } }))
    vi.doMock('../ipcSecurity', () => ({ handleMainIpc: handle }))
    vi.doMock('./agentStorage', () => ({ AgentStorage: { open: vi.fn(() => conversationStorage(database)) } }))
    vi.doMock('./agentRuntimeCoordinator', () => ({ AgentRuntimeCoordinator: AgentRuntime }))
    vi.doMock('../config/appConfig', () => ({
      getAppConfigSnapshot,
      findResolvedModelConfig
    }))
    vi.doMock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))

    const module = await import('./agentIpcHandlers')
    module.registerAgentIpcHandlers()
    const submit = handlers.get('agent:runs:submit')
    if (!submit) throw new Error('agent:runs:submit was not registered.')
    const input = {
      requestId: '718b5ec8-dbb4-4bd2-8dd0-d9073f14185d',
      newThread: { title: 'Only once', projectId: 'default-workspace' },
      text: 'Send once'
    }

    const first = submit({ sender: firstSender }, input)
    const second = submit({ sender: { ...firstSender, id: 2 } }, input)
    await vi.waitFor(() => expect(submitRunWithAttachments).toHaveBeenCalledOnce())
    release()

    await expect(Promise.all([first, second])).resolves.toEqual([durable, durable])
    await expect(submit({ sender: { ...firstSender, id: 3 } }, input)).resolves.toEqual(durable)
    expect(getAppConfigSnapshot).toHaveBeenCalledOnce()
    expect(submitRunWithAttachments).toHaveBeenCalledOnce()
    expect(submitRunWithAttachments).toHaveBeenCalledWith(expect.objectContaining({
      newThread: expect.objectContaining({
        modelConfigId: 'model-1',
        modelParameterPresetId: 'thinking-on'
      })
    }))
    await vi.waitFor(() => expect(firstSender.send).toHaveBeenCalledOnce())
    expect(firstSender.send).toHaveBeenCalledWith(
      'agent:event',
      expect.objectContaining({ event: forwardedEvent })
    )
  })

  it('continues forwarding an existing run to a replacement renderer subscriber', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const handle = vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    let releaseFirst!: () => void
    let releaseSecond!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve })
    const run = {
      id: 'replacement-run',
      threadId: 'replacement-thread',
      operation: 'agent' as const,
      status: 'running' as const,
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z'
    }
    const firstEvent = {
      type: 'run_started' as const,
      run,
      newUserTurn: false
    }
    const secondEvent = {
      type: 'model_delta' as const,
      runId: run.id,
      threadId: run.threadId,
      modelId: 'model-1',
      delta: { type: 'text' as const, text: 'Still running' }
    }
    const previewEvent = {
      type: 'model_tool_calls' as const, runId: run.id, threadId: run.threadId, modelId: 'model-1',
      progress: [{ index: 0, name: 'apply_patch', characterCount: 6, complete: false }]
    }
    const events = (async function *() {
      await firstGate
      yield firstEvent
      await secondGate
      yield secondEvent
      for (let index = 0; index < 100; index++) yield previewEvent
    })()
    const runtime = {
      recoverRun: vi.fn(() => events),
      shutdown: vi.fn(async () => ({
        drained: true,
        lingeringRunIds: [],
        lingeringCallIds: []
      }))
    }
    let firstDestroyed = false
    let onFirstDestroyed: (() => void) | undefined
    const firstSender = {
      isDestroyed: vi.fn(() => firstDestroyed),
      send: vi.fn(),
      once: vi.fn((name: string, listener: () => void) => {
        if (name === 'destroyed') onFirstDestroyed = listener
      })
    }
    const secondSender = {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn()
    }

    vi.doMock('electron', () => ({ ipcMain: { handle } }))
    vi.doMock('../ipcSecurity', () => ({ handleMainIpc: handle }))
    vi.doMock('./agentStorage', () => ({
      AgentStorage: { open: vi.fn(() => conversationStorage({ close: vi.fn() })) }
    }))
    vi.doMock('./agentRuntimeCoordinator', () => ({
      AgentRuntimeCoordinator: vi.fn(function AgentRuntimeMock(storage) { return runtimeForStorage(storage, runtime) })
    }))
    vi.doMock('../config/appConfig', () => ({
      getAppConfigSnapshot: vi.fn(),
      findResolvedModelConfig: vi.fn()
    }))
    vi.doMock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))

    const module = await import('./agentIpcHandlers')
    module.registerAgentIpcHandlers()
    const recover = handlers.get('agent:runs:recover')
    const subscribe = handlers.get('agent:events:subscribe')
    if (!recover || !subscribe) throw new Error('Agent event handlers were not registered.')

    expect(recover({ sender: firstSender }, 'replacement-thread')).toBe(true)
    releaseFirst()
    await vi.waitFor(() => expect(firstSender.send).toHaveBeenCalledWith(
      'agent:event',
      expect.objectContaining({ event: firstEvent })
    ))

    firstDestroyed = true
    onFirstDestroyed?.()
    const subscription = subscribe({ sender: secondSender }) as {
      replay: Array<{ event: unknown }>
    }
    expect(subscription.replay.map((envelope) => envelope.event)).toEqual([firstEvent])
    subscribe({ sender: secondSender }, { afterRevision: 0 })
    expect(secondSender.once).toHaveBeenCalledOnce()
    releaseSecond()

    await vi.waitFor(() => expect(secondSender.send).toHaveBeenCalledWith(
      'agent:event',
      expect.objectContaining({ event: secondEvent })
    ))
    expect(firstSender.send).not.toHaveBeenCalledWith(
      'agent:event',
      expect.objectContaining({ event: secondEvent })
    )
    const compacted = subscribe({ sender: secondSender }, { afterRevision: 1 }) as {
      replay: Array<{ event: { type: string } }>; replayComplete: boolean
    }
    expect(compacted.replay.filter(({ event }) => event.type === 'model_tool_calls')).toHaveLength(1)
    expect(compacted.replayComplete).toBe(true)
    await module.closeAgentRuntime()
  })

  it('retains interrupted-run replay through nested subagent output and releases it at settlement', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const handle = vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    let releaseParentSettlement!: () => void
    let releaseNestedSettlement!: () => void
    const parentSettlementGate = new Promise<void>((resolve) => {
      releaseParentSettlement = resolve
    })
    const nestedSettlementGate = new Promise<void>((resolve) => {
      releaseNestedSettlement = resolve
    })
    const runningRun = {
      id: 'interrupted-parent-run',
      threadId: 'interrupted-parent-thread',
      operation: 'agent' as const,
      status: 'running' as const,
      createdAt: '2026-08-11T00:00:00.000Z',
      updatedAt: '2026-08-11T00:00:00.000Z'
    }
    const interruptedRun = { ...runningRun, status: 'interrupted' as const }
    const parentActivity = {
      id: 'parent-subagent',
      name: 'parent',
      sequence: 1,
      status: 'running' as const
    }
    const nestedActivity = {
      id: 'nested-subagent',
      name: 'nested',
      sequence: 2,
      status: 'running' as const,
      parentSubagentId: parentActivity.id
    }
    const initialDelta = {
      type: 'model_delta' as const,
      runId: runningRun.id,
      threadId: runningRun.threadId,
      modelId: 'nested-model-1',
      subagentId: nestedActivity.id,
      delta: { type: 'text' as const, text: 'before resume' }
    }
    const resumedDelta = {
      ...initialDelta,
      delta: { type: 'text' as const, text: 'after resume' }
    }
    const firstEvents = (async function *() {
      yield { type: 'run_started' as const, run: runningRun, newUserTurn: false as const }
      // The durable call lookup must also cover the case where interruption is
      // projected before queued subagent activity updates reach this publisher.
      yield { type: 'run_interrupted' as const, run: interruptedRun, interrupts: [] }
      yield {
        type: 'subagent_updated' as const,
        runId: runningRun.id,
        threadId: runningRun.threadId,
        subagent: parentActivity
      }
      yield {
        type: 'subagent_updated' as const,
        runId: runningRun.id,
        threadId: runningRun.threadId,
        subagent: nestedActivity
      }
      yield initialDelta
    })()
    const secondEvents = (async function *() {
      yield { type: 'run_started' as const, run: runningRun, newUserTurn: false as const }
      yield resumedDelta
      yield { type: 'run_interrupted' as const, run: interruptedRun, interrupts: [] }
      await parentSettlementGate
      yield {
        type: 'subagent_updated' as const,
        runId: runningRun.id,
        threadId: runningRun.threadId,
        subagent: { ...parentActivity, status: 'completed' as const }
      }
      await nestedSettlementGate
      yield {
        type: 'subagent_updated' as const,
        runId: runningRun.id,
        threadId: runningRun.threadId,
        subagent: { ...nestedActivity, status: 'completed' as const }
      }
    })()
    const recoveryFailedRun = {
      ...runningRun,
      id: 'recovery-failed-run',
      threadId: 'recovery-failed-thread'
    }
    const recoveryFailedEvent = {
      type: 'run_recovery_failed' as const,
      run: recoveryFailedRun,
      error: 'checkpoint unavailable'
    }
    const recoveryFailedEvents = (async function *() {
      yield {
        type: 'run_started' as const,
        run: recoveryFailedRun,
        newUserTurn: false as const
      }
      yield recoveryFailedEvent
    })()
    const runtime = {
      recoverRun: vi.fn()
        .mockReturnValueOnce(firstEvents)
        .mockReturnValueOnce(secondEvents)
        .mockReturnValueOnce(recoveryFailedEvents),
      shutdown: vi.fn(async () => ({
        drained: true,
        lingeringRunIds: [],
        lingeringCallIds: []
      }))
    }
    const activeCalls = {
      [runningRun.id]: [{
        id: parentActivity.id,
        childRunId: 'parent-child-run',
        status: 'running'
      }],
      'parent-child-run': [{
        id: nestedActivity.id,
        childRunId: 'nested-child-run',
        status: 'running'
      }]
    }
    const database = {
      close: vi.fn(),
      listSubagentCallsForParentRun: vi.fn((runId: string) => (
        activeCalls[runId as keyof typeof activeCalls] ?? []
      ))
    }
    const sender = {
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn()
    }
    const subscriptionSender = () => ({
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn()
    })

    vi.doMock('electron', () => ({ ipcMain: { handle } }))
    vi.doMock('../ipcSecurity', () => ({ handleMainIpc: handle }))
    vi.doMock('./agentStorage', () => ({
      AgentStorage: { open: vi.fn(() => conversationStorage(database)) }
    }))
    vi.doMock('./agentRuntimeCoordinator', () => ({
      AgentRuntimeCoordinator: vi.fn(function AgentRuntimeMock(storage) { return runtimeForStorage(storage, runtime) })
    }))
    vi.doMock('../config/appConfig', () => ({
      getAppConfigSnapshot: vi.fn(),
      findResolvedModelConfig: vi.fn()
    }))
    vi.doMock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))

    const module = await import('./agentIpcHandlers')
    module.registerAgentIpcHandlers()
    const recover = handlers.get('agent:runs:recover')
    const subscribe = handlers.get('agent:events:subscribe')
    if (!recover || !subscribe) throw new Error('Agent event handlers were not registered.')

    expect(recover({ sender }, runningRun.threadId)).toBe(true)
    await vi.waitFor(() => expect(sender.send).toHaveBeenCalledWith(
      'agent:event',
      expect.objectContaining({ event: initialDelta, replayActive: true })
    ))
    const interruptedReplay = subscribe({ sender: subscriptionSender() }) as {
      replay: Array<{ event: { type: string }; replayActive: boolean }>
    }
    expect(interruptedReplay.replay[0]?.event.type).toBe('run_started')
    expect(interruptedReplay.replay.at(-1)?.replayActive).toBe(true)

    expect(recover({ sender }, runningRun.threadId)).toBe(true)
    await vi.waitFor(() => expect(sender.send).toHaveBeenCalledWith(
      'agent:event',
      expect.objectContaining({ event: resumedDelta, replayActive: true })
    ))
    const resumedReplay = subscribe({ sender: subscriptionSender() }) as {
      replay: Array<{ event: unknown }>
    }
    expect(resumedReplay.replay.map(({ event }) => event)).toEqual(expect.arrayContaining([
      initialDelta,
      resumedDelta
    ]))
    expect(resumedReplay.replay[0]?.event).toMatchObject({ type: 'run_started' })

    releaseParentSettlement()
    await vi.waitFor(() => expect(sender.send).toHaveBeenCalledWith(
      'agent:event',
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'subagent_updated',
          subagent: expect.objectContaining({ id: parentActivity.id, status: 'completed' })
        }),
        replayActive: true
      })
    ))
    const nestedStillRunning = subscribe({ sender: subscriptionSender() }) as {
      replay: Array<{ event: { type: string } }>
    }
    expect(nestedStillRunning.replay[0]?.event.type).toBe('run_started')

    releaseNestedSettlement()
    await vi.waitFor(() => expect(sender.send).toHaveBeenCalledWith(
      'agent:event',
      expect.objectContaining({
        event: expect.objectContaining({
          type: 'subagent_updated',
          subagent: expect.objectContaining({ id: nestedActivity.id, status: 'completed' })
        }),
        replayActive: false
      })
    ))
    const settledReplay = subscribe({ sender: subscriptionSender() }) as {
      replay: unknown[]
    }
    expect(settledReplay.replay).toEqual([])

    expect(recover({ sender }, recoveryFailedRun.threadId)).toBe(true)
    await vi.waitFor(() => expect(sender.send).toHaveBeenCalledWith(
      'agent:event',
      expect.objectContaining({ event: recoveryFailedEvent, replayActive: false })
    ))
    const recoveryFailedReplay = subscribe({ sender: subscriptionSender() }) as {
      replay: unknown[]
    }
    expect(recoveryFailedReplay.replay).toEqual([])
    await module.closeAgentRuntime()
  })

  it('releases a failed main-process submission so the same request can retry immediately', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const handle = vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    const durable = {
      thread: {
        id: 'retry-thread',
        title: 'Retry',
        pinned: false,
        accessMode: 'read_only_allowed',
        status: 'running',
        userTurnCount: 1,
        createdAt: '2026-08-11T00:00:00.000Z',
        updatedAt: '2026-08-11T00:00:00.000Z'
      },
      run: {
        id: 'retry-run',
        threadId: 'retry-thread',
        operation: 'agent',
        status: 'running',
        createdAt: '2026-08-11T00:00:00.000Z',
        updatedAt: '2026-08-11T00:00:00.000Z'
      }
    } as const
    const runtime = {
      getRunSubmission: vi.fn(() => undefined),
      submitRunWithAttachments: vi.fn(async () => durable)
    }
    const getAppConfigSnapshot = vi.fn()
      .mockRejectedValueOnce(new Error('configuration unavailable'))
      .mockResolvedValueOnce({ defaultModelId: 'model-1' })
    const findResolvedModelConfig = vi.fn(() => ({ id: 'model-1', capabilities: { vision: true } }))

    vi.doMock('electron', () => ({ ipcMain: { handle } }))
    vi.doMock('../ipcSecurity', () => ({ handleMainIpc: handle }))
    vi.doMock('./agentStorage', () => ({ AgentStorage: { open: vi.fn(() => conversationStorage({ close: vi.fn() })) } }))
    vi.doMock('./agentRuntimeCoordinator', () => ({
      AgentRuntimeCoordinator: vi.fn(function AgentRuntimeMock(storage) {
        return runtimeForStorage(storage, runtime)
      })
    }))
    vi.doMock('../config/appConfig', () => ({
      getAppConfigSnapshot,
      findResolvedModelConfig
    }))
    vi.doMock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))

    const module = await import('./agentIpcHandlers')
    module.registerAgentIpcHandlers()
    const submit = handlers.get('agent:runs:submit')
    if (!submit) throw new Error('agent:runs:submit was not registered.')
    const input = {
      requestId: 'dfbbb9f0-ed7f-428a-8ab4-b168f7eb3c91',
      newThread: { title: 'Retry', projectId: 'default-workspace' },
      text: 'Retry me'
    }

    await expect(submit({ sender: { id: 1 } }, input)).rejects.toThrow('configuration unavailable')
    await expect(submit({ sender: { id: 1 } }, input)).resolves.toEqual(durable)
    expect(getAppConfigSnapshot).toHaveBeenCalledTimes(2)
    expect(runtime.submitRunWithAttachments).toHaveBeenCalledOnce()
  })

  it('starts recovery only after the renderer explicitly accepts the initial snapshot', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const handle = vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    const recoveryEvent = {
      type: 'run_settled' as const,
      runId: 'run-1',
      threadId: 'thread-1',
      operation: 'agent' as const,
      status: 'completed' as const
    }
    const recoveryEvents = (async function *() { yield recoveryEvent })()
    const snapshot = { thread: { id: 'thread-1' } }
    const recoverRun = vi.fn()
      .mockReturnValueOnce(recoveryEvents)
      .mockReturnValue(undefined)
    const getSnapshot = vi.fn().mockResolvedValue(snapshot)
    const loadEarlierMessages = vi.fn().mockResolvedValue(snapshot)
    const shutdown = vi.fn(async (_options: { timeoutMs: number }) => ({
      drained: true,
      lingeringRunIds: [],
      lingeringCallIds: []
    }))
    const runtime = { recoverRun, getSnapshot, loadEarlierMessages, shutdown }
    const close = vi.fn()
    const database = { close }
    const open = vi.fn(() => database)
    const AgentRuntime = vi.fn(function AgentRuntimeMock(storage) {
      return runtimeForStorage(storage, runtime)
    })

    vi.doMock('electron', () => ({ ipcMain: { handle } }))
    vi.doMock('../ipcSecurity', () => ({ handleMainIpc: handle }))
    vi.doMock('./agentStorage', () => ({ AgentStorage: { open: () => conversationStorage(open()) } }))
    vi.doMock('./agentRuntimeCoordinator', () => ({ AgentRuntimeCoordinator: AgentRuntime }))
    vi.doMock('../config/appConfig', () => ({
      getAppConfigSnapshot: vi.fn(),
      findResolvedModelConfig: vi.fn()
    }))
    vi.doMock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))

    const module = await import('./agentIpcHandlers')
    module.registerAgentIpcHandlers()
    const getThread = handlers.get('agent:threads:get')
    if (!getThread) throw new Error('agent:threads:get was not registered.')
    const recover = handlers.get('agent:runs:recover')
    if (!recover) throw new Error('agent:runs:recover was not registered.')
    const loadEarlier = handlers.get('agent:messages:loadEarlier')
    if (!loadEarlier) throw new Error('agent:messages:loadEarlier was not registered.')
    const sender = {
      id: 1,
      isDestroyed: vi.fn(() => false),
      send: vi.fn(),
      once: vi.fn()
    }

    await expect(getThread({ sender }, 'thread-1')).resolves.toBe(snapshot)
    await expect(getThread({ sender }, 'thread-1')).resolves.toBe(snapshot)
    await expect(loadEarlier({}, {
      threadId: 'thread-1',
      beforeIndex: 10
    })).resolves.toBe(snapshot)

    expect(recoverRun).not.toHaveBeenCalled()
    expect(sender.send).not.toHaveBeenCalled()
    expect(loadEarlierMessages).toHaveBeenCalledWith({
      threadId: 'thread-1',
      beforeIndex: 10
    })

    expect(recover({ sender }, 'thread-1')).toBe(true)
    await vi.waitFor(() => expect(sender.send).toHaveBeenCalledOnce())
    expect(recover({ sender }, 'thread-1')).toBe(false)

    expect(recoverRun).toHaveBeenNthCalledWith(1, 'thread-1')
    expect(recoverRun).toHaveBeenNthCalledWith(2, 'thread-1')
    expect(getSnapshot).toHaveBeenCalledTimes(2)
    expect(sender.send).toHaveBeenCalledWith(
      'agent:event',
      expect.objectContaining({ event: recoveryEvent })
    )

    await module.closeAgentRuntime()
    expect(shutdown).toHaveBeenCalledOnce()
    const remaining = shutdown.mock.calls[0]?.[0]?.timeoutMs
    expect(remaining).toBeGreaterThan(0)
    expect(remaining).toBeLessThanOrEqual(5_000)
    expect(close).toHaveBeenCalledOnce()
  })

  it('saves the complete captured model request selected by the user', async () => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const handle = vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
    const writeFile = vi.fn(async () => {})
    const showModalSaveDialog = vi.fn(async () => ({
      canceled: false,
      filePath: '/tmp/complete-model-request.json'
    }))

    vi.doMock('electron', () => ({ ipcMain: { handle } }))
    vi.doMock('node:fs/promises', async (importOriginal) => ({
      ...await importOriginal<typeof import('node:fs/promises')>(),
      writeFile
    }))
    vi.doMock('../ipcSecurity', () => ({ handleMainIpc: handle }))
    vi.doMock('../modalDialog', () => ({
      dialogParentFromEvent: vi.fn(() => undefined),
      showModalSaveDialog
    }))
    vi.doMock('./agentStorage', () => ({ AgentStorage: { open: vi.fn() } }))
    vi.doMock('./agentRuntimeCoordinator', () => ({ AgentRuntimeCoordinator: vi.fn(function (storage) { return runtimeForStorage(storage, {}) }) }))
    vi.doMock('../config/appConfig', () => ({
      getAppConfigSnapshot: vi.fn(),
      findResolvedModelConfig: vi.fn()
    }))
    vi.doMock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))

    const module = await import('./agentIpcHandlers')
    module.registerAgentIpcHandlers()
    const save = handlers.get('agent:context:saveModelRequest')
    if (!save) throw new Error('agent:context:saveModelRequest was not registered.')
    const content = '{"authorization":"Bearer complete-api-key"}'

    await expect(save({ sender: { id: 1 } }, content))
      .resolves.toBe('/tmp/complete-model-request.json')
    expect(writeFile).toHaveBeenCalledWith(
      '/tmp/complete-model-request.json',
      `${content}\n`,
      'utf8'
    )
  })
})
