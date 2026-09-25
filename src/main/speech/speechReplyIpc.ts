import type { WebContents } from 'electron'
import type { SpeechGenerateRequest } from '@shared/types'
import { handleMainIpc } from '../ipcSecurity'
import { generateSpeech, loadSpeechVoices } from '../speechReply'

export function registerSpeechReplyIpc(): void {
  const requests = new WeakMap<WebContents, Map<string, AbortController>>()
  const ownerRequests = (owner: WebContents): Map<string, AbortController> => {
    const existing = requests.get(owner)
    if (existing) return existing
    const pending = new Map<string, AbortController>()
    requests.set(owner, pending)
    const cancel = (): void => {
      for (const controller of pending.values()) controller.abort()
      pending.clear()
    }
    owner.once('destroyed', cancel)
    owner.on('render-process-gone', cancel)
    owner.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) cancel()
    })
    return pending
  }
  handleMainIpc('speech:generate', async (event, request: SpeechGenerateRequest): Promise<Uint8Array> => {
    if (!request || typeof request.requestId !== 'string' || !/^[\w-]{1,80}$/.test(request.requestId)) {
      throw new Error('Invalid speech request ID.')
    }
    const pending = ownerRequests(event.sender)
    if (pending.has(request.requestId)) throw new Error('Speech request already exists.')
    if (pending.size >= 4) throw new Error('Too many active speech requests.')
    const controller = new AbortController()
    pending.set(request.requestId, controller)
    try {
      return await generateSpeech(request, controller.signal)
    } finally {
      if (pending.get(request.requestId) === controller) pending.delete(request.requestId)
    }
  })
  handleMainIpc('speech:cancel', async (event, requestId: string): Promise<void> => {
    if (typeof requestId !== 'string') throw new Error('Invalid speech request ID.')
    requests.get(event.sender)?.get(requestId)?.abort()
  })
  handleMainIpc('speech:listVoices', async (_event, forceRefresh: boolean = false) => loadSpeechVoices(forceRefresh))
}
