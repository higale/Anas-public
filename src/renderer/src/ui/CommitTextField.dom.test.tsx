import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CommitTextarea, CommitTextInput } from './CommitTextField'

describe('CommitTextInput', () => {
  it('normalizes a number-step zero before displaying the draft', () => {
    const onDraftChange = vi.fn()

    render(
      <CommitTextInput
        type="number"
        value=""
        normalizeDraft={(value) => value === '0' ? '' : value}
        onDraftChange={onDraftChange}
        onCommit={vi.fn()}
      />
    )

    const input = screen.getByRole('spinbutton') as HTMLInputElement
    fireEvent.change(input, { target: { value: '0' } })

    expect(input.value).toBe('')
    expect(onDraftChange).toHaveBeenCalledWith('')
  })
})

describe('CommitTextarea external updates', () => {
  it('adopts incoming values while pristine and preserves a dirty draft until committed', () => {
    const onCommit = vi.fn()
    const { rerender } = render(<CommitTextarea preserveDirtyDraft value="" onCommit={onCommit} />)
    const input = screen.getByRole('textbox')
    rerender(<CommitTextarea preserveDirtyDraft value="Detected environment" onCommit={onCommit} />)
    expect(input).toHaveValue('Detected environment')
    fireEvent.change(input, { target: { value: 'User edit' } })
    rerender(<CommitTextarea preserveDirtyDraft value="Updated environment" onCommit={onCommit} />)
    expect(input).toHaveValue('User edit')
    fireEvent.blur(input)
    expect(onCommit).toHaveBeenCalledWith('User edit')
    rerender(<CommitTextarea preserveDirtyDraft value="User edit" onCommit={onCommit} />)
    rerender(<CommitTextarea preserveDirtyDraft value="Next saved value" onCommit={onCommit} />)
    expect(input).toHaveValue('Next saved value')
  })
})
