import { useTranslation } from 'react-i18next'
import { PersonaAvatar } from './PersonaAvatar'

interface SidebarProfileHeaderProps {
  avatarDataUri?: string
  assistantName: string
  assistantRole?: string
  onAvatarClick: () => void | Promise<void>
}

export function SidebarProfileHeader({
  assistantName,
  assistantRole,
  avatarDataUri,
  onAvatarClick
}: SidebarProfileHeaderProps) {
  const { t } = useTranslation()

  return (
    <div className="sidebar-profile-header ui-row">
      <PersonaAvatar
        ariaLabel={t('settings.assistant_profile')}
        dataUri={avatarDataUri}
        size="lg"
        onClick={onAvatarClick}
      />
      <span className="ui-copy-stack">
        <span className="ui-title-sm ui-truncate">{assistantName}</span>
        {assistantRole && <span className="ui-subtitle-sm ui-truncate">{assistantRole}</span>}
      </span>
    </div>
  )
}
