export type MessageScrollAnchor = {
  element: HTMLElement
  top: number
}

export function scrollListToBottom(element: HTMLElement | null): void {
  window.requestAnimationFrame(() => {
    if (!element) return
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' })
  })
}

export function getFirstVisibleMessageAnchor(panel: HTMLElement): MessageScrollAnchor | undefined {
  const panelRect = panel.getBoundingClientRect()
  const messages = Array.from(panel.querySelectorAll<HTMLElement>('[data-message-id]'))
  const element = messages.find((candidate) => candidate.getBoundingClientRect().bottom > panelRect.top) ?? messages[0]
  if (!element) return undefined
  return { element, top: element.getBoundingClientRect().top }
}

export function restoreMessageScrollAnchor(panel: HTMLElement, anchor: MessageScrollAnchor, previousScrollHeight: number): void {
  const element = anchor.element.isConnected ? anchor.element : undefined
  if (!element) {
    panel.scrollTop += panel.scrollHeight - previousScrollHeight
    return
  }
  panel.scrollTop += element.getBoundingClientRect().top - anchor.top
}
