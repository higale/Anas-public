import { AIMessage, ToolMessage, type BaseMessage, type ToolMessageFields } from '@langchain/core/messages'
import { createMiddleware } from 'langchain'

const omittedImageText = '[Tool image provided in an earlier step; omitted from this request.]'

function isToolImageBlock(block: unknown): boolean {
  return Boolean(block && typeof block === 'object' && 'type' in block
    && ['image', 'image_url', 'input_image'].includes(String(block.type)))
}

export function hasToolImages(message: BaseMessage): boolean {
  return ToolMessage.isInstance(message) && Array.isArray(message.content)
    && message.content.some(isToolImageBlock)
}

function isModelResponse(message: BaseMessage): boolean {
  return AIMessage.isInstance(message) && message.additional_kwargs.lc_source !== 'summarization'
}

function latestResponseIndex(messages: BaseMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (isModelResponse(messages[index])) return index
  }
  return -1
}

/** Preserve the entire tool transaction until a normal model response exists. */
export function pendingToolImageStart(messages: BaseMessage[]): number | undefined {
  const responseIndex = latestResponseIndex(messages)
  return messages.some((message, index) => index > responseIndex && hasToolImages(message))
    ? Math.max(0, responseIndex)
    : undefined
}

/** A pure request projection, based solely on committed conversation messages. */
export function projectToolImages(messages: BaseMessage[]): BaseMessage[] {
  const responseIndex = latestResponseIndex(messages)
  let projected = messages
  for (let index = 0; index < responseIndex; index++) {
    const message = messages[index]
    if (!hasToolImages(message) || !Array.isArray(message.content)) continue
    if (projected === messages) projected = messages.slice()
    projected[index] = new ToolMessage({
      ...(message as unknown as ToolMessageFields),
      content: message.content.map((block) => isToolImageBlock(block)
        ? { type: 'text', text: omittedImageText }
        : block)
    })
  }
  return projected
}

export function createToolImageProjectionMiddleware() {
  return createMiddleware({
    name: 'AnasToolImageProjectionMiddleware',
    wrapModelCall: (request, handler) => handler({
      ...request,
      messages: projectToolImages(request.messages)
    })
  })
}
