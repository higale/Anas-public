import { app, nativeImage, net, protocol } from 'electron'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, readFile, rm, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { imageDimensionsFromStream } from 'image-dimensions'
import { getAppConfigSnapshot } from './config/appConfig'
import { getTempDir } from './config/dataDir'
import { extractLocalAttachmentText, supportsLocalTextExtraction } from './attachmentTextExtractor'
import { runtimeLog } from './runtimeLogger'
import { findAvatarSourceImage, isAvatarImageExtension, readAvatarImage as readCurrentAvatarImage, readAvatarTransform, resetAvatarAssetsToDefault, setAvatarCrop, setAvatarSourceCrop } from './avatarAssets'
import { applyProfileIcon } from './profileIconService'
import { defaultAvatarTransform, requireAvatarTransform } from '@shared/avatar'
import { armCurrentAgentToolEffect } from './agent/toolEffectScope'
import type { AppAvatarImage, AttachmentPreview, AttachmentPreviewOptions, AttachmentTextOverflowMode, AvatarCropSource, AvatarCropSourceReadResult, AvatarTransform, FileIconImage, FileIconSize, SelectedAttachment, SelectedAttachmentKind } from '@shared/types'

const textAttachmentProbeBytes = 8192
const maxParsedAttachmentBytes = 20 * 1024 * 1024
const imagePreviewSize = 240
const maxImageSourceBytes = 25 * 1024 * 1024
const maxThumbnailBytes = 4 * 1024 * 1024
const maxImagePixels = 25_000_000
const maxImageDimension = 16_384
const imagePreviewTimeoutMs = 5_000
const maxConcurrentImagePreviews = 3
const maxQueuedImagePreviews = 64
const maxAvatarImageBytes = 50 * 1024 * 1024
const maxAvatarCropBytes = 8 * 1024 * 1024
const avatarCropMaxSize = 1024
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const fileIconSizes = new Set<FileIconSize>(['small', 'normal', 'large'])

export const attachmentExtensions = ['txt', 'md', 'markdown', 'json', 'jsonl', 'csv', 'tsv', 'log', 'xml', 'yaml', 'yml', 'toml', 'ini', 'js', 'ts', 'tsx', 'jsx', 'py', 'ps1', 'css', 'html', 'pdf', 'docx', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']
const attachmentExtensionSet = new Set(attachmentExtensions)

interface TextAttachmentLimit {
  maxChars: number
  overflow: AttachmentTextOverflowMode
}

interface ValidatedImage {
  bytes: number
  height: number
  mimeType: string
  width: number
}

interface PreviewQueueItem<T> {
  key: string
  run: () => Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
}

const imageMimeTypes = new Map([
  ['bmp', 'image/bmp'],
  ['gif', 'image/gif'],
  ['jpeg', 'image/jpeg'],
  ['png', 'image/png'],
  ['webp', 'image/webp']
])
const previewQueue: PreviewQueueItem<AttachmentPreview | null>[] = []
const previewRequests = new Map<string, Promise<AttachmentPreview | null>>()
let activePreviewCount = 0
let avatarMutationQueue = Promise.resolve()
const avatarChangeListeners = new Set<(avatar: AppAvatarImage | null) => void>()

class AvatarCropSourceError extends Error {
  constructor(
    readonly code: Exclude<AvatarCropSourceReadResult, { ok: true }>['errorCode'],
    message: string
  ) {
    super(message)
    this.name = 'AvatarCropSourceError'
  }
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(`${label} exceeded ${milliseconds} ms.`)), milliseconds)
    promise.then(resolvePromise, rejectPromise).finally(() => clearTimeout(timer))
  })
}

interface ImageDimensions {
  height: number
  type: 'bmp' | 'gif' | 'jpeg' | 'png' | 'webp'
  width: number
}

function isSupportedStreamImage(header: Uint8Array): boolean {
  const signature = Buffer.from(header)
  return signature.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ||
    signature.subarray(0, 6).toString('ascii') === 'GIF87a' ||
    signature.subarray(0, 6).toString('ascii') === 'GIF89a' ||
    (signature[0] === 0xff && signature[1] === 0xd8 && signature[2] === 0xff) ||
    (signature.subarray(0, 4).toString('ascii') === 'RIFF' && signature.subarray(8, 12).toString('ascii') === 'WEBP')
}

