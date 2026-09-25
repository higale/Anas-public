import { createHash, randomUUID } from 'node:crypto'
import { WebSocket, type RawData } from 'ws'

// Edge Read Aloud wire protocol, also implemented by SchneeHertz/node-edge-tts.
const clientToken = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'
const browserVersion = '143.0.3650.75'
const endpoint = 'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1'
const maxAudioBytes = 8 * 1024 * 1024

export interface EdgeSpeechRequest {
  text: string
  voice: string
  speed: number
}

function escapeXml(value: string): string {
  const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
  return Array.from(value, (char) => {
    const code = char.codePointAt(0)!
    if ((code < 32 && ![9, 10, 13].includes(code)) || (code >= 0xd800 && code <= 0xdfff) || code >= 0xfffe && code <= 0xffff) return ' '
    return entities[char] ?? char
  }).join('')
}

function requestUrl(): string {
  const ticks = (BigInt(Math.floor(Date.now() / 1000)) + 11644473600n) * 10000000n
  const roundedTicks = ticks - ticks % 3000000000n
  const hash = createHash('sha256').update(`${roundedTicks}${clientToken}`).digest('hex').toUpperCase()
  const params = new URLSearchParams({
    TrustedClientToken: clientToken,
    ConnectionId: randomUUID().replaceAll('-', ''),
    'Sec-MS-GEC': hash,
    'Sec-MS-GEC-Version': `1-${browserVersion}`
  })
  return `${endpoint}?${params}`
}

function headers(text: string): Map<string, string> {
  return new Map(text.split('\r\n').filter(Boolean).map((line) => {
    const colon = line.indexOf(':')
    if (colon < 1) throw new Error('Invalid Edge speech frame header.')
    return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()]
  }))
}

function asBuffer(data: RawData): Buffer {
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data)
}

export async function synthesizeEdgeSpeech(request: EdgeSpeechRequest, signal: AbortSignal): Promise<Uint8Array> {
  signal.throwIfAborted()
  const rate = Math.round((request.speed - 1) * 100)
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${escapeXml(request.voice)}"><prosody rate="${rate >= 0 ? '+' : ''}${rate}%" pitch="+0Hz" volume="+0%">${escapeXml(request.text)}</prosody></voice></speak>`
  if (Buffer.byteLength(ssml) > 32 * 1024) throw new Error('Speech chunk is too large.')

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(requestUrl(), {
      handshakeTimeout: 10000,
      maxPayload: 1024 * 1024,
      perMessageDeflate: false,
      origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      headers: {
        'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${browserVersion.split('.')[0]}.0.0.0 Safari/537.36 Edg/${browserVersion.split('.')[0]}.0.0.0`
      }
    })
    let settled = false
    let bytes = 0
    const chunks: Buffer[] = []
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', abort)
      // Terminate even during the handshake. Keep the error listener until close:
      // ws emits an asynchronous error when a connecting socket is terminated.
      socket.terminate()
      if (error) reject(error)
      else resolve(new Uint8Array(Buffer.concat(chunks, bytes)))
      chunks.length = 0
    }
    const abort = (): void => finish(new DOMException('Speech synthesis cancelled.', 'AbortError'))
    const timeout = setTimeout(() => finish(new Error('Edge speech synthesis timed out.')), 120000)
    signal.addEventListener('abort', abort, { once: true })
    socket.on('error', (error) => finish(error))
    socket.on('close', () => {
      finish(new Error('Edge speech connection closed before audio completed.'))
      socket.removeAllListeners()
    })
    socket.on('open', () => {
      if (settled) return
      const config = { context: { synthesis: { audio: {
        metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
        outputFormat: 'audio-24khz-48kbitrate-mono-mp3'
      } } } }
      const send = (message: string): void => socket.send(message, (error) => { if (error) finish(error) })
      send(`Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${JSON.stringify(config)}`)
      send(`X-RequestId:${randomUUID().replaceAll('-', '')}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n${ssml}`)
    })
    socket.on('message', (raw, binary) => {
      if (settled) return
      try {
        const data = asBuffer(raw)
        if (binary) {
          if (data.length < 2) throw new Error('Missing Edge speech frame header.')
          const start = 2 + data.readUInt16BE(0)
          if (start > data.length) throw new Error('Truncated Edge speech frame.')
          const fields = headers(data.subarray(2, start).toString('utf8'))
          if (fields.get('path') !== 'audio') throw new Error('Unexpected Edge speech binary frame.')
          const contentType = fields.get('content-type')
          const audio = data.subarray(start)
          if (!contentType && audio.length === 0) return
          if (contentType !== 'audio/mpeg' || audio.length === 0) throw new Error('Invalid Edge speech audio frame.')
          bytes += audio.length
          if (bytes > maxAudioBytes) throw new Error('Edge speech audio exceeded the size limit.')
          chunks.push(audio)
        } else {
          const text = data.toString('utf8')
          const separator = text.indexOf('\r\n\r\n')
          if (separator < 0) throw new Error('Invalid Edge speech text frame.')
          const path = headers(text.slice(0, separator)).get('path')
          if (path === 'turn.end') finish(bytes ? undefined : new Error('Edge speech returned empty audio.'))
          else if (!['turn.start', 'response', 'audio.metadata'].includes(path ?? '')) throw new Error('Unexpected Edge speech response.')
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)))
      }
    })
    if (signal.aborted) abort()
  })
}
