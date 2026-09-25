export const DEFAULT_SPEECH_REPLY_VOICE = 'zh-CN-XiaoxiaoNeural'
export const DEFAULT_SPEECH_REPLY_SPEED = 1
export const MIN_SPEECH_REPLY_SPEED = 0.25
export const MAX_SPEECH_REPLY_SPEED = 4

const speechStreamMinFirstDelayMs = 500
const speechStreamStrongMinLen = 20
const speechStreamWeakMinLen = 120
const speechStreamForceMinLen = 220

export interface SpeechCutOptions {
  final: boolean
  streamSequence: number
  streamStartedAt: number
  now?: number
}

export function clampSpeechReplySpeed(value: unknown): number {
  const speed = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_SPEECH_REPLY_SPEED
  return Math.min(MAX_SPEECH_REPLY_SPEED, Math.max(MIN_SPEECH_REPLY_SPEED, speed))
}

export function defaultSpeechReplyVoice(value: string | undefined): string {
  const voice = value?.trim()
  return voice || DEFAULT_SPEECH_REPLY_VOICE
}

function isEmojiCodePoint(codePoint: number): boolean {
  return (codePoint >= 0x1f000 && codePoint <= 0x1faff) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf) ||
    codePoint === 0x200d ||
    codePoint === 0x20e3 ||
    codePoint === 0xfe0f
}

function removeEmojiChars(text: string): string {
  let result = ''
  for (const char of text) {
    const codePoint = char.codePointAt(0)
    if (codePoint === undefined || isEmojiCodePoint(codePoint)) continue
    result += char
  }
  return result
}

function isSpeechPauseChar(char: string): boolean {
  return '.!?;:,。！？；：，、'.includes(char)
}

function normalizeSpeechWhitespace(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  let result = ''
  for (const rawLine of lines) {
    const line = rawLine.replace(/[ \t]+/g, ' ').trim()
    if (!line) continue
    if (result) {
      if (!isSpeechPauseChar(result[result.length - 1])) result += '。'
      result += ' '
    }
    result += line
  }
  return result.replace(/[ \t]+/g, ' ').trim()
}

interface TextSpan {
  start: number
  end: number
}

function markdownImageSpans(text: string): TextSpan[] {
  const spans: TextSpan[] = []
  let searchFrom = 0
  while (searchFrom < text.length) {
    const start = text.indexOf('![', searchFrom)
    if (start < 0) break
    const labelEnd = text.indexOf(']', start + 2)
    if (labelEnd < 0 || text[labelEnd + 1] !== '(') {
      searchFrom = start + 2
      continue
    }
    let depth = 1
    let cursor = labelEnd + 2
    while (cursor < text.length && depth > 0) {
      if (text[cursor] === '\\') {
        cursor += 2
        continue
      }
      if (text[cursor] === '(') depth += 1
      if (text[cursor] === ')') depth -= 1
      cursor += 1
    }
    spans.push({ start, end: depth === 0 ? cursor : text.length })
    searchFrom = Math.max(cursor, start + 2)
  }
  return spans
}

