import { Bot } from 'lucide-react'
import { NoFocusButton } from './NoFocusButton'

type PersonaAvatarSize = 'sm' | 'md' | 'lg'

interface PersonaAvatarProps {
  ariaLabel: string
  dataUri?: string
  onClick: () => void | Promise<void>
  size?: PersonaAvatarSize
}

export function PersonaAvatar({ ariaLabel, dataUri, onClick, size = 'md' }: PersonaAvatarProps) {
  const content = dataUri ? <img src={dataUri} alt="" draggable={false} /> : <Bot />

  return (
    <NoFocusButton
      aria-label={ariaLabel}
      className={`ui-avatar ui-avatar-${size}`}
      type="button"
      onClick={() => void onClick()}
    >
      {content}
    </NoFocusButton>
  )
}
