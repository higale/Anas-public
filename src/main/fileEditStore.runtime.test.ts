import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { configureDataRuntime, getDataDir } from './config/dataDir'
import {
  deleteFileEditRecordsForRequest,
  editRecordDir,
  editRecordsDir,
  FileEditStore,
  getDefaultFileEditStore,
  listEditRecordsForRequest,
  listRetainedEditRecords,
  loadOperationRecord,
  pathExists
} from './fileEditStore'
import { createFileTools } from './llm/fileTools'
import { runWithCurrentAgentToolEffect } from './agent/toolEffectScope'
import { withApplicationDataSnapshot } from './applicationDataSnapshot'

// Static imports run before profile configuration, as they do in the main entry.
// Even a regression must never write to the developer's real home directory.
const home = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  return mkdtempSync(join(tmpdir(), 'anas-file-edit-runtime-'))
})
vi.mock('node:os', async (original) => ({
  ...await original<typeof import('node:os')>(), homedir: () => home
}))
vi.mock('electron', () => ({ app: { isPackaged: false, setPath: vi.fn() } }))

afterAll(() => rm(home, { recursive: true, force: true }))

function selectProfile(name: string): string {
  configureDataRuntime(['electron', 'app', '--data-dir', join(home, name)])
  return getDataDir()
}

function writeTool(primaryFolder: string, requestId: string, fileEditStore?: FileEditStore) {
  return createFileTools({ primaryFolder, requestId, maxReadBytes: 1_000_000,
    toolNames: ['write_file'], authorizePatch: async () => {}, fileEditStore })[0]
}

async function write(tool: ReturnType<typeof writeTool>, requestId: string, name: string) {
  const result = await runWithCurrentAgentToolEffect({
    effectKey: { runId: requestId, checkpointId: 'profile-checkpoint', checkpointNs: 'tools:profile-task',
      taskId: 'profile-task', callKey: randomUUID(), inputHash: 'a'.repeat(64) },
    isUnarmed: () => true, arm: () => {}
  }, () => tool.invoke({ path: name, content: name, summary: 'Write profile fixture' }))
  const output = JSON.parse(result as string) as { ok: boolean; operationId: string }
  expect(output).toMatchObject({ ok: true, operationId: expect.any(String) })
  return output.operationId
}

describe('file edit store profile binding', () => {
  it('uses configuration applied after imports and binds each created tool group to its profile', async () => {
    const workspace = join(home, 'workspace')
    await mkdir(workspace)
    const requestId = randomUUID()
    const first = selectProfile('first')
    const firstStore = getDefaultFileEditStore()
    const firstTool = writeTool(workspace, requestId)
    const second = selectProfile('second')
    const secondTool = writeTool(workspace, requestId)

    const firstOperation = await write(firstTool, requestId, 'first.txt')
    const secondOperation = await write(secondTool, requestId, 'second.txt')
    expect(await readFile(join(workspace, 'first.txt'), 'utf8')).toBe('first.txt')
    expect(await readFile(join(workspace, 'second.txt'), 'utf8')).toBe('second.txt')
    expect((await firstStore.loadOperationRecord(firstOperation, requestId)).operationId).toBe(firstOperation)
    expect(await firstStore.listEditRecordsForRequest(requestId)).toHaveLength(1)
    expect(editRecordsDir(requestId)).toBe(join(second, 'file_edits', requestId))
    expect(editRecordDir(requestId, secondOperation)).toBe(join(second, 'file_edits', requestId, secondOperation))
    expect((await listEditRecordsForRequest(requestId)).map(record => record.operationId)).toEqual([secondOperation])
    expect(await pathExists(join(first, 'file_edits', requestId, secondOperation))).toBe(false)

    const secondRead = loadOperationRecord(secondOperation, requestId)
    selectProfile('first')
    expect((await secondRead).operationId).toBe(secondOperation)
    expect((await loadOperationRecord(firstOperation, requestId)).operationId).toBe(firstOperation)
    await deleteFileEditRecordsForRequest(requestId, [firstOperation])
    expect((await listRetainedEditRecords()).map(record => record.operationId)).toEqual([firstOperation])
    selectProfile('second')
    expect(await listRetainedEditRecords()).toEqual([])
    await deleteFileEditRecordsForRequest(requestId)
    expect(await listEditRecordsForRequest(requestId)).toEqual([])
    expect((await firstStore.listEditRecordsForRequest(requestId)).map(record => record.operationId)).toEqual([firstOperation])
    expect(await pathExists(join(home, '.galeAnas', 'file_edits'))).toBe(false)
  })

  it('keeps explicit stores and pending cleanup on their captured roots after another profile is selected', async () => {
    const workspace = join(home, 'cleanup-workspace')
    await mkdir(workspace)
    const requestId = randomUUID()
    selectProfile('cleanup-owner')
    const ownerStore = getDefaultFileEditStore()
    const ownerTool = writeTool(workspace, requestId)
    const explicitStore = new FileEditStore(join(home, 'explicit-records'))
    const explicitTool = writeTool(workspace, requestId, explicitStore)
    const ownerOperation = await write(ownerTool, requestId, 'owner.txt')

    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const entered = new Promise<void>(resolve => { started = resolve })
    const snapshot = withApplicationDataSnapshot(async () => { started(); await gate })
    await entered
    const cleanup = deleteFileEditRecordsForRequest(requestId)
    selectProfile('cleanup-other')
    release()
    await snapshot
    await cleanup
    expect(await ownerStore.listEditRecordsForRequest(requestId)).toEqual([])
    expect(await pathExists(ownerStore.editRecordDir(requestId, ownerOperation))).toBe(false)
    expect(await readFile(join(workspace, 'owner.txt'), 'utf8')).toBe('owner.txt')

    const explicitOperation = await write(explicitTool, requestId, 'explicit.txt')
    expect((await explicitStore.loadOperationRecord(explicitOperation, requestId)).operationId).toBe(explicitOperation)
    expect(await listEditRecordsForRequest(requestId)).toEqual([])
  })
})