function urlSpans(text: string): TextSpan[] {
  const spans: TextSpan[] = []
  const pattern = /(?:https?:\/\/|data:(?:image|audio|video)\/|blob:|file:\/\/|sandbox:\/)/gi
  let match = pattern.exec(text)
  while (match) {
    let end = match.index + match[0].length
    while (end < text.length && !/[\s<>"']/.test(text[end])) end += 1
    spans.push({ start: match.index, end })
    pattern.lastIndex = Math.max(end, match.index + match[0].length)
    match = pattern.exec(text)
  }
  return spans
}

function htmlTagSpans(text: string): TextSpan[] {
  const spans: TextSpan[] = []
  let searchFrom = 0
  while (searchFrom < text.length) {
    const start = text.indexOf('<', searchFrom)
    if (start < 0) break
    const close = text.indexOf('>', start + 1)
    const fragment = text.slice(start, close < 0 ? text.length : close + 1)
    const completeTag = close >= 0 && /^<\/?[a-zA-Z][^>]*>$/.test(fragment)
    const incompleteMediaTag = close < 0
      && /^<\/?(?:img|video|audio|source|picture)\b/i.test(fragment)
    if (completeTag || incompleteMediaTag) {
      spans.push({ start, end: close < 0 ? text.length : close + 1 })
    }
    searchFrom = close < 0 ? text.length : close + 1
  }
  return spans
}

function nonSpeechSpans(text: string): TextSpan[] {
  return [...markdownImageSpans(text), ...urlSpans(text), ...htmlTagSpans(text)]
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .reduce<TextSpan[]>((merged, span) => {
      const previous = merged.at(-1)
      if (!previous || span.start > previous.end) {
        merged.push({ ...span })
      } else {
        previous.end = Math.max(previous.end, span.end)
      }
      return merged
    }, [])
}

function removeSpans(text: string, spans: TextSpan[]): string {
  let result = ''
  let cursor = 0
  for (const span of spans) {
    result += text.slice(cursor, span.start)
    result += ' '
    cursor = span.end
  }
  return result + text.slice(cursor)
}

export interface SpeechTextContext {
  /** False when a streaming cut starts in the middle of an existing line. */
  startsAtLineBoundary?: boolean
}

export function cleanSpeechText(text: string, context: SpeechTextContext = {}): string {
  const removeLineMarker = (marker: string, offset: number): string =>
    offset === 0 && context.startsAtLineBoundary === false ? marker : ''
  let result = removeEmojiChars(text)
  result = result.replace(/```[\s\S]*?```/g, ' ')
  result = result.replace(/```[\s\S]*$/g, ' ')
  result = result.replace(/`[^`]*`/g, ' ')
  result = removeSpans(result, nonSpeechSpans(result))
  result = result.replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
  result = result.replace(/^[ \t]*#{1,6}[ \t]*/gm, removeLineMarker)
  result = result.replace(/^[ \t]*[-*+]\s+/gm, removeLineMarker)
  result = result.replace(/^[ \t]*>\s?/gm, removeLineMarker)
  result = result.replace(/[*_#()[\]]/g, ' ')
  return normalizeSpeechWhitespace(result)
}

export function hasUnclosedCodeFence(text: string): boolean {
  let count = 0
  let index = text.indexOf('```')
  while (index >= 0) {
    count += 1
    index = text.indexOf('```', index + 3)
  }
  return count % 2 === 1
}

export function findSpeechCutPosition(text: string, options: SpeechCutOptions): number {
  if (!text.trim()) return 0
  if (options.final) return text.length
  if (hasUnclosedCodeFence(text)) return 0
  if (options.streamSequence === 0 && (options.now ?? Date.now()) - options.streamStartedAt < speechStreamMinFirstDelayMs) return 0

  const protectedSpans = nonSpeechSpans(text)
  let spanIndex = 0
  const protectedAt = (index: number): TextSpan | undefined => {
    while (spanIndex < protectedSpans.length && protectedSpans[spanIndex].end <= index) {
      spanIndex += 1
    }
    const span = protectedSpans[spanIndex]
    return span && span.start <= index && index < span.end ? span : undefined
  }

  let strongPos = 0
  let weakPos = 0
  for (let index = 0; index < text.length; index += 1) {
    const protectedSpan = protectedAt(index)
    if (protectedSpan) {
      index = protectedSpan.end - 1
      continue
    }
    const current = text[index]
    const next = text[index + 1]
    const position = index + 1
    if (current === '\n' && next === '\n') {
      strongPos = position + 1
    } else if ('.!?;。！？；'.includes(current)) {
      strongPos = position
    } else if (',:，、：'.includes(current)) {
      weakPos = position
    }
  }

  if (strongPos >= speechStreamStrongMinLen) return strongPos
  if (weakPos >= speechStreamWeakMinLen) return weakPos
  if (text.length >= speechStreamForceMinLen) {
    const forceIndex = speechStreamForceMinLen - 1
    const containingSpan = protectedSpans.find((span) =>
      span.start <= forceIndex && forceIndex < span.end
    )
    if (!containingSpan) return speechStreamForceMinLen
    return text.slice(0, containingSpan.start).trim().length > 0
      ? containingSpan.start
      : 0
  }
  return 0
}

export function splitSpeechText(text: string, context: SpeechTextContext = {}): string[] {
  let remaining = cleanSpeechText(text, context)
  const chunks: string[] = []

  while (remaining) {
    let cutPosition = findCompleteSpeechCutPosition(remaining)
    // Keep supplementary characters intact when the length limit cuts a word.
    const previous = remaining.charCodeAt(cutPosition - 1)
    const next = remaining.charCodeAt(cutPosition)
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) cutPosition -= 1
    const chunk = remaining.slice(0, cutPosition).trim()
    remaining = remaining.slice(cutPosition).trimStart()
    if (chunk) chunks.push(chunk)
  }

  return chunks
}

function findCompleteSpeechCutPosition(text: string): number {
  if (text.length <= speechStreamForceMinLen) return text.length

  let weakPos = 0
  for (let index = 0; index < Math.min(text.length, speechStreamForceMinLen); index += 1) {
    const current = text[index]
    const next = text[index + 1]
    const position = index + 1
    if (current === '\n' && next === '\n' && position + 1 >= speechStreamStrongMinLen) return position + 1
    if ('.!?;。！？；'.includes(current) && position >= speechStreamStrongMinLen) return position
    if (!weakPos && ',:，、：'.includes(current) && position >= speechStreamWeakMinLen) weakPos = position
  }

  return weakPos || speechStreamForceMinLen
}
