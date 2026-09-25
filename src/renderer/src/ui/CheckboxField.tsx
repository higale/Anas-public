import type { ReactNode } from 'react'
import { Checkbox, type CheckboxProps } from './Checkbox'

interface CheckboxFieldProps extends Omit<CheckboxProps, 'className'> {
  className?: string
  label: ReactNode
  tooltip?: string
}

export function CheckboxField({
  checked,
  className,
  label,
  tooltip,
  onChange,
  ...inputProps
}: CheckboxFieldProps) {
  return (
    <label
      className={['ui-checkbox-field', className ?? ''].filter(Boolean).join(' ')}
      data-tooltip={tooltip}
    >
      <Checkbox
        {...inputProps}
        checked={checked}
        onChange={onChange}
      />
      <span className="ui-checkbox-field-label">{label}</span>
    </label>
  )
}
