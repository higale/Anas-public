import { ProjectOperationFailure, type ProjectIssue, type ProjectOperationResult } from '@shared/projectOperation'
import { runtimeLog } from './runtimeLogger'

export async function projectOperation<T>(operation: () => Promise<T>): Promise<ProjectOperationResult<T>> {
  try {
    return { status: 'ok', value: await operation() }
  } catch (reason) {
    if (reason instanceof ProjectOperationFailure) return { status: 'error', error: reason.issue }
    runtimeLog('error', 'projects', 'Project operation failed.', { error: reason })
    const error = reason as NodeJS.ErrnoException | undefined
    const path = typeof error?.path === 'string' ? error.path : undefined
    let code: ProjectIssue['code'] = 'unexpected'
    if (error?.code === 'ENOENT') code = 'path_not_found'
    else if (error?.code === 'ENOTDIR') code = 'not_directory'
    else if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'EROFS') code = 'permission_denied'
    else if (error?.code === 'ENOSPC' || error?.code === 'EDQUOT') code = 'storage_full'
    return { status: 'error', error: { code, ...(path ? { path } : {}) } }
  }
}
