export interface MessagePaginationRequest {
  readonly signal: AbortSignal
  isCurrent(threadId: string | undefined, panel: HTMLElement | null): boolean
}

export class MessagePaginationCoordinator {
  private generation = 0
  private controller: AbortController | undefined

  begin(threadId: string, panel: HTMLElement): MessagePaginationRequest {
    this.invalidate()
    const generation = this.generation
    const controller = new AbortController()
    this.controller = controller
    return {
      signal: controller.signal,
      isCurrent: (currentThreadId, currentPanel) => (
        !controller.signal.aborted
        && this.generation === generation
        && currentThreadId === threadId
        && currentPanel === panel
      )
    }
  }

  invalidate(): void {
    this.generation += 1
    this.controller?.abort()
    this.controller = undefined
  }
}

export function isAbortError(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === 'AbortError'
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('The request was aborted.', 'AbortError')
}

interface RunMessagePaginationOptions {
  request: MessagePaginationRequest
  threadId: string
  panel: HTMLElement
  currentThreadId(): string | undefined
  currentPanel(): HTMLElement | null
  load(signal: AbortSignal): void | Promise<void>
  onError(threadId: string, error: string): void
  fallbackError: string
  schedule(callback: () => void): void
}

export async function runMessagePagination({
  request,
  threadId,
  panel,
  currentThreadId,
  currentPanel,
  load,
  onError,
  fallbackError,
  schedule
}: RunMessagePaginationOptions): Promise<void> {
  const previousHeight = panel.scrollHeight
  const previousTop = panel.scrollTop
  try {
    await load(request.signal)
    if (!request.isCurrent(currentThreadId(), currentPanel())) return
    schedule(() => {
      if (!request.isCurrent(currentThreadId(), currentPanel())) return
      panel.scrollTop = previousTop + panel.scrollHeight - previousHeight
    })
  } catch (reason) {
    if (isAbortError(reason) || !request.isCurrent(currentThreadId(), currentPanel())) return
    onError(threadId, fallbackError)
  }
}
