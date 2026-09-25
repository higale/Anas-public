import type { FormEvent, RefObject } from 'react'
import type {
  AppConfigSnapshot,
  McpToolStatus,
  RuntimeToolStatus,
  SkillSnapshot
} from '@shared/types'
import { SubagentEditor } from './SubagentEditor'
import { SubagentListPane } from './SubagentListPane'
import type { SubagentDraft } from './subagentDraft'

interface SubagentSettingsProps {
  config: AppConfigSnapshot | undefined
  draft: SubagentDraft
  editingIndex?: number
  listRef: RefObject<HTMLDivElement | null>
  mcpStatus: McpToolStatus | undefined
  runtimeToolStatus: RuntimeToolStatus | undefined
  sectionClass: string
  skills: SkillSnapshot | undefined
  onAdd: () => void | Promise<void>
  onAutosizeInput: (event: FormEvent<HTMLTextAreaElement>) => void
  onDelete: () => void | Promise<void>
  onEdit: (index: number) => void
  onMove: (direction: -1 | 1) => void | Promise<void>
  onRestore: () => void
  onUpdate: (update: Partial<SubagentDraft>) => void
}

export function SubagentSettings({
  config,
  draft,
  editingIndex,
  listRef,
  mcpStatus,
  runtimeToolStatus,
  sectionClass,
  skills,
  onAdd,
  onAutosizeInput,
  onDelete,
  onEdit,
  onMove,
  onRestore,
  onUpdate
}: SubagentSettingsProps) {
  return (
    <section className={sectionClass}>
      <SubagentListPane
        config={config}
        editingIndex={editingIndex}
        listRef={listRef}
        onAdd={onAdd}
        onDelete={onDelete}
        onEdit={onEdit}
        onMove={onMove}
      />
      <SubagentEditor
        customTools={config?.customTools}
        draft={draft}
        subagents={config?.subagents}
        key={draft.index ?? 'new'}
        mcpStatus={mcpStatus}
        mcpServers={config?.mcpServers}
        runtimeToolStatus={runtimeToolStatus}
        skills={skills}
        onAutosizeInput={onAutosizeInput}
        onRestore={onRestore}
        onUpdate={onUpdate}
      />
    </section>
  )
}
