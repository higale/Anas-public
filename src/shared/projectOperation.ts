export type ProjectIssueCode =
  | 'duplicate_name' | 'name_required' | 'name_too_long'
  | 'prompt_invalid' | 'prompt_too_long' | 'invalid_settings' | 'not_found'
  | 'folders_required' | 'not_directory' | 'path_not_found'
  | 'permission_denied' | 'storage_full' | 'unexpected'

export interface ProjectIssue {
  code: ProjectIssueCode
  name?: string
  path?: string
}

export type ProjectOperationResult<T> =
  | { status: 'ok'; value: T }
  | { status: 'error'; error: ProjectIssue }

export class ProjectOperationFailure extends Error {
  constructor(readonly issue: ProjectIssue, diagnostic: string = issue.code) {
    super(diagnostic)
  }
}

export function unwrapProjectResult<T>(result: ProjectOperationResult<T>): T {
  if (result.status === 'error') throw new ProjectOperationFailure(result.error)
  return result.value
}
