import { describe, expect, it } from 'vitest'
import {
  normalizeSidebarWidth,
  normalizeUiFontSize,
  SIDEBAR_WIDTH_DEFAULT,
  UI_FONT_SIZE_DEFAULT
} from './uiPreferences'

describe('UI preferences', () => {
  it('normalizes font size to an integer from 11 through 18', () => {
    expect(normalizeUiFontSize(undefined)).toBe(UI_FONT_SIZE_DEFAULT)
    expect(normalizeUiFontSize(10)).toBe(11)
    expect(normalizeUiFontSize(13.9)).toBe(13)
    expect(normalizeUiFontSize(19)).toBe(18)
  })

  it('normalizes sidebar width to an integer from 220 through 420', () => {
    expect(normalizeSidebarWidth(undefined)).toBe(SIDEBAR_WIDTH_DEFAULT)
    expect(normalizeSidebarWidth(180)).toBe(220)
    expect(normalizeSidebarWidth(279.6)).toBe(280)
    expect(normalizeSidebarWidth(500)).toBe(420)
  })
})
