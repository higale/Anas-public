import { helpDocuments } from '@shared/helpDocuments'
import { HelpDocumentPanel } from './HelpDocumentPanel'
import * as Dialog from '@radix-ui/react-dialog'
import * as Tabs from '@radix-ui/react-tabs'
import { BookOpen, FileDiff, Maximize2, Minimize2, PanelLeftOpen, PanelRightClose, X } from 'lucide-react'
import { useEffect, useRef, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentRunActivity } from '@shared/agentTypes'
import type { CodeReviewRequest } from '@shared/codeReview'
import type { WorkspaceProject } from '@shared/types'
import { WORKSPACE_PANEL_WIDTH_DEFAULT } from '@shared/uiPreferences'
import { ResizeHandle } from '../ResizeHandle'
import { AgentSubagentStatusIcon, subagentStatusLabel } from './AgentSubagentActivityDock'
import { AgentSubagentPanel, type EarlierActivityRequest } from './AgentMessageList'
import { FileChangesPanel } from './FileChangesPanel'
import { PanelViewState } from './PanelViewState'
import { workspacePanelGroup, type WorkspacePanelsController } from './useWorkspacePanels'

interface WorkspacePanelsProps {
  controller: WorkspacePanelsController
  scope: string
  activities: AgentRunActivity[]
  project?: WorkspaceProject
  sidebarVisible?: boolean
  onToggleSidebar?(): void | Promise<void>
  narrow: boolean
  width: number
  minWidth: number
  maxWidth: number
  toggleRef: RefObject<HTMLButtonElement | null>
  inputRef: RefObject<HTMLTextAreaElement | null>
  onWidthCommit(width: number): void | Promise<void>
  onOpenSubagent(runId: string, subagentId: string): void
  onLoadEarlierActivities?(request: EarlierActivityRequest): void | Promise<void>
  onLoadEarlierError?(threadId: string, error: string): void
  onLoadSubagentDetails?(threadId: string, runId: string, subagentId: string): Promise<void>
  onReview?(request: CodeReviewRequest): Promise<void>
}

