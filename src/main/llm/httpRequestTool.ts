import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, openAsBlob } from 'node:fs'
import { access, mkdir, open, rename, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import { z } from 'zod/v3'
import { armCurrentAgentToolEffect, currentAgentToolEffectArtifactId } from '../agent/toolEffectScope'
import { registerExternalTemporaryFile, releaseExternalTemporaryFile } from '../tempCleanupService'
import { resolveWorkspacePath } from '../workspacePath'
import { toolSummarySchema } from './toolSummary'
import { currentToolExecution } from '../agent/toolExecutionContext'

const envPlaceholderPattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g
const methodsWithoutBody = new Set(['GET', 'HEAD'])
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS'])
const textResponseDefaultBytes = 200_000
const textResponseMaximumBytes = 1_000_000
const downloadDefaultBytes = 1_000_000_000
const downloadMaximumBytes = 100_000_000_000
const uploadMaximumBytes = 1_000_000_000
const maximumTimeoutSeconds = Math.floor(2_147_483_647 / 1000)

interface HttpRequestToolOptions {
  primaryFolder: string
  signal?: AbortSignal
  onDispatched?(): void
  onOutcomeUncertain?(reason: string): void
  onProgress?(current: number, total?: number): void
  onResult?(outcome: Record<string, unknown>): void
}

interface MultipartFileInput {
  field: string
  path: string
  filename?: string
  content_type?: string
}

interface TextResponse {
  body: string
  bytesRead: number
  truncated: boolean
}

interface PreparedRequestBody {
  body?: BodyInit
  fingerprint?: string
}

function result(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(maximum, Math.max(minimum, Math.floor(value)))
    : fallback
}

function requestMethod(input: Record<string, unknown>): string {
  const hasBody = typeof input.body === 'string'
    || (typeof input.body_file === 'string' && input.body_file.trim().length > 0)
    || input.form_fields !== undefined
    || input.form_files !== undefined
  const fallback = hasBody ? 'POST' : 'GET'
  return (typeof input.method === 'string' ? input.method : fallback).trim().toUpperCase() || fallback
}

function resolveEnvironment(value: string, label: string): string {
  let missing: string | undefined
  const resolved = value.replace(envPlaceholderPattern, (_match, name: string) => {
    const environmentValue = process.env[name]
    if (environmentValue === undefined) {
      missing = name
      return ''
    }
    return environmentValue
  })
  if (missing) throw new Error(`${label} references unset environment variable ${missing}`)
  return resolved
}

function requestHeaders(value: unknown): Headers {
  const headers = new Headers()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return headers
  for (const [name, item] of Object.entries(value)) {
    if (!name.trim()) continue
    if (typeof item === 'string') headers.set(name, resolveEnvironment(item, `header ${name}`))
    else if (typeof item === 'number' || typeof item === 'boolean') headers.set(name, String(item))
  }
  return headers
}

async function fileSize(path: string): Promise<number> {
  const info = await stat(path)
  if (!info.isFile()) throw new Error(`not a file: ${path}`)
  return info.size
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function fileSha256(path: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk)
  return hash.digest('hex')
}

async function requestBody(
  input: Record<string, unknown>,
  primaryFolder: string,
  headers: Headers,
  signal: AbortSignal
): Promise<PreparedRequestBody> {
  const textBody = typeof input.body === 'string' ? input.body : undefined
  const bodyFile = typeof input.body_file === 'string' && input.body_file.trim()
    ? resolveWorkspacePath(input.body_file, primaryFolder)
    : undefined
  const fields = input.form_fields && typeof input.form_fields === 'object' && !Array.isArray(input.form_fields)
    ? input.form_fields as Record<string, string>
    : undefined
  const files = Array.isArray(input.form_files)
    ? input.form_files as MultipartFileInput[]
    : undefined
  const usesMultipart = input.form_fields !== undefined || input.form_files !== undefined
  const bodyModes = [textBody !== undefined, bodyFile !== undefined, usesMultipart].filter(Boolean).length
  if (bodyModes > 1) throw new Error('use only one of body, body_file, or multipart form data')

  if (bodyFile) {
    const size = await fileSize(bodyFile)
    if (size > uploadMaximumBytes) throw new Error(`upload exceeds ${uploadMaximumBytes} bytes`)
    const contentType = headers.get('content-type') || 'application/octet-stream'
    return {
      body: await openAsBlob(bodyFile, { type: contentType }),
      fingerprint: sha256(JSON.stringify({
        type: 'file',
        path: bodyFile,
        size,
        contentType,
        sha256: await fileSha256(bodyFile, signal)
      }))
    }
  }

  if (!usesMultipart) {
    return textBody === undefined
      ? {}
      : { body: textBody, fingerprint: sha256(JSON.stringify({ type: 'text', value: textBody })) }
  }
  if (headers.has('content-type')) {
    throw new Error('omit Content-Type for multipart requests so the boundary can be generated automatically')
  }

  const form = new FormData()
  const sortedFields = Object.entries(fields ?? {}).sort(([left], [right]) => (
    left < right ? -1 : left > right ? 1 : 0
  ))
  for (const [name, value] of sortedFields) form.append(name, value)
  let totalSize = 0
  const fileDescriptors: Array<Record<string, unknown>> = []
  for (const item of files ?? []) {
    const path = resolveWorkspacePath(item.path, primaryFolder)
    const size = await fileSize(path)
    totalSize += size
    if (totalSize > uploadMaximumBytes) throw new Error(`upload exceeds ${uploadMaximumBytes} bytes`)
    const contentType = item.content_type?.trim() || 'application/octet-stream'
    const filename = item.filename?.trim() || basename(path)
    const blob = await openAsBlob(path, {
      type: contentType
    })
    form.append(item.field, blob, filename)
    fileDescriptors.push({
      field: item.field,
      path,
      filename,
      contentType,
      size,
      sha256: await fileSha256(path, signal)
    })
  }
  return {
    body: form,
    fingerprint: sha256(JSON.stringify({
      type: 'multipart',
      fields: sortedFields,
      files: fileDescriptors
    }))
  }
}

async function readBoundedText(response: Response, maximumBytes: number): Promise<TextResponse> {
  if (!response.body) return { body: '', bytesRead: 0, truncated: false }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytesRead = 0
  let storedBytes = 0
  let truncated = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytesRead += value.byteLength
      const remaining = maximumBytes - storedBytes
      if (remaining > 0) {
        const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value
        chunks.push(chunk)
        storedBytes += chunk.byteLength
      }
      if (value.byteLength > remaining) {
        truncated = true
        await reader.cancel()
        break
      }
    }
  } finally {
    reader.releaseLock()
  }
  const body = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))))
  return { body, bytesRead, truncated }
}

