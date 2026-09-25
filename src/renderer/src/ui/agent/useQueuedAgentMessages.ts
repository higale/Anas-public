import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentQueuedInput,
  AgentQueuedInputCreate,
  AgentRuntimeEvent
} from '@shared/agentTypes'
import type { SelectedAttachment } from '@shared/types'
import { selectedAttachmentInput } from '../chat/attachmentUtils'

export type QueuedAgentMessageStatus = AgentQueuedInput['status'] | 'direction_pending' | 'dispatching'

export interface QueuedAgentMessage extends Omit<AgentQueuedInput, 'status'> {
  status: QueuedAgentMessageStatus
  targetRunId?: string
}

interface UseQueuedAgentMessagesOptions {
  readyThreadIds: ReadonlySet<string>
  onDispatchError(threadId: string | undefined): void
}

function removeMessage(
  current: Record<string, QueuedAgentMessage[]>,
  threadId: string,
  id: string
): Record<string, QueuedAgentMessage[]> {
  const remaining = (current[threadId] ?? []).filter((item) => item.id !== id)
  if (remaining.length === (current[threadId] ?? []).length) return current
  const next = { ...current }
  if (remaining.length > 0) next[threadId] = remaining
  else delete next[threadId]
  return next
}

function groupMessages(items: QueuedAgentMessage[]): Record<string, QueuedAgentMessage[]> {
  const grouped: Record<string, QueuedAgentMessage[]> = {}
  for (const item of items) {
    grouped[item.threadId] = [...(grouped[item.threadId] ?? []), item]
  }
  return grouped
}

function resetPendingDirections(
  current: Record<string, QueuedAgentMessage[]>,
  threadId: string,
  runId: string
): Record<string, QueuedAgentMessage[]> {
  const items = current[threadId]
  if (!items?.some((item) =>
    item.status === 'direction_pending' && item.targetRunId === runId
  )) return current
  return {
    ...current,
    [threadId]: items.map((item) =>
      item.status === 'direction_pending' && item.targetRunId === runId
        ? { ...item, status: 'queued' as const, targetRunId: undefined }
        : item
    )
  }
}

function mergeLoadedMessages(
  current: Record<string, QueuedAgentMessage[]>,
  loaded: AgentQueuedInput[]
): Record<string, QueuedAgentMessage[]> {
  const localById = new Map(
    Object.values(current).flat().map((item) => [item.id, item])
  )
  const merged: QueuedAgentMessage[] = loaded.map((item) => {
    const local = localById.get(item.id)
    return local ?? item
  })
  // A refresh is authoritative for membership. Local-only items are guarded
  // by the projection revision while the request is in flight, so anything
  // still absent here was durably removed while its event was unavailable.
  merged.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  return groupMessages(merged)
}

