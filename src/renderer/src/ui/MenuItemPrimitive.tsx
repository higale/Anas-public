import * as ContextMenu from '@radix-ui/react-context-menu'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { ComponentPropsWithoutRef } from 'react'

export type MenuItemKind = 'context' | 'dropdown'

type MenuItemPrimitiveProps = ComponentPropsWithoutRef<typeof DropdownMenu.Item> & {
  kind: MenuItemKind
}

export function MenuItemPrimitive({ kind, ...props }: MenuItemPrimitiveProps) {
  return kind === 'context'
    ? <ContextMenu.Item {...props} />
    : <DropdownMenu.Item {...props} />
}
