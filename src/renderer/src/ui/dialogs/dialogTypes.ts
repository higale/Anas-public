import type { DataCleanupTarget, StorageUsageValue } from '@shared/types'

export type ConfirmDialogRequest = {
  title: string
  description: string
  confirmText?: string
  variant?: 'default' | 'danger'
  onConfirm: () => void | Promise<void>
}

export type DataCleanupDialogTarget =
  | DataCleanupTarget
  | 'agent_unpinned_threads'
  | 'memories'

export type DataCleanupSelection = Record<DataCleanupDialogTarget, boolean>
export type DataCleanupUsage = Partial<Record<DataCleanupDialogTarget, StorageUsageValue>>

export const dataCleanupTargets: DataCleanupDialogTarget[] = [
  'agent_unpinned_threads',
  'memories',
  'input_history',
  'cache_folder',
  'temp_folder',
  'log_folder',
  'developer_http_trace'
]

export function defaultDataCleanupSelection(): DataCleanupSelection {
  return {
    agent_unpinned_threads: false,
    memories: false,
    input_history: true,
    cache_folder: true,
    temp_folder: true,
    log_folder: true,
    developer_http_trace: true
  }
}
