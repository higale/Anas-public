import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { getInputHistoryFile } from './config/dataDir'
import type { InputHistoryItem, InputHistorySnapshot } from '@shared/types'

interface StoredInputHistory {
  version: 1
  maxHistory: number
  items: InputHistoryItem[]
}

const defaultMaxHistory = 100

function now(): string {
  return new Date().toISOString()
}

function cleanText(text: string): string {
  return text.trim()
}

async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  await rename(tempPath, path)
}

function sortItems(items: InputHistoryItem[]): InputHistoryItem[] {
  return [...items].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
}

function prune(items: InputHistoryItem[], maxHistory: number): InputHistoryItem[] {
  const pinned = sortItems(items.filter((item) => item.pinned))
  const history = sortItems(items.filter((item) => !item.pinned)).slice(0, maxHistory)
  return [...pinned, ...history]
}

export function normalizeInputHistoryStore(raw: Partial<StoredInputHistory> | undefined): StoredInputHistory {
  const maxHistory = typeof raw?.maxHistory === 'number' && raw.maxHistory > 0 ? Math.floor(raw.maxHistory) : defaultMaxHistory
  const seen = new Set<string>()
  const items = Array.isArray(raw?.items) ? raw.items.flatMap((item) => {
    const text = cleanText(item?.text ?? '')
    if (!text || seen.has(text)) return []
    seen.add(text)
    const timestamp = item.updatedAt || item.createdAt || now()
    return [{
      text,
      pinned: Boolean(item.pinned),
      createdAt: item.createdAt || timestamp,
      updatedAt: timestamp
    }]
  }) : []
  return {
    version: 1,
    maxHistory,
    items: prune(items, maxHistory)
  }
}

export async function readInputHistoryStoreFile(path: string): Promise<StoredInputHistory> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Partial<StoredInputHistory>
  if (parsed.version !== 1 || !Array.isArray(parsed.items)) {
    throw new Error('Input history has an invalid format.')
  }
  return normalizeInputHistoryStore(parsed)
}

async function readStore(): Promise<StoredInputHistory> {
  try {
    return await readInputHistoryStoreFile(getInputHistoryFile())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, maxHistory: defaultMaxHistory, items: [] }
    }
    throw error
  }
}

async function writeStore(store: StoredInputHistory): Promise<InputHistorySnapshot> {
  const normalized = normalizeInputHistoryStore(store)
  await writeJsonAtomic(getInputHistoryFile(), normalized)
  return {
    maxHistory: normalized.maxHistory,
    items: normalized.items
  }
}

export async function getInputHistory(): Promise<InputHistorySnapshot> {
  const store = await readStore()
  return {
    maxHistory: store.maxHistory,
    items: store.items
  }
}

export async function addInputHistory(text: string): Promise<InputHistorySnapshot> {
  const value = cleanText(text)
  const store = await readStore()
  if (!value) return getInputHistory()

  const existing = store.items.find((item) => item.text === value)
  const timestamp = now()
  if (existing) {
    existing.updatedAt = timestamp
  } else {
    store.items.unshift({
      text: value,
      pinned: false,
      createdAt: timestamp,
      updatedAt: timestamp
    })
  }

  return writeStore(store)
}

export async function removeInputHistory(text: string): Promise<InputHistorySnapshot> {
  const value = cleanText(text)
  const store = await readStore()
  store.items = store.items.filter((item) => item.text !== value)
  return writeStore(store)
}

export async function setInputHistoryPinned(text: string, pinned: boolean): Promise<InputHistorySnapshot> {
  const value = cleanText(text)
  const store = await readStore()
  const existing = store.items.find((item) => item.text === value)
  const timestamp = now()
  if (existing) {
    existing.pinned = pinned
    existing.updatedAt = timestamp
  } else if (value && pinned) {
    store.items.unshift({
      text: value,
      pinned: true,
      createdAt: timestamp,
      updatedAt: timestamp
    })
  }
  return writeStore(store)
}

export async function clearInputHistory(): Promise<InputHistorySnapshot> {
  const store = await readStore()
  store.items = store.items.filter((item) => item.pinned)
  return writeStore(store)
}
