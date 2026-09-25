import * as Popover from '@radix-ui/react-popover'
import type { ComponentProps } from 'react'
import { useFloatingCollisionPadding } from './floatingViewport'

export function PopoverContent({ collisionPadding, ...props }: ComponentProps<typeof Popover.Content>) {
  const safePadding = useFloatingCollisionPadding(collisionPadding)
  return <Popover.Content {...props} collisionPadding={safePadding} />
}
