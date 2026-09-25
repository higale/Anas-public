import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const storePaths = vi.hoisted(() => ({
  inputHistoryFile: ''
}))

vi.mock('./config/dataDir', () => ({
  getInputHistoryFile: () => storePaths.inputHistoryFile
}))

let tempDir = ''

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'anas-input-history-'))
  storePaths.inputHistoryFile = join(tempDir, 'input_history.json')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('input history store', () => {
  it('treats a missing file as an empty first-run store', async () => {
    const { getInputHistory } = await import('./inputHistoryStore')

    await expect(getInputHistory()).resolves.toEqual({
      maxHistory: 100,
      items: []
    })
  })

  it('persists the first entry atomically after an empty first run', async () => {
    const { addInputHistory } = await import('./inputHistoryStore')

    const snapshot = await addInputHistory('  first prompt  ')
    const stored = JSON.parse(await readFile(storePaths.inputHistoryFile, 'utf8'))

    expect(snapshot.items).toHaveLength(1)
    expect(snapshot.items[0]).toMatchObject({ text: 'first prompt', pinned: false })
    expect(stored).toEqual({
      version: 1,
      maxHistory: 100,
      items: snapshot.items
    })
  })

  it('does not hide malformed persisted history as a first-run state', async () => {
    const { getInputHistory } = await import('./inputHistoryStore')
    await writeFile(storePaths.inputHistoryFile, '{"version":2,"items":[]}', 'utf8')

    await expect(getInputHistory()).rejects.toThrow('invalid format')
  })

  it('normalizes, deduplicates, orders, and prunes persisted entries', async () => {
    const { normalizeInputHistoryStore } = await import('./inputHistoryStore')
    const normalized = normalizeInputHistoryStore({
      maxHistory: 2,
      items: [
        { text: ' newer ', pinned: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-03T00:00:00.000Z' },
        { text: 'pinned', pinned: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        { text: 'older', pinned: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
        { text: 'newer', pinned: true, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-04T00:00:00.000Z' },
        { text: 'pruned', pinned: false, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
        { text: '   ', pinned: false, createdAt: '', updatedAt: '' }
      ]
    })

    expect(normalized.items.map((item) => item.text)).toEqual(['pinned', 'newer', 'older'])

    const defaulted = normalizeInputHistoryStore({
      maxHistory: 0,
      items: [{ text: 'timestamped now', pinned: false, createdAt: '', updatedAt: '' }]
    })
    expect(defaulted.maxHistory).toBe(100)
    expect(defaulted.items[0]?.createdAt).toBe(defaulted.items[0]?.updatedAt)
  })

  it('updates, pins, removes, and clears only unpinned entries', async () => {
    const {
      addInputHistory,
      clearInputHistory,
      getInputHistory,
      removeInputHistory,
      setInputHistoryPinned
    } = await import('./inputHistoryStore')

    await addInputHistory('alpha')
    await addInputHistory('beta')
    await addInputHistory('alpha')
    await expect(addInputHistory('   ')).resolves.toMatchObject({ items: expect.any(Array) })
    await setInputHistoryPinned('alpha', true)
    await setInputHistoryPinned('new pinned', true)
    await setInputHistoryPinned('missing', false)
    await removeInputHistory('beta')

    expect((await getInputHistory()).items.map((item) => [item.text, item.pinned])).toEqual([
      ['new pinned', true],
      ['alpha', true]
    ])
    await addInputHistory('history')
    await setInputHistoryPinned('kept', true)
    expect((await clearInputHistory()).items.map((item) => item.text)).toEqual([
      'kept',
      'new pinned',
      'alpha'
    ])
  })
})
