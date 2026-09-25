import { SlidersHorizontal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ModelParameterPresetMode } from '@shared/types'

interface ModelParameterPresetBadgeProps {
  mode: ModelParameterPresetMode
  presetCount: number
}

export function ModelParameterPresetBadge({ mode, presetCount }: ModelParameterPresetBadgeProps) {
  const { t } = useTranslation()
  if (mode === 'none' || (mode === 'custom' && presetCount === 0)) return null
  const label = `${t('settings.model_parameter_presets')}: ${t('settings.enabled')}`

  return (
    <span
      aria-label={label}
      className="ui-status-icon"
      data-model-status-badge
      data-tooltip={label}
    >
      <SlidersHorizontal size={13} />
    </span>
  )
}
