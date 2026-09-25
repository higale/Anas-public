export interface ThreadErrorState {
  draft?: string
  threads: Record<string, string | undefined>
}

export function createThreadErrorState(): ThreadErrorState {
  return { threads: {} }
}

export function threadErrorFor(
  state: ThreadErrorState,
  threadId: string | undefined
): string | undefined {
  return threadId ? state.threads[threadId] : state.draft
}

export function updateThreadError(
  state: ThreadErrorState,
  threadId: string | undefined,
  error: string | undefined
): ThreadErrorState {
  if (!threadId) return state.draft === error ? state : { ...state, draft: error }
  if (state.threads[threadId] === error) return state
  const threads = { ...state.threads }
  if (error) threads[threadId] = error
  else delete threads[threadId]
  return { ...state, threads }
}

export function forgetThreadErrors(
  state: ThreadErrorState,
  threadIds: Iterable<string>
): ThreadErrorState {
  const forgotten = new Set(threadIds)
  if (forgotten.size === 0) return state
  const threads = Object.fromEntries(
    Object.entries(state.threads).filter(([threadId]) => !forgotten.has(threadId))
  )
  return Object.keys(threads).length === Object.keys(state.threads).length
    ? state
    : { ...state, threads }
}
