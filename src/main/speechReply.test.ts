import { describe, expect, it, vi } from 'vitest'
import { generateSpeech } from './speechReply'
import { synthesizeEdgeSpeech } from './speech/edgeSpeech'

vi.mock('./config/dataDir', () => ({ getDataDir: vi.fn() }))
vi.mock('./runtimeLogger', () => ({ runtimeLog: vi.fn() }))
vi.mock('./speech/edgeSpeech', () => ({ synthesizeEdgeSpeech: vi.fn(async () => new Uint8Array([1, 2, 3])) }))
const request = { requestId: 'request-1', voice: 'zh-CN-XiaoxiaoNeural', speed: 1 }

describe('speech synthesis plain text boundary', () => {
  it.each(['> 5。', '+ 5。', '- 5。'])('preserves the leading operator in %s', async (text) => {
    const signal = new AbortController().signal
    expect(await generateSpeech({ ...request, text }, signal)).toEqual(new Uint8Array([1, 2, 3]))
    expect(synthesizeEdgeSpeech).toHaveBeenCalledWith({ text, voice: request.voice, speed: request.speed }, signal)
  })

  it.each(['', ' \n\t', '文'.repeat(8193)])('rejects empty or oversized chunks before synthesis', async (text) => {
    await expect(generateSpeech({ ...request, text }, new AbortController().signal)).rejects.toThrow()
    expect(synthesizeEdgeSpeech).not.toHaveBeenCalled()
  })

  it('still rejects cancelled requests before synthesis', async () => {
    await expect(generateSpeech({ ...request, text: '+ 5。' }, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
    expect(synthesizeEdgeSpeech).not.toHaveBeenCalled()
  })
})
