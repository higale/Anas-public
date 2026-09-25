import type { AttachmentPreview, AttachmentPreviewOptions } from '@shared/types'

const maxConcurrentPreviewRequests = 4
const maxQueuedPreviewRequests = 96

interface PreviewTask {
  key: string
  path: string
  options: AttachmentPreviewOptions
  resolve: (preview: AttachmentPreview | null) => void
  reject: (reason: unknown) => void
}

interface NormalizedAttachmentPreviewOptions {
  mode: 'thumbnail' | 'original'
  size: number
  projectId?: string
}

const queued: PreviewTask[] = []
const requests = new Map<string, Promise<AttachmentPreview | null>>()
let activeCount = 0

function normalizedOptions(options: AttachmentPreviewOptions): NormalizedAttachmentPreviewOptions {
  const mode = options.mode === 'original' ? 'original' : 'thumbnail'
  const size = mode === 'thumbnail' && Number.isFinite(options.size)
    ? Math.min(Math.max(Math.round(options.size as number), 240), 1600)
    : 240
  const projectId = typeof options.projectId === 'string' && options.projectId.trim()
    ? options.projectId.trim()
    : undefined
  return { mode, size, ...(projectId ? { projectId } : {}) }
}

function requestKey(path: string, options: NormalizedAttachmentPreviewOptions): string {
  return `${options.projectId ?? ''}\0${path}\0${options.mode}\0${options.size}`
}

function pumpQueue(): void {
  while (activeCount < maxConcurrentPreviewRequests && queued.length > 0) {
    const task = queued.shift()
    if (!task) return
    activeCount += 1
    void window.gale.files.readAttachmentPreview(task.path, task.options)
      .then(task.resolve, task.reject)
      .finally(() => {
        activeCount -= 1
        requests.delete(task.key)
        pumpQueue()
      })
  }
}

export function loadAttachmentPreview(
  path: string,
  options: AttachmentPreviewOptions = { mode: 'thumbnail' }
): Promise<AttachmentPreview | null> {
  const normalized = normalizedOptions(options)
  const key = requestKey(path, normalized)
  const existing = requests.get(key)
  if (existing) return existing
  if (queued.length >= maxQueuedPreviewRequests) {
    return Promise.reject(new Error('Image preview queue is full.'))
  }
  const request = new Promise<AttachmentPreview | null>((resolve, reject) => {
    queued.push({ key, path, options: normalized, resolve, reject })
    pumpQueue()
  })
  requests.set(key, request)
  return request
}
