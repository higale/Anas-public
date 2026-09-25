import { useCallback, useState } from 'react'
import type { HelpDocumentId } from '@shared/helpDocuments'

export type WorkspacePanel =
  | { kind: 'subagent'; runId: string; subagentId: string; name: string }
  | { kind: 'files'; projectId: string; threadId?: string; runId?: string }
  | { kind: 'document'; documentId: HelpDocumentId; anchor?: string; navigationId?: string }

export interface WorkspacePanelTab {
  id: string
  panel: WorkspacePanel
  view: Map<string, unknown>
}

export interface WorkspacePanelGroup {
  tabs: WorkspacePanelTab[]
  activeId?: string
  expanded: boolean
  maximized: boolean
}

export function workspacePanelId(panel: WorkspacePanel): string {
  switch (panel.kind) {
    case 'subagent': return JSON.stringify([panel.kind, panel.runId, panel.subagentId])
    case 'files': return JSON.stringify([panel.kind, panel.projectId])
    case 'document': return JSON.stringify([panel.kind, panel.documentId])
  }
}

const emptyGroup: WorkspacePanelGroup = { tabs: [], expanded: false, maximized: false }

interface PanelState {
  groups: Record<string, WorkspacePanelGroup>
  documents: WorkspacePanelGroup
}

function visibleGroup(state: PanelState, scope: string): WorkspacePanelGroup {
  const local = state.groups[scope] ?? emptyGroup
  const documents = state.documents
  const activeId = documents.activeId ?? local.activeId ?? documents.tabs[0]?.id
  const active = documents.tabs.some((tab) => tab.id === activeId) ? documents : local
  return { ...active, activeId, tabs: [...local.tabs, ...documents.tabs] }
}

export function useWorkspacePanels() {
  const [state, setState] = useState<PanelState>({ groups: {}, documents: emptyGroup })
  const update = useCallback((scope: string, change: (group: WorkspacePanelGroup) => WorkspacePanelGroup) => {
    setState((current) => {
      const group = change(visibleGroup(current, scope))
      const localTabs = group.tabs.filter((tab) => tab.panel.kind !== 'document')
      const documentTabs = group.tabs.filter((tab) => tab.panel.kind === 'document')
      const documentActive = documentTabs.some((tab) => tab.id === group.activeId)
      const previousLocal = current.groups[scope] ?? emptyGroup
      const localActiveId = localTabs.some((tab) => tab.id === previousLocal.activeId)
        ? previousLocal.activeId : localTabs[0]?.id
      return {
        groups: { ...current.groups, [scope]: documentActive
          ? { ...previousLocal, tabs: localTabs, activeId: localActiveId }
          : { ...group, tabs: localTabs } },
        documents: { ...(documentActive ? group : current.documents), tabs: documentTabs,
          activeId: documentActive ? group.activeId : undefined }
      }
    })
  }, [])
  const open = useCallback((scope: string, panel: WorkspacePanel) => {
    const id = workspacePanelId(panel)
    update(scope, (group) => ({ ...group, expanded: true, activeId: id,
      tabs: group.tabs.some((tab) => tab.id === id) ? group.tabs.map((tab) => tab.id === id ? { ...tab, panel } : tab)
        : [...group.tabs, { id, panel, view: new Map() }] }))
  }, [update])
  const select = useCallback((scope: string, id: string) => {
    update(scope, (group) => group.tabs.some((tab) => tab.id === id) ? { ...group, activeId: id } : group)
  }, [update])
  const close = useCallback((scope: string, id: string) => {
    update(scope, (group) => {
      const index = group.tabs.findIndex((tab) => tab.id === id)
      const tabs = group.tabs.filter((tab) => tab.id !== id)
      return { tabs, expanded: tabs.length > 0 && group.expanded, maximized: tabs.length > 0 && group.maximized,
        activeId: group.activeId === id ? tabs[Math.min(index, tabs.length - 1)]?.id : group.activeId }
    })
  }, [update])
  const toggle = useCallback((scope: string) => {
    update(scope, (group) => ({ ...group, expanded: group.tabs.length > 0 && !group.expanded, maximized: false }))
  }, [update])
  const dismiss = useCallback((scope: string) => {
    update(scope, (group) => ({ ...group, expanded: false, maximized: false }))
  }, [update])
  const toggleMaximized = useCallback((scope: string) => {
    update(scope, (group) => group.expanded && group.tabs.length > 0 ? { ...group, maximized: !group.maximized } : group)
  }, [update])
  const remove = useCallback((scope: string) => {
    setState((current) => {
      const next = { ...current.groups }
      delete next[scope]
      return { ...current, groups: next }
    })
  }, [])
  return { ...state, open, select, close, toggle, dismiss, toggleMaximized, remove }
}

export type WorkspacePanelsController = ReturnType<typeof useWorkspacePanels>
export function workspacePanelScope(threadId: string | undefined, projectId: string): string {
  return JSON.stringify(threadId ? ['thread', threadId] : ['draft', projectId])
}
export function workspacePanelGroup(controller: WorkspacePanelsController, scope: string): WorkspacePanelGroup {
  return visibleGroup(controller, scope)
}
