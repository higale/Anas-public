import { HumanMessage, ToolMessage, type BaseMessage, type ToolMessageFields } from '@langchain/core/messages'
import { convertStandardContentBlockToCompletionsContentPart } from '@langchain/openai'
import { hasToolImages } from './toolImageProjection'

type Content = Exclude<ToolMessageFields['content'], string | undefined>

/** Request-only protocol encoding. Checkpoints retain the original tool result. */
export function encodeOpenAiToolImages(messages: BaseMessage[], responses: boolean): BaseMessage[] {
  const result: BaseMessage[] = []
  let images: Content = []
  const flush = () => {
    if (!images.length) return
    result.push(new HumanMessage({ content: images }))
    images = []
  }
  for (const message of messages) {
    // All results in a parallel tool batch must precede its image user message.
    if (!ToolMessage.isInstance(message)) flush()
    if (!hasToolImages(message) || !ToolMessage.isInstance(message)) {
      result.push(message)
      continue
    }
    const content: Content = []
    const text: Content = []
    const normalized = new ToolMessage({
      ...(message as unknown as ToolMessageFields),
      content: Array.isArray(message.content) ? message.content.map((block) => {
        if (block.type === 'input_text') return { type: 'text', text: block.text }
        if (block.type === 'input_image') return { type: 'image_url', image_url: { url: block.image_url, detail: block.detail } }
        return block
      }) : message.content
    })
    for (const block of normalized.contentBlocks) {
      if (block.type === 'image') {
        const image = convertStandardContentBlockToCompletionsContentPart(block)
        if (!image || image.type !== 'image_url') throw new Error('Tool image cannot be encoded for this model interface.')
        content.push(responses
          ? { type: 'input_image', image_url: image.image_url.url, detail: image.image_url.detail ?? 'auto' }
          : { type: 'image_url', image_url: image.image_url })
      } else {
        const value = block.type === 'text' ? block.text : JSON.stringify(block)
        content.push({ type: responses ? 'input_text' : 'text', text: value })
        text.push({ type: 'text', text: value })
      }
    }
    // Native Responses output arrays must not take LangChain's v1 text conversion.
    const { output_version: _version, ...metadata } = message.response_metadata
    result.push(new ToolMessage({
      ...(message as unknown as ToolMessageFields),
      response_metadata: responses ? metadata : message.response_metadata,
      content: responses ? content : [...text, { type: 'text', text: 'Tool images are attached after this tool result batch.' }]
    }))
    if (!responses) images.push({ type: 'text', text: `Images returned by tool call ${message.tool_call_id} (${message.name ?? 'tool'}):` }, ...content)
  }
  flush()
  return result
}
