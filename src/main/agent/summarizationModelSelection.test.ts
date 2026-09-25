import { createRequire } from 'node:module'
import { AIMessage, HumanMessage, SystemMessage } from '@langchain/core/messages'
import { FakeListChatModel } from '@langchain/core/utils/testing'
import { createSummarizationMiddleware, StateBackend, type BackendRuntime } from 'deepagents'
import { describe, expect, it, vi } from 'vitest'

const commonjs: typeof import('deepagents') = createRequire(import.meta.url)('deepagents')

describe.each([
  ['ESM', createSummarizationMiddleware],
  ['CommonJS', commonjs.createSummarizationMiddleware]
] as const)('%s native summarization model selection', (_name, createMiddleware) => {
  function middleware(model?: FakeListChatModel) {
    return createMiddleware({
      ...(model ? { model } : {}), backend: (runtime: BackendRuntime) => new StateBackend(runtime),
      trigger: { type: 'tokens', value: 1 }, keep: { type: 'messages', value: 1 }
    })
  }

  async function invoke(summary: ReturnType<typeof middleware>, model: FakeListChatModel) {
    const messages = [new HumanMessage('Old question ' + 'x'.repeat(1000)),
      new AIMessage('Old answer ' + 'y'.repeat(1000)), new HumanMessage('Current task')]
    let prepared = ''
    await summary.wrapModelCall!({
      model, messages, state: { messages, files: {} }, systemMessage: new SystemMessage('System'),
      systemPrompt: 'System', tools: [], runtime: {}
    } as never, async (request) => {
      expect(request.model).toBe(model)
      prepared = request.messages.map((message) => message.text).join('\n')
      return new AIMessage('Main response')
    })
    return prepared
  }

  it('uses the explicitly configured summary model while preserving the main request model', async () => {
    const main = new FakeListChatModel({ responses: ['WRONG MAIN MODEL'] })
    const summary = new FakeListChatModel({ responses: ['EXPLICIT SUMMARY'] })
    const mainInvoke = vi.spyOn(main, 'invoke')
    const summaryInvoke = vi.spyOn(summary, 'invoke')
    expect(await invoke(middleware(summary), main)).toContain('EXPLICIT SUMMARY')
    expect(summaryInvoke).toHaveBeenCalledOnce()
    expect(mainInvoke).not.toHaveBeenCalled()
  })

  it('uses each active request model when no summary model is configured', async () => {
    const first = new FakeListChatModel({ responses: ['FIRST MODEL SUMMARY'] })
    const second = new FakeListChatModel({ responses: ['SECOND MODEL SUMMARY'] })
    const summary = middleware()
    expect(await invoke(summary, first)).toContain('FIRST MODEL SUMMARY')
    expect(await invoke(summary, second)).toContain('SECOND MODEL SUMMARY')
  })
})
