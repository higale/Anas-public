function cssNumber(value: string, fallback = 0): number {
  const parsed = parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function resizeAutosizeTextarea(textarea: HTMLTextAreaElement | null): void {
  if (!textarea || textarea.offsetParent === null) return
  const style = window.getComputedStyle(textarea)
  const fontSize = cssNumber(style.fontSize, 14)
  const lineHeight = cssNumber(style.lineHeight, fontSize * 1.4)
  const verticalPadding = cssNumber(style.paddingTop) + cssNumber(style.paddingBottom)
  const verticalBorder = cssNumber(style.borderTopWidth) + cssNumber(style.borderBottomWidth)
  const minRows = Number(textarea.dataset.minRows ?? 2) || 2
  const rowMinHeight = Math.ceil(lineHeight * minRows + verticalPadding + verticalBorder)
  const minHeight = Math.max(rowMinHeight, cssNumber(style.minHeight))
  const maxRows = Number(textarea.dataset.maxRows)
  const maxHeightValue = textarea.dataset.maxHeight ?? (maxRows > 0
    ? String(Math.ceil(lineHeight * Math.max(minRows, maxRows) + verticalPadding + verticalBorder)) : undefined)
  const maxHeight = maxHeightValue === 'none' ? Number.POSITIVE_INFINITY : Number(maxHeightValue ?? 420) || 420
  textarea.style.height = 'auto'
  const naturalHeight = textarea.scrollHeight + verticalBorder
  const height = Math.min(Math.max(naturalHeight, minHeight), maxHeight)
  textarea.style.height = `${height}px`
  const clippedHeight = textarea.scrollHeight - textarea.clientHeight
  if (clippedHeight > 0 && height < maxHeight) {
    textarea.style.height = `${Math.min(height + clippedHeight + verticalBorder, maxHeight)}px`
  }
  textarea.style.overflowY = Number.isFinite(maxHeight) && textarea.scrollHeight > textarea.clientHeight + 1 ? 'scroll' : 'hidden'
}

export function resizeAutosizeTextareasIn(root: ParentNode | null): void {
  root?.querySelectorAll<HTMLTextAreaElement>('textarea.ui-autosize-textarea').forEach(resizeAutosizeTextarea)
}
