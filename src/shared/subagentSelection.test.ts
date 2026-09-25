import { expect, it } from 'vitest'
import { selectedSubagents } from './subagentSelection'

it('treats custom names as explicit grants while excluding missing and incomplete definitions', () => {
  const definitions = [
    { name: 'default-agent', enabled: true, description: 'Default', systemPrompt: 'Complete task.' },
    { name: 'custom-agent', enabled: false, description: 'Custom', systemPrompt: 'Complete task.' },
    { name: 'draft-agent', enabled: false, description: 'Draft', systemPrompt: '' }
  ]
  expect(selectedSubagents(definitions).map(item => item.name)).toEqual(['default-agent'])
  expect(selectedSubagents(definitions, { mode: 'custom', names: ['custom-agent', 'draft-agent', 'missing'] }).map(item => item.name)).toEqual(['custom-agent'])
  expect(selectedSubagents(definitions, { mode: 'custom', names: [] })).toEqual([])
  expect(definitions[1].enabled).toBe(false)
})
