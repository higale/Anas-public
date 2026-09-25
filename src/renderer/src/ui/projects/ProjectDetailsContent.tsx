import * as ContextMenu from '@radix-ui/react-context-menu'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { CodeXml, Folder, MessageCircle, MessageCircleX, PencilLine, Pin, SlidersHorizontal, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { isDefaultWorkspaceProject, type Project } from '@shared/types'
import { MenuItemPrimitive, type MenuItemKind } from '../MenuItemPrimitive'
import { notice } from '../notice'
import { ProjectIcon } from './ProjectIcon'

interface ProjectDetailsContentProps {
  itemKind: MenuItemKind
  project: Project
  threadCount: number
  onDelete(project: Project): void
  onDeleteThreads(project: Project): void
  onEdit(project: Project): void
  onTogglePinned(project: Project): void | Promise<void>
}

export function ProjectDetailsContent({
  itemKind,
  project,
  threadCount,
  onDelete,
  onDeleteThreads,
  onEdit,
  onTogglePinned
}: ProjectDetailsContentProps) {
  const { t } = useTranslation()
  const defaultWorkspace = isDefaultWorkspaceProject(project)
  const Separator = itemKind === 'context' ? ContextMenu.Separator : DropdownMenu.Separator
  const statuses = project.kind === 'simple_chat'
    ? [{ Icon: MessageCircle, label: t('project.simple_chat'), enabled: true }]
    : [
        { Icon: CodeXml, label: t('project.coding_mode'), enabled: project.codingMode },
        { Icon: SlidersHorizontal, label: t('project.advanced_settings_label'), enabled: project.advancedSettings }
      ]

  function runAfterSelect(action: () => void): void {
    window.requestAnimationFrame(action)
  }

  async function openSourceFolder(sourceFolder: string): Promise<void> {
    try {
      await window.gale.projects.openSourceFolder(project.id, sourceFolder)
    } catch {
      notice.error(t('project.failed_open_source_folder'))
    }
  }

  return (
    <>
      <header className="project-details-header">
        <ProjectIcon color={project.iconColor} icon={project.icon} kind={project.kind} size={16} />
        <strong className={defaultWorkspace ? 'project-default-workspace-name' : undefined}>{project.name}</strong>
        <div className="ui-row">
          {statuses.map(({ Icon, label, enabled }) => {
            const description = `${label}: ${t(enabled ? 'common.on' : 'common.off')}`
            return <span key={label} className="ui-status-icon" data-active={enabled}
              role="img" aria-label={description} data-tooltip={description}>
              <Icon size={15} aria-hidden="true" />
            </span>
          })}
        </div>
      </header>
      <div className="project-details-stat">
        <MessageCircle size={14} />
        <span>{t('project.thread_count', { count: threadCount })}</span>
      </div>
      <div className="project-details-separator" />
      {project.kind === 'workspace' && <>
        <div className="project-details-folders">
          {project.sourceFolders.map((folder) => (
            <MenuItemPrimitive
              kind={itemKind}
              className="project-details-folder ui-menu-item"
              key={folder}
              onSelect={() => void openSourceFolder(folder)}
            >
              <Folder size={14} />
              <span>{folder}</span>
            </MenuItemPrimitive>
          ))}
        </div>
        <div className="project-details-separator" />
      </>}
      {!defaultWorkspace && (
        <MenuItemPrimitive
          kind={itemKind}
          className="project-details-action ui-menu-item ui-menu-item-row"
          onSelect={() => runAfterSelect(() => void onTogglePinned(project))}
        >
          <Pin size={15} fill={project.pinned ? 'currentColor' : 'none'} />
          <span>{t(project.pinned ? 'project.unpin' : 'project.pin')}</span>
        </MenuItemPrimitive>
      )}
      <MenuItemPrimitive
        kind={itemKind}
        className="project-details-action ui-menu-item ui-menu-item-row"
        onSelect={() => runAfterSelect(() => onEdit(project))}
      >
        <PencilLine size={15} />
        <span>{t('project.edit')}</span>
      </MenuItemPrimitive>
      {!defaultWorkspace && (
        <MenuItemPrimitive
          kind={itemKind}
          className="project-details-action ui-menu-item ui-menu-item-row danger"
          onSelect={() => runAfterSelect(() => onDelete(project))}
        >
          <Trash2 size={15} />
          <span>{t('project.delete')}</span>
        </MenuItemPrimitive>
      )}
      <Separator className="ui-menu-separator" />
      <MenuItemPrimitive
        kind={itemKind}
        className="project-details-action ui-menu-item ui-menu-item-row danger"
        disabled={threadCount === 0}
        onSelect={() => runAfterSelect(() => onDeleteThreads(project))}
      >
        <MessageCircleX size={15} />
        <span>{t('project.delete_threads')}</span>
      </MenuItemPrimitive>
    </>
  )
}
