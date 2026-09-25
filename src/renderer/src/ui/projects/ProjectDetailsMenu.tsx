import type { ReactElement } from 'react'
import type { Project } from '@shared/types'
import { ContextMenuShell } from '../ContextMenuShell'
import { DropdownMenuShell } from '../DropdownMenuShell'
import { SIDEBAR_ROW_OVERLAY_POSITION, THREAD_TOPBAR_OVERLAY_POSITION } from '../uiConstants'
import { ProjectDetailsContent } from './ProjectDetailsContent'

interface ProjectDetailsMenuProps {
  children: ReactElement
  project: Project
  threadCount: number
  placement: 'sidebar' | 'topbar'
  onDelete(project: Project): void
  onDeleteThreads(project: Project): void
  onEdit(project: Project): void
  onTogglePinned(project: Project): void | Promise<void>
}

export function ProjectDetailsMenu({
  children,
  project,
  threadCount,
  placement,
  onDelete,
  onDeleteThreads,
  onEdit,
  onTogglePinned
}: ProjectDetailsMenuProps) {
  return (
    <DropdownMenuShell
      className="project-details-popover ui-popover"
      position={placement === 'sidebar' ? SIDEBAR_ROW_OVERLAY_POSITION : THREAD_TOPBAR_OVERLAY_POSITION}
      sidebarFloating={placement === 'sidebar'}
      trigger={children}
    >
      <ProjectDetailsContent
        itemKind="dropdown"
        project={project}
        threadCount={threadCount}
        onDelete={onDelete}
        onDeleteThreads={onDeleteThreads}
        onEdit={onEdit}
        onTogglePinned={onTogglePinned}
      />
    </DropdownMenuShell>
  )
}

export function ProjectDetailsContextMenu({
  children,
  project,
  threadCount,
  onDelete,
  onDeleteThreads,
  onEdit,
  onTogglePinned
}: Omit<ProjectDetailsMenuProps, 'placement'>) {
  return (
    <ContextMenuShell
      className="project-details-popover ui-popover"
      sidebarFloating
      trigger={children}
    >
      <ProjectDetailsContent
        itemKind="context"
        project={project}
        threadCount={threadCount}
        onDelete={onDelete}
        onDeleteThreads={onDeleteThreads}
        onEdit={onEdit}
        onTogglePinned={onTogglePinned}
      />
    </ContextMenuShell>
  )
}
