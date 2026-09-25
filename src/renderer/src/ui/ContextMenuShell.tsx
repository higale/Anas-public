import * as ContextMenu from '@radix-ui/react-context-menu'
import { type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { UI_POPOVER_COLLISION_PADDING } from './uiConstants'
import { useFloatingCollisionPadding } from './floatingViewport'

interface ContextMenuShellProps {
  children: ReactNode
  className: string
  sidebarFloating?: boolean
  trigger: ReactElement
}

function ContextMenuContent(props: ComponentProps<typeof ContextMenu.Content>) {
  const collisionPadding = useFloatingCollisionPadding(UI_POPOVER_COLLISION_PADDING)
  return <ContextMenu.Content {...props} collisionPadding={collisionPadding} />
}

export function ContextMenuShell({
  children,
  className,
  sidebarFloating = false,
  trigger
}: ContextMenuShellProps) {
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild data-app-context-menu>{trigger}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenuContent
          className={className}
          data-sidebar-floating={sidebarFloating ? true : undefined}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {children}
        </ContextMenuContent>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  )
}
