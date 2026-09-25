import type { InputHTMLAttributes } from 'react'

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'checked' | 'children' | 'defaultChecked' | 'onChange' | 'type'> {
  checked: boolean
  indeterminate?: boolean
  onChange: (checked: boolean) => void
}

export function Checkbox({ checked, indeterminate = false, className, onChange, ...props }: CheckboxProps) {
  return (
    <input
      {...props}
      checked={checked}
      ref={(input) => { if (input) input.indeterminate = indeterminate }}
      aria-checked={indeterminate ? 'mixed' : checked}
      className={['ui-checkbox', className ?? ''].filter(Boolean).join(' ')}
      type="checkbox"
      onChange={(event) => onChange(event.target.checked)}
    />
  )
}
