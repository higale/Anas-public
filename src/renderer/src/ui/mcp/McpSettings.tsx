import type { FormEvent, RefObject } from 'react'
import type { AppConfigSnapshot, McpToolStatus } from '@shared/types'
import { McpEditor } from './McpEditor'
import { McpListPane } from './McpListPane'
import type { McpDraft } from './mcpDraft'

interface McpSettingsProps {
  config: AppConfigSnapshot | undefined
  editingIndex?: number
  listRef: RefObject<HTMLDivElement | null>
  mcpDraft: McpDraft
  reloadingFailed: boolean
  runtimeEnabled: boolean
  sectionClass: string
  status: McpToolStatus | undefined
  onAddServer: () => void | Promise<void>
  onAutosizeInput: (event: FormEvent<HTMLTextAreaElement>) => void
  onDeleteServer: () => void | Promise<void>
  onEditServer: (index: number) => void | Promise<void>
  onMoveServer: (direction: -1 | 1) => void | Promise<void>
  onReloadFailedServers: () => void | Promise<void>
  onUpdateDraft: (update: Partial<McpDraft>) => void
}

export function McpSettings({
  config,
  editingIndex,
  listRef,
  mcpDraft,
  reloadingFailed,
  runtimeEnabled,
  sectionClass,
  status,
  onAddServer,
  onAutosizeInput,
  onDeleteServer,
  onEditServer,
  onMoveServer,
  onReloadFailedServers,
  onUpdateDraft
}: McpSettingsProps) {
  const selectedServer = editingIndex === undefined
    ? undefined
    : config?.mcpServers.find((server) => server.index === editingIndex)

  return (
    <section className={sectionClass}>
      <McpListPane
        config={config}
        editingIndex={editingIndex}
        listRef={listRef}
        reloadingFailed={reloadingFailed}
        runtimeEnabled={runtimeEnabled}
        status={status}
        onAddServer={onAddServer}
        onDeleteServer={onDeleteServer}
        onEditServer={onEditServer}
        onMoveServer={onMoveServer}
        onReloadFailedServers={onReloadFailedServers}
      />

      <McpEditor
        mcpDraft={mcpDraft}
        runtimeEnabled={runtimeEnabled}
        selectedServer={selectedServer}
        status={status}
        onAutosizeInput={onAutosizeInput}
        onUpdateDraft={onUpdateDraft}
      />
    </section>
  )
}
