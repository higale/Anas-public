import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ProfileSettings } from './ProfileSettings'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

describe('profile settings layout', () => {
  it('groups the avatar and name label in the wide row column before the input', () => {
    render(
      <ProfileSettings
        avatarDragActive={false}
        customAvatar={false}
        profile={undefined}
        onAvatarDragEnter={vi.fn()}
        onAvatarDragLeave={vi.fn()}
        onAvatarDragOver={vi.fn()}
        onAvatarDrop={vi.fn()}
        onEditAvatar={vi.fn()}
        onClearAvatar={vi.fn()}
        onProfileChange={vi.fn()}
      />
    )

    const nameInput = screen.getByRole('textbox', { name: 'settings.assistant_name' })
    const avatarButton = screen.getByRole('button', { name: 'settings.edit_avatar' })
    const row = nameInput.parentElement
    const nameLabel = avatarButton.parentElement?.parentElement

    expect(row).toHaveClass('ui-form-row-wide', 'settings-profile-name-row')
    expect(nameLabel).toHaveClass('settings-profile-name-label')
    expect(row?.firstElementChild).toBe(nameLabel)
    expect(row?.lastElementChild).toBe(nameInput)
    expect(document.querySelector('.settings-profile-name-control')).not.toBeInTheDocument()
  })
})
