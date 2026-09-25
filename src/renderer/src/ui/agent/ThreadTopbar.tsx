import { MoreHorizontal } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentThread } from '@shared/agentTypes'
import type { Project } from '@shared/types'
import { NoFocusButton } from '../NoFocusButton'
import { ProjectDetailsMenu } from '../projects/ProjectDetailsMenu'
import { ProjectIcon } from '../projects/ProjectIcon'
import { ThreadActionsMenu } from './ThreadActionsMenu'

interface ThreadTopbarProps {
  project?: Project
  projectThreadCount: number
  thread?: AgentThread
  title: string
  onDeleteProject(project: Project): void
  onDeleteProjectThreads(project: Project): void
  onDeleteThread(threadId: string): void
  onEditProject(project: Project): void
  onRenameThread(threadId: string, title: string): void | Promise<void>
  onToggleProjectPinned(project: Project): void | Promise<void>
  onToggleThreadPinned(thread: AgentThread): void | Promise<void>
}

export function ThreadTopbar({
  project,
  projectThreadCount,
  thread,
  title,
  onDeleteProject,
  onDeleteProjectThreads,
  onDeleteThread,
  onEditProject,
  onRenameThread,
  onToggleProjectPinned,
  onToggleThreadPinned
}: ThreadTopbarProps) {
  const { t } = useTranslation()
  const [renaming, setRenaming] = useState(false)
  const [titleDraft, setTitleDraft] = useState(title)
  const cancelRenameRef = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setRenaming(false)
    setTitleDraft(title)
  }, [thread?.id, title])

  useEffect(() => {
    if (renaming) inputRef.current?.select()
  }, [renaming])

  async function saveRename(): Promise<void> {
    if (cancelRenameRef.current) {
      cancelRenameRef.current = false
      return
    }
    const nextTitle = titleDraft.trim()
    setRenaming(false)
    if (thread && nextTitle && nextTitle !== thread.title) {
      await onRenameThread(thread.id, nextTitle)
      return
    }
    setTitleDraft(title)
  }

  return (
    <div className="thread-topbar">
      {project && (
        <ProjectDetailsMenu
          placement="topbar"
          project={project}
          threadCount={projectThreadCount}
          onDelete={onDeleteProject}
          onDeleteThreads={onDeleteProjectThreads}
          onEdit={onEditProject}
          onTogglePinned={onToggleProjectPinned}
        >
          <NoFocusButton
            className="thread-topbar-project ui-tool-button"
            type="button"
            aria-label={t('project.show_details', { name: project.name })}
          >
            <ProjectIcon color={project.iconColor} icon={project.icon} kind={project.kind} size={15} />
          </NoFocusButton>
        </ProjectDetailsMenu>
      )}
      {renaming ? (
        <input
          ref={inputRef}
          className="thread-topbar-title-input ui-input"
          value={titleDraft}
          aria-label={t('chat.rename_thread')}
          onBlur={() => void saveRename()}
          onChange={(event) => setTitleDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              event.currentTarget.blur()
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              cancelRenameRef.current = true
              setTitleDraft(title)
              setRenaming(false)
            }
          }}
        />
      ) : <span className="thread-topbar-title ui-truncate">{title}</span>}
      {thread && (
        <ThreadActionsMenu
          thread={thread}
          onDelete={onDeleteThread}
          onRename={(item) => {
            setTitleDraft(item.title)
            setRenaming(true)
          }}
          onTogglePinned={onToggleThreadPinned}
        >
          <NoFocusButton className="thread-topbar-more ui-tool-button" type="button" aria-label={t('common.more')}>
            <MoreHorizontal size={15} />
          </NoFocusButton>
        </ThreadActionsMenu>
      )}
    </div>
  )
}
