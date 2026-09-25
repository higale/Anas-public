import type { DragEvent } from 'react'
import { Image as ImageIcon, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AppProfile, AppProfileUpdate } from '@shared/types'
import { CommitTextInput, CommitTextarea } from '../CommitTextField'
import { UI_ICON_SIZE_TINY, UI_TEXTAREA_ROWS_COMPACT } from '../uiConstants'
import { SettingsGroup } from './SettingsGroup'

interface ProfileSettingsProps {
  avatarDataUri?: string
  avatarDragActive: boolean
  customAvatar: boolean
  profile: AppProfile | undefined
  onAvatarDragEnter: (event: DragEvent<HTMLButtonElement>) => void
  onAvatarDragLeave: (event: DragEvent<HTMLButtonElement>) => void
  onAvatarDragOver: (event: DragEvent<HTMLButtonElement>) => void
  onAvatarDrop: (event: DragEvent<HTMLButtonElement>) => void | Promise<void>
  onEditAvatar: () => void | Promise<void>
  onClearAvatar: () => void | Promise<void>
  onProfileChange: (profile: AppProfileUpdate) => void | Promise<void>
}

export function ProfileSettings({
  avatarDataUri,
  avatarDragActive,
  customAvatar,
  profile,
  onAvatarDragEnter,
  onAvatarDragLeave,
  onAvatarDragOver,
  onAvatarDrop,
  onEditAvatar,
  onClearAvatar,
  onProfileChange
}: ProfileSettingsProps) {
  const { t } = useTranslation()
  const assistant = profile?.assistant ?? { name: '', role: '', instructions: '' }
  const user = profile?.user ?? { preferredName: '', personalInfo: '' }
  const textareaClass = 'ui-autosize-textarea ui-code-textarea ui-textarea-wrap'

  return (
    <div className="settings-profile">
      <SettingsGroup
        title={t('settings.assistant_profile')}
      >
        <div className="ui-form-row ui-form-row-wide settings-profile-name-row">
          <div className="settings-profile-name-label">
            <div className="ui-corner-host ui-hover-reveal settings-profile-avatar">
              <button
                aria-label={t('settings.edit_avatar')}
                className={avatarDragActive ? 'ui-avatar ui-avatar-lg ui-avatar-active' : 'ui-avatar ui-avatar-lg'}
                data-tooltip={t('settings.edit_avatar')}
                type="button"
                onClick={() => void onEditAvatar()}
                onDragEnter={onAvatarDragEnter}
                onDragLeave={onAvatarDragLeave}
                onDragOver={onAvatarDragOver}
                onDrop={(event) => void onAvatarDrop(event)}
              >
                {avatarDataUri ? <img src={avatarDataUri} alt="" draggable={false} /> : <ImageIcon />}
              </button>
              {customAvatar && (
                <button
                  aria-label={t('common.delete')}
                  className="ui-corner-action ui-hover-reveal-target ui-icon-button ui-icon-button-xs ui-button-danger"
                  data-tooltip={t('common.delete')}
                  type="button"
                  onClick={() => void onClearAvatar()}
                >
                  <Trash2 size={UI_ICON_SIZE_TINY} />
                </button>
              )}
            </div>
            <div className="ui-copy-stack">
              <label htmlFor="assistant-name-input">
                <strong>{t('settings.assistant_name')}</strong>
              </label>
              <small id="assistant-name-hint">{t('settings.assistant_name_hint')}</small>
            </div>
          </div>
          <CommitTextInput
            id="assistant-name-input"
            aria-describedby="assistant-name-hint"
            className="ui-form-control"
            type="text"
            value={assistant.name}
            onCommit={(name) => void onProfileChange({ assistant: { name } })}
          />
        </div>
        <label className="ui-form-row ui-form-row-wide" htmlFor="assistant-role-input">
          <span>
            <strong>{t('settings.assistant_role')}</strong>
            <small>{t('settings.assistant_role_hint')}</small>
          </span>
          <CommitTextarea
            id="assistant-role-input"
            className={textareaClass}
            data-max-height="none"
            rows={UI_TEXTAREA_ROWS_COMPACT}
            value={assistant.role}
            onCommit={(role) => void onProfileChange({ assistant: { role } })}
          />
        </label>
        <label className="ui-form-row ui-form-row-wide" htmlFor="assistant-instructions-input">
          <span>
            <strong>{t('settings.assistant_instructions')}</strong>
            <small>{t('settings.assistant_instructions_hint')}</small>
          </span>
          <CommitTextarea
            id="assistant-instructions-input"
            className={textareaClass}
            data-max-height="none"
            rows={UI_TEXTAREA_ROWS_COMPACT}
            value={assistant.instructions}
            onCommit={(instructions) => void onProfileChange({ assistant: { instructions } })}
          />
        </label>
      </SettingsGroup>
      <SettingsGroup
        className="settings-profile-user"
        title={t('settings.user_profile')}
      >
        <label className="ui-form-row ui-form-row-wide" htmlFor="user-preferred-name-input">
          <span>
            <strong>{t('settings.preferred_name')}</strong>
            <small>{t('settings.preferred_name_hint')}</small>
          </span>
          <CommitTextInput
            id="user-preferred-name-input"
            className="ui-form-control"
            type="text"
            value={user.preferredName}
            onCommit={(preferredName) => void onProfileChange({ user: { preferredName } })}
          />
        </label>
        <label className="ui-form-row ui-form-row-wide" htmlFor="user-personal-info-input">
          <span>
            <strong>{t('settings.personal_info')}</strong>
            <small>{t('settings.personal_info_hint')}</small>
          </span>
          <CommitTextarea
            id="user-personal-info-input"
            className={textareaClass}
            data-max-height="none"
            rows={UI_TEXTAREA_ROWS_COMPACT}
            value={user.personalInfo}
            onCommit={(personalInfo) => void onProfileChange({ user: { personalInfo } })}
          />
        </label>
      </SettingsGroup>
    </div>
  )
}
