import { HumanMessage, ToolMessage } from '@langchain/core/messages'
import { describe, expect, it, vi } from 'vitest'
import { createQueuedDirectionMiddleware } from './directionMiddleware'

describe('createQueuedDirectionMiddleware', () => {
  it('only consumes queued directions at the model boundary after tool results', async () => {
    const direction = new HumanMessage({ id: 'direction-1', content: 'Use the new constraint.' })
    const takeDirectionMessages = vi.fn((_afterToolCallIds: string[]) => [direction])
    const middleware = createQueuedDirectionMiddleware({ takeDirectionMessages })
    const beforeModel = middleware.beforeModel
    expect(beforeModel).toBeTypeOf('function')
    if (typeof beforeModel !== 'function') throw new Error('beforeModel hook was not callable.')

    const beforeTool = await beforeModel({
      messages: [new HumanMessage('Start')]
    } as never, {} as never)
    expect(beforeTool).toBeUndefined()
    expect(takeDirectionMessages).not.toHaveBeenCalled()

    const afterTool = await beforeModel({
      messages: [
        new HumanMessage('Start'),
        new ToolMessage({ content: 'First output', tool_call_id: 'tool-1' }),
        new ToolMessage({ content: 'Second output', tool_call_id: 'tool-2' })
      ]
    } as never, {} as never)
    expect(afterTool).toEqual({ messages: [direction] })
    expect(takeDirectionMessages).toHaveBeenCalledOnce()
    expect(takeDirectionMessages).toHaveBeenCalledWith(['tool-1', 'tool-2'])
  })

  it('leaves state unchanged when no direction is queued', async () => {
    const middleware = createQueuedDirectionMiddleware({
      takeDirectionMessages: () => []
    })
    const beforeModel = middleware.beforeModel
    if (typeof beforeModel !== 'function') throw new Error('beforeModel hook was not callable.')

    expect(await beforeModel({
      messages: [new ToolMessage({ content: 'Done', tool_call_id: 'tool-1' })]
    } as never, {} as never)).toBeUndefined()
  })
})
