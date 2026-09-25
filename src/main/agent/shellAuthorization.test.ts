import { AIMessage, ToolMessage } from '@langchain/core/messages'
import { Command, interrupt, MemorySaver } from '@langchain/langgraph'
import { createAgent, createMiddleware, FakeToolCallingModel, tool } from 'langchain'
import { expect, it, vi } from 'vitest'
import { z } from 'zod/v3'
import type { AgentAccessMode } from '@shared/agentTypes'
import type { ShellCommandPlan } from '../shellCommandAuthorization'
import { createToolApprovalMiddleware } from './toolApprovalMiddleware'
import { createShellAuthorizationMiddleware, shellAuthorizationFor, verifyCurrentShellAuthorization } from './shellAuthorization'
import { createRuntimeTools } from '../llm/runtimeTools'
import { AgentDatabase } from './agentDatabase'
import { createAgentToolEffectMiddleware } from './toolEffectMiddleware'
import { createToolInputErrorMiddleware, createToolInputValidationMiddleware } from './toolInputErrors'
import { toHumanMessage } from './messageMapper'
import type { SkillScriptInvocation } from '../skillsStore'

it.each([
  { args: JSON.parse('{"command":"Get-Date","timeout":1e400}'), field: '/timeout' },
  { args: { command: 'Get-Date', extra: { values: [Infinity] } }, field: '/extra/values/0' },
  { args: { command: ' \n\t' }, field: 'command' },
  { args: { command: 'Read-Host', pty: { columns: 100, rows: 30 }, keep_processes: true }, field: 'keep_processes' }
])('returns invalid $field before shell preflight, approval or effect preparation', async ({ args, field }) => {
  const database = AgentDatabase.open(':memory:')
  try {
    const thread = database.createThread(), run = database.createRun(thread.id, 'shell-input')
    const execute = vi.fn(async () => { await verifyCurrentShellAuthorization(); return 'Executed' })
    const tools = (await createRuntimeTools({ enabled: true, primaryFolder: process.cwd(), memory: false, network: false,
      shell: true, mcp: false, commandShell: { executable: 'pwsh.exe', name: 'PowerShell', family: 'powershell' },
      backgroundTools: true, threadId: thread.id, shellRunner: execute,
      managedCalls: { read: vi.fn(), readOutput: vi.fn(), readResult: vi.fn(), wait: vi.fn(), cancel: vi.fn(), start: vi.fn(), writeTerminal: vi.fn() }
    })).filter(item => item.name === 'pwsh')
    const analyzer = { inspect: vi.fn(async (_args: Readonly<Record<string, unknown>>) => undefined), requiresApproval: vi.fn() }
    const prepare = vi.spyOn(database, 'prepareToolEffect')
    const model = new FakeToolCallingModel({ toolCalls: [
      [{ id: 'invalid', name: 'pwsh', args }], [{ id: 'corrected', name: 'pwsh', args: { command: 'Get-Date' } }], []
    ] })
    const makeAgent = () => createAgent({ model, tools, checkpointer: database.checkpointer, middleware: [
      createToolInputErrorMiddleware(),
      createToolApprovalMiddleware({ pwsh: { allowedDecisions: ['approve', 'reject'], when: request =>
        shellAuthorizationFor(request.state, request.toolCall, run.id)?.requiresApproval === true } }, tools),
      createShellAuthorizationMiddleware({ runId: run.id, toolName: 'pwsh', analyzer, accessMode: () => 'strict_approval' }),
      createToolInputValidationMiddleware(tools),
      createAgentToolEffectMiddleware({ database, runId: run.id, threadId: thread.id, tools })
    ] })
    const config = { configurable: { thread_id: thread.id } }
    const paused = await makeAgent().invoke({ messages: [{ role: 'user', content: 'Run the command.' }] }, config)
    expect(paused.messages.filter(ToolMessage.isInstance)).toMatchObject([
      { tool_call_id: 'invalid', status: 'error', content: expect.stringContaining(field) }
    ])
    expect(paused.messages.find(AIMessage.isInstance)?.tool_calls?.[0].args).toEqual(args)
    expect(paused.__interrupt__![0].value).toMatchObject({ actionRequests: [{ name: 'pwsh', args: { command: 'Get-Date' } }] })
    expect(analyzer.inspect.mock.calls.map(([input]) => input)).toEqual([{ command: 'Get-Date' }])
    expect(prepare).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
    const completed = await makeAgent().invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), config)
    expect(completed.messages.filter(ToolMessage.isInstance)).toMatchObject([
      { tool_call_id: 'invalid', status: 'error' }, { tool_call_id: 'corrected', content: 'Executed' }
    ])
    expect(prepare).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledOnce()
  } finally { database.close() }
})

