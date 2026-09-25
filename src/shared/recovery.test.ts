import { describe, expect, it } from 'vitest'
import { errorDetail } from './recovery'

describe('recovery error details', () => {
  it('retains causes and aggregated rollback errors without duplicating embedded messages', () => {
    const cause = new Error('Unexpected token')
    const error = new Error('/data/config/settings.json\nUnexpected token', { cause })
    expect(errorDetail(error)).toBe('/data/config/settings.json\nUnexpected token')
    expect(errorDetail(new AggregateError([error, new Error('rollback failed')], 'restore failed')))
      .toBe('restore failed\n/data/config/settings.json\nUnexpected token\nrollback failed')
  })

  it('bounds recursive errors and uses localized fallback copy for unknown failures', () => {
    const error = new Error('cycle')
    error.cause = error
    expect(errorDetail(error)).toBe('cycle')
    expect(errorDetail(new Error('x'.repeat(40_000)))).toHaveLength(32_000)
    expect(errorDetail(undefined, '加载失败')).toBe('加载失败')
    expect(errorDetail('native error')).toBe('native error')
  })
})
