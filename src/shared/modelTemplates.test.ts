import { describe, expect, it } from 'vitest'
import { resolveModelListEndpoint } from './modelListEndpoint'
import { findModelTemplate, getModelTemplate, modelTemplateTree, modelTemplates } from './modelTemplates'

describe('bundled model templates', () => {
  it('provides complete, uniquely identified connection presets', () => {
    expect(modelTemplateTree).toHaveLength(4)
    expect(modelTemplates).toHaveLength(33)
    expect(new Set(modelTemplates.map((template) => template.templateId)).size).toBe(33)
    expect(modelTemplates.every((template) => (
      template.name.trim().length > 0
      && template.label.trim().length > 0
      && template.baseUrl.trim().length > 0
      && template.modelListUrl.trim().length > 0
      && (template.modelListAuth === 'bearer' || template.modelListAuth === 'anthropic')
      && template.apiKey === ''
      && typeof template.parameters === 'object'
    ))).toBe(true)
    expect(modelTemplates.some((template) => template.protocol === 'openai_responses')).toBe(false)
  })

  it('groups hosted services by country and keeps local servers separate', () => {
    expect(modelTemplateTree.map((node) => node.label)).toEqual([
      'Local',
      'China',
      'United States',
      'France'
    ])

    const unitedStates = modelTemplateTree.find((node) => node.id === 'united-states')
    expect(unitedStates).toMatchObject({ type: 'group', label: 'United States' })
    if (!unitedStates || unitedStates.type !== 'group') {
      throw new Error('Expected the United States template group.')
    }
    expect(unitedStates.children.map((node) => node.label)).toEqual([
      'OpenAI',
      'Anthropic',
      'Gemini',
      'xAI / Grok',
      'Groq',
      'OpenRouter',
      'Together AI'
    ])

    const france = modelTemplateTree.find((node) => node.id === 'france')
    expect(france).toMatchObject({ type: 'group', label: 'France' })
    if (!france || france.type !== 'group') throw new Error('Expected the France template group.')
    expect(france.children.map((node) => node.label)).toEqual(['Mistral'])

    const china = modelTemplateTree.find((node) => node.id === 'china')
    expect(china).toMatchObject({ type: 'group', label: 'China' })
    if (!china || china.type !== 'group') throw new Error('Expected the China template group.')
    expect(china.children.map((node) => node.label)).toEqual([
      'Qwen',
      'DeepSeek',
      'MiniMax',
      'VolcEngine',
      'Kimi',
      'GLM',
      'MIMO'
    ])
  })

  it.each([
    {
      templateId: 'united-states/openai',
      protocol: 'openai_chat_completions',
      baseUrl: 'https://api.openai.com/v1',
      modelListUrl: 'https://api.openai.com/v1/models',
      modelListAuth: 'bearer'
    },
    {
      templateId: 'united-states/anthropic/anthropic',
      protocol: 'anthropic_messages',
      baseUrl: 'https://api.anthropic.com',
      modelListUrl: 'https://api.anthropic.com/v1/models',
      modelListAuth: 'anthropic'
    },
    {
      templateId: 'united-states/anthropic/openai',
      protocol: 'openai_chat_completions',
      baseUrl: 'https://api.anthropic.com/v1',
      modelListUrl: 'https://api.anthropic.com/v1/models',
      modelListAuth: 'anthropic'
    },
    {
      templateId: 'united-states/gemini',
      protocol: 'openai_chat_completions',
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      modelListUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/models',
      modelListAuth: 'bearer'
    },
    {
      templateId: 'united-states/xai',
      protocol: 'openai_chat_completions',
      baseUrl: 'https://api.x.ai/v1',
      modelListUrl: 'https://api.x.ai/v1/language-models',
      modelListAuth: 'bearer'
    },
    {
      templateId: 'france/mistral',
      protocol: 'openai_chat_completions',
      baseUrl: 'https://api.mistral.ai/v1',
      modelListUrl: 'https://api.mistral.ai/v1/models',
      modelListAuth: 'bearer'
    },
    {
      templateId: 'united-states/groq',
      protocol: 'openai_chat_completions',
      baseUrl: 'https://api.groq.com/openai/v1',
      modelListUrl: 'https://api.groq.com/openai/v1/models',
      modelListAuth: 'bearer'
    },
    {
      templateId: 'united-states/openrouter',
      protocol: 'openai_chat_completions',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelListUrl: 'https://openrouter.ai/api/v1/models',
      modelListAuth: 'bearer'
    },
    {
      templateId: 'united-states/together-ai',
      protocol: 'openai_chat_completions',
      baseUrl: 'https://api.together.ai/v1',
      modelListUrl: 'https://api.together.ai/v1/models',
      modelListAuth: 'bearer'
    }
  ])('provides the official $templateId connection endpoint', ({ templateId, ...expected }) => {
    expect(getModelTemplate(templateId)).toMatchObject(expected)
  })

  it('uses Anthropic model-list authentication only for Anthropic official endpoints', () => {
    expect(modelTemplates.filter((template) => template.modelListAuth === 'anthropic')
      .map((template) => template.templateId)).toEqual([
      'united-states/anthropic/anthropic',
      'united-states/anthropic/openai'
    ])
    expect(modelTemplates.filter((template) => template.modelListAuth === 'bearer')).toHaveLength(31)
  })

  it('represents nested groups and templates with stable path IDs', () => {
    const china = modelTemplateTree.find((node) => node.id === 'china')
    if (!china || china.type !== 'group') throw new Error('Expected the China template group.')

    const qwen = china.children.find((node) => node.id === 'qwen')
    expect(qwen).toMatchObject({ type: 'group', label: 'Qwen' })
    if (!qwen || qwen.type !== 'group') throw new Error('Expected the Qwen template group.')

    const tokenPlan = qwen.children.find((node) => node.id === 'token-plan')
    expect(tokenPlan).toMatchObject({ type: 'group', label: 'TokenPlan' })
    if (!tokenPlan || tokenPlan.type !== 'group') throw new Error('Expected the TokenPlan template group.')

    expect(tokenPlan.children.map((node) => node.label)).toEqual([
      'OpenAI',
      'Anthropic Messages'
    ])
    expect(getModelTemplate('china/qwen/token-plan/openai')).toMatchObject({
      label: 'OpenAI',
      name: 'Qwen TokenPlan',
      protocol: 'openai_chat_completions'
    })
    expect(getModelTemplate('china/qwen/token-plan/anthropic')).toMatchObject({
      label: 'Anthropic Messages',
      name: 'Qwen TokenPlan',
      protocol: 'anthropic_messages'
    })
  })

  it('keeps menu labels separate from created model names', () => {
    expect(getModelTemplate('united-states/anthropic/anthropic')).toMatchObject({
      label: 'Anthropic Messages',
      name: 'Anthropic',
      modelListAuth: 'anthropic'
    })
    expect(getModelTemplate('china/qwen/openai')).toMatchObject({
      label: 'OpenAI',
      name: 'Qwen',
      protocol: 'openai_chat_completions'
    })
    expect(getModelTemplate('china/qwen/anthropic')).toMatchObject({
      label: 'Anthropic Messages',
      name: 'Qwen',
      modelListAuth: 'bearer'
    })
  })

  it('configures provider-level parameters only for the MiniMax OpenAI protocol', () => {
    expect(modelTemplates.filter((template) => Object.keys(template.parameters).length > 0)
      .map((template) => template.templateId))
      .toEqual(['china/minimax/openai'])
    expect(getModelTemplate('china/minimax/openai')).toMatchObject({
      parameters: { reasoning_split: true }
    })
    expect(getModelTemplate('china/minimax/anthropic')).toMatchObject({
      parameters: {}
    })
  })

  it('groups local model servers under one nested menu', () => {
    const local = modelTemplateTree.find((node) => node.id === 'local')
    expect(local).toMatchObject({ type: 'group', label: 'Local' })
    if (!local || local.type !== 'group') throw new Error('Expected the Local template group.')

    expect(local.children.map((node) => node.label)).toEqual(['LM Studio', 'Ollama', 'LLaMA', 'vLLM'])
    expect(getModelTemplate('local/ollama/openai')).toMatchObject({
      name: 'Ollama',
      protocol: 'openai_chat_completions',
      baseUrl: 'http://localhost:11434/v1'
    })
    expect(getModelTemplate('local/llama-cpp/openai')).toMatchObject({
      name: 'LLaMA',
      protocol: 'openai_chat_completions',
      baseUrl: 'http://localhost:8080/v1'
    })
  })

  it('keeps local model list URLs dynamic while cloud templates stay explicit', () => {
    const localTemplates = modelTemplates.filter((template) => template.baseUrl.startsWith('http://localhost:'))
    const cloudTemplates = modelTemplates.filter((template) => !template.baseUrl.startsWith('http://localhost:'))

    expect(localTemplates).toHaveLength(8)
    expect(localTemplates.every((template) => template.modelListUrl === '{origin}/v1/models')).toBe(true)
    expect(localTemplates.every((template) => resolveModelListEndpoint(
      template.baseUrl.replace('localhost', '127.0.0.1'),
      template.modelListUrl
    ).startsWith('http://127.0.0.1:'))).toBe(true)
    expect(cloudTemplates.every((template) => template.modelListUrl.trim().length > 0)).toBe(true)
  })

  it('finds a template by protocol and normalized Base URL', () => {
    expect(findModelTemplate(
      'anthropic_messages',
      'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic/'
    )?.name).toBe('Qwen TokenPlan')
    expect(findModelTemplate('openai_chat_completions', 'https://custom.example.com/v1')).toBeUndefined()
  })
})
