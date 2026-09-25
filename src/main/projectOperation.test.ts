import { describe, expect, it, vi } from 'vitest'
import { ProjectOperationFailure } from '@shared/projectOperation'
import { projectOperation } from './projectOperation'
import { runtimeLog } from './runtimeLogger'

vi.mock('./runtimeLogger', () => ({ runtimeLog: vi.fn() }))

describe('project operation IPC results', () => {
  it('preserves domain error data across serialization without exposing diagnostic text', async () => {
    const issue = { code: 'duplicate_name' as const, name: 'Project “A”' }
    const result = await projectOperation(async () => { throw new ProjectOperationFailure(issue, 'English diagnostic') })
    expect(JSON.parse(JSON.stringify(result))).toEqual({ status: 'error', error: issue })
    expect(await projectOperation(async () => ['folder'])).toEqual({ status: 'ok', value: ['folder'] })
  })

  it.each([
    ['ENOENT', 'path_not_found'], ['ENOTDIR', 'not_directory'], ['EACCES', 'permission_denied'],
    ['EPERM', 'permission_denied'], ['EROFS', 'permission_denied'], ['ENOSPC', 'storage_full'], ['EDQUOT', 'storage_full']
  ])('classifies %s without parsing platform error prose', async (code, expected) => {
    const reason = Object.assign(new Error('OS diagnostic'), { code, path: '/project/data' })
    expect(await projectOperation(async () => { throw reason })).toEqual({
      status: 'error', error: { code: expected, path: '/project/data' }
    })
    expect(runtimeLog).toHaveBeenLastCalledWith('error', 'projects', expect.any(String), { error: reason })
  })

  it('keeps unknown diagnostics in the log and returns a translatable failure', async () => {
    const reason = new Error('Unexpected English implementation detail')
    expect(await projectOperation(async () => { throw reason })).toEqual({ status: 'error', error: { code: 'unexpected' } })
    expect(runtimeLog).toHaveBeenLastCalledWith('error', 'projects', expect.any(String), { error: reason })
  })
})
