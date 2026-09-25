import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { CircleHelp, Info, Plus, Power, Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AgentThread } from '@shared/agentTypes'
import type { AppBuildInfo, Project, SidebarCollapsedSections, SidebarSectionId } from '@shared/types'
import { formatBuildTime } from '../buildInfo'
import { DropdownMenuContent, DropdownMenuRoot, DropdownMenuTrigger } from '../DropdownMenuShell'
import { NoFocusButton } from '../NoFocusButton'
import { ThreadList } from './ThreadList'

interface ThreadSidebarContentProps {
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
  onStartNewThread(): void
  onStartProjectThread(projectId: string): void
  onToggleSidebarSection(section: SidebarSectionId): void | Promise<void>
  onToggleProjectCollapsed(project: Project): void | Promise<void>
  onToggleProjectPinned(project: Project): void | Promise<void>
  onTogglePinned(thread: AgentThread): void | Promise<void>
}

interface ThreadSidebarFooterProps {
  appMenuOpen: boolean
  buildInfo?: AppBuildInfo
  onOpenHelp(): void | Promise<void>
  onOpenSettings(): void
  onQuit(): void | Promise<void>
  onShowAbout(): void
  onAppMenuOpenChange(open: boolean): void
}

export function ThreadSidebarContent(props: ThreadSidebarContentProps) {
  const { t } = useTranslation()

  return (
    <>
      <NoFocusButton
        className="new-chat ui-sidebar-action ui-button"
        type="button"
        onClick={() => props.onStartNewThread()}
      >
        <Plus size={17} />
        <span>{t('chat.new_thread')}</span>
      </NoFocusButton>
      <ThreadList
        activeThreadId={props.activeThreadId}
        loading={props.loading}
        projects={props.projects}
        selectedProjectId={props.selectedProjectId}
        sidebarCollapsedSections={props.sidebarCollapsedSections}
        threads={props.threads}
        onDeleteProject={props.onDeleteProject}
        onDeleteProjectThreads={props.onDeleteProjectThreads}
        onDeleteThread={props.onDeleteThread}
        onEditProject={props.onEditProject}
        onOpenThread={props.onOpenThread}
        onRenameThread={props.onRenameThread}
        onStartProjectThread={props.onStartProjectThread}
        onToggleSidebarSection={props.onToggleSidebarSection}
        onToggleProjectCollapsed={props.onToggleProjectCollapsed}
        onToggleProjectPinned={props.onToggleProjectPinned}
        onTogglePinned={props.onTogglePinned}
      />
    </>
  )
}

export function ThreadSidebarFooter(props: ThreadSidebarFooterProps) {
  const { t } = useTranslation()
  const buildTime = props.buildInfo?.environment === 'production'
    ? formatBuildTime(props.buildInfo.builtAt)
    : ''

  return (
    <DropdownMenuRoot open={props.appMenuOpen} onOpenChange={props.onAppMenuOpenChange}>
      <DropdownMenuTrigger asChild>
        <NoFocusButton
          className={props.appMenuOpen
            ? 'sidebar-settings ui-sidebar-action ui-list-item ui-list-item-active active'
            : 'sidebar-settings ui-sidebar-action ui-list-item'}
          type="button"
        >
          <Settings size={16} />
          <span>{t('settings.title')}</span>
        </NoFocusButton>
      </DropdownMenuTrigger>
      <DropdownMenu.Portal>
        <DropdownMenuContent
          className="app-menu-popover ui-menu ui-menu-list"
          aria-label={t('settings.app_menu')}
          data-sidebar-floating
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={10}
        >
          <DropdownMenu.Label className="app-menu-build-info">
            <span>Version {props.buildInfo?.version ?? '-'}</span>
            {props.buildInfo?.environment === 'development'
              ? <span>Development</span>
              : buildTime && <time dateTime={props.buildInfo?.builtAt}>Built {buildTime}</time>}
          </DropdownMenu.Label>
          <DropdownMenu.Separator className="ui-menu-separator" />
          <DropdownMenu.Item className="app-menu-item ui-menu-item ui-menu-item-row" onSelect={props.onOpenSettings}>
            <Settings size={15} /><span>{t('settings.title')}</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className="app-menu-item ui-menu-item ui-menu-item-row" onSelect={() => void props.onOpenHelp()}>
            <CircleHelp size={15} /><span>{t('settings.help')}</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className="app-menu-item ui-menu-item ui-menu-item-row" onSelect={props.onShowAbout}>
            <Info size={15} /><span>{t('settings.about')}</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className="app-menu-item ui-menu-item ui-menu-item-row" onSelect={() => void props.onQuit()}>
            <Power size={15} /><span>{t('settings.quit')}</span>
          </DropdownMenu.Item>
        </DropdownMenuContent>
      </DropdownMenu.Portal>
    </DropdownMenuRoot>
  )
}
