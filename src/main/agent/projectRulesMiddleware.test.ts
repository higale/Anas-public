import { mkdtemp, mkdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'
import type { ModelProtocol } from '@shared/types'
import { Command, MemorySaver, type StateSnapshot } from '@langchain/langgraph'
import { FakeListChatModel } from '@langchain/core/utils/testing'
import { StateBackend, type BackendRuntime } from 'deepagents'
import { createAgent, createMiddleware, FakeToolCallingModel, tool } from 'langchain'
import { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createProjectRulesMiddleware } from './projectRulesMiddleware'
import { createAnasSummarizationMiddleware } from './summarizationMiddleware'
import { filePatchSchema } from '../filePatch'
import { projectSkillMessages, toHumanMessage } from './messageMapper'

const roots: string[] = []
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'anas-rules-graph-')))
  roots.push(root)
  await mkdir(join(root, 'child'))
  await writeFile(join(root, 'AGENTS.md'), 'ROOT RULE')
  await writeFile(join(root, 'child/AGENTS.md'), 'CHILD RULE')
  return root
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
function rules(root: string, inputCapacityTokens = 20_000) {
  return createProjectRulesMiddleware({ runId: 'run', folders: [root], primaryFolder: root, getModelTokenCountingOptions: () => ({ protocol: 'openai_chat_completions' }), getInputCapacityTokens: () => inputCapacityTokens, accessMode: () => 'full_access' })
}
const writeCall = (id: string, path: string) => ({ id, name: 'delete_file', args: { path } })

