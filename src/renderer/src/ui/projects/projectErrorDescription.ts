import type { TFunction } from 'i18next'
import { ProjectOperationFailure, type ProjectIssueCode } from '@shared/projectOperation'

const translationKeys: Record<ProjectIssueCode, string> = {
  duplicate_name: 'project.errors.duplicate_name',
  name_required: 'project.errors.name_required',
  name_too_long: 'project.errors.name_too_long',
  prompt_invalid: 'project.errors.prompt_invalid',
  prompt_too_long: 'project.errors.prompt_too_long',
  invalid_settings: 'project.errors.invalid_settings',
  not_found: 'project.errors.not_found',
  folders_required: 'project.errors.folders_required',
  not_directory: 'project.errors.not_directory',
  path_not_found: 'project.errors.path_not_found',
  permission_denied: 'project.errors.permission_denied',
  storage_full: 'project.errors.storage_full',
  unexpected: 'project.errors.unexpected'
}

export function projectErrorDescription(reason: unknown, t: TFunction): string {
  const issue = reason instanceof ProjectOperationFailure ? reason.issue : { code: 'unexpected' as const }
  const description = t(translationKeys[issue.code], { name: issue.name })
  return issue.path ? `${description}\n${issue.path}` : description
}
