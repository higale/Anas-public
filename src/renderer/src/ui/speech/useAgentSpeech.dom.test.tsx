import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeechGenerateRequest } from '@shared/types'
import type { AgentRuntimeEvent } from '@shared/agentTypes'
import { useAgentSpeech } from './useAgentSpeech'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const config = { enabled: true, voice: 'zh-CN-XiaoxiaoNeural', speed: 1 }
const pending: Array<{ request: SpeechGenerateRequest; resolve: (audio: Uint8Array) => void; reject: (error: Error) => void }> = []
const audioPlayers: FakeAudio[] = []
class FakeAudio extends EventTarget {
  preload = ''
  volume = 1
  error = undefined
  pause = vi.fn()
  play = vi.fn(async () => {})
  load = vi.fn()
  constructor(public src: string) { super(); audioPlayers.push(this) }
  removeAttribute(): void { this.src = '' }
}
const generate = vi.fn((request: SpeechGenerateRequest) => new Promise<Uint8Array>((resolve, reject) => {
  pending.push({ request, resolve, reject })
}))
const cancel = vi.fn(async (_requestId: string) => {})
const revoke = vi.fn()
beforeEach(() => {
  pending.length = 0
  audioPlayers.length = 0
  vi.stubGlobal('Audio', FakeAudio)
  Object.defineProperty(window, 'gale', { configurable: true, value: { speech: { generate, cancel, logWarning: vi.fn(async () => {}) } } })
  let counter = 0
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => `blob:audio-${++counter}`), revokeObjectURL: revoke })
})
afterEach(() => vi.unstubAllGlobals())
async function complete(index: number): Promise<void> {
  await act(async () => pending[index].resolve(new Uint8Array([0xff, 0xfb, index])))
}

function startCandidate(handleEvent: (event: AgentRuntimeEvent) => void, startedAt: number) {
  const run = { id: 'run', threadId: 'thread-1', operation: 'agent' as const, status: 'running' as const, createdAt: '', updatedAt: '' }
  const model = { id: 'model', sequence: 1, status: 'running' as const, text: '', reasoning: '', toolCallIds: [], startedAt: new Date(startedAt).toISOString() }
  handleEvent({ type: 'run_started', run, newUserTurn: true, userMessage: { id: 'input', role: 'user', content: [{ type: 'text', text: 'Hello' }] } })
  handleEvent({ type: 'model_started', runId: 'run', threadId: 'thread-1', model })
  return {
    delta: (text: string) => handleEvent({ type: 'model_delta', runId: 'run', threadId: 'thread-1', modelId: 'model', delta: { type: 'text', text } }),
    complete: (text: string) => handleEvent({ type: 'model_completed', runId: 'run', threadId: 'thread-1', model: { ...model, status: 'completed', text } })
  }
}

async function drainPlayback(): Promise<void> {
  for (let index = 0; index < pending.length; index += 1) {
    await complete(index)
    // Every generated chunk must become playable, even across candidate cuts.
    expect(audioPlayers).toHaveLength(index + 1)
    await act(async () => audioPlayers[index].dispatchEvent(new Event('ended')))
  }
}

