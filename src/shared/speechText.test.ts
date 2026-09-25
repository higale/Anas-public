import { describe, expect, it } from 'vitest'
import {
  cleanSpeechText,
  findSpeechCutPosition,
  splitSpeechText
} from './speechText'

const cutOptions = {
  final: false,
  streamSequence: 0,
  streamStartedAt: 0,
  now: 1_000
}

describe('speech text media filtering', () => {
  it('removes complete Markdown images including nested URL parentheses', () => {
    const text = '图片如下：![result](https://example.com/image_(large).png?token=secret) 生成完成。'
    expect(cleanSpeechText(text)).toBe('图片如下： 生成完成。')
  })

  it('removes bare media data, blob, file, and sandbox URLs', () => {
    const text = [
      '开始。',
      `data:image/png;base64,${'A'.repeat(500)}`,
      'blob:https://example.com/id',
      'file:///C:/Temp/result.png',
      'sandbox:/mnt/data/result.png',
      '结束。'
    ].join(' ')
    expect(cleanSpeechText(text)).toBe('开始。 结束。')
  })

  it('never force-cuts inside a long streaming media reference', () => {
    const image = `![result](data:image/png;base64,${'A'.repeat(800)}`
    expect(findSpeechCutPosition(image, cutOptions)).toBe(0)
  })

  it('can emit preceding prose without splitting the following media reference', () => {
    const prose = '图片已经生成完成。'
    const image = `![result](data:image/png;base64,${'A'.repeat(800)}`
    expect(findSpeechCutPosition(`${prose}${image}`, cutOptions)).toBe(prose.length)
  })

  it('does not leave media fragments in completed speech chunks', () => {
    const text = `图片如下。![result](data:image/png;base64,${'A'.repeat(800)}) 请查收。`
    expect(splitSpeechText(text).join(' ')).toBe('图片如下。 请查收。')
  })

  it('keeps supplementary Chinese characters intact at a forced chunk boundary', () => {
    const prefix = '文'.repeat(219)
    expect(splitSpeechText(`${prefix}𠀀结束`)).toEqual([prefix, '𠀀结束'])
  })

  it.each(['>', '+', '-'])('preserves a mid-line %s while still cleaning real line markers', (operator) => {
    const text = ` ${operator} 5。\n> 引用\n- 列表`
    expect(splitSpeechText(text, { startsAtLineBoundary: false })).toEqual([`${operator} 5。 引用。 列表`])
    expect(splitSpeechText(`${operator} 5。`)).toEqual(['5。'])
  })
})
