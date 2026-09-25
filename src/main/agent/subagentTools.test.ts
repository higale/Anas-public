import { defaultCapabilities, } from '@shared/agentCapabilities'
import { describe, expect, it, vi } from 'vitest'
import { interrupt } from '@langchain/langgraph'
import { ToolMessage } from '@langchain/core/messages'
import { createAgent, FakeToolCallingModel } from 'langchain'
import { createToolInputErrorMiddleware } from './toolInputErrors'
import type { SubagentConfig } from '@shared/types'
import type { AgentSubagentCallRecord } from './agentDatabase'
import { createSubagentTools, type SubagentProcessSnapshot, type SubagentToolRuntime } from './subagentTools'
import { runWithCurrentAgentToolEffect } from './toolEffectScope'

vi.mock('@langchain/langgraph', async (importOriginal) => ({
  ...await importOriginal<typeof import('@langchain/langgraph')>(),
  interrupt: vi.fn(() => ({
    decisions: [{ type: 'approve' }],
    __anas_interrupt_generation: 'generation-1'
  }))
}))

const reviewer: SubagentConfig = {
 capabilities: { ...structuredClone(defaultCapabilities), profile: false, workspace: true, memory: true, toolMode: 'all', tools: [], skills: { enabled: true, mode: 'default', project: false, entries: [] } },
  index: 0,
  name: 'reviewer',
  enabled: true,
  builtIn: false,
  description: 'Review changes.',
  systemPrompt: 'Review the delegated changes.',
}

function snapshot(overrides: Partial<AgentSubagentCallRecord> = {}): SubagentProcessSnapshot {
  return {
    call: {
      id: '11111111-1111-8111-8111-111111111111',
      ownerThreadId: 'owner',
      parentThreadId: 'parent',
      parentRunId: 'run',
      childThreadId: 'child',
      childRunId: 'child-run',
      agentName: 'reviewer',
      config: reviewer,
      description: 'Review the code.',
      status: 'running',
      createdAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z',
      ...overrides
    },
    modelRounds: 1,
    toolCalls: 2,
    activeTools: [],
    interrupts: [],
    approvalGeneration: 'generation-1'
  }
}

