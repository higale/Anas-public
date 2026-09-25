import { app } from 'electron'
import { copyFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { getBundledLangDir, getLangDir } from './config/dataDir'
import { runtimeLog } from './runtimeLogger'
import type { AppProfile, LanguagePackSummary, LanguageResourcesSnapshot } from '@shared/types'

type JsonObject = Record<string, unknown>

const builtInLanguages = ['en', 'zh-CN']
const readmeFileName = 'README.md'
const systemLanguagePreference = 'system'
let latestSnapshot: LanguageResourcesSnapshot | undefined

function isJsonObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function mergeDeep(base: JsonObject, override: JsonObject): JsonObject {
  const result: JsonObject = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const current = result[key]
    result[key] = isJsonObject(current) && isJsonObject(value) ? mergeDeep(current, value) : value
  }
  return result
}

async function readJsonFile(filePath: string): Promise<JsonObject | undefined> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf8')) as unknown
    return isJsonObject(parsed) ? parsed : undefined
  } catch (reason) {
    runtimeLog('warn', 'i18n', 'Failed to read language pack.', {
      path: filePath,
      error: reason
    })
    return undefined
  }
}

function languageName(code: string, resource: JsonObject | undefined): string {
  const meta = isJsonObject(resource?._meta) ? resource._meta : {}
  const name = meta.name
  return typeof name === 'string' && name.trim() ? name.trim() : code
}

function languageAuthor(resource: JsonObject | undefined): string | undefined {
  const meta = isJsonObject(resource?._meta) ? resource._meta : {}
  const author = meta.author
  return typeof author === 'string' && author.trim() ? author.trim() : undefined
}

function nestedString(resource: JsonObject | undefined, path: readonly string[]): string | undefined {
  let current: unknown = resource
  for (const key of path) {
    if (!isJsonObject(current)) return undefined
    current = current[key]
  }
  return typeof current === 'string' ? current : undefined
}

export function profileDefaultsFromResources(
  languageCode: string,
  resources: Record<string, unknown>
): AppProfile {
  const selected = isJsonObject(resources[languageCode]) ? resources[languageCode] : undefined
  const fallback = isJsonObject(resources.en) ? resources.en : undefined
  const defaultValue = (path: readonly string[]): string =>
    nestedString(selected, path) ?? nestedString(fallback, path) ?? ''

  return {
    assistant: {
      name: 'Ananas',
      role: defaultValue(['profile_defaults', 'assistant', 'role']),
      instructions: defaultValue(['profile_defaults', 'assistant', 'instructions']),
      newAvatarPath: ''
    },
    user: {
      preferredName: '',
      personalInfo: ''
    }
  }
}

async function listUserLanguageFiles(): Promise<string[]> {
  await mkdir(getLangDir(), { recursive: true })
  const files = await readdir(getLangDir())
  return files
    .filter((file) => extname(file).toLowerCase() === '.json')
    .map((file) => join(getLangDir(), file))
}

async function releaseBuiltinLanguageFiles(): Promise<void> {
  await mkdir(getLangDir(), { recursive: true })
  await Promise.all([
    ...builtInLanguages.map((code) => copyFile(
      join(getBundledLangDir(), `${code}.json`),
      join(getLangDir(), `${code}.json`)
    )),
    copyFile(
      join(getBundledLangDir(), readmeFileName),
      join(getLangDir(), readmeFileName)
    )
  ])
}

export async function getLanguageResources(): Promise<LanguageResourcesSnapshot> {
  await releaseBuiltinLanguageFiles()
  const resources: Record<string, JsonObject> = {}
  const summaries = new Map<string, LanguagePackSummary>()

  for (const code of builtInLanguages) {
    const filePath = join(getBundledLangDir(), `${code}.json`)
    const resource = await readJsonFile(filePath)
    resources[code] = resource ?? {}
    summaries.set(code, {
      code,
      name: languageName(code, resource),
      author: languageAuthor(resource),
      builtIn: true
    })
  }

  for (const filePath of await listUserLanguageFiles()) {
    const code = basename(filePath, extname(filePath))
    const resource = await readJsonFile(filePath)
    if (!resource) continue
    resources[code] = mergeDeep(resources[code] ?? {}, resource)
    summaries.set(code, {
      code,
      name: languageName(code, resources[code]),
      author: languageAuthor(resources[code]),
      builtIn: summaries.get(code)?.builtIn ?? false,
      userPath: filePath
    })
  }

  latestSnapshot = {
    langDir: getLangDir(),
    languages: [...summaries.values()].sort((a, b) => a.name.localeCompare(b.name)),
    resources
  }
  return latestSnapshot
}

function matchLanguage(
  code: string,
  languages: LanguagePackSummary[]
): LanguagePackSummary | undefined {
  const normalized = code.trim()
  if (!normalized) return undefined
  const exact = languages.find((language) =>
    language.code.toLowerCase() === normalized.toLowerCase()
  )
  if (exact) return exact
  const base = normalized.split('-')[0]?.toLowerCase()
  return languages.find((language) =>
    language.code.split('-')[0]?.toLowerCase() === base
  )
}

export async function resolveConfiguredLanguage(
  preference: string
): Promise<LanguagePackSummary> {
  const snapshot = latestSnapshot ?? await getLanguageResources()
  return resolveLanguagePack(
    preference,
    app.getLocale(),
    snapshot.languages
  )
}

export async function resolveDefaultProfile(preference: string): Promise<AppProfile> {
  const snapshot = latestSnapshot ?? await getLanguageResources()
  const language = resolveLanguagePack(preference, app.getLocale(), snapshot.languages)
  return profileDefaultsFromResources(language.code, snapshot.resources)
}

export function resolveLanguagePack(
  preference: string,
  systemLocale: string,
  languages: LanguagePackSummary[]
): LanguagePackSummary {
  const requested = preference === systemLanguagePreference
    ? systemLocale
    : preference
  const resolved = matchLanguage(requested, languages)
    ?? matchLanguage('en', languages)
  if (!resolved) throw new Error('No language pack is available for context summaries.')
  return resolved
}
