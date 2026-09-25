import { describe, expect, it } from 'vitest'
import { inferModelListEndpoint, resolveModelListEndpoint } from './modelListEndpoint'

describe('model list endpoint', () => {
  it.each([
    ['https://example.com', 'https://example.com/v1/models'],
    ['https://example.com/v1/', 'https://example.com/v1/models'],
    ['https://example.com/anthropic', 'https://example.com/v1/models'],
    ['https://example.com/compatible', 'https://example.com/v1/models']
  ])('infers %s as %s', (baseUrl, endpoint) => {
    expect(inferModelListEndpoint(baseUrl)).toBe(endpoint)
  })

  it('prefers an explicit model list URL', () => {
    expect(resolveModelListEndpoint(
      'https://example.com/v1',
      ' https://models.example.com/catalog '
    )).toBe('https://models.example.com/catalog')
  })

  it('falls back to inference when the explicit URL is empty', () => {
    expect(resolveModelListEndpoint('https://example.com/v1', '   '))
      .toBe('https://example.com/v1/models')
  })

  it('resolves origin and Base URL expressions dynamically', () => {
    expect(resolveModelListEndpoint(
      'http://localhost:22434/custom/path',
      '{origin}/v1/models'
    )).toBe('http://localhost:22434/v1/models')
    expect(resolveModelListEndpoint(
      'https://proxy.example.com/openai/v1/',
      '{base_url}/models'
    )).toBe('https://proxy.example.com/openai/v1/models')
  })

  it('rejects invalid origins and unsupported placeholders', () => {
    expect(() => resolveModelListEndpoint('not a URL', '{origin}/v1/models'))
      .toThrow('Base URL must be valid')
    expect(() => resolveModelListEndpoint('https://example.com/v1', '{host}/models'))
      .toThrow('{host}')
  })

  it('rejects malformed, relative, and non-HTTP endpoints', () => {
    expect(() => resolveModelListEndpoint('https://example.com/v1', 'https://example.com/{broken'))
      .toThrow('malformed placeholder')
    expect(() => resolveModelListEndpoint('https://example.com/v1', 'models'))
      .toThrow('valid absolute URL')
    expect(() => resolveModelListEndpoint('https://example.com/v1', 'file:///tmp/models.json'))
      .toThrow('HTTP or HTTPS')
  })
})
