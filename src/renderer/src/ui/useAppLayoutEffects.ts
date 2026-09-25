import { type FormEvent, useCallback, useEffect } from 'react'
import { resizeAutosizeTextarea, resizeAutosizeTextareasIn } from './autosizeTextarea'
import { scrollListToBottom } from './chat/scrollUtils'

type MutableRef<T> = {
  current: T
}

type AppLayoutEffectsOptions = {
  busy: boolean
  chatPanelRef: MutableRef<HTMLElement | null>
  composerInputRef: MutableRef<HTMLTextAreaElement | null>
  editingMcpIndex: number | undefined
  error: string | undefined
  followOutputRef: MutableRef<boolean>
  input: string
  mcpListRef: MutableRef<HTMLDivElement | null>
  mcpServerCount: number | undefined
  memoryDraft: unknown
  messages: unknown
  mcpArgsText: string
  mcpEnvText: string
  nextFollowOutputScrollBehaviorRef: MutableRef<ScrollBehavior>
  settingsContentRef: MutableRef<HTMLDivElement | null>
  settingsOpen: boolean
  settingsTab: string
  subagentDescription: string
  subagentSystemPrompt: string
}

export function useAppLayoutEffects({
  busy,
  chatPanelRef,
  composerInputRef,
  editingMcpIndex,
  error,
  followOutputRef,
  input,
  mcpListRef,
  mcpServerCount,
  memoryDraft,
  messages,
  mcpArgsText,
  mcpEnvText,
  nextFollowOutputScrollBehaviorRef,
  settingsContentRef,
  settingsOpen,
  settingsTab,
  subagentDescription,
  subagentSystemPrompt,
}: AppLayoutEffectsOptions): {
  handleAutosizeInput: (event: FormEvent<HTMLTextAreaElement>) => void
} {
  const resizeSettingsTextareas = useCallback((): void => {
    resizeAutosizeTextareasIn(settingsContentRef.current)
  }, [settingsContentRef])

  const resizeComposerInput = useCallback((): void => {
    resizeAutosizeTextarea(composerInputRef.current)
  }, [composerInputRef])

  const handleAutosizeInput = useCallback((event: FormEvent<HTMLTextAreaElement>): void => {
    resizeAutosizeTextarea(event.currentTarget)
  }, [])

  useEffect(() => {
    function handleResize(): void {
      window.requestAnimationFrame(() => {
        resizeComposerInput()
        resizeSettingsTextareas()
      })
    }
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [resizeComposerInput, resizeSettingsTextareas])

  useEffect(() => {
    window.requestAnimationFrame(resizeComposerInput)
  }, [input, resizeComposerInput])

  useEffect(() => {
    if (!settingsOpen) return
    window.requestAnimationFrame(resizeSettingsTextareas)
  }, [
    settingsOpen,
    settingsTab,
    mcpArgsText,
    mcpEnvText,
    memoryDraft,
    subagentDescription,
    subagentSystemPrompt,
    resizeSettingsTextareas
  ])

  useEffect(() => {
    if (!settingsOpen) return
    if (settingsContentRef.current) settingsContentRef.current.scrollTop = 0
  }, [settingsContentRef, settingsOpen, settingsTab])

  useEffect(() => {
    if (!followOutputRef.current) return
    const panel = chatPanelRef.current
    if (!panel) return
    const behavior = busy ? 'auto' : nextFollowOutputScrollBehaviorRef.current
    nextFollowOutputScrollBehaviorRef.current = 'smooth'
    panel.scrollTo({ top: panel.scrollHeight, behavior })
  }, [
    messages,
    busy,
    error,
    chatPanelRef,
    followOutputRef,
    nextFollowOutputScrollBehaviorRef
  ])

  useEffect(() => {
    if (settingsTab === 'mcp' && mcpServerCount !== undefined && editingMcpIndex === mcpServerCount - 1) {
      scrollListToBottom(mcpListRef.current)
    }
  }, [editingMcpIndex, mcpListRef, mcpServerCount, settingsTab])

  return {
    handleAutosizeInput
  }
}
