import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentPreview } from '@shared/types'

function preview(path: string): AttachmentPreview {
  return { path, mimeType: 'image/png', src: `data:image/png;base64,${path}` }
}

describe('attachment preview loader', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('deduplicates in-flight requests without retaining stale path results', async () => {
    let resolveFirst: ((value: AttachmentPreview) => void) | undefined
    const readAttachmentPreview = vi.fn((_path: string) => new Promise<AttachmentPreview>((resolve) => {
      resolveFirst = resolve
    }))
    vi.stubGlobal('window', { gale: { files: { readAttachmentPreview } } })
    const { loadAttachmentPreview } = await import('./attachmentPreviewLoader')

    const first = loadAttachmentPreview('C:\\images\\same.png', { mode: 'thumbnail' })
    const duplicate = loadAttachmentPreview('C:\\images\\same.png', { mode: 'thumbnail' })
    expect(duplicate).toBe(first)
    resolveFirst?.(preview('C:\\images\\same.png'))
    await expect(first).resolves.toEqual(preview('C:\\images\\same.png'))
    expect(readAttachmentPreview).toHaveBeenCalledTimes(1)

    const refreshed = loadAttachmentPreview('C:\\images\\same.png', { mode: 'thumbnail' })
    expect(readAttachmentPreview).toHaveBeenCalledTimes(2)
    resolveFirst?.(preview('C:\\images\\same.png'))
    await expect(refreshed).resolves.toEqual(preview('C:\\images\\same.png'))
  })

  it('limits preview IPC concurrency across independently rendered messages', async () => {
    const pending = new Map<string, (value: AttachmentPreview) => void>()
    const readAttachmentPreview = vi.fn((path: string) => new Promise<AttachmentPreview>((resolve) => {
      pending.set(path, resolve)
    }))
    vi.stubGlobal('window', { gale: { files: { readAttachmentPreview } } })
    const { loadAttachmentPreview } = await import('./attachmentPreviewLoader')

    const paths = Array.from({ length: 9 }, (_, index) => `C:\\images\\${index}.png`)
    const requests = paths.map((path) => loadAttachmentPreview(path, { mode: 'thumbnail' }))
    expect(readAttachmentPreview).toHaveBeenCalledTimes(4)

    for (let index = 0; index < paths.length; index += 1) {
      const path = paths[index]
      if (!path) continue
      await vi.waitFor(() => expect(pending.has(path)).toBe(true))
      pending.get(path)?.(preview(path))
    }
    await expect(Promise.all(requests)).resolves.toHaveLength(paths.length)
    expect(readAttachmentPreview).toHaveBeenCalledTimes(paths.length)
  })

  it('isolates relative image requests by project', async () => {
    const readAttachmentPreview = vi.fn(async (path: string) => preview(path))
    vi.stubGlobal('window', { gale: { files: { readAttachmentPreview } } })
    const { loadAttachmentPreview } = await import('./attachmentPreviewLoader')

    await Promise.all([
      loadAttachmentPreview('images/avatar.png', { mode: 'thumbnail', projectId: 'project-a' }),
      loadAttachmentPreview('images/avatar.png', { mode: 'thumbnail', projectId: 'project-b' })
    ])

    expect(readAttachmentPreview).toHaveBeenCalledTimes(2)
    expect(readAttachmentPreview).toHaveBeenCalledWith('images/avatar.png', {
      mode: 'thumbnail',
      size: 240,
      projectId: 'project-a'
    })
    expect(readAttachmentPreview).toHaveBeenCalledWith('images/avatar.png', {
      mode: 'thumbnail',
      size: 240,
      projectId: 'project-b'
    })
  })

  it('rejects overflow instead of growing the renderer queue without bound', async () => {
    const pending = new Map<string, (value: AttachmentPreview) => void>()
    const readAttachmentPreview = vi.fn((path: string) => new Promise<AttachmentPreview>((resolve) => {
      pending.set(path, resolve)
    }))
    vi.stubGlobal('window', { gale: { files: { readAttachmentPreview } } })
    const { loadAttachmentPreview } = await import('./attachmentPreviewLoader')

    const paths = Array.from({ length: 100 }, (_, index) => `C:\\images\\queued-${index}.png`)
    const requests = paths.map((path) => loadAttachmentPreview(path))
    await expect(loadAttachmentPreview('C:\\images\\overflow.png')).rejects.toThrow('queue is full')

    for (const path of paths) {
      await vi.waitFor(() => expect(pending.has(path)).toBe(true))
      pending.get(path)?.(preview(path))
    }
    await expect(Promise.all(requests)).resolves.toHaveLength(paths.length)
  })
})
