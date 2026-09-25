import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AppearanceSettings } from './AppearanceSettings'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

describe('appearance settings layout', () => {
  it('renders its options as divided rows in one settings card', () => {
    render(
      <AppearanceSettings
        languageOptions={[{ code: 'en', name: 'English', builtIn: true }]}
        languageValue="en"
        systemLanguage="system"
        themeValue="dark"
        fontSizeValue={15}
        chatContentWidthValue="wide"
        onSaveLanguage={vi.fn()}
        onSaveTheme={vi.fn()}
        onSaveFontSize={vi.fn()}
        onSaveChatContentWidth={vi.fn()}
      />
    )

    const card = document.querySelector('.settings-card')
    expect(card).toBeInTheDocument()
    expect(card?.children).toHaveLength(4)
    expect(screen.getByRole('heading', { level: 2, name: 'settings.appearance' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'settings.language' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'settings.theme' })).toBeInTheDocument()
    const fontSizeInput = screen.getByRole('spinbutton', { name: 'settings.font_size' })
    expect(fontSizeInput).toHaveValue(15)
    expect(fontSizeInput).toHaveAttribute('max', '18')
    expect(Array.from(card?.children ?? []).every((row) => row.classList.contains('ui-form-row-narrow'))).toBe(true)
    expect(fontSizeInput.closest('label')).toHaveClass('ui-form-row-narrow')
    expect(screen.getByRole('combobox', { name: 'settings.chat_content_width' })).toHaveValue('settings.chat_content_width_wide')
  })
})