function bmpDimensions(header: Uint8Array): ImageDimensions | undefined {
  const bytes = Buffer.from(header)
  if (bytes.length < 26 || bytes.subarray(0, 2).toString('ascii') !== 'BM') return undefined
  const dibHeaderSize = bytes.readUInt32LE(14)
  if (dibHeaderSize === 12) {
    return { height: bytes.readUInt16LE(20), type: 'bmp', width: bytes.readUInt16LE(18) }
  }
  if (dibHeaderSize < 40) return undefined
  return {
    height: Math.abs(bytes.readInt32LE(22)),
    type: 'bmp',
    width: bytes.readInt32LE(18)
  }
}

async function readImageDimensions(filePath: string): Promise<ImageDimensions | undefined> {
  const handle = await open(filePath, 'r')
  const header = Buffer.alloc(26)
  try {
    const { bytesRead } = await handle.read(header, 0, header.length, 0)
    const boundedHeader = header.subarray(0, bytesRead)
    const bmp = bmpDimensions(boundedHeader)
    if (bmp) return bmp
    if (!isSupportedStreamImage(boundedHeader)) return undefined
  } finally {
    await handle.close()
  }

  const abortController = new AbortController()
  const stream = createReadStream(filePath, { signal: abortController.signal })
  try {
    const dimensions = await withTimeout(
      imageDimensionsFromStream(stream as unknown as ReadableStream<Uint8Array>),
      imagePreviewTimeoutMs,
      'Image metadata read'
    )
    if (!dimensions || !['gif', 'jpeg', 'png', 'webp'].includes(dimensions.type)) return undefined
    return dimensions as ImageDimensions
  } finally {
    abortController.abort()
    stream.destroy()
  }
}

async function validateImage(filePath: string, maxBytes: number | null = maxImageSourceBytes): Promise<ValidatedImage> {
  const info = await stat(filePath)
  if (!info.isFile()) throw new Error('Image preview target is not a file.')
  if (info.size <= 0) throw new Error('Image preview target is empty.')
  if (maxBytes !== null && info.size > maxBytes) {
    throw new Error(`Image preview source exceeds ${Math.round(maxBytes / 1024 / 1024)} MB.`)
  }
  const dimensions = await readImageDimensions(filePath)
  if (!dimensions) throw new Error('Image preview type is not supported.')
  const width = dimensions.width
  const height = dimensions.height
  const mimeType = dimensions.type ? imageMimeTypes.get(dimensions.type) : undefined
  if (!mimeType) throw new Error('Image preview type is not supported.')
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error('Image preview dimensions are invalid.')
  }
  if (width > maxImageDimension || height > maxImageDimension || width * height > maxImagePixels) {
    throw new Error(`Image preview exceeds the ${maxImagePixels.toLocaleString('en-US')} pixel budget.`)
  }
  return { bytes: info.size, height, mimeType, width }
}

function pumpPreviewQueue(): void {
  while (activePreviewCount < maxConcurrentImagePreviews && previewQueue.length > 0) {
    const item = previewQueue.shift()
    if (!item) return
    activePreviewCount += 1
    const work = item.run()
    void withTimeout(work, imagePreviewTimeoutMs, 'Image preview processing').then(item.resolve, item.reject)
    void work.catch(() => undefined).finally(() => {
      activePreviewCount -= 1
      previewRequests.delete(item.key)
      pumpPreviewQueue()
    })
  }
}

function schedulePreview(
  key: string,
  run: () => Promise<AttachmentPreview | null>
): Promise<AttachmentPreview | null> {
  const existing = previewRequests.get(key)
  if (existing) return existing
  if (previewQueue.length >= maxQueuedImagePreviews) {
    return Promise.reject(new Error('Image preview queue is full.'))
  }
  const request = new Promise<AttachmentPreview | null>((resolveRequest, rejectRequest) => {
    previewQueue.push({ key, run, resolve: resolveRequest, reject: rejectRequest })
    pumpPreviewQueue()
  })
  previewRequests.set(key, request)
  return request
}