function fixture(commands = ['rg -n needle .']) {
  const saver = new MemorySaver()
  const config = { configurable: { thread_id: 'original-shell' } }
  let mode: AgentAccessMode = 'strict_approval'
  let target = '/project/original'
  let supported = true
  let skillScript: ShellCommandPlan['skillScript']
  const analyzer = {
    inspect: vi.fn(async (args: Readonly<Record<string, unknown>>, _invocation?: SkillScriptInvocation): Promise<ShellCommandPlan | undefined> => supported && args.command !== 'unknown command'
      ? { workingDir: '/project', executable: '/shell', paths: [target], ...(skillScript ? { skillScript } : {}) } : undefined),
    requiresApproval: vi.fn()
  }
  const run = vi.fn(async (args: { command: string; working_dir?: string }) => {
    // Keep the real check at dispatch, not just entry into the middleware. Async
    // work may be deferred by managed background tools before the runner starts.
    await new Promise<void>((resolve) => setImmediate(resolve))
    await verifyCurrentShellAuthorization()
    return args.command
  })
  const calls = commands.map((command, i) => ({ id: `call-${i}`, name: 'shell', args: { command, working_dir: '.' } }))
  const tools = [tool(run, { name: 'shell', description: 'Shell fixture', schema: z.object({ command: z.string(), working_dir: z.string().optional() }) })]
  const create = (pause = false, resume = false, runId = 'run') => createAgent({
    checkpointer: saver,
    model: new FakeToolCallingModel({ toolCalls: [calls, []], index: resume ? 1 : 0 }),
    tools,
    middleware: [createToolApprovalMiddleware({ shell: { allowedDecisions: ['approve', 'reject'], when: (request) =>
      mode !== 'full_access' && (shellAuthorizationFor(request.state, request.toolCall, runId)?.requiresApproval ?? true) } }, tools),
    createShellAuthorizationMiddleware({ runId, toolName: 'shell', analyzer, accessMode: () => mode }),
    createMiddleware({ name: 'PauseBeforeDispatch', wrapToolCall: (request, handler) => {
      if (pause) interrupt('before dispatch')
      return handler(request)
    } })]
  })
  return { create, run, saver, config, calls, analyzer,
    skill: (value: ShellCommandPlan['skillScript']) => { skillScript = value },
    mode: (value: AgentAccessMode) => { mode = value },
    target: (value: string) => { target = value },
    supported: (value: boolean) => { supported = value } }
}

it.each(['revoke', 'skillId', 'root', 'script', 'executor'] as const)('rechecks Skill exemption %s before delayed dispatch after runtime recreation', async change => {
  const h = fixture(['python scripts/query.py --month 2026-09'])
  const binding = { skillId: 'user:query', root: '/skills/query', script: '/skills/query/scripts/query.py', executor: '/python' }
  h.skill(binding)
  await h.create(true).invoke({ messages: [{ role: 'user', content: 'Run the Skill script.' }] }, h.config)
  const checkpoint = await h.saver.get(h.config)
  expect(checkpoint?.channel_values.anasShellAuthorization).toMatchObject({ calls: [{ humanApproved: false, plan: { skillScript: binding } }] })
  if (change === 'revoke') h.supported(false)
  else h.skill({ ...binding, [change]: '/changed' })
  await expect(h.create(false, true).invoke(null, h.config)).rejects.toThrow('targets changed')
  // Entering the runner is not dispatch: its verifier must reject first.
})

it('passes only the latest host-recorded explicit Skill invocation to both authorization checks', async () => {
  const h = fixture(['python scripts/query.py'])
  const user = toHumanMessage('/query@user report\n\n<skill>instructions</skill>', undefined, '/query@user report')
  await h.create().invoke({ messages: [user] }, h.config)
  expect(h.analyzer.inspect.mock.calls.map(([, invocation]) => invocation)).toEqual([
    expect.objectContaining({ name: 'query', sourceAlias: 'user' }),
    expect.objectContaining({ name: 'query', sourceAlias: 'user' })
  ])
})

