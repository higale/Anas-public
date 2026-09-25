import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ModelEditor } from './ModelEditor'
import { emptyModelDraft } from './modelDraft'
import type { ModelDraft } from './modelDraft'
import type { ModelProviderConfigDetail } from '@shared/types'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

function providerForDraft(draft: ModelDraft): ModelProviderConfigDetail {
  return {
    id: 'provider-1',
    index: 0,
    name: draft.name,
    protocol: draft.protocol,
    baseUrl: draft.baseUrl,
    modelListUrl: draft.modelListUrl,
    modelListAuth: draft.modelListAuth,
    apiKey: draft.apiKey,
    parameters: JSON.parse(draft.providerParametersJson || '{}') as Record<string, unknown>,
    models: [{
      id: 'model-1',
      index: 0,
      displayName: draft.displayName,
      model: draft.model,
      parameters: {},
      parameterPresetMode: draft.parameterPresetMode,
      capabilities: draft.capabilities,
      stream: draft.stream,
      maxContextTokens: Number(draft.maxContextTokens),
      maxOutputTokens: Number(draft.maxOutputTokens),
      contextCompressionThreshold: draft.contextCompressionThreshold,
      contextCompressionEnabled: draft.contextCompressionEnabled
    }]
  }
}

async function openModelDetails(user = userEvent.setup()): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: 'settings.edit_model: settings.no_model_id' }))
  return screen.findByRole('dialog')
}

describe('model creation', () => {
  it('offers the three explicit provider protocols', async () => {
    const user = userEvent.setup()
    const draft = emptyModelDraft()
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={vi.fn()}
        onUpdateParameters={vi.fn()}
      />
    )

    const protocol = screen.getByRole('combobox', { name: 'settings.provider' })
    expect(protocol).toHaveValue('OpenAI Chat Completions')
    await user.click(protocol)
    const protocolOptions = document.getElementById(protocol.getAttribute('aria-controls') ?? '')
    expect(protocolOptions).not.toBeNull()
    expect(within(protocolOptions!).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'OpenAI Responses',
      'OpenAI Chat Completions',
      'Anthropic Messages'
    ])
  })

  it('always shows provider-level parameters separately from model parameters', () => {
    const onUpdateDraft = vi.fn()
    const draft = emptyModelDraft()
    const view = render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onUpdateParameters={vi.fn()}
      />
    )

    expect(screen.queryByRole('checkbox', { name: 'settings.extra_parameters' })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'settings.extra_parameters' })).toHaveValue('')

    const populatedDraft = {
      ...draft,
      providerParametersJson: JSON.stringify({ reasoning_split: true }, null, 2)
    }
    view.rerender(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={populatedDraft}
        provider={providerForDraft(populatedDraft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onUpdateParameters={vi.fn()}
      />
    )
    expect(screen.getByRole('textbox', { name: 'settings.extra_parameters' }))
      .toHaveValue(JSON.stringify({ reasoning_split: true }, null, 2))
  })

  it('opens the multi-select model list from the existing add button', async () => {
    const user = userEvent.setup()
    const onAddProviderModels = vi.fn().mockResolvedValue(true)
    const draft = emptyModelDraft()
    render(
      <ModelEditor
        candidates={['model-a', 'model-b']}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onAddProviderModels={onAddProviderModels}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={vi.fn()}
        onUpdateParameters={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: 'settings.add_provider_model' }))
    const dialog = await screen.findByRole('dialog', { name: 'settings.add_models_title' })
    await user.click(within(dialog).getByRole('checkbox', { name: 'model-a' }))
    await user.click(within(dialog).getByRole('button', { name: 'settings.add_selected_models' }))

    expect(onAddProviderModels).toHaveBeenCalledWith(['model-a'])
  })
})

