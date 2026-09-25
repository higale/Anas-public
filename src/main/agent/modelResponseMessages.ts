import { AIMessage } from '@langchain/core/messages'

/** LangChain returns one AI message normally, or a message batch for native
 * structured output. Metadata must decorate checkpoint messages, not the batch. */
export function modelResponseMessages(response: unknown): AIMessage[] {
  if (AIMessage.isInstance(response)) return [response]
  if (response && typeof response === 'object' && 'structuredResponse' in response
    && 'messages' in response && Array.isArray(response.messages)) {
    return response.messages.filter((message): message is AIMessage => AIMessage.isInstance(message))
  }
  return []
}
