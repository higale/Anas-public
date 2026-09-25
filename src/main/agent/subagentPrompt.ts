import type { SubagentConfig } from '@shared/types'
import type { AgentSystemPrompt } from './systemPrompt'

export function buildSubagentSystemPrompt(
  subagent: SubagentConfig,
  ownPrompt: AgentSystemPrompt
): string {
  const sections = ownPrompt.sections.filter((section) => section.kind !== 'system_instruction' && section.kind !== 'coding_instruction').map((section) => section.content)
  const subagentContext = [
    '<subagent_context>',
    `You are the "${subagent.name}" subagent working temporarily for the main assistant.`,
    'Treat the current user message as the complete delegated task. You cannot see the parent conversation unless its context is included in that task; do not invent missing context.',
    'Your final response is returned to the main assistant, not directly to the user. Clearly report results, evidence, changes made, and blockers.',
    'Work only on the delegated task.',
    '</subagent_context>'
  ].join('\n')
  const instruction = [
    `<subagent_instruction name="${subagent.name}">`,
    subagent.systemPrompt.trim(),
    '</subagent_instruction>'
  ].join('\n')
  return [
    ...sections,
    subagentContext,
    instruction
  ].filter(Boolean).join('\n\n')
}
