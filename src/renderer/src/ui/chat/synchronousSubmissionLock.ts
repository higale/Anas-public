export class SynchronousSubmissionLock {
  private active = false

  get locked(): boolean {
    return this.active
  }

  async run<T>(action: () => T | Promise<T>): Promise<T | undefined> {
    if (this.active) return undefined
    this.active = true
    try {
      return await action()
    } finally {
      this.active = false
    }
  }
}
