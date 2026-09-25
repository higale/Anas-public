import type { CSSProperties, ReactNode } from 'react'
import { CheckboxField } from './CheckboxField'

interface RangeFieldProps {
  className?: string
  disabled?: boolean
  label: ReactNode
  max: number
  min: number
  step: number
  value: number
  checked?: boolean
  onChange: (value: number) => void
  onCheckedChange?: (checked: boolean) => void
}

export function RangeField({
  checked,
  className,
  disabled = false,
  label,
  max,
  min,
  step,
  value,
  onChange,
  onCheckedChange
}: RangeFieldProps) {
  const rawProgress = max === min ? 0 : ((value - min) / (max - min)) * 100
  const progress = Math.max(0, Math.min(100, rawProgress))
  const range = (
    <input
      aria-label={typeof label === 'string' ? label : undefined}
      disabled={disabled || checked === false}
      min={min}
      max={max}
      step={step}
      type="range"
      value={value}
      style={{ '--range-progress': `${progress}%` } as CSSProperties}
      onChange={(event) => onChange(Number(event.target.value))}
    />
  )

  if (checked !== undefined && onCheckedChange) {
    return (
      <div className={['ui-range-row', className ?? ''].filter(Boolean).join(' ')}>
        <CheckboxField
          checked={checked}
          className="ui-checkbox-field-inline"
          label={label}
          onChange={onCheckedChange}
        />
        {range}
      </div>
    )
  }

  return (
    <label className={['ui-range-row', className ?? ''].filter(Boolean).join(' ')}>
      <span>{label}</span>
      {range}
    </label>
  )
}
