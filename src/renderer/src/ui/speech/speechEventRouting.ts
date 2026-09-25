export function shouldHandleSpeechEvent(
  activeThreadId: string | undefined,
  eventThreadId: string
): boolean {
  return Boolean(activeThreadId && activeThreadId === eventThreadId)
}
