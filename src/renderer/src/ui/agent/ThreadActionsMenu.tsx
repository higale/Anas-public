import { Clock, MessagesSquare, PencilLine, Pin, Trash2 } from 'lucide-react'
import * as ContextMenu from '@radix-ui/react-context-menu'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { isAgentThreadLocked, type AgentThread } from '@shared/agentTypes'
import { ContextMenuShell } from '../ContextMenuShell'
import { DropdownMenuShell } from '../DropdownMenuShell'
import { MenuItemPrimitive, type MenuItemKind } from '../MenuItemPrimitive'
import { formatDateTime } from '../formatDateTime'
import { SIDEBAR_ROW_OVERLAY_POSITION, THREAD_TOPBAR_OVERLAY_POSITION } from '../uiConstants'

interface ThreadActionsProps {
  thread: AgentThread
  onDelete(threadId: string): void
  onRename(thread: AgentThread): void
  onTogglePinned(thread: AgentThread): void | Promise<void>
}

interface ThreadActionsMenuProps extends ThreadActionsProps {
  children: ReactElement
  sidebarFloating?: boolean
}

interface ThreadActionsContentProps extends ThreadActionsProps {
  itemKind: MenuItemKind
}

function ThreadActionsContent({
  itemKind,
  thread,
  onDelete,
  onRename,
  onTogglePinned
}: ThreadActionsContentProps) {
  const { t } = useTranslation()
  const Label = itemKind === 'context' ? ContextMenu.Label : DropdownMenu.Label
  const Separator = itemKind === 'context' ? ContextMenu.Separator : DropdownMenu.Separator

  return (
    <>
      <Label className="ui-menu-description">
        <span className="ui-menu-description-row">
          <Clock size={14} aria-hidden="true" />
          <time dateTime={thread.updatedAt}>{formatDateTime(thread.updatedAt)}</time>
        </span>
        <span className="ui-menu-description-row">
          <MessagesSquare size={14} aria-hidden="true" />
          <span>{t('chat.user_turn_count', { count: thread.userTurnCount })}</span>
        </span>
      </Label>
      <Separator className="ui-menu-separator" />
      <MenuItemPrimitive
        kind={itemKind}
        className="thread-action-menu-item ui-menu-item ui-menu-item-row"
        onSelect={() => void onTogglePinned(thread)}
      >
        <Pin size={16} fill={thread.pinned ? 'currentColor' : 'none'} />
        <span>{thread.pinned ? t('chat.unpin_thread') : t('chat.pin_thread')}</span>
      </MenuItemPrimitive>
      <MenuItemPrimitive
        kind={itemKind}
        className="thread-action-menu-item ui-menu-item ui-menu-item-row"
        onSelect={() => onRename(thread)}
      >
        <PencilLine size={16} />
        <span>{t('chat.rename_thread')}</span>
      </MenuItemPrimitive>
      <MenuItemPrimitive
        kind={itemKind}
        className="thread-action-menu-item ui-menu-item ui-menu-item-row danger"
        disabled={isAgentThreadLocked(thread.status)}
        onSelect={() => onDelete(thread.id)}
      >
        <Trash2 size={16} />
        <span>{t('common.delete')}</span>
      </MenuItemPrimitive>
    </>
  )
}

export function ThreadActionsMenu({
  children,
  thread,
  sidebarFloating = false,
  onDelete,
  onRename,
  onTogglePinned
}: ThreadActionsMenuProps) {
  return (
    <DropdownMenuShell
      className="thread-action-menu ui-menu ui-menu-list"
      position={sidebarFloating ? SIDEBAR_ROW_OVERLAY_POSITION : THREAD_TOPBAR_OVERLAY_POSITION}
      sidebarFloating={sidebarFloating}
      trigger={children}
    >
      <ThreadActionsContent
        itemKind="dropdown"
        thread={thread}
        onDelete={onDelete}
        onRename={onRename}
        onTogglePinned={onTogglePinned}
      />
    </DropdownMenuShell>
  )
}

export function ThreadActionsContextMenu({
  children,
  thread,
  onDelete,
  onRename,
  onTogglePinned
}: ThreadActionsMenuProps) {
  return (
    <ContextMenuShell
      className="thread-action-menu ui-menu ui-menu-list"
      sidebarFloating
      trigger={children}
    >
      <ThreadActionsContent
        itemKind="context"
        thread={thread}
        onDelete={onDelete}
        onRename={onRename}
        onTogglePinned={onTogglePinned}
      />
    </ContextMenuShell>
  )
}
