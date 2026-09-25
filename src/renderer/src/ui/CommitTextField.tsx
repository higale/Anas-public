import type { ChangeEvent, FocusEvent, InputHTMLAttributes, KeyboardEvent, TextareaHTMLAttributes } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { resizeAutosizeTextarea } from './autosizeTextarea'

interface CommitTextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onBlur' | 'onChange' | 'onKeyDown' | 'type' | 'value'> {
  normalizeDraft?: (value: string) => string
  onBlur?: (event: FocusEvent<HTMLInputElement>) => void
  onCommit: (value: string) => void | Promise<void>
  onDraftChange?: (value: string) => void
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void
  type?: InputHTMLAttributes<HTMLInputElement>['type']
  value: string
}

interface CommitTextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onBlur' | 'onChange' | 'value'> {
  onBlur?: (event: FocusEvent<HTMLTextAreaElement>) => void
  onCommit: (value: string) => void | Promise<void>
  onDraftChange?: (value: string) => void
  preserveDirtyDraft?: boolean
  value: string
}

export function CommitTextInput({
  normalizeDraft,
  onBlur,
  onCommit,
  onDraftChange,
  onKeyDown,
  value,
  ...props
}: CommitTextInputProps) {
  const [draft, setDraft] = useState(value)
  const draftRef = useRef(value)
  const skipBlurCommitRef = useRef(false)

  useEffect(() => {
    draftRef.current = value
    setDraft(value)
  }, [value])

  function commit(): void {
    if (draftRef.current !== value) void onCommit(draftRef.current)
  }

  function handleBlur(event: FocusEvent<HTMLInputElement>): void {
    if (skipBlurCommitRef.current) {
      skipBlurCommitRef.current = false
    } else {
      commit()
    }
    onBlur?.(event)
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>): void {
    const nextDraft = normalizeDraft?.(event.target.value) ?? event.target.value
    draftRef.current = nextDraft
    setDraft(nextDraft)
    onDraftChange?.(nextDraft)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === 'Enter') {
      event.preventDefault()
      event.currentTarget.blur()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      skipBlurCommitRef.current = true
      draftRef.current = value
      setDraft(value)
      onDraftChange?.(value)
      event.currentTarget.blur()
      return
    }
    onKeyDown?.(event)
  }

  return (
    <input
      {...props}
      value={draft}
      onBlur={handleBlur}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
    />
  )
}

export function CommitTextarea({
  onBlur,
  onCommit,
  onDraftChange,
  preserveDirtyDraft = false,
  value,
  ...props
}: CommitTextareaProps) {
  const [draft, setDraft] = useState(value)
  const draftRef = useRef(value)
  const savedValueRef = useRef(value)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    if (!preserveDirtyDraft || draftRef.current === savedValueRef.current) {
      draftRef.current = value
      setDraft(value)
    }
    savedValueRef.current = value
  }, [preserveDirtyDraft, value])

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (!textarea?.classList.contains('ui-autosize-textarea')) return
    resizeAutosizeTextarea(textarea)
  }, [draft])

  function handleBlur(event: FocusEvent<HTMLTextAreaElement>): void {
    if (draftRef.current !== value) void onCommit(draftRef.current)
    onBlur?.(event)
  }

  return (
    <textarea
      {...props}
      ref={textareaRef}
      value={draft}
      onBlur={handleBlur}
      onChange={(event) => {
        const nextDraft = event.target.value
        draftRef.current = nextDraft
        setDraft(nextDraft)
        onDraftChange?.(nextDraft)
      }}
    />
  )
}