export function attachmentMimeType(filePath: string): string {
  const ext = extname(filePath).toLowerCase()
  const mimeTypes: Record<string, string> = {
    '.bmp': 'image/bmp',
    '.css': 'text/css',
    '.csv': 'text/csv',
    '.gif': 'image/gif',
    '.htm': 'text/html',
    '.html': 'text/html',
    '.ini': 'text/plain',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.jsonl': 'application/jsonl',
    '.jsx': 'text/javascript',
    '.log': 'text/plain',
    '.md': 'text/markdown',
    '.markdown': 'text/markdown',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.ps1': 'text/plain',
    '.py': 'text/x-python',
    '.svg': 'image/svg+xml',
    '.toml': 'application/toml',
    '.ts': 'text/typescript',
    '.tsx': 'text/typescript',
    '.tsv': 'text/tab-separated-values',
    '.txt': 'text/plain',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.webp': 'image/webp',
    '.xml': 'application/xml',
    '.yaml': 'application/yaml',
    '.yml': 'application/yaml'
  }
  return mimeTypes[ext] ?? 'application/octet-stream'
}

function attachmentKind(mimeType: string): SelectedAttachmentKind {
  if (mimeType.startsWith('image/')) return 'image'
  if (supportsLocalTextExtraction(mimeType)) return 'text'
  if (mimeType.startsWith('text/') || ['application/json', 'application/jsonl', 'application/toml', 'application/xml', 'application/yaml'].includes(mimeType)) return 'text'
  return 'binary'
}

function hasKnownAttachmentExtension(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase().replace(/^\./, '')
  return attachmentExtensionSet.has(ext)
}

function bufferLooksLikeText(buffer: Buffer): boolean {
  if (buffer.length === 0) return true
  if (
    buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) ||
    buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfe])) ||
    buffer.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))
  ) return true
  if (buffer.includes(0)) return false
  const sample = buffer.subarray(0, textAttachmentProbeBytes)
  if (sample.some((byte) => byte > 127)) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(sample)
    } catch {
      return false
    }
  }
  let suspicious = 0
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13 || byte === 27) continue
    if (byte >= 32) continue
    suspicious += 1
  }
  return suspicious / sample.length <= 0.02
}

async function fileLooksLikeText(filePath: string): Promise<boolean> {
  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(textAttachmentProbeBytes)
    const result = await handle.read(buffer, 0, textAttachmentProbeBytes, 0)
    return bufferLooksLikeText(buffer.subarray(0, result.bytesRead))
  } finally {
    await handle.close()
  }
}

async function detectAttachmentMimeType(filePath: string, detectedMimeType?: string): Promise<string> {
  const mimeType = detectedMimeType ?? attachmentMimeType(filePath)
  if (mimeType !== 'application/octet-stream') return mimeType
  return await fileLooksLikeText(filePath) ? 'text/plain' : mimeType
}

async function getTextAttachmentLimit(): Promise<TextAttachmentLimit> {
  const { settings } = await getAppConfigSnapshot()
  return {
    maxChars: settings.attachmentTextMaxChars,
    overflow: settings.attachmentTextOverflow
  }
}

function formatCharacterCount(value: number): string {
  return value.toLocaleString('en-US')
}

function limitAttachmentText(text: string, limit: TextAttachmentLimit): Pick<SelectedAttachment, 'text' | 'truncated' | 'skippedReason'> {
  if (text.length <= limit.maxChars) return { text, truncated: false }
  if (limit.overflow === 'error') {
    return {
      skippedReason: `Extracted text is longer than ${formatCharacterCount(limit.maxChars)} characters.`
    }
  }
  return {
    text: text.slice(0, limit.maxChars),
    truncated: true
  }
}

