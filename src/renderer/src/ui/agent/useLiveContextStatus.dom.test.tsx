import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentContextStatus } from '@shared/agentTypes'
import { defaultModelConfig, modelContextKey } from '@shared/modelConfig'
import type { AppConfigSnapshot, Project, ResolvedModelConfig } from '@shared/types'
import { defaultCapabilities } from '@shared/agentCapabilities'
import { useLiveContextStatus } from './useLiveContextStatus'

const model: ResolvedModelConfig = {
  ...defaultModelConfig, id: 'model', providerId: 'provider', providerName: 'Provider',
  displayName: 'Model', model: 'model', baseUrl: 'https://example.test/v1',
  protocol: 'anthropic_messages', maxContextTokens: 10_000, maxOutputTokens: 1_000
}
function contextStatus(config = model, tokens = 100): AgentContextStatus {
  return {
    runId: 'run',
    modelConfigId: config.id, modelContextKey: modelContextKey(config),
    maxContextTokens: config.maxContextTokens, maxOutputTokens: config.maxOutputTokens,
    inputCapacityTokens: 9_000, estimatedInputTokens: tokens, currentContextTokens: tokens,
    compressionEnabled: true, compressionThreshold: 0.8, compressionThresholdTokens: 7_200,
    compressionApplied: false, manualCompressionAvailable: true,
    breakdown: { profileTokens: 0, systemInstructionTokens: 0, runtimeContextTokens: 0,
      workspaceTokens: 0, memoryTokens: 0, skillTokens: 0, toolDefinitionTokens: 0,
      messageTokens: tokens, attachmentTokens: 0 }
  }
}
const continuation = { config: undefined, project: undefined, continuationRunId: 'run', continuationStatus: 'running' as const,
  liveStatus: contextStatus() }
const project: Project = {
  id: 'project', name: 'Project', kind: 'workspace', sourceFolders: ['C:/workspace'],
  advancedSettings: true, prompt: 'Project instructions.', codingMode: false,
  capabilities: structuredClone(defaultCapabilities), restrictSubagents: false,
  pinned: false, collapsed: false, createdAt: '', updatedAt: ''
}
function installStatusReader(reader: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('gale', { agent: { context: { status: reader } } })
}

afterEach(() => vi.unstubAllGlobals())

