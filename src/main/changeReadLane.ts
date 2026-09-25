/** Superseding reads in one view lane wait for previous work to release its resources. */
export class ChangeReadLane {
  private current?: { id: string; controller: AbortController; settled: Promise<void> }

  read<T>(id: string, query: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const previous = this.current
    previous?.controller.abort()
    const controller = new AbortController()
    const result = (previous?.settled ?? Promise.resolve()).then(() => {
      controller.signal.throwIfAborted()
      return query(controller.signal)
    })
    const entry = { id, controller, settled: result.then(() => {}, () => {}) }
    this.current = entry
    void entry.settled.then(() => { if (this.current === entry) this.current = undefined })
    return result
  }

  cancel(id: string): void {
    if (this.current?.id === id) this.current.controller.abort()
  }

  dispose(): void { this.current?.controller.abort() }
}
