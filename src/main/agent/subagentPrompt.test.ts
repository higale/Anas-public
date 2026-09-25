import { describe, expect, it } from 'vitest'
import { defaultCapabilities } from '@shared/agentCapabilities'
import type { SubagentConfig } from '@shared/types'
import { buildSubagentSystemPrompt } from './subagentPrompt'

const subagent: SubagentConfig = {
  index: 0, name: 'reviewer', enabled: true, builtIn: false, description: 'Review', systemPrompt: 'Verify the work.', capabilities: structuredClone(defaultCapabilities)
}
describe('independent subagent context', () => {
  it('uses its own resolved sections rather than filtering a parent prompt', () => {
    const prompt = buildSubagentSystemPrompt(subagent, { text: '', sections: [
      { kind: 'profile', content: 'OWN PROFILE' }, { kind: 'skills', content: 'OWN SKILLS' }, { kind: 'memory', content: 'OWN MEMORY' }, { kind: 'system_instruction', content: 'SIMPLE CHAT INSTRUCTION' },
      { kind: 'coding_instruction', content: 'MAIN CODING ROLE' }
    ] })
    expect(prompt).toContain('OWN PROFILE')
    expect(prompt).toContain('OWN SKILLS')
    expect(prompt).toContain('OWN MEMORY')
    expect(prompt).not.toContain('SIMPLE CHAT INSTRUCTION')
    expect(prompt).not.toContain('MAIN CODING ROLE')
  })
  it('always identifies the delegated role without inventing absent context', () => {
    const prompt = buildSubagentSystemPrompt(subagent, { text: '', sections: [] })
    expect(prompt).toContain('"reviewer" subagent')
    expect(prompt).toContain('cannot see the parent conversation')
    expect(prompt).toContain('Verify the work.')
    expect(prompt).not.toContain('<memory>')
  })
})
