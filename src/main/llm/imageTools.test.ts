import { mkdtemp, rm, writeFile, truncate } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createImageTools } from './imageTools'
import type { StructuredToolInterface } from '@langchain/core/tools'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64')
let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'anas-image-tools-'))
  await writeFile(join(root, '图.png'), png)
})
afterEach(() => rm(root, { recursive: true, force: true }))
const invoke = async (name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
  const tool: StructuredToolInterface = createImageTools({ primaryFolder: root, signal }).find((tool) => tool.name === name)!
  return await tool.invoke({ type: 'tool_call', id: 'image-call', name, args })
}

it('returns original image blocks, with labels and per-file errors in input order', async () => {
  await writeFile(join(root, 'text.txt'), 'not an image')
  const result = await invoke('view_multiple_images', { paths: ['missing.png', '图.png', 'text.txt', '图.png'] })
  expect(result.content.map((block: any) => block.type)).toEqual(['text', 'text', 'image', 'text', 'text', 'image'])
  expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: false, path: join(root, 'missing.png') })
  expect(JSON.parse(result.content[1].text)).toEqual({ ok: true, path: join(root, '图.png'), mimeType: 'image/png' })
  expect(result.content[2]).toEqual({ type: 'image', mimeType: 'image/png', data: png.toString('base64') })
  expect(JSON.parse(result.content[3].text)).toMatchObject({ ok: false })
})

it('identifies WebP from content and passes it through without local decoding', async () => {
  await writeFile(join(root, 'image.bin'), webp)
  const result = await invoke('view_image', { path: 'image.bin' })
  expect(result.content[1]).toEqual({ type: 'image', mimeType: 'image/webp', data: webp.toString('base64') })
})

it('rejects empty, excessive and non-file input and invalid batch sizes', async () => {
  await writeFile(join(root, 'empty.png'), '')
  await writeFile(join(root, 'large.png'), png)
  await truncate(join(root, 'large.png'), 8 * 1024 * 1024 + 1)
  for (const path of ['empty.png', 'large.png', '.']) {
    const result = await invoke('view_image', { path })
    expect(result.content).toHaveLength(1)
    expect(JSON.parse(result.content[0].text)).toMatchObject({ ok: false })
  }
  await expect(invoke('view_multiple_images', { paths: [] })).rejects.toThrow()
  await expect(invoke('view_multiple_images', { paths: Array(11).fill('图.png') })).rejects.toThrow()
})

it('observes cancellation instead of converting it to a per-file error', async () => {
  const controller = new AbortController()
  controller.abort(new Error('stop images'))
  await expect(invoke('view_multiple_images', { paths: ['图.png'] }, controller.signal)).rejects.toThrow('stop images')
})

it('enforces the batch output budget without discarding earlier images', async () => {
  await truncate(join(root, '图.png'), 8 * 1024 * 1024)
  const result = await invoke('view_multiple_images', { paths: ['图.png', '图.png', '图.png'] })
  expect(result.content.filter((block: any) => block.type === 'image')).toHaveLength(2)
  expect(JSON.parse(result.content.at(-1).text).error).toContain('16 MiB')
})
