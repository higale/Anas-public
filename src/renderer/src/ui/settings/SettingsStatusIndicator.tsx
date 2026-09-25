import { TriangleAlert } from 'lucide-react'

interface SettingsStatusIndicatorProps {
  hint: string
  label: string
}

export function SettingsStatusIndicator({
  hint,
  label
}: SettingsStatusIndicatorProps) {
  return (
    <span
      className="settings-status-indicator"
      role="img"
      aria-label={label}
      data-tooltip={hint}
    >
      <TriangleAlert aria-hidden="true" size={15} />
    </span>
  )
}
