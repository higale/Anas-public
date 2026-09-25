import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  type ComponentProps,
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode
} from 'react'
import { useFloatingCollisionPadding } from './floatingViewport'

type DropdownMenuRootProps = ComponentPropsWithoutRef<typeof DropdownMenu.Root>

export function DropdownMenuRoot({ modal = false, ...props }: DropdownMenuRootProps) {
  return <DropdownMenu.Root {...props} modal={modal} />
}

type DropdownMenuTriggerProps = Omit<
  ComponentPropsWithoutRef<typeof DropdownMenu.Trigger>,
  'onMouseDown' | 'tabIndex'
>

export function DropdownMenuTrigger(props: DropdownMenuTriggerProps) {
  return (
    <DropdownMenu.Trigger
      {...props}
      tabIndex={-1}
      onMouseDown={(event) => event.preventDefault()}
    />
  )
}

type DropdownMenuContentProps = ComponentPropsWithoutRef<typeof DropdownMenu.Content> & {
  restoreFocus?: boolean
}

export function DropdownMenuContent({
  collisionPadding,
  onCloseAutoFocus,
  restoreFocus = false,
  ...props
}: DropdownMenuContentProps) {
  const safePadding = useFloatingCollisionPadding(collisionPadding)
  return (
    <DropdownMenu.Content
      {...props}
      collisionPadding={safePadding}
      onCloseAutoFocus={(event) => {
        onCloseAutoFocus?.(event)
        if (!restoreFocus) event.preventDefault()
      }}
    />
  )
}

export function DropdownMenuSubContent({ collisionPadding, ...props }: ComponentProps<typeof DropdownMenu.SubContent>) {
  const safePadding = useFloatingCollisionPadding(collisionPadding)
  return <DropdownMenu.SubContent {...props} collisionPadding={safePadding} />
}

interface DropdownMenuPosition {
  align: 'start' | 'center' | 'end'
  collisionPadding: number
  side: 'top' | 'right' | 'bottom' | 'left'
  sideOffset: number
}

interface DropdownMenuShellProps {
  children: ReactNode
  className: string
  position: DropdownMenuPosition
  sidebarFloating?: boolean
  trigger: ReactElement
}

export function DropdownMenuShell({
  children,
  className,
  position,
  sidebarFloating = false,
  trigger
}: DropdownMenuShellProps) {
  return (
    <DropdownMenuRoot>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenu.Portal>
        <DropdownMenuContent
          className={className}
          data-sidebar-floating={sidebarFloating ? true : undefined}
          {...position}
        >
          {children}
        </DropdownMenuContent>
      </DropdownMenu.Portal>
    </DropdownMenuRoot>
  )
}