async function readSelectedAttachment(filePath: string, detectedMimeType: string | undefined, textLimit: TextAttachmentLimit): Promise<SelectedAttachment> {
  const info = await stat(filePath)
  if (!info.isFile()) {
    return {
      path: filePath,
      name: basename(filePath),
      size: info.size,
      kind: 'binary',
      mimeType: 'application/octet-stream',
      contextPolicy: 'one_turn',
      skippedReason: 'Only files can be attached.'
    }
  }
  const mimeType = await detectAttachmentMimeType(filePath, detectedMimeType)
  const kind = attachmentKind(mimeType)
  if (kind === 'image') {
    let validated: ValidatedImage
    try {
      validated = await validateImage(filePath)
    } catch (reason) {
      return {
        path: filePath,
        name: basename(filePath),
        size: info.size,
        kind,
        mimeType,
        contextPolicy: 'one_turn',
        skippedReason: reason instanceof Error ? reason.message : 'Image validation failed.'
      }
    }
    const buffer = await readFile(filePath)
    if (buffer.length > maxImageSourceBytes) {
      return {
        path: filePath,
        name: basename(filePath),
        size: buffer.length,
        kind,
        mimeType: validated.mimeType,
        contextPolicy: 'one_turn',
        skippedReason: 'Image changed while the bounded attachment was being read.'
      }
    }
    return {
      path: filePath,
      name: basename(filePath),
      size: buffer.length,
      kind,
      mimeType: validated.mimeType,
      contextPolicy: 'one_turn',
      dataUri: `data:${validated.mimeType};base64,${buffer.toString('base64')}`
    }
  }
  if (kind !== 'text') {
    runtimeLog('debug', 'attachment', 'Attachment selected for upload-only use.', {
      file: filePath,
      mimeType
    })
    return {
      path: filePath,
      name: basename(filePath),
      size: info.size,
      kind,
      mimeType,
      contextPolicy: 'one_turn'
    }
  }

  if (supportsLocalTextExtraction(mimeType)) {
    if (info.size > maxParsedAttachmentBytes) {
      return {
        path: filePath,
        name: basename(filePath),
        size: info.size,
        kind,
        mimeType,
        contextPolicy: 'one_turn',
        skippedReason: `File is larger than ${Math.round(maxParsedAttachmentBytes / 1024 / 1024)} MB.`
      }
    }
    try {
      const extracted = await extractLocalAttachmentText(filePath, mimeType)
      const limitedText = limitAttachmentText(extracted.text, textLimit)
      return {
        path: filePath,
        name: basename(filePath),
        size: info.size,
        kind,
        mimeType,
        contextPolicy: 'one_turn',
        ...limitedText
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : 'Failed to extract text.'
      runtimeLog('warn', 'attachment', 'Attachment text extraction failed.', {
        file: filePath,
        mimeType,
        error: message
      })
      return {
        path: filePath,
        name: basename(filePath),
        size: info.size,
        kind,
        mimeType,
        contextPolicy: 'one_turn',
        skippedReason: message
      }
    }
  }

  const buffer = await readFile(filePath)
  const limitedText = limitAttachmentText(buffer.toString('utf8'), textLimit)
  return {
    path: filePath,
    name: basename(filePath),
    size: info.size,
    kind,
    mimeType,
    contextPolicy: 'one_turn',
    ...limitedText
  }
}

export async function readSelectedAttachments(filePaths: string[]): Promise<SelectedAttachment[]> {
  const uniquePaths = Array.from(new Set(filePaths.map((filePath) => filePath.trim()).filter(Boolean)))
  const textLimit = await getTextAttachmentLimit()
  return Promise.all(uniquePaths.map((filePath) => readSelectedAttachment(filePath, undefined, textLimit)))
}

export async function readDroppedAttachments(filePaths: string[]): Promise<SelectedAttachment[]> {
  const uniquePaths = Array.from(new Set(filePaths.map((filePath) => filePath.trim()).filter(Boolean)))
  const supportedFiles: Array<{ filePath: string; detectedMimeType?: string }> = []
  for (const filePath of uniquePaths) {
    try {
      const info = await stat(filePath)
      if (!info.isFile()) {
        runtimeLog('debug', 'attachment', 'Dropped attachment rejected.', {
          file: filePath,
          isFile: false,
          extension: extname(filePath).toLowerCase()
        })
        continue
      }
      if (hasKnownAttachmentExtension(filePath)) {
        supportedFiles.push({ filePath })
        continue
      }
      if (await fileLooksLikeText(filePath)) {
        supportedFiles.push({ filePath, detectedMimeType: 'text/plain' })
        continue
      }
      runtimeLog('debug', 'attachment', 'Dropped attachment rejected.', {
        file: filePath,
        isFile: true,
        extension: extname(filePath).toLowerCase()
      })
    } catch (reason) {
      runtimeLog('warn', 'attachment', 'Dropped attachment rejected because file metadata could not be read.', {
        file: filePath,
        error: reason instanceof Error ? reason.message : String(reason)
      })
    }
  }
  const textLimit = await getTextAttachmentLimit()
  return Promise.all(supportedFiles.map((file) => readSelectedAttachment(file.filePath, file.detectedMimeType, textLimit)))
}

export async function releaseTemporaryAttachments(filePaths: string[]): Promise<void> {
  const temporaryRoots = [
    resolve(getTempDir(), 'agent-message-edit')
  ]
  const directories = new Set<string>()
  for (const filePath of filePaths) {
    const resolved = resolve(filePath)
    for (const temporaryRoot of temporaryRoots) {
      const rel = relative(temporaryRoot, resolved)
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) continue
      const [draftId] = rel.split(sep)
      if (draftId) directories.add(resolve(temporaryRoot, draftId))
      break
    }
  }
  await Promise.all([...directories].map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
}

const attachmentPreviewScheme = 'anas-image'

export function registerAttachmentPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: attachmentPreviewScheme,
    privileges: { standard: true, secure: true, stream: true } }])
}

