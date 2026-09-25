import { afterEach, describe, expect, it } from 'vitest'
import { defaultCapabilities } from '@shared/agentCapabilities'
import { defaultModelConfig, resolveProviderModelConfig } from '@shared/modelConfig'
import type { ModelProviderConfigDetail, SubagentConfig } from '@shared/types'
import { AgentDatabase } from './agentDatabase'
import { createAgentModelResolver, ModelSelectionError, resolveModelSelection, resolveThreadModelSelection } from './modelSelection'

function configuration() {
  const provider: ModelProviderConfigDetail = {
    id: 'provider', name: 'Provider', index: 0, protocol: 'openai_chat_completions',
    baseUrl: 'http://localhost:1234/v1', modelListUrl: '', modelListAuth: 'bearer', parameters: {},
    models: ['model-a', 'model-b', 'model-c'].map((id, index) => ({
      ...structuredClone(defaultModelConfig), id, index, displayName: id, model: id,
      parameterPresetMode: 'custom', parameters: { temperature: 0.5 },
      parameterPresets: [{ id: 'precise', name: 'Precise', parameters: { temperature: 0.1 } }]
    }))
  }
  return { providers: [provider], defaultModel: resolveProviderModelConfig(provider, provider.models[0]) }
}

let database: AgentDatabase | undefined
afterEach(() => { database?.close(); database = undefined })

function addChild(owner: string, parent: string, parentRun: string, id: string, parentSubagentId?: string) {
  const config: SubagentConfig = {
    name: id, index: 0, enabled: true, builtIn: false, description: 'Perform a delegated task.',
    systemPrompt: 'Complete the task.', capabilities: structuredClone(defaultCapabilities)
  }
  return database!.createSubagentCall({
    id, ownerThreadId: owner, parentThreadId: parent, parentRunId: parentRun, parentSubagentId,
    childThreadId: `${id}-thread`, childRunId: `${id}-run`, config, description: 'Delegated task',
    childThread: { projectId: database!.getThread(owner)!.projectId }
  })
}

