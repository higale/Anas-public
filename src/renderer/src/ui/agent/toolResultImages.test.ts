import { ToolMessage } from '@langchain/core/messages'
import { describe, expect, it } from 'vitest'
import { toAgentMessage } from '../../../../main/agent/messageMapper'
import { toolResultImages } from './toolResultImages'

const image = { type: 'image', mimeType: 'image/png', data: 'AA==' }
const src = 'data:image/png;base64,AA=='

describe('tool result images', () => {
  it('keeps every image in return order, including duplicates and more than four images', () => {
    const output = { content: [{ type: 'text', text: 'Screenshot' }, ...Array.from({ length: 6 }, () => image)] }
    const before = JSON.stringify(output)
    expect(toolResultImages(output)).toEqual(Array(6).fill(src))
    expect(JSON.stringify(output)).toBe(before)
  })

  it.each([
    image,
    { type: 'image', source_type: 'base64', mime_type: 'image/png', data: 'AA==' },
    { type: 'image_url', image_url: { url: src } },
    { type: 'image_url', image_url: src },
    { type: 'input_image', image_url: src }
  ])('reads raw and persisted framework image content: $type', (block) => {
    expect(toolResultImages(block)).toEqual([src])
    const native = new ToolMessage({ tool_call_id: 'capture', content: [block] })
    const restored = toAgentMessage(native, 'capture-result')
    expect(toolResultImages(restored.content)).toEqual([src])
  })

  it('reads known content envelopes without treating arbitrary JSON or text as images', () => {
    expect(toolResultImages({ type: 'json', value: { content: [image] } })).toEqual([src])
    for (const output of [null, 'done', JSON.stringify(image), { type: 'text', text: JSON.stringify(image) },
      { metadata: image }, { type: 'image', mimeType: 'image/png' }, { ...image, data: '' }, { ...image, mimeType: 'text/plain' }]) {
      expect(toolResultImages(output)).toEqual([])
    }
  })
})
