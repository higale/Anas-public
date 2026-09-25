import { useState } from 'react'
import type { TFunction } from 'i18next'
import type { InputHistorySnapshot } from '@shared/types'

interface UseInputHistoryStateOptions {
  setError(error: string | undefined): void
  t: TFunction
}

export function useInputHistoryState({ setError, t }: UseInputHistoryStateOptions) {
  const [inputHistory, setInputHistory] = useState<InputHistorySnapshot>({ maxHistory: 100, items: [] })

  async function saveInputHistoryText(text: string): Promise<void> {
    const value = text.trim()
    if (!value) return
    try {
      setInputHistory(await window.gale.inputHistory.add(value))
    } catch {
      // Chat sending should not fail because input history could not be written.
    }
  }

  async function removeInputHistoryItem(text: string): Promise<void> {
    try {
      setInputHistory(await window.gale.inputHistory.remove(text))
    } catch {
      setError(t('chat.failed_remove_input_history'))
    }
  }

  async function toggleInputHistoryPinned(text: string, pinned: boolean): Promise<void> {
    try {
      setInputHistory(await window.gale.inputHistory.setPinned(text, pinned))
    } catch {
      setError(t('chat.failed_update_favorite'))
    }
  }

  return {
    inputHistory,
    removeInputHistoryItem,
    saveInputHistoryText,
    setInputHistory,
    toggleInputHistoryPinned
  }
}
