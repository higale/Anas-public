import { Volume2, VolumeX } from 'lucide-react'
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { SelectableIconButton } from '../SelectableIconButton'

interface ComposerSpeechReplyToggleProps {
  disabled: boolean
  enabled: boolean
  onChange(enabled: boolean): void | Promise<void>
}

export function ComposerSpeechReplyToggle({
  disabled,
  enabled,
  onChange
}: ComposerSpeechReplyToggleProps) {
  const { t } = useTranslation()
  const updatingRef = useRef(false)
  const label = t('speech.auto_reply')

  async function toggle(): Promise<void> {
    if (disabled || updatingRef.current) return
    updatingRef.current = true
    try {
      await onChange(!enabled)
    } finally {
      updatingRef.current = false
    }
  }

  return (
    <SelectableIconButton
      preserveFocus
      className="composer-speech-reply-toggle"
      disabled={disabled}
      Icon={VolumeX}
      iconSize={15}
      label={label}
      pressed={enabled}
      PressedIcon={Volume2}
      onClick={() => void toggle()}
    />
  )
}
