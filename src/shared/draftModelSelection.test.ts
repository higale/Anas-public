import { describe, expect, it } from 'vitest'
import {
  newThreadDraftModelSelection,
  projectDraftModelSelection,
  reconcileDraftModelSelection
} from './draftModelSelection'
import { defaultModelConfig, findProviderModelConfig } from './modelConfig'
import type { ModelProviderConfig, NewThreadModelSelection } from './types'

const model = {
  baseUrl: 'https://provider.example/v1',
  defaultParameterPresetId: 'thinking-on',
  model: 'model-name',
  parameterPresets: [
    { id: 'thinking-on', name: 'Thinking on', parameters: { enable_thinking: true } },
    { id: 'thinking-off', name: 'Thinking off', parameters: { enable_thinking: false } }
  ]
}

describe('draft model selection', () => {
  const providers: ModelProviderConfig[] = [{
    id: 'provider', name: 'Provider', protocol: 'openai_chat_completions',
    baseUrl: 'https://example.com/v1', modelListUrl: '', modelListAuth: 'bearer', parameters: {},
    models: [{
      ...defaultModelConfig, ...model, id: 'project-model', index: 0,
      displayName: 'Project Model', parameterPresetMode: 'custom'
    }]
  }]

  it.each<NewThreadModelSelection>(['current', 'default', 'prompt'])(
    'prioritizes the project model and reasoning over the global %s strategy', (strategy) => {
      const projectSelection = projectDraftModelSelection(providers, {
        modelConfigId: 'project-model', modelParameterPresetId: 'thinking-off'
      })
      expect(newThreadDraftModelSelection({
        settings: { newThreadModelSelection: strategy },
        defaultModel: { ...model, id: 'global-default' }
      }, { ...model, id: 'current' }, null, projectSelection)).toEqual({
        modelConfigId: 'project-model', modelParameterPresetId: 'thinking-off', parameterPresetSource: 'explicit'
      })
    }
  )

  it('distinguishes an explicit empty project reasoning selection from the model default', () => {
    expect(projectDraftModelSelection(providers, {
      modelConfigId: 'project-model', modelParameterPresetId: null
    })).toEqual({ modelConfigId: 'project-model', modelParameterPresetId: null, parameterPresetSource: 'explicit' })
    expect(projectDraftModelSelection(providers, { modelConfigId: 'project-model' }))
      .toMatchObject({ modelParameterPresetId: 'thinking-on', parameterPresetSource: 'model-default' })
  })

  it('falls back to the model default for a deleted project reasoning option', () => {
    expect(projectDraftModelSelection(providers, {
      modelConfigId: 'project-model', modelParameterPresetId: 'removed'
    })).toMatchObject({ modelConfigId: 'project-model', modelParameterPresetId: 'thinking-on' })
  })

  it('resolves protocol-default reasoning options before validating the project selection', () => {
    const protocolProviders: ModelProviderConfig[] = [{
      ...providers[0],
      protocol: 'openai_responses',
      models: [{ ...providers[0].models[0], parameterPresetMode: 'protocol_default' }]
    }]
    const preset = findProviderModelConfig(protocolProviders, 'project-model')!.parameterPresets![0]
    expect(projectDraftModelSelection(protocolProviders, {
      modelConfigId: 'project-model', modelParameterPresetId: preset.id
    })).toMatchObject({ modelParameterPresetId: preset.id, parameterPresetSource: 'explicit' })
  })

  it.each([
    { project: undefined, candidates: providers },
    { project: {}, candidates: providers },
    { project: { modelConfigId: 'deleted' }, candidates: providers },
    { project: { modelConfigId: 'project-model' }, candidates: [] },
    { project: { modelConfigId: 'project-model' }, candidates: [{ ...providers[0], baseUrl: '' }] },
    { project: { modelConfigId: 'project-model' }, candidates: [{ ...providers[0], models: [{ ...providers[0].models[0], model: '' }] }] }
  ])('uses the unchanged global path for an absent or unavailable project model: %j', ({ project, candidates }) => {
    const preferred = projectDraftModelSelection(candidates, project)
    expect(preferred).toBeUndefined()
    for (const strategy of ['current', 'default', 'prompt'] as const) {
      const config = { settings: { newThreadModelSelection: strategy }, defaultModel: { ...model, id: 'global' } }
      const current = { ...model, id: 'current' }
      expect(newThreadDraftModelSelection(config, current, null, preferred))
        .toEqual(newThreadDraftModelSelection(config, current, null))
    }
  })

  it('starts a new thread with the configured default model and its parameter default', () => {
    expect(newThreadDraftModelSelection({
      settings: { newThreadModelSelection: 'default' },
      defaultModel: { id: 'model-1', ...model }
    })).toEqual({
      modelConfigId: 'model-1',
      modelParameterPresetId: 'thinking-on',
      parameterPresetSource: 'model-default'
    })
  })

  it('can preserve the current model or leave selection to the user', () => {
    const currentModel = { id: 'model-2', ...model }

    expect(newThreadDraftModelSelection({
      settings: { newThreadModelSelection: 'current' }
    }, currentModel, 'thinking-off')).toEqual({
      modelConfigId: 'model-2',
      modelParameterPresetId: 'thinking-off',
      parameterPresetSource: 'explicit'
    })
    expect(newThreadDraftModelSelection({
      settings: { newThreadModelSelection: 'prompt' }
    }, currentModel)).toEqual({
      modelConfigId: undefined,
      modelParameterPresetId: null,
      parameterPresetSource: 'model-default'
    })
  })

  it('preserves an explicit empty parameter selection with the current model', () => {
    expect(newThreadDraftModelSelection({
      settings: { newThreadModelSelection: 'current' }
    }, { id: 'model-2', ...model }, null)).toEqual({
      modelConfigId: 'model-2',
      modelParameterPresetId: null,
      parameterPresetSource: 'explicit'
    })
  })

  it('falls back from an unavailable current model to the default model', () => {
    expect(newThreadDraftModelSelection({
      settings: { newThreadModelSelection: 'current' },
      defaultModel: { id: 'model-default', ...model },
      providers: [{
        baseUrl: 'https://first.example/v1',
        models: [{ id: 'model-first', model: 'first-model', defaultParameterPresetId: undefined }]
      }]
    })).toEqual({
      modelConfigId: 'model-default',
      modelParameterPresetId: 'thinking-on',
      parameterPresetSource: 'model-default'
    })
  })

  it('falls back from an unavailable default to the current model', () => {
    expect(newThreadDraftModelSelection({
      settings: { newThreadModelSelection: 'default' },
      defaultModel: {
        id: 'model-default-incomplete',
        baseUrl: 'https://default.example/v1',
        model: '',
        defaultParameterPresetId: undefined
      },
      providers: [{
        baseUrl: 'https://first.example/v1',
        models: [{ id: 'model-first', model: 'first-model', defaultParameterPresetId: undefined }]
      }]
    }, { id: 'model-current', ...model }, null)).toEqual({
      modelConfigId: 'model-current',
      modelParameterPresetId: null,
      parameterPresetSource: 'explicit'
    })
  })

  it('uses the first provider model when current and default are unavailable', () => {
    expect(newThreadDraftModelSelection({
      settings: { newThreadModelSelection: 'default' },
      providers: [{
        baseUrl: 'https://first.example/v1',
        models: [{ id: 'model-first', model: 'first-model', defaultParameterPresetId: 'first-default' }]
      }]
    })).toEqual({
      modelConfigId: 'model-first',
      modelParameterPresetId: 'first-default',
      parameterPresetSource: 'model-default'
    })
  })

  it('skips incomplete current, default, and provider model candidates', () => {
    expect(newThreadDraftModelSelection({
      settings: { newThreadModelSelection: 'current' },
      defaultModel: {
        id: 'model-default-incomplete',
        baseUrl: 'https://default.example/v1',
        model: '',
        defaultParameterPresetId: undefined
      },
      providers: [
        {
          baseUrl: '',
          models: [{ id: 'model-first-incomplete', model: 'first', defaultParameterPresetId: undefined }]
        },
        {
          baseUrl: 'https://second.example/v1',
          models: [{ id: 'model-second', model: 'second', defaultParameterPresetId: 'second-default' }]
        }
      ]
    }, {
      id: 'model-current-incomplete',
      baseUrl: '',
      model: 'current',
      defaultParameterPresetId: undefined
    })).toEqual({
      modelConfigId: 'model-second',
      modelParameterPresetId: 'second-default',
      parameterPresetSource: 'model-default'
    })
  })

  it('follows a changed default until the draft is manually changed', () => {
    expect(reconcileDraftModelSelection(model, {
      modelConfigId: 'model-1',
      modelParameterPresetId: 'thinking-off',
      parameterPresetSource: 'model-default'
    })).toEqual({
      modelConfigId: 'model-1',
      modelParameterPresetId: 'thinking-on',
      parameterPresetSource: 'model-default'
    })
    expect(reconcileDraftModelSelection(model, {
      modelConfigId: 'model-1',
      modelParameterPresetId: 'thinking-off',
      parameterPresetSource: 'explicit'
    })).toEqual({
      modelConfigId: 'model-1',
      modelParameterPresetId: 'thinking-off',
      parameterPresetSource: 'explicit'
    })
  })

  it('preserves an explicit empty selection but repairs a deleted preset', () => {
    expect(reconcileDraftModelSelection(model, {
      modelConfigId: 'model-1',
      modelParameterPresetId: null,
      parameterPresetSource: 'explicit'
    })).toEqual({
      modelConfigId: 'model-1',
      modelParameterPresetId: null,
      parameterPresetSource: 'explicit'
    })
    expect(reconcileDraftModelSelection(model, {
      modelConfigId: 'model-1',
      modelParameterPresetId: 'deleted',
      parameterPresetSource: 'explicit'
    })).toEqual({
      modelConfigId: 'model-1',
      modelParameterPresetId: 'thinking-on',
      parameterPresetSource: 'model-default'
    })
  })
})
