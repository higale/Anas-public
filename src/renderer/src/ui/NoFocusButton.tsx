import { forwardRef, type ButtonHTMLAttributes } from 'react'

type NoFocusButtonProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'tabIndex'>

export const NoFocusButton = forwardRef<HTMLButtonElement, NoFocusButtonProps>(
  function NoFocusButton({ onMouseDown, ...props }, ref) {
    return (
      <button
        {...props}
        ref={ref}
        tabIndex={-1}
        onMouseDown={(event) => {
          onMouseDown?.(event)
          event.preventDefault()
        }}
      />
    )
  }
)
