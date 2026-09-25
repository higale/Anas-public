import { useCallback, useRef } from 'react'

export interface AutosaveRevision {
  entityId: string
  revision: number
}

export interface AutosaveRequest extends AutosaveRevision {
  isCurrent(): boolean
}

type QueuedAutosaveTask = (request: AutosaveRequest) => Promise<void>

export class QueuedAutosave {
  private queue: Promise<void> = Promise.resolve()
  private current?: AutosaveRevision
  private revision = 0

  revise(entityId: string): AutosaveRevision {
    const next = { entityId, revision: ++this.revision }
    this.current = next
    return next
  }

  isCurrent(revision: AutosaveRevision): boolean {
    return revision.revision === this.current?.revision
      && revision.entityId === this.current.entityId
  }

  async enqueue(revision: AutosaveRevision, task: QueuedAutosaveTask): Promise<boolean> {
    const request: AutosaveRequest = {
      ...revision,
      isCurrent: () => this.isCurrent(revision)
    }
    const saveTask = this.queue
      .catch(() => undefined)
      .then(() => task(request))
    this.queue = saveTask
    await saveTask
    return request.isCurrent()
  }

  async waitForIdle(): Promise<void> {
    await this.queue.catch(() => undefined)
  }
}

export function useQueuedAutosave(): {
  enqueue: (revision: AutosaveRevision, task: QueuedAutosaveTask) => Promise<boolean>
  isCurrent: (revision: AutosaveRevision) => boolean
  revise: (entityId: string) => AutosaveRevision
  waitForIdle: () => Promise<void>
} {
  const autosaveRef = useRef<QueuedAutosave | null>(null)
  if (!autosaveRef.current) autosaveRef.current = new QueuedAutosave()
  const autosave = autosaveRef.current

  const enqueue = useCallback(
    (revision: AutosaveRevision, task: QueuedAutosaveTask) => autosave.enqueue(revision, task),
    [autosave]
  )
  const isCurrent = useCallback(
    (revision: AutosaveRevision) => autosave.isCurrent(revision),
    [autosave]
  )
  const revise = useCallback(
    (entityId: string) => autosave.revise(entityId),
    [autosave]
  )
  const waitForIdle = useCallback(() => autosave.waitForIdle(), [autosave])

  return { enqueue, isCurrent, revise, waitForIdle }
}
