import { copyFile, mkdtemp, open, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileContentInfo } from './fileMetadata'
import { createFileTools } from './llm/fileTools'

const fixtures = join(import.meta.dirname, 'testFixtures/media')
let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'anas-metadata-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
async function info(path: string, signal?: AbortSignal) {
  return JSON.parse(await createFileTools({ primaryFolder: root, maxReadBytes: 1, toolNames: ['get_file_info'], signal })[0].invoke({ path }))
}
async function inspect(path: string, options: Parameters<typeof readFileContentInfo>[3] = {}) {
  const file = await open(path, 'r')
  try { return await readFileContentInfo(file, await file.stat(), path, options) }
  finally { await file.close() }
}

describe('automatic file metadata', () => {
  it('reads displayed JPEG dimensions and orientation from bytes, independent of the extension', async () => {
    const path = join(root, 'renamed.data')
    await copyFile(join(fixtures, 'rotated.jpg'), path)
    const result = await info(path)
    expect(result).toMatchObject({ ok: true, type: 'file', media: {
      kind: 'image', format: 'JPEG', width: 32, height: 64, storedWidth: 64, storedHeight: 32, orientation: 6, hasAlpha: false
    } })
    expect(result).not.toHaveProperty('lineCount')
    expect(result).not.toHaveProperty('metadataError')
  })

  it('reads an alpha channel without decoding image pixels', async () => {
    expect(await info(join(fixtures, 'rgba.png'))).toMatchObject({ media: { kind: 'image', width: 64, height: 32, hasAlpha: true } })
  })

  it.each(['rotated.avif', 'rotated-exif.avif'])('uses AVIF container rotation without applying EXIF twice: %s', async name => {
    const result = await info(join(fixtures, name))
    expect(result).toMatchObject({ media: {
      kind: 'image', format: 'avif', width: 32, height: 64,
      storedWidth: 64, storedHeight: 32, rotationDegrees: -90
    } })
    if (name === 'rotated-exif.avif') expect(result.media.orientation).toBe(6)
    else expect(result.media).not.toHaveProperty('orientation')
    expect(result).not.toHaveProperty('metadataError')
  })

  it('honors zero container rotation even when AVIF EXIF describes a rotated source', async () => {
    const result = await info(join(fixtures, 'unrotated-exif.avif'))
    expect(result).toMatchObject({ media: {
      kind: 'image', width: 64, height: 32, rotationDegrees: 0, orientation: 6
    } })
    expect(result.media).not.toHaveProperty('storedWidth')
    expect(result).not.toHaveProperty('metadataError')
  })

  it.each(['cropped.avif', 'cropped-rotated.avif'])('applies AVIF clean aperture before container rotation: %s', async name => {
    const rotated = name === 'cropped-rotated.avif'
    const result = await info(join(fixtures, name))
    expect(result).toMatchObject({ media: {
      kind: 'image', width: rotated ? 16 : 48, height: rotated ? 48 : 16,
      storedWidth: 64, storedHeight: 32,
      ...(rotated ? { rotationDegrees: -90 } : {})
    } })
    expect(result.media).not.toHaveProperty('warnings')
    expect(result).not.toHaveProperty('metadataError')
  })

  it('reports invalid AVIF clean-aperture dimensions without substituting them for the coded size', async () => {
    const bytes = await readFile(join(fixtures, 'cropped.avif'))
    // The fixture has one clap property; replace its 48-pixel width numerator
    // with 100 pixels, beyond the 64-pixel coded width.
    bytes.writeUInt32BE(100, bytes.indexOf(Buffer.from('clap')) + 4)
    const path = join(root, 'invalid-crop.avif')
    await writeFile(path, bytes)
    const result = await info(path)
    expect(result).toMatchObject({ media: {
      width: 64, height: 32, storedWidth: 64, storedHeight: 32,
      warnings: [expect.stringContaining('clean-aperture dimensions are incomplete or invalid')]
    } })
    expect(result).not.toHaveProperty('metadataError')
  })

  it('returns seconds, sample rate, channels and codec for audio', async () => {
    expect(await info(join(fixtures, 'audio.wav'))).toMatchObject({ media: {
      kind: 'audio', format: 'Wave', durationSeconds: 0.25, trackCount: 1,
      tracks: [{ type: 'audio', codec: 'PCM', sampleRate: 8000, channels: 1 }]
    } })
  })

  it.each(['video.mp4', 'rotated.mp4'])('summarizes video and audio tracks including display rotation: %s', async name => {
    const result = await info(join(fixtures, name))
    expect(result).toMatchObject({ media: {
      kind: 'video', format: 'MPEG-4', durationSeconds: 0.5, trackCount: 2,
      tracks: [
        { type: 'video', width: name === 'video.mp4' ? 64 : 32, height: name === 'video.mp4' ? 32 : 64, frameRate: 10, codec: 'MPEG-4 Visual' },
        { type: 'audio', sampleRate: 8000, channels: 1, codec: 'AAC' }
      ]
    } })
    expect(JSON.stringify(result)).not.toContain('Encoded_Application')
  })

  it('reads a large sparse WAV by header instead of loading the whole file', async () => {
    const path = join(root, 'large.wav'), size = 100 * 1024 * 1024
    const bytes = Buffer.alloc(44)
    bytes.write('RIFF'); bytes.writeUInt32LE(size - 8, 4); bytes.write('WAVEfmt ', 8)
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
    bytes.writeUInt32LE(8000, 24); bytes.writeUInt32LE(16000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
    bytes.write('data', 36); bytes.writeUInt32LE(size - 44, 40)
    const file = await open(path, 'w')
    try { await file.write(bytes); await file.truncate(size) } finally { await file.close() }
    const result = await inspect(path, { maxReadBytes: 256 * 1024 })
    expect(result).toMatchObject({ media: { kind: 'audio', warnings: [expect.stringContaining('read limit')] } })
    expect(result.media?.durationSeconds).toBeCloseTo((size - 44) / 16000, 3)
  })

  it.each(['', 'one\r\ntwo\n', '中文\r尾行', 'x'.repeat(1_000_001)])('retains ordinary text metadata within the line-count limit', async content => {
    const path = join(root, 'source.ts')
    await writeFile(path, content)
    const result = await info(path)
    expect(result.ok).toBe(true)
    expect(result.lineCount).toBe(content.length > 1_000_000 ? undefined : content ? 2 : 0)
    expect(result.media).toBeUndefined()
    expect(result.metadataError).toBeUndefined()
  })

  it.each([Buffer.from('broken media'), Buffer.from([0, 255, 10, 0]), Buffer.alloc(0)])('preserves basic stats when metadata is unavailable', async bytes => {
    const path = join(root, 'broken.mp4')
    await writeFile(path, bytes)
    expect(await info(path)).toMatchObject({ ok: true, size: bytes.length, type: 'file', metadataError: expect.any(String) })
    expect(await info(path)).not.toHaveProperty('lineCount')
  })

  it('does not probe directories or symlink targets', async () => {
    const target = join(root, 'image.png'), link = join(root, 'link.png')
    await copyFile(join(fixtures, 'rgba.png'), target)
    await symlink(target, link, 'file')
    expect(await info(root)).toMatchObject({ type: 'directory' })
    expect(await info(link)).toMatchObject({ type: 'symlink' })
    expect(await info(link)).not.toHaveProperty('media')
  })

  it('bounds bytes and time, then releases the worker slot for subsequent calls', async () => {
    const path = join(fixtures, 'video.mp4')
    expect(await inspect(path, { maxReadBytes: 1 })).toMatchObject({ metadataError: expect.stringContaining('read limit') })
    expect(await inspect(path, { timeoutMs: 1 })).toMatchObject({ metadataError: expect.stringContaining('timed out') })
    expect(await inspect(path)).toHaveProperty('media.kind', 'video')
  })

  it('propagates cancellation and allows all waiting calls to finish afterwards', async () => {
    const controller = new AbortController(), path = join(fixtures, 'video.mp4')
    const jobs = Array.from({ length: 6 }, () => inspect(path, { signal: controller.signal }))
    const cancelled = Promise.allSettled(jobs)
    setTimeout(() => controller.abort(new Error('Stop metadata')), 10)
    expect((await cancelled).every(result => result.status === 'rejected' && result.reason.message === 'Stop metadata')).toBe(true)
    expect(await inspect(path)).toHaveProperty('media.kind', 'video')
  })

  it('rejects metadata when the file changes during the read', async () => {
    const path = join(root, 'audio.wav')
    await writeFile(path, await readFile(join(fixtures, 'audio.wav')))
    const file = await open(path, 'r')
    try {
      const before = await file.stat()
      vi.spyOn(file, 'stat').mockResolvedValue({ ...before, mtimeMs: before.mtimeMs + 1 } as typeof before)
      expect(await readFileContentInfo(file, before, path)).toEqual({ metadataError: 'File changed while reading metadata; retry.' })
    } finally { await file.close() }
  })
})
