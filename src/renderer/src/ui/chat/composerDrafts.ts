import { useCallback, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { SelectedAttachment } from '@shared/types'
import type { AgentAccessMode } from '@shared/agentTypes'

export interface ComposerDraft {
  input: string
  attachments: SelectedAttachment[]
  accessMode: AgentAccessMode
}

const emptyDraft = (): ComposerDraft => ({
  input: '',
  attachments: [],
  accessMode: 'read_only_allowed'
})

function isEmptyDraft(draft: ComposerDraft): boolean {
  return draft.input.length === 0
    && draft.attachments.length === 0
    && draft.accessMode === 'read_only_allowed'
}

export function threadComposerDraftKey(threadId: string): string {
  return `thread:${threadId}`
}

export function newThreadComposerDraftKey(projectId: string): string {
  return `new-thread:project:${projectId}`
}

export class ComposerDraftStore {
  private readonly drafts = new Map<string, ComposerDraft>()

  get(key: string): ComposerDraft {
    return this.drafts.get(key) ?? emptyDraft()
  }

  setInput(key: string, input: string): void {
    this.write(key, { ...this.get(key), input })
  }

  setAttachments(key: string, attachments: SelectedAttachment[]): void {
    this.write(key, { ...this.get(key), attachments })
  }

  setAccessMode(key: string, accessMode: AgentAccessMode): void {
    this.write(key, { ...this.get(key), accessMode })
  }

  discard(key: string): ComposerDraft | undefined {
    const draft = this.drafts.get(key)
    if (!draft) return undefined
    this.drafts.delete(key)
    return draft
  }

  discardMany(keys: Iterable<string>): ComposerDraft[] {
    const discarded: ComposerDraft[] = []
    for (const key of new Set(keys)) {
      const draft = this.discard(key)
      if (draft) discarded.push(draft)
    }
    return discarded
  }

  private write(key: string, draft: ComposerDraft): void {
    if (isEmptyDraft(draft)) {
      this.drafts.delete(key)
      return
    }
    this.drafts.set(key, draft)
  }
}

export function useComposerDrafts(activeKey: string) {
  const storeRef = useRef<ComposerDraftStore | null>(null)
  const [, setRevision] = useState(0)
  if (!storeRef.current) storeRef.current = new ComposerDraftStore()
  const store = storeRef.current
  const draft = store.get(activeKey)

  const update = useCallback((action: () => void): void => {
    action()
    setRevision((current) => current + 1)
  }, [])

  const setInput = useCallback<Dispatch<SetStateAction<string>>>((value) => {
    update(() => {
      const current = store.get(activeKey).input
      store.setInput(activeKey, typeof value === 'function' ? value(current) : value)
    })
  }, [activeKey, store, update])

  const setAttachments = useCallback<Dispatch<SetStateAction<SelectedAttachment[]>>>((value) => {
    update(() => {
      const current = store.get(activeKey).attachments
      store.setAttachments(activeKey, typeof value === 'function' ? value(current) : value)
    })
  }, [activeKey, store, update])

  const setAccessMode = useCallback((accessMode: AgentAccessMode): void => {
    update(() => store.setAccessMode(activeKey, accessMode))
  }, [activeKey, store, update])

  const discardDrafts = useCallback((keys: Iterable<string>): ComposerDraft[] => {
    const discarded = store.discardMany(keys)
    if (discarded.length > 0) setRevision((current) => current + 1)
    return discarded
  }, [store])

  return {
    attachments: draft.attachments,
    discardDrafts,
    accessMode: draft.accessMode,
    input: draft.input,
    setAttachments,
    setAccessMode,
    setInput
  }
}
