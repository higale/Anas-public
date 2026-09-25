import type { Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { extname } from 'node:path'
import { Worker } from 'node:worker_threads'

const dependency = createRequire(import.meta.url)
// .ts is also TypeScript: transport streams are recognized from bytes instead.
const mediaExtensions = new Set('jpg jpeg png gif webp bmp tif tiff heic heif avif ico mp3 wav flac aac m4a ogg opus aiff aif wma mp4 m4v mov mkv webm avi wmv flv mpg mpeg mts m2ts 3gp'.split(' '))
const pending = new Set<() => void>()
let active = 0

export interface FileContentInfo {
  lineCount?: number
  media?: {
    kind: 'image' | 'audio' | 'video'
    format?: string
    width?: number
    height?: number
    storedWidth?: number
    storedHeight?: number
    orientation?: number
    rotationDegrees?: number
    hasAlpha?: boolean
    durationSeconds?: number
    tracks?: Record<string, unknown>[]
    trackCount?: number
    tracksTruncated?: boolean
    warnings?: string[]
  }
  metadataError?: string
}

// Serialized into a fresh worker: all runtime dependencies must be resolved inside
// this function. Only file descriptors and local dependency paths cross the boundary.
/* eslint-disable @typescript-eslint/no-require-imports -- The serialized worker has no surrounding module imports. */
async function inspectInWorker(): Promise<void> {
  const { parentPort, workerData } = require('node:worker_threads') as typeof import('node:worker_threads')
  const { readSync } = require('node:fs') as typeof import('node:fs')
  const { fd, size, maxReadBytes, mediaHint, paths } = workerData
  class ReadLimitError extends Error {}
  let readBytes = 0
  const read = (length: number, offset: number): Buffer => {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > size || !Number.isSafeInteger(length) || length < 0) {
      throw new Error('Invalid media read range.')
    }
    length = Math.min(length, size - offset)
    if (length > maxReadBytes - readBytes) throw new ReadLimitError(`Metadata read limit exceeded (${maxReadBytes} bytes).`)
    const data = Buffer.alloc(length)
    let done = 0
    while (done < length) {
      const count = readSync(fd, data, done, length - done, offset + done)
      if (!count) throw new Error('File changed while reading metadata; retry.')
      done += count
    }
    readBytes += done
    return data
  }
  const number = (value: unknown): number | undefined => {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return undefined
    const result = Number(value)
    return Number.isFinite(result) && result >= 0 ? result : undefined
  }
  const text = (value: unknown): string | undefined => typeof value === 'string' && value ? value.slice(0, 160) : undefined
  try {
    const head = read(Math.min(size, 64 * 1024), 0)
    if (!mediaHint && !head.includes(0)) {
      let isText = true
      try { new TextDecoder('utf-8', { fatal: true }).decode(head, { stream: head.length < size }) } catch { isText = false }
      if (isText) {
        if (size > 1_000_000) { parentPort!.postMessage({}); return }
        const bytes = head.length === size ? head : Buffer.concat([head, read(size - head.length, head.length)])
        try {
          const content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
          if (!content.includes('\0')) {
            const count = content ? content.split(/\r\n|\r|\n/).length - Number(/[\r\n]$/.test(content)) : 0
            parentPort!.postMessage({ lineCount: count }); return
          }
        } catch { /* Binary data after a text-like header still needs probing. */ }
      }
    }
    if (!size) throw new Error('Empty file has no media metadata.')
    const { imageDimensionsFromData } = require(paths.dimensions) as typeof import('image-dimensions')
    let dimensions = imageDimensionsFromData(head)
    const factory = (require(paths.mediaInfo) as typeof import('mediainfo.js')).default
    const parser = await factory({ format: 'JSON', coverData: false, full: false, chunkSize: 64 * 1024, locateFile: () => paths.wasm })
    type RawTrack = Record<string, unknown> & { '@type': string }
    let result: { media?: { track?: RawTrack[] } }
    const warnings: string[] = []
    try {
      try {
        result = JSON.parse(await parser.analyzeData(size, (length, offset) => offset + length <= head.length ? head.subarray(offset, offset + length) : read(length, offset)))
      } catch (error) {
        if (!(error instanceof ReadLimitError)) throw error
        // Some formats (notably PCM WAV) keep scanning after their headers are
        // known. Finalize the inspected portion and label the partial result.
        parser.openBufferFinalize()
        result = JSON.parse(parser.inform())
        warnings.push(`${error.message} Metadata may be incomplete.`)
      }
    }
    finally { parser.close() }
    const all = result.media?.track ?? []
    const general = all.find(track => track['@type'] === 'General')
    const image = all.find(track => track['@type'] === 'Image')
    const video = all.find(track => track['@type'] === 'Video')
    const audio = all.find(track => track['@type'] === 'Audio')
    const format = text(general?.Format)
    if (dimensions || image) {
      const containerOrientation = ['heic', 'avif'].includes(dimensions?.type ?? '') || /^(HEIC|HEIF|AVIF)$/i.test(format ?? '')
      const extra = image?.extra
      const imageProperty = (name: string): unknown => image?.[name] ?? (extra && typeof extra === 'object' ? (extra as Record<string, unknown>)[name] : undefined)
      const rawRotation = imageProperty('Rotation')
      const rotation = typeof rawRotation === 'number' || (typeof rawRotation === 'string' && rawRotation.trim()) ? Number(rawRotation) : NaN
      const rotationDegrees = containerOrientation && Number.isFinite(rotation) ? rotation : undefined
      let orientation: number | undefined
      // EXIF is independent of codec metadata. Parse only orientation from a
      // bounded prefix; do not decode pixels or return unrelated tags.
      if (['jpeg', 'png', 'heic', 'avif'].includes(dimensions?.type ?? '') || /^(JPEG|PNG|TIFF|HEIF|AVIF)$/i.test(format ?? '')) {
        try {
          const prefixSize = Math.min(size, 1024 * 1024)
          const prefix = prefixSize <= head.length ? head : Buffer.concat([head, read(prefixSize - head.length, head.length)])
          dimensions ??= imageDimensionsFromData(prefix)
          const exifr = require(paths.exifr) as typeof import('exifr')
          const value = await exifr.orientation(prefix)
          if (value !== undefined && Number.isInteger(value) && value >= 1 && value <= 8) orientation = value
          else if (prefixSize < size && !containerOrientation) warnings.push('EXIF orientation was not found within the 1 MiB header limit; dimensions may be unrotated.')
        } catch { warnings.push(containerOrientation ? 'EXIF orientation could not be read.' : 'EXIF orientation could not be read; dimensions may be unrotated.') }
      }
      const width = dimensions?.width ?? number(image?.Width)
      const height = dimensions?.height ?? number(image?.Height)
      if (!width || !height) throw new Error('Image dimensions are unavailable.')
      let displayWidth = width, displayHeight = height
      const rawCleanWidth = imageProperty('Width_CleanAperture'), rawCleanHeight = imageProperty('Height_CleanAperture')
      const hasCleanAperture = containerOrientation && (rawCleanWidth !== undefined || rawCleanHeight !== undefined)
      if (hasCleanAperture) {
        const cleanWidth = number(rawCleanWidth), cleanHeight = number(rawCleanHeight)
        if (cleanWidth && cleanHeight && Number.isInteger(cleanWidth) && Number.isInteger(cleanHeight) && cleanWidth <= width && cleanHeight <= height) {
          displayWidth = cleanWidth
          displayHeight = cleanHeight
        } else warnings.push('Container clean-aperture dimensions are incomplete or invalid; reported dimensions may include cropped pixels.')
      }
      // HEIF/AVIF display transforms come from the container, not EXIF. Applying
      // both would rotate twice; crop before rotation and retain the coded size.
      const swap = containerOrientation
        ? rotationDegrees !== undefined && Math.abs(Math.abs(rotationDegrees) % 180 - 90) < 0.01
        : orientation !== undefined && orientation >= 5
      const colorSpace = image?.ColorSpace
      const hasAlpha = typeof colorSpace === 'string' && /A$/.test(colorSpace) ? true : format === 'JPEG' ? false : undefined
      parentPort!.postMessage({ media: {
        kind: 'image', format: format ?? dimensions?.type, width: swap ? displayHeight : displayWidth, height: swap ? displayWidth : displayHeight,
        ...(orientation !== undefined ? { orientation } : {}),
        ...(rotationDegrees !== undefined ? { rotationDegrees } : {}),
        ...(swap || hasCleanAperture ? { storedWidth: width, storedHeight: height } : {}),
        ...(hasAlpha !== undefined ? { hasAlpha } : {}), ...(warnings.length ? { warnings } : {})
      } }); return
    }
    if (!video && !audio) throw new Error(warnings[0] ?? 'Unsupported or unrecognized media format.')
    const tracks = all.filter(track => ['Video', 'Audio', 'Text'].includes(track['@type']))
    parentPort!.postMessage({ media: {
      kind: video ? 'video' : 'audio', format,
      durationSeconds: number(general?.Duration) ?? number(video?.Duration) ?? number(audio?.Duration),
      ...(warnings.length ? { warnings } : {}),
      trackCount: tracks.length, ...(tracks.length > 16 ? { tracksTruncated: true } : {}),
      tracks: tracks.slice(0, 16).map(track => {
        const data = track
        const rawRotation = typeof data.Rotation === 'string' || typeof data.Rotation === 'number' ? Number(data.Rotation) : NaN
        const rotation = Number.isFinite(rawRotation) ? rawRotation : undefined
        const width = number(data.Width), height = number(data.Height)
        const swap = rotation !== undefined && Math.abs(Math.abs(rotation) % 180 - 90) < 0.01
        return {
          type: track['@type'].toLowerCase(), codec: text(data.Format), codecId: text(data.CodecID),
          language: text(data.Language), durationSeconds: number(data.Duration), bitRate: number(data.BitRate),
          width: swap ? height : width, height: swap ? width : height,
          ...(swap ? { storedWidth: width, storedHeight: height } : {}),
          rotationDegrees: rotation, frameRate: number(data.FrameRate), sampleRate: number(data.SamplingRate), channels: number(data.Channels)
        }
      })
    } })
  } catch (error) {
    parentPort!.postMessage({ metadataError: error instanceof Error ? error.message : 'Media metadata could not be read.' })
  }
}
/* eslint-enable @typescript-eslint/no-require-imports */

