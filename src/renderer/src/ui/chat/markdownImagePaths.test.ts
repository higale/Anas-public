import { describe, expect, it } from 'vitest'
import { normalizeLocalImagePath } from './markdownImagePaths'

describe('normalizeLocalImagePath', () => {
  it('keeps absolute macOS file URLs as POSIX paths', () => {
    expect(normalizeLocalImagePath('file:///Users/user/Pictures/photo%201.png')).toBe('/Users/user/Pictures/photo 1.png')
  })

  it('accepts absolute POSIX image paths', () => {
    expect(normalizeLocalImagePath('/Users/user/Pictures/photo.jpg')).toBe('/Users/user/Pictures/photo.jpg')
  })

  it('keeps Windows file URLs as Windows paths', () => {
    expect(normalizeLocalImagePath('file:///C:/Users/user/Pictures/photo.png')).toBe('C:\\Users\\user\\Pictures\\photo.png')
  })

  it('accepts direct Windows image paths', () => {
    expect(normalizeLocalImagePath('C:\\Users\\user\\Pictures\\photo.webp')).toBe('C:\\Users\\user\\Pictures\\photo.webp')
  })

  it('strips query and hash fragments before reading the local image', () => {
    expect(normalizeLocalImagePath('/Users/user/Pictures/photo.png?raw=1#preview')).toBe('/Users/user/Pictures/photo.png')
  })

  it('accepts workspace-relative image paths and decodes URL escapes', () => {
    expect(normalizeLocalImagePath('asian_woman_avatar.png')).toBe('asian_woman_avatar.png')
    expect(normalizeLocalImagePath('./images/asian%20woman.webp')).toBe('./images/asian woman.webp')
  })

  it('rejects non-local and non-image sources', () => {
    expect(normalizeLocalImagePath('https://example.com/photo.png')).toBeNull()
    expect(normalizeLocalImagePath('data:image/png;base64,AA==')).toBeNull()
    expect(normalizeLocalImagePath('/Users/user/Pictures/readme.txt')).toBeNull()
    expect(normalizeLocalImagePath('notes/readme.txt')).toBeNull()
  })
})
