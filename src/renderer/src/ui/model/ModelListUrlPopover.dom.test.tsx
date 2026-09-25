import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ModelListUrlPopover } from './ModelListUrlPopover'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { url?: string }) => values?.url ? `${key}: ${values.url}` : key
  })
}))

describe('model list URL popover', () => {
  it('shows the inferred endpoint when no explicit URL is configured', async () => {
    const user = userEvent.setup()
    render(
      <ModelListUrlPopover
        baseUrl="https://example.com/v1"
        modelListAuth="bearer"
        modelListUrl=""
        onChange={vi.fn()}
        protocol="openai_chat_completions"
      />
    )

    await user.click(screen.getByRole('button', { name: 'settings.edit_model_list_settings' }))

    expect(screen.getByText('settings.model_list_url_resolved: https://example.com/v1/models'))
      .toBeInTheDocument()
  })

  it('changes the authentication used to fetch model lists', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <ModelListUrlPopover
        baseUrl="https://example.com/v1"
        modelListAuth="bearer"
        modelListUrl="{base_url}/models"
        onChange={onChange}
        protocol="openai_chat_completions"
      />
    )

    await user.click(screen.getByRole('button', { name: 'settings.edit_model_list_settings' }))
    expect(screen.getByText('settings.model_list_auth_hint')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'settings.model_list_auth' }))
    await user.click(screen.getByRole('option', { name: 'settings.model_list_auth_anthropic' }))

    expect(onChange).toHaveBeenCalledWith({
      modelListAuth: 'anthropic',
      modelListUrl: '{base_url}/models'
    })
  })

  it('restores both the URL and authentication from a matching template', async () => {
    const user = userEvent.setup()
    const onChange = vi.fn()
    render(
      <ModelListUrlPopover
        baseUrl="https://api.anthropic.com"
        modelListAuth="bearer"
        modelListUrl="/custom-models"
        onChange={onChange}
        protocol="anthropic_messages"
      />
    )

    await user.click(screen.getByRole('button', { name: 'settings.edit_model_list_settings' }))
    await user.click(screen.getByRole('button', { name: 'settings.restore_template_model_list_settings' }))

    expect(onChange).toHaveBeenCalledWith({
      modelListAuth: 'anthropic',
      modelListUrl: 'https://api.anthropic.com/v1/models'
    })
  })
})
