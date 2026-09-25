export const UI_FONT_SIZE_MIN = 11
export const UI_FONT_SIZE_MAX = 18
export const UI_FONT_SIZE_DEFAULT = 14
export const SIDEBAR_WIDTH_MIN = 220
export const SIDEBAR_WIDTH_MAX = 420
export const SIDEBAR_WIDTH_DEFAULT = 260

export function normalizeUiFontSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return UI_FONT_SIZE_DEFAULT
  return Math.min(UI_FONT_SIZE_MAX, Math.max(UI_FONT_SIZE_MIN, Math.floor(value)))
}

export function normalizeSidebarWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return SIDEBAR_WIDTH_DEFAULT
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(value)))
}

export const WORKSPACE_PANEL_WIDTH_DEFAULT = 480
export const WORKSPACE_PANEL_WIDTH_MIN = 320

export function normalizeWorkspacePanelWidth(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(Math.round(value))) return WORKSPACE_PANEL_WIDTH_DEFAULT
  return Math.max(WORKSPACE_PANEL_WIDTH_MIN, Math.round(value))
}
