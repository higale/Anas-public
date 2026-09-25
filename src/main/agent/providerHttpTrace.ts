import { randomUUID } from 'node:crypto'
import { mkdir, open, writeFile, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelProtocol } from '@shared/types'
import { getDeveloperHttpTraceDir } from '../config/dataDir'
import { runtimeLog } from '../runtimeLogger'

const mebibyte = 1024 * 1024

export interface ProviderHttpTraceLimits {
  maximumBodyBytes: number
}

const defaultTraceLimits: Readonly<ProviderHttpTraceLimits> = Object.freeze({
  maximumBodyBytes: 1024 * mebibyte
})

export interface ProviderHttpTraceOptions {
  model: string
  protocol: ModelProtocol
  providerName: string
  requestId?: string
  requestRole?: string
}

interface TraceEntry {
  directory: string
  finalized: boolean
  maximumBodyBytes: number
  requestCapture: Promise<void>
  responseBodyBytes: number
  responseBodyFile?: FileHandle
  responseBodyFileName?: string
  responseBodyObservedBytes: number
  responseMetadata?: Record<string, unknown>
  traceFailed: boolean
  truncated: boolean
}

interface BodyCaptureResult {
  bodyBytes: number
  observedBodyBytes: number
  truncated: boolean
}

function safeFilePart(value: string | undefined, fallback: string): string {
  const safe = value?.trim().replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64)
  return safe || fallback
}

function timestampFilePart(date: Date): string {
  return date.toISOString().replaceAll(':', '-').replace('Z', '')
}

function headersObject(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries())
}

function bodyFileName(prefix: 'request' | 'response', contentType: string | null): string {
  const normalized = contentType?.toLowerCase() ?? ''
  if (normalized.includes('text/event-stream')) return `${prefix}-body.sse`
  if (normalized.includes('json')) return `${prefix}-body.json`
  if (normalized.startsWith('text/')) return `${prefix}-body.txt`
  return `${prefix}-body.bin`
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { type: typeof error }
  return {
    name: error.name,
    message: error.message,
    ...('code' in error && typeof error.code === 'string' ? { code: error.code } : {})
  }
}

