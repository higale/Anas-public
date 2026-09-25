import { BrowserWindow, dialog, type IpcMainInvokeEvent, type OpenDialogOptions, type SaveDialogOptions } from 'electron'

export function dialogParentFromEvent(event: IpcMainInvokeEvent): BrowserWindow | undefined {
  if (event.sender.isDestroyed()) return undefined
  return BrowserWindow.fromWebContents(event.sender) ?? undefined
}

export function showModalOpenDialog(parent: BrowserWindow | undefined, options: OpenDialogOptions) {
  return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options)
}

export function showModalSaveDialog(parent: BrowserWindow | undefined, options: SaveDialogOptions) {
  return parent ? dialog.showSaveDialog(parent, options) : dialog.showSaveDialog(options)
}
