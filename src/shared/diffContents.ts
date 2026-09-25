/** Full text or an explicit unavailable state. Text is never a clipped patch. */
export const DIFF_MAX_BYTES = 1_000_000
export type DiffUnavailableReason = 'binary' | 'too_large' | 'encoding' | 'unsupported' | 'history_missing' | 'conflict' | 'changing'
export type DiffContents = { status: 'ready'; path: string; before: string; after: string; beforeExists: boolean; afterExists: boolean }
  | { status: 'unavailable'; path: string; reason: DiffUnavailableReason }
