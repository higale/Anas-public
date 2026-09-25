import {
  ChevronRight,
  CircleAlert,
  LoaderCircle,
  MoreHorizontal,
  ShieldAlert,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentThread } from '@shared/agentTypes'
import type { Project, SidebarCollapsedSections, SidebarSectionId } from '@shared/types'
import { NoFocusButton } from '../NoFocusButton'
import { ProjectGroup } from '../projects/ProjectGroup'
import { ThreadActionsContextMenu, ThreadActionsMenu } from './ThreadActionsMenu'

interface ThreadListProps {
  activeThreadId?: string
  loading: boolean
  projects: Project[]
  selectedProjectId?: string
  sidebarCollapsedSections: SidebarCollapsedSections
  threads: AgentThread[]
  onDeleteProject(project: Project): void
  onDeleteProjectThreads(project: Project): void
  onDeleteThread(threadId: string): void | Promise<void>
  onEditProject(project: Project): void
  onOpenThread(threadId: string): void | Promise<void>
  onRenameThread(threadId: string, title: string): void | Promise<void>
  onStartProjectThread(projectId: string): void
  onToggleSidebarSection(section: SidebarSectionId): void | Promise<void>
  onToggleProjectCollapsed(project: Project): void | Promise<void>
  onToggleProjectPinned(project: Project): void | Promise<void>
  onTogglePinned(thread: AgentThread): void | Promise<void>
}

interface CollapsibleThreadSectionProps {
  children: ReactNode
  collapsed: boolean
  label: string
  separated?: boolean
  section: SidebarSectionId
  onToggle(section: SidebarSectionId): void | Promise<void>
}

function CollapsibleThreadSection({
  children,
  collapsed,
  label,
  separated = false,
  section,
  onToggle
}: CollapsibleThreadSectionProps) {
  const { t } = useTranslation()

  return (
    <section className="thread-list-section">
      <NoFocusButton
        className={separated ? 'thread-group-label separated' : 'thread-group-label'}
        type="button"
        aria-expanded={!collapsed}
        aria-label={t(collapsed ? 'project.expand_section' : 'project.collapse_section', { name: label })}
        onClick={() => void onToggle(section)}
      >
        <ChevronRight className="thread-group-chevron" size={13} />
        <span>{label}</span>
      </NoFocusButton>
      {!collapsed && children}
    </section>
  )
}

function ThreadStatus({ thread }: { thread: AgentThread }) {
  if (thread.status === 'running') return <LoaderCircle className="agent-spin" size={13} />
  if (thread.status === 'interrupted') return <ShieldAlert size={13} />
  if (thread.status === 'failed') return <CircleAlert size={13} />
  return null
}

export function ThreadList({
  activeThreadId,
  loading,
  projects,
  selectedProjectId,
  sidebarCollapsedSections,
  threads,
  onDeleteProject,
  onDeleteProjectThreads,
  onDeleteThread,
  onEditProject,
  onOpenThread,
  onRenameThread,
  onStartProjectThread,
  onToggleSidebarSection,
  onToggleProjectCollapsed,
  onToggleProjectPinned,
  onTogglePinned
}: ThreadListProps) {
  const { t } = useTranslation()
  const [renamingId, setRenamingId] = useState<string>()
  const [title, setTitle] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renamingId) inputRef.current?.focus()
  }, [renamingId])

  async function saveRename(): Promise<void> {
    const threadId = renamingId
    const nextTitle = title.trim()
    setRenamingId(undefined)
    if (threadId && nextTitle) await onRenameThread(threadId, nextTitle)
  }

  function renderThread(thread: AgentThread) {
    const threadActions = {
      onDelete: (threadId: string) => void onDeleteThread(threadId),
      onRename: (item: AgentThread) => {
        setTitle(item.title)
        setRenamingId(item.id)
      },
      onTogglePinned
    }

    return (
      <ThreadActionsContextMenu
        {...threadActions}
        key={thread.id}
        thread={thread}
      >
        <div
          className={thread.id === activeThreadId
            ? 'thread-item ui-list-item ui-list-item-row ui-list-item-action-host ui-list-item-active active'
            : 'thread-item ui-list-item ui-list-item-row ui-list-item-action-host'}
          data-pinned={thread.pinned ? true : undefined}
        >
          {renamingId === thread.id ? (
            <div className="thread-open editing ui-list-item-main">
              <input
                ref={inputRef}
                className="ui-input"
                value={title}
                onBlur={() => void saveRename()}
                onChange={(event) => setTitle(event.target.value)}
                onContextMenu={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void saveRename()
                  if (event.key === 'Escape') setRenamingId(undefined)
                }}
                aria-label={t('chat.rename_thread')}
              />
            </div>
          ) : (
            <NoFocusButton className="thread-open ui-list-item-main" type="button" onClick={() => void onOpenThread(thread.id)}>
              <span className="thread-status-indicator" aria-hidden="true">
                <ThreadStatus thread={thread} />
              </span>
              <span className="thread-name ui-list-item-title">
                <span className="ui-truncate">{thread.title}</span>
              </span>
            </NoFocusButton>
          )}
          <div className="ui-list-item-action-wrap">
            <ThreadActionsMenu thread={thread} sidebarFloating {...threadActions}>
              <NoFocusButton className="ui-list-item-action ui-tool-button" type="button" aria-label={t('common.more')}>
                <MoreHorizontal size={15} />
              </NoFocusButton>
            </ThreadActionsMenu>
          </div>
        </div>
      </ThreadActionsContextMenu>
    )
  }

  function renderProject(project: Project) {
    const projectThreads = threads.filter((thread) => thread.projectId === project.id)
    return (
      <ProjectGroup
        key={project.id}
        project={project}
        selected={project.id === selectedProjectId}
        threadCount={projectThreads.length}
        onDelete={onDeleteProject}
        onDeleteThreads={onDeleteProjectThreads}
        onEdit={onEditProject}
        onStartChat={onStartProjectThread}
        onToggleCollapsed={onToggleProjectCollapsed}
        onTogglePinned={onToggleProjectPinned}
      >
        {!project.collapsed && (projectThreads.length
          ? projectThreads.map(renderThread)
          : <div className="project-thread-empty">{t('project.no_threads')}</div>)}
      </ProjectGroup>
    )
  }

  const workspaceProjects = projects.filter((project) => project.kind === 'workspace')
  const simpleChatProjects = projects.filter((project) => project.kind === 'simple_chat')

  if (loading && !projects.length && !threads.length) {
    return (
      <nav className="thread-list ui-list ui-scroll-list" aria-label={t('chat.threads')} tabIndex={-1}>
        <div className="ui-empty-state">{t('chat.threads_loading')}</div>
      </nav>
    )
  }

  return (
    <nav className="thread-list ui-list ui-scroll-list" aria-label={t('chat.threads')} tabIndex={-1}>
      {workspaceProjects.length > 0 && (
        <CollapsibleThreadSection
          collapsed={sidebarCollapsedSections.projects}
          label={t('project.projects')}
          section="projects"
          onToggle={onToggleSidebarSection}
        >
          {workspaceProjects.map(renderProject)}
        </CollapsibleThreadSection>
      )}
      {simpleChatProjects.length > 0 && (
        <CollapsibleThreadSection
          collapsed={sidebarCollapsedSections.simpleChats}
          label={t('project.simple_chats')}
          separated={workspaceProjects.length > 0}
          section="simpleChats"
          onToggle={onToggleSidebarSection}
        >
          {simpleChatProjects.map(renderProject)}
        </CollapsibleThreadSection>
      )}
    </nav>
  )
}
