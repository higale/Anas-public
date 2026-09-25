import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SelectedAttachment } from '@shared/types'
import {
  ComposerDraftStore,
  newThreadComposerDraftKey,
  threadComposerDraftKey
} from './composerDrafts'
import { releaseTemporaryAttachments } from './useComposerAttachments'

function attachment(path: string, temporary = false): SelectedAttachment {
  return {
    path,
    name: path.split('/').at(-1) ?? path,
    size: 1,
    kind: 'text',
    mimeType: 'text/plain',
    contextPolicy: 'one_turn',
    temporary
  }
}

describe('ComposerDraftStore', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('isolates and restores input and attachments for existing threads', () => {
    const store = new ComposerDraftStore()
    const threadA = threadComposerDraftKey('thread-a')
    const threadB = threadComposerDraftKey('thread-b')
    const fileA = attachment('/tmp/a.txt', true)

    store.setInput(threadA, 'draft for A')
    store.setAttachments(threadA, [fileA])

    expect(store.get(threadB)).toEqual({ input: '', attachments: [], accessMode: 'read_only_allowed' })
    store.setInput(threadB, 'draft for B')

    expect(store.get(threadA)).toEqual({
      input: 'draft for A',
      attachments: [fileA],
      accessMode: 'read_only_allowed'
    })
    expect(store.get(threadB)).toEqual({
      input: 'draft for B',
      attachments: [],
      accessMode: 'read_only_allowed'
    })
  })

  it('isolates new-thread drafts by project including the built-in default workspace', () => {
    const store = new ComposerDraftStore()
    const projectA = newThreadComposerDraftKey('project-a')
    const projectB = newThreadComposerDraftKey('project-b')
    const defaultWorkspace = newThreadComposerDraftKey('default-workspace')

    store.setInput(projectA, 'new task in A')
    store.setInput(projectB, 'new task in B')
    store.setInput(defaultWorkspace, 'default workspace task')
    store.setAccessMode(projectA, 'strict_approval')

    expect(store.get(projectA).input).toBe('new task in A')
    expect(store.get(projectA).accessMode).toBe('strict_approval')
    expect(store.get(projectB).input).toBe('new task in B')
    expect(store.get(projectB).accessMode).toBe('read_only_allowed')
    expect(store.get(defaultWorkspace).input).toBe('default workspace task')
  })

  it('returns the exact discarded attachments so temporary files can be released', () => {
    const store = new ComposerDraftStore()
    const threadA = threadComposerDraftKey('thread-a')
    const temporary = attachment('/tmp/edit.txt', true)
    const persistent = attachment('/project/source.txt')
    store.setAttachments(threadA, [temporary, persistent])

    expect(store.discard(threadA)).toEqual({
      input: '',
      attachments: [temporary, persistent],
      accessMode: 'read_only_allowed'
    })
    expect(store.get(threadA)).toEqual({
      input: '',
      attachments: [],
      accessMode: 'read_only_allowed'
    })
    expect(store.discard(threadA)).toBeUndefined()
  })

  it('discards only requested thread drafts during cleanup', () => {
    const store = new ComposerDraftStore()
    const threadA = threadComposerDraftKey('thread-a')
    const threadB = threadComposerDraftKey('thread-b')
    store.setInput(threadA, 'A')
    store.setInput(threadB, 'B')

    expect(store.discardMany([threadA])).toEqual([{
      input: 'A',
      attachments: [],
      accessMode: 'read_only_allowed'
    }])
    expect(store.get(threadA).input).toBe('')
    expect(store.get(threadB).input).toBe('B')
  })

  it('releases only temporary files from a discarded draft', () => {
    const release = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      gale: { files: { releaseTemporaryAttachments: release } }
    })

    releaseTemporaryAttachments([
      attachment('/tmp/edit.txt', true),
      attachment('/project/source.txt')
    ])

    expect(release).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledWith(['/tmp/edit.txt'])
  })
})