describe('speech generation and playback', () => {
  it('serializes generation and bounds prefetched audio while preserving playback order', async () => {
    const { result, unmount } = renderHook(() => useAgentSpeech(config, 'thread-1'))
    await act(async () => result.current.playText('message', 'a'.repeat(1100)))
    expect(pending).toHaveLength(1)
    await complete(0)
    expect(audioPlayers).toHaveLength(1)
    expect(pending).toHaveLength(2)
    await complete(1)
    await complete(2)
    expect(pending).toHaveLength(3)
    await act(async () => audioPlayers[0].dispatchEvent(new Event('ended')))
    expect(revoke).toHaveBeenCalledWith('blob:audio-1')
    expect(audioPlayers[1].src).toBe('blob:audio-2')
    expect(pending).toHaveLength(4)
    unmount()
    expect(cancel).toHaveBeenCalledWith(pending[3].request.requestId)
    expect(revoke).toHaveBeenCalledWith('blob:audio-2')
    expect(revoke).toHaveBeenCalledWith('blob:audio-3')
  })

  it('stops active synthesis, discards late audio, and can start a new playback', async () => {
    const { result } = renderHook(() => useAgentSpeech(config, 'thread-1'))
    await act(async () => result.current.playText('first', 'First sentence.'))
    act(() => result.current.stop())
    expect(cancel).toHaveBeenCalledWith(pending[0].request.requestId)
    await act(async () => result.current.playText('second', 'Second sentence.'))
    await complete(0)
    expect(audioPlayers).toHaveLength(0)
    await complete(1)
    expect(audioPlayers).toHaveLength(1)
    expect(result.current.state).toMatchObject({ status: 'playing', messageId: 'second' })
  })

  it('cancels synthesis on thread switch', async () => {
    const { result, rerender } = renderHook(({ thread }) => useAgentSpeech(config, thread), { initialProps: { thread: 'one' } })
    await act(async () => result.current.playText('message', 'Hello.'))
    rerender({ thread: 'two' })
    expect(cancel).toHaveBeenCalledWith(pending[0].request.requestId)
    await complete(0)
    expect(audioPlayers).toHaveLength(0)
    expect(result.current.state.status).toBe('idle')
  })

  it('continues to the next chunk after synthesis failure', async () => {
    const { result } = renderHook(() => useAgentSpeech(config, 'thread-1'))
    await act(async () => result.current.playText('message', 'a'.repeat(440)))
    await act(async () => pending[0].reject(new Error('Disconnected')))
    expect(pending).toHaveLength(2)
    await complete(1)
    expect(result.current.state.status).toBe('playing')
  })

  it('retains cleaning and waits for short streaming text to complete', async () => {
    const { result } = renderHook(() => useAgentSpeech(config, 'thread-1'))
    const run = { id: 'run', threadId: 'thread-1', operation: 'agent' as const, status: 'running' as const, createdAt: '', updatedAt: '' }
    const model = { id: 'model', sequence: 1, status: 'running' as const, text: '', reasoning: '', toolCallIds: [] }
    const text = '**你好** ![图片](https://example.com/image.png) 😀'
    await act(async () => {
      result.current.handleEvent({ type: 'run_started', run, newUserTurn: true, userMessage: { id: 'input', role: 'user', content: [{ type: 'text', text: 'Hello' }] } })
      result.current.handleEvent({ type: 'model_started', runId: 'run', threadId: 'thread-1', model })
      result.current.handleEvent({ type: 'model_delta', runId: 'run', threadId: 'thread-1', modelId: 'model', delta: { type: 'text', text } })
    })
    expect(pending).toHaveLength(0)
    await act(async () => result.current.handleEvent({ type: 'model_completed', runId: 'run', threadId: 'thread-1', model: { ...model, status: 'completed', text } }))
    expect(pending).toHaveLength(1)
    expect(pending[0].request.text).toBe('你好')
  })

  it.each(['completion only', 'buffered delta', 'large punctuated delta'] as const)('splits a long %s into playable requests without dropping text', async (mode) => {
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    const { result } = renderHook(() => useAgentSpeech(config, 'thread-1'))
    const text = `${'甲'.repeat(219)}𠀀${'乙'.repeat(9000)}。`
    await act(async () => {
      const candidate = startCandidate(result.current.handleEvent, mode === 'large punctuated delta' ? 0 : 1000)
      if (mode !== 'completion only') candidate.delta(text)
      if (mode !== 'large punctuated delta') candidate.complete(text)
    })
    expect(pending).toHaveLength(1)
    await drainPlayback()
    expect(pending.length).toBeGreaterThan(1)
    expect(pending.every(({ request }) => request.text.length <= 8192)).toBe(true)
    expect(pending.every(({ request }) => Array.from(request.text).every((char) => {
      const code = char.codePointAt(0)!
      return code < 0xd800 || code > 0xdfff
    }))).toBe(true)
    expect(pending.map(({ request }) => request.text).join('')).toBe(text)
    expect(result.current.state.status).toBe('idle')
  })

  it('keeps continuous playback order across empty, split, and later streamed candidates', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    const { result } = renderHook(() => useAgentSpeech(config, 'thread-1'))
    const empty = `![image](data:image/png;base64,${'A'.repeat(9000)})\n\n`
    const first = `${'甲'.repeat(9000)}。`
    const later = `${'乙'.repeat(400)}。`
    const tail = '结束'
    let candidate!: ReturnType<typeof startCandidate>
    await act(async () => {
      candidate = startCandidate(result.current.handleEvent, 0)
      candidate.delta(empty)
    })
    expect(pending).toHaveLength(0)
    await act(async () => candidate.delta(first))
    // Fill the prefetch slots before more deltas arrive.
    await complete(0)
    await complete(1)
    await complete(2)
    expect(pending).toHaveLength(3)
    await act(async () => {
      candidate.delta(later)
      candidate.complete(`${empty}${first}${later}${tail}`)
    })
    expect(pending).toHaveLength(3)
    for (let index = 0; index < pending.length; index += 1) {
      if (index >= 3) await complete(index)
      expect(audioPlayers).toHaveLength(index + 1)
      await act(async () => audioPlayers[index].dispatchEvent(new Event('ended')))
    }
    expect(pending.map(({ request }) => request.text).join('')).toBe(`${first}${later}${tail}`)
    expect(result.current.state.status).toBe('idle')
  })

  describe.each(['manual', 'completion', 'delta', 'forced delta'] as const)('%s text preparation', (mode) => {
    it.each(['>', '+', '-'])('cleans Markdown before splitting and preserves a boundary %s operator', async (operator) => {
      vi.spyOn(Date, 'now').mockReturnValue(1000)
      const { result } = renderHook(() => useAgentSpeech(config, 'thread-1'))
      const prefix = `${'甲'.repeat(219)}x`
      const suffix = `${operator} 5${mode === 'forced delta' ? '' : '。'}`
      const source = mode === 'forced delta' ? `${prefix} ${suffix}` : `**${prefix}** ${suffix}`
      await act(async () => {
        if (mode === 'manual') result.current.playText('message', source)
        else {
          const candidate = startCandidate(result.current.handleEvent, mode === 'completion' ? 1000 : 0)
          if (mode === 'delta' || mode === 'forced delta') candidate.delta(source)
          else candidate.complete(source)
          if (mode === 'forced delta') candidate.complete(source)
        }
      })
      await drainPlayback()
      expect(pending.map(({ request }) => request.text)).toEqual([prefix, suffix])
      expect(result.current.state.status).toBe('idle')
    })
  })

  it('recognizes genuine line markers after a streaming cut and resets context for the next candidate', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    const { result } = renderHook(() => useAgentSpeech(config, 'thread-1'))
    const prefix = '甲'.repeat(220)
    await act(async () => {
      const candidate = startCandidate(result.current.handleEvent, 0)
      candidate.delta(prefix)
      candidate.complete(`${prefix}\n> 引用\n+ 列表`)
    })
    await drainPlayback()
    expect(pending.map(({ request }) => request.text)).toEqual([prefix, '引用。 列表'])
    const previousRequests = pending.length
    await act(async () => startCandidate(result.current.handleEvent, 1000).complete('> 新引用'))
    expect(pending[previousRequests].request.text).toBe('新引用')
  })
})
