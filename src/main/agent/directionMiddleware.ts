import { ToolMessage, type BaseMessage } from '@langchain/core/messages'
import { createMiddleware } from 'langchain'

export function createQueuedDirectionMiddleware(options: {
  takeDirectionMessages?(afterToolCallIds: string[]): BaseMessage[] | Promise<BaseMessage[]>
}) {
  return createMiddleware({
    name: 'AnasQueuedDirectionMiddleware',
    beforeModel: async (state) => {
      const messages = Array.isArray(state.messages) ? state.messages : []
      if (!ToolMessage.isInstance(messages.at(-1))) return undefined
      const afterToolCallIds: string[] = []
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (!ToolMessage.isInstance(message)) break
        afterToolCallIds.unshift(message.tool_call_id)
      }
      const directions = await options.takeDirectionMessages?.(afterToolCallIds) ?? []
      return directions.length > 0 ? { messages: directions } : undefined
    }
  })
}