function runtime(current: SubagentProcessSnapshot): SubagentToolRuntime {
  return {
    start: vi.fn(async () => current),
    read: vi.fn(async () => current),
    wait: vi.fn(async () => current),
    cancel: vi.fn(async () => current),
    resume: vi.fn(async () => undefined),
    unresolvedForRun: vi.fn(() => []),
    resolveObserved: vi.fn(),
    cancelRun: vi.fn(async () => undefined)
  }
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('subagent tools', () => {
  it('exposes only the asynchronous subagent lifecycle', () => {
    expect(createSubagentTools({
      subagents: [reviewer]
    }).map((tool) => tool.name)).toEqual([
      'start_subagent',
      'read_subagent',
      'wait_subagent',
      'cancel_subagent'
    ])
  })

  it.each([true, false])('starts a selected subagent independently of global default enabled (%s)', async (enabled) => {
    const current = snapshot()
    const service = runtime(current)
    const start = createSubagentTools({
      runtime: service,
      subagents: [{ ...reviewer, enabled }]
    }).find((tool) => tool.name === 'start_subagent')!

    const result = JSON.parse(await start.invoke({
      agent: 'reviewer',
      description: 'Review the code.'
    }) as string) as Record<string, unknown>

    expect(service.start).toHaveBeenCalledWith(
      { agentName: 'reviewer', config: { ...reviewer, enabled } },
      'Review the code.',
      expect.objectContaining({
        subagentId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        childThreadId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        childRunId: expect.stringMatching(/^[0-9a-f-]{36}$/)
      }),
      expect.any(Function)
    )
    expect(result).toMatchObject({
      subagent_id: current.call.id,
      status: 'running',
      terminal: false,
      model_rounds: 1,
      tool_calls: 2
    })
  })

  it('lets the runtime arm start and cancel only after their pure validation', async () => {
    const service = runtime(snapshot())
    const tools = createSubagentTools({
      runtime: service,
      subagents: [reviewer]
    })
    const start = tools.find((tool) => tool.name === 'start_subagent')!
    const cancel = tools.find((tool) => tool.name === 'cancel_subagent')!
    const arm = vi.fn()

    await runWithCurrentAgentToolEffect({ arm }, () => start.invoke({
      agent: 'reviewer',
      description: 'Review the code.'
    }))
    await runWithCurrentAgentToolEffect({ arm }, () => cancel.invoke({
      subagent_id: '11111111-1111-8111-8111-111111111111'
    }))

    expect(arm).not.toHaveBeenCalled()
    expect(service.start).toHaveBeenCalledWith(
      { agentName: 'reviewer', config: reviewer },
      'Review the code.',
      expect.any(Object),
      expect.any(Function)
    )
    expect(service.cancel).toHaveBeenCalledWith(
      '11111111-1111-8111-8111-111111111111',
      expect.any(Function)
    )
    const startArm = vi.mocked(service.start).mock.calls[0][3]
    const cancelArm = vi.mocked(service.cancel).mock.calls[0][1]
    runWithCurrentAgentToolEffect({ arm }, startArm)
    runWithCurrentAgentToolEffect({ arm }, cancelArm)
    expect(arm).toHaveBeenNthCalledWith(1, expect.objectContaining({
      kind: 'subagent-start',
      recoveryMode: 'idempotent'
    }))
    expect(arm).toHaveBeenNthCalledWith(2, {
      kind: 'subagent-cancel',
      target: { subagentId: '11111111-1111-8111-8111-111111111111' },
      recoveryMode: 'idempotent'
    })
  })

  it('keeps a durable start replay reachable without a currently configured agent', async () => {
    const service = runtime(snapshot())
    const tools = createSubagentTools({
      runtime: service,
      subagents: [],
      includeStartForRecovery: true
    })
    expect(tools.map((tool) => tool.name)).toEqual([
      'start_subagent',
      'read_subagent',
      'wait_subagent',
      'cancel_subagent'
    ])
    await tools.find((tool) => tool.name === 'start_subagent')?.invoke({
      agent: 'reviewer',
      description: 'Resume the durable launch.'
    })
    expect(service.start).toHaveBeenCalledWith(
      { agentName: 'reviewer' },
      'Resume the durable launch.',
      expect.any(Object),
      expect.any(Function)
    )
  })

  it('allows only one wait and approval lifecycle per subagent at a time', async () => {
    const waitingForApproval = {
      ...snapshot({ status: 'interrupted' }),
      interrupts: [{
        id: 'approval-1',
        approvalGeneration: 'generation-1',
        value: { actionRequests: [{ name: 'apply_patch', args: { path: 'result.txt' } }] }
      }]
    }
    const completed = snapshot({ status: 'completed', result: 'Reviewed.' })
    const resumeGate = deferred<void>()
    const service = runtime(waitingForApproval)
    service.wait = vi.fn()
      .mockResolvedValueOnce(waitingForApproval)
      .mockResolvedValueOnce(completed)
      .mockResolvedValueOnce(completed)
    service.resume = vi.fn(() => resumeGate.promise)
    const wait = createSubagentTools({
      runtime: service,
      subagents: [reviewer]
    }).find((tool) => tool.name === 'wait_subagent')!
    const input = {
      subagent_id: '11111111-1111-8111-8111-111111111111',
      timeout: 10
    }

    const first = wait.invoke(input)
    await vi.waitFor(() => expect(service.resume).toHaveBeenCalledOnce())

    const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[
      { id: 'duplicate-wait', name: wait.name, args: input }
    ], []] }), tools: [wait], middleware: [createToolInputErrorMiddleware()] })
    const result = await agent.invoke({ messages: [{ role: 'user', content: 'Wait again.' }] })
    expect(result.messages.filter(ToolMessage.isInstance)).toMatchObject([{
      tool_call_id: 'duplicate-wait', status: 'error', content: expect.stringContaining('already has an active wait')
    }])
    expect(service.wait).toHaveBeenCalledOnce()
    expect(interrupt).toHaveBeenCalledOnce()

    resumeGate.resolve()
    await expect(first).resolves.toContain('"status":"completed"')
    expect(service.wait).toHaveBeenCalledTimes(2)
    expect(service.resume).toHaveBeenCalledOnce()

    await expect(wait.invoke(input)).resolves.toContain('"status":"completed"')
    expect(service.wait).toHaveBeenCalledTimes(3)
  })

  it('presents parallel child approvals together and resumes them atomically', async () => {
    const waitingForApproval = {
      ...snapshot({ status: 'interrupted' }),
      interrupts: [{
        id: 'approval-1',
        approvalGeneration: 'generation-1',
        value: {
          actionRequests: [{ name: 'apply_patch', args: { path: 'first.txt' } }],
          reviewConfigs: [{ actionName: 'apply_patch', allowedDecisions: ['approve', 'reject'] }]
        }
      }, {
        id: 'approval-2',
        approvalGeneration: 'generation-1',
        value: {
          actionRequests: [{ name: 'pwsh', args: { command: 'npm test' } }],
          reviewConfigs: [{ actionName: 'pwsh', allowedDecisions: ['approve', 'reject'] }]
        }
      }]
    }
    const completed = snapshot({ status: 'completed', result: 'Done.' })
    const service = runtime(waitingForApproval)
    service.wait = vi.fn()
      .mockResolvedValueOnce(waitingForApproval)
      .mockResolvedValueOnce(completed)
    vi.mocked(interrupt).mockReturnValueOnce({
      decisions: [{ type: 'approve' }, { type: 'reject', message: 'Skip command.' }],
      __anas_interrupt_generation: 'generation-1'
    } as never)
    const wait = createSubagentTools({
      runtime: service,
      subagents: [reviewer]
    }).find((tool) => tool.name === 'wait_subagent')!

    await expect(wait.invoke({
      subagent_id: '11111111-1111-8111-8111-111111111111',
      timeout: 10
    })).resolves.toContain('"status":"completed"')

    expect(interrupt).toHaveBeenCalledOnce()
    expect(interrupt).toHaveBeenCalledWith({
      actionRequests: [
        { name: 'apply_patch', args: { path: 'first.txt' } },
        { name: 'pwsh', args: { command: 'npm test' } }
      ],
      reviewConfigs: [
        { actionName: 'apply_patch', allowedDecisions: ['approve', 'reject'] },
        { actionName: 'pwsh', allowedDecisions: ['approve', 'reject'] }
      ],
      anasSubagentApproval: { generation: 'generation-1' }
    })
    expect(service.resume).toHaveBeenCalledOnce()
    expect(service.resume).toHaveBeenCalledWith(
      '11111111-1111-8111-8111-111111111111',
      [{
        interruptId: 'approval-1',
        decisions: [{ type: 'approve' }],
        expectedGeneration: 'generation-1'
      }, {
        interruptId: 'approval-2',
        decisions: [{ type: 'reject', message: 'Skip command.' }],
        expectedGeneration: 'generation-1'
      }]
    )
  })

  it('never applies a stale approval response to a later subagent interrupt generation', async () => {
    const waitingForApproval = {
      ...snapshot({ status: 'interrupted' }),
      approvalGeneration: 'generation-2',
      interrupts: [{
        id: 'approval-2',
        approvalGeneration: 'generation-2',
        value: { actionRequests: [{ name: 'apply_patch', args: { path: 'second.txt' } }] }
      }]
    }
    const completed = snapshot({ status: 'completed', result: 'Done.' })
    const service = runtime(waitingForApproval)
    service.wait = vi.fn()
      .mockResolvedValueOnce(waitingForApproval)
      .mockResolvedValueOnce(completed)
    vi.mocked(interrupt)
      .mockReturnValueOnce({
        decisions: [{ type: 'approve' }],
        __anas_interrupt_generation: 'generation-1'
      } as never)
      .mockReturnValueOnce({
        decisions: [{ type: 'reject', message: 'Review the new request.' }],
        __anas_interrupt_generation: 'generation-2'
      } as never)
    const wait = createSubagentTools({
      runtime: service,
      subagents: [reviewer]
    }).find((tool) => tool.name === 'wait_subagent')!

    await expect(wait.invoke({
      subagent_id: waitingForApproval.call.id,
      timeout: 10
    })).resolves.toContain('"status":"completed"')

    expect(interrupt).toHaveBeenCalledTimes(2)
    expect(service.resume).toHaveBeenCalledWith(waitingForApproval.call.id, [{
      interruptId: 'approval-2',
      decisions: [{ type: 'reject', message: 'Review the new request.' }],
      expectedGeneration: 'generation-2'
    }])
  })
})
