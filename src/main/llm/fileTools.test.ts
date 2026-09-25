import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enabledBuiltinFileToolNames } from '@shared/toolRegistry'
import type { AgentFeatures } from '@shared/types'
import { AgentDatabase, type AgentToolEffectKey } from '../agent/agentDatabase'
import { runWithCurrentAgentToolEffect, type AgentToolEffectArm } from '../agent/toolEffectScope'
import { FileEditStore, pathExists } from '../fileEditStore'
import { createFileTools } from './fileTools'
import { ManagedCallService } from '../agent/managedCallService'
import { withManagedToolExecution } from '../agent/managedToolExecution'
import { ToolMessage } from '@langchain/core/messages'
import { directoryTreePages } from '../directoryTree'

const tempDirs: string[] = []
const defaultRequestId = '00000000-0000-4000-8000-000000000001'
let fileEditStore: FileEditStore
let fileEditStoreRoot: string
let database: AgentDatabase

function ensureRun(requestId: string): void {
  if (!database.getRun(requestId)) database.createRun(database.createThread().id, requestId, 'agent', [], { kind: 'user', text: 'File test' })
}

const stableFileEffectKey: AgentToolEffectKey = {
  runId: defaultRequestId,
  checkpointId: 'checkpoint-file-edit',
  checkpointNs: 'tools:file-edit-task',
  taskId: 'file-edit-task',
  callKey: 'id:file-edit-call',
  inputHash: 'a'.repeat(64)
}

async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'anas-file-tools-')))
  tempDirs.push(dir)
  return dir
}

async function invokeTool(name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  return invokeRequestTool(name, defaultRequestId, input)
}

async function invokeRequestTool(
  name: string,
  requestId: string,
  input: Record<string, unknown>,
  primaryFolder = process.cwd()
): Promise<Record<string, unknown>> {
  ensureRun(requestId)
  const selected = createFileTools({ maxReadBytes: 1_000_000,
    primaryFolder,
    requestId,
    fileEditStore, fileChanges: database.fileChanges, authorizePatch: async () => {}
  }).find((item) => item.name === name)
  expect(selected, `tool ${name} should exist`).toBeTruthy()
  const effects: AgentToolEffectArm[] = []
  const output = await runWithCurrentAgentToolEffect({ effectKey: { ...stableFileEffectKey, runId: requestId, callKey: randomUUID() },
    persistFileChange: (record, observed) => database.fileChanges.persist(record, observed),
    isUnarmed: () => effects.length === 0, previousEffect: () => effects.at(-1), arm: (effect) => effects.push(effect)
  }, () => selected!.invoke({ summary: 'Run the file tool test', ...input }))
  expect(typeof output).toBe('string')
  const result = JSON.parse(output as string) as Record<string, unknown>
  return result
}

async function invokeToolWithEffects(
  name: string,
  input: Record<string, unknown>,
  primaryFolder = process.cwd()
): Promise<{ effects: AgentToolEffectArm[]; result: Record<string, unknown> }> {
  ensureRun(defaultRequestId)
  const selected = createFileTools({ maxReadBytes: 1_000_000,
    primaryFolder,
    requestId: defaultRequestId,
    fileEditStore, fileChanges: database.fileChanges, authorizePatch: async () => {}
  }).find((item) => item.name === name)
  expect(selected, `tool ${name} should exist`).toBeTruthy()
  const effects: AgentToolEffectArm[] = []
  const output = await runWithCurrentAgentToolEffect({
    persistFileChange: (record, observed) => database.fileChanges.persist(record, observed),
    effectKey: { ...stableFileEffectKey, callKey: randomUUID() }, isUnarmed: () => effects.length === 0,
    previousEffect: () => effects.at(-1), arm: (effect) => effects.push(effect)
  }, () => selected!.invoke({ summary: 'Run the file tool test', ...input }))
  expect(typeof output).toBe('string')
  return {
    effects,
    result: JSON.parse(output as string) as Record<string, unknown>
  }
}

beforeEach(async () => {
  const directory = await tempDir()
  fileEditStoreRoot = join(directory, 'file_edits')
  fileEditStore = new FileEditStore(fileEditStoreRoot)
  database = AgentDatabase.open(':memory:', join(directory, 'attachments'))
})

