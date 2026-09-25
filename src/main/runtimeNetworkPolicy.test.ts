import { describe, expect, it, vi } from 'vitest'
import { enforceRuntimeNetworkPolicy } from './runtimeNetworkPolicy'

describe('runtime network policy', () => {
  it('blocks the framework tokenizer CDN before a request is sent', async () => {
    const fetchImplementation = vi.fn<typeof fetch>()
    const policyFetch = enforceRuntimeNetworkPolicy(fetchImplementation)

    await expect(policyFetch(
      'https://tiktoken.pages.dev/js/cl100k_base.json'
    )).rejects.toThrow('Blocked unapproved runtime network access')
    expect(fetchImplementation).not.toHaveBeenCalled()
  })

  it('does not interfere with approved application requests', async () => {
    const response = new Response('ok')
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(response)
    const policyFetch = enforceRuntimeNetworkPolicy(fetchImplementation)

    await expect(policyFetch('https://example.com/data')).resolves.toBe(response)
    expect(fetchImplementation).toHaveBeenCalledOnce()
  })
})
