export interface CapturedProviderRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

const maximumCapturedRequestBytes = 32 * 1024 * 1024

export class ProviderRequestCapturedError extends Error {
  constructor() {
    super('Invalid request: provider request captured for preview.')
    this.name = 'ProviderRequestCapturedError'
  }
}

function parseRequestBody(content: string): unknown {
  if (!content) return null
  try {
    return JSON.parse(content) as unknown
  } catch {
    return content
  }
}

export function createProviderRequestCaptureFetch(
  capture: (request: CapturedProviderRequest) => void
): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    const contentLength = Number(request.headers.get('content-length'))
    if (Number.isFinite(contentLength) && contentLength > maximumCapturedRequestBytes) {
      throw new Error('The provider request is too large to preview.')
    }
    const bodyText = await request.text()
    if (Buffer.byteLength(bodyText, 'utf8') > maximumCapturedRequestBytes) {
      throw new Error('The provider request is too large to preview.')
    }
    capture({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body: parseRequestBody(bodyText)
    })
    throw new ProviderRequestCapturedError()
  }
}