function requireTraceLimits(limits: ProviderHttpTraceLimits): ProviderHttpTraceLimits {
  if (!Number.isSafeInteger(limits.maximumBodyBytes) || limits.maximumBodyBytes < 1) {
    throw new Error('HTTP trace maximum body bytes must be a positive safe integer.')
  }
  return limits
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function writeAll(file: FileHandle, value: Uint8Array): Promise<void> {
  let offset = 0
  while (offset < value.byteLength) {
    const { bytesWritten } = await file.write(value, offset, value.byteLength - offset)
    if (bytesWritten <= 0) throw new Error('HTTP trace file write made no progress.')
    offset += bytesWritten
  }
}

async function captureBody(
  body: ReadableStream<Uint8Array> | null,
  path: string,
  maximumBodyBytes: number
): Promise<BodyCaptureResult> {
  const file = await open(path, 'w')
  let bodyBytes = 0
  let observedBodyBytes = 0
  let truncated = false
  try {
    if (!body) return { bodyBytes, observedBodyBytes, truncated }
    const reader = body.getReader()
    try {
      while (true) {
        const next = await reader.read()
        if (next.done) break
        observedBodyBytes = Math.min(
          Number.MAX_SAFE_INTEGER,
          observedBodyBytes + next.value.byteLength
        )
        const remaining = maximumBodyBytes - bodyBytes
        if (remaining <= 0) {
          truncated = true
          continue
        }
        const captured = next.value.subarray(0, remaining)
        await writeAll(file, captured)
        bodyBytes += captured.byteLength
        if (captured.byteLength < next.value.byteLength) truncated = true
      }
    } finally {
      reader.releaseLock()
    }
    return { bodyBytes, observedBodyBytes, truncated }
  } finally {
    await file.close()
  }
}

function requestMetadata(
  request: Request,
  options: ProviderHttpTraceOptions,
  requestNumber: number,
  startedAt: Date,
  requestBodyFileName: string
): Record<string, unknown> {
  return {
    formatVersion: 1,
    startedAt: startedAt.toISOString(),
    requestId: options.requestId,
    role: options.requestRole ?? 'model',
    provider: options.providerName,
    protocol: options.protocol,
    model: options.model,
    requestNumber,
    url: request.url,
    method: request.method,
    headers: headersObject(request.headers),
    bodyFile: requestBodyFileName,
    captureStatus: request.body ? 'streaming' : 'completed',
    bodyBytes: 0
  }
}

async function recordRequestBody(
  entry: TraceEntry,
  request: Request,
  metadata: Record<string, unknown>,
  requestBodyFileName: string
): Promise<void> {
  try {
    const result = await captureBody(
      request.body,
      join(entry.directory, requestBodyFileName),
      entry.maximumBodyBytes
    )
    await writeJson(join(entry.directory, 'request.json'), {
      ...metadata,
      completedAt: new Date().toISOString(),
      captureStatus: result.truncated ? 'truncated' : 'completed',
      bodyBytes: result.bodyBytes,
      ...(result.truncated
        ? {
            observedBodyBytes: result.observedBodyBytes,
            maximumBodyBytes: entry.maximumBodyBytes
          }
        : {})
    })
  } catch (error) {
    try {
      await writeJson(join(entry.directory, 'request.json'), {
        ...metadata,
        completedAt: new Date().toISOString(),
        captureStatus: 'failed',
        bodyCaptureError: errorDetails(error)
      })
    } catch {
      // The provider call remains authoritative when diagnostic metadata fails.
    }
    runtimeLog('warn', 'agent-model-http-trace', 'Failed to capture provider HTTP request.', {
      directory: entry.directory,
      error: errorDetails(error)
    })
  }
}

async function beginTrace(
  request: Request,
  options: ProviderHttpTraceOptions,
  requestNumber: number,
  startedAt: Date,
  limits: ProviderHttpTraceLimits
): Promise<TraceEntry> {
  const directory = join(
    getDeveloperHttpTraceDir(),
    `${timestampFilePart(startedAt)}_${safeFilePart(options.requestId, 'no-run')}_${safeFilePart(options.requestRole, 'model')}_${String(requestNumber).padStart(4, '0')}_${randomUUID()}`
  )
  await mkdir(directory, { recursive: true })
  const requestClone = request.clone()
  const requestBodyFileName = bodyFileName('request', request.headers.get('content-type'))
  const metadata = requestMetadata(request, options, requestNumber, startedAt, requestBodyFileName)
  await writeJson(join(directory, 'request.json'), metadata)
  const entry: TraceEntry = {
    directory,
    finalized: false,
    maximumBodyBytes: limits.maximumBodyBytes,
    requestCapture: Promise.resolve(),
    responseBodyBytes: 0,
    responseBodyObservedBytes: 0,
    traceFailed: false,
    truncated: false
  }
  entry.requestCapture = recordRequestBody(entry, requestClone, metadata, requestBodyFileName)
  return entry
}

async function recordResponseHeaders(entry: TraceEntry, response: Response, startedAt: Date): Promise<void> {
  entry.responseBodyFileName = bodyFileName('response', response.headers.get('content-type'))
  entry.responseMetadata = {
    receivedAt: new Date().toISOString(),
    durationToHeadersMs: Date.now() - startedAt.getTime(),
    url: response.url,
    redirected: response.redirected,
    type: response.type,
    status: response.status,
    statusText: response.statusText,
    headers: headersObject(response.headers),
    bodyFile: entry.responseBodyFileName,
    captureStatus: response.body ? 'streaming' : 'completed',
    bodyBytes: 0
  }
  await writeJson(join(entry.directory, 'response.json'), entry.responseMetadata)
  if (response.body) {
    entry.responseBodyFile = await open(join(entry.directory, entry.responseBodyFileName), 'w')
  } else {
    await writeFile(join(entry.directory, entry.responseBodyFileName), new Uint8Array())
  }
}

async function finalizeResponse(entry: TraceEntry, status: 'completed' | 'cancelled' | 'failed'): Promise<void> {
  if (entry.finalized) return
  entry.finalized = true
  try {
    if (entry.responseBodyFile) {
      try {
        await entry.responseBodyFile.close()
      } catch {
        // A trace close failure must not alter the provider response.
      }
      entry.responseBodyFile = undefined
    }
    if (!entry.responseMetadata || entry.traceFailed) return
    entry.responseMetadata = {
      ...entry.responseMetadata,
      completedAt: new Date().toISOString(),
      captureStatus: entry.truncated ? 'truncated' : status,
      bodyBytes: entry.responseBodyBytes,
      ...(entry.truncated
        ? {
            observedBodyBytes: entry.responseBodyObservedBytes,
            maximumBodyBytes: entry.maximumBodyBytes
          }
        : {})
    }
    try {
      await writeJson(join(entry.directory, 'response.json'), entry.responseMetadata)
    } catch (error) {
      entry.traceFailed = true
      runtimeLog('warn', 'agent-model-http-trace', 'Failed to finalize provider HTTP trace.', {
        directory: entry.directory,
        error: errorDetails(error)
      })
    }
  } finally {
    await entry.requestCapture
  }
}

async function recordNetworkFailure(entry: TraceEntry, error: unknown): Promise<void> {
  try {
    await writeJson(join(entry.directory, 'error.json'), {
      failedAt: new Date().toISOString(),
      error: errorDetails(error)
    })
  } catch {
    // The original provider failure remains authoritative.
  } finally {
    await entry.requestCapture
  }
}

async function recordResponseChunk(entry: TraceEntry, chunk: Uint8Array): Promise<void> {
  if (entry.traceFailed || !entry.responseBodyFile) return
  entry.responseBodyObservedBytes = Math.min(
    Number.MAX_SAFE_INTEGER,
    entry.responseBodyObservedBytes + chunk.byteLength
  )
  const remaining = entry.maximumBodyBytes - entry.responseBodyBytes
  if (remaining <= 0) {
    entry.truncated = true
    return
  }
  const captured = chunk.subarray(0, remaining)
  try {
    await writeAll(entry.responseBodyFile, captured)
    entry.responseBodyBytes += captured.byteLength
    if (captured.byteLength < chunk.byteLength) entry.truncated = true
  } catch (error) {
    entry.traceFailed = true
    try {
      await entry.responseBodyFile.close()
    } catch {
      // Preserve the provider stream even when the diagnostic sink fails.
    }
    entry.responseBodyFile = undefined
    runtimeLog('warn', 'agent-model-http-trace', 'Failed to write provider HTTP response trace.', {
      directory: entry.directory,
      error: errorDetails(error)
    })
  }
}

function responseWithTracedBody(response: Response, entry: TraceEntry): Response {
  if (!response.body) return response
  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read()
        if (next.done) {
          await finalizeResponse(entry, 'completed')
          controller.close()
          return
        }
        await recordResponseChunk(entry, next.value)
        controller.enqueue(next.value)
      } catch (error) {
        await finalizeResponse(entry, 'failed')
        controller.error(error)
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason)
      } finally {
        await finalizeResponse(entry, 'cancelled')
      }
    }
  })
  const traced = new Response(body, {
    headers: response.headers,
    status: response.status,
    statusText: response.statusText
  })
  Object.defineProperties(traced, {
    redirected: { configurable: true, value: response.redirected },
    type: { configurable: true, value: response.type },
    url: { configurable: true, value: response.url }
  })
  return traced
}

