import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import type { StateSnapshot } from '@langchain/langgraph'
import { createDeepAgent } from 'deepagents'
import { createMiddleware, FakeToolCallingModel, tool } from 'langchain'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { CurrentStateSqliteSaver } from './currentStateSqliteSaver'
import { contextRequestKey as requestKey, currentContextWindowTokens as windowTokens } from './serverTokenUsage'

import { countMessagesApproximately } from './localTokenCounting'
import {
  createToolImageProjectionMiddleware, hasToolImages, pendingToolImageStart,
  projectToolImages
} from './toolImageProjection'

function contextRequestKey(options: Omit<Parameters<typeof requestKey>[0], 'messages' | 'protocol'> & Partial<Pick<Parameters<typeof requestKey>[0], 'messages' | 'protocol'>>) {
  return requestKey({ messages: [], protocol: 'openai_chat_completions', ...options })
}

function currentContextWindowTokens(options: Omit<Parameters<typeof windowTokens>[0], 'protocol'> & Partial<Pick<Parameters<typeof windowTokens>[0], 'protocol'>>) {
  return windowTokens({ protocol: 'openai_chat_completions', ...options })
}

const image = { type: 'image', source_type: 'base64', data: 'SCREENSHOT_BASE64', mime_type: 'image/png' }
function result(id = 'capture') {
  return new ToolMessage({ id: `${id}-result`, name: 'capture', tool_call_id: id,
    content: [{ type: 'text', text: 'Captured window 123' }, image,
      { type: 'image_url', image_url: { url: 'data:image/png;base64,SECOND_IMAGE' } }],
    artifact: { original: image }, additional_kwargs: { provenance: 'mcp' }, status: 'success' })
}
function call(id = 'capture') {
  return new AIMessage({ content: '', tool_calls: [{ name: 'capture', args: {}, id, type: 'tool_call' }] })
}

describe('tool image request lifetime', () => {
  it('preserves every pending image and removes only observed tool images without mutating history', () => {
    const old = result('old'), fresh = result('fresh')
    const attachment = new HumanMessage({ content: [image] })
    const messages = [attachment, call('old'), old, call('fresh'), fresh]
    const before = JSON.stringify(messages)
    const projected = projectToolImages(messages)
    expect(hasToolImages(projected[2])).toBe(false)
    expect(projected[2]).toMatchObject({ id: old.id, name: old.name, tool_call_id: 'old', artifact: old.artifact,
      status: 'success', additional_kwargs: { provenance: 'mcp' } })
    expect(projected[2].text).toContain('Captured window 123')
    expect(projected[4]).toBe(fresh)
    expect(projected[0]).toBe(attachment)
    expect(JSON.stringify(messages)).toBe(before)
    expect(projectToolImages(projected)).toBe(projected)
    expect(pendingToolImageStart(projected)).toBe(3)
  })

  it('does not interpret a compression response or another agent response as consuming images', () => {
    const parent = [call(), result()]
    const child = [call('child'), result('child'), new AIMessage('Child observed image')]
    expect(hasToolImages(projectToolImages(child)[1])).toBe(false)
    expect(projectToolImages(parent)).toBe(parent)
    const compression = new AIMessage({ content: 'Summary', additional_kwargs: { lc_source: 'summarization' } })
    expect(projectToolImages([...parent, compression])[1]).toBe(parent[1])
    expect(projectToolImages([...parent, new HumanMessage('Queued direction')])[1]).toBe(parent[1])
  })

  it('leaves arbitrary base64 text and non-image blocks intact', () => {
    const text = new ToolMessage({ tool_call_id: 'text', content: JSON.stringify(image) })
    const audio = new ToolMessage({ tool_call_id: 'audio', content: [{ type: 'audio', data: 'AUDIO' }] })
    const messages = [text, audio, new AIMessage('Read')]
    expect(projectToolImages(messages)).toBe(messages)
  })

  it('retains every image in a parallel batch until the next response', () => {
    const ids = Array.from({ length: 6 }, (_, index) => `parallel-${index}`)
    const request = new AIMessage({ content: '', tool_calls: ids.map((id) => ({ id, name: 'capture', args: {} })) })
    const messages = [request, ...ids.map(result)]
    expect(projectToolImages(messages)).toBe(messages)
    expect(projectToolImages([...messages, new AIMessage('Compared all screens')]).filter(hasToolImages)).toHaveLength(0)
    expect(messages.filter(hasToolImages)).toHaveLength(6)
  })

  it('invalidates only the usage snapshot that included the newly omitted images', () => {
    const response = (input: BaseMessage[]) => new AIMessage({ content: 'Observed',
      additional_kwargs: { anas_context_request_key: contextRequestKey({ messages: input, systemMessage: '', tools: [] }) }, usage_metadata: {
      input_tokens: 9000, output_tokens: 100, total_tokens: 9100
    } })
    const input = [call(), result()]
    const messages = [...input, response(input)]
    expect(currentContextWindowTokens({ messages, systemMessage: '', tools: [] })).toBeLessThan(9100)
    const nextInput = projectToolImages([...messages, new HumanMessage('Continue')])
    const next = [...nextInput, response(nextInput)]
    expect(currentContextWindowTokens({ messages: next, systemMessage: '', tools: [] }))
      .toBe(9000 + countMessagesApproximately(next.slice(-1)))
  })

  it('keeps images across failure and SQLite restart, then omits them after a committed response', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-tool-images-'))
    const path = join(root, 'state.sqlite')
    let connection = new Database(path)
    const inputs: BaseMessage[][] = []
    const capture = tool(async () => [result().content, result().artifact], {
      name: 'capture', description: 'Capture screen', schema: z.object({}), responseFormat: 'content_and_artifact'
    })
    const graph = (respond: (messages: BaseMessage[]) => AIMessage) => createDeepAgent({
      model: new FakeToolCallingModel({ toolCalls: [[]] }),
      checkpointer: new CurrentStateSqliteSaver(connection), tools: [capture],
      middleware: [createToolImageProjectionMiddleware(), createMiddleware({
        name: 'ObserveImageRequests', wrapModelCall: async (request) => {
          inputs.push(request.messages)
          return respond(request.messages)
        }
      })]
    })
    const config = { configurable: { thread_id: 'root' } }
    try {
      const failing = graph((messages) => {
        if (messages.some(hasToolImages)) throw new Error('Model request failed after receiving the image')
        return call()
      })
      await expect(failing.invoke({ messages: [new HumanMessage('Capture')] }, config)).rejects.toThrow('Model request failed')
      expect(inputs.at(-1)?.filter(hasToolImages)).toHaveLength(1)
      connection.close()
      connection = new Database(path)
      const restored = graph(() => new AIMessage('Image processed'))
      await restored.invoke(null, config)
      expect(inputs.at(-1)?.filter(hasToolImages)).toHaveLength(1)
      await restored.invoke({ messages: [new HumanMessage('Continue')] }, config)
      expect(inputs.at(-1)?.filter(hasToolImages)).toHaveLength(0)
      const state = await (restored as unknown as {
        getState(config: { configurable: { thread_id: string } }): Promise<StateSnapshot>
      }).getState(config)
      const stored = (state.values.messages as BaseMessage[]).find(hasToolImages)
      expect(stored?.content).toEqual(result().content)
      expect((stored as ToolMessage).artifact).toEqual(result().artifact)
    } finally {
      connection.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
