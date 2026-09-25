import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getDataDir } from './config/dataDir'
import { synthesizeEdgeSpeech } from './speech/edgeSpeech'
import { runtimeLog } from './runtimeLogger'
import { clampSpeechReplySpeed, defaultSpeechReplyVoice } from '@shared/speechText'
import type { SpeechGenerateRequest, SpeechVoiceInfo } from '@shared/types'

const speechCacheDirName = 'cache'
const speechVoiceCacheFileName = 'speech_voices.json'
const speechVoiceListTimeoutMs = 30000
const speechErrorOutputMaxLength = 1000
const speechVoiceListUrl = 'https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4'

interface SpeechVoiceCache {
  cachedAt: string
  voices: SpeechVoiceInfo[]
}

function speechCacheDir(): string {
  return join(getDataDir(), speechCacheDirName)
}

function speechVoiceCachePath(): string {
  return join(speechCacheDir(), speechVoiceCacheFileName)
}

function shortErrorText(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > speechErrorOutputMaxLength ? `${trimmed.slice(0, speechErrorOutputMaxLength)}...` : trimmed
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    })
  } finally {
    clearTimeout(timeout)
  }
}

async function responseError(prefix: string, response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') ?? ''
  const output = shortErrorText(await response.text().catch(() => ''))
  return `${prefix}: HTTP ${response.status}${contentType ? `, content-type=${contentType}` : ''}${output ? `: ${output}` : ''}`
}

export async function generateSpeech(request: SpeechGenerateRequest, signal: AbortSignal): Promise<Uint8Array> {
  if (!request || typeof request.text !== 'string' || request.text.length > 8192
    || typeof request.voice !== 'string' || request.voice.length > 200
    || !Number.isFinite(request.speed)) throw new Error('Invalid speech request.')
  signal.throwIfAborted()
  const text = request.text
  if (!text.trim()) throw new Error('Speech text is empty.')
  const voice = defaultSpeechReplyVoice(request.voice)
  const speed = clampSpeechReplySpeed(request.speed)
  try {
    const audio = await synthesizeEdgeSpeech({ text, voice, speed }, signal)
    runtimeLog('debug', 'speech', 'Speech audio generated.', {
      requestId: request.requestId, bytes: audio.byteLength, textLength: text.length, voice, speed
    })
    return audio
  } catch (error) {
    if (!signal.aborted) runtimeLog('warn', 'speech', 'Speech generation failed.', {
      requestId: request.requestId, textLength: text.length, voice, speed, error
    })
    throw error
  }
}

function parseSpeechVoiceList(output: unknown): SpeechVoiceInfo[] {
  if (!Array.isArray(output)) return []
  const voices = new Map<string, SpeechVoiceInfo>()
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const shortName = typeof record.ShortName === 'string'
      ? record.ShortName.trim()
      : typeof record.Name === 'string'
        ? record.Name.trim()
        : ''
    if (!shortName || voices.has(shortName.toLowerCase())) continue
    voices.set(shortName.toLowerCase(), {
      shortName,
      gender: typeof record.Gender === 'string' ? record.Gender.trim() : '',
      detail: typeof record.Locale === 'string' ? record.Locale.trim() : ''
    })
  }
  return [...voices.values()]
}

function parseSpeechVoiceCache(output: unknown): SpeechVoiceCache | undefined {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return undefined
  const record = output as Record<string, unknown>
  const cachedAt = typeof record.cachedAt === 'string' ? record.cachedAt : ''
  const voices = parseCachedSpeechVoices(record.voices)
  if (!cachedAt || voices.length === 0) return undefined
  return { cachedAt, voices }
}

function parseCachedSpeechVoices(output: unknown): SpeechVoiceInfo[] {
  if (!Array.isArray(output)) return []
  const voices = new Map<string, SpeechVoiceInfo>()
  for (const item of output) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const shortName = typeof record.shortName === 'string' ? record.shortName.trim() : ''
    if (!shortName || voices.has(shortName.toLowerCase())) continue
    voices.set(shortName.toLowerCase(), {
      shortName,
      gender: typeof record.gender === 'string' ? record.gender.trim() : '',
      detail: typeof record.detail === 'string' ? record.detail.trim() : ''
    })
  }
  return [...voices.values()]
}

async function readSpeechVoiceCache(): Promise<SpeechVoiceCache | undefined> {
  try {
    return parseSpeechVoiceCache(JSON.parse(await readFile(speechVoiceCachePath(), 'utf8')))
  } catch (reason) {
    const code = (reason as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      runtimeLog('warn', 'speech', 'Failed to read speech voice cache.', { error: reason })
    }
    return undefined
  }
}

async function writeSpeechVoiceCache(voices: SpeechVoiceInfo[]): Promise<void> {
  try {
    await mkdir(speechCacheDir(), { recursive: true })
    await writeFile(speechVoiceCachePath(), JSON.stringify({
      cachedAt: new Date().toISOString(),
      voices
    }, null, 2), 'utf8')
  } catch (reason) {
    runtimeLog('warn', 'speech', 'Failed to write speech voice cache.', { error: reason })
  }
}

async function fetchSpeechVoices(): Promise<SpeechVoiceInfo[]> {
  runtimeLog('debug', 'speech', 'Loading speech voice list.')
  const response = await fetchWithTimeout(speechVoiceListUrl, {
    headers: {
      Accept: 'application/json'
    }
  }, speechVoiceListTimeoutMs)

  if (!response.ok) throw new Error(await responseError('Speech voice list failed', response))

  const voices = parseSpeechVoiceList(await response.json())
  if (voices.length === 0) throw new Error('No speech voices returned.')
  return voices
}

export async function loadSpeechVoices(forceRefresh = false): Promise<SpeechVoiceInfo[]> {
  const cache = await readSpeechVoiceCache()
  if (cache && !forceRefresh) {
    runtimeLog('debug', 'speech', 'Using cached speech voice list.', {
      cachedAt: cache.cachedAt,
      voices: cache.voices.length
    })
    return cache.voices
  }

  try {
    const voices = await fetchSpeechVoices()
    await writeSpeechVoiceCache(voices)
    return voices
  } catch (reason) {
    if (cache) {
      runtimeLog('warn', 'speech', 'Failed to refresh speech voice list; using cached voices.', {
        cachedAt: cache.cachedAt,
        voices: cache.voices.length,
        error: reason
      })
      return cache.voices
    }
    throw reason
  }
}
