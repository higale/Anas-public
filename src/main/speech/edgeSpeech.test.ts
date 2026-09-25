import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { synthesizeEdgeSpeech } from './edgeSpeech'

const state = vi.hoisted(() => ({ sockets: [] as unknown[] }))
vi.mock('ws', () => ({
  WebSocket: class extends EventEmitter {
    send = vi.fn((_message: string, callback: (error?: Error) => void) => callback())
    terminate = vi.fn()
    constructor(readonly url: string, readonly options: unknown) {
      super()
      state.sockets.push(this)
    }
  }
}))

type Socket = EventEmitter & { send: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn>; url: string }
const request = { text: '你好 <world> & goodbye', voice: 'zh-CN-XiaoxiaoNeural', speed: 1.5 }
function start() {
  const controller = new AbortController()
  const result = synthesizeEdgeSpeech(request, controller.signal)
  const socket = state.sockets.at(-1) as Socket
  return { controller, result, socket }
}
function frame(audio: Buffer, extraHeaders = ''): Buffer {
  const header = Buffer.from(`X-RequestId:test\r\nContent-Type:audio/mpeg\r\n${extraHeaders}Path:audio\r\n`)
  const size = Buffer.alloc(2)
  size.writeUInt16BE(header.length)
  return Buffer.concat([size, header, audio])
}
function end(socket: Socket): void {
  socket.emit('message', Buffer.from('Path:turn.end\r\n\r\n{}'), false)
}
beforeEach(() => { state.sockets = []; vi.useFakeTimers() })
afterEach(() => vi.useRealTimers())

describe('Edge speech transport', () => {
  it('escapes SSML, maps speed, and returns only audio bytes after turn.end', async () => {
    const { socket, result } = start()
    socket.emit('open')
    expect(socket.url).toMatch(/Sec-MS-GEC=[A-F0-9]{64}/)
    const ssml = socket.send.mock.calls[1][0]
    expect(ssml).toContain('rate="+50%"')
    expect(ssml).toContain('你好 &lt;world&gt; &amp; goodbye')
    socket.emit('message', frame(Buffer.from([0xff, 0xfb, 1]), 'X-Other:value\r\n'), true)
    socket.emit('message', frame(Buffer.from([2, 3])), true)
    end(socket)
    expect(await result).toEqual(new Uint8Array([0xff, 0xfb, 1, 2, 3]))
    expect(socket.terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels during connection and tolerates the asynchronous ws error on termination', async () => {
    const { socket, controller, result } = start()
    controller.abort()
    await expect(result).rejects.toMatchObject({ name: 'AbortError' })
    socket.emit('error', new Error('WebSocket was closed before the connection was established'))
    socket.emit('close')
    expect(socket.terminate).toHaveBeenCalledOnce()
    expect(socket.eventNames()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects a pre-cancelled request without connecting', async () => {
    await expect(synthesizeEdgeSpeech(request, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
    expect(state.sockets).toHaveLength(0)
  })

  it('times out the whole request and terminates the socket', async () => {
    const { socket, result } = start()
    const failure = expect(result).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(120000)
    await failure
    expect(socket.terminate).toHaveBeenCalledOnce()
  })

  it.each(['close', 'error'])('rejects %s before completion even after partial audio', async (event) => {
    const { socket, result } = start()
    socket.emit('message', frame(Buffer.from([1])), true)
    socket.emit(event, new Error('connection failed'))
    await expect(result).rejects.toThrow()
    expect(socket.terminate).toHaveBeenCalledOnce()
  })

  it('rejects empty completed audio', async () => {
    const { socket, result } = start()
    end(socket)
    await expect(result).rejects.toThrow('empty audio')
  })

  it.each([Buffer.from([1]), Buffer.from([0, 50, 1]), frame(Buffer.alloc(0))])('rejects malformed binary frames', async (data) => {
    const { socket, result } = start()
    socket.emit('message', data, true)
    await expect(result).rejects.toThrow()
    expect(socket.terminate).toHaveBeenCalledOnce()
  })

  it('bounds accumulated audio', async () => {
    const { socket, result } = start()
    for (let n = 0; n < 9; n++) socket.emit('message', frame(Buffer.alloc(1024 * 1024)), true)
    await expect(result).rejects.toThrow('size limit')
  })

  it('rejects oversized text before opening a socket', async () => {
    await expect(synthesizeEdgeSpeech({ ...request, text: '&'.repeat(8192) }, new AbortController().signal)).rejects.toThrow('too large')
    expect(state.sockets).toHaveLength(0)
  })
})
