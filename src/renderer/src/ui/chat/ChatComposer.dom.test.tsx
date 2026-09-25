import { createRef, useState, type ComponentProps } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ChatComposer } from './ChatComposer'
import { useComposerKeyDown } from './useComposerKeyDown'
import { defaultModelConfig, resolveProviderModelConfig } from '@shared/modelConfig'
import type { AppConfigSnapshot, ModelProviderConfig } from '@shared/types'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

function composerProps(): ComponentProps<typeof ChatComposer> {
  return {
    attachments: [], config: undefined,
    contextCompressionBusy: false, contextCompressionDisabled: true,
    generationBusy: false, locked: false, dragActive: false,
    accessMode: 'read_only_allowed', formRef: createRef(), inputRef: createRef(),
    input: 'draft', assistantName: 'Anas', projects: [], queuedMessages: [],
    simpleChatEnabled: false, submissionBusy: false, selectedProjectId: 'project',
    projectSelectionDisabled: false, showProjectPicker: false, showSuggestions: false,
    suggestions: [], todos: [],
    onApplySuggestion: vi.fn(), onAttachFiles: vi.fn(), onAutosizeInput: vi.fn(),
    onCancelGeneration: vi.fn(), onChangeAccessMode: vi.fn(), onChangeInput: vi.fn(),
    onChangeSpeechReplyEnabled: vi.fn(), onCompressContext: vi.fn(),
    onDragEnter: vi.fn(), onDragLeave: vi.fn(), onDragOver: vi.fn(), onDrop: vi.fn(),
    onKeyDown: vi.fn(), onCreateProject: vi.fn(),
    onOpenModelSettings: vi.fn(), onOpenSubagent: vi.fn(), onRemoveAttachment: vi.fn(),
    onRemoveQueuedMessage: vi.fn(), onRetryQueuedMessage: vi.fn(),
    onToggleAttachmentContextPolicy: vi.fn(), onRemoveSuggestion: vi.fn(),
    onSelectProject: vi.fn(), onSelectMainModel: vi.fn(),
    onSelectModelParameterPreset: vi.fn(), onSetDefaultModel: vi.fn(),
    onSteerQueuedMessage: vi.fn(), onSubmit: vi.fn(), onToggleSuggestionPinned: vi.fn()
  }
}

