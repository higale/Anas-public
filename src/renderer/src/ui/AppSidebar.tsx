import type { ReactNode } from 'react'
import { PanelLeftClose } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { NoFocusButton } from './NoFocusButton'
import { SidebarResizeHandle } from './SidebarResizeHandle'
import { SidebarProfileHeader } from './SidebarProfileHeader'

interface AppSidebarProps {
  ariaLabel: string
  assistantName: string
  assistantRole?: string
  avatarDataUri?: string
  children: ReactNode
  footer: ReactNode
  sidebarVisible: boolean
  sidebarWidth: number
  onAvatarClick: () => void | Promise<void>
  onSidebarWidthCommit: (width: number) => void | Promise<void>
  onToggleSidebar: () => void | Promise<void>
}

export function AppSidebar({
  ariaLabel,
  assistantName,
  assistantRole,
  avatarDataUri,
  children,
  footer,
  sidebarVisible,
  sidebarWidth,
  onAvatarClick,
  onSidebarWidthCommit,
  onToggleSidebar
}: AppSidebarProps) {
  const { t } = useTranslation()
  const collapseLabel = t('chat.collapse_sidebar')

  return (
    <aside
      className="app-sidebar sidebar ui-sidebar ui-sidebar-inset ui-sidebar-with-footer ui-sidebar-stack"
      aria-label={ariaLabel}
    >
      <div className="sidebar-profile-row">
        <SidebarProfileHeader
          avatarDataUri={avatarDataUri}
          assistantName={assistantName}
          assistantRole={assistantRole}
          onAvatarClick={onAvatarClick}
        />
        {sidebarVisible && (
          <NoFocusButton
            className="sidebar-collapse ui-tool-button ui-tool-button-square"
            type="button"
            aria-label={collapseLabel}
            data-tooltip={collapseLabel}
            onClick={() => void onToggleSidebar()}
          >
            <PanelLeftClose size={18} />
          </NoFocusButton>
        )}
      </div>
      <div className="app-sidebar-content">
        {children}
      </div>
      <div className="sidebar-footer ui-sidebar-footer">
        {footer}
      </div>
      {sidebarVisible && (
        <SidebarResizeHandle
          label={t('chat.resize_sidebar')}
          width={sidebarWidth}
          onCommit={onSidebarWidthCommit}
        />
      )}
    </aside>
  )
}
