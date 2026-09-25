import { imageDimensionsFromData } from 'image-dimensions'
import { open, stat } from 'node:fs/promises'
import { tool } from '@langchain/core/tools'
import type { MessageContentComplex } from '@langchain/core/messages'
import { z } from 'zod/v3'
import { resolveWorkspacePath } from '../workspacePath'
import { currentToolExecution } from '../agent/toolExecutionContext'
import { toolSummarySchema } from './toolSummary'

const maxImageBytes = 8 * 1024 * 1024
const maxBatchBytes = 16 * 1024 * 1024
const maxImages = 10
const mimeTypes = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const

async function readImage(path: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const source = await stat(path)
  if (!source.isFile()) throw new Error('path is not a regular file')
  if (source.size === 0 || source.size > maxImageBytes) throw new Error('image must be between 1 byte and 8 MiB')
  const file = await open(path, 'r')
  let bytes: Buffer
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size === 0 || info.size > maxImageBytes) throw new Error('image must be a regular file between 1 byte and 8 MiB')
    const buffer = Buffer.alloc(info.size + 1)
    let offset = 0
    while (offset < buffer.length) {
      signal?.throwIfAborted()
      const read = await file.read(buffer, offset, Math.min(64 * 1024, buffer.length - offset), offset)
      if (!read.bytesRead) break
      offset += read.bytesRead
    }
    const after = await file.stat()
    if (offset !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('image changed while being read; retry')
    bytes = buffer.subarray(0, offset)
  } finally { await file.close() }
  signal?.throwIfAborted()
  const dimensions = imageDimensionsFromData(bytes)
  if (!dimensions || !(dimensions.type in mimeTypes)) throw new Error('supported image formats: PNG, JPEG and WebP')
  return { bytes, mimeType: mimeTypes[dimensions.type as keyof typeof mimeTypes] }
}

export function createImageTools(options: { primaryFolder: string; signal?: AbortSignal }) {
  const read = async (paths: string[]): Promise<MessageContentComplex[]> => {
    const signal = currentToolExecution()?.signal ?? options.signal
    const content: MessageContentComplex[] = []
    let total = 0
    for (const requestedPath of paths) {
      signal?.throwIfAborted()
      let path = requestedPath
      try {
        path = resolveWorkspacePath(requestedPath, options.primaryFolder)
        const { bytes, ...info } = await readImage(path, signal)
        if (total + bytes.length > maxBatchBytes) throw new Error('batch image data exceeds 16 MiB; request fewer images')
        total += bytes.length
        content.push({ type: 'text', text: JSON.stringify({ ok: true, path, ...info }) },
          { type: 'image', mimeType: info.mimeType, data: bytes.toString('base64') })
      } catch (error) {
        signal?.throwIfAborted()
        content.push({ type: 'text', text: JSON.stringify({ ok: false, path, error: error instanceof Error ? error.message : String(error) }) })
      }
    }
    return content
  }
  const path = z.string().trim().min(1).describe('Local image path, absolute or relative to the primary/default folder.')
  const usage = 'Use only for local images whose content is not already included in the current context, or when the user explicitly requests rereading the file. Inspect attached images directly without calling this tool. Use paths supplied by the user or obtained from tool results; never guess a local path from an attachment filename.'
  const limits = 'Supports PNG, JPEG and WebP. Requires a vision-capable model. Maximum 8 MiB per image. Returns the original image as image content without resizing or re-encoding.'
  return [
    tool(({ path }) => read([path]), { name: 'view_image', description: `View one local image. ${usage} ${limits}`,
      schema: z.object({ summary: toolSummarySchema, path }).strict() }),
    tool(({ paths }) => read(paths), { name: 'view_multiple_images', description: `View up to 10 local images in input order. ${usage} Each image is preceded by its path; failed files return individual errors without discarding successful images. Maximum 16 MiB total output image data before base64 encoding. ${limits}`,
      schema: z.object({ summary: toolSummarySchema, paths: z.array(path).min(1).max(maxImages) }).strict() })
  ]
}
