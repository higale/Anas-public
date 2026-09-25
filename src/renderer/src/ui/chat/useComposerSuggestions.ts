import { useCallback, useMemo, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { TFunction } from 'i18next'
import type { InputHistorySnapshot, SkillSnapshot } from '@shared/types'
import { parseSlashSkillInput } from '@shared/skillShortcuts'
import type { ComposerSuggestion, SlashCommand } from './composerTypes'

interface UseComposerSuggestionsOptions {
  input: string
  inputHistory: InputHistorySnapshot
  setInput: Dispatch<SetStateAction<string>>
  skills: SkillSnapshot | undefined
  skillShortcutsEnabled: boolean
  t: TFunction
}

export function useComposerSuggestions({
  input,
  inputHistory,
  setInput,
  skills,
  skillShortcutsEnabled,
  t
}: UseComposerSuggestionsOptions) {
  const [suggestionMode, setSuggestionMode] = useState<'auto' | 'all' | 'fav'>('auto')
  const [dismissedSuggestionText, setDismissedSuggestionText] = useState<string | undefined>()

  const builtInSlashCommands = useMemo<SlashCommand[]>(() => [
    { name: '/all', description: t('chat.command_all'), action: () => { setSuggestionMode('all') } },
    { name: '/fav', description: t('chat.command_fav'), action: () => { setSuggestionMode('fav') } }
  ], [t])

  const userSkillSlashCommands = useMemo<SlashCommand[]>(() => {
    if (!skillShortcutsEnabled) return []
    return (skills?.skills ?? [])
      .filter((skill) => skill.userAvailable && !skill.loadError && skill.shortcut)
      .map((skill) => ({
        name: skill.shortcut!,
        description: `${skill.rootName} · ${skill.description || skill.name}`,
        skillName: skill.name
      }))
  }, [skillShortcutsEnabled, skills?.skills])

  const slashCommands = useMemo(
    () => [...builtInSlashCommands, ...userSkillSlashCommands],
    [builtInSlashCommands, userSkillSlashCommands]
  )

  const composerSuggestions = useMemo<ComposerSuggestion[]>(() => {
    const rawQuery = input.trim()
    const query = rawQuery.toLowerCase()
    const items = inputHistory.items
    const activeSuggestionMode = query === '/all' || query === '/fav'
      ? query.slice(1)
      : suggestionMode

    if (activeSuggestionMode === 'all') {
      return items.map((item) => ({
        id: `history:${item.text}`,
        kind: item.pinned ? 'favorite' : 'history',
        text: item.text,
        item
      }))
    }

    if (activeSuggestionMode === 'fav') {
      return items.filter((item) => item.pinned).map((item) => ({
        id: `favorite:${item.text}`,
        kind: 'favorite',
        text: item.text,
        item
      }))
    }

    if (rawQuery === '/' || parseSlashSkillInput(rawQuery)) {
      return slashCommands
        .filter((command) => command.name.includes(query) && command.name !== query)
        .map((command) => ({
          id: `command:${command.name}`,
          kind: 'command',
          text: command.name,
          description: command.description,
          command
        }))
    }

    if (query.length === 0) return []
    return items
      .filter((item) => item.text.toLowerCase().includes(query) && item.text.trim().toLowerCase() !== query)
      .slice(0, 10)
      .map((item) => ({
        id: `${item.pinned ? 'favorite' : 'history'}:${item.text}`,
        kind: item.pinned ? 'favorite' : 'history',
        text: item.text,
        item
      }))
  }, [input, inputHistory.items, slashCommands, suggestionMode])

  const showComposerSuggestions = composerSuggestions.length > 0 && input !== dismissedSuggestionText

  const handleInputChange = useCallback((value: string): void => {
    setInput(value)
    setSuggestionMode('auto')
    if (value !== dismissedSuggestionText) setDismissedSuggestionText(undefined)
  }, [dismissedSuggestionText, setInput])

  const applyComposerSuggestion = useCallback((suggestion: ComposerSuggestion): void => {
    setDismissedSuggestionText(undefined)
    if (suggestion.kind === 'command' && suggestion.command) {
      const exactInput = input.trim().toLowerCase() === suggestion.command.name.toLowerCase()
      if (exactInput && suggestion.command.action) {
        void suggestion.command.action()
        return
      }
      setInput(suggestion.command.skillName ? `${suggestion.command.name} ` : suggestion.command.name)
      setSuggestionMode('auto')
      return
    }
    setInput(suggestion.text)
    setSuggestionMode('auto')
  }, [input, setInput])

  const dismissComposerSuggestions = useCallback((): void => {
    setDismissedSuggestionText(input)
    setSuggestionMode('auto')
  }, [input])

  const resetComposerSuggestions = useCallback((): void => {
    setDismissedSuggestionText(undefined)
    setSuggestionMode('auto')
  }, [])

  const executeExactSlashCommand = useCallback((): boolean => {
    const value = input.trim().toLowerCase()
    const command = builtInSlashCommands.find((item) => item.name.toLowerCase() === value)
    if (!command?.action) return false
    void command.action()
    return true
  }, [builtInSlashCommands, input])

  return {
    applyComposerSuggestion,
    composerSuggestions,
    dismissComposerSuggestions,
    executeExactSlashCommand,
    handleInputChange,
    resetComposerSuggestions,
    showComposerSuggestions,
  }
}
