import { BrowserWindow, Menu } from 'electron'
import type { SpeechInputOpenResult } from '@shared/speechInput'
import { handleMainIpc } from '../ipcSecurity'
import { runtimeLog } from '../runtimeLogger'
import { openWindowsVoiceInput } from './windowsVoiceInput'

export function registerSpeechInputIpc(): void {
  handleMainIpc('speech:openInput', (event): SpeechInputOpenResult => {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return 'unsupported'
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner || owner.isDestroyed() || !owner.isFocused() || !event.sender.isFocused()) return 'not_focused'
    try {
      if (process.platform === 'darwin') {
        // Use the native Start Dictation action, independent of the user's
        // keyboard shortcut. Electron does not report recognition state.
        Menu.sendActionToFirstResponder('startDictation:')
        return 'requested'
      }
      return openWindowsVoiceInput(owner.getNativeWindowHandle())
    } catch (error) {
      runtimeLog('warn', 'speech.input', 'Could not request system voice input', error)
      return 'failed'
    }
  })
}