describe('model token controls', () => {
  it('keeps model editing open after backdrop clicks and allows Escape or Close', async () => {
    const user = userEvent.setup()
    const draft = emptyModelDraft()
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={vi.fn()}
        onUpdateParameters={vi.fn()}
      />
    )
    const dialog = await openModelDetails(user)
    const displayName = within(dialog).getByRole('textbox', { name: 'settings.model_display_name' })
    await user.type(displayName, 'Unsaved model name')
    await user.click(document.querySelector('.ui-backdrop')!)
    expect(dialog).toBeVisible()
    expect(displayName).toHaveValue('Unsaved model name')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await openModelDetails(user)
    await user.click(screen.getByRole('button', { name: 'common.close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('edits the model display name separately from its provider model ID', async () => {
    const user = userEvent.setup()
    const onUpdateDraft = vi.fn()
    const draft = { ...emptyModelDraft(), model: 'remote-model' }
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onUpdateParameters={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: 'settings.edit_model: remote-model' }))
    const dialog = await screen.findByRole('dialog')
    const displayName = within(dialog).getByRole('textbox', { name: 'settings.model_display_name' })
    await user.type(displayName, 'Friendly model{Enter}')

    expect(onUpdateDraft).toHaveBeenCalledWith({ displayName: 'Friendly model' })
    expect(within(dialog).getByRole('combobox', { name: 'settings.model_id' })).toHaveValue('remote-model')
  })

  it('steps maximum output tokens in thousand-token increments', async () => {
    const draft = emptyModelDraft()
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={vi.fn()}
        onUpdateParameters={vi.fn()}
      />
    )
    await openModelDetails()
    const input = screen.getByLabelText('settings.max_output_tokens') as HTMLInputElement
    const contextControls = input.closest('.model-context-controls')

    expect(input).toHaveAttribute('min', '1000')
    expect(input).toHaveAttribute('step', '1000')
    expect(input.value).toBe('16000')
    expect(contextControls).toHaveClass('ui-grid-3')
    expect(contextControls?.children).toHaveLength(3)

    input.stepUp()
    expect(input.value).toBe('17000')
    input.stepDown(2)
    expect(input.value).toBe('15000')
  })

  it('steps from provider-default mode to one thousand tokens', async () => {
    const draft = { ...emptyModelDraft(), maxOutputTokens: '0' }
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={vi.fn()}
        onUpdateParameters={vi.fn()}
      />
    )
    await openModelDetails()
    const input = screen.getByLabelText('settings.max_output_tokens') as HTMLInputElement

    expect(input.value).toBe('')
    expect(input).toHaveAttribute('placeholder', 'settings.max_output_tokens_ignored')
    input.stepUp()
    expect(input.value).toBe('1000')
  })

  it('maps an empty maximum output field to the ignored value', async () => {
    const user = userEvent.setup()
    const onUpdateDraft = vi.fn()
    const draft = emptyModelDraft()
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onUpdateParameters={vi.fn()}
      />
    )
    await openModelDetails()
    const input = screen.getByLabelText('settings.max_output_tokens') as HTMLInputElement

    await user.clear(input)

    expect(onUpdateDraft).toHaveBeenCalledWith({ maxOutputTokens: '0' })
  })

  it('uses the compression threshold label as the enable checkbox', async () => {
    const user = userEvent.setup()
    const onUpdateDraft = vi.fn()
    const draft = { ...emptyModelDraft(), contextCompressionEnabled: false }
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onUpdateParameters={vi.fn()}
      />
    )

    await openModelDetails(user)
    const checkbox = screen.getByRole('checkbox', { name: 'settings.context_compression_threshold' })
    expect(checkbox).not.toBeChecked()
    expect(screen.getByRole('slider', { name: 'settings.context_compression_threshold' })).toBeDisabled()
    expect(screen.queryByText('settings.context_compression_enabled')).not.toBeInTheDocument()
    await user.click(checkbox)
    expect(onUpdateDraft).toHaveBeenCalledWith({ contextCompressionEnabled: true })
  })

  it('shows extra parameters and reasoning options in independent cards', async () => {
    const user = userEvent.setup()
    const onUpdateDraft = vi.fn()
    const draft = emptyModelDraft()
    const view = render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onUpdateParameters={vi.fn()}
      />
    )

    await openModelDetails(user)
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).queryByRole('checkbox', { name: 'settings.extra_parameters' })).not.toBeInTheDocument()
    expect(within(dialog).getByRole('textbox', { name: 'settings.extra_parameters' })).toBeInTheDocument()
    expect(within(dialog).getByRole('combobox', { name: 'settings.parameter_preset_mode' }))
      .toHaveValue('settings.parameter_preset_mode_protocol_default')
    expect(screen.queryByRole('button', { name: 'settings.add_model_parameter_preset' })).not.toBeInTheDocument()
    expect(dialog.querySelectorAll('.model-details-group.ui-surface-flat')).toHaveLength(5)
    expect(within(dialog).queryByRole('heading', { level: 3 })).not.toBeInTheDocument()
    const protocolDefaultToggle = within(dialog).getByRole('checkbox', { name: 'common.default' })
    expect(protocolDefaultToggle).not.toBeChecked()
    await user.click(protocolDefaultToggle)
    expect(onUpdateDraft).toHaveBeenCalledWith({
      defaultParameterPresetId: 'openai_chat_completions/reasoning-none'
    })
    const modePicker = within(dialog).getByRole('combobox', { name: 'settings.parameter_preset_mode' })
    await user.click(modePicker)
    expect(document.querySelector('.model-parameter-preset-mode-popover'))
      .not.toHaveClass('model-parameter-preset-mode-picker')
    await user.click(screen.getByRole('option', { name: 'settings.parameter_preset_mode_custom' }))
    expect(onUpdateDraft).toHaveBeenCalledWith({
      parameterPresetMode: 'custom',
      defaultParameterPresetId: undefined
    })

    const customDraft = {
      ...draft,
      parameterPresetMode: 'custom' as const
    }
    view.rerender(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={customDraft}
        provider={providerForDraft(customDraft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onUpdateParameters={vi.fn()}
      />
    )
    expect(within(screen.getByRole('dialog')).getByRole('textbox', { name: 'settings.extra_parameters' }))
      .toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'settings.add_model_parameter_preset' })).toBeInTheDocument()
  })

  it('selects model rows without opening details and opens details from the edit button', async () => {
    const user = userEvent.setup()
    const draft = { ...emptyModelDraft(), parameterPresetMode: 'custom' as const }
    const provider = providerForDraft(draft)
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={provider}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={vi.fn()}
        onUpdateParameters={vi.fn()}
      />
    )

    expect(screen.getByRole('option', { name: 'settings.no_model_id' })).toBeInTheDocument()
    expect(screen.queryByLabelText('settings.max_output_tokens')).not.toBeInTheDocument()
    expect(screen.queryByText('settings.model_parameter_presets')).not.toBeInTheDocument()

    await user.click(screen.getByRole('option', { name: 'settings.no_model_id' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    const dialog = await openModelDetails(user)
    expect(within(dialog).getByLabelText('settings.max_output_tokens')).toBeInTheDocument()
    expect(within(dialog).getByText('settings.model_parameter_presets')).toBeInTheDocument()
    const modelCard = document.querySelector<HTMLElement>('[data-settings-group="models"]')!
    expect(within(modelCard).queryByLabelText('settings.max_output_tokens')).not.toBeInTheDocument()
    expect(within(modelCard).queryByText('settings.model_parameter_presets')).not.toBeInTheDocument()
  })

  it('opens model details when the selected model row is double-clicked', async () => {
    const user = userEvent.setup()
    const draft = emptyModelDraft()
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={vi.fn()}
        onUpdateParameters={vi.fn()}
      />
    )

    await user.dblClick(screen.getByRole('option', { name: 'settings.no_model_id' }))

    expect(await screen.findByRole('dialog')).toBeInTheDocument()
  })

  it('keeps model deletion out of the details dialog', async () => {
    const onDeleteProviderModel = vi.fn().mockResolvedValue(true)
    const draft = emptyModelDraft()
    const provider = providerForDraft(draft)
    provider.models.push({
      ...provider.models[0],
      id: 'model-2',
      index: 1,
      model: 'other-model'
    })
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={provider}
        selectedModelIndex={0}
        onDeleteProviderModel={onDeleteProviderModel}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={vi.fn()}
        onUpdateParameters={vi.fn()}
      />
    )

    const dialog = await openModelDetails()
    expect(within(dialog).queryByRole('button', { name: 'settings.delete_model' })).not.toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'common.close' })).not.toHaveClass('ui-button-compact')
    expect(onDeleteProviderModel).not.toHaveBeenCalled()
  })

  it('adds a model parameter preset from the model card', async () => {
    const user = userEvent.setup()
    const onUpdateDraft = vi.fn()
    const draft = { ...emptyModelDraft(), parameterPresetMode: 'custom' as const }
    const view = render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onUpdateParameters={vi.fn()}
      />
    )

    await openModelDetails(user)
    const addButton = screen.getByRole('button', { name: 'settings.add_model_parameter_preset' })
    const toolbar = addButton.closest<HTMLElement>('.ui-toolbar')
    expect(toolbar).not.toBeNull()
    expect(within(toolbar!).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'settings.import_protocol_defaults',
      'settings.add_model_parameter_preset',
      'settings.delete_model_parameter_preset',
      'common.move_up',
      'common.move_down'
    ])
    await user.click(addButton)
    expect(onUpdateDraft).toHaveBeenCalledWith({
      parameterPresets: [expect.objectContaining({
        name: 'settings.new_model_parameter_preset',
        parametersJson: ''
      })]
    })
    const update = onUpdateDraft.mock.calls.at(-1)?.[0] as Partial<ModelDraft>
    const updatedDraft = { ...draft, ...update }
    view.rerender(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={updatedDraft}
        provider={providerForDraft(updatedDraft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onUpdateParameters={vi.fn()}
      />
    )
    const dialog = screen.getByRole('dialog')
    expect(await within(dialog).findByRole('textbox', { name: 'settings.name' })).toHaveValue(
      'settings.new_model_parameter_preset'
    )
  })

  it('restores the current protocol parameter defaults directly', async () => {
    const user = userEvent.setup()
    const onUpdateDraft = vi.fn()
    const draft = {
      ...emptyModelDraft(),
      protocol: 'anthropic_messages' as const,
      parameterPresetMode: 'custom' as const
    }
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onUpdateParameters={vi.fn()}
      />
    )

    await openModelDetails(user)
    await user.click(screen.getByRole('button', { name: 'settings.import_protocol_defaults' }))

    expect(onUpdateDraft).toHaveBeenCalledWith({
      defaultParameterPresetId: undefined,
      parameterPresets: [
        expect.objectContaining({
          name: 'disable',
          parametersJson: JSON.stringify({ thinking: { type: 'disabled' } }, null, 2)
        }),
        expect.objectContaining({
          name: 'low',
          parametersJson: JSON.stringify({
            thinking: { type: 'adaptive' },
            output_config: { effort: 'low' }
          }, null, 2)
        }),
        expect.objectContaining({
          name: 'medium',
          parametersJson: JSON.stringify({
            thinking: { type: 'adaptive' },
            output_config: { effort: 'medium' }
          }, null, 2)
        }),
        expect.objectContaining({
          name: 'high',
          parametersJson: JSON.stringify({
            thinking: { type: 'adaptive' },
            output_config: { effort: 'high' }
          }, null, 2)
        }),
        expect.objectContaining({
          name: 'xhigh',
          parametersJson: JSON.stringify({
            thinking: { type: 'adaptive' },
            output_config: { effort: 'xhigh' }
          }, null, 2)
        }),
        expect.objectContaining({
          name: 'max',
          parametersJson: JSON.stringify({
            thinking: { type: 'adaptive' },
            output_config: { effort: 'max' }
          }, null, 2)
        })
      ]
    })
  })

  it('confirms before replacing existing parameter options with protocol defaults', async () => {
    const user = userEvent.setup()
    const onUpdateDraft = vi.fn()
    const draft = {
      ...emptyModelDraft(),
      protocol: 'openai_responses' as const,
      parameterPresetMode: 'custom' as const,
      parameterPresets: [{
        id: 'custom',
        name: 'custom',
        parametersJson: '{"temperature":0.5}'
      }],
      defaultParameterPresetId: 'custom'
    }
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onUpdateParameters={vi.fn()}
      />
    )

    await openModelDetails(user)
    await user.click(screen.getByRole('button', { name: 'settings.import_protocol_defaults' }))
    expect(onUpdateDraft).not.toHaveBeenCalled()
    const confirmation = await screen.findByRole('alertdialog')
    expect(within(confirmation).getByText('settings.restore_model_parameter_presets_title'))
      .toBeInTheDocument()

    await user.click(within(confirmation).getByRole('button', { name: 'settings.import_protocol_defaults' }))
    expect(onUpdateDraft).toHaveBeenCalledWith({
      defaultParameterPresetId: undefined,
      parameterPresets: expect.arrayContaining([
        expect.objectContaining({
          name: 'medium',
          parametersJson: JSON.stringify({
            reasoning: { effort: 'medium', summary: 'auto' }
          }, null, 2)
        })
      ])
    })
  })

  it('edits a parameter preset name directly in its list item', async () => {
    const user = userEvent.setup()
    const onUpdateDraft = vi.fn()
    const draft = {
      ...emptyModelDraft(),
      parameterPresetMode: 'custom' as const,
      parameterPresets: [{
        id: 'thinking-on',
        name: '思考开启',
        parametersJson: '{"enable_thinking":true}'
      }, {
        id: 'thinking-off',
        name: '思考关闭',
        parametersJson: '{"enable_thinking":false}'
      }]
    }
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onUpdateParameters={vi.fn()}
      />
    )

    const dialog = await openModelDetails(user)
    expect(within(dialog).queryByText('settings.name')).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('option', { name: '思考关闭' }))
    expect(within(dialog).queryByRole('textbox', { name: 'settings.name' })).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('option', { name: '思考关闭' }))
    const nameInput = within(dialog).getByRole('textbox', { name: 'settings.name' })
    await user.clear(nameInput)
    await user.type(nameInput, '快速回答{Enter}')

    expect(onUpdateDraft).toHaveBeenCalledWith({
      parameterPresets: [{
        id: 'thinking-on',
        name: '思考开启',
        parametersJson: '{"enable_thinking":true}'
      }, {
        id: 'thinking-off',
        name: '快速回答',
        parametersJson: '{"enable_thinking":false}'
      }]
    })
  })

  it('places the default toggle after the parameter heading', async () => {
    const user = userEvent.setup()
    const onUpdateDraft = vi.fn()
    const draft = {
      ...emptyModelDraft(),
      parameterPresetMode: 'custom' as const,
      parameterPresets: [{
        id: 'thinking-on',
        name: '思考开启',
        parametersJson: '{"enable_thinking":true}'
      }],
      defaultParameterPresetId: 'thinking-on'
    }
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onUpdateParameters={vi.fn()}
      />
    )

    await openModelDetails(user)
    expect(screen.queryByText('settings.model_parameter_preset_parameters')).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'common.default' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('option', { name: /思考开启/ }))
    const heading = screen.getByText('settings.model_parameter_preset_parameters')
      .closest('.ui-field-heading') as HTMLElement
    const defaultToggle = within(heading).getByRole('checkbox', { name: 'common.default' })
    expect(defaultToggle.closest('.ui-checkbox-field')).toHaveClass('ui-checkbox-field-inline')
    expect(defaultToggle).toBeChecked()

    await user.click(defaultToggle)
    expect(onUpdateDraft).toHaveBeenCalledWith({ defaultParameterPresetId: undefined })
  })

  it('shows an explicit expression example when no model list URL is configured', async () => {
    const user = userEvent.setup()
    const draft = { ...emptyModelDraft(), baseUrl: 'https://example.com/v1' }
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={vi.fn()}
        onUpdateParameters={vi.fn()}
      />
    )

    const listHeading = screen.getByText('settings.provider_models').closest('.provider-model-list-heading') as HTMLElement
    expect(within(listHeading).getByLabelText('settings.edit_model_list_settings')).toBeInTheDocument()
    const providerCard = screen.getByLabelText('settings.name').closest('[data-settings-group="provider"]')
    const dialog = await openModelDetails(user)
    const modelCard = document.querySelector<HTMLElement>('[data-settings-group="models"]')!
    expect(providerCard).toHaveAttribute('data-settings-group', 'provider')
    expect(modelCard).toHaveAttribute('data-settings-group', 'models')
    expect(providerCard).not.toBe(modelCard)
    expect(within(dialog).getByLabelText('settings.max_output_tokens')).toBeInTheDocument()
    expect(within(dialog).getByText('settings.model_parameter_presets')).toBeInTheDocument()
    const modelIdInput = within(dialog).getByRole('combobox', { name: 'settings.model_id' })
    expect(modelIdInput.closest('.model-details-dialog')).toBe(dialog)
    expect(modelIdInput).toHaveAttribute('placeholder', 'settings.model_id_placeholder')
    await user.click(screen.getByRole('button', { name: 'settings.model_id' }))
    const modelPicker = document.querySelector('.searchable-option-popover') as HTMLElement
    const trigger = within(modelPicker).getByLabelText('settings.edit_model_list_settings')
    expect(trigger).toHaveClass('model-list-url-inline-trigger')
    expect(trigger).not.toHaveClass('ui-icon-button')
    expect(trigger.closest('.searchable-option-popover')).not.toBeNull()
    expect(screen.getByLabelText('settings.fetch_available_models')
      .closest('.searchable-option-popover')).not.toBeNull()
    await user.click(trigger)

    expect(screen.getByLabelText('settings.model_list_url'))
      .toHaveAttribute('placeholder', '{base_url}/models')
  })

  it('restores a matching template model list URL', async () => {
    const user = userEvent.setup()
    const onUpdateDraft = vi.fn()
    const draft = {
      ...emptyModelDraft(),
      protocol: 'anthropic_messages' as const,
      baseUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',
      modelListUrl: '',
      modelListAuth: 'anthropic' as const
    }
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onUpdateParameters={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: 'settings.edit_model: settings.no_model_id' }))
    await user.click(screen.getByRole('button', { name: 'settings.model_id' }))
    const modelPicker = document.querySelector('.searchable-option-popover') as HTMLElement
    await user.click(within(modelPicker).getByLabelText('settings.edit_model_list_settings'))
    await user.click(screen.getByText('settings.restore_template_model_list_settings'))

    expect(onUpdateDraft).toHaveBeenCalledWith({
      modelListAuth: 'bearer',
      modelListUrl: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/models'
    })
  })

  it('refreshes available models from inside the model picker', async () => {
    const user = userEvent.setup()
    const onRefreshCandidates = vi.fn()
    const draft = {
      ...emptyModelDraft(),
      baseUrl: 'https://example.com/v1',
      modelListUrl: '{base_url}/models'
    }
    render(
      <ModelEditor
        candidates={[]}
        listLoading={false}
        modelDraft={draft}
        provider={providerForDraft(draft)}
        selectedModelIndex={0}
        onRefreshCandidates={onRefreshCandidates}
        onUpdateDraft={vi.fn()}
        onUpdateParameters={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: 'settings.edit_model: settings.no_model_id' }))
    await user.click(screen.getByRole('button', { name: 'settings.model_id' }))
    await user.click(screen.getByLabelText('settings.fetch_available_models'))
    expect(onRefreshCandidates).toHaveBeenCalledOnce()
  })

  it('keeps duplicate model IDs selectable inside the model dialog portal', async () => {
    const user = userEvent.setup()
    const onUpdateDraft = vi.fn()
    const draft = emptyModelDraft()
    const provider = providerForDraft(draft)
    provider.models.push({
      ...provider.models[0],
      id: 'model-2',
      index: 1,
      model: 'existing-model'
    })
    render(
      <ModelEditor
        candidates={['existing-model', 'new-model']}
        listLoading={false}
        modelDraft={draft}
        provider={provider}
        selectedModelIndex={0}
        onRefreshCandidates={vi.fn()}
        onUpdateDraft={onUpdateDraft}
        onUpdateParameters={vi.fn()}
      />
    )

    const dialog = await openModelDetails(user)
    await user.click(within(dialog).getByRole('button', { name: 'settings.model_id' }))
    const candidatePopover = screen.getByRole('dialog', { name: 'settings.model_id' })
    const candidateList = within(candidatePopover).getByRole('listbox')
    const configuredOption = within(candidateList).getByRole('option', { name: 'existing-model' })
    expect(candidateList.closest('.model-details-dialog')).toBe(dialog)
    expect(configuredOption).not.toBeDisabled()
    await user.click(configuredOption)
    expect(onUpdateDraft).toHaveBeenCalledWith({ model: 'existing-model' })
    await user.click(within(dialog).getByRole('checkbox', { name: 'settings.stream_output' }))
    expect(onUpdateDraft).toHaveBeenCalledWith({ stream: false })
  })
})
