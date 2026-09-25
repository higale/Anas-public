export type GitReadErrorCode = 'not_repository' | 'read_failed' | 'stale' | 'invalid_commit'
export type GitReadResponse<T> = T | { error: GitReadErrorCode }

/** Domain failures are serialized as codes at the IPC boundary. */
export class GitReadError extends Error {
  constructor(readonly code: GitReadErrorCode, message: string, options?: ErrorOptions) { super(message, options) }
}

export interface GitChangeQuery {
  sourceFolder: string
  scope: 'workspace' | 'baseline' | 'staged' | 'unstaged'
  /** Explicit commit-ish, resolved to an immutable commit before reading. */
  baseline?: string
  /** Pinned target commit for committed comparisons. */
  head?: string
  includePatch?: boolean
  filePath?: string
  after?: number
  limit?: number
  version?: string
}

export interface GitChangeReadInput extends GitChangeQuery { projectId: string }

export interface GitChangeFile {
  path: string
  relativePath: string
  status: string
  source: 'tracked' | 'untracked'
  patch: string
  patchTruncated: boolean
  addedLines?: number
  removedLines?: number
  unavailableReason?: string
}

export interface GitChangeResult {
  scope: 'workspace' | 'baseline' | 'staged' | 'unstaged'
  sourceFolder: string
  repositoryRoot: string
  head: string | null
  baseline: string | null
  baselineLabel?: string
  version: string
  fileCount: number
  files: GitChangeFile[]
  hasMore: boolean
  nextAfter?: number
}

/** Single-file reads use current content, independently of list paging versions. */
export interface GitContentInput extends Pick<GitChangeReadInput, 'projectId' | 'sourceFolder' | 'scope' | 'head'> {
  filePath: string
  baseline?: string | null
}
export interface GitReferenceQuery { projectId: string; sourceFolder: string; kind: 'refs' | 'history' | 'resolve'; ref?: string; after?: number }
export interface GitReference { value: string; label: string; commit: string; group: 'head' | 'local' | 'remote' | 'tag' | 'history'; current?: boolean }
export interface GitReferenceResult { repositoryRoot: string; entries: GitReference[]; hasMore: boolean; historyHead?: string }
