import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages'
import { Command, type StateSnapshot } from '@langchain/langgraph'
import { createAgent, createMiddleware, FakeToolCallingModel } from 'langchain'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentDatabase } from './agentDatabase'
import { FileEditStore, pathExists } from '../fileEditStore'
import { createFileTools } from '../llm/fileTools'
import { createPatchAuthorizationMiddleware, patchAuthorizationFor } from './patchAuthorization'
import { createToolApprovalMiddleware } from './toolApprovalMiddleware'
import { createAgentToolEffectMiddleware } from './toolEffectMiddleware'
import { projectInterruptPathPreviews } from './approvalPathPreview'
import { resolveFilePatchTargets } from '../filePatch'
import { captureFilePatchPreimages } from '../filePatchState'
import { createProjectRulesMiddleware } from './projectRulesMiddleware'
import { createToolInputErrorMiddleware, createToolInputValidationMiddleware } from './toolInputErrors'
import type { AgentAccessMode } from '@shared/agentTypes'

const roots: string[] = [], databases = new Set<AgentDatabase>()
type PatchCall = { id: string; name: string; args: Record<string, unknown> }
afterEach(async () => {
  for (const database of databases) database.close()
  databases.clear()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'anas-patch-authorization-')))
  roots.push(root)
  const workspace = join(root, 'project'), outside = join(root, 'outside')
  await mkdir(workspace); await mkdir(outside)
  const databasePath = join(root, 'agent.sqlite'), attachments = join(root, 'attachments')
  let database = AgentDatabase.open(databasePath, attachments)
  databases.add(database)
  const thread = database.createThread(), run = database.createRun(thread.id, randomUUID(), 'agent', [], { kind: 'user', text: 'Edit files' })
  const fileEditStore = new FileEditStore(join(root, 'records'))
  const config = { configurable: { thread_id: thread.id }, durability: 'sync' as const }
  const agent = (calls: PatchCall[] = [], repeatWithRules = false,
    accessMode: AgentAccessMode | (() => AgentAccessMode) = 'read_only_allowed',
    options: { nextCalls?: PatchCall[]; modelIndex?: number; beforePatchCheck?(): void } = {}) => {
    const currentAccessMode = typeof accessMode === 'function' ? accessMode : () => accessMode
    const tools = createFileTools({ maxReadBytes: 1_000_000, primaryFolder: workspace, requestId: run.id, fileEditStore, toolNames: ['apply_patch', 'write_file', 'restore_file_edit'] })
    const rules = createProjectRulesMiddleware({ runId: run.id, primaryFolder: workspace, folders: [workspace], accessMode: currentAccessMode, getInputCapacityTokens: () => 20_000, getModelTokenCountingOptions: () => ({ protocol: 'openai_chat_completions' }), fileEditStore })
    const nextCalls = options.nextCalls ?? (repeatWithRules ? calls.map((call) => ({ ...call, id: `${call.id}-decided` })) : undefined)
    return createAgent({ model: new FakeToolCallingModel({ index: options.modelIndex, toolCalls: calls.length ? [calls, ...(nextCalls ? [nextCalls] : []), []] : [[]] }), tools,
      checkpointer: database.checkpointer, middleware: [
        createToolInputErrorMiddleware(),
        createToolApprovalMiddleware(Object.fromEntries(tools.map((item) => [item.name, { allowedDecisions: ['approve', 'reject'],
          when: (request) => currentAccessMode() !== 'full_access' && patchAuthorizationFor(request.state, request.toolCall, run.id)?.requiresApproval === true }])), tools),
        ...(options.beforePatchCheck ? [createMiddleware({ name: 'BeforePatchAuthorization', wrapToolCall: (request, handler) => {
          options.beforePatchCheck!()
          return handler(request)
        } })] : []),
        createPatchAuthorizationMiddleware({ runId: run.id, primaryFolder: workspace, folders: [workspace], accessMode: currentAccessMode, fileEditStore }),
        ...(repeatWithRules ? [rules.middleware, rules.guard] : []),
        createToolInputValidationMiddleware(tools),
        createAgentToolEffectMiddleware({ database, runId: run.id, threadId: thread.id, tools })
      ] })
  }
  const reopen = () => { database.close(); databases.delete(database); database = AgentDatabase.open(databasePath, attachments); databases.add(database) }
  return { root, workspace, outside, fileEditStore, run, config, agent, reopen }
}

