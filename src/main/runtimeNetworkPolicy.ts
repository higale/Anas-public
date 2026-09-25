const blockedRuntimeHosts = new Set([
  'tiktoken.pages.dev'
])

function requestUrl(input: Parameters<typeof fetch>[0]): URL | undefined {
  try {
    if (input instanceof URL) return input
    return new URL(typeof input === 'string' ? input : input.url)
  } catch {
    return undefined
  }
}

export function enforceRuntimeNetworkPolicy(fetchImplementation: typeof fetch): typeof fetch {
  return ((input, init) => {
    const url = requestUrl(input)
    if (url && blockedRuntimeHosts.has(url.hostname.toLowerCase())) {
      return Promise.reject(new Error(
        `Blocked unapproved runtime network access to "${url.hostname}".`
      ))
    }
    return fetchImplementation(input, init)
  }) as typeof fetch
}

export function installRuntimeNetworkPolicy(): void {
  globalThis.fetch = enforceRuntimeNetworkPolicy(globalThis.fetch)
}
