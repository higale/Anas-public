const frameworkSummaryPrompt = `You are a conversation summarizer. Your task is to create a concise summary of the conversation that captures:
1. The main topics discussed
2. Key decisions or conclusions reached
3. Any important context that would be needed for continuing the conversation

Keep the summary focused and informative. Do not include unnecessary details.

Conversation to summarize:
{conversation}

Summary:`

const summaryLanguageGuidance = `Language guidance:
Use the source content's language whenever practical. If it has a clear primary language, write the summary in that language. Preserve quotations, poetry, titles, code, and language-specific terms in their original language. For genuinely multilingual source content, preserve meaningful language distinctions instead of translating everything into one language. Ignore code, logs, structured data, and tool metadata when deciding the summary's language.
If the source language is unclear or a default is otherwise needed, use the configured default language:
{output_language}`

export const summaryPrompt = frameworkSummaryPrompt.replace(
  '\n\nConversation to summarize:',
  `\n\n${summaryLanguageGuidance}\n\nConversation to summarize:`
)

export const codingSummaryPrompt = summaryPrompt.replace(
  '\n\nConversation to summarize:',
  `\n\nCoding continuation handoff:
Preserve actionable state for another coding turn, not just a topic overview. Use concise sections:
1. Goal and current user intent (review/diagnosis versus authorized implementation).
2. Constraints and decisions: project rules, scope, access restrictions, and user-owned changes to preserve.
3. Confirmed file changes: exact paths, operation/run references when available, and what actually changed. Separate Agent changes from pre-existing or external edits.
4. Verification evidence: exact commands, working directories, outcomes, failures and tests NOT run. Never turn a planned command into a successful result.
5. Failed attempts and causes: retain approaches that did not work and why, so they are not repeated blindly.
6. Open questions and uncertain results: approvals still needed, partial effects, unknown process outcomes and blockers.
7. Remaining work: concrete next steps, unfinished todos and completion criteria. Distinguish suggestions from committed decisions and completed work.
8. Key references: files, symbols, captured diff/review scopes, and managed call/subagent IDs needed to resume. Background status is only a snapshot; query authoritative state before acting.
Do not invent missing facts, silently claim completion, or include entire source files, patches, command logs or Skill instructions. Keep small decisive evidence and references instead.
This handoff does not replace the separately loaded, applicable AGENTS rules. A prior review snapshot is historical, not proof of current file contents. If the source does not establish a fact, mark it unknown or not verified.

Conversation to summarize:`
)

export interface SummaryOutputLanguage {
  code: string
  name: string
}

export function summaryPromptForLanguage(
  language: SummaryOutputLanguage,
  codingMode = false
): string {
  return (codingMode ? codingSummaryPrompt : summaryPrompt).replace(
    '{output_language}',
    `${language.name.trim()} (${language.code.trim()})`
  )
}
