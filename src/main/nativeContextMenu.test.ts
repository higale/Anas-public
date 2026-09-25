import { describe, expect, it } from 'vitest'
import { buildNativeContextMenuTemplate } from './nativeContextMenu'

const label = (key: string): string => key

function editFlags(overrides: Partial<Electron.EditFlags> = {}): Electron.EditFlags {
  return {
    canCopy: false,
    canCut: false,
    canDelete: false,
    canEditRichly: false,
    canPaste: false,
    canRedo: false,
    canSelectAll: false,
    canUndo: false,
    ...overrides
  }
}

describe('native context menu', () => {
  it('offers the full set of editing actions for text inputs', () => {
    const template = buildNativeContextMenuTemplate({
      isEditable: true,
      editFlags: editFlags({ canCopy: true, canPaste: true, canSelectAll: true })
    }, label)

    expect(template.map((item) => item.role ?? item.type)).toEqual([
      'undo',
      'redo',
      'separator',
      'cut',
      'copy',
      'paste',
      'delete',
      'separator',
      'selectAll'
    ])
    expect(template.find((item) => item.role === 'copy')?.enabled).toBe(true)
    expect(template.find((item) => item.role === 'cut')?.enabled).toBe(false)
  })

  it('limits read-only page content to copy and select all', () => {
    const template = buildNativeContextMenuTemplate({
      isEditable: false,
      editFlags: editFlags({ canCopy: true })
    }, label)

    expect(template.map((item) => item.role ?? item.type)).toEqual([
      'copy',
      'separator',
      'selectAll'
    ])
    expect(template.find((item) => item.role === 'selectAll')?.enabled).toBe(false)
  })
})