async function ensureDownloadTarget(
  path: string,
  overwrite: boolean
): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  try {
    const info = await stat(path)
    if (info.isDirectory()) throw new Error(`download target is a directory: ${path}`)
    if (!overwrite) throw new Error(`download target already exists: ${path}`)
  } catch (reason) {
    const code = reason && typeof reason === 'object' && 'code' in reason ? reason.code : undefined
    if (code !== 'ENOENT') throw reason
  }
}

async function downloadResponse(
  response: Response,
  targetPath: string,
  maximumBytes: number,
  overwrite: boolean,
  onProgress?: (current: number, total?: number) => void
): Promise<number> {
  const artifactId = currentAgentToolEffectArtifactId('http-download') ?? randomUUID()
  const temporaryPath = `${targetPath}.anas-download-${artifactId}.tmp`
  const recordPath = await registerExternalTemporaryFile(temporaryPath, artifactId)
  let handle: Awaited<ReturnType<typeof open>> | undefined
  let bytesWritten = 0
  const contentLengthHeader = response.headers.get('content-length')
  const contentLengthValue = contentLengthHeader === null ? Number.NaN : Number(contentLengthHeader)
  const contentLength = Number.isSafeInteger(contentLengthValue) && contentLengthValue >= 0
    ? contentLengthValue
    : undefined
  try {
    handle = await open(temporaryPath, 'wx')
    if (response.body) {
      const reader = response.body.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          if (bytesWritten + value.byteLength > maximumBytes) {
            await reader.cancel()
            throw new Error(`download exceeds ${maximumBytes} bytes`)
          }
          let offset = 0
          while (offset < value.byteLength) {
            const write = await handle.write(value, offset, value.byteLength - offset)
            if (write.bytesWritten === 0) throw new Error(`could not write download target: ${targetPath}`)
            offset += write.bytesWritten
          }
          bytesWritten += value.byteLength
          onProgress?.(bytesWritten, contentLength)
        }
      } finally {
        reader.releaseLock()
      }
    }
    await handle.sync()
    await handle.close()
    handle = undefined
    if (!overwrite) await access(targetPath).then(
      () => { throw new Error(`download target already exists: ${targetPath}`) },
      () => undefined
    )
    await rename(temporaryPath, targetPath)
    return bytesWritten
  } finally {
    await handle?.close().catch(() => undefined)
    await releaseExternalTemporaryFile(temporaryPath, recordPath)
  }
}

