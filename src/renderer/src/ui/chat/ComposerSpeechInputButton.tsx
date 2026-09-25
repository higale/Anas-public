import { useRef, type RefObject } from 'react'
import { Mic } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { NoFocusButton } from '../NoFocusButton'

export function ComposerSpeechInputButton({ inputRef, disabled }: {
  inputRef: RefObject<HTMLTextAreaElement | null>
  disabled: boolean
}) {
  const { t } = useTranslation()
  const opening = useRef(false)
  const platform = document.documentElement.dataset.platform
  const supported = platform === 'win32' || platform === 'darwin'
  const label = t(supported ? `speech_input.open_${platform}` : 'speech_input.unsupported')

  async function open(): Promise<void> {
    const input = inputRef.current
    if (!supported || disabled || opening.current || !input || input.disabled || input.readOnly) return
    const failureLabel = t(`speech_input.error_failed_${platform}`)
    // Preserve the current selection. The OS inserts dictation through the
    // normal text-input path; there is no app-owned transcript or recorder.
    input.focus({ preventScroll: true })
    if (document.activeElement !== input) {
      toast.error(t('speech_input.error_not_focused'))
      return
    }
    opening.current = true
    try {
      const result = await window.gale.speechInput.open()
      if (result !== 'requested') toast.error(result === 'failed' ? failureLabel : t(`speech_input.error_${result}`))
    } catch {
      toast.error(failureLabel)
    } finally {
      opening.current = false
    }
  }

  return (
    <NoFocusButton
      type="button"
      className="ui-icon-button"
      aria-label={label}
      data-tooltip={label}
      disabled={disabled || !supported}
      onClick={() => void open()}
    >
      <Mic size={16} />
    </NoFocusButton>
  )
}