describe('useLiveContextStatus', () => {
  it('reprojects after a protocol edit without using an old estimate under the new identity', async () => {
    let finish!: (status: AgentContextStatus) => void
    const reader = vi.fn(() => new Promise<AgentContextStatus>((resolve) => { finish = resolve }))
    installStatusReader(reader)
    const reported = contextStatus()
    const { result, rerender } = renderHook(({ selected }) => useLiveContextStatus('thread', selected, reported, continuation), {
      initialProps: { selected: model }
    })
    expect(result.current?.estimatedInputTokens).toBe(100)
    expect(reader).not.toHaveBeenCalled()
    const edited: ResolvedModelConfig = { ...model, protocol: 'openai_chat_completions' }
    rerender({ selected: edited })
    expect(result.current).toBeUndefined()
    await act(async () => finish(contextStatus(edited, 2_300)))
    expect(result.current?.estimatedInputTokens).toBe(2_300)
    expect(result.current?.breakdown.messageTokens).toBe(2_300)
  })

  it('ignores stale refreshes across rapid model and thread switches', async () => {
    const finish: Array<(status: AgentContextStatus) => void> = []
    installStatusReader(vi.fn(() => new Promise<AgentContextStatus>((resolve) => finish.push(resolve))))
    const changed = { ...model, parameters: { temperature: 0.2 } }
    const reported = contextStatus()
    const { result, rerender } = renderHook(({ thread, selected }) => useLiveContextStatus(thread, selected, reported, continuation), {
      initialProps: { thread: 'one', selected: changed }
    })
    rerender({ thread: 'two', selected: changed })
    await act(async () => finish[0](contextStatus(changed, 400)))
    expect(result.current).toBeUndefined()
    await act(async () => finish[1](contextStatus(changed, 800)))
    expect(result.current?.estimatedInputTokens).toBe(800)
    rerender({ thread: 'two', selected: { ...changed, model: 'other' } })
    expect(result.current).toBeUndefined()
  })

  it('updates capacity immediately without a request; invalid identities hide the display', async () => {
    const reader = vi.fn().mockResolvedValue(contextStatus())
    installStatusReader(reader)
    const reported = contextStatus()
    const { result, rerender } = renderHook(({ selected }) => useLiveContextStatus('thread', selected, reported, continuation), {
      initialProps: { selected: model }
    })
    await waitFor(() => expect(result.current?.estimatedInputTokens).toBe(100))
    rerender({ selected: { ...model, maxContextTokens: 20_000 } })
    expect(result.current?.inputCapacityTokens).toBe(19_000)
    expect(reader).not.toHaveBeenCalled()
    reader.mockRejectedValue(new Error('selected model was deleted'))
    rerender({ selected: { ...model, id: 'missing' } })
    await waitFor(() => expect(reader).toHaveBeenCalledWith('thread'))
    expect(result.current).toBeUndefined()
  })

  it.each(['name', 'prompt', 'coding', 'tools'] as const)('reprojects an idle conversation after its project %s changes', async (change) => {
    const reader = vi.fn().mockResolvedValue(contextStatus(model, 300))
    installStatusReader(reader)
    const reported = contextStatus()
    const { result, rerender } = renderHook(({ currentProject }) => useLiveContextStatus('thread', model, reported, {
      config: undefined, project: currentProject, continuationRunId: undefined
    }), { initialProps: { currentProject: project } })
    expect(result.current).toBeUndefined()
    await waitFor(() => expect(result.current?.estimatedInputTokens).toBe(300))
    reader.mockResolvedValue(contextStatus(model, 800))
    rerender({ currentProject: { ...project,
      ...(change === 'name' ? { name: 'Renamed workspace' } : {}),
      ...(change === 'prompt' ? { prompt: 'Revised project instructions.' } : {}),
      ...(change === 'coding' ? { codingMode: true } : {}),
      ...(change === 'tools' ? { capabilities: { ...project.capabilities, planning: !project.capabilities.planning } } : {})
    } })
    expect(result.current).toBeUndefined()
    await waitFor(() => expect(result.current?.estimatedInputTokens).toBe(800))
  })

  it('reprojects product settings but reuses a current idle estimate for model budgets and appearance changes', async () => {
    const reader = vi.fn().mockResolvedValue(contextStatus(model, 300))
    installStatusReader(reader)
    const reported = contextStatus()
    const config = { settings: { attachmentTextMaxChars: 1000, fontSize: 14 } } as AppConfigSnapshot
    const { result, rerender } = renderHook(({ currentConfig, selected }) => useLiveContextStatus('thread', selected, reported, {
      config: currentConfig, project, continuationRunId: undefined
    }), { initialProps: { currentConfig: config, selected: model } })
    await waitFor(() => expect(result.current?.estimatedInputTokens).toBe(300))
    reader.mockResolvedValue(contextStatus(model, 900))
    const changed = { ...config, settings: { ...config.settings, attachmentTextMaxChars: 3000 } }
    rerender({ currentConfig: changed, selected: model })
    await waitFor(() => expect(result.current?.estimatedInputTokens).toBe(900))
    const calls = reader.mock.calls.length
    rerender({ currentConfig: { ...changed, settings: { ...changed.settings, fontSize: 18 } },
      selected: { ...model, maxContextTokens: 20_000 } })
    expect(result.current?.estimatedInputTokens).toBe(900)
    expect(result.current?.inputCapacityTokens).toBe(19_000)
    expect(reader.mock.calls).toHaveLength(calls)
  })

  it('keeps running product settings until the run ends and then refreshes the same model', async () => {
    const reader = vi.fn().mockResolvedValue(contextStatus())
    installStatusReader(reader)
    const reported = contextStatus()
    const { result, rerender } = renderHook(({ currentProject, runId }) => useLiveContextStatus('thread', model, reported, {
      config: undefined, project: currentProject, continuationRunId: runId,
      continuationStatus: runId ? 'running' : undefined, liveStatus: reported
    }), { initialProps: { currentProject: project, runId: 'run' as string | undefined } })
    await waitFor(() => expect(result.current?.estimatedInputTokens).toBe(100))
    const changed = { ...project, codingMode: true, prompt: 'New instructions for the next run.' }
    rerender({ currentProject: changed, runId: 'run' })
    expect(result.current?.estimatedInputTokens).toBe(100)
    expect(reader).not.toHaveBeenCalled()
    reader.mockResolvedValue(contextStatus(model, 700))
    rerender({ currentProject: changed, runId: undefined })
    expect(result.current).toBeUndefined()
    await waitFor(() => expect(result.current?.estimatedInputTokens).toBe(700))
  })

  it.each(['profile', 'prompt', 'attachments'] as const)('reprojects an interrupted continuation after its %s changes', async (change) => {
    const reader = vi.fn().mockResolvedValue({ ...contextStatus(model, 300), includeProjectRules: false })
    installStatusReader(reader)
    const reported = contextStatus()
    const config = { settings: { profile: { assistant: { instructions: 'Original profile.' } }, attachmentTextMaxChars: 1000 } } as AppConfigSnapshot
    const { result, rerender } = renderHook(({ currentConfig, currentProject }) => useLiveContextStatus('thread', model, reported, {
      config: currentConfig, project: currentProject, continuationRunId: 'run', continuationStatus: 'interrupted'
    }), { initialProps: { currentConfig: config, currentProject: { ...project, codingMode: true } } })
    await waitFor(() => expect(result.current?.estimatedInputTokens).toBe(300))
    const changedConfig = structuredClone(config)
    if (change === 'profile') changedConfig.settings.profile.assistant.instructions = 'Expanded profile context.'
    if (change === 'attachments') changedConfig.settings.attachmentTextMaxChars = 5000
    const changedProject = { ...project, codingMode: true, ...(change === 'prompt' ? { prompt: 'Expanded project context.' } : {}) }
    reader.mockResolvedValue({ ...contextStatus(model, 900), includeProjectRules: false })
    rerender({ currentConfig: changedConfig, currentProject: changedProject })
    expect(result.current).toBeUndefined()
    await waitFor(() => expect(result.current?.estimatedInputTokens).toBe(900))
    // The runtime still owns the saved run's coding/capability configuration.
    expect(result.current?.includeProjectRules).toBe(false)
  })

  it('rejects old reports and pending previews when the same run resumes, then accepts a new live report', async () => {
    const finish: Array<(status: AgentContextStatus) => void> = []
    const reader = vi.fn(() => new Promise<AgentContextStatus>((resolve) => finish.push(resolve)))
    installStatusReader(reader)
    const reported = contextStatus()
    const { result, rerender } = renderHook(({ state, currentProject, liveStatus }) => useLiveContextStatus('thread', model, reported, {
      config: undefined, project: currentProject, continuationRunId: 'run', continuationStatus: state, liveStatus
    }), { initialProps: { state: 'running' as 'running' | 'interrupted', currentProject: project, liveStatus: undefined as AgentContextStatus | undefined } })
    await act(async () => finish[0](contextStatus(model, 100)))
    expect(result.current?.estimatedInputTokens).toBe(100)
    rerender({ state: 'interrupted', currentProject: project, liveStatus: undefined })
    const changed = { ...project, prompt: 'Instructions used when the graph is rebuilt.' }
    rerender({ state: 'interrupted', currentProject: changed, liveStatus: undefined })
    await act(async () => finish[1](contextStatus(model, 200)))
    expect(result.current).toBeUndefined()
    rerender({ state: 'running', currentProject: changed, liveStatus: undefined })
    await act(async () => finish[2](contextStatus(model, 800)))
    expect(result.current).toBeUndefined()
    const fresh = contextStatus(model, 1200)
    rerender({ state: 'running', currentProject: changed, liveStatus: fresh })
    expect(result.current?.estimatedInputTokens).toBe(1200)
    await act(async () => finish[3](contextStatus(model, 900)))
    expect(result.current?.estimatedInputTokens).toBe(1200)
    rerender({ state: 'running', currentProject: { ...changed, prompt: 'For the next reconstruction.' }, liveStatus: fresh })
    expect(result.current?.estimatedInputTokens).toBe(1200)
    expect(reader).toHaveBeenCalledTimes(4)
  })

  it('ignores stale idle refreshes after project changes and thread switches with the same model', async () => {
    const finish: Array<(status: AgentContextStatus) => void> = []
    installStatusReader(vi.fn(() => new Promise<AgentContextStatus>((resolve) => finish.push(resolve))))
    const reported = contextStatus()
    const { result, rerender } = renderHook(({ thread, currentProject }) => useLiveContextStatus(thread, model, reported, {
      config: undefined, project: currentProject, continuationRunId: undefined
    }), { initialProps: { thread: 'one', currentProject: project } })
    const changed = { ...project, prompt: 'Updated instructions.' }
    rerender({ thread: 'one', currentProject: changed })
    rerender({ thread: 'two', currentProject: changed })
    await act(async () => { finish[0](contextStatus(model, 300)); finish[1](contextStatus(model, 500)) })
    expect(result.current).toBeUndefined()
    await act(async () => finish[2](contextStatus(model, 800)))
    expect(result.current?.estimatedInputTokens).toBe(800)
  })
})
