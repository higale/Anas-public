import type { InputHistoryItem } from '@shared/types'

export type ComposerSuggestionKind = 'command' | 'history' | 'favorite'

export interface SlashCommand {
  name: string
  description: string
  skillName?: string
  action?: () => void | Promise<void>
}

export interface ComposerSuggestion {
  id: string
  kind: ComposerSuggestionKind
  text: string
  description?: string
  item?: InputHistoryItem
  command?: SlashCommand
}