function responseMetadata(response: Response, includeHeaders: boolean): Record<string, unknown> {
  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    contentType: response.headers.get('content-type') || undefined,
    ...(includeHeaders ? { headers: Object.fromEntries(response.headers.entries()) } : {})
  }
}

export async function executeHttpRequest(
  input: Record<string, unknown>,
  options: HttpRequestToolOptions
): Promise<string> {
  const controller = new AbortController()
  let dispatched = false
  let abortReason: 'cancelled' | 'timeout' | undefined
  const abort = (): void => {
    abortReason ??= 'cancelled'
    controller.abort()
  }
  const timeoutSeconds = boundedInteger(input.timeout, 0, 0, maximumTimeoutSeconds)
  const timeout = timeoutSeconds > 0
    ? setTimeout(() => {
        abortReason ??= 'timeout'
        controller.abort()
      }, timeoutSeconds * 1000)
    : undefined
  if (options.signal?.aborted) abort()
  else options.signal?.addEventListener('abort', abort, { once: true })

  try {
    const rawUrl = typeof input.url === 'string' ? input.url.trim() : ''
    if (!rawUrl) throw new Error('url is required')
    const url = new URL(resolveEnvironment(rawUrl, 'url'))
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error('url protocol must be http or https')
    }

    const headers = requestHeaders(input.headers)
    const preparedBody = await requestBody(
      input,
      options.primaryFolder,
      headers,
      controller.signal
    )
    const body = preparedBody.body
    const method = requestMethod(input)
    if (methodsWithoutBody.has(method) && body !== undefined) {
      throw new Error(`${method} requests cannot include a body`)
    }

    const outputPath = typeof input.output_path === 'string' && input.output_path.trim()
      ? resolveWorkspacePath(input.output_path, options.primaryFolder)
      : undefined
    const overwrite = input.overwrite === true
    const idempotencyKey = headers.get('idempotency-key')?.trim() || undefined
    const effectiveUrl = new URL(url)
    effectiveUrl.hash = ''

    if (outputPath) {
      await ensureDownloadTarget(outputPath, overwrite)
    }
    if (controller.signal.aborted) throw new Error('request aborted before dispatch')
    if (outputPath || !safeMethods.has(method)) {
      armCurrentAgentToolEffect({
        kind: outputPath ? 'http_request_with_download' : 'http_request',
        target: {
          method,
          origin: url.origin,
          requestedUrl: rawUrl,
          resolvedUrlFingerprint: sha256(effectiveUrl.href),
          headersFingerprint: sha256(JSON.stringify([...headers.entries()])),
          ...(preparedBody.fingerprint
            ? { bodyFingerprint: preparedBody.fingerprint }
            : {}),
          ...(outputPath ? { outputPath } : {})
        },
        recoveryMode: !outputPath && idempotencyKey ? 'idempotent' : 'confirm',
        ...(!outputPath && idempotencyKey
          ? { idempotencyFingerprint: sha256(idempotencyKey) }
          : {})
        })
    }

    options.onDispatched?.()
    dispatched = true
    const response = await fetch(url, {
      method,
      headers,
      body,
      redirect: input.follow_redirects === false ? 'manual' : 'follow',
      signal: controller.signal
    })

    if (outputPath && response.ok) {
      const maximumBytes = boundedInteger(input.max_bytes, downloadDefaultBytes, 1, downloadMaximumBytes)
      const bytes = await downloadResponse(
        response,
        outputPath,
        maximumBytes,
        overwrite,
        options.onProgress
      )
      options.onResult?.({
        ok: true,
        status: response.status,
        status_text: response.statusText,
        url: response.url,
        path: outputPath,
        bytes
      })
      return result({
        ...responseMetadata(response, input.include_metadata === true),
        path: outputPath,
        bytes
      })
    }

    const maximumBytes = boundedInteger(input.max_bytes, textResponseDefaultBytes, 1, textResponseMaximumBytes)
    const text = await readBoundedText(response, maximumBytes)
    if (outputPath) {
      options.onResult?.({
        ok: false,
        status: response.status,
        status_text: response.statusText,
        url: response.url,
        bytes_read: text.bytesRead,
        truncated: text.truncated,
        error: `HTTP ${response.status} response was not saved`
      })
      return result({
        ...responseMetadata(response, input.include_metadata === true),
        error: `HTTP ${response.status} response was not saved`,
        bytesRead: text.bytesRead,
        truncated: text.truncated,
        body: text.body
      })
    }
    options.onResult?.({
      ok: response.ok,
      status: response.status,
      status_text: response.statusText,
      url: response.url,
      bytes_read: text.bytesRead,
      truncated: text.truncated,
      ...(!response.ok ? { error: `HTTP ${response.status} ${response.statusText}`.trim() } : {})
    })
    if (input.include_metadata === true) {
      return result({
        ...responseMetadata(response, true),
        bytesRead: text.bytesRead,
        truncated: text.truncated,
        body: text.body
      })
    }
    return text.truncated
      ? `${text.body}\n\n[response truncated at ${maximumBytes} bytes]`
      : text.body
  } catch (reason) {
    const error = abortReason === 'timeout'
      ? `request timed out after ${timeoutSeconds} seconds`
      : abortReason === 'cancelled'
        ? 'request cancelled'
        : reason instanceof Error ? reason.message : String(reason)
    const failure = result({ ok: false, error })
    options.onResult?.({
      ok: false,
      error,
      ...(abortReason === 'timeout' ? { timed_out: true } : {}),
      ...(abortReason === 'cancelled' ? { cancelled: true } : {})
    })
    if (dispatched) {
      options.onOutcomeUncertain?.(
        abortReason === 'timeout'
          ? `HTTP request timed out after dispatch; the remote outcome is unknown.`
          : abortReason === 'cancelled'
            ? 'HTTP request was cancelled after dispatch; the remote outcome is unknown.'
            : 'HTTP request failed after dispatch; the remote outcome is unknown.'
      )
    }
    return failure
  } finally {
    if (timeout) clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abort)
  }
}