export function WorkspacePanels({ controller, scope, activities, project, narrow, width, minWidth, maxWidth,
  toggleRef, inputRef, onWidthCommit, onOpenSubagent, onLoadEarlierActivities, onLoadEarlierError, onLoadSubagentDetails, onReview, sidebarVisible, onToggleSidebar }: WorkspacePanelsProps) {
  const { t } = useTranslation()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const group = workspacePanelGroup(controller, scope)
  const close = (id: string) => {
    const index = group.tabs.findIndex((tab) => tab.id === id)
    const remaining = group.tabs.filter((tab) => tab.id !== id)
    const next = group.activeId === id ? remaining[Math.min(index, remaining.length - 1)]?.id : group.activeId
    controller.close(scope, id)
    requestAnimationFrame(() => {
      const trigger = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
        .find((button) => button.dataset.panelId === next)
      ;(trigger ?? toggleRef.current ?? inputRef.current)?.focus({ preventScroll: true })
    })
  }
  const collapse = () => {
    controller.dismiss(scope)
    requestAnimationFrame(() => (toggleRef.current ?? inputRef.current)?.focus({ preventScroll: true }))
  }
  useEffect(() => {
    const selected = rootRef.current?.querySelector<HTMLElement>('[role="tab"][data-state="active"]')
    selected?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [scope, group.activeId, group.expanded, narrow])

  if (!group.expanded || !group.tabs.length) return null
  const content = <Tabs.Root key={scope} ref={rootRef} className="ui-tab-workspace" value={group.activeId}
    onValueChange={(id) => controller.select(scope, id)}>
    <div className="ui-tab-workspace-header workspace-panels-titlebar">
      <div className="ui-tab-workspace-tabs">
        {group.maximized && sidebarVisible === false && <button type="button" className="ui-tool-button ui-tool-button-square"
          aria-label={t('chat.show_sidebar')} data-tooltip={t('chat.show_sidebar')} onClick={() => void onToggleSidebar?.()}><PanelLeftOpen size={16} /></button>}
        <Tabs.List className="ui-tab-list" aria-label={t('agent.workspace_panels')}>
          {group.tabs.map((tab) => {
            const panel = tab.panel
            const subagent = panel.kind === 'subagent'
              ? activities.find((run) => run.runId === panel.runId)?.subagents.find((item) => item.id === panel.subagentId)
              : undefined
            const label = panel.kind === 'document' ? helpDocuments[panel.documentId]
              : panel.kind === 'files' ? t('agent.file_changes') : subagent?.name ?? panel.name
            return <div className="ui-tab-item" key={tab.id} data-active={group.activeId === tab.id}
              onMouseDownCapture={(event) => { if (event.button === 1) event.preventDefault() }}
              onAuxClick={(event) => {
                if (event.button !== 1) return
                event.preventDefault()
                close(tab.id)
              }}>
              <Tabs.Trigger className="ui-tab-trigger" value={tab.id} data-panel-id={tab.id}
                onKeyDown={(event) => { if (event.key === 'Delete') { event.preventDefault(); close(tab.id) } }}>
                {panel.kind === 'subagent'
                  ? <span role="img" aria-label={subagent ? subagentStatusLabel(subagent.status) : t('agent.panel_unavailable')}>
                      <AgentSubagentStatusIcon status={subagent?.status ?? 'failed'} size={14} />
                    </span>
                  : panel.kind === 'document' ? <BookOpen size={14} /> : <FileDiff size={14} />}
                <span className="ui-truncate">{label}</span>
              </Tabs.Trigger>
              <button className="ui-tab-close ui-tool-button" type="button"
                aria-label={t('agent.close_panel', { name: label })} onClick={() => close(tab.id)}><X size={12} /></button>
            </div>
          })}
        </Tabs.List>
      </div>
      <div className="ui-tab-workspace-actions">
        <button type="button" className="ui-tool-button ui-tool-button-square" onClick={() => controller.toggleMaximized(scope)}
          aria-label={t(group.maximized ? 'agent.restore_panels' : 'agent.maximize_panels')}
          data-tooltip={t(group.maximized ? 'agent.restore_panels' : 'agent.maximize_panels')} aria-pressed={group.maximized}>
          {group.maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
        <button type="button" className="ui-tool-button ui-tool-button-square" onClick={collapse}
          aria-label={t('agent.hide_panels')} data-tooltip={t('agent.hide_panels')}><PanelRightClose size={18} /></button>
      </div>
    </div>
    {group.tabs.map((tab) => {
      const panel = tab.panel
      return <Tabs.Content key={tab.id} className="ui-tab-content" value={tab.id}>
      <PanelViewState state={tab.view}>
        {panel.kind === 'document'
          ? <HelpDocumentPanel request={panel} onOpen={(next) => controller.open(scope, next)} />
          : panel.kind === 'subagent'
          ? activities.some((run) => run.runId === panel.runId && run.subagents.some((item) => item.id === panel.subagentId))
            ? <AgentSubagentPanel run={activities.find((run) => run.runId === panel.runId)}
                subagentId={panel.subagentId} onOpenSubagent={onOpenSubagent} threadId={scope}
                onLoadEarlierActivities={onLoadEarlierActivities} onLoadEarlierError={onLoadEarlierError}
                onLoadSubagentDetails={onLoadSubagentDetails} />
            : <p className="ui-detail-panel-empty">{t('agent.panel_unavailable')}</p>
          : <FileChangesPanel project={project?.id === panel.projectId ? project : undefined} request={panel} onReview={onReview} />}
      </PanelViewState>
    </Tabs.Content>})}
  </Tabs.Root>

  if (narrow) return <Dialog.Root open modal={false} onOpenChange={(open) => { if (!open) collapse() }}>
    <Dialog.Content className="workspace-panels workspace-panels-drawer" data-maximized={group.maximized} aria-describedby={undefined}
      onOpenAutoFocus={(event) => event.preventDefault()}
      onCloseAutoFocus={(event) => event.preventDefault()}
      onInteractOutside={(event) => event.preventDefault()}>
      <Dialog.Title className="ui-visually-hidden">{t('agent.workspace_panels')}</Dialog.Title>
      {content}
    </Dialog.Content>
  </Dialog.Root>
  return <aside className="workspace-panels" data-maximized={group.maximized} aria-label={t('agent.workspace_panels')}>
    {!group.maximized && <ResizeHandle label={t('agent.resize_panels')} width={width} minWidth={minWidth} maxWidth={maxWidth}
      defaultWidth={WORKSPACE_PANEL_WIDTH_DEFAULT} direction={-1} onCommit={onWidthCommit}
      rootSelector=".agent-workspace-body" paneSelector=".workspace-panels" property="--workspace-panel-width"
      className="workspace-panel-resize" />}
    {content}
  </aside>
}
