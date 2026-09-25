/** Read structured tool content only; text containing JSON is still text. */
export function toolResultImages(output: unknown): string[] {
  if (Array.isArray(output)) return output.flatMap(toolResultImages)
  if (!output || typeof output !== 'object') return []
  const block = output as Record<string, unknown>
  if (block.type === 'json') return toolResultImages(block.value)
  if (Array.isArray(block.content)) return toolResultImages(block.content)
  if (block.type === 'image') {
    const mimeType = block.mimeType ?? block.mime_type
    if (typeof block.data === 'string' && block.data && typeof mimeType === 'string' && mimeType.startsWith('image/')) {
      return [`data:${mimeType};base64,${block.data}`]
    }
    return typeof block.url === 'string' && block.url ? [block.url] : []
  }
  if (block.type === 'image_url' || block.type === 'input_image') {
    const image = block.image_url
    const url = image && typeof image === 'object' ? (image as Record<string, unknown>).url : image
    return typeof url === 'string' && url ? [url] : []
  }
  return []
}