export function registerAttachmentPreviewProtocol(): void {
  protocol.handle(attachmentPreviewScheme, async (request) => {
    const url = new URL(request.url)
    const path = url.searchParams.get('path')
    if (url.hostname !== 'local' || !path || !isAbsolute(path) || request.method !== 'GET') {
      return new Response(null, { status: 400 })
    }
    try {
      const image = await validateImage(path, null)
      // Chromium streams the file directly instead of copying an unbounded base64 string through IPC.
      const response = await net.fetch(pathToFileURL(path).href, { signal: request.signal })
      const headers = new Headers(response.headers)
      headers.set('Content-Type', image.mimeType)
      headers.set('Cache-Control', 'no-store')
      return new Response(response.body, { status: response.status, headers })
    } catch {
      return new Response(null, { status: 404 })
    }
  })
}

async function createAttachmentPreview(filePath: string, options: AttachmentPreviewOptions): Promise<AttachmentPreview | null> {
  const extensionMimeType = attachmentMimeType(filePath)
  if (!extensionMimeType.startsWith('image/') || extensionMimeType === 'image/svg+xml') return null
  const image = await validateImage(filePath, null)
  if (options.mode === 'original') return {
    path: filePath,
    mimeType: image.mimeType,
    src: `${attachmentPreviewScheme}://local/?path=${encodeURIComponent(filePath)}`
  }
  const size = options.size ?? imagePreviewSize
  const previewSize = Math.min(Math.max(Math.round(size), imagePreviewSize), 1600)
  const thumbnail = await nativeImage.createThumbnailFromPath(filePath, {
    width: previewSize,
    height: previewSize
  })
  if (thumbnail.isEmpty()) throw new Error('Image thumbnail could not be decoded.')
  const dimensions = thumbnail.getSize()
  if (dimensions.width <= 0 || dimensions.height <= 0 || dimensions.width * dimensions.height > previewSize * previewSize) {
    throw new Error('Image thumbnail dimensions exceed the requested preview budget.')
  }
  const png = thumbnail.toPNG()
  if (png.length > maxThumbnailBytes) {
    throw new Error(`Image thumbnail exceeds ${Math.round(maxThumbnailBytes / 1024 / 1024)} MB.`)
  }
  return {
    path: filePath,
    mimeType: 'image/png',
    src: `data:image/png;base64,${png.toString('base64')}`
  }
}

export function readAttachmentPreview(filePath: string, options: AttachmentPreviewOptions = {}): Promise<AttachmentPreview | null> {
  const normalizedPath = resolve(filePath)
  const mode = options.mode === 'original' ? 'original' : 'thumbnail'
  const size = mode === 'thumbnail' && Number.isFinite(options.size)
    ? Math.min(Math.max(Math.round(options.size as number), imagePreviewSize), 1600)
    : imagePreviewSize
  const normalizedOptions: AttachmentPreviewOptions = { mode, size }
  return schedulePreview(`${normalizedPath}\0${mode}\0${size}`, () => createAttachmentPreview(normalizedPath, normalizedOptions))
}

