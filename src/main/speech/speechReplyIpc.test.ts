import { EventEmitter } from 'node:events'
import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleMainIpc } from '../ipcSecurity'
import { generateSpeech } from '../speechReply'
import { registerSpeechReplyIpc } from './speechReplyIpc'

vi.mock('../ipcSecurity', () => ({ handleMainIpc: vi.fn() }))
vi.mock('../speechReply', () => ({ generateSpeech: vi.fn(), loadSpeechVoices: vi.fn() }))
const request = { requestId: 'request-1', text: 'Hello', voice: 'en-US-AriaNeural', speed: 1 }
function invoke(channel: string, sender: EventEmitter, arg: unknown): Promise<unknown> {
  const handler = vi.mocked(handleMainIpc).mock.calls.find(([name]) => name === channel)![1]
  return Promise.resolve(handler({ sender } as unknown as IpcMainInvokeEvent, arg))
}
beforeEach(() => {
  registerSpeechReplyIpc()
  vi.mocked(generateSpeech).mockImplementation((_request, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')), { once: true })
  }))
})
describe('speech IPC request lifetime', () => {
  it('returns binary audio and releases the completed request ID', async () => {
    const owner = new EventEmitter()
    vi.mocked(generateSpeech).mockResolvedValue(new Uint8Array([1, 2, 3]))
    expect(await invoke('speech:generate', owner, request)).toEqual(new Uint8Array([1, 2, 3]))
    expect(await invoke('speech:generate', owner, request)).toEqual(new Uint8Array([1, 2, 3]))
  })
  it('only cancels a request belonging to the caller', async () => {
    const owner = new EventEmitter()
    const result = invoke('speech:generate', owner, request)
    const failure = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    await invoke('speech:cancel', new EventEmitter(), request.requestId)
    expect(vi.mocked(generateSpeech).mock.calls[0][1].aborted).toBe(false)
    await invoke('speech:cancel', owner, request.requestId)
    await failure
  })
  it.each(['destroyed', 'render-process-gone', 'did-start-navigation'])('cancels on %s', async (event) => {
    const owner = new EventEmitter()
    const failure = expect(invoke('speech:generate', owner, request)).rejects.toMatchObject({ name: 'AbortError' })
    owner.emit(event, {}, 'file:///index.html', false, true)
    await failure
  })
  it('keeps same-document navigation alive and rejects duplicate or excess requests', async () => {
    const owner = new EventEmitter()
    const jobs = Array.from({ length: 4 }, (_, n) => invoke('speech:generate', owner, { ...request, requestId: `request-${n}` }))
    const settled = Promise.allSettled(jobs)
    owner.emit('did-start-navigation', {}, 'file:///index.html#settings', true, true)
    expect(vi.mocked(generateSpeech).mock.calls.every(([, signal]) => !signal.aborted)).toBe(true)
    await expect(invoke('speech:generate', owner, request)).rejects.toThrow('already exists')
    await expect(invoke('speech:generate', owner, { ...request, requestId: 'extra' })).rejects.toThrow('Too many')
    owner.emit('destroyed')
    expect((await settled).every((job) => job.status === 'rejected')).toBe(true)
  })
})
