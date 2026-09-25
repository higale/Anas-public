import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { ChevronDown, CornerDownLeft } from 'lucide-react'
import { UI_ICON_SIZE_MEDIUM, UI_POPOVER_FALLBACK_WIDTH } from './uiConstants'
import { OptionPopover } from './OptionPopover'
import type { OptionPopoverOption } from './OptionPopover'

export interface SearchableOption extends OptionPopoverOption<string> {
  label: string
  searchText?: string
}

interface SearchableOptionPickerProps {
  allowInput?: boolean
  ariaLabel: string
  className?: string
  contentAlign?: 'start' | 'center' | 'end'
  disabled?: boolean
  emptyLabel: string
  commitSearchLabel?: string
  enterCommitsSearch?: boolean
  footer?: ReactNode
  inputPlaceholder?: string
  inputCommitMode?: 'change' | 'blur'
  inputSize?: number
  open?: boolean
  options: SearchableOption[]
  popoverClassName?: string
  popoverWidth?: string
  portalContainer?: HTMLElement | null
  searchable?: boolean
  searchPlaceholder?: string
  value: string
  onChange: (value: string) => void | Promise<void>
  onOpenChange?: (open: boolean) => void
  onInputChange?: (value: string) => void
}

export function SearchableOptionPicker({
  allowInput = false,
  ariaLabel,
  className,
  contentAlign = 'end',
  disabled = false,
  emptyLabel,
  commitSearchLabel,
  enterCommitsSearch = false,
  footer,
  inputPlaceholder,
  inputCommitMode = 'change',
  inputSize,
  open: controlledOpen,
  options,
  popoverClassName,
  popoverWidth,
  portalContainer,
  searchable = true,
  searchPlaceholder,
  value,
  onChange,
  onOpenChange,
  onInputChange
}: SearchableOptionPickerProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const [inputDraft, setInputDraft] = useState(value)
  const [query, setQuery] = useState('')
  const listboxId = useId()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const inputDraftRef = useRef(value)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const skipInputBlurCommitRef = useRef(false)
  const open = disabled ? false : controlledOpen ?? uncontrolledOpen
  const usesBlurInputCommit = allowInput && inputCommitMode === 'blur'

  useEffect(() => {
    inputDraftRef.current = value
    setInputDraft(value)
  }, [value])

  const filteredOptions = useMemo(() => {
    if (!searchable) return options
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return options
    return options.filter((option) => (option.searchText ?? option.label).toLowerCase().includes(normalizedQuery))
  }, [options, query, searchable])

  const selectedOption = options.find((option) => option.value.toLowerCase() === value.toLowerCase())
  const triggerLabel = selectedOption?.label ?? value
  const canCommitSearch = searchable && query.trim().length > 0
  const resolvedSearchPlaceholder = searchPlaceholder ?? ariaLabel
  const searchCommitLabel = commitSearchLabel ?? resolvedSearchPlaceholder

  function setPickerOpen(nextOpen: boolean): void {
    if (disabled && nextOpen) return
    if (controlledOpen === undefined) setUncontrolledOpen(nextOpen)
    onOpenChange?.(nextOpen)
    if (nextOpen) setQuery('')
  }

  function selectOption(nextValue: string): void {
    setPickerOpen(false)
    setQuery('')
    inputDraftRef.current = nextValue
    setInputDraft(nextValue)
    void onChange(nextValue)
  }

  function commitInputDraft(): void {
    if (!usesBlurInputCommit) return
    if (skipInputBlurCommitRef.current) {
      skipInputBlurCommitRef.current = false
      return
    }
    if (inputDraftRef.current === value) return
    void (onInputChange ?? onChange)(inputDraftRef.current)
  }

  function submitSearchQuery(): void {
    const nextValue = query.trim()
    if (!nextValue) return
    setPickerOpen(false)
    setQuery('')
    void onChange(nextValue)
  }

  const rootClassName = ['searchable-option-picker', allowInput ? '' : 'readonly', className ?? ''].filter(Boolean).join(' ')
  const inputValue = allowInput ? (usesBlurInputCommit ? inputDraft : value) : triggerLabel

  return (
    <Popover.Root open={open} onOpenChange={setPickerOpen}>
      <Popover.Anchor asChild>
        <div className={rootClassName} ref={rootRef}>
          <input
            className="searchable-option-input"
            role="combobox"
            aria-label={ariaLabel}
            aria-controls={listboxId}
            aria-expanded={open}
            aria-haspopup="listbox"
            autoComplete="off"
            disabled={disabled}
            placeholder={inputPlaceholder}
            readOnly={!allowInput}
            size={inputSize}
            value={inputValue}
            onBlur={commitInputDraft}
            onChange={(event) => {
              if (!allowInput || disabled) return
              if (usesBlurInputCommit) {
                const nextDraft = event.target.value
                inputDraftRef.current = nextDraft
                setInputDraft(nextDraft)
                return
              }
              void (onInputChange ?? onChange)(event.target.value)
            }}
            onClick={() => {
              if (!allowInput && !disabled) setPickerOpen(true)
            }}
            onKeyDown={(event) => {
              if (usesBlurInputCommit) {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  event.currentTarget.blur()
                }
                if (event.key === 'Escape') {
                  event.preventDefault()
                  skipInputBlurCommitRef.current = true
                  inputDraftRef.current = value
                  setInputDraft(value)
                  event.currentTarget.blur()
                }
                return
              }
              if (allowInput || disabled) return
              if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
                event.preventDefault()
                setPickerOpen(true)
              }
              if (event.key === 'Escape') setPickerOpen(false)
            }}
          />
          <Popover.Trigger asChild>
            <button
              className="searchable-option-tail ui-icon-button"
              type="button"
              aria-label={ariaLabel}
              aria-expanded={open}
              disabled={disabled}
              onMouseDown={(event) => event.preventDefault()}
            >
              <ChevronDown size={UI_ICON_SIZE_MEDIUM} />
            </button>
          </Popover.Trigger>
        </div>
      </Popover.Anchor>
      <OptionPopover
        align={contentAlign}
        ariaLabel={ariaLabel}
        className={['searchable-option-popover ui-popover', popoverClassName ?? className ?? ''].filter(Boolean).join(' ')}
        emptyLabel={emptyLabel}
        footer={footer}
        header={searchable && (
          <div className={enterCommitsSearch ? 'searchable-option-search-row with-commit' : 'searchable-option-search-row'}>
            <input
              ref={searchRef}
              className="searchable-option-search"
              type="search"
              placeholder={resolvedSearchPlaceholder}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && enterCommitsSearch) {
                  event.preventDefault()
                  submitSearchQuery()
                }
                if (event.key === 'Escape') setPickerOpen(false)
              }}
              autoFocus
            />
            {enterCommitsSearch && (
              <button
                className="searchable-option-search-commit ui-icon-button"
                type="button"
                aria-label={searchCommitLabel}
                data-tooltip={searchCommitLabel}
                disabled={!canCommitSearch}
                onMouseDown={(event) => event.preventDefault()}
                onClick={submitSearchQuery}
              >
                <CornerDownLeft size={UI_ICON_SIZE_MEDIUM} />
              </button>
            )}
          </div>
        )}
        listClassName="searchable-option-list"
        listId={listboxId}
        open={open}
        options={filteredOptions}
        portalContainer={portalContainer}
        style={{ '--searchable-option-picker-width': popoverWidth ?? `${rootRef.current?.offsetWidth ?? UI_POPOVER_FALLBACK_WIDTH}px` } as CSSProperties}
        value={value}
        onAutoFocus={({ firstOption, selectedOption }) => {
          if (searchable) {
            searchRef.current?.focus({ preventScroll: true })
          } else {
            const optionToFocus = selectedOption ?? firstOption
            optionToFocus?.focus({ preventScroll: true })
          }
        }}
        onClose={() => setPickerOpen(false)}
        onSelect={selectOption}
        renderOption={(option) => <span className="ui-truncate">{option.label}</span>}
      />
    </Popover.Root>
  )
}
