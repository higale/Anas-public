import { getModelProviderConfig } from './config/appConfig'
import { resolveModelApiKey } from './config/apiKeys'
import { readModelListCache, writeModelListCache } from './modelListCache'
import { requireModelListAuth, requireModelProtocol } from '@shared/modelConfig'
import { resolveModelListEndpoint } from '@shared/modelListEndpoint'
import type { ModelListAuth, ModelListRequest, ModelListResponse, ModelProviderConfig } from '@shared/types'

function modelListHeaders(auth: ModelListAuth, apiKey: string | undefined): Record<string, string> {
  if (!apiKey) return {}
  if (auth === 'anthropic') {
    return {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    }
  }
  return {
    Authorization: `Bearer ${apiKey}`
  }
}

interface ModelListRequestRuntime {
  endpoint: string
  apiKey: string | undefined
  auth: ModelListAuth
}

async function modelListRequestRuntime(request: ModelListRequest): Promise<ModelListRequestRuntime> {
  const existing = request.providerId === undefined ? undefined : await getModelProviderConfig(request.providerId)
  const provider: ModelProviderConfig = {
    id: existing?.id ?? 'model-list-request',
    name: request.name?.trim() || existing?.name || 'Model',
    protocol: requireModelProtocol(request.protocol, 'modelList.protocol'),
    baseUrl: request.baseUrl.trim(),
    modelListUrl: request.modelListUrl === undefined
      ? existing?.modelListUrl ?? ''
      : request.modelListUrl.trim(),
    modelListAuth: requireModelListAuth(request.modelListAuth, 'modelList.modelListAuth'),
    apiKey: request.apiKey?.trim() || existing?.apiKey,
    parameters: existing?.parameters ?? {},
    models: existing?.models ?? []
  }
  if (!provider.baseUrl) throw new Error('Base URL is required.')
  const endpoint = resolveModelListEndpoint(provider.baseUrl, provider.modelListUrl)
  const apiKey = resolveModelApiKey(provider)
  return { endpoint, apiKey, auth: provider.modelListAuth }
}

function modelListItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (!value || typeof value !== 'object') return []
  const record = value as Record<string, unknown>
  if (Array.isArray(record.data)) return record.data
  return Array.isArray(record.models) ? record.models : []
}

function modelListItemId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const id = (value as Record<string, unknown>).id
  return typeof id === 'string' && id.trim().length > 0 ? id : undefined
}

export async function getCachedAvailableModels(request: ModelListRequest): Promise<ModelListResponse | null> {
  const { endpoint, apiKey } = await modelListRequestRuntime(request)
  const cache = await readModelListCache(endpoint, apiKey)
  return cache
    ? {
        models: cache.models
      }
    : null
}

export async function fetchAvailableModels(request: ModelListRequest): Promise<ModelListResponse> {
  const { endpoint, apiKey, auth } = await modelListRequestRuntime(request)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  try {
    const headers = modelListHeaders(auth, apiKey)
    const response = await fetch(endpoint, { headers, signal: controller.signal })
    const text = await response.text()
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 240)}`)
    const models = modelListItems(JSON.parse(text))
      .map(modelListItemId)
      .filter((id): id is string => id !== undefined)
    if (models.length === 0) throw new Error('No models were returned.')
    await writeModelListCache(endpoint, apiKey, models)
    const cache = await readModelListCache(endpoint, apiKey)
    if (!cache) throw new Error('Model list cache was not written.')
    return { models: cache.models }
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw new Error('Model list request timed out.')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}
