import { randomUUID } from 'node:crypto'
import { userInputSchema, userInputResponseSchema } from '@shared/userInput'
import type { UserInputRequest, UserInputResult, UserInputSnapshot, UserInputSource } from '@shared/userInput'

interface PendingInput {
  request: UserInputRequest
  shown: boolean
  timer?: ReturnType<typeof setTimeout>
  finish(result: UserInputResult): void
}

/** Transient UI requests, not conversation state. The native tool returns the answer. */
export class UserInputService {
  private pending = new Map<string, PendingInput>()
  private listeners = new Set<(snapshot: UserInputSnapshot) => void>()
  private revision = 0

  snapshot(): UserInputSnapshot {
    return { revision: this.revision, requests: [...this.pending.values()].map(({ request }) => ({ ...request })) }
  }

  subscribe(listener: (snapshot: UserInputSnapshot) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private changed(): void {
    // Only the head is eligible for display. Queued questions must not expire
    // while the user is still answering an earlier dialog.
    const head = this.pending.values().next().value as PendingInput | undefined
    if (head && !head.shown && !head.timer) {
      head.timer = setTimeout(() => head.finish({ status: 'cancelled' }), 60_000)
    }
    this.revision++
    const snapshot = this.snapshot()
    for (const listener of this.listeners) listener(snapshot)
  }

  request(input: unknown, context: { threadId: string; runId: string; source: UserInputSource; signal?: AbortSignal }): Promise<UserInputResult> {
    const value = userInputSchema.parse(input)
    if (context.signal?.aborted) return Promise.resolve({ status: 'cancelled' })
    const request: UserInputRequest = { id: randomUUID(), threadId: context.threadId, runId: context.runId, source: context.source,
      questions: value.questions, requireResponse: value.require_response ?? false, interacted: false, timeoutSeconds: value.timeout_seconds ?? 60 }
    return new Promise((resolve) => {
      const abort = () => entry.finish({ status: 'cancelled' })
      const entry: PendingInput = { request, shown: false, finish: result => {
        if (!this.pending.delete(request.id)) return
        clearTimeout(entry.timer)
        context.signal?.removeEventListener('abort', abort)
        resolve(result)
        this.changed()
      } }
      this.pending.set(request.id, entry)
      context.signal?.addEventListener('abort', abort, { once: true })
      this.changed()
    })
  }

  shown(id: string): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    if (this.pending.keys().next().value !== id) return false
    if (entry.shown) return true
    entry.shown = true
    clearTimeout(entry.timer)
    if (!entry.request.requireResponse) {
      entry.request.deadline = Date.now() + entry.request.timeoutSeconds * 1_000
      entry.timer = setTimeout(() => entry.finish({ status: 'timed_out' }), entry.request.timeoutSeconds * 1_000)
    }
    this.changed()
    return true
  }

  interact(id: string): boolean {
    const entry = this.pending.get(id)
    if (!entry || !entry.shown) return false
    if (entry.request.deadline !== undefined && Date.now() >= entry.request.deadline) {
      entry.finish({ status: 'timed_out' })
      return false
    }
    if (entry.request.interacted) return true
    clearTimeout(entry.timer)
    entry.timer = undefined
    delete entry.request.deadline
    entry.request.interacted = true
    this.changed()
    return true
  }

  respond(id: string, value: unknown): boolean {
    const entry = this.pending.get(id)
    if (!entry || !entry.shown) return false
    if (entry.request.deadline !== undefined && Date.now() >= entry.request.deadline) {
      entry.finish({ status: 'timed_out' })
      return false
    }
    const response = userInputResponseSchema.parse(value)
    if (response.status === 'answered') {
      const answers = new Map(response.answers.map(answer => [answer.question_id, answer]))
      if (answers.size !== response.answers.length || answers.size !== entry.request.questions.length) {
        throw new Error('Every question requires exactly one answer.')
      }
      for (const question of entry.request.questions) {
        const answer = answers.get(question.id)
        if (!answer || (!answer.other && answer.selected_options.length === 0)
          || new Set(answer.selected_options).size !== answer.selected_options.length
          || answer.selected_options.some(label => !question.options.some(option => option.label === label))
          || (!question.multiple && answer.selected_options.length + (answer.other ? 1 : 0) > 1)) {
          throw new Error('Answer does not match the question options or selection mode.')
        }
      }
    }
    entry.finish(response)
    return true
  }
}

export const userInputService = new UserInputService()