export function createProviderHttpTraceFetch(
  baseFetch: typeof fetch,
  options: ProviderHttpTraceOptions,
  requestedLimits: ProviderHttpTraceLimits = defaultTraceLimits
): typeof fetch {
  const limits = requireTraceLimits(requestedLimits)
  let requestNumber = 0
  return async (input, init) => {
    requestNumber += 1
    const request = new Request(input, init)
    const startedAt = new Date()
    let entry: TraceEntry | undefined
    try {
      entry = await beginTrace(request, options, requestNumber, startedAt, limits)
    } catch (error) {
      runtimeLog('warn', 'agent-model-http-trace', 'Failed to start provider HTTP trace.', {
        requestId: options.requestId,
        role: options.requestRole ?? 'model',
        protocol: options.protocol,
        model: options.model,
        error: errorDetails(error)
      })
    }

    try {
      const response = await baseFetch(request)
      if (!entry) return response
      try {
        await recordResponseHeaders(entry, response, startedAt)
        if (!response.body) await finalizeResponse(entry, 'completed')
        return responseWithTracedBody(response, entry)
      } catch (error) {
        entry.traceFailed = true
        await finalizeResponse(entry, 'failed')
        runtimeLog('warn', 'agent-model-http-trace', 'Failed to capture provider HTTP response.', {
          directory: entry.directory,
          error: errorDetails(error)
        })
        return response
      }
    } catch (error) {
      if (entry) await recordNetworkFailure(entry, error)
      throw error
    }
  }
}