afterEach(async () => {
  await directoryTreePages.closeIdleCursors()
  database.close()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('file tools', () => {
  it.each([256_000, 1_000_000, 2_000_000])('shares a %i byte model budget across JSON, raw and batch reads', async (maxReadBytes) => {
    const dir = await tempDir(), path = join(dir, 'limit.txt'), extra = join(dir, 'extra.txt'), empty = join(dir, 'empty.txt')
    const content = '中'.repeat(Math.floor((maxReadBytes - 2) / 3)) + 'x'.repeat((maxReadBytes - 2) % 3) + '\r\n'
    await writeFile(path, content)
    await writeFile(extra, 'x')
    await writeFile(empty, '')
    const tools = createFileTools({ primaryFolder: dir, maxReadBytes })
    const read = tools.find(tool => tool.name === 'read_file')!
    const batch = tools.find(tool => tool.name === 'read_multiple_files')!
    expect(await read.invoke({ path, format: 'raw' })).toBe(content)
    expect(JSON.parse(await read.invoke({ path }))).toMatchObject({ ok: true, content, byteLimit: maxReadBytes, returnedBytes: maxReadBytes })
    expect(JSON.parse(await batch.invoke({ paths: [path, empty, extra] }))).toMatchObject({
      byteLimit: maxReadBytes, returnedBytes: maxReadBytes, truncated: true,
      files: [{ ok: true, content }, { ok: true, content: '' }, { ok: false }]
    })
    await writeFile(path, content + 'tail\n')
    expect(JSON.parse(await read.invoke({ path }))).toMatchObject({ ok: false, error: expect.stringContaining(String(maxReadBytes)) })
    await expect(read.invoke({ path, format: 'raw' })).rejects.toThrow(String(maxReadBytes))
    expect(JSON.parse(await read.invoke({ path, max_lines: 2 }))).toMatchObject({ content, byteLimit: maxReadBytes, truncated: true })
    expect(await read.invoke({ path, max_lines: 1, format: 'raw' })).toBe(content)
    await expect(read.invoke({ path, max_lines: 2, format: 'raw' })).rejects.toThrow('no partial raw content')
  })

  it('keeps metadata line counting independent of the model read budget', async () => {
    const dir = await tempDir(), path = join(dir, 'lines.txt')
    await writeFile(path, 'first\nsecond\n')
    const tools = createFileTools({ primaryFolder: dir, maxReadBytes: 1 })
    expect(JSON.parse(await tools.find(tool => tool.name === 'get_file_info')!.invoke({ path }))).toMatchObject({ ok: true, lineCount: 2 })
  })

  it('reads the current model budget on every file operation and rejects an invalid updated budget', async () => {
    const dir = await tempDir(), path = join(dir, 'dynamic.txt')
    await writeFile(path, '12345678')
    let currentBudget = 16
    const tools = createFileTools({ primaryFolder: dir, maxReadBytes: async () => currentBudget })
    const read = tools.find(tool => tool.name === 'read_file')!
    const batch = tools.find(tool => tool.name === 'read_multiple_files')!
    expect(await read.invoke({ path, format: 'raw' })).toBe('12345678')
    currentBudget = 4
    await expect(read.invoke({ path, format: 'raw' })).rejects.toThrow('max 4')
    expect(JSON.parse(await batch.invoke({ paths: [path] }))).toMatchObject({ byteLimit: 4, truncated: true })
    currentBudget = 32
    expect(JSON.parse(await batch.invoke({ paths: [path] }))).toMatchObject({ byteLimit: 32, returnedBytes: 8 })
    currentBudget = NaN
    await expect(read.invoke({ path, format: 'raw' })).rejects.toThrow('positive safe integer')
  })

  it('does not execute model-free catalog reads or accept invalid budgets', async () => {
    const dir = await tempDir(), path = join(dir, 'file.txt')
    await writeFile(path, 'text')
    const tools = createFileTools({ primaryFolder: dir, maxReadBytes: null })
    await expect(tools.find(tool => tool.name === 'read_file')!.invoke({ path, format: 'raw' })).rejects.toThrow('configured model')
    expect(JSON.parse(await tools.find(tool => tool.name === 'read_multiple_files')!.invoke({ paths: [path] }))).toMatchObject({ ok: false })
    for (const maxReadBytes of [0, -1, 1.5, NaN, Infinity]) {
      expect(() => createFileTools({ primaryFolder: dir, maxReadBytes })).toThrow('positive safe integer')
    }
  })

  const reader = (primaryFolder: string, signal?: AbortSignal) => createFileTools({ maxReadBytes: 1_000_000, primaryFolder, signal, toolNames: ['read_file'] })[0]

  it.each(['', 'last', 'last\n', 'last\r\n', '\ufeff中文\r\n\t"quoted"\\path\n\nlast\r', '\n\n'])('preserves exact whole-file text in both formats: %j', async (content) => {
    const dir = await tempDir(), path = join(dir, 'source.txt')
    await writeFile(path, content)
    const read = reader(dir)
    expect(await read.invoke({ path, format: 'raw' })).toBe(content)
    const result = JSON.parse(await read.invoke({ path }))
    expect(result).toMatchObject({ ok: true, content, truncated: false, returnedBytes: Buffer.byteLength(content) })
    expect(result.lineCount).toBe(content ? (content.match(/\n/g)?.length ?? 0) + Number(!content.endsWith('\n')) : 0)
    expect(JSON.parse(await read.invoke({ path, format: 'json' }))).toEqual(result)
    const batch = await invokeTool('read_multiple_files', { paths: [path] })
    expect(batch.files).toEqual([{ ok: true, path, size: Buffer.byteLength(content), content }])
  })

  it.each(['last', 'last\n', 'last\r\n'])('preserves selected line terminators and EOF state: %j', async (last) => {
    const dir = await tempDir(), path = join(dir, 'slice.txt')
    await writeFile(path, '\ufefffirst\r\nsecond\n' + last)
    const read = reader(dir)
    expect(await read.invoke({ path, start_line: 1, max_lines: 1, format: 'raw' })).toBe('\ufefffirst\r\n')
    expect(await read.invoke({ path, start_line: 2, max_lines: 1, format: 'raw' })).toBe('second\n')
    expect(await read.invoke({ path, start_line: 3, max_lines: 5, format: 'raw' })).toBe(last)
    expect(await read.invoke({ path, start_line: 3, format: 'raw' })).toBe(last)
    expect(await read.invoke({ path, start_line: 4, format: 'raw' })).toBe('')
    expect(JSON.parse(await read.invoke({ path, start_line: 3, max_lines: 5 })))
      .toMatchObject({ content: last, lineCount: 3, returnedLineCount: 1, truncated: false })
  })

  it('preserves CRLF and multibyte text crossing stream chunk boundaries', async () => {
    const dir = await tempDir(), path = join(dir, 'chunks.txt')
    const first = 'x'.repeat(65535) + '\r\n'
    const second = 'a'.repeat(65534) + '中文🙂\r\n'
    await writeFile(path, first + second)
    const read = reader(dir)
    expect(await read.invoke({ path, format: 'raw' })).toBe(first + second)
    expect(await read.invoke({ path, start_line: 2, max_lines: 1, format: 'raw' })).toBe(second)
  })

  it('returns complete lines with JSON truncation metadata but never silently truncates a raw range', async () => {
    const dir = await tempDir(), path = join(dir, 'limit.txt')
    await writeFile(path, 'first\r\n' + '中'.repeat(400_000) + '\r\nlast\n')
    const read = reader(dir)
    expect(JSON.parse(await read.invoke({ path, max_lines: 3 }))).toMatchObject({
      ok: true, content: 'first\r\n', lineCount: 3, returnedLineCount: 1, truncated: true
    })
    await expect(read.invoke({ path, max_lines: 3, format: 'raw' })).rejects.toThrow('no partial raw content')
    await expect(read.invoke({ path, format: 'raw' })).rejects.toThrow('too large')
    expect(await read.invoke({ path, start_line: 3, max_lines: 1, format: 'raw' })).toBe('last\n')
    await writeFile(path, 'x'.repeat(999_998) + '\r\n')
    expect((await read.invoke({ path, format: 'raw' })).length).toBe(1_000_000)
  })

  it.each([Buffer.from([0xc3, 0x28]), Buffer.from([0xe4, 0xb8]), Buffer.concat([Buffer.alloc(9000, 97), Buffer.from([0])])])('rejects invalid UTF-8 and binary data without returning replacement text', async (bytes) => {
    const dir = await tempDir(), path = join(dir, 'invalid.txt')
    await writeFile(path, bytes)
    const read = reader(dir)
    await expect(read.invoke({ path, format: 'raw' })).rejects.toThrow(/UTF-8|binary/)
    await expect(read.invoke({ path, max_lines: 1, format: 'raw' })).rejects.toThrow(/UTF-8|binary/)
    expect(JSON.parse(await read.invoke({ path }))).toMatchObject({ ok: false })
    expect((await invokeTool('read_multiple_files', { paths: [path] })).files).toMatchObject([{ ok: false }])
  })

  it('distinguishes error-looking raw file content from a real managed tool failure', async () => {
    const dir = await tempDir(), path = join(dir, 'status.json')
    const content = '{"ok":false,"error":"file data"}\r\n'
    await writeFile(path, content)
    ensureRun(defaultRequestId)
    const threadId = database.getRun(defaultRequestId)!.threadId
    const service = new ManagedCallService(database)
    try {
      const read = withManagedToolExecution(reader(dir), { database, service, threadId, runId: defaultRequestId, allowBackground: false })
      const invoke = (path: string) => read.invoke({ type: 'tool_call', id: randomUUID(), name: 'read_file', args: { path, format: 'raw' } }) as Promise<ToolMessage>
      expect(await invoke(path)).toMatchObject({ status: 'success', content })
      expect(await invoke(join(dir, 'missing.txt'))).toMatchObject({ status: 'error' })
    } finally { await service.shutdown() }
  })

  it('rejects invalid ranges and respects cancellation', async () => {
    const dir = await tempDir(), path = join(dir, 'source.txt')
    await writeFile(path, 'text\n')
    const read = reader(dir)
    for (const args of [{ start_line: 0 }, { start_line: 1.5 }, { max_lines: 5001 }, { max_lines: 0 }, { format: 'xml' }]) {
      await expect(read.invoke({ path, ...args })).rejects.toThrow()
    }
    const controller = new AbortController()
    controller.abort(new Error('Read cancelled'))
    await expect(reader(dir, controller.signal).invoke({ path, format: 'raw' })).rejects.toThrow('Read cancelled')
  })

  it('edits raw CRLF context through apply_patch without changing surrounding line endings', async () => {
    const dir = await tempDir(), path = join(dir, 'source.txt')
    await writeFile(path, '\ufeffheader\nold\r\ntail')
    const context = await reader(dir).invoke({ path, start_line: 2, max_lines: 1, format: 'raw' })
    const result = await invokeRequestTool('apply_patch', defaultRequestId, {
      patch: '*** Begin Patch\n*** Update File: source.txt\n@@\n-' + context + '+new\n*** End Patch'
    }, dir)
    expect(result.ok).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('\ufeffheader\nnew\r\ntail')
  })

  it.each(['', '#Requires -Version 5.1\r\n\r\n+literal\r\n  indented', '\ufeff中文\n'])('writes exact content with automatic parents and supports diff and undo: %j', async (content) => {
    const dir = await tempDir(), path = join(dir, 'nested', 'deeper', 'new.ps1')
    const { result, effects } = await invokeToolWithEffects('write_file', { path: 'nested/deeper/new.ps1', content }, dir)
    expect(result).toMatchObject({ ok: true, state: 'applied', operationId: expect.any(String) })
    expect(effects).toMatchObject([{ kind: 'file_patch', recoveryMode: 'confirm' }])
    expect(await readFile(path, 'utf8')).toBe(content)
    const diff = await invokeRequestTool('get_file_edit_diff', defaultRequestId, { operation_id: result.operationId }, dir)
    expect(diff).toMatchObject({ ok: true, operationId: result.operationId,
      segments: [{ path, beforeExists: false, afterExists: true }] })
    expect(diff.patch).toContain('new.ps1')
    fileEditStore = new FileEditStore(fileEditStoreRoot)
    const restored = await invokeTool('restore_file_edit', { operation_id: result.operationId })
    expect(restored.ok).toBe(true)
    expect(await pathExists(path)).toBe(false)
  })

  it('replaces an existing file with explicit overwrite and restores its exact original content', async () => {
    const dir = await tempDir(), path = join(dir, 'file.txt'), before = '\ufeffbefore\r\n'
    await writeFile(path, before)
    const edit = await invokeTool('write_file', { path, content: 'after', overwrite: true })
    expect(edit.ok).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('after')
    expect((await invokeTool('restore_file_edit', { operation_id: edit.operationId })).ok).toBe(true)
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it.each([{}, { overwrite: false }])('rejects existing files without publishing an edit: %j', async (options) => {
    const dir = await tempDir(), path = join(dir, 'file.txt')
    await writeFile(path, 'original')
    const { result, effects } = await invokeToolWithEffects('write_file', { path, content: 'replacement', ...options })
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('overwrite is false') })
    expect(result).not.toHaveProperty('operationId')
    expect(effects).toEqual([])
    expect(await readFile(path, 'utf8')).toBe('original')
    expect(await fileEditStore.listEditRecordsForRequest(defaultRequestId)).toEqual([])
  })

  it.each(['created', 'modified', 'deleted'])('preserves a concurrent file %s before write commit', async (change) => {
    const dir = await tempDir(), path = join(dir, 'race.txt')
    if (change !== 'created') await writeFile(path, 'before')
    const execute = fileEditStore.executePatch.bind(fileEditStore)
    vi.spyOn(fileEditStore, 'executePatch').mockImplementationOnce(async (...args) => {
      if (change === 'deleted') await rm(path)
      else await writeFile(path, 'concurrent')
      return execute(...args)
    })
    const { result, effects } = await invokeToolWithEffects('write_file', { path, content: 'after', overwrite: change !== 'created' })
    expect(result.ok).toBe(false)
    expect(result).not.toHaveProperty('operationId')
    expect(effects).toEqual([])
    if (change === 'deleted') expect(await pathExists(path)).toBe(false)
    else expect(await readFile(path, 'utf8')).toBe('concurrent')
  })

  it('does not overwrite later edits when undoing a write', async () => {
    const dir = await tempDir(), path = join(dir, 'file.txt')
    const edit = await invokeTool('write_file', { path, content: 'created' })
    await writeFile(path, 'user work')
    expect((await invokeTool('restore_file_edit', { operation_id: edit.operationId })).ok).toBe(false)
    expect(await readFile(path, 'utf8')).toBe('user work')
  })

  it('rejects invalid write content and obsolete options before creating parents', async () => {
    const dir = await tempDir(), path = join(dir, 'missing', 'file.txt')
    const tool = createFileTools({ maxReadBytes: 1_000_000, primaryFolder: dir, fileEditStore }).find((item) => item.name === 'write_file')!
    await expect(tool.invoke({ path, content: 'text', create_parents: true })).rejects.toThrow()
    const result = await invokeTool('write_file', { path, content: 'binary\0content' })
    expect(result.ok).toBe(false)
    expect(await pathExists(join(dir, 'missing'))).toBe(false)
  })

  it('queries old run history after recovery cleanup without pretending it remains restorable', async () => {
    const dir = await tempDir()
    const edit = await invokeRequestTool('apply_patch', defaultRequestId, { patch: '*** Begin Patch\n*** Add File: old.txt\n+old\n*** End Patch' }, dir)
    database.finishRun(defaultRequestId, 'cancelled')
    await fileEditStore.deleteFileEditRecordsForRequest(defaultRequestId)
    database.acknowledgeFileEditCleanup(defaultRequestId)
    expect(await pathExists(fileEditStore.editRecordsDir(defaultRequestId))).toBe(false)
    const current = randomUUID()
    const result = await invokeRequestTool('get_file_edit_diff', current, { request_id: defaultRequestId, operation_id: edit.operationId }, dir)
    expect(result).toMatchObject({ ok: true, complete: true, netDiffAvailable: true, scope: 'recorded_run_changes' })
    expect(result.patch).toContain('+old')
    const restore = await invokeRequestTool('restore_file_edit', current, { request_id: defaultRequestId, operation_id: edit.operationId }, dir)
    expect(restore.ok).toBe(false)
    expect(await readFile(join(dir, 'old.txt'), 'utf8')).toBe('old\n')
    const wrongRun = await invokeRequestTool('get_file_edit_diff', current, { operation_id: edit.operationId }, dir)
    expect(wrongRun.ok).toBe(false)
  })
  it('exposes only the batch editing entry and rejects obsolete model arguments', async () => {
    const tools = createFileTools({ maxReadBytes: 1_000_000, primaryFolder: process.cwd(), fileEditStore })
    expect(tools.map((item) => item.name)).toContain('write_file')
    expect(tools.map((item) => item.name)).not.toContain('replace_text')
    await expect(tools.find((item) => item.name === 'apply_patch')!.invoke({ path: 'a.txt', content: 'old contract' })).rejects.toThrow()
    await expect(tools.find((item) => item.name === 'apply_patch')!.invoke({ operations: [{ type: 'create', path: 'a.txt', content: 'old contract' }] })).rejects.toThrow()
    await expect(tools.find((item) => item.name === 'restore_file_edit')!.invoke({ operation_id: randomUUID(), force: true })).rejects.toThrow()
  })

  it.each(['change', 'delete'])('does not overwrite a concurrent %s after reading the batch', async (action) => {
    const dir = await tempDir(), path = join(dir, 'race.txt')
    await writeFile(path, 'before\n')
    const execute = fileEditStore.executePatch.bind(fileEditStore)
    vi.spyOn(fileEditStore, 'executePatch').mockImplementationOnce(async (...args) => {
      if (action === 'change') await writeFile(path, 'user changed\n')
      else await rm(path)
      return execute(...args)
    })
    const { result } = await invokeToolWithEffects('apply_patch', { patch: `*** Begin Patch\n*** Update File: ${path}\n@@\n-before\n+after\n*** End Patch` })
    expect(result.ok).toBe(false)
    expect(result).not.toHaveProperty('operationId')
    expect(result).not.toHaveProperty('recoveryRequestId')
    if (action === 'change') expect(await readFile(path, 'utf8')).toBe('user changed\n')
    else expect(await pathExists(path)).toBe(false)
  })

  it('creates a batch including empty and nested files, reads it, and restores the entire batch', async () => {
    const dir = await tempDir()
    const edit = await invokeRequestTool('apply_patch', defaultRequestId, { patch: '*** Begin Patch\n*** Add File: notes/today.txt\n+one\n+two\n+three\n*** Add File: empty.txt\n*** End Patch' }, dir)
    expect(edit).toMatchObject({ ok: true, operationId: expect.any(String), recoveryRequestId: defaultRequestId, state: 'applied', patchTruncated: false })
    expect(edit.patch).toContain('new file mode')
    expect(edit).not.toHaveProperty('backupPath')
    expect(await invokeRequestTool('read_file', defaultRequestId, { path: 'notes/today.txt', start_line: 2, max_lines: 1 }, dir))
      .toMatchObject({ ok: true, content: 'two\n', truncated: true })
    for (const scope of ['operation', 'request']) {
      const diff = await invokeRequestTool('get_file_edit_diff', defaultRequestId, { scope, operation_id: edit.operationId }, dir)
      expect(diff.patch).toContain('b/empty.txt')
      expect(diff.patch).toContain('b/notes/today.txt')
    }
    const preview = await invokeTool('restore_file_edit', { operation_id: edit.operationId, dry_run: true })
    expect(preview).toMatchObject({ ok: true, dryRun: true, files: expect.any(Array) })
    expect(await readFile(join(dir, 'notes/today.txt'), 'utf8')).toBe('one\ntwo\nthree\n')
    const restore = await invokeTool('restore_file_edit', { operation_id: edit.operationId })
    expect(restore).toMatchObject({ ok: true, restores: { operationId: edit.operationId } })
    expect(restore.operationId).not.toBe(edit.operationId)
    expect(await pathExists(join(dir, 'empty.txt'))).toBe(false)
    expect(await pathExists(join(dir, 'notes/today.txt'))).toBe(false)
    expect((await invokeTool('restore_file_edit', { operation_id: edit.operationId })).ok).toBe(true)
  })

  it.each(['EACCES', 'ENOENT'])('retains a published edit reference when recovery metadata becomes unavailable (%s)', async (code) => {
    const dir = await tempDir(), path = join(dir, 'written.txt')
    const load = fileEditStore.loadOperationRecord.bind(fileEditStore)
    const unavailable = Object.assign(new Error('Recovery metadata is temporarily unavailable.'), { code })
    const reader = vi.spyOn(fileEditStore, 'loadOperationRecord').mockImplementation(async (...args) => {
      const record = await load(...args)
      if (record.transaction.state === 'applied') throw unavailable
      return record
    })
    try {
      const { result, effects } = await invokeToolWithEffects('apply_patch', {
        patch: '*** Begin Patch\n*** Add File: written.txt\n+written\n*** End Patch'
      }, dir)
      expect(effects).toHaveLength(1)
      expect(result).toMatchObject({ ok: false, operationId: expect.any(String),
        recoveryRequestId: defaultRequestId, state: 'unavailable',
        recoveryError: expect.stringContaining('Recovery metadata is temporarily unavailable.') })
      expect(await readFile(path, 'utf8')).toBe('written\n')
      expect(await load(String(result.operationId), String(result.recoveryRequestId)))
        .toMatchObject({ transaction: { state: 'applied' } })
    } finally {
      reader.mockRestore()
    }
  })

  it.each([undefined, 'EACCES', 'ENOENT'])('reports the actual source when no-inverse restore finalization fails (%s)', async (code) => {
    const dir = await tempDir(), path = join(dir, 'nested/written.txt'), sourceRequestId = randomUUID()
    const edit = await invokeRequestTool('apply_patch', sourceRequestId, {
      patch: '*** Begin Patch\n*** Add File: nested/written.txt\n+written\n*** End Patch'
    }, dir)
    await rm(path)
    const load = fileEditStore.loadOperationRecord.bind(fileEditStore)
    const persist = database.fileChanges.persist.bind(database.fileChanges)
    vi.spyOn(database.fileChanges, 'persist').mockImplementation((record, observed) => {
      if (record.operationId === edit.operationId && record.transaction.recovery) {
        throw new Error('Failed to persist the finalized source in the file-change ledger.')
      }
      return persist(record, observed)
    })
    vi.spyOn(fileEditStore, 'loadOperationRecord').mockImplementation(async (...args) => {
      const record = await load(...args)
      if (code && record.operationId === edit.operationId && record.transaction.recovery) {
        throw Object.assign(new Error('Finalized source metadata is temporarily unavailable.'), { code })
      }
      return record
    })

    const { result, effects } = await invokeToolWithEffects('restore_file_edit', {
      operation_id: edit.operationId, request_id: sourceRequestId
    }, dir)

    expect(effects).toEqual([expect.objectContaining({ kind: 'file_patch',
      target: expect.objectContaining({ operationId: edit.operationId, requestId: sourceRequestId }) })])
    expect(result).toMatchObject({ ok: false, operationId: edit.operationId, recoveryRequestId: sourceRequestId,
      state: code ? 'unavailable' : 'resolved', error: expect.stringContaining('Failed to persist the finalized source') })
    if (code) expect(result.recoveryError).toContain('Finalized source metadata is temporarily unavailable.')
    else expect(result.recovery).toEqual({ state: 'complete', inverse: null })
    expect(await load(String(edit.operationId), sourceRequestId))
      .toMatchObject({ transaction: { state: 'resolved', recovery: { state: 'complete', inverse: null } } })
    expect(await fileEditStore.listEditRecordsForRequest(defaultRequestId)).toEqual([])
    expect(await pathExists(path)).toBe(false)
  })

  it('requires durable identity and checkpointed authorization in production calls', async () => {
    const dir = await tempDir(), path = join(dir, 'new.txt')
    const selected = createFileTools({ maxReadBytes: 1_000_000, primaryFolder: dir, requestId: defaultRequestId, fileEditStore }).find((item) => item.name === 'apply_patch')!
    const input = { patch: `*** Begin Patch\n*** Add File: ${path}\n+new\n*** End Patch` }
    expect(JSON.parse(String(await selected.invoke(input)))).toMatchObject({ ok: false, error: expect.stringContaining('durable effect identity') })
    expect(JSON.parse(String(await selected.invoke({ ...input, dry_run: true })))).toMatchObject({ ok: false, error: expect.stringContaining('checkpointed path authorization') })
    expect(await pathExists(path)).toBe(false)
  })

  it('validates the whole dry run without creating directories or arming effects', async () => {
    const dir = await tempDir(), path = join(dir, 'nested/new.txt')
    const preview = await invokeToolWithEffects('apply_patch', { dry_run: true, patch: `*** Begin Patch\n*** Add File: ${path}\n+new\n*** End Patch` })
    expect(preview.result).toMatchObject({ ok: true, dryRun: true, patch: expect.stringContaining('+new') })
    expect(preview.effects).toEqual([])
    expect(await pathExists(join(dir, 'nested'))).toBe(false)
    const bad = await invokeToolWithEffects('apply_patch', { dry_run: true, patch: `*** Begin Patch\n*** Add File: ${path}\n+new\n*** Delete File: ${join(dir, 'missing')}\n*** End Patch` })
    expect(bad.result.ok).toBe(false)
    expect(bad.result).not.toHaveProperty('operationId')
    expect(bad.result).not.toHaveProperty('recoveryRequestId')
    expect(bad.effects).toEqual([])
    expect(await fileEditStore.listEditRecordsForRequest(defaultRequestId)).toEqual([])
  })

  it('restores from another request only when the source request is explicit', async () => {
    const dir = await tempDir(), other = randomUUID(), path = join(dir, 'new.txt')
    const edit = await invokeRequestTool('apply_patch', other, { patch: `*** Begin Patch\n*** Add File: ${path}\n+new\n*** End Patch` })
    expect(edit.ok).toBe(true)
    expect((await invokeTool('restore_file_edit', { operation_id: edit.operationId })).ok).toBe(false)
    expect((await invokeTool('restore_file_edit', { operation_id: edit.operationId, request_id: other })).ok).toBe(true)
    expect(await pathExists(path)).toBe(false)
  })

  it('rejects whole-batch restore on an external change and preserves the other files', async () => {
    const dir = await tempDir(), a = join(dir, 'a.txt'), b = join(dir, 'b.txt')
    const edit = await invokeTool('apply_patch', { patch: `*** Begin Patch\n*** Add File: ${a}\n+a\n*** Add File: ${b}\n+b\n*** End Patch` })
    expect(edit.ok).toBe(true)
    await writeFile(b, 'external')
    const restored = await invokeTool('restore_file_edit', { operation_id: edit.operationId })
    expect(restored.ok).toBe(false)
    expect(await readFile(a, 'utf8')).toBe('a\n')
    expect(await readFile(b, 'utf8')).toBe('external')
  })

  it('replays the historical operation without overwriting later user changes', async () => {
    const dir = await tempDir(), path = join(dir, 'new.txt')
    const selected = createFileTools({ maxReadBytes: 1_000_000, primaryFolder: dir, requestId: defaultRequestId, fileEditStore, authorizePatch: async () => {} }).find((item) => item.name === 'apply_patch')!
    const effects: AgentToolEffectArm[] = []
    const scope = { effectKey: stableFileEffectKey, isUnarmed: () => effects.length === 0, previousEffect: () => effects.at(-1), arm: (effect: AgentToolEffectArm) => { effects.push(effect) } }
    const input = { patch: `*** Begin Patch\n*** Add File: ${path}\n+original\n*** End Patch` }
    const first = JSON.parse(String(await runWithCurrentAgentToolEffect(scope, () => selected.invoke(input))))
    expect(first.ok).toBe(true)
    await writeFile(path, 'later user changes')
    const next = JSON.parse(String(await runWithCurrentAgentToolEffect(scope, () => selected.invoke(input))))
    expect(next).toEqual(first)
    expect(await readFile(path, 'utf8')).toBe('later user changes')
    expect(await fileEditStore.listEditRecordsForRequest(defaultRequestId)).toHaveLength(1)
  })

  it('uses unique context without line numbers, preserves file mode, and bounds diff output', async () => {
    const dir = await tempDir(), path = join(dir, 'old.txt')
    await writeFile(path, 'before\nbefore\n', { mode: 0o640 })
    const mode = (await lstat(path)).mode
    const edit = await invokeTool('apply_patch', { patch: `*** Begin Patch\n*** Update File: ${path}\n@@\n before\n-before\n+after\n*** End Patch` })
    expect(edit.ok).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('before\nafter\n')
    expect((await lstat(path)).mode).toBe(mode)
    const bad = await invokeTool('apply_patch', { patch: `*** Begin Patch\n*** Update File: ${path}\n@@\n before\n-before\n+again\n*** End Patch` })
    expect(bad.ok).toBe(false)
    expect(bad).not.toHaveProperty('operationId')
    expect(bad).not.toHaveProperty('recoveryRequestId')
    const diff = await invokeTool('get_file_edit_diff', { scope: 'operation', operation_id: edit.operationId, max_chars: 20 })
    expect(String(diff.patch).length).toBeLessThanOrEqual(20)
    expect(diff.patchTruncated).toBe(true)
    expect((await invokeTool('restore_file_edit', { operation_id: edit.operationId })).ok).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('before\nbefore\n')
  })

  it('creates every file tool by default and honors a subagent tool scope', () => {
    const allTools = createFileTools({ maxReadBytes: 1_000_000,
      primaryFolder: process.cwd(),
      fileEditStore
    }).map((item) => item.name)
    const scopedTools = createFileTools({ maxReadBytes: 1_000_000,
      primaryFolder: process.cwd(),
      fileEditStore,
      toolNames: ['apply_patch', 'restore_file_edit', 'get_file_edit_diff']
    }).map((item) => item.name)

    expect(allTools).toContain('read_file')
    expect(allTools).toContain('delete_file')
    expect(scopedTools).not.toContain('read_file')
    expect(scopedTools).not.toContain('delete_file')
    expect(scopedTools).toContain('apply_patch')
    expect(scopedTools).toContain('restore_file_edit')
    expect(scopedTools).toContain('get_file_edit_diff')
  })

  it('offers an optional localized display summary on every file tool', () => {
    const tools = createFileTools({ maxReadBytes: 1_000_000,
      primaryFolder: process.cwd(),
      fileEditStore
    })

    for (const fileTool of tools) {
      const schema = fileTool.schema as unknown as {
        shape: {
          summary?: {
            description?: string
            safeParse: (value: unknown) => { success: boolean }
          }
        }
      }
      expect(schema.shape.summary?.description).toContain("user's language")
      expect(schema.shape.summary?.safeParse(undefined).success).toBe(true)
    }
  })

  it('separates globally enabled file read and write tools before applying a subagent scope', () => {
    const features: AgentFeatures = {
      configuration: true,
      profile: true,
      environment: true,
      applicationEnvironment: true,
      subagents: true,
      workspaceContext: true,
      memory: true,
      skills: true,
      mcp: true,
      planning: true,
      commandExecution: true,
      networkAccess: true,
      backgroundTools: true,
      fileRead: true,
      fileWrite: false
    }
    const readOnlyTools = createFileTools({ maxReadBytes: 1_000_000,
      primaryFolder: process.cwd(),
      fileEditStore,
      toolNames: enabledBuiltinFileToolNames(features)
    }).map((tool) => tool.name)
    const scopedTools = enabledBuiltinFileToolNames(
      { ...features, fileWrite: true },
      ['read_file', 'apply_patch']
    )
    const writeOnlyTools = enabledBuiltinFileToolNames({
      ...features,
      fileRead: false,
      fileWrite: true
    })

    expect(readOnlyTools).toContain('read_file')
    expect(readOnlyTools).not.toContain('get_file_edit_diff')
    expect(readOnlyTools).not.toContain('apply_patch')
    expect(readOnlyTools).not.toContain('write_file')
    expect(readOnlyTools).not.toContain('delete_file')
    expect(writeOnlyTools).toContain('get_file_edit_diff')
    expect(scopedTools).toEqual(['read_file', 'apply_patch'])
  })

  it('streams requested line slices from files larger than the full-read limit', async () => {
    const dir = await tempDir()
    const path = join(dir, 'large.txt')
    const lines = Array.from({ length: 80_000 }, (_value, index) => `line-${index + 1}`)
    await writeFile(path, lines.join('\n'), 'utf8')

    const read = await invokeTool('read_file', {
      path,
      start_line: 79_999,
      max_lines: 2
    })

    expect(read).toMatchObject({
      ok: true,
      startLine: 79_999,
      lineCount: 80_000,
      returnedLineCount: 2,
      truncated: false,
      content: 'line-79999\nline-80000'
    })
    expect(read).not.toHaveProperty('path')

    const capped = await invokeTool('read_file', {
      path,
      start_line: 1,
      max_lines: 5_000
    })
    expect(capped).toMatchObject({
      ok: true,
      returnedLineCount: 5_000,
      truncated: true
    })
    expect(String(capped.content).startsWith('line-1\nline-2')).toBe(true)
    expect(String(capped.content).endsWith('line-5000\n')).toBe(true)
  })

  it('caps aggregate output when reading multiple files', async () => {
    const dir = await tempDir()
    const first = join(dir, 'first.txt')
    const second = join(dir, 'second.txt')
    await writeFile(first, 'a'.repeat(600_000), 'utf8')
    await writeFile(second, 'b'.repeat(600_000), 'utf8')

    const result = await invokeTool('read_multiple_files', {
      paths: [first, second]
    })

    expect(result).toMatchObject({
      ok: true,
      fileLimit: 20,
      byteLimit: 1_000_000,
      returnedBytes: 600_000,
      truncated: true
    })
    const files = result.files as Array<Record<string, unknown>>
    expect(files[0]).toMatchObject({ ok: true, path: first, size: 600_000 })
    expect(String(files[0].content)).toHaveLength(600_000)
    expect(files[1]).toMatchObject({ ok: false, path: second, size: 600_000, error: expect.stringContaining('aggregate read limit exceeded') })
  })

  it('lists directories, builds trees, and reports file info', async () => {
    const dir = await tempDir()
    const nested = join(dir, 'nested')
    const target = join(nested, 'target.txt')
    const created = await invokeTool('create_directory', { path: nested })
    expect(created).toEqual({ ok: true })
    await writeFile(join(dir, 'root.txt'), 'root', 'utf8')
    await writeFile(target, 'first\nneedle\nthird', 'utf8')

    const list = await invokeTool('list_directory', { path: dir })
    expect(list.ok).toBe(true)
    expect(list.limit).toBe(300)
    expect(list).not.toHaveProperty('path')
    expect(list.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'nested', type: 'directory' }),
      expect.objectContaining({ name: 'root.txt', type: 'file' })
    ]))
    for (const entry of list.entries as Array<Record<string, unknown>>) {
      expect(entry).not.toHaveProperty('path')
    }

    const tree = await invokeTool('directory_tree', { path: dir })
    expect(tree).toMatchObject({
      ok: true,
      returnedCount: 4,
      depthLimit: 64,
      truncated: false,
      hasMore: false,
      depthTruncated: false,
      accessTruncated: false
    })
    expect(tree).not.toHaveProperty('path')
    expect(tree.entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ relativePath: '.', type: 'directory', depth: 0 }),
      expect.objectContaining({ relativePath: join('nested', 'target.txt'), type: 'file', depth: 2 })
    ]))
    expect(JSON.stringify(tree.entries)).not.toContain(dir)

    const info = await invokeTool('get_file_info', { path: target })
    expect(info).toMatchObject({
      ok: true,
      type: 'file',
      lineCount: 3
    })
    expect(info).not.toHaveProperty('path')
  })

  it('caps broad directory outputs with explicit truncation metadata', async () => {
    const dir = await tempDir()
    await writeFile(join(dir, 'target-a.txt'), 'a', 'utf8')
    await writeFile(join(dir, 'target-b.txt'), 'b', 'utf8')
    await writeFile(join(dir, 'target-c.txt'), 'c', 'utf8')

    const cappedList = await invokeTool('list_directory', {
      path: dir,
      limit: 10_000
    })
    expect(cappedList).toMatchObject({ ok: true, limit: 1000, truncated: false })

    const limitedList = await invokeTool('list_directory', {
      path: dir,
      limit: 2
    })
    expect(limitedList).toMatchObject({ ok: true, limit: 2, truncated: true })
    expect(limitedList.entries).toHaveLength(2)

    const cappedTree = await invokeTool('directory_tree', {
      path: dir,
      max_entries: 10_000
    })
    expect(cappedTree).toMatchObject({
      ok: true,
      entryLimit: 1000,
      returnedCount: 4,
      truncated: false,
      hasMore: false
    })

    const limitedTree = await invokeTool('directory_tree', {
      path: dir,
      max_entries: 2
    })
    expect(limitedTree).toMatchObject({
      ok: true,
      entryLimit: 2,
      returnedCount: 2,
      truncated: true,
      hasMore: true,
      nextCursor: expect.any(String)
    })
    const continuedTree = await invokeTool('directory_tree', {
      path: dir,
      max_entries: 2,
      cursor: limitedTree.nextCursor
    })
    expect(continuedTree).toMatchObject({
      ok: true,
      entryLimit: 2,
      returnedCount: 2,
      truncated: false,
      hasMore: false
    })
    expect([
      ...(limitedTree.entries as Array<Record<string, unknown>>),
      ...(continuedTree.entries as Array<Record<string, unknown>>)
    ].map((entry) => entry.relativePath).sort()).toEqual([
      '.',
      'target-a.txt',
      'target-b.txt',
      'target-c.txt'
    ])
  })

  it('walks directory trees breadth-first and limits expansion depth', async () => {
    const dir = await tempDir()
    const deep = join(dir, 'a-branch', 'deep')
    await mkdir(deep, { recursive: true })
    await writeFile(join(deep, 'leaf.txt'), 'leaf', 'utf8')
    await writeFile(join(dir, 'z-root.txt'), 'root', 'utf8')

    const firstPage = await invokeTool('directory_tree', {
      path: dir,
      max_entries: 3
    })
    expect(firstPage).toMatchObject({
      ok: true,
      returnedCount: 3,
      hasMore: true,
      nextCursor: expect.any(String)
    })
    expect((firstPage.entries as Array<Record<string, unknown>>).map((entry) => entry.relativePath).sort()).toEqual([
      '.',
      'a-branch',
      'z-root.txt'
    ])

    const depthLimited = await invokeTool('directory_tree', {
      path: dir,
      max_entries: 10,
      max_depth: 1
    })
    expect(depthLimited).toMatchObject({
      ok: true,
      depthLimit: 1,
      returnedCount: 3,
      truncated: true,
      hasMore: false,
      depthTruncated: true
    })
    expect(JSON.stringify(depthLimited.entries)).not.toContain('deep')

    const unlimited = await invokeTool('directory_tree', {
      path: dir,
      max_entries: 10
    })
    expect(unlimited).toMatchObject({
      ok: true,
      depthLimit: 64,
      returnedCount: 5,
      truncated: false,
      depthTruncated: false,
      accessTruncated: false
    })
    expect(JSON.stringify(unlimited.entries)).toContain('leaf.txt')
  })

  it.runIf(process.platform !== 'win32')('continues past unreadable descendant directories', async () => {
    const dir = await tempDir()
    const locked = join(dir, 'locked')
    await mkdir(locked)
    await writeFile(join(locked, 'hidden.txt'), 'hidden', 'utf8')
    await writeFile(join(dir, 'visible.txt'), 'visible', 'utf8')
    await chmod(locked, 0o000)

    try {
      const tree = await invokeTool('directory_tree', {
        path: dir,
        max_entries: 10
      })
      expect(tree).toMatchObject({
        ok: true,
        returnedCount: 3,
        truncated: true,
        hasMore: false,
        depthTruncated: false,
        accessTruncated: true
      })
      expect(tree.errors).toEqual([{ relativePath: 'locked', errorCode: expect.stringMatching(/^(EACCES|EPERM)$/) }])
      expect(tree.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ relativePath: 'locked', type: 'directory' }),
        expect.objectContaining({
          relativePath: 'visible.txt',
          type: 'file'
        })
      ]))
      expect(JSON.stringify(tree.entries)).not.toContain('hidden.txt')
    } finally {
      await chmod(locked, 0o700)
    }
  })

  it('treats symlinked directories as leaves during recursive traversal', async () => {
    const dir = await tempDir()
    const outside = await tempDir()
    const link = join(dir, 'linked')
    await writeFile(join(outside, 'target.txt'), 'needle', 'utf8')
    try {
      await symlink(outside, link, 'junction')
    } catch (error) {
      if (['EPERM', 'EINVAL', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) return
      throw error
    }

    const tree = await invokeTool('directory_tree', {
      path: dir,
      max_entries: 10
    })
    expect(tree.ok).toBe(true)
    expect(JSON.stringify(tree.entries)).toContain('linked')
    expect(JSON.stringify(tree.entries)).not.toContain('target.txt')
  })

  it('moves and deletes files', async () => {
    const dir = await tempDir()
    const source = join(dir, 'source.txt')
    const destination = join(dir, 'moved', 'destination.txt')
    await writeFile(source, 'move me', 'utf8')

    const move = await invokeTool('move_file', {
      source,
      destination,
      create_parents: true
    })
    expect(move).toEqual({ ok: true })
    expect(await readFile(destination, 'utf8')).toBe('move me')

    const deleted = await invokeTool('delete_file', { path: destination })
    expect(deleted).toEqual({ ok: true })
    const missing = await invokeTool('read_file', { path: destination })
    expect(missing.ok).toBe(false)
  })

  it('refuses to move over an existing destination unless overwrite is true', async () => {
    const dir = await tempDir()
    const source = join(dir, 'source.txt')
    const destination = join(dir, 'destination.txt')
    await writeFile(source, 'source', 'utf8')
    await writeFile(destination, 'destination', 'utf8')

    const refused = await invokeTool('move_file', {
      source,
      destination
    })
    expect(refused).toMatchObject({ ok: false, error: 'destination already exists', source, destination })
    expect(await readFile(source, 'utf8')).toBe('source')
    expect(await readFile(destination, 'utf8')).toBe('destination')

    const moved = await invokeTool('move_file', {
      source,
      destination,
      overwrite: true
    })
    expect(moved).toEqual({ ok: true })
    expect(await pathExists(source)).toBe(false)
    expect(await readFile(destination, 'utf8')).toBe('source')
  })

  it('rejects binary files when reading as text', async () => {
    const dir = await tempDir()
    const path = join(dir, 'binary.dat')
    await writeFile(path, Buffer.from([0x61, 0x00, 0x62]))

    const result = await invokeTool('read_file', { path })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('file appears to be binary')
  })
})