export async function readFileIcon(filePath: string, size: FileIconSize = 'normal'): Promise<FileIconImage | null> {
  const info = await stat(filePath)
  if (!info.isFile()) return null
  const icon = await app.getFileIcon(filePath, {
    size: fileIconSizes.has(size) ? size : 'normal'
  })
  if (icon.isEmpty()) return null
  return {
    path: filePath,
    dataUri: icon.toDataURL()
  }
}

export async function readAvatarImage(): Promise<AppAvatarImage | null> {
  return readCurrentAvatarImage()
}

async function validatedAvatarSource(sourcePath: unknown): Promise<{ image: ValidatedImage; path: string }> {
  if (typeof sourcePath !== 'string' || sourcePath.trim().length === 0) {
    throw new AvatarCropSourceError('load_failed', 'Avatar source path is required.')
  }
  const normalizedPath = resolve(sourcePath)
  const ext = extname(normalizedPath).toLowerCase()
  if (!isAvatarImageExtension(ext)) {
    throw new AvatarCropSourceError('unsupported_type', 'Avatar must be a PNG, JPG, WebP, GIF, or BMP image.')
  }
  return {
    image: await validateImage(normalizedPath, maxAvatarImageBytes),
    path: normalizedPath
  }
}

async function avatarCropSourceFromPath(
  sourcePath: unknown,
  transform?: AvatarCropSource['transform']
): Promise<AvatarCropSource> {
  const { image, path } = await validatedAvatarSource(sourcePath)
  const buffer = await readFile(path)
  if (buffer.length !== image.bytes || buffer.length > maxAvatarImageBytes) {
    throw new Error('Avatar image changed while it was being read.')
  }
  return {
    dataUri: `data:${image.mimeType};base64,${buffer.toString('base64')}`,
    height: image.height,
    mimeType: image.mimeType,
    path,
    transform,
    width: image.width
  }
}

export function readAvatarCropSource(sourcePath: string): Promise<AvatarCropSource> {
  return avatarCropSourceFromPath(sourcePath)
}

export async function readAvatarCropSourceResult(sourcePath: unknown): Promise<AvatarCropSourceReadResult> {
  try {
    return { ok: true, source: await avatarCropSourceFromPath(sourcePath) }
  } catch (reason) {
    if (reason instanceof AvatarCropSourceError) {
      return { ok: false, errorCode: reason.code }
    }
    runtimeLog('warn', 'avatar', 'Failed to read an avatar crop source.', { error: reason })
    return { ok: false, errorCode: 'load_failed' }
  }
}

export async function readCurrentAvatarCropSource(): Promise<AvatarCropSource | null> {
  const sourcePath = await findAvatarSourceImage()
  if (!sourcePath) return null
  return avatarCropSourceFromPath(sourcePath, await readAvatarTransform())
}

function validatedAvatarCropPng(value: unknown): Buffer {
  if (!(value instanceof Uint8Array)) throw new Error('Avatar crop must be PNG bytes.')
  if (value.byteLength <= 0 || value.byteLength > maxAvatarCropBytes) {
    throw new Error(`Avatar crop must be ${Math.round(maxAvatarCropBytes / 1024 / 1024)} MB or smaller.`)
  }

  const png = Buffer.from(value)
  if (png.length < 24 || !png.subarray(0, pngSignature.length).equals(pngSignature)) {
    throw new Error('Avatar crop must be a PNG image.')
  }
  if (png.readUInt32BE(8) !== 13 || png.subarray(12, 16).toString('ascii') !== 'IHDR') {
    throw new Error('Avatar crop has an invalid PNG header.')
  }
  const declaredWidth = png.readUInt32BE(16)
  const declaredHeight = png.readUInt32BE(20)
  if (declaredWidth <= 0 || declaredWidth !== declaredHeight || declaredWidth > avatarCropMaxSize) {
    throw new Error(`Avatar crop must be square and no larger than ${avatarCropMaxSize} by ${avatarCropMaxSize} pixels.`)
  }

  const image = nativeImage.createFromBuffer(png)
  if (image.isEmpty()) throw new Error('Avatar crop could not be decoded.')
  const size = image.getSize()
  if (size.width !== declaredWidth || size.height !== declaredHeight) {
    throw new Error('Decoded avatar crop dimensions do not match its PNG header.')
  }
  const normalized = image.toPNG()
  if (normalized.length <= 0 || normalized.length > maxAvatarCropBytes) {
    throw new Error('Normalized avatar crop exceeds the allowed size.')
  }
  return normalized
}

