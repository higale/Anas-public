import { describe, expect, it, vi } from 'vitest'
import {
  createProviderRequestCaptureFetch,
  ProviderRequestCapturedError
} from './providerRequestCapture'

describe('provider request capture', () => {
  it('preserves the complete request including credentials and parsed JSON body', async () => {
    const capture = vi.fn()
    const captureFetch = createProviderRequestCaptureFetch(capture)

    await expect(captureFetch('https://provider.example/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer complete-api-key',
        'Content-Type': 'application/json',
        'X-Api-Key': 'complete-secondary-key'
      },
      body: JSON.stringify({
        model: 'example-model',
        messages: [{ role: 'user', content: 'hello world' }]
      })
    })).rejects.toBeInstanceOf(ProviderRequestCapturedError)

    expect(capture).toHaveBeenCalledWith({
      url: 'https://provider.example/v1/chat/completions',
      method: 'POST',
      headers: expect.objectContaining({
        authorization: 'Bearer complete-api-key',
        'x-api-key': 'complete-secondary-key'
      }),
      body: {
        model: 'example-model',
        messages: [{ role: 'user', content: 'hello world' }]
      }
    })
  })
})
