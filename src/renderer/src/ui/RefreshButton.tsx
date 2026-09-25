import type { ButtonHTMLAttributes } from 'react'
import { RefreshCw } from 'lucide-react'

interface RefreshButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'type'> {
  iconSize?: number
  label: string
  loading?: boolean
  showLabel?: boolean
  text?: string
  variant?: 'icon' | 'small'
}

export function RefreshButton({
  className,
  disabled,
  iconSize = 14,
  label,
  loading = false,
  showLabel = false,
  text,
  variant = 'icon',
  ...props
}: RefreshButtonProps) {
  return (
    <button
      {...props}
      aria-busy={loading}
      aria-label={label}
      className={[
        'refresh-button',
        variant === 'small' ? 'ui-button-compact' : '',
        variant === 'small' ? 'ui-button' : 'ui-icon-button',
        loading ? 'loading' : '',
        className ?? ''
      ].filter(Boolean).join(' ')}
      data-tooltip={showLabel ? undefined : label}
      disabled={disabled || loading}
      type="button"
    >
      <RefreshCw size={iconSize} />
      {showLabel && <span>{text ?? label}</span>}
    </button>
  )
}
