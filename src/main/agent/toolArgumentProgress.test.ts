import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolArgumentProgress } from './toolArgumentProgress'

describe('native tool argument reception progress', () => {
  afterEach(() => vi.useRealTimers())

  it('publishes the first tool immediately, batches snapshots, and binds late IDs by block index', () => {
    vi.useFakeTimers()
    const publish = vi.fn()
    const progress = new ToolArgumentProgress(publish)
    progress.accept({ event: 'content-block-start', index: 2, content: { type: 'tool_call_chunk', name: 'apply_patch', args: '' } })
    expect(publish).toHaveBeenCalledTimes(1)
    progress.accept({ event: 'content-block-delta', index: 2, delta: { type: 'block-delta', fields: { type: 'tool_call_chunk', args: '{"patch":' } } })
    progress.accept({ event: 'content-block-delta', index: 2, delta: { type: 'block-delta', fields: { type: 'tool_call_chunk', id: 'patch-id', args: '{"patch":"hello"}' } } })
    vi.advanceTimersByTime(249)
    expect(publish).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish.mock.lastCall?.[0]).toMatchObject([
      { index: 2, callId: 'patch-id', name: 'apply_patch', characterCount: 17, complete: false }
    ])
    progress.accept({ event: 'content-block-start', index: 3, content: { type: 'tool_call_chunk', id: 'read-id', name: 'read_file', args: '' } })
    expect(publish.mock.lastCall?.[0][1]).toMatchObject({ index: 3, callId: 'read-id', name: 'read_file', characterCount: 0 })
    progress.accept({ event: 'content-block-finish', index: 2, content: { type: 'tool_call', id: 'patch-id', name: 'apply_patch', args: { patch: 'hello' } } })
    expect(publish.mock.lastCall?.[0][0]).toEqual({ index: 2, callId: 'patch-id', name: 'apply_patch', characterCount: 17, complete: true })
    progress.dispose()
    vi.runAllTimers()
    expect(publish).toHaveBeenCalledTimes(4)
  })

  it('never retains or publishes argument contents, even for large arguments', () => {
    const publish = vi.fn()
    const progress = new ToolArgumentProgress(publish)
    const args = 'HEAD' + 'x'.repeat(100_000) + 'TAIL'
    progress.accept({ event: 'content-block-start', index: 0, content: { type: 'tool_call_chunk', name: 'apply_patch', args } })
    const value = publish.mock.lastCall?.[0][0]
    expect(value).toEqual({ index: 0, callId: undefined, name: 'apply_patch', characterCount: args.length, complete: false })
    expect(JSON.stringify(publish.mock.calls)).not.toContain('HEAD')
    progress.dispose()
  })

  it('ignores text, server-side tools and late events after cancellation', () => {
    vi.useFakeTimers()
    const publish = vi.fn()
    const progress = new ToolArgumentProgress(publish)
    progress.accept({ event: 'content-block-delta', index: 0, delta: { type: 'text-delta', text: 'Hello' } })
    progress.accept({ event: 'content-block-delta', index: 1, delta: { type: 'block-delta', fields: { type: 'server_tool_call_chunk', args: '{}' } } })
    progress.dispose()
    progress.accept({ event: 'content-block-start', index: 2, content: { type: 'tool_call_chunk', name: 'apply_patch', args: '' } })
    vi.runAllTimers()
    expect(publish).not.toHaveBeenCalled()
  })
})