describe('request-time model selection', () => {
  it('reads parent selection and model parameters again for every child request, including nested children', async () => {
    database = AgentDatabase.open(':memory:')
    const root = database.createThread({ modelConfigId: 'model-a', modelParameterPresetId: 'precise' })
    const run = database.createRun(root.id)
    const child = addChild(root.id, root.id, run.id, 'child')
    const grandchild = addChild(root.id, child.childThreadId, child.childRunId, 'grandchild', child.id)
    const config = configuration()
    const resolve = createAgentModelResolver(grandchild.childThreadId, database, { loadConfig: async () => config })

    const first = await resolve()
    expect(first).toMatchObject({ id: 'model-a', parameters: { temperature: 0.1 } })
    database.updateThread(root.id, { modelConfigId: 'model-b', modelParameterPresetId: null })
    expect(await resolve()).toMatchObject({ id: 'model-b', parameters: { temperature: 0.5 } })
    config.providers[0].models[1].parameters.temperature = 0.7
    config.providers[0].models[1].maxContextTokens = 80_000
    expect(await resolve()).toMatchObject({ id: 'model-b', parameters: { temperature: 0.7 }, maxContextTokens: 80_000 })
    expect(first).toMatchObject({ id: 'model-a', parameters: { temperature: 0.1 } })
    expect(database.getThread(child.childThreadId)?.modelConfigId).toBeUndefined()
    expect(database.getThread(grandchild.childThreadId)?.modelConfigId).toBeUndefined()
  })

  it('lets a child select its own model and makes descendants inherit that nearest selection', async () => {
    database = AgentDatabase.open(':memory:')
    const root = database.createThread({ modelConfigId: 'model-a' })
    const run = database.createRun(root.id)
    const child = addChild(root.id, root.id, run.id, 'child')
    const grandchild = addChild(root.id, child.childThreadId, child.childRunId, 'grandchild', child.id)
    const config = configuration()
    database.updateThread(child.childThreadId, { modelConfigId: 'model-c' })
    const resolve = createAgentModelResolver(grandchild.childThreadId, database, { loadConfig: async () => config })
    database.updateThread(root.id, { modelConfigId: 'model-b' })
    expect(await resolve()).toMatchObject({ id: 'model-c' })
    config.providers[0].models[2].parameters.temperature = 0.8
    expect(await resolve()).toMatchObject({ id: 'model-c', parameters: { temperature: 0.8 } })
    config.providers[0].models.splice(2, 1)
    await expect(resolve()).rejects.toThrow(/no longer exists: model-c/)
    database.updateThread(child.childThreadId, { modelConfigId: null })
    expect(await resolve()).toMatchObject({ id: 'model-b' })
    expect(database.getThread(child.childThreadId)?.modelParameterPresetId).toBeUndefined()
    expect(() => database!.updateThread(root.id, { modelConfigId: null })).toThrow(/must select its own model/)
  })

  it('never replaces an absent root selection or deleted model with the current default', async () => {
    database = AgentDatabase.open(':memory:')
    const root = database.createThread()
    const config = configuration()
    const resolve = createAgentModelResolver(root.id, database, { loadConfig: async () => config })
    await expect(resolve()).rejects.toThrow(/No model is selected/)
    database.updateThread(root.id, { modelConfigId: 'deleted' })
    await expect(resolve()).rejects.toThrow(/no longer exists: deleted/)
    expect(resolveModelSelection({}, config, { allowDefault: true }).id).toBe('model-a')
    expect(() => resolveModelSelection({ modelConfigId: 'deleted' }, config, { allowDefault: true })).toThrow(ModelSelectionError)
  })

  it('rejects missing presets, deleted providers and incomplete connection settings', async () => {
    database = AgentDatabase.open(':memory:')
    const root = database.createThread({ modelConfigId: 'model-a', modelParameterPresetId: 'precise' })
    const config = configuration()
    const resolve = createAgentModelResolver(root.id, database, { loadConfig: async () => config })
    config.providers[0].models[0].parameterPresets = []
    await expect(resolve()).rejects.toThrow(/parameter preset no longer exists: precise/)
    database.updateThread(root.id, { modelParameterPresetId: null })
    config.providers[0].baseUrl = ''
    await expect(resolve()).rejects.toThrow(/invalid provider URL/)
    config.providers[0].baseUrl = 'file:///tmp/model'
    await expect(resolve()).rejects.toThrow(/HTTP or HTTPS/)
    config.providers[0].baseUrl = 'http://localhost:1234/v1'
    config.providers[0].models[0].model = ' '
    await expect(resolve()).rejects.toThrow(/no provider model name/)
    config.providers = []
    await expect(resolve()).rejects.toThrow(/no longer exists: model-a/)
  })

  it('uses the selection saved while configuration loading is pending', async () => {
    database = AgentDatabase.open(':memory:')
    const root = database.createThread({ modelConfigId: 'model-a' })
    const config = configuration()
    let finish!: () => void
    const barrier = new Promise<void>((resolve) => { finish = resolve })
    const resolve = createAgentModelResolver(root.id, database, { loadConfig: async () => { await barrier; return config } })
    const pending = resolve()
    database.updateThread(root.id, { modelConfigId: 'model-b' })
    finish()
    expect(await pending).toMatchObject({ id: 'model-b' })
  })

  it('classifies configuration read and ancestry failures as terminal model selection errors', async () => {
    database = AgentDatabase.open(':memory:')
    const root = database.createThread({ modelConfigId: 'model-a' })
    const resolve = createAgentModelResolver(root.id, database, { loadConfig: async () => { throw new Error('max_output_tokens must be smaller than max_context_tokens') } })
    await expect(resolve()).rejects.toMatchObject({ code: 'MODEL_SELECTION_INVALID', message: expect.stringContaining('max_output_tokens') })
    expect(() => resolveThreadModelSelection('missing', database!)).toThrow(/no longer exists/)
    expect(() => resolveThreadModelSelection('cycle', {
      getThread: () => ({ ...root, modelConfigId: undefined }),
      getSubagentCallByChildThreadId: () => ({ parentThreadId: 'cycle' }) as ReturnType<AgentDatabase['getSubagentCallByChildThreadId']>
    })).toThrow(/inheritance contains a cycle/)
  })
})
