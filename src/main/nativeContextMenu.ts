import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron'

export type NativeMenuLabel = (key: string, fallback: string) => string

type NativeContextMenuContext = Pick<ContextMenuParams, 'editFlags' | 'isEditable'>

function editItem(
  role: NonNullable<MenuItemConstructorOptions['role']>,
  label: string,
  enabled: boolean
): MenuItemConstructorOptions {
  return { role, label, enabled }
}

export function buildNativeContextMenuTemplate(
  context: NativeContextMenuContext,
  label: NativeMenuLabel
): MenuItemConstructorOptions[] {
  const { editFlags } = context
  const copy = editItem('copy', label('copy', 'Copy'), editFlags.canCopy)
  const selectAll = editItem('selectAll', label('select_all', 'Select All'), editFlags.canSelectAll)

  if (!context.isEditable) {
    return [copy, { type: 'separator' }, selectAll]
  }

  return [
    editItem('undo', label('undo', 'Undo'), editFlags.canUndo),
    editItem('redo', label('redo', 'Redo'), editFlags.canRedo),
    { type: 'separator' },
    editItem('cut', label('cut', 'Cut'), editFlags.canCut),
    copy,
    editItem('paste', label('paste', 'Paste'), editFlags.canPaste),
    editItem('delete', label('delete', 'Delete'), editFlags.canDelete),
    { type: 'separator' },
    selectAll
  ]
}
