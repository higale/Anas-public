import { defaultCapabilities, serializeCapabilities } from '@shared/agentCapabilities'
import { describe, expect, it } from 'vitest'
import { normalizeSubagent, rawSubagentFromSave } from './subagentConfigMapper'

describe('subagent configuration mapping', () => {
  it('round trips delegation choices independently of the global default switch', () => {
    const config = { name: 'delegate', enabled: false, description: 'Delegate work.', systemPrompt: 'Complete work.',
      capabilities: structuredClone(defaultCapabilities), subagentSelection: { mode: 'custom' as const, names: ['reviewer', 'missing'] } }
    const raw = rawSubagentFromSave(config)
    expect(raw.subagent_selection).toEqual(config.subagentSelection)
    expect(raw).not.toHaveProperty('subagentSelection')
    expect(normalizeSubagent(raw, 0)).toMatchObject(config)
    expect(() => rawSubagentFromSave({ ...config, subagentSelection: { mode: 'custom', names: ['bad name'] } })).toThrow()
  })

  it('derives built-in status from a known preset and normalizes scoped capabilities', () => {
    expect(normalizeSubagent({
 capabilities: serializeCapabilities({ ...structuredClone(defaultCapabilities), profile: false, workspace: false,
        memory: false, toolMode: 'selected', tools: ['http_request', 'http_request'], skills: { enabled: true, mode: 'custom' as const, project: false, entries: (['baidu-search'] as string[]).map(id => ({ id, shortcut: false, model: true })) } }),
      preset: 'web-researcher',
      name: 'web-researcher',
      enabled: true,
      description: 'Research current information.',
      system_prompt: 'Verify sources.',
    }, 2)).toEqual({
 capabilities: { ...structuredClone(defaultCapabilities), profile: false, workspace: false,
        memory: false, toolMode: 'selected', tools: ['http_request'], skills: { enabled: true, mode: 'custom' as const, project: false, entries: (['baidu-search'] as string[]).map(id => ({ id, shortcut: false, model: true })) } },
      index: 2,
      preset: 'web-researcher',
      builtIn: true,
      name: 'web-researcher',
      enabled: true,
      description: 'Research current information.',
      systemPrompt: 'Verify sources.',
    })
  })

  it('preserves a built-in preset when editing while rejecting invalid names', () => {
    const existing = {
      preset: 'general-purpose',
      name: 'general-purpose'
    }
    expect(rawSubagentFromSave({
 capabilities: { ...structuredClone(defaultCapabilities), profile: false, workspace: true,
        memory: true, toolMode: 'all', tools: [], skills: { enabled: true, mode: 'default' as const, project: false, entries: [] } },
      index: 0,
      name: 'general-purpose',
      enabled: true,
      description: 'General work.',
      systemPrompt: 'Complete the task.',
    }, existing)).toMatchObject({
      preset: 'general-purpose',
      name: 'general-purpose'
    })

    expect(() => rawSubagentFromSave({
 capabilities: { ...structuredClone(defaultCapabilities), profile: false, workspace: false,
        memory: false, toolMode: 'selected', tools: [], skills: { enabled: true, mode: 'custom' as const, project: false, entries: [] } },
      name: 'Invalid Agent',
      enabled: false,
      description: '',
      systemPrompt: '',
    })).toThrow(/Subagent names/)

    expect(() => rawSubagentFromSave({
 capabilities: { ...structuredClone(defaultCapabilities), profile: false, workspace: true,
        memory: true, toolMode: 'all', tools: [], skills: { enabled: true, mode: 'default' as const, project: false, entries: [] } },
      index: 0,
      name: 'renamed-agent',
      enabled: true,
      description: 'General work.',
      systemPrompt: 'Complete the task.',
    }, existing)).toThrow(/cannot be changed/)
  })

  it('requires routing text and a prompt only when the subagent is enabled', () => {
    const disabled = {
 capabilities: { ...structuredClone(defaultCapabilities), profile: false, workspace: false,
        memory: false, toolMode: 'selected' as const, tools: [], skills: { enabled: true, mode: 'custom' as const, project: false, entries: [] } },
      name: 'draft-agent',
      enabled: false,
      description: '',
      systemPrompt: '',
    }
    expect(rawSubagentFromSave(disabled)).toMatchObject({
      name: 'draft-agent',
      enabled: false
    })
    expect(() => rawSubagentFromSave({
      ...disabled,
      enabled: true
    })).toThrow(/description/)
  })
})
