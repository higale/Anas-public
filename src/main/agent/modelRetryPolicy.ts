import { AIMessage } from '@langchain/core/messages'
import { createMiddleware } from 'langchain'
import { runtimeLog } from '../runtimeLogger'
import { isProjectRulesError } from './projectRules'
import { isModelSelectionError, ModelSelectionError } from './modelSelection'
import { isModelRequestChangedError } from './modelRequestValidation'
import { errorCauses } from './errorCauses'

export type ModelRetryReason = 'network' | 'rate_limit' | 'server' | 'timeout' | 'configuration_changed'

export interface ModelRetryDecision {
  retry: boolean
  reason?: ModelRetryReason
  status?: number
  code?: string
}

export interface ModelRetryEvent extends ModelRetryDecision {
  attempt: number
  delayMs: number
  maxAttempts: number
}

export interface ModelRetryOptions {
  initialDelayMs?: number
  maxDelayMs?: number
  maxRetries?: number
  retryWhen?(error: unknown): boolean
  onRetry?(event: ModelRetryEvent): void
  runId?: string
  signal?: AbortSignal
}

const retryableStatuses = new Set([408, 429, 500, 502, 503, 504, 520, 522, 523, 524])
const retryableCodes = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET'
])
const retryableNames = new Set([
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'InternalServerError',
  'RateLimitError',
  'TimeoutError'
])
const permanentQuotaPattern = /(?:billing[_ -]?hard[_ -]?limit|credit balance|exceeded your current quota|insufficient[_ -]?quota|monthly (?:spend|usage) limit|payment required|quota[_ -]?exhausted|usage limit)/i
const deterministicPattern = /(?:authentication|context length|invalid (?:argument|input|json|request|schema)|malformed|maximum context|must be|permission|token limit|tool[_ -]?use.*invalid|unsupported)/i

function boundedInteger(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  const candidate = value !== undefined && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(maximum, Math.max(minimum, candidate))
}

function firstString(chain: unknown[], key: string): string | undefined {
  for (const item of chain) {
    const value = (item as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function errorStatus(chain: unknown[]): number | undefined {
  for (const item of chain) {
    const record = item as Record<string, unknown>
    for (const value of [record.status, record.statusCode, (record.response as { status?: unknown } | undefined)?.status]) {
      const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
      if (Number.isInteger(parsed) && parsed >= 100 && parsed <= 599) return parsed
    }
  }
  return undefined
}

function errorText(chain: unknown[]): string {
  return chain.flatMap((item) => {
    const record = item as Record<string, unknown>
    return [record.name, record.message, record.code, record.type]
      .filter((value): value is string => typeof value === 'string')
  }).join(' ')
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason
  return new DOMException(
    typeof signal.reason === 'string' && signal.reason ? signal.reason : 'The model request was aborted.',
    'AbortError'
  )
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal)
}

export function classifyModelRetryError(error: unknown, signal?: AbortSignal): ModelRetryDecision {
  if (isModelSelectionError(error)) return { retry: false }
  if (isModelRequestChangedError(error)) return signal?.aborted
    ? { retry: false } : { retry: true, reason: 'configuration_changed' }
  if (isProjectRulesError(error)) return { retry: false }
  if (signal?.aborted) return { retry: false }
  const chain = errorCauses(error)
  const name = firstString(chain, 'name')
  const code = firstString(chain, 'code')
  const status = errorStatus(chain)
  const text = errorText(chain)
  if (name === 'AbortError' || code === 'ABORT_ERR' || code === 'ERR_ABORTED') return { retry: false, status, code }
  if (permanentQuotaPattern.test(text) || deterministicPattern.test(text)) return { retry: false, status, code }
  if (status !== undefined) {
    if (!retryableStatuses.has(status)) return { retry: false, status, code }
    return { retry: true, reason: status === 408 ? 'timeout' : status === 429 ? 'rate_limit' : 'server', status, code }
  }
  if (code && retryableCodes.has(code.toUpperCase())) return { retry: true, reason: 'network', code }
  if (name && retryableNames.has(name)) {
    return { retry: true, reason: name.includes('Timeout') ? 'timeout' : name === 'RateLimitError' ? 'rate_limit' : name === 'InternalServerError' ? 'server' : 'network', code }
  }
  if (/fetch failed/i.test(text)) return { retry: true, reason: 'network', code }
  if (/(?:request )?(?:timed out|timeout)/i.test(text) && name !== 'TypeError') {
    return { retry: true, reason: 'timeout', code }
  }
  return { retry: false, status, code }
}

export function abortableModelRetryDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) {
    throwIfAborted(signal)
    return Promise.resolve()
  }
  throwIfAborted(signal)
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, milliseconds)
    const onAbort = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(signal ? abortError(signal) : new DOMException('The model request was aborted.', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function invokeModelWithRetry<T>(
  invoke: () => T | Promise<T>,
  options: ModelRetryOptions = {}
): Promise<T> {
  const maxRetries = boundedInteger(options.maxRetries, 2, 0, 8)
  const maxAttempts = maxRetries + 1
  const initialDelayMs = boundedInteger(options.initialDelayMs, 500, 0, 60_000)
  const maxDelayMs = Math.max(
    initialDelayMs,
    boundedInteger(options.maxDelayMs, 4_000, 0, 60_000)
  )
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(options.signal)
    try {
      return await invoke()
    } catch (error) {
      throwIfAborted(options.signal)
      const decision = classifyModelRetryError(error, options.signal)
      if (decision.status !== undefined && [400, 401, 403, 404, 413, 422].includes(decision.status)) {
        throw new ModelSelectionError(`The provider rejected the current model request (HTTP ${decision.status}). The run was stopped. Check the selected model, credentials, parameters and input requirements. ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      }
      if (!decision.retry || options.retryWhen?.(error) === false || attempt >= maxAttempts) throw error
      const delayMs = Math.min(maxDelayMs, initialDelayMs * (2 ** (attempt - 1)))
      const event: ModelRetryEvent = { ...decision, attempt, delayMs, maxAttempts }
      options.onRetry?.(event)
      runtimeLog('warn', 'agent-model', 'Retrying a transient model request.', {
        runId: options.runId,
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
        delayMs,
        reason: decision.reason,
        status: decision.status,
        code: decision.code
      })
      await abortableModelRetryDelay(delayMs, options.signal)
    }
  }
  throw new Error('Model retry loop completed without returning.')
}

export function createAnasModelRetryMiddleware(options: ModelRetryOptions = {}) {
  return createMiddleware({
    name: 'AnasModelRetryMiddleware',
    wrapModelCall: async (request, handler) => invokeModelWithRetry(
      async () => {
        const response = await handler(request)
        // Structured output returns a framework state update containing messages.
        const messages = response && 'messages' in response && Array.isArray(response.messages)
          ? response.messages : [response]
        if (messages.some((message) => AIMessage.isInstance(message) && (message.invalid_tool_calls?.length
          || message.contentBlocks.some((block) => block.type === 'invalid_tool_call')))) {
          throw new Error('Model returned an invalid tool call.')
        }
        return response
      },
      { ...options, signal: request.runtime.signal ?? options.signal }
    )
  })
}
