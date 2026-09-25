import { describe, expect, it } from 'vitest'
import { modelReservedParameterKeys } from './modelConfig'
import {
  modelParameterPresetTemplateGroups,
  modelParameterPresetTemplateTree
} from './modelParameterPresetTemplates'

describe('model parameter preset templates', () => {
  it('loads distinct templates grouped by provider dialect', () => {
    expect(modelParameterPresetTemplateGroups.map((group) => group.id)).toEqual([
      'openai_responses',
      'openai_chat_completions',
      'anthropic_messages'
    ])
    expect(modelParameterPresetTemplateGroups.map((group) => group.label)).toEqual([
      'OpenAI Responses',
      'OpenAI Chat Completions',
      'Anthropic Messages'
    ])
    const templates = modelParameterPresetTemplateGroups.flatMap((group) => group.templates)
    expect(new Set(templates.map((template) => template.id)).size).toBe(templates.length)
    expect(templates.every((template) => modelReservedParameterKeys(template.parameters).length === 0)).toBe(true)
  })

  it('groups provider protocols in the template tree', () => {
    expect(modelParameterPresetTemplateTree.map((node) => node.label)).toEqual([
      'OpenAI Responses',
      'OpenAI Chat Completions',
      'Anthropic Messages'
    ])
    const providerGroups = modelParameterPresetTemplateTree
      .filter((node) => node.type === 'group')
    expect(providerGroups).toEqual([])
  })

  it('keeps current adaptive Anthropic thinking shapes explicit', () => {
    const anthropicTemplates = modelParameterPresetTemplateGroups
      .find((group) => group.id === 'anthropic_messages')
      ?.templates

    expect(anthropicTemplates?.map((template) => template.label)).toEqual([
      'disable',
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
    expect(anthropicTemplates?.map((template) => template.parameters)).toEqual([
      { thinking: { type: 'disabled' } },
      { thinking: { type: 'adaptive' }, output_config: { effort: 'low' } },
      { thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } },
      { thinking: { type: 'adaptive' }, output_config: { effort: 'high' } },
      { thinking: { type: 'adaptive' }, output_config: { effort: 'xhigh' } },
      { thinking: { type: 'adaptive' }, output_config: { effort: 'max' } }
    ])
  })

  it('uses protocol-native OpenAI reasoning shapes', () => {
    const responsesTemplates = modelParameterPresetTemplateGroups
      .find((group) => group.id === 'openai_responses')
      ?.templates
    const chatTemplates = modelParameterPresetTemplateGroups
      .find((group) => group.id === 'openai_chat_completions')
      ?.templates

    expect(responsesTemplates?.map((template) => template.parameters.reasoning)).toEqual([
      { effort: 'none' },
      { effort: 'minimal', summary: 'auto' },
      { effort: 'low', summary: 'auto' },
      { effort: 'medium', summary: 'auto' },
      { effort: 'high', summary: 'auto' },
      { effort: 'xhigh', summary: 'auto' },
      { effort: 'max', summary: 'auto' }
    ])
    expect(chatTemplates?.map((template) => template.parameters.reasoning_effort)).toEqual([
      'none',
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
  })
})
