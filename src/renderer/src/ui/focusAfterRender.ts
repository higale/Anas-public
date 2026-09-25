type FocusTarget = {
  focus(options?: FocusOptions): void
}

type FocusTargetRef = {
  readonly current: FocusTarget | null
}

export function focusAfterRender(targetRef: FocusTargetRef): void {
  window.requestAnimationFrame(() => {
    targetRef.current?.focus({ preventScroll: true })
  })
}
