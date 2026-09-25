import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getCacheDir } from './config/dataDir'
import { runtimeLog } from './runtimeLogger'

export interface ModelListCache {
  cachedAt: string
  endpoint: string
  models: string[]
}

function modelListCacheFileName(endpoint: string, apiKey?: string): string {
  return `${createHash('sha256')
    .update(JSON.stringify({
      endpoint,
      apiKey: apiKey ?? ''
    }))
    .digest('hex')}.json`
}

function modelListCachePath(endpoint: string, apiKey?: string): string {
  return join(getCacheDir(), 'model_lists', modelListCacheFileName(endpoint, apiKey))
}

function parseCachedModels(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const models = new Map<string, string>()
  for (const item of value) {
    if (typeof item !== 'string') continue
    const model = item.trim()
    if (!model || models.has(model.toLowerCase())) continue
    models.set(model.toLowerCase(), model)
  }
  return [...models.values()]
}

function parseModelListCache(value: unknown, endpoint: string): ModelListCache | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const cachedAt = typeof record.cachedAt === 'string' ? record.cachedAt : ''
  const cacheEndpoint = typeof record.endpoint === 'string' ? record.endpoint : ''
  const models = parseCachedModels(record.models)
  if (!cachedAt || cacheEndpoint !== endpoint || models.length === 0) return undefined
  return {
    cachedAt,
    endpoint: cacheEndpoint,
    models
  }
}

export async function readModelListCache(endpoint: string, apiKey?: string): Promise<ModelListCache | undefined> {
  try {
    return parseModelListCache(JSON.parse(await readFile(modelListCachePath(endpoint, apiKey), 'utf8')), endpoint)
  } catch (reason) {
    const code = (reason as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      runtimeLog('warn', 'model', 'Failed to read model list cache.', {
        endpoint,
        error: reason
      })
    }
    return undefined
  }
}

export async function writeModelListCache(endpoint: string, apiKey: string | undefined, models: string[]): Promise<void> {
  const cache: ModelListCache = {
    cachedAt: new Date().toISOString(),
    endpoint,
    models
  }
  await mkdir(join(getCacheDir(), 'model_lists'), { recursive: true })
  await writeFile(modelListCachePath(endpoint, apiKey), JSON.stringify(cache, null, 2), 'utf8')
}
