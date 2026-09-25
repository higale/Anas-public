import { type KeyboardEvent, useCallback } from 'react'
import { resizeAutosizeTextarea } from '../autosizeTextarea'

type UseComposerKeyDownOptions = {
  dismissComposerSuggestions: () => void
  handleInputChange: (value: string) => void
  sendCurrentMessage: () => void | Promise<void>
  showComposerSuggestions: boolean
}

export function useComposerKeyDown({
  dismissComposerSuggestions,
  handleInputChange,
  sendCurrentMessage,
  showComposerSuggestions
}: UseComposerKeyDownOptions): (event: KeyboardEvent<HTMLTextAreaElement>) => void {
  return useCallback((event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const commandNewline = document.documentElement.dataset.platform === 'darwin' && event.metaKey
    const explicitNewline = event.ctrlKey || event.altKey || commandNewline
    const wantsNewline = event.shiftKey || explicitNewline
    if (event.key === 'Enter' && event.nativeEvent.isComposing) return

    if (event.key === 'Enter' && explicitNewline) {
      event.preventDefault()
      const textarea = event.currentTarget
      const start = textarea.selectionStart
      const end = textarea.selectionEnd
      const next = `${textarea.value.slice(0, start)}\n${textarea.value.slice(end)}`
      handleInputChange(next)
      requestAnimationFrame(() => {
        textarea.selectionStart = start + 1
        textarea.selectionEnd = start + 1
        resizeAutosizeTextarea(textarea)
      })
      return
    }

    if (showComposerSuggestions && event.key === 'Escape') {
      event.preventDefault()
      dismissComposerSuggestions()
      return
    }
    if (event.key !== 'Enter') return
    if (wantsNewline) return
    event.preventDefault()
    void sendCurrentMessage()
  }, [
    dismissComposerSuggestions,
    handleInputChange,
    sendCurrentMessage,
    showComposerSuggestions
  ])
}
