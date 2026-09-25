import { describe, expect, it, vi } from 'vitest'
import { createAgent, FakeToolCallingModel } from 'langchain'
import { Command, MemorySaver } from '@langchain/langgraph'
import { createRuntimeTools } from '../llm/runtimeTools'
import { createInterruptPolicy } from './agentFactory'
import { createToolApprovalMiddleware } from './toolApprovalMiddleware'
import { AgentDatabase } from './agentDatabase'
import { ManagedCallService } from './managedCallService'
import type { AgentAccessMode } from '@shared/agentTypes'

describe('native terminal input authorization', () => {
  it.each(['approve', 'reject', 'ended'] as const)('handles %s without reusing command authorization or a stale terminal', async (decision) => {
    const database = AgentDatabase.open(':memory:')
    const service = new ManagedCallService(database)
    let finish!: (value: string) => void
    const completion = new Promise<string>((resolve) => { finish = resolve })
    const thread = database.createThread({ title: 'PTY approval' })
    const run = database.createRun(thread.id, 'pty-approval')
    const apply = vi.fn()
    const terminalId = '22222222-2222-4222-8222-222222222222'
    const starting = service.start({ kind: 'shell', threadId: thread.id, runId: run.id, summary: 'CLI',
      execute: async (control) => { control.markRunning(); control.setTerminal!({ id: terminalId, size: { columns: 100, rows: 30 }, apply }); return completion } })
    try {
      const callId = service.activeCallIds()[0]
      await vi.waitFor(() => expect(JSON.parse(service.read({ callId, threadId: thread.id }))).toHaveProperty('pty'))
      let accessMode: AgentAccessMode = 'full_access'
      const tools = await createRuntimeTools({ enabled: true, primaryFolder: process.cwd(), shell: true, memory: false, network: false,
        mcp: false, backgroundTools: true, managedCalls: service, threadId: thread.id,
        commandShell: { executable: '/bin/zsh', name: 'zsh', family: 'posix' } })
      const write = tools.find((item) => item.name === 'write_call')!
      const model = new FakeToolCallingModel({ toolCalls: [[{ id: 'input', name: 'write_call', args: {
        call_id: callId, terminal_id: terminalId, action: { type: 'text', text: 'new command\r' }
      } }], []] })
      const agent = createAgent({ model, tools: [write], checkpointer: new MemorySaver(), middleware: [createToolApprovalMiddleware(
        createInterruptPolicy({ availableTools: ['write_call'], primaryFolder: process.cwd(), trustedFolders: [], accessMode: () => accessMode }), [write]
      )] })
      // The terminal and tool schema were created during full access. Revoking it
      // still governs this new input; the original command grants no exemption.
      accessMode = 'read_only_allowed'
      const config = { configurable: { thread_id: thread.id } }
      const paused = await agent.invoke({ messages: [{ role: 'user', content: 'continue CLI' }] }, config)
      expect(paused.__interrupt__).toHaveLength(1)
      expect(apply).not.toHaveBeenCalled()
      if (decision === 'ended') { finish('done'); await starting }
      await agent.invoke(new Command({ resume: { decisions: [{ type: decision === 'reject' ? 'reject' : 'approve' }] } }), config)
      expect(apply).toHaveBeenCalledTimes(decision === 'approve' ? 1 : 0)
    } finally { finish('done'); await starting; await service.waitForIdle(); database.close() }
  })
})