it('checkpoints original arguments and separate read bindings; dispatch still works after runtime recreation', async () => {
  const h = fixture(['# original comment\n rg -n needle .  ', 'Get-Content notes.txt | Select-Object -First 1'])
  const original = structuredClone(h.calls)
  const paused = await h.create(true).invoke({ messages: [{ role: 'user', content: 'Read' }] }, h.config)
  expect(paused.__interrupt__).toHaveLength(2)
  expect(h.run).not.toHaveBeenCalled()
  const checkpoint = await h.saver.get(h.config)
  const messages = checkpoint?.channel_values.messages as AIMessage[]
  expect(messages.find(AIMessage.isInstance)?.tool_calls?.map(({ id, name, args }) => ({ id, name, args }))).toEqual(original)
  expect(checkpoint?.channel_values.anasShellAuthorization).toMatchObject({ runId: 'run', calls: [
    { id: 'call-0', humanApproved: false, plan: { paths: ['/project/original'] } },
    { id: 'call-1', humanApproved: false, plan: { paths: ['/project/original'] } }
  ] })
  const result = await h.create(false, true).invoke(null, h.config)
  expect(result.messages.filter(ToolMessage.isInstance).map((message) => message.text).sort()).toEqual(original.map((call) => call.args.command).sort())
  expect(h.run.mock.calls.map(([args]) => args).sort((a, b) => a.command.localeCompare(b.command)))
    .toEqual(original.map((call) => call.args).sort((a, b) => a.command.localeCompare(b.command)))
})

it.each(['target', 'unsupported', 'run'] as const)('does not dispatch a stale auto-approval after %s changes', async (change) => {
  const h = fixture()
  await h.create(true).invoke({ messages: [{ role: 'user', content: 'Read' }] }, h.config)
  if (change === 'target') h.target('/project/other')
  if (change === 'unsupported') h.supported(false)
  const resumed = h.create(false, true, change === 'run' ? 'other-run' : 'run')
  await expect(resumed.invoke(null, h.config)).rejects.toThrow(/authorization|targets changed/)
})

it.each(['approve', 'reject'] as const)('keeps unknown original commands under native %s after resume', async (decision) => {
  const h = fixture(['rg --pre custom-helper needle . > output.txt'])
  h.supported(false)
  const paused = await h.create().invoke({ messages: [{ role: 'user', content: 'Run' }] }, h.config)
  expect(paused.__interrupt__![0].value).toMatchObject({ actionRequests: [{ args: h.calls[0].args }] })
  const result = await h.create(false, true).invoke(new Command({ resume: { decisions: [{ type: decision }] } }), h.config)
  expect(h.run).toHaveBeenCalledTimes(decision === 'approve' ? 1 : 0)
  if (decision === 'approve') {
    expect(result.messages.filter(ToolMessage.isInstance).at(-1)?.text).toBe(h.calls[0].args.command)
  }
})

it('does not turn a full-access exemption into a durable human grant', async () => {
  const h = fixture(['unknown command'])
  h.mode('full_access')
  await h.create(true).invoke({ messages: [{ role: 'user', content: 'Run' }] }, h.config)
  h.mode('strict_approval')
  await expect(h.create(false, true).invoke(null, h.config)).rejects.toThrow('access mode changed')
})

it('executes full-access commands unchanged without invoking read analysis', async () => {
  const h = fixture(['unknown command'])
  h.mode('full_access')
  const result = await h.create().invoke({ messages: [{ role: 'user', content: 'Run' }] }, h.config)
  expect(h.analyzer.inspect).not.toHaveBeenCalled()
  expect(result.messages.filter(ToolMessage.isInstance).at(-1)?.text).toBe('unknown command')
})

it('does not treat a former command marker as authorization', async () => {
  const h = fixture(['# Anas verified read\nunknown command'])
  h.supported(false)
  const result = await h.create().invoke({ messages: [{ role: 'user', content: 'Run' }] }, h.config)
  expect(result.__interrupt__).toHaveLength(1)
  expect(h.run).not.toHaveBeenCalled()
})

it('rejects a runner without checkpointed invocation scope', async () => {
  await expect(verifyCurrentShellAuthorization()).rejects.toThrow('checkpointed authorization')
})

it('keeps human approval isolated from auto-approved calls in the same batch', async () => {
  const h = fixture(['rg -n needle .', 'unknown command'])
  const paused = await h.create(true).invoke({ messages: [{ role: 'user', content: 'Run both' }] }, h.config)
  expect(paused.__interrupt__![0].value).toMatchObject({ actionRequests: [{ args: h.calls[1].args }] })
  await h.create(true, true).invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), h.config)
  const checkpoint = await h.saver.get(h.config)
  expect(checkpoint?.channel_values.anasShellAuthorization).toMatchObject({ calls: [
    { id: 'call-0', requiresApproval: false, humanApproved: false },
    { id: 'call-1', requiresApproval: true, humanApproved: true }
  ] })
  const completed = await h.create(false, true).invoke(null, h.config)
  expect(completed.messages.filter(ToolMessage.isInstance).map((item) => item.text).sort()).toEqual(h.calls.map((call) => call.args.command).sort())
})
