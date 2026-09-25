import { describe, expect, it } from 'vitest'
import { ContextOverflowError } from '@langchain/core/errors'
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'
import { modelContextKey } from '@shared/modelConfig'
import type { ResolvedModelConfig } from '@shared/types'
import { assertModelInputFits, assertModelInputSupported } from './modelRequestValidation'
import { isModelSelectionError } from './modelSelection'
import { countMessagesApproximately } from './localTokenCounting'
import { contextRequestKey, currentContextWindowTokens } from './serverTokenUsage'
import { effectiveContextMessages } from './contextRuntime'
import { projectToolImages } from './toolImageProjection'

const model: ResolvedModelConfig = {
  id: 'test', displayName: 'Test', providerId: 'provider', providerName: 'Provider',
  protocol: 'openai_chat_completions', baseUrl: 'https://example.com/v1', model: 'test',
  parameters: {}, parameterPresetMode: 'none', capabilities: { toolUse: true, vision: true },
  stream: true, maxContextTokens: 4096, maxOutputTokens: 1024,
  contextCompressionEnabled: true, contextCompressionThreshold: 0.8
}

describe('model request compatibility', () => {
  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)(
    'enforces calibrated %s usage after shrinking the window and disabling compression', (protocol) => {
      const original = { ...model, protocol, maxContextTokens: 100_000 }
      const systemMessage = new SystemMessage('Preserve the project constraints.')
      const user = new HumanMessage('分析：' + '中'.repeat(6000))
      const tools = [{ type: 'function', function: { name: 'lookup', description: 'Find context', parameters: { type: 'object', properties: {} } } }]
      const response = new AIMessage({ content: 'Done',
        usage_metadata: { input_tokens: 8000, output_tokens: 1, total_tokens: 8001 },
        additional_kwargs: {
          anas_model_context_key: modelContextKey(original),
          anas_context_request_key: contextRequestKey({ messages: [user], systemMessage, tools, protocol })
        }
      })
      const messages = [user, response, new HumanMessage('Continue')]
      const preparedMessages = [systemMessage, ...messages]
      expect(() => assertModelInputFits(original, preparedMessages, tools)).not.toThrow()
      const bounded = { ...original, maxContextTokens: 7000, contextCompressionEnabled: false }
      const calibrated = currentContextWindowTokens({ messages, systemMessage, tools, protocol,
        modelContextKey: modelContextKey(bounded), parameters: bounded.parameters })
      expect(calibrated).toBeGreaterThan(8000)
      expect(countMessagesApproximately(preparedMessages, tools, { protocol })).toBeLessThan(3000)
      expect(() => assertModelInputFits(bounded, preparedMessages, tools))
        .toThrow(`prepared conversation needs approximately ${calibrated}`)
      expect(() => assertModelInputFits({ ...bounded, maxContextTokens: calibrated + bounded.maxOutputTokens }, preparedMessages, tools)).not.toThrow()

      // A changed provider, model, parameter set, or actual input invalidates the
      // old usage. The remaining request fits under its current local estimate.
      for (const changed of [
        { ...bounded, providerId: 'another-provider' },
        { ...bounded, model: 'another-model' },
        { ...bounded, parameters: { temperature: 0.5 } }
      ]) expect(() => assertModelInputFits(changed, preparedMessages, tools)).not.toThrow()
      expect(() => assertModelInputFits(bounded, [new SystemMessage('Changed constraints.'), ...messages], tools)).not.toThrow()
      expect(() => assertModelInputFits(bounded, [systemMessage, new HumanMessage('Revised input'), response, messages[2]], tools)).not.toThrow()
      expect(() => assertModelInputFits(bounded, preparedMessages, [])).not.toThrow()
      expect(() => assertModelInputFits(bounded, [systemMessage, user, new AIMessage('No usage'), messages[2]], tools)).not.toThrow()
    }
  )

  it('includes Responses instruction parameters in the final input capacity boundary', () => {
    const selected = { ...model, protocol: 'openai_responses' as const, parameters: { instructions: 'x'.repeat(20_000) } }
    const messages = [new HumanMessage('Hi')]
    expect(() => assertModelInputFits(selected, messages, [])).toThrow('prepared conversation needs approximately 5001')
    expect(() => assertModelInputFits({ ...selected, parameters: { instructions: 'Short instructions' } }, messages, []))
      .not.toThrow()
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('includes %s structured-output schemas in the final input capacity boundary', (protocol) => {
    const schema = { type: 'object', description: 'x'.repeat(20_000), properties: { answer: { type: 'string' } } }
    const parameters = protocol === 'anthropic_messages' ? { output_config: { format: { type: 'json_schema', schema } } }
      : protocol === 'openai_responses' ? { text: { format: { type: 'json_schema', name: 'answer', schema } } }
        : { response_format: { type: 'json_schema', json_schema: { name: 'answer', schema } } }
    expect(() => assertModelInputFits({ ...model, protocol, parameters }, [new HumanMessage('Hi')], []))
      .toThrow('input capacity of 3072')
  })

  it('reserves 1024 tokens for each image at the final input capacity boundary', () => {
    const messages = [new HumanMessage({ content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
      { type: 'image_url', image_url: { url: 'https://example.test/second.png' } }
    ] })]
    expect(() => assertModelInputFits({ ...model, maxContextTokens: 3072, maxOutputTokens: 1024 }, messages, [])).not.toThrow()
    expect(() => assertModelInputFits({ ...model, maxContextTokens: 3071, maxOutputTokens: 1024 }, messages, []))
      .toThrow('prepared conversation needs approximately 2048')
  })

  it('uses a fixed image budget for Responses generated-image history at the input boundary', () => {
    const messages = [new AIMessage({ content: '', response_metadata: { output: [{
      type: 'image_generation_call', id: 'ig_generated', status: 'completed', result: 'A'.repeat(100_000)
    }] } })]
    const selected = { ...model, protocol: 'openai_responses' as const }
    const tokens = countMessagesApproximately(messages, [], { protocol: selected.protocol })
    expect(tokens).toBeGreaterThanOrEqual(1024)
    expect(tokens).toBeLessThan(1100)
    expect(() => assertModelInputFits({ ...selected, maxContextTokens: tokens + selected.maxOutputTokens }, messages, []))
      .not.toThrow()
    expect(() => assertModelInputFits({ ...selected, maxContextTokens: tokens + selected.maxOutputTokens - 1 }, messages, []))
      .toThrow('required context does not fit')
    expect(() => assertModelInputSupported({ ...selected, capabilities: { ...selected.capabilities, vision: false } }, messages, false))
      .toThrow('images required')
  })

  it('includes Chat Completions tool-image transport text before allowing a request', () => {
    const messages = [new ToolMessage({ tool_call_id: 'image-call', name: 'view_image', content: [
      { type: 'text', text: 'Loaded screenshot.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }
    ] })]
    const rawBudget = countMessagesApproximately(messages, null, { protocol: 'anthropic_messages' })
    const bounded = { ...model, maxContextTokens: rawBudget + 1000, maxOutputTokens: 1000 }
    expect(() => assertModelInputFits({ ...bounded, protocol: 'anthropic_messages' }, messages, [])).not.toThrow()
    expect(() => assertModelInputFits(bounded, messages, [])).toThrow('required context does not fit')
  })

  it('rejects unsupported tool history and required supervision, but allows ordinary text', () => {
    const textOnly = { ...model, capabilities: { ...model.capabilities, toolUse: false } }
    expect(() => assertModelInputSupported(textOnly, [new HumanMessage('Hi')], false)).not.toThrow()
    expect(() => assertModelInputSupported(textOnly, [], true)).toThrow('tool context required')
    expect(() => assertModelInputSupported(textOnly, [new AIMessage({ content: '', tool_calls: [
      { id: 'call', name: 'read_file', args: {} }
    ] }), new ToolMessage({ content: 'file content', tool_call_id: 'call' })], false)).toThrow('run was stopped')
  })

  it('rejects a vision downgrade without mutating necessary image content', () => {
    const messages = [new HumanMessage({ content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] })]
    expect(() => assertModelInputSupported({ ...model, capabilities: { ...model.capabilities, vision: false } }, messages, false)).toThrow('images required')
    expect(messages[0].content).toHaveLength(1)
    expect(() => assertModelInputSupported(model, messages, false)).not.toThrow()
  })

  it('checks native images only when the selected protocol replays them and the summary retains them', () => {
    const selected = { ...model, protocol: 'openai_responses' as const, capabilities: { ...model.capabilities, vision: false } }
    const output = { type: 'code_interpreter_call', id: 'chart', code: 'plot()', status: 'completed', container_id: 'container',
      outputs: [{ type: 'logs', logs: 'Chart ready' }, { type: 'image', url: 'https://example.test/chart.png' }] }
    const messages = [new HumanMessage('Plot the chart'), new AIMessage({ content: '', response_metadata: { output: [output] } }),
      new HumanMessage('Continue')]
    expect(() => assertModelInputSupported(selected, messages, false)).toThrow('images required')
    expect(() => assertModelInputSupported(selected, [new AIMessage({ content: '', response_metadata: {
      output: [{ ...output, outputs: [{ type: 'logs', logs: 'No chart was generated' }] }]
    } })], false)).not.toThrow()
    for (const protocol of ['openai_chat_completions', 'anthropic_messages'] as const) {
      expect(() => assertModelInputSupported({ ...selected, protocol }, messages, false)).not.toThrow()
    }
    const summary = new HumanMessage({ content: 'The chart was inspected.', additional_kwargs: { lc_source: 'summarization' } })
    const projected = effectiveContextMessages(messages, {
      _summarizationEvent: { cutoffIndex: 2, summaryMessage: summary, filePath: null }
    })
    expect(() => assertModelInputSupported(selected, projected, false)).not.toThrow()
    expect(messages[1].response_metadata).toMatchObject({ output: [output] })
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)(
    'allows %s text-shaped image data and already-consumed tool images on a text-only model', protocol => {
      const selected = { ...model, protocol, capabilities: { ...model.capabilities, vision: false } }
      const imageJson = { type: 'code_interpreter_call', outputs: [{ type: 'image', url: 'https://example.test/chart.png' }] }
      const jsonMessages = [new AIMessage({ content: '', tool_calls: [{ id: 'json', name: 'write_json', args: imageJson }] }),
        new ToolMessage({ tool_call_id: 'json', content: JSON.stringify(imageJson) })]
      expect(() => assertModelInputSupported(selected, jsonMessages, false)).not.toThrow()
      const imageMessages = [new AIMessage({ content: '', tool_calls: [{ id: 'image', name: 'view_image', args: {} }] }),
        new ToolMessage({ tool_call_id: 'image', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] })]
      expect(() => assertModelInputSupported(selected, imageMessages, false)).toThrow('images required')
      expect(() => assertModelInputSupported(selected,
        projectToolImages([...imageMessages, new AIMessage('The chart shows an increase.')]), false)).not.toThrow()
    }
  )

  it('uses the output reserve in the final input limit and never truncates history', () => {
    const messages = [new HumanMessage('Required context. '.repeat(2000))]
    expect(() => assertModelInputFits(model, messages, [])).toThrow('input capacity of 3072')
    expect(messages[0].text).toBe('Required context. '.repeat(2000))
    expect(() => assertModelInputFits({ ...model, maxContextTokens: 100_000 }, messages, [])).not.toThrow()
    try { assertModelInputFits(model, messages, []) } catch (error) {
      expect(ContextOverflowError.isInstance(error)).toBe(true)
      expect(isModelSelectionError(error)).toBe(true)
    }
  })
})
