import { describe, expect, it, vi } from 'vitest'
import { agentActionError, localizeAgentError } from './agentErrorMessage'
import { backgroundTasksPendingError, backgroundCleanupStarted, backgroundCleanupCompleted } from '@shared/backgroundCleanup'

describe('agent error messages', () => {
  it('keeps the underlying failure beside the localized action summary', () => {
    expect(agentActionError('重新生成回复失败。', new Error('Background work is still executing.')))
      .toBe('重新生成回复失败。\nBackground work is still executing.')
    expect(agentActionError('重新生成回复失败。', 'Message was not found.'))
      .toBe('重新生成回复失败。\nMessage was not found.')
  })

  it('keeps the action summary when there is no useful extra error detail', () => {
    for (const error of [undefined, null, {}, '', new Error(''), new Error('重新生成回复失败。')]) {
      expect(agentActionError('重新生成回复失败。', error)).toBe('重新生成回复失败。')
    }
  })

  it('localizes the LangChain run model-call limit error', () => {
    const t = vi.fn((key: string) => key)

    expect(localizeAgentError(
      'Model call limits exceeded: run level call limit reached with 3 model calls',
      t
    )).toBe('agent.model_call_limit_reached_with_count')
    expect(t).toHaveBeenCalledWith('agent.model_call_limit_reached_with_count', { count: 3 })
  })

  it('explains invalid model tool calls', () => {
    expect(localizeAgentError('Model returned an invalid tool call.', (key) => key)).toBe('agent.invalid_model_tool_call')
  })

  it('preserves unknown errors', () => {
    expect(localizeAgentError('Unknown failure', (key) => key)).toBe('Unknown failure')
  })

  it('localizes cleanup progress and terminal status while retaining exact task IDs and errors', () => {
    const text = localizeAgentError([
      backgroundTasksPendingError, backgroundCleanupStarted,
      'call_id=task-123: uncertain; Remote response was lost',
      'subagent_id=child-456: cancelled', backgroundCleanupCompleted
    ].join('\n'), (key) => `[${key}]`)
    expect(text).toContain('[agent.background_tasks_unresolved]')
    expect(text).toContain('[agent.background_cleanup_started]')
    expect(text).toContain('call_id=task-123: [agent.background_cleanup_uncertain]; Remote response was lost')
    expect(text).toContain('subagent_id=child-456: [agent.background_cleanup_cancelled]')
    expect(text).toContain('[agent.background_cleanup_completed]')
  })
})