export function useQueuedAgentMessages({
  readyThreadIds,
  onDispatchError
}: UseQueuedAgentMessagesOptions) {
  const [messagesByThread, setMessagesByThread] = useState<Record<string, QueuedAgentMessage[]>>({})
  const [loaded, setLoaded] = useState(false)
  const [availabilityRevision, setAvailabilityRevision] = useState(0)
  const messagesByThreadRef = useRef(messagesByThread)
  messagesByThreadRef.current = messagesByThread
  const onDispatchErrorRef = useRef(onDispatchError)
  onDispatchErrorRef.current = onDispatchError
  const projectionRevisionRef = useRef(0)
  const refreshInFlightRef = useRef<Promise<void> | undefined>(undefined)
  const dispatchingThreadsRef = useRef(new Set<string>())
  const directionMutationsRef = useRef(new Set<string>())
  const unsettledThreadsRef = useRef(new Set<string>())

  const refresh = useCallback((): Promise<void> => {
    const existing = refreshInFlightRef.current
    if (existing) return existing
    const request = (async (): Promise<void> => {
      while (true) {
        const projectionRevision = projectionRevisionRef.current
        const items = await window.gale.agent.queuedInputs.list()
        if (projectionRevision !== projectionRevisionRef.current) continue
        setMessagesByThread((current) => mergeLoadedMessages(current, items))
        return
      }
    })()
    refreshInFlightRef.current = request
    const release = (): void => {
      if (refreshInFlightRef.current === request) refreshInFlightRef.current = undefined
    }
    void request.then(release, release)
    return request
  }, [])

  useEffect(() => {
    let cancelled = false
    void refresh()
      .catch(() => {
        if (!cancelled) onDispatchErrorRef.current(undefined)
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [refresh])

  useEffect(() => window.gale.agent.onEvent((event: AgentRuntimeEvent) => {
    if (event.type === 'run_started') {
      if (event.run.operation === 'agent') unsettledThreadsRef.current.add(event.run.threadId)
      return
    }
    if (event.type === 'direction_applied') {
      projectionRevisionRef.current += 1
      setMessagesByThread((current) => removeMessage(
        current,
        event.threadId,
        event.queuedInputId
      ))
      return
    }
    if (
      event.type !== 'run_settled'
      || event.operation !== 'agent'
    ) return
    if (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled') {
      unsettledThreadsRef.current.delete(event.threadId)
      setAvailabilityRevision((current) => current + 1)
    }
    projectionRevisionRef.current += 1
    setMessagesByThread((current) => resetPendingDirections(
      current,
      event.threadId,
      event.runId
    ))
    void refresh().catch(() => onDispatchErrorRef.current(event.threadId))
  }, async () => {
    await refresh()
    // The preload hub replays every still-active run after synchronization.
    // Clear stale ownership first so a missed terminal event cannot block the
    // next durable queued input forever.
    unsettledThreadsRef.current.clear()
  }, () => onDispatchErrorRef.current(undefined)), [refresh])

  useEffect(() => {
    if (!loaded) return
    for (const threadId of readyThreadIds) {
      if (unsettledThreadsRef.current.has(threadId)) continue
      if (dispatchingThreadsRef.current.has(threadId)) continue
      const item = messagesByThread[threadId]?.[0]
      if (!item || item.status !== 'queued') continue
      dispatchingThreadsRef.current.add(threadId)
      unsettledThreadsRef.current.add(threadId)
      projectionRevisionRef.current += 1
      setMessagesByThread((current) => ({
        ...current,
        [threadId]: (current[threadId] ?? []).map((candidate) =>
          candidate.id === item.id ? { ...candidate, status: 'dispatching' as const } : candidate
        )
      }))
      void window.gale.agent.runs.submit({
        requestId: item.id,
        threadId,
        text: item.text,
        displayText: item.displayText === item.text ? undefined : item.displayText,
        attachments: item.attachments.map(selectedAttachmentInput)
      }).then(async (submission) => {
        await window.gale.agent.queuedInputs.remove(threadId, item.id)
        projectionRevisionRef.current += 1
        setMessagesByThread((current) => removeMessage(current, threadId, item.id))
        if (submission.run.status !== 'running' && submission.run.status !== 'interrupted') {
          unsettledThreadsRef.current.delete(threadId)
          setAvailabilityRevision((current) => current + 1)
        }
      }).catch(async (reason) => {
        unsettledThreadsRef.current.delete(threadId)
        const message = reason instanceof Error ? reason.message : String(reason)
        let failed: AgentQueuedInput = {
          ...item,
          status: 'failed',
          error: message
        }
        try {
          failed = await window.gale.agent.queuedInputs.markFailed(
            threadId,
            item.id,
            message
          )
        } catch {
          // Keep the item visibly retryable even if persisting the error failed.
        }
        projectionRevisionRef.current += 1
        setMessagesByThread((current) => ({
          ...current,
          [threadId]: (current[threadId] ?? []).map((candidate) =>
            candidate.id === item.id ? failed : candidate
          )
        }))
        onDispatchError(threadId)
      }).finally(() => {
        dispatchingThreadsRef.current.delete(threadId)
      })
    }
  }, [availabilityRevision, loaded, messagesByThread, onDispatchError, readyThreadIds])

  const enqueue = useCallback(async (
    threadId: string,
    text: string,
    displayText = text,
    attachments: SelectedAttachment[] = []
  ): Promise<QueuedAgentMessage> => {
    const input: AgentQueuedInputCreate = {
      id: globalThis.crypto.randomUUID(),
      threadId,
      text,
      ...(displayText === text ? {} : { displayText }),
      attachments: attachments.map(selectedAttachmentInput)
    }
    const item = await window.gale.agent.queuedInputs.enqueue(input)
    projectionRevisionRef.current += 1
    setMessagesByThread((current) => ({
      ...current,
      [threadId]: [...(current[threadId] ?? []), item]
    }))
    return item
  }, [])

  const steer = useCallback(async (item: QueuedAgentMessage, runId: string): Promise<boolean> => {
    const current = messagesByThreadRef.current[item.threadId]?.find((candidate) => candidate.id === item.id)
    if (!current || current.status !== 'queued' || directionMutationsRef.current.has(item.id)) return false
    directionMutationsRef.current.add(item.id)
    try {
      const accepted = await window.gale.agent.runs.steer({
        threadId: current.threadId,
        runId,
        queuedInputId: current.id,
        text: current.text,
        displayText: current.displayText === current.text ? undefined : current.displayText,
        attachments: current.attachments.map(selectedAttachmentInput)
      })
      if (!accepted) return false
      projectionRevisionRef.current += 1
      setMessagesByThread((state) => ({
        ...state,
        [current.threadId]: (state[current.threadId] ?? []).map((candidate) =>
          candidate.id === current.id && candidate.status === 'queued'
            ? { ...candidate, status: 'direction_pending' as const, targetRunId: runId }
            : candidate
        )
      }))
      return true
    } finally {
      directionMutationsRef.current.delete(item.id)
    }
  }, [])

  const remove = useCallback(async (item: QueuedAgentMessage): Promise<boolean> => {
    const current = messagesByThreadRef.current[item.threadId]?.find((candidate) => candidate.id === item.id)
    if (!current || current.status === 'dispatching' || directionMutationsRef.current.has(item.id)) return false
    directionMutationsRef.current.add(item.id)
    try {
      if (current.status === 'direction_pending' && current.targetRunId) {
        const removed = await window.gale.agent.runs.removeSteer({
          threadId: current.threadId,
          runId: current.targetRunId,
          queuedInputId: current.id
        })
        if (!removed) return false
      }
      const removed = await window.gale.agent.queuedInputs.remove(current.threadId, current.id)
      if (!removed) return false
      projectionRevisionRef.current += 1
      setMessagesByThread((state) => removeMessage(state, current.threadId, current.id))
      return true
    } finally {
      directionMutationsRef.current.delete(item.id)
    }
  }, [])

  const retry = useCallback(async (item: QueuedAgentMessage): Promise<boolean> => {
    const current = messagesByThreadRef.current[item.threadId]?.find((candidate) => candidate.id === item.id)
    if (!current || current.status !== 'failed') return false
    const queued = await window.gale.agent.queuedInputs.retry(current.threadId, current.id)
    projectionRevisionRef.current += 1
    setMessagesByThread((state) => ({
      ...state,
      [current.threadId]: (state[current.threadId] ?? []).map((candidate) =>
        candidate.id === current.id ? queued : candidate
      )
    }))
    return true
  }, [])

  const forgetThread = useCallback((threadId: string): void => {
    projectionRevisionRef.current += 1
    setMessagesByThread((current) => {
      if (!(threadId in current)) return current
      const next = { ...current }
      delete next[threadId]
      return next
    })
  }, [])

  return useMemo(() => ({
    enqueue,
    forgetThread,
    messagesByThread,
    remove,
    retry,
    steer
  }), [enqueue, forgetThread, messagesByThread, remove, retry, steer])
}
