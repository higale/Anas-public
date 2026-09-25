export interface FileChangeQuery {
  runId: string
  operationId?: string
  filePath?: string
  after?: number
  limit?: number
  maxChars?: number
  includePatch?: boolean
  version?: string
}

export interface FileChangeOrigin {
  runId: string
  threadId: string
  actor: string
  operationId: string
  entryIndex: number
  direction: 'forward' | 'inverse' | 'compensation'
}

export interface FileChangeSegment {
  beforeHash?: string | null
  afterHash?: string | null
  path: string
  origins: FileChangeOrigin[]
  beforeExists: boolean
  afterExists: boolean
  continuity: 'recorded' | 'external_change' | 'uncertain' | 'page_boundary'
  cancelledOut: boolean
  patch: string
  patchTruncated: boolean
  addedLines?: number
  removedLines?: number
  unavailableReason?: string
}

export interface FileChangeQueryResult {
  scope: 'recorded_run_changes'
  runId: string
  operationId?: string
  filePath?: string
  version: string
  operationCount: number
  segments: FileChangeSegment[]
  issues: Array<{ runId: string; operationId?: string; path?: string; reason: string }>
  pendingRunIds: string[]
  complete: boolean
  netDiffAvailable: boolean
  hasMore: boolean
  nextAfter?: number
  patch: string
  patchTruncated: boolean
}

export interface FileChangeRoundListInput { threadId: string; after?: number; limit?: number; selectedRunId?: string }
export interface FileChangeRound { runId: string; createdAt: string; summary: string; status: string }
export interface FileChangeRoundListResult { rounds: FileChangeRound[]; hasMore: boolean; nextAfter?: number; selectedRound?: FileChangeRound | null }

export interface RoundFileChangesInput {
  runId: string
  filePath?: string
  after?: string
  limit?: number
  version?: string
}
export interface RoundFileChangesReadInput extends RoundFileChangesInput { threadId: string }
export type RoundFileChange = Omit<FileChangeSegment, 'patch' | 'patchTruncated' | 'addedLines' | 'removedLines'>
export interface RoundFileChangesResult {
  runId: string
  version: string
  files: RoundFileChange[]
  pendingRunIds: string[]
  issues: FileChangeQueryResult['issues']
  hasMore: boolean
  nextAfter?: string
}
export interface RoundFileContentInput {
  threadId: string
  runId: string
  filePath: string
  version: string
  target: 'recorded' | 'current'
}
