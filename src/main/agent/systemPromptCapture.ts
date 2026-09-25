import { AIMessage } from '@langchain/core/messages'
import { createMiddleware } from 'langchain'

export function createSystemPromptCaptureMiddleware(
  capture: (content: string) => void
) {
  return createMiddleware({
    name: 'AnasSystemPromptCaptureMiddleware',
    wrapModelCall: async (request) => {
      capture(request.systemMessage.text)
      return new AIMessage('')
    }
  })
}
