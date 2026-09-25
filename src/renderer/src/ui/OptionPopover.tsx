import { PopoverContent } from './PopoverContent'
import { Fragment, useCallback, useLayoutEffect, useRef } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { UI_POPOVER_COLLISION_PADDING, UI_POPOVER_SIDE_OFFSET } from './uiConstants'

type OptionValue = string | number

export interface OptionPopoverOption<Value extends OptionValue = string> {
  value: Value
  disabled?: boolean
  tooltip?: string
  group?: string
}

interface OptionPopoverAutoFocusTargets {
  firstOption: HTMLButtonElement | null
  selectedOption: HTMLButtonElement | null
}

interface OptionPopoverProps<Option extends OptionPopoverOption<OptionValue>> {
  align?: 'start' | 'center' | 'end'
  ariaLabel: string
  className?: string
  collisionPadding?: number
  emptyLabel: string
  footer?: ReactNode
  header?: ReactNode
  listClassName?: string
  listId?: string
  open: boolean
  optionClassName?: string | ((option: Option, active: boolean) => string)
  options: Option[]
  portalContainer?: HTMLElement | null
  side?: 'top' | 'right' | 'bottom' | 'left'
  sideOffset?: number
  style?: CSSProperties
  value: Option['value']
  onAutoFocus?: (targets: OptionPopoverAutoFocusTargets) => void
  onClose?: () => void
  onSelect: (value: Option['value'], option: Option) => void | Promise<void>
  renderOption: (option: Option, active: boolean) => ReactNode
}

function valuesMatch(left: OptionValue, right: OptionValue): boolean {
  if (typeof left === 'string' && typeof right === 'string') return left.toLowerCase() === right.toLowerCase()
  return left === right
}

function optionKey(value: OptionValue): string {
  return typeof value === 'number' ? String(value) : value
}

export function OptionPopover<Option extends OptionPopoverOption<OptionValue>>({
  align = 'end',
  ariaLabel,
  className,
  collisionPadding = UI_POPOVER_COLLISION_PADDING,
  emptyLabel,
  footer,
  header,
  listClassName,
  listId,
  open,
  optionClassName = (option, active) => active
    ? 'ui-option-item ui-option-item-active ui-list-item ui-list-item-active active'
    : 'ui-option-item ui-list-item',
  options,
  portalContainer,
  side = 'bottom',
  sideOffset = UI_POPOVER_SIDE_OFFSET,
  style,
  value,
  onAutoFocus,
  onClose,
  onSelect,
  renderOption
}: OptionPopoverProps<Option>) {
  const listRef = useRef<HTMLDivElement | null>(null)
  const selectedRef = useRef<HTMLButtonElement | null>(null)
  const firstOptionRef = useRef<HTMLButtonElement | null>(null)

  const scrollSelectedIntoList = useCallback(() => {
    const list = listRef.current
    const selected = selectedRef.current
    if (!list || !selected) return

    const selectedTop = selected.offsetTop
    const selectedBottom = selectedTop + selected.offsetHeight
    const viewportTop = list.scrollTop
    const viewportBottom = viewportTop + list.clientHeight
    if (selectedTop >= viewportTop && selectedBottom <= viewportBottom) return

    const centeredTop = selectedTop - Math.max(0, (list.clientHeight - selected.offsetHeight) / 2)
    list.scrollTop = Math.max(0, centeredTop)
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(scrollSelectedIntoList)
    return () => cancelAnimationFrame(frame)
  }, [open, options, scrollSelectedIntoList, value])

  function moveOptionFocus(direction: 'first' | 'last' | 'next' | 'previous'): void {
    const optionButtons = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])
    const currentIndex = optionButtons.findIndex((option) => option === document.activeElement)
    const lastIndex = optionButtons.length - 1
    if (lastIndex < 0) return

    const nextIndex = (() => {
      if (direction === 'first') return 0
      if (direction === 'last') return lastIndex
      if (currentIndex < 0) return 0
      return direction === 'next' ? Math.min(lastIndex, currentIndex + 1) : Math.max(0, currentIndex - 1)
    })()
    optionButtons[nextIndex]?.focus({ preventScroll: true })
  }

  return (
    <Popover.Portal container={portalContainer ?? undefined}>
      <PopoverContent
        className={className}
        side={side}
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        style={style}
        aria-label={ariaLabel}
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          requestAnimationFrame(() => {
            scrollSelectedIntoList()
            if (onAutoFocus) {
              onAutoFocus({ firstOption: firstOptionRef.current, selectedOption: selectedRef.current })
            } else {
              const optionToFocus = selectedRef.current ?? firstOptionRef.current
              optionToFocus?.focus({ preventScroll: true })
            }
          })
        }}
      >
        {header}
        <div
          className={listClassName}
          id={listId}
          ref={listRef}
          role="listbox"
          tabIndex={-1}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault()
              onClose?.()
              return
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              moveOptionFocus('next')
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              moveOptionFocus('previous')
            }
            if (event.key === 'Home') {
              event.preventDefault()
              moveOptionFocus('first')
            }
            if (event.key === 'End') {
              event.preventDefault()
              moveOptionFocus('last')
            }
          }}
        >
          {options.map((option, index) => {
            const active = valuesMatch(option.value, value)
            return (
              <Fragment key={optionKey(option.value)}>
              {option.group && option.group !== options[index - 1]?.group && <div className="ui-option-group" role="presentation">{option.group}</div>}
              <button
                className={typeof optionClassName === 'function' ? optionClassName(option, active) : optionClassName}
                key={optionKey(option.value)}
                type="button"
                ref={active ? selectedRef : index === 0 ? firstOptionRef : undefined}
                disabled={option.disabled}
                onClick={() => void onSelect(option.value, option)}
                role="option"
                aria-selected={active}
                data-tooltip={option.tooltip}
              >
                {renderOption(option, active)}
              </button>
              </Fragment>
            )
          })}
          {options.length === 0 && <div className="ui-empty-state ui-empty-state-compact">{emptyLabel}</div>}
        </div>
        {footer}
      </PopoverContent>
    </Popover.Portal>
  )
}