function runAvatarMutation<T>(action: () => Promise<T>): Promise<T> {
  const result = avatarMutationQueue.then(action, action)
  avatarMutationQueue = result.then(() => undefined, () => undefined)
  return result
}

export function onAvatarChanged(listener: (avatar: AppAvatarImage | null) => void): () => void {
  avatarChangeListeners.add(listener)
  return () => avatarChangeListeners.delete(listener)
}

function emitAvatarChanged(avatar: AppAvatarImage | null): void {
  for (const listener of avatarChangeListeners) {
    try {
      listener(avatar)
    } catch (reason) {
      try {
        runtimeLog('warn', 'avatar', 'An avatar change listener failed after the avatar was saved.', { error: reason })
      } catch {
        // Avatar assets have already committed; observer failures must not change the result.
      }
    }
  }
}

function replaceAvatarImage(action: () => Promise<unknown>): Promise<AppAvatarImage | null> {
  return runAvatarMutation(async () => {
    await action()
    const avatar = await readAvatarImage()
    await applyProfileIcon()
    emitAvatarChanged(avatar)
    return avatar
  })
}

function centeredAvatarCrop(source: Electron.NativeImage): { png: Buffer; transform: AvatarTransform } {
  if (source.isEmpty()) throw new Error('Avatar image could not be decoded.')
  const { width, height } = source.getSize()
  if (width <= 0 || height <= 0) throw new Error('Avatar image dimensions are invalid.')
  const side = Math.min(width, height)
  const x = Math.floor((width - side) / 2)
  const y = Math.floor((height - side) / 2)
  const square = width === height ? source : source.crop({ x, y, width: side, height: side })
  const bounded = side > avatarCropMaxSize
    ? square.resize({ width: avatarCropMaxSize, height: avatarCropMaxSize, quality: 'best' })
    : square
  const transform = width === height
    ? defaultAvatarTransform
    : requireAvatarTransform({
        crop: {
          height: side / height * 100,
          width: side / width * 100,
          x: x / width * 100,
          y: y / height * 100
        },
        rotation: 0
      })
  return { png: validatedAvatarCropPng(bounded.toPNG()), transform }
}

export async function setAvatarImageFromSource(sourcePath: unknown): Promise<AppAvatarImage | null> {
  const { image, path } = await validatedAvatarSource(sourcePath)
  const sourceBytes = await readFile(path)
  if (sourceBytes.length !== image.bytes || sourceBytes.length > maxAvatarImageBytes) {
    throw new Error('Avatar image changed while it was being read.')
  }
  const crop = centeredAvatarCrop(nativeImage.createFromBuffer(sourceBytes))
  const sourceFingerprint = createHash('sha256').update(sourceBytes).digest('hex')
  armCurrentAgentToolEffect({
    kind: 'avatar_update',
    target: { path, sourceFingerprint },
    recoveryMode: 'idempotent',
    idempotencyFingerprint: sourceFingerprint
  })
  return replaceAvatarImage(() => setAvatarSourceCrop(
    path,
    sourceBytes,
    crop.png,
    crop.transform
  ))
}

export async function saveAvatarCrop(request: unknown): Promise<AppAvatarImage | null> {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Avatar crop request must be an object.')
  }
  const value = request as Record<string, unknown>
  const { path } = await validatedAvatarSource(value.sourcePath)
  const png = validatedAvatarCropPng(value.pngBytes)
  const transform = requireAvatarTransform(value.transform)
  return replaceAvatarImage(() => setAvatarCrop(path, png, transform))
}

export async function clearAvatarImage(): Promise<AppAvatarImage | null> {
  return replaceAvatarImage(() => resetAvatarAssetsToDefault())
}
