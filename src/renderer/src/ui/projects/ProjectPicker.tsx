import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Braces, Check, FolderKanban, MessageCircle } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { isDefaultWorkspaceProject, type Project } from '@shared/types'
import { DropdownMenuContent, DropdownMenuRoot, DropdownMenuTrigger } from '../DropdownMenuShell'
import { NoFocusButton } from '../NoFocusButton'
import { ProjectIcon } from './ProjectIcon'
import type { ProjectCreationKind } from './ProjectDialog'

interface ProjectPickerProps {
  disabled: boolean
  projects: Project[]
  selectedProjectId: string
  onCreateProject: (kind: ProjectCreationKind) => void
  onSelectProject: (projectId: string) => void
}

export function ProjectPicker({
  disabled,
  projects,
  selectedProjectId,
  onCreateProject,
  onSelectProject
}: ProjectPickerProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const selectedProject = projects.find((project) => project.id === selectedProjectId)

  function openCreateDialog(kind: ProjectCreationKind): void {
    setOpen(false)
    window.requestAnimationFrame(() => onCreateProject(kind))
  }

  return (
    <DropdownMenuRoot open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <NoFocusButton
          className="project-picker-trigger"
          type="button"
          disabled={disabled}
          aria-label={t('project.select')}
        >
          {selectedProject
            ? <ProjectIcon
                color={selectedProject.iconColor}
                icon={selectedProject.icon}
                kind={selectedProject.kind}
                size={14}
              />
            : <FolderKanban size={14} />}
          <span className={selectedProject && isDefaultWorkspaceProject(selectedProject)
            ? 'project-default-workspace-name'
            : undefined}
          >
            {selectedProject?.name ?? t('project.select')}
          </span>
        </NoFocusButton>
      </DropdownMenuTrigger>
      <DropdownMenu.Portal>
        <DropdownMenuContent
          className="project-picker-menu ui-menu ui-menu-list"
          side="top"
          align="start"
          sideOffset={7}
          collisionPadding={10}
        >
          <DropdownMenu.Group className="project-picker-scroll">
            {projects.map((project) => (
              <DropdownMenu.Item
                className="project-picker-item ui-menu-item ui-menu-item-row"
                key={project.id}
                onSelect={() => onSelectProject(project.id)}
              >
                <ProjectIcon color={project.iconColor} icon={project.icon} kind={project.kind} size={15} />
                <span className={`ui-truncate${isDefaultWorkspaceProject(project) ? ' project-default-workspace-name' : ''}`}>
                  {project.name}
                </span>
                {selectedProjectId === project.id && <Check className="project-picker-check" size={14} />}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Group>
          <DropdownMenu.Separator className="ui-menu-separator" />
          <DropdownMenu.Item className="project-picker-item ui-menu-item ui-menu-item-row" onSelect={() => openCreateDialog('workspace')}>
            <FolderKanban size={15} />
            <span>{t('project.normal_project')}</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className="project-picker-item ui-menu-item ui-menu-item-row" onSelect={() => openCreateDialog('coding')}>
            <Braces size={15} />
            <span>{t('project.coding_project')}</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className="project-picker-item ui-menu-item ui-menu-item-row" onSelect={() => openCreateDialog('simple_chat')}>
            <MessageCircle size={15} />
            <span>{t('project.simple_chat')}</span>
          </DropdownMenu.Item>
        </DropdownMenuContent>
      </DropdownMenu.Portal>
    </DropdownMenuRoot>
  )
}
