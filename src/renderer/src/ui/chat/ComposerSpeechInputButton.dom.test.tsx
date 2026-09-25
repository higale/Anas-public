import { act, fireEvent, render, screen } from '@testing-library/react'
import { useRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposerSpeechInputButton } from './ComposerSpeechInputButton'

const mocks = vi.hoisted(() => ({ open: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: mocks.error } }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

function Harness({ disabled = false }: { disabled?: boolean }) {
  const inputRef = useRef<HTMLTextAreaElement>(null)
  return <>
    <textarea ref={inputRef} defaultValue="原有文字" disabled={disabled} />
    <ComposerSpeechInputButton inputRef={inputRef} disabled={disabled} />
  </>
}

beforeEach(() => {
  document.documentElement.dataset.platform = 'win32'
  mocks.open.mockResolvedValue('requested')
  Object.defineProperty(window, 'gale', { configurable: true, value: { speechInput: { open: mocks.open } } })
})

describe('system voice typing button', () => {
  it.each(['win32', 'darwin'])('preserves text and selection without recording state on %s', async (platform) => {
    document.documentElement.dataset.platform = platform
    render(<Harness />)
    const input = screen.getByRole<HTMLTextAreaElement>('textbox')
    input.setSelectionRange(1, 3)
    mocks.open.mockImplementationOnce(async () => {
      expect(document.activeElement).toBe(input)
      return 'requested'
    })
    const button = screen.getByRole('button', { name: `speech_input.open_${platform}` })
    await act(async () => { fireEvent.click(button) })
    expect(input).toHaveValue('原有文字')
    expect([input.selectionStart, input.selectionEnd]).toEqual([1, 3])
    expect(button).not.toHaveAttribute('aria-pressed')
    expect(button).not.toHaveAttribute('aria-busy')
    expect(mocks.open).toHaveBeenCalledOnce()
  })

  it.each(['not_focused', 'keys_held', 'failed'])('shows actionable %s feedback and permits retry', async (result) => {
    render(<Harness />)
    mocks.open.mockResolvedValueOnce(result)
    await act(async () => { fireEvent.click(screen.getByRole('button')) })
    expect(mocks.error).toHaveBeenCalledWith(`speech_input.error_${result}${result === 'failed' ? '_win32' : ''}`)
    await act(async () => { fireEvent.click(screen.getByRole('button')) })
    expect(mocks.open).toHaveBeenCalledTimes(2)
  })

  it('does not duplicate a pending request', async () => {
    render(<Harness />)
    let finish!: (value: string) => void
    mocks.open.mockReturnValueOnce(new Promise((resolve) => { finish = resolve }))
    fireEvent.click(screen.getByRole('button'))
    fireEvent.click(screen.getByRole('button'))
    expect(mocks.open).toHaveBeenCalledOnce()
    await act(async () => finish('requested'))
  })

  it.each(['failed', 'exception'])('shows macOS guidance on %s', async (failure) => {
    document.documentElement.dataset.platform = 'darwin'
    render(<Harness />)
    if (failure === 'exception') mocks.open.mockRejectedValueOnce(new Error('IPC failed'))
    else mocks.open.mockResolvedValueOnce('failed')
    await act(async () => { fireEvent.click(screen.getByRole('button')) })
    expect(mocks.error).toHaveBeenCalledWith('speech_input.error_failed_darwin')
  })

  it('retains a disabled entry on unsupported platforms', () => {
    document.documentElement.dataset.platform = 'linux'
    render(<Harness />)
    expect(screen.getByRole('button', { name: 'speech_input.unsupported' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button'))
    expect(mocks.open).not.toHaveBeenCalled()
  })

  it('does not open dictation for a locked draft', () => {
    render(<Harness disabled />)
    expect(screen.getByRole('button')).toBeDisabled()
    fireEvent.click(screen.getByRole('button'))
    expect(mocks.open).not.toHaveBeenCalled()
  })
})
