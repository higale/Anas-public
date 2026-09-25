export interface AgentSnapshotLoadGuard {
  isCurrent(): boolean
}

type AgentSnapshotLoader = (guard: AgentSnapshotLoadGuard) => Promise<void>

interface LoadAttempt {
  generation: number
  promise: Promise<void>
}

interface QueuedLoadAttempt extends LoadAttempt {
  loader: AgentSnapshotLoader
  resolve(): void
  reject(reason: unknown): void
}

interface ThreadReadinessState {
  generation: number
  readyGeneration?: number
  active?: LoadAttempt
  queued?: QueuedLoadAttempt
}

function deferredLoadAttempt(
  generation: number,
  loader: AgentSnapshotLoader
): QueuedLoadAttempt {
  let resolve!: () => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { generation, loader, promise, resolve, reject }
}

export class AgentSnapshotReadiness {
  private readonly states = new Map<string, ThreadReadinessState>()

  markReady(threadId: string): void {
    const state = this.state(threadId)
    this.advanceGeneration(state)
    state.readyGeneration = state.generation
  }

  markNotReady(threadId: string): void {
    const state = this.state(threadId)
    this.advanceGeneration(state)
    state.readyGeneration = undefined
  }

  markProjectionReady(threadId: string): void {
    const state = this.state(threadId)
    state.readyGeneration = state.generation
  }

  markProjected(threadId: string): void {
    const state = this.state(threadId)
    const wasReady = state.readyGeneration === state.generation
    this.advanceGeneration(state)
    state.readyGeneration = wasReady ? state.generation : undefined
  }

  forget(threadId: string): void {
    const state = this.states.get(threadId)
    if (!state) return
    this.advanceGeneration(state)
    this.states.delete(threadId)
  }

  guard(threadId: string): AgentSnapshotLoadGuard {
    const state = this.state(threadId)
    const generation = state.generation
    return {
      isCurrent: () => (
        this.states.get(threadId) === state
        && state.generation === generation
      )
    }
  }

  async load(
    threadId: string,
    loader: AgentSnapshotLoader,
    refresh = false
  ): Promise<void> {
    const state = this.state(threadId)
    if (refresh) {
      this.advanceGeneration(state)
      state.readyGeneration = undefined
    }

    while (this.states.get(threadId) === state) {
      const generation = state.generation
      if (state.readyGeneration === generation) {
        const active = state.active
        if (!active) return
        try {
          await active.promise
        } catch (reason) {
          if (
            this.states.get(threadId) === state
            && state.generation === generation
            && state.readyGeneration !== generation
          ) {
            throw reason
          }
        }
        continue
      }

      const attempt = this.requestAttempt(threadId, state, generation, loader)
      try {
        await attempt
      } catch (reason) {
        if (
          this.states.get(threadId) === state
          && state.generation === generation
          && state.readyGeneration !== generation
        ) {
          throw reason
        }
      }
    }
  }

  private state(threadId: string): ThreadReadinessState {
    const existing = this.states.get(threadId)
    if (existing) return existing
    const created: ThreadReadinessState = { generation: 0 }
    this.states.set(threadId, created)
    return created
  }

  private advanceGeneration(state: ThreadReadinessState): void {
    state.generation += 1
    const queued = state.queued
    if (!queued) return
    state.queued = undefined
    queued.resolve()
  }

  private requestAttempt(
    threadId: string,
    state: ThreadReadinessState,
    generation: number,
    loader: AgentSnapshotLoader
  ): Promise<void> {
    const active = state.active
    if (!active) return this.startAttempt(threadId, state, generation, loader)
    if (active.generation === generation) return active.promise

    const queued = state.queued
    if (queued?.generation === generation) return queued.promise
    if (queued) queued.resolve()

    const next = deferredLoadAttempt(generation, loader)
    state.queued = next
    return next.promise
  }

  private startAttempt(
    threadId: string,
    state: ThreadReadinessState,
    generation: number,
    loader: AgentSnapshotLoader
  ): Promise<void> {
    let resolve!: () => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    const attempt = { generation, promise }
    state.active = attempt

    const { isCurrent } = this.guard(threadId)
    void (async () => {
      try {
        await loader({ isCurrent })
        if (isCurrent()) state.readyGeneration = generation
        resolve()
      } catch (reason) {
        if (isCurrent()) state.readyGeneration = undefined
        reject(reason)
      } finally {
        if (state.active === attempt) state.active = undefined
        this.startQueuedAttempt(threadId, state)
      }
    })()
    return promise
  }

  private startQueuedAttempt(
    threadId: string,
    state: ThreadReadinessState
  ): void {
    const queued = state.queued
    if (!queued) return
    state.queued = undefined

    if (
      this.states.get(threadId) !== state
      || state.readyGeneration === state.generation
      || queued.generation !== state.generation
    ) {
      queued.resolve()
      return
    }

    void this.startAttempt(
      threadId,
      state,
      queued.generation,
      queued.loader
    ).then(queued.resolve, queued.reject)
  }
}
