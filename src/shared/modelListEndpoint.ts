export function inferModelListEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  if (trimmed.endsWith('/anthropic')) {
    return `${trimmed.slice(0, -'/anthropic'.length)}/v1/models`
  }
  if (trimmed.endsWith('/compatible')) {
    return `${trimmed.slice(0, -'/compatible'.length)}/v1/models`
  }
  const schemePos = trimmed.indexOf('://')
  if (schemePos >= 0 && !trimmed.slice(schemePos + 3).includes('/')) {
    return `${trimmed}/v1/models`
  }
  return `${trimmed}/models`
}

export function resolveModelListEndpoint(baseUrl: string, modelListUrl: string): string {
  const expression = modelListUrl.trim() || inferModelListEndpoint(baseUrl)
  if (!expression) return ''

  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, '')
  let endpoint = expression.replaceAll('{base_url}', normalizedBaseUrl)
  if (endpoint.includes('{origin}')) {
    let origin: string
    try {
      origin = new URL(normalizedBaseUrl).origin
    } catch {
      throw new Error('Base URL must be valid before resolving {origin}.')
    }
    endpoint = endpoint.replaceAll('{origin}', origin)
  }
  const unsupportedPlaceholder = endpoint.match(/\{[^{}]+\}/)?.[0]
  if (unsupportedPlaceholder) {
    throw new Error(`Unsupported model list URL placeholder: ${unsupportedPlaceholder}.`)
  }
  if (endpoint.includes('{') || endpoint.includes('}')) {
    throw new Error('Model list URL contains a malformed placeholder.')
  }
  let parsedEndpoint: URL
  try {
    parsedEndpoint = new URL(endpoint)
  } catch {
    throw new Error('Model list URL must be a valid absolute URL.')
  }
  if (parsedEndpoint.protocol !== 'http:' && parsedEndpoint.protocol !== 'https:') {
    throw new Error('Model list URL must use HTTP or HTTPS.')
  }
  return endpoint
}