describe('checkpointed batch path authorization', () => {
  it('preserves withheld automatic and approved calls when another action is rejected after reopening SQLite', async () => {
    const value = await fixture()
    const paths = [join(value.workspace, 'inside.txt'), join(value.outside, 'first.txt'), join(value.outside, 'second.txt')]
    const calls = [{ id: 'invalid', name: 'write_file', args: { path: 'invalid.txt', content: 4 } },
      ...paths.map((path, index) => ({ id: `write-${index}`, name: 'write_file', args: { path, content: 'New content' } }))]
    const first = value.agent(calls, true, 'read_only_allowed', { nextCalls: [] })
    const paused = await first.invoke({ messages: [new HumanMessage('Write files')] }, value.config)
    expect(paused.__interrupt__![0].value).toMatchObject({ actionRequests: [
      { name: 'write_file', args: { path: paths[1] } }, { name: 'write_file', args: { path: paths[2] } }
    ] })
    value.reopen()
    const completed = await value.agent([], true, 'read_only_allowed', { modelIndex: 1 }).invoke(new Command({ resume: {
      decisions: [{ type: 'approve' }, { type: 'reject', message: 'Reconsider this batch' }]
    } }), value.config)
    const outputs = completed.messages.filter(ToolMessage.isInstance)
    expect(outputs).toHaveLength(calls.length)
    expect(new Set(outputs.map(message => message.tool_call_id)).size).toBe(calls.length)
    expect(outputs.every(message => message.status === 'error')).toBe(true)
    expect(completed.messages.find(AIMessage.isInstance)?.tool_calls?.map(call => call.id)).toEqual(calls.map(call => call.id))
    expect(completed.messages.filter(AIMessage.isInstance)).toHaveLength(2)
    for (const path of [...paths, join(value.workspace, 'invalid.txt')]) expect(await pathExists(path)).toBe(false)
    expect(await value.fileEditStore.listEditRecordsForRequest(value.run.id)).toHaveLength(0)
  })

  it.each(['approve', 'reject'] as const)('retains invalid call results and valid write %s after reopening SQLite', async decision => {
    const value = await fixture(), path = join(value.outside, 'valid.txt')
    const calls = [
      { id: 'invalid', name: 'write_file', args: { path: 'invalid.txt', content: 'unused', extra: { number: Infinity } } },
      { id: 'valid', name: 'write_file', args: { path, content: 'approved content' } }
    ]
    const first = value.agent(calls, true, 'read_only_allowed', { nextCalls: [] })
    const paused = await first.invoke({ messages: [new HumanMessage('Write files')] }, value.config)
    expect(paused.messages.filter(ToolMessage.isInstance)).toMatchObject([
      { tool_call_id: 'invalid', status: 'error', content: expect.stringContaining('/extra/number') }
    ])
    expect(paused.messages.find(AIMessage.isInstance)?.tool_calls?.map(call => call.id)).toEqual(['invalid', 'valid'])
    expect(paused.__interrupt__![0].value).toMatchObject({ actionRequests: [{ name: 'write_file', args: { path } }] })
    expect(await pathExists(path)).toBe(false)
    value.reopen()
    const completed = await value.agent([], true).invoke(new Command({ resume: { decisions: [{ type: decision }] } }), value.config)
    expect(completed.messages.filter(ToolMessage.isInstance)).toHaveLength(2)
    expect(completed.messages.filter(ToolMessage.isInstance).find(message => message.tool_call_id === 'invalid')?.status).toBe('error')
    expect(await pathExists(join(value.workspace, 'invalid.txt'))).toBe(false)
    if (decision === 'approve') expect(await readFile(path, 'utf8')).toBe('approved content')
    else expect(await pathExists(path)).toBe(false)
  })

  it('authorizes a write outside the workspace and restores its checkpointed call after reopening', async () => {
    const value = await fixture(), path = join(value.outside, 'new', 'file.txt')
    const call = { id: 'write', name: 'write_file', args: { summary: 'Create a file', path, content: 'complete\n+content', overwrite: false } }
    const first = value.agent([call])
    await first.invoke({ messages: [new HumanMessage('Write the file')] }, value.config)
    const paused: StateSnapshot = await first.getState(value.config)
    expect(paused.tasks.flatMap((task) => task.interrupts)).toHaveLength(1)
    expect(patchAuthorizationFor(paused.values, call, value.run.id)?.targets.map((target) => target.path)).toEqual([path])
    expect(await pathExists(path)).toBe(false)
    value.reopen()
    const result = await value.agent().invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), value.config)
    expect(result.messages.filter(ToolMessage.isInstance).at(-1)?.text).toContain('"ok":true')
    expect(await readFile(path, 'utf8')).toBe('complete\n+content')
  })

  it('discovers scoped rules before writing complete content', async () => {
    const value = await fixture()
    await mkdir(join(value.workspace, 'child'))
    await writeFile(join(value.workspace, 'child', 'AGENTS.md'), 'CHILD RULE')
    const call = { id: 'write', name: 'write_file', args: { path: 'child/file.txt', content: 'complete content' } }
    const result = await value.agent([call], true).invoke({ messages: [new HumanMessage('Write the file')] }, value.config)
    const messages = result.messages.filter(ToolMessage.isInstance)
    expect(messages.find((message) => message.tool_call_id === 'write')?.text).toContain('NOT EXECUTED')
    expect(messages.find((message) => message.tool_call_id === 'write-decided')?.text).toContain('"ok":true')
    expect(await readFile(join(value.workspace, 'child', 'file.txt'), 'utf8')).toBe('complete content')
  })

  it('blocks the original real batch on new scoped rules and runs only the new model decision', async () => {
    const value = await fixture()
    await mkdir(join(value.workspace, 'child'))
    await writeFile(join(value.workspace, 'AGENTS.md'), 'ROOT RULE')
    await writeFile(join(value.workspace, 'child/AGENTS.md'), 'CHILD RULE')
    const call = { id: 'batch', name: 'apply_patch', args: { patch: '*** Begin Patch\n*** Add File: a.txt\n+root\n*** Add File: child/b.txt\n+child\n*** End Patch' } }
    const result = await value.agent([call], true).invoke({ messages: [new HumanMessage('Edit together')] }, value.config)
    const outputs = result.messages.filter(ToolMessage.isInstance)
    expect(outputs[0].tool_call_id).toBe('batch')
    expect(outputs[0].text).toContain('NOT EXECUTED')
    expect(outputs[1].tool_call_id).toBe('batch-decided')
    expect(outputs[1].text).toContain('"ok":true')
    expect(await value.fileEditStore.listEditRecordsForRequest(value.run.id)).toHaveLength(1)
    expect(await readFile(join(value.workspace, 'a.txt'), 'utf8')).toBe('root\n')
    expect(await readFile(join(value.workspace, 'child/b.txt'), 'utf8')).toBe('child\n')
  })

  it('rejects two authorized links swapping their targets instead of treating approval as an unordered set', async () => {
    const value = await fixture(), a = join(value.outside, 'a.txt'), b = join(value.outside, 'b.txt')
    await writeFile(a, 'before\n'); await writeFile(b, 'before\n')
    await symlink(a, join(value.workspace, 'first'), 'file'); await symlink(b, join(value.workspace, 'second'), 'file')
    const call = { id: 'batch', name: 'apply_patch', args: { patch: '*** Begin Patch\n*** Update File: first\n@@\n-before\n+first\n*** Update File: second\n@@\n-before\n+second\n*** End Patch' } }
    await value.agent([call]).invoke({ messages: [new HumanMessage('Edit both')] }, value.config)
    await unlink(join(value.workspace, 'first')); await unlink(join(value.workspace, 'second'))
    await symlink(b, join(value.workspace, 'first'), 'file'); await symlink(a, join(value.workspace, 'second'), 'file')
    value.reopen()
    const result = await value.agent().invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), value.config)
    expect(result.messages.filter(ToolMessage.isInstance).at(-1)?.text).toContain('operation binding after authorization')
    expect(await readFile(a, 'utf8')).toBe('before\n')
    expect(await readFile(b, 'utf8')).toBe('before\n')
  })

  it('checkpoints every target before HITL and executes the approved batch after reopening SQLite', async () => {
    const value = await fixture(), path = join(value.outside, 'a.txt'), inside = join(value.workspace, 'b.txt')
    const call = { id: 'batch', name: 'apply_patch', args: { patch: `*** Begin Patch\n*** Add File: ${path}\n+outside\n*** Add File: ${inside}\n+inside\n*** End Patch` } }
    const first = value.agent([call])
    await first.invoke({ messages: [new HumanMessage('Create both files')] }, value.config)
    const paused: StateSnapshot = await first.getState(value.config)
    expect(paused.tasks.flatMap((task) => task.interrupts), JSON.stringify(paused.values)).toHaveLength(1)
    expect(patchAuthorizationFor(paused.values, call, value.run.id)?.targets.map((target) => target.path)).toEqual([path, inside])
    expect(await pathExists(path)).toBe(false)
    expect(await pathExists(inside)).toBe(false)
    value.reopen()
    const result = await value.agent().invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), value.config)
    expect(result.messages.filter(ToolMessage.isInstance).at(-1)?.text).toContain('"ok":true')
    expect(await readFile(path, 'utf8')).toBe('outside\n')
    expect(await readFile(inside, 'utf8')).toBe('inside\n')
  })

  it.each(['apply_patch', 'write_file'])('does not grant a changed link destination when an old %s approval resumes', async (name) => {
    const value = await fixture(), original = join(value.outside, 'a.txt'), replacement = join(value.outside, 'b.txt'), link = join(value.workspace, 'link')
    await writeFile(original, 'before\n'); await writeFile(replacement, 'before\n'); await symlink(original, link, 'file')
    const call: PatchCall = { id: 'batch', name, args: name === 'write_file'
      ? { path: 'link', content: 'after\n', overwrite: true }
      : { patch: '*** Begin Patch\n*** Update File: link\n@@\n-before\n+after\n*** End Patch' } }
    const first = value.agent([call])
    await first.invoke({ messages: [new HumanMessage('Edit link')] }, value.config)
    const paused: StateSnapshot = await first.getState(value.config)
    expect(paused.tasks.flatMap((task) => task.interrupts)).toHaveLength(1)
    await unlink(link); await symlink(replacement, link, 'file')
    value.reopen()
    const result = await value.agent().invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), value.config)
    expect(result.messages.filter(ToolMessage.isInstance).at(-1)?.text).toContain('operation binding after authorization')
    expect(await readFile(original, 'utf8')).toBe('before\n')
    expect(await readFile(replacement, 'utf8')).toBe('before\n')
    expect(await value.fileEditStore.listEditRecordsForRequest(value.run.id)).toEqual([])
  })

  it('shows and authorizes the complete stored restore target list without adding model arguments', async () => {
    const value = await fixture(), sourceRequest = randomUUID()
    const paths = [join(value.outside, 'a.txt'), join(value.outside, 'b.txt')]
    const resolved = await resolveFilePatchTargets({ patch: `*** Begin Patch\n${paths.map((path) => `*** Add File: ${path}\n+created`).join('\n')}\n*** End Patch` }, value.workspace)
    const source = await value.fileEditStore.executePatch(resolved.input, await captureFilePatchPreimages(resolved.targets), sourceRequest, { operationId: randomUUID() })
    const call = { id: 'restore', name: 'restore_file_edit', args: { operation_id: source.operationId, request_id: sourceRequest } }
    const agent = value.agent([call])
    await agent.invoke({ messages: [new HumanMessage('Restore both')] }, value.config)
    const paused: StateSnapshot = await agent.getState(value.config)
    const interrupts = paused.tasks.flatMap((task) => task.interrupts)
    expect(interrupts).toHaveLength(1)
    const projected = await projectInterruptPathPreviews(interrupts.map((item) => ({ id: item.id!, value: item.value, approvalGeneration: 'test' })), value.workspace, paused.values)
    expect(projected[0].pathPreviews?.map((item) => item.absolutePath)).toEqual(paths)
    expect(JSON.stringify(interrupts[0].value)).not.toContain('resolved_path')
    value.reopen()
    const result = await value.agent().invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), value.config)
    expect(result.messages.filter(ToolMessage.isInstance).at(-1)?.text).toContain('"ok":true')
    for (const path of paths) expect(await pathExists(path)).toBe(false)
  })

  it.each(['strict_approval', 'read_only_allowed', 'full_access'] as const)('uses checkpointed read authorization for an outside dry run in %s', async (accessMode) => {
    const value = await fixture(), path = join(value.outside, 'preview.txt')
    const call = { id: 'preview', name: 'apply_patch', args: { dry_run: true,
      patch: `*** Begin Patch\n*** Add File: ${path}\n+preview\n*** End Patch` } }
    const first = value.agent([call], false, accessMode)
    let result = await first.invoke({ messages: [new HumanMessage('Preview only')] }, value.config)
    const snapshot: StateSnapshot = await first.getState(value.config)
    expect(snapshot.tasks.flatMap((task) => task.interrupts)).toHaveLength(accessMode === 'strict_approval' ? 1 : 0)
    if (accessMode === 'strict_approval') {
      expect(patchAuthorizationFor(snapshot.values, call, value.run.id)?.targets).toEqual([
        expect.objectContaining({ path, access: 'read', locator: ['operations', 0, 'path'] })
      ])
      value.reopen()
      result = await value.agent([], false, accessMode).invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), value.config)
    }
    expect(result.messages.filter(ToolMessage.isInstance).at(-1)?.text).toContain('"dryRun":true')
    expect(await pathExists(path)).toBe(false)
    expect(await value.fileEditStore.listEditRecordsForRequest(value.run.id)).toEqual([])
  })

  it.each(['strict_approval', 'read_only_allowed', 'full_access'] as const)('previews an outside restore as a read in %s', async (accessMode) => {
    const value = await fixture(), path = join(value.outside, 'created.txt'), sourceRequest = randomUUID()
    const resolved = await resolveFilePatchTargets({ patch: `*** Begin Patch\n*** Add File: ${path}\n+created\n*** End Patch` }, value.workspace)
    const source = await value.fileEditStore.executePatch(resolved.input, await captureFilePatchPreimages(resolved.targets), sourceRequest, { operationId: randomUUID() })
    const call = { id: 'restore-preview', name: 'restore_file_edit', args: {
      operation_id: source.operationId, request_id: sourceRequest, dry_run: true
    } }
    const first = value.agent([call], false, accessMode)
    let result = await first.invoke({ messages: [new HumanMessage('Preview restoration')] }, value.config)
    const snapshot: StateSnapshot = await first.getState(value.config)
    expect(snapshot.tasks.flatMap((task) => task.interrupts)).toHaveLength(accessMode === 'strict_approval' ? 1 : 0)
    if (accessMode === 'strict_approval') {
      expect(patchAuthorizationFor(snapshot.values, call, value.run.id)?.targets.every((target) => target.access === 'read')).toBe(true)
      value.reopen()
      result = await value.agent([], false, accessMode).invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), value.config)
    }
    expect(result.messages.filter(ToolMessage.isInstance).at(-1)?.text).toContain('"dryRun":true')
    expect(await readFile(path, 'utf8')).toBe('created\n')
    expect(await value.fileEditStore.listEditRecordsForRequest(value.run.id)).toEqual([])
  })

  it.each(['apply_patch', 'restore_file_edit'])('blocks an outside %s preview when access tightens after preflight', async (name) => {
    const value = await fixture(), path = join(value.outside, 'preview.txt')
    const patch = `*** Begin Patch\n*** Add File: ${path}\n+created\n*** End Patch`
    let args: Record<string, unknown> = { patch, dry_run: true }
    if (name === 'restore_file_edit') {
      const resolved = await resolveFilePatchTargets({ patch }, value.workspace)
      const source = await value.fileEditStore.executePatch(resolved.input, await captureFilePatchPreimages(resolved.targets), randomUUID(), { operationId: randomUUID() })
      args = { operation_id: source.operationId, request_id: source.requestId, dry_run: true }
    }
    let accessMode: AgentAccessMode = 'read_only_allowed'
    const tightenAccess = vi.fn(() => { accessMode = 'strict_approval' })
    const call = { id: 'preview', name, args }
    const agent = value.agent([call], false, () => accessMode, { beforePatchCheck: tightenAccess })
    const result = await agent.invoke({ messages: [new HumanMessage('Preview only')] }, value.config)
    const output = result.messages.filter(ToolMessage.isInstance).at(-1)!
    expect(tightenAccess).toHaveBeenCalledOnce()
    expect(output.status).toBe('error')
    expect(output.text).toContain('Patch targets require a new approval after the access mode changed')
    expect(output.text).not.toContain('"dryRun":true')
    if (name === 'restore_file_edit') expect(await readFile(path, 'utf8')).toBe('created\n')
    else expect(await pathExists(path)).toBe(false)
    expect(await value.fileEditStore.listEditRecordsForRequest(value.run.id)).toEqual([])
  })

  it.each([
    ['apply_patch', 'read_only_allowed'], ['apply_patch', 'strict_approval'],
    ['restore_file_edit', 'read_only_allowed'], ['restore_file_edit', 'strict_approval']
  ] as const)('does not treat a full-access %s preflight as human approval after switching to %s', async (name, nextMode) => {
    const value = await fixture(), path = join(value.outside, 'revoked.txt')
    const patch = `*** Begin Patch\n*** Add File: ${path}\n+created\n*** End Patch`
    let args: Record<string, unknown> = { patch }
    if (name === 'restore_file_edit') {
      const resolved = await resolveFilePatchTargets({ patch }, value.workspace)
      const source = await value.fileEditStore.executePatch(resolved.input, await captureFilePatchPreimages(resolved.targets), randomUUID(), { operationId: randomUUID() })
      args = { operation_id: source.operationId, request_id: source.requestId }
    }
    let accessMode: AgentAccessMode = 'full_access'
    const call = { id: 'revoked-write', name, args }
    const result = await value.agent([call], false, () => accessMode, {
      beforePatchCheck: () => { accessMode = nextMode }
    }).invoke({ messages: [new HumanMessage('Write only under the current access mode')] }, value.config)
    const output = result.messages.filter(ToolMessage.isInstance).find((message) => message.tool_call_id === call.id)!
    expect(output.status).toBe('error')
    expect(output.text).toContain('new approval')
    if (name === 'restore_file_edit') expect(await readFile(path, 'utf8')).toBe('created\n')
    else expect(await pathExists(path)).toBe(false)
    expect(await value.fileEditStore.listEditRecordsForRequest(value.run.id)).toEqual([])
  })

  it('keeps exact human approval after tightening access while paused, but not for the next call', async () => {
    const value = await fixture(), firstPath = join(value.outside, 'first.txt'), nextPath = join(value.outside, 'next.txt')
    let accessMode: AgentAccessMode = 'read_only_allowed'
    const createCall = (id: string, path: string) => ({ id, name: 'apply_patch', args: {
      patch: `*** Begin Patch\n*** Add File: ${path}\n+approved\n*** End Patch`
    } })
    const first = createCall('first', firstPath), next = createCall('next', nextPath)
    const agent = value.agent([first], false, () => accessMode, { nextCalls: [next] })
    await agent.invoke({ messages: [new HumanMessage('Create two files separately')] }, value.config)
    const initial: StateSnapshot = await agent.getState(value.config)
    expect(patchAuthorizationFor(initial.values, first)?.humanApproved).toBe(false)
    accessMode = 'strict_approval'
    await agent.invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), value.config)
    expect(await readFile(firstPath, 'utf8')).toBe('approved\n')
    expect(await pathExists(nextPath)).toBe(false)
    const paused: StateSnapshot = await agent.getState(value.config)
    expect(paused.tasks.flatMap((task) => task.interrupts)).toHaveLength(1)
    expect(patchAuthorizationFor(paused.values, next)?.humanApproved).toBe(false)
    await agent.invoke(new Command({ resume: { decisions: [{ type: 'reject' }] } }), value.config)
    expect(await pathExists(nextPath)).toBe(false)
    expect(await value.fileEditStore.listEditRecordsForRequest(value.run.id)).toHaveLength(1)
  })

  it.each(['apply_patch', 'restore_file_edit'])('requires separate approval for %s writes after an approved dry run', async (name) => {
    const value = await fixture(), path = join(value.outside, 'preview-then-write.txt')
    const patch = `*** Begin Patch\n*** Add File: ${path}\n+created\n*** End Patch`
    let args: Record<string, unknown> = { patch }
    if (name === 'restore_file_edit') {
      const resolved = await resolveFilePatchTargets({ patch }, value.workspace)
      const source = await value.fileEditStore.executePatch(resolved.input, await captureFilePatchPreimages(resolved.targets), randomUUID(), { operationId: randomUUID() })
      args = { operation_id: source.operationId, request_id: source.requestId }
    }
    const preview = { id: 'preview', name, args: { ...args, dry_run: true } }
    const write = { id: 'write', name, args: { ...args, dry_run: false } }
    const agent = value.agent([preview], false, 'strict_approval', { nextCalls: [write] })
    await agent.invoke({ messages: [new HumanMessage('Preview, then apply')] }, value.config)
    const previewState: StateSnapshot = await agent.getState(value.config)
    expect(previewState.tasks.flatMap((task) => task.interrupts)).toHaveLength(1)
    expect(patchAuthorizationFor(previewState.values, preview, value.run.id)?.targets).toEqual([
      expect.objectContaining({ path, access: 'read' })
    ])

    const previewResult = await agent.invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), value.config)
    expect(previewResult.messages.filter(ToolMessage.isInstance).at(-1)?.text).toContain('"dryRun":true')
    const writeState: StateSnapshot = await agent.getState(value.config)
    const writeInterrupts = writeState.tasks.flatMap((task) => task.interrupts)
    expect(writeInterrupts).toHaveLength(1)
    expect(writeInterrupts[0].value).toMatchObject({ actionRequests: [{ name, args: write.args }] })
    expect(patchAuthorizationFor(writeState.values, write, value.run.id)?.targets).toEqual([
      expect.objectContaining({ path, access: 'write' })
    ])
    if (name === 'restore_file_edit') expect(await readFile(path, 'utf8')).toBe('created\n')
    else expect(await pathExists(path)).toBe(false)
    expect(await value.fileEditStore.listEditRecordsForRequest(value.run.id)).toEqual([])

    const result = await agent.invoke(new Command({ resume: { decisions: [{ type: 'approve' }] } }), value.config)
    expect(result.messages.filter(ToolMessage.isInstance).at(-1)?.text).toContain('"ok":true')
    if (name === 'restore_file_edit') expect(await pathExists(path)).toBe(false)
    else expect(await readFile(path, 'utf8')).toBe('created\n')
    expect(await value.fileEditStore.listEditRecordsForRequest(value.run.id)).toHaveLength(1)
  })
})