async function acquire(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  if (active < 2) { active++; return }
  if (pending.size >= 16) throw new Error('Media metadata queue is full; retry.')
  await new Promise<void>((resolve, reject) => {
    const abort = () => { pending.delete(ready); reject(signal.reason) }
    const ready = () => { signal.removeEventListener('abort', abort); active++; resolve() }
    pending.add(ready)
    signal.addEventListener('abort', abort, { once: true })
  })
}

/** The caller owns the regular-file handle and must keep it open until this settles. */
export async function readFileContentInfo(file: FileHandle, info: Stats, path: string, options: {
  signal?: AbortSignal
  timeoutMs?: number
  maxReadBytes?: number
} = {}): Promise<FileContentInfo> {
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  const timer = setTimeout(() => controller.abort(new Error('Media metadata detection timed out.')), options.timeoutMs ?? 5000)
  let acquired = false
  let worker: Worker | undefined
  try {
    await acquire(signal)
    acquired = true
    signal.throwIfAborted()
    worker = new Worker(`(${inspectInWorker.toString()})()`, {
      eval: true,
      workerData: {
        fd: file.fd, size: info.size, maxReadBytes: options.maxReadBytes ?? 16 * 1024 * 1024,
        mediaHint: mediaExtensions.has(extname(path).slice(1).toLowerCase()),
        paths: {
          mediaInfo: dependency.resolve('mediainfo.js'), wasm: dependency.resolve('mediainfo.js/MediaInfoModule.wasm'),
          dimensions: dependency.resolve('image-dimensions'), exifr: dependency.resolve('exifr')
        }
      }
    })
    const result = await new Promise<FileContentInfo>((resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      worker!.once('message', resolve)
      worker!.once('error', reject)
      worker!.once('exit', code => { signal.removeEventListener('abort', abort); reject(new Error(`Metadata worker exited without a result (${code}).`)) })
    })
    const after = await file.stat()
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) {
      throw new Error('File changed while reading metadata; retry.')
    }
    signal.throwIfAborted()
    return result
  } catch (error) {
    options.signal?.throwIfAborted()
    return { metadataError: error instanceof Error ? error.message : 'Media metadata could not be read.' }
  } finally {
    clearTimeout(timer)
    // Stop WASM parsing before the caller closes/reuses the shared descriptor.
    await worker?.terminate()
    if (acquired) {
      active--
      const next = pending.values().next().value
      if (next) { pending.delete(next); next() }
    }
  }
}