describe('composer draft locking', () => {
  it('sends the typed draft on Enter and applies suggestions only on click', async () => {
    const user = userEvent.setup()
    const send = vi.fn()
    const dismiss = vi.fn()
    const props = composerProps()
    function Harness() {
      const [input, setInput] = useState('duck')
      const onKeyDown = useComposerKeyDown({ showComposerSuggestions: true,
        dismissComposerSuggestions: dismiss, handleInputChange: setInput,
        sendCurrentMessage: () => { send(input) } })
      return <ChatComposer {...props} input={input} onChangeInput={setInput} onKeyDown={onKeyDown}
        showSuggestions suggestions={[{ id: 'history:duckduckgo', kind: 'history', text: 'duckduckgo' }]}
        onApplySuggestion={(suggestion) => setInput(suggestion.text)} />
    }
    render(<Harness />)
    const input = screen.getByRole('textbox')
    await user.click(input)
    await user.keyboard('{ArrowDown}{ArrowUp}{Enter}')
    expect(send).toHaveBeenCalledExactlyOnceWith('duck')
    expect(input).toHaveValue('duck')
    await user.tab()
    expect(input).toHaveValue('duck')
    await user.click(input)
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    expect(send).toHaveBeenCalledTimes(1)
    await user.keyboard('{Control>}{Enter}{/Control}')
    expect(input).toHaveValue('duck\n')
    expect(send).toHaveBeenCalledTimes(1)
    await user.keyboard('{Escape}')
    expect(dismiss).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: 'duckduckgo' }))
    expect(input).toHaveValue('duckduckgo')
    expect(send).toHaveBeenCalledTimes(1)
  })

  it.each(['model', 'preset'] as const)('locks the %s menu during submission then allows changes while the conversation runs', async (menu) => {
    const user = userEvent.setup()
    const props = composerProps()
    const provider: ModelProviderConfig = {
      id: 'provider', name: 'Provider', protocol: 'openai_chat_completions',
      baseUrl: 'https://example.test/v1', modelListUrl: '', modelListAuth: 'bearer', parameters: {},
      models: ['one', 'two'].map((id, index) => ({ ...defaultModelConfig, id, index,
        model: id, displayName: `Model ${id}`, parameterPresetMode: 'custom',
        parameterPresets: [{ id: 'balanced', name: 'Balanced', parameters: {} }] }))
    }
    props.config = { providers: [provider],
      defaultModel: resolveProviderModelConfig(provider, provider.models[0]),
      settings: { speechReply: { enabled: false } }
    } as AppConfigSnapshot
    const { rerender } = render(<ChatComposer {...props} />)
    const modelButton = screen.getByRole('button', { name: 'chat.select_model' })
    const presetButton = screen.getByRole('button', { name: 'chat.select_model_parameter_preset' })
    const trigger = menu === 'model' ? modelButton : presetButton
    await user.click(trigger)
    expect(screen.getByRole('menu')).toBeInTheDocument()
    rerender(<ChatComposer {...props} submissionBusy />)
    expect(modelButton).toBeDisabled()
    expect(presetButton).toBeDisabled()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    for (const generationBusy of [true, false]) {
      rerender(<ChatComposer {...props} generationBusy={generationBusy} locked />)
      expect(modelButton).toBeEnabled()
      expect(presetButton).toBeEnabled()
      await user.click(trigger)
      await user.click(screen.getByRole('menuitemradio', { name: menu === 'model' ? /Model two/ : 'Balanced' }))
      await waitFor(() => expect(menu === 'model' ? props.onSelectMainModel : props.onSelectModelParameterPreset)
        .toHaveBeenCalledWith(menu === 'model' ? 'two' : 'balanced'))
    }
  })

  it('keeps missing selections visible until the user chooses another model or preset', async () => {
    const props = composerProps()
    props.config = { providers: [], defaultModelId: 'deleted-model', settings: { speechReply: { enabled: false } } } as unknown as AppConfigSnapshot
    render(<ChatComposer {...props} generationBusy locked selectedModelParameterPresetId="deleted-preset" />)
    expect(screen.getByRole('button', { name: 'chat.select_model' })).toHaveTextContent('chat.model_unavailable')
    expect(screen.getByRole('button', { name: 'chat.select_model_parameter_preset' })).toHaveTextContent('chat.model_parameter_preset_unavailable')
    expect(props.onSelectMainModel).not.toHaveBeenCalled()
    expect(props.onSelectModelParameterPreset).not.toHaveBeenCalled()
  })

  it('retains focus across submission and a delayed thread unlock', async () => {
    const user = userEvent.setup()
    const props = composerProps()
    const { rerender } = render(<ChatComposer {...props} />)
    const input = screen.getByRole('textbox')
    await user.click(input)
    for (const state of [
      { submissionBusy: true, locked: true, input: 'draft' },
      { submissionBusy: false, locked: true, input: '' }
    ]) {
      rerender(<ChatComposer {...props} {...state} />)
      expect(input).toHaveFocus()
      expect(input).not.toBeDisabled()
      expect(input).toHaveAttribute('readonly')
      await user.keyboard('x{Enter}{ArrowUp}{Tab}')
      expect(props.onChangeInput).not.toHaveBeenCalled()
      expect(props.onKeyDown).not.toHaveBeenCalled()
      expect(props.onSubmit).not.toHaveBeenCalled()
      // Tab may intentionally leave the input; return before the next transition.
      await user.click(input)
    }
    rerender(<ChatComposer {...props} input="" />)
    expect(input).toHaveFocus()
    expect(input).not.toHaveAttribute('readonly')
    await user.keyboard('x')
    expect(props.onChangeInput).toHaveBeenCalledWith('x')
  })

  it('does not take focus from another control when unlocking', async () => {
    const user = userEvent.setup()
    const props = composerProps()
    const { rerender } = render(<><button>Other control</button><ChatComposer {...props} submissionBusy /></>)
    const other = screen.getByRole('button', { name: 'Other control' })
    await user.click(other)
    rerender(<><button>Other control</button><ChatComposer {...props} /></>)
    expect(other).toHaveFocus()
  })
})
