import type { ButtonHTMLAttributes } from 'react'
import type { LucideIcon } from 'lucide-react'
import { NoFocusButton } from './NoFocusButton'

interface SelectableIconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'tabIndex' | 'type'> {
  Icon: LucideIcon
  iconSize: number
  label: string
  pressed: boolean
  PressedIcon?: LucideIcon
  preserveFocus?: boolean
  variant?: 'default' | 'toolbar'
}

export function SelectableIconButton({
  className,
  Icon,
  iconSize,
  label,
  pressed,
  PressedIcon,
  preserveFocus = false,
  variant = 'default',
  ...props
}: SelectableIconButtonProps) {
  const Button = preserveFocus ? NoFocusButton : 'button'
  const DisplayIcon = pressed && PressedIcon ? PressedIcon : Icon

  return (
    <Button
      {...props}
      aria-label={label}
      aria-pressed={pressed}
      className={[
        variant === 'toolbar' ? 'ui-tool-button ui-tool-button-small' : 'ui-icon-button',
        'ui-selectable-icon-button',
        pressed ? 'ui-selectable-icon-button-active' : '',
        className ?? ''
      ].filter(Boolean).join(' ')}
      data-tooltip={label}
      type="button"
    >
      <DisplayIcon size={iconSize} />
    </Button>
  )
}