describe('project rules graph middleware', () => {
  it('includes updated Responses instructions in the required-context budget', async () => {
    const root = await fixture()
    let instructions = ''
    const set = createProjectRulesMiddleware({ runId: 'run', folders: [root], primaryFolder: root,
      getInputCapacityTokens: () => 6000,
      getModelTokenCountingOptions: () => ({ protocol: 'openai_responses', parameters: { instructions } }),
      accessMode: () => 'full_access' })
    const model = new FakeToolCallingModel({ toolCalls: [[], []] })
    const agent = createAgent({ model, middleware: [set.middleware, set.guard] })
    await agent.invoke({ messages: [new HumanMessage('Inspect')] })
    instructions = 'x'.repeat(24_000)
    await expect(agent.invoke({ messages: [new HumanMessage('Inspect')] })).rejects.toThrow('safe capacity')
    expect(model.index).toBe(1)
  })

  it('budgets images and the active protocol’s duplicated tool text at the final request guard', async () => {
    const root = await fixture()
    let protocol: ModelProtocol = 'openai_responses'
    const set = createProjectRulesMiddleware({ runId: 'run', folders: [root], primaryFolder: root,
      getInputCapacityTokens: () => 2000, getModelTokenCountingOptions: () => ({ protocol }), accessMode: () => 'full_access' })
    const model = new FakeToolCallingModel({ toolCalls: [[], []] })
    const agent = createAgent({ model, middleware: [set.middleware, set.guard] })
    const messages = [new HumanMessage('Inspect'), new AIMessage({ content: '', tool_calls: [
      { id: 'image', name: 'capture', args: {} }
    ] }), new ToolMessage({ name: 'capture', tool_call_id: 'image', content: [
      { type: 'text', text: 'Image metadata '.repeat(100) },
      { type: 'image', source_type: 'base64', data: 'AA==', mime_type: 'image/png' }
    ] }), new HumanMessage('Continue')]
    await agent.invoke({ messages })
    protocol = 'openai_chat_completions'
    await expect(agent.invoke({ messages })).rejects.toThrow('safe capacity is 1744')
    expect(model.index).toBe(1)
  })

  it('checks the current input capacity on the next request without recreating the rules middleware', async () => {
    const root = await fixture()
    let inputCapacityTokens = 20_000
    const set = createProjectRulesMiddleware({ runId: 'run', folders: [root], primaryFolder: root,
      getModelTokenCountingOptions: () => ({ protocol: 'openai_chat_completions' }), getInputCapacityTokens: () => inputCapacityTokens, accessMode: () => 'full_access' })
    const model = new FakeToolCallingModel({ toolCalls: [[], []] })
    const agent = createAgent({ model, middleware: [set.middleware, set.guard] })
    await agent.invoke({ messages: [new HumanMessage('Inspect')] })
    inputCapacityTokens = 100
    await expect(agent.invoke({ messages: [new HumanMessage('Inspect')] })).rejects.toThrow('safe capacity is 0')
    expect(model.index).toBe(1)
  })

  it('uses the originating request budget when dispatching its tool calls', async () => {
    const root = await fixture()
    let inputCapacityTokens = 20_000
    const set = createProjectRulesMiddleware({ runId: 'run', folders: [root], primaryFolder: root,
      getModelTokenCountingOptions: () => ({ protocol: 'openai_chat_completions' }), getInputCapacityTokens: () => inputCapacityTokens, accessMode: () => 'full_access' })
    const write = vi.fn(async () => 'done')
    const model = new FakeToolCallingModel({ toolCalls: [[writeCall('write', join(root, 'a'))], []] })
    const changeAfterResponse = createMiddleware({ name: 'ChangeWindowAfterResponse', wrapModelCall: async (request, handler) => {
      const response = await handler(request)
      inputCapacityTokens = 100
      return response
    } })
    const agent = createAgent({ model,
      tools: [tool(write, { name: 'delete_file', description: 'Write', schema: z.object({ path: z.string() }) })],
      middleware: [set.middleware, set.guard, changeAfterResponse] })
    await expect(agent.invoke({ messages: [new HumanMessage('Edit a')] })).rejects.toThrow('safe capacity is 0')
    expect(write).toHaveBeenCalledOnce()
    expect(model.index).toBe(1)
  })

  it('includes the original user request when checking scoped rules after Skill projection', async () => {
    const root = await fixture()
    await writeFile(join(root, 'child/AGENTS.md'), 'RULE '.repeat(1000))
    const set = rules(root, 2000)
    const write = vi.fn(async () => 'must not write')
    const model = new FakeToolCallingModel({ toolCalls: [[writeCall('large', join(root, 'child/a'))], []] })
    const projection = createMiddleware({ name: 'SkillProjection', wrapModelCall: (request, handler) => handler({
      ...request, messages: projectSkillMessages(request.messages)
    }) })
    const agent = createAgent({ model, tools: [tool(write, { name: 'delete_file', description: 'Write', schema: z.object({ path: z.string() }) })],
      middleware: [set.middleware, projection, set.guard] })
    const command = `/edit ${'User requirements. '.repeat(170)}`.trim()
    const context = '<skill>\n<name>edit</name>\n<path>/skills/edit/SKILL.md</path>\nEdit the requested files.\n</skill>'
    await expect(agent.invoke({ messages: [toHumanMessage(`${command}\n\n${context}`, undefined, command)] })).rejects.toThrow('indivisible')
    expect(write).not.toHaveBeenCalled()
    expect(model.index).toBe(1)
  })

  it.each([null, 'wrong', 3, []])('returns malformed HTTP arguments %j before inspecting optional file targets', async args => {
    const root = await fixture(), set = rules(root)
    const execute = vi.fn(async () => 'Response')
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [
      [{ id: 'invalid', name: 'http_request', args: args as unknown as Record<string, unknown> }],
      [{ id: 'corrected', name: 'http_request', args: { url: 'https://example.test' } }], []
    ] }), tools: [tool(execute, { name: 'http_request', description: 'Read a URL.', schema: z.object({ url: z.string() }) })],
      middleware: [set.middleware, set.guard] })
    const result = await agent.invoke({ messages: [new HumanMessage('Read a URL.')] })
    expect(result.messages.filter(ToolMessage.isInstance)).toMatchObject([
      { tool_call_id: 'invalid', status: 'error' }, { tool_call_id: 'corrected', status: 'success' }
    ])
    expect(execute).toHaveBeenCalledOnce()
  })

  it('includes native structured response tools in the final request budget', async () => {
    const root = await fixture()
    const model = new FakeToolCallingModel({ toolCalls: [[]] })
    const set = createProjectRulesMiddleware({ runId: 'run', folders: [root], primaryFolder: root, getModelTokenCountingOptions: () => ({ protocol: 'openai_chat_completions' }), getInputCapacityTokens: () => 2000,
      accessMode: () => 'full_access', responseTools: [{ type: 'function', function: { name: 'report', description: 'x'.repeat(16_000), parameters: { type: 'object', properties: {} } } }] })
    const agent = createAgent({ model, middleware: [set.middleware, set.guard] })
    await expect(agent.invoke({ messages: [new HumanMessage('Review')] })).rejects.toThrow('safe capacity is 1744')
    expect(model.index).toBe(0)
  })
  it('requires all source and destination rules before dispatching an indivisible patch', async () => {
    const root = await fixture()
    await mkdir(join(root, 'target'))
    await writeFile(join(root, 'target/AGENTS.md'), 'DESTINATION RULE')
    const set = rules(root)
    const patch = vi.fn(async (input: unknown) => ({ status: 'applied', input }))
    const prompts: string[] = []
    const args = { summary: 'Edit together', patch: '*** Begin Patch\n*** Add File: new.txt\n+new\n*** Update File: child/a\n*** Move to: target/b\n*** End Patch' }
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [
      [{ id: 'discover', name: 'apply_patch', args }], [{ id: 'decided', name: 'apply_patch', args }], []
    ] }), tools: [tool(patch, { name: 'apply_patch', description: 'Patch files', schema: filePatchSchema })],
      middleware: [set.middleware, set.guard, createMiddleware({ name: 'CapturePatchRules', wrapModelCall: async (request, handler) => {
        prompts.push(request.systemMessage.text)
        if (prompts.length === 2) expect(patch).not.toHaveBeenCalled()
        return handler(request)
      } })] })
    const result = await agent.invoke({ messages: [new HumanMessage('Apply all edits')] })
    expect(prompts[1]).toContain('CHILD RULE')
    expect(prompts[1]).toContain('DESTINATION RULE')
    expect(patch).toHaveBeenCalledOnce()
    expect(patch.mock.calls[0][0]).toEqual(args)
    expect(result.messages.find((message) => ToolMessage.isInstance(message) && message.tool_call_id === 'discover')?.text).toContain('NOT EXECUTED')
  })

  it('never dispatches part of a patch whose combined rules exceed the request budget', async () => {
    const root = await fixture()
    await mkdir(join(root, 'target'))
    await writeFile(join(root, 'child/AGENTS.md'), 'A '.repeat(2200))
    await writeFile(join(root, 'target/AGENTS.md'), 'B '.repeat(2200))
    const set = rules(root, 2500)
    const patch = vi.fn(async () => 'must not run')
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[{ id: 'large', name: 'apply_patch',
      args: { summary: 'Move together', patch: '*** Begin Patch\n*** Update File: child/a\n*** Move to: target/b\n*** End Patch' } }], []] }),
      tools: [tool(patch, { name: 'apply_patch', description: 'Patch files', schema: filePatchSchema })],
      middleware: [set.middleware, set.guard] })
    await expect(agent.invoke({ messages: [new HumanMessage('Move')] })).rejects.toThrow('indivisible apply_patch')
    expect(patch).not.toHaveBeenCalled()
  })

  it('previews a patch with newly discovered rules as a read without requesting a new write decision', async () => {
    const root = await fixture(), set = rules(root)
    const preview = vi.fn(async () => 'previewed')
    const args = { dry_run: true, patch: '*** Begin Patch\n*** Add File: child/new.txt\n+new\n*** End Patch' }
    const prompts: string[] = []
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[{ id: 'preview', name: 'apply_patch', args }], []] }),
      tools: [tool(preview, { name: 'apply_patch', description: 'Preview files', schema: filePatchSchema })],
      middleware: [set.middleware, set.guard, createMiddleware({ name: 'CapturePreviewRules', wrapModelCall: async (request, handler) => {
        prompts.push(request.systemMessage.text)
        return handler(request)
      } })] })
    const result = await agent.invoke({ messages: [new HumanMessage('Preview child changes')] })
    expect(preview).toHaveBeenCalledOnce()
    expect(preview.mock.calls[0]).toEqual(expect.arrayContaining([args]))
    expect(result.messages.filter(ToolMessage.isInstance).at(-1)?.text).toBe('previewed')
    expect(prompts[1]).toContain('CHILD RULE')
  })

  it('rejects a patch link retargeted after rule preflight instead of hiding it behind a realpath', async () => {
    const root = await fixture()
    await writeFile(join(root, 'a'), 'before\n')
    await writeFile(join(root, 'child/b'), 'before\n')
    await symlink(join(root, 'a'), join(root, 'link'), 'file')
    const set = rules(root)
    const patch = vi.fn(async () => 'must not run')
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[{ id: 'race', name: 'apply_patch',
      args: { summary: 'Update link', patch: '*** Begin Patch\n*** Update File: link\n@@\n-before\n+after\n*** End Patch' } }], []] }),
      tools: [tool(patch, { name: 'apply_patch', description: 'Patch files', schema: filePatchSchema })],
      middleware: [createMiddleware({ name: 'RetargetAfterPreflight', wrapToolCall: async (request, handler) => {
        await unlink(join(root, 'link'))
        await symlink(join(root, 'child/b'), join(root, 'link'), 'file')
        return handler(request)
      } }), set.middleware, set.guard] })
    const result = await agent.invoke({ messages: [new HumanMessage('Edit link')] })
    expect(patch).not.toHaveBeenCalled()
    expect(result.messages.find((message) => ToolMessage.isInstance(message) && message.tool_call_id === 'race')?.text).toContain('targets changed')
  })
  it('compacts oversized tool results against the rule-reserved request budget', async () => {
    const root = await fixture()
    await writeFile(join(root, 'child/AGENTS.md'), 'R '.repeat(6100))
    const set = rules(root, 4000)
    const summaryModel = new FakeListChatModel({ responses: ['Continue the requested edit.'] })
    const summary = createAnasSummarizationMiddleware({ resolveRequest: () => ({ model: summaryModel, protocol: 'openai_chat_completions', inputCapacityTokens: 4000, threshold: 3000, enabled: true, modelContextKey: 'rules-test' }),
      backend: (runtime: BackendRuntime) => {
        const backend = new StateBackend(runtime)
        backend.write = () => ({ error: 'Conversation history offloading is disabled.' })
        return backend
      },
      outputLanguage: { code: 'en', name: 'English' } })
    const write = vi.fn(async () => 'SUCCESS '.repeat(400))
    const sentToolResults: string[] = []
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [
      [writeCall('discover', join(root, 'child/a'))], [writeCall('write', join(root, 'child/a'))], []
    ] }), tools: [tool(write, { name: 'delete_file', description: 'Write', schema: z.object({ path: z.string() }) })],
      middleware: [set.middleware, {
        ...summary,
        // The framework prefers request.model for summaries. Keep the tool
        // model's call sequence separate from the deterministic summarizer.
        wrapModelCall: (request, handler) => summary.wrapModelCall!({ ...request, model: summaryModel },
          (next) => handler({ ...next, model: request.model }))
      }, set.guard, createMiddleware({ name: 'QuietFake', wrapModelCall: async (request, handler) => {
        sentToolResults.push(...request.messages.filter(ToolMessage.isInstance).map((message) => message.text))
        if (write.mock.calls.length) expect(request.systemMessage.text).toContain('R '.repeat(6100))
        const response = await handler(request)
        response.content = ''
        return response
      } })] })
    await agent.invoke({ messages: [new HumanMessage('Edit child')] })
    expect(write).toHaveBeenCalledOnce()
    expect(sentToolResults.some((text) => text.includes('Tool result compacted for model context'))).toBe(true)
    expect(sentToolResults).not.toContain('SUCCESS '.repeat(400))
  })
  it.each(['restore', 'empty-path', 'blank-request-id'])('returns %s argument errors to the model without aborting the run', async (kind) => {
    const root = await fixture()
    const set = createProjectRulesMiddleware({ runId: 'a1234567-1234-4234-8234-123456789abc', folders: [root], primaryFolder: root, getModelTokenCountingOptions: () => ({ protocol: 'openai_chat_completions' }), getInputCapacityTokens: () => 20_000, accessMode: () => 'full_access' })
    const writes = vi.fn(async () => 'written')
    const restores = vi.fn(async () => 'must not run')
    const badCall = kind === 'empty-path' ? writeCall('bad', '') : { id: 'bad', name: 'restore_file_edit', args: { operation_id: 'mistyped/id', ...(kind === 'blank-request-id' ? { request_id: '  ' } : {}) } }
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[badCall], [writeCall('corrected', join(root, 'a'))], []] }),
      tools: [
        tool(writes, { name: 'delete_file', description: 'Write', schema: z.object({ path: z.string() }) }),
        tool(restores, { name: 'restore_file_edit', description: 'Restore', schema: z.object({ operation_id: z.string(), request_id: z.string().optional() }) })
      ], middleware: [set.middleware, set.guard] })
    const result = await agent.invoke({ messages: [new HumanMessage('Edit')] })
    const rejected = result.messages.find((message) => ToolMessage.isInstance(message) && message.tool_call_id === 'bad')
    expect(rejected?.text).toContain('NOT EXECUTED')
    expect(rejected?.text).toContain(kind === 'empty-path' ? 'Invalid file path' : 'operation_id is invalid')
    expect(restores).not.toHaveBeenCalled()
    expect(writes).toHaveBeenCalledOnce()
  })
  it('freezes additional roots but projects their rules only when those scopes are targeted', async () => {
    const root = await fixture()
    const other = await fixture()
    await writeFile(join(other, 'AGENTS.md'), 'OTHER ROOT RULE')
    const set = createProjectRulesMiddleware({ runId: 'run', folders: [root, other], primaryFolder: root, getModelTokenCountingOptions: () => ({ protocol: 'openai_chat_completions' }), getInputCapacityTokens: () => 20_000, accessMode: () => 'full_access' })
    const prompts: string[] = []
    const write = vi.fn(async () => 'done')
    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[writeCall('first', join(other, 'a'))], [writeCall('second', join(other, 'a'))], []] }),
      tools: [tool(write, { name: 'delete_file', description: 'Write', schema: z.object({ path: z.string() }) })],
      middleware: [set.middleware, set.guard, createMiddleware({ name: 'Capture', wrapModelCall: async (request, handler) => {
        prompts.push(request.systemMessage.text)
        if (prompts.length === 2) expect(write).not.toHaveBeenCalled()
        return handler(request)
      } })] })
    await agent.invoke({ messages: [new HumanMessage('Edit other root')] })
    expect(prompts[0]).not.toContain('OTHER ROOT RULE')
    expect(prompts[1]).toContain('OTHER ROOT RULE')
    expect(prompts[1]).not.toContain(`Source: ${JSON.stringify(join(root, 'AGENTS.md'))}`)
    expect(write).toHaveBeenCalledOnce()
  })
  it('preflights the entire parallel batch before any write, keeps reads runnable, and requires a newly generated call', async () => {
    const root = await fixture()
    const seen: string[] = []
    const write = vi.fn(async ({ path }: { path: string }) => {
      expect(seen.at(-1)).toContain('CHILD RULE')
      return `wrote:${path}`
    })
    const read = vi.fn(async () => 'read result')
    const set = rules(root)
    const model = new FakeToolCallingModel({ toolCalls: [
      [writeCall('root-first', join(root, 'a')), writeCall('child-first', join(root, 'child/b')), { id: 'read-first', name: 'read_file', args: { path: join(root, 'a') } }],
      [writeCall('child-redecided', join(root, 'child/c'))], []
    ] })
    const agent = createAgent({ model, systemPrompt: 'BASE', tools: [
      tool(write, { name: 'delete_file', description: 'Write', schema: z.object({ path: z.string() }) }),
      tool(read, { name: 'read_file', description: 'Read', schema: z.object({ path: z.string() }) })
    ], middleware: [set.middleware, set.guard, createMiddleware({ name: 'Capture', wrapModelCall: async (request, handler) => {
      seen.push(request.systemMessage.text)
      if (seen.length === 2) expect(write).not.toHaveBeenCalled()
      return handler(request)
    } })] })
    const result = await agent.invoke({ messages: [new HumanMessage('Edit both directories')] })
    expect(seen[0]).not.toContain('CHILD RULE')
    expect(write).toHaveBeenCalledOnce()
    expect(write.mock.calls[0][0].path).toBe(join(root, 'child/c'))
    expect(read).toHaveBeenCalledOnce()
    const blocked = result.messages.filter((message) => ToolMessage.isInstance(message) && message.text.includes('NOT EXECUTED'))
    expect(blocked).toHaveLength(2)
  })

  it('restores adopted rule contents from a checkpoint even when disk rules change', async () => {
    const root = await fixture()
    const saver = new MemorySaver()
    const config = { configurable: { thread_id: 'frozen' } }
    const write = vi.fn(async () => 'done')
    function agent(stop: boolean) {
      const set = rules(root)
      return createAgent({
        model: new FakeToolCallingModel({ index: stop ? 0 : 1, toolCalls: [[writeCall('one', join(root, 'child/a'))], [writeCall('two', join(root, 'child/b'))], []] }),
        tools: [tool(write, { name: 'delete_file', description: 'Write', schema: z.object({ path: z.string() }) })],
        checkpointer: saver,
        middleware: [set.middleware, set.guard, createMiddleware({ name: 'Stop', wrapModelCall: async (request, handler) => {
          if (request.systemMessage.text.includes('CHILD RULE')) {
            if (stop) throw new Error('simulated stopped process')
            expect(request.systemMessage.text).not.toContain('CHANGED')
          }
          return handler(request)
        } })]
      })
    }
    await expect(agent(true).invoke({ messages: [new HumanMessage('Edit child')] }, config)).rejects.toThrow('simulated stopped process')
    expect(write).not.toHaveBeenCalled()
    await writeFile(join(root, 'child/AGENTS.md'), 'CHANGED')
    await agent(false).invoke(null, config)
    expect(write).toHaveBeenCalled()
  })

  it('terminates oversized indivisible scopes before any write and never calls the model again', async () => {
    const root = await fixture()
    await writeFile(join(root, 'child/AGENTS.md'), 'LONG '.repeat(1500))
    const set = rules(root, 1500)
    const write = vi.fn(async () => 'must not write')
    const model = new FakeToolCallingModel({ toolCalls: [[writeCall('large', join(root, 'child/a'))], []] })
    const agent = createAgent({ model, tools: [tool(write, { name: 'delete_file', description: 'Write', schema: z.object({ path: z.string() }) })], middleware: [set.middleware, set.guard] })
    await expect(agent.invoke({ messages: [new HumanMessage('Edit child')] })).rejects.toThrow('indivisible')
    expect(write).not.toHaveBeenCalled()
    expect(model.index).toBe(1)
  })

  it.each(['removed rules', 'larger tools', 'larger messages'])('rechecks final requests after %s', async (change) => {
    const root = await fixture()
    const set = rules(root, 1500)
    const model = new FakeToolCallingModel({ toolCalls: [[], []] })
    const alteration = createMiddleware({ name: 'ChangedRequest', wrapModelCall: async (request, handler) => handler({
      ...request,
      ...(change === 'removed rules' ? { systemMessage: new SystemMessage('Summary without rules') } : {}),
      ...(change === 'larger messages' ? { messages: [new HumanMessage('x'.repeat(12_000))] } : {}),
      ...(change === 'larger tools' ? { tools: [tool(async () => '', { name: 'large', description: 'x'.repeat(12_000), schema: z.object({}) })] } : {})
    }) })
    const agent = createAgent({ model, middleware: [set.middleware, alteration, set.guard] })
    await expect(agent.invoke({ messages: [new HumanMessage('Hello')] })).rejects.toThrow('Project rules cannot be applied')
    expect(model.index).toBe(0)
  })

  it('preserves rules outside summarized history and validates each repeated send', async () => {
    const root = await fixture()
    const set = rules(root)
    const model = new FakeToolCallingModel({ toolCalls: [[], []] })
    const captured: string[] = []
    const compression = createMiddleware({ name: 'CompressionRetry', wrapModelCall: async (request, handler) => {
      await handler({ ...request, messages: [new HumanMessage('SUMMARY')] })
      return handler({ ...request, messages: [new HumanMessage('SMALLER SUMMARY')] })
    } })
    const agent = createAgent({ model, middleware: [set.middleware, compression, set.guard, createMiddleware({ name: 'Capture', wrapModelCall: async (request, handler) => {
      captured.push(request.systemMessage.text)
      return handler(request)
    } })] })
    await agent.invoke({ messages: [new HumanMessage('Task')] })
    expect(captured).toHaveLength(2)
    expect(captured.every((text) => text.includes('ROOT RULE'))).toBe(true)
  })

  it('uses native approval before reading rules outside trusted folders', async () => {
    const root = await fixture()
    await writeFile(join(root, '.git'), 'worktree marker')
    const set = createProjectRulesMiddleware({ runId: 'run', folders: [join(root, 'child')], primaryFolder: join(root, 'child'), getModelTokenCountingOptions: () => ({ protocol: 'openai_chat_completions' }), getInputCapacityTokens: () => 20_000, accessMode: () => 'strict_approval' })
    const model = new FakeToolCallingModel({ toolCalls: [[], []] })
    const agent = createAgent({ model, checkpointer: new MemorySaver(), middleware: [set.middleware, set.guard] })
    const config = { configurable: { thread_id: 'approval' } }
    const paused = await agent.invoke({ messages: [new HumanMessage('Inspect')] }, config)
    expect(paused.__interrupt__).toHaveLength(1)
    expect(model.index).toBe(0)
    await agent.invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), config)
    expect(model.index).toBe(1)
  })

  it('rejects a combined rule budget but allows model-selected independent batches', async () => {
    const root = await fixture()
    await mkdir(join(root, 'other'))
    await writeFile(join(root, 'child/AGENTS.md'), 'A '.repeat(1500))
    await writeFile(join(root, 'other/AGENTS.md'), 'B '.repeat(1500))
    const set = rules(root, 2000)
    const write = vi.fn(async () => 'done')
    const a = join(root, 'child/a')
    const b = join(root, 'other/b')
    const model = new FakeToolCallingModel({ toolCalls: [
      [writeCall('batch-a', a), writeCall('batch-b', b)],
      [writeCall('select-a', a)], [writeCall('write-a', a)],
      [writeCall('select-b', b)], [writeCall('write-b', b)], []
    ] })
    const agent = createAgent({ model, tools: [tool(write, { name: 'delete_file', description: 'Write', schema: z.object({ path: z.string() }) })],
      middleware: [set.middleware, set.guard, createMiddleware({ name: 'QuietFake', wrapModelCall: async (request, handler) => {
        const response = await handler(request)
        response.content = ''
        return response
      } })] })
    const result = await agent.invoke({ messages: [new HumanMessage('Edit')] })
    expect(write).toHaveBeenCalledTimes(2)
    expect(result.messages.filter((message) => ToolMessage.isInstance(message) && message.text.includes('rule union'))).toHaveLength(2)
  })

  it('checks both sides and descendant scopes of an indivisible directory move', async () => {
    const root = await fixture()
    await mkdir(join(root, 'child/deep'))
    await writeFile(join(root, 'child/deep/AGENTS.md'), 'DEEP RULE')
    await mkdir(join(root, 'target'))
    await writeFile(join(root, 'target/AGENTS.md'), 'DESTINATION RULE')
    const set = rules(root)
    const move = vi.fn(async () => 'moved')
    const call = (id: string) => ({ id, name: 'move_file', args: { source: join(root, 'child'), destination: join(root, 'target') } })
    const prompts: string[] = []
    const agent = createAgent({
      model: new FakeToolCallingModel({ toolCalls: [[call('first')], [call('again')], []] }),
      tools: [tool(move, { name: 'move_file', description: 'Move', schema: z.object({ source: z.string(), destination: z.string() }) })],
      middleware: [set.middleware, set.guard, createMiddleware({ name: 'Capture', wrapModelCall: async (request, handler) => {
        prompts.push(request.systemMessage.text)
        if (prompts.length === 2) expect(move).not.toHaveBeenCalled()
        return handler(request)
      } })]
    })
    await agent.invoke({ messages: [new HumanMessage('Move directory')] })
    expect(prompts[1]).toContain('DEEP RULE')
    expect(prompts[1]).toContain('DESTINATION RULE')
    expect(move).toHaveBeenCalledOnce()
  })

  it('persists terminal budget failures so a restored graph cannot reread fixed files and retry', async () => {
    const root = await fixture()
    await writeFile(join(root, 'child/AGENTS.md'), 'LONG '.repeat(1500))
    const saver = new MemorySaver()
    const write = vi.fn(async () => 'must not write')
    const config = { configurable: { thread_id: 'terminal-budget' } }
    function agent() {
      const set = rules(root, 1500)
      return createAgent({ model: new FakeToolCallingModel({ toolCalls: [[writeCall('large', join(root, 'child/a'))], []] }),
        checkpointer: saver, tools: [tool(write, { name: 'delete_file', description: 'Write', schema: z.object({ path: z.string() }) })], middleware: [set.middleware, set.guard] })
    }
    const first = agent()
    await expect(first.invoke({ messages: [new HumanMessage('Edit')] }, config)).rejects.toThrow('indivisible')
    expect((await first.getState(config) as StateSnapshot).values.anasProjectRules.fatalError).toContain('indivisible')
    await writeFile(join(root, 'child/AGENTS.md'), 'SHORT')
    await expect(agent().invoke(null, config)).rejects.toThrow('indivisible')
    expect(write).not.toHaveBeenCalled()
  })
})