export function createHttpRequestTool(options: HttpRequestToolOptions): StructuredToolInterface {
  return tool(async (input) => {
    const control = currentToolExecution()
    if (!control) return executeHttpRequest(input, options)
    const method = requestMethod(input)
    const writesFile = typeof input.output_path === 'string' && input.output_path.trim().length > 0
    const uncertainAfterDispatch = writesFile || !safeMethods.has(method)
    return executeHttpRequest(input, {
      primaryFolder: options.primaryFolder,
      signal: control.signal,
      onDispatched: () => {
        control.markRunning()
        control.output('progress', 'HTTP request dispatched.\n')
      },
      onProgress: (current, total) => control.progress(current, 'bytes', total),
      onResult: control.setOutcome,
      ...(uncertainAfterDispatch
        ? { onOutcomeUncertain: control.markUncertain }
        : {})
    })
  }, {
    name: 'http_request',
    description: 'Make a common HTTP(S) request. Supports text or file bodies, multipart form uploads, bounded text responses, and atomic downloads.',
    schema: z.object({
      summary: toolSummarySchema,
      url: z.string().describe('Absolute HTTP(S) URL; may use local ${ENV_NAME} placeholders.'),
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).optional().describe('Request method. Defaults to GET without a body and POST with a body.'),
      headers: z.record(z.union([z.string(), z.number(), z.boolean()])).optional().describe('Request headers; string values may use local ${ENV_NAME} placeholders.'),
      body: z.string().optional().describe('UTF-8 request body. Mutually exclusive with body_file and multipart fields/files.'),
      body_file: z.string().optional().describe('Raw request body file, absolute or relative to the primary/default folder.'),
      form_fields: z.record(z.string()).optional().describe('Multipart form text fields.'),
      form_files: z.array(z.object({
        field: z.string().min(1).describe('Multipart field name.'),
        path: z.string().min(1).describe('File path, absolute or relative to the primary/default folder.'),
        filename: z.string().optional().describe('Uploaded filename. Defaults to the local basename.'),
        content_type: z.string().optional().describe('File content type. Defaults to application/octet-stream.')
      })).optional().describe('Multipart form files.'),
      output_path: z.string().optional().describe('Save a successful response to this absolute or workspace-relative path instead of returning its body.'),
      overwrite: z.boolean().optional().describe('Replace an existing output file. Default false.'),
      follow_redirects: z.boolean().optional().describe('Follow HTTP redirects. Default true.'),
      timeout: z.number().int().min(0).max(2_147_483).optional().describe('Maximum execution time in seconds. Omit or use 0 for no time limit; use a positive value only when an execution deadline is needed.'),
      max_bytes: z.number().int().min(1).max(100_000_000_000).optional().describe('Response limit in bytes. Text defaults to 200000 and allows at most 1000000; downloads default to 1000000000 and allow at most 100000000000.'),
      include_metadata: z.boolean().optional().describe('For text responses, return status, headers, size, truncation, and body as JSON. Download results always return JSON.')
    })
  })
}
