import { ListChecks, Bot, Brain, Code2, Earth, GitFork, Plug, Settings, SlidersHorizontal, Wand2, Wrench } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export type SettingsTab = 'capabilities' | 'general' | 'chatMode' | 'environment' | 'subagents' | 'memory' | 'dev' | 'model' | 'mcp' | 'tools' | 'skills'

export const settingsTabs: Array<{
  id: SettingsTab
  labelKey: string
  descriptionKey: string
  Icon: LucideIcon
}> = [
  { id: 'general', labelKey: 'settings.tabs.general', descriptionKey: 'settings.tab_descriptions.general', Icon: Settings },
  { id: 'model', labelKey: 'settings.tabs.model', descriptionKey: 'settings.tab_descriptions.model', Icon: Bot },
  { id: 'chatMode', labelKey: 'settings.tabs.chat_mode', descriptionKey: 'settings.tab_descriptions.chat_mode', Icon: SlidersHorizontal },
  { id: 'capabilities', labelKey: 'settings.capabilities', descriptionKey: 'settings.tab_descriptions.capabilities', Icon: ListChecks },
  { id: 'environment', labelKey: 'settings.tabs.environment', descriptionKey: 'settings.tab_descriptions.environment', Icon: Earth },
  { id: 'subagents', labelKey: 'settings.tabs.subagents', descriptionKey: 'settings.tab_descriptions.subagents', Icon: GitFork },
  { id: 'skills', labelKey: 'settings.tabs.skills', descriptionKey: 'settings.tab_descriptions.skills', Icon: Wand2 },
  { id: 'mcp', labelKey: 'settings.tabs.mcp', descriptionKey: 'settings.tab_descriptions.mcp', Icon: Plug },
  { id: 'tools', labelKey: 'settings.tools_page', descriptionKey: 'settings.tab_descriptions.tools', Icon: Wrench },
  { id: 'memory', labelKey: 'settings.tabs.memory', descriptionKey: 'settings.tab_descriptions.memory', Icon: Brain },
  { id: 'dev', labelKey: 'settings.tabs.dev', descriptionKey: 'settings.tab_descriptions.dev', Icon: Code2 }
]
