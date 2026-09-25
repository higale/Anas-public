import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { ProviderModelAddDialog } from './ProviderModelAddDialog'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

function props(overrides: Partial<ComponentProps<typeof ProviderModelAddDialog>> = {}): ComponentProps<typeof ProviderModelAddDialog> {
  return {
    baseUrl: 'https://example.com/v1', candidates: ['Qwen-A', 'Qwen-B', 'DeepSeek'], configuredModelIds: [], listLoading: false,
    modelListAuth: 'bearer', modelListUrl: '{base_url}/models', open: true, protocol: 'openai_chat_completions',
    onAddBlank: vi.fn(), onAddSelected: vi.fn().mockResolvedValue(true), onModelListSettingsChange: vi.fn(),
    onOpenChange: vi.fn(), onRefreshCandidates: vi.fn(), ...overrides
  }
}

describe('provider model add dialog', () => {
  it('selects all unique candidates and adds them together', async () => {
    const user = userEvent.setup()
    const onAddSelected = vi.fn().mockResolvedValue(true)
    const onOpenChange = vi.fn()
    render(
      <ProviderModelAddDialog
        baseUrl="https://example.com/v1"
        candidates={['model-a', 'model-b', 'model-a']}
        configuredModelIds={[]}
        listLoading={false}
        modelListAuth="bearer"
        modelListUrl="{base_url}/models"
        open
        protocol="openai_chat_completions"
        onAddBlank={vi.fn()}
        onAddSelected={onAddSelected}
        onModelListSettingsChange={vi.fn()}
        onOpenChange={onOpenChange}
        onRefreshCandidates={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: 'settings.edit_model_list_settings' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'settings.fetch_available_models' })).toBeEnabled()
    await user.click(screen.getByRole('checkbox', { name: 'menu.select_all' }))
    await user.click(screen.getByRole('button', { name: 'settings.add_selected_models' }))

    expect(onAddSelected).toHaveBeenCalledWith(['model-a', 'model-b'])
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('keeps blank model creation available for manual entry', async () => {
    const user = userEvent.setup()
    const onAddBlank = vi.fn().mockResolvedValue(true)
    const onOpenChange = vi.fn()
    render(
      <ProviderModelAddDialog
        baseUrl="https://example.com/v1"
        candidates={[]}
        configuredModelIds={[]}
        listLoading={false}
        modelListAuth="bearer"
        modelListUrl="{base_url}/models"
        open
        protocol="openai_chat_completions"
        onAddBlank={onAddBlank}
        onAddSelected={vi.fn()}
        onModelListSettingsChange={vi.fn()}
        onOpenChange={onOpenChange}
        onRefreshCandidates={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: 'settings.blank_model' }))

    expect(onAddBlank).toHaveBeenCalledOnce()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it.each([{ candidates: [] }, { candidates: ['Only model'] }])('offers search even with few candidates: $candidates', async ({ candidates }) => {
    render(<ProviderModelAddDialog {...props({ candidates })} />)
    expect(screen.getByRole('searchbox', { name: 'settings.search_models' })).toBeVisible()
    expect(screen.getByRole('searchbox', { name: 'settings.search_models' })).toHaveFocus()
  })

  it('filters case-insensitively and restores selected models when the query is cleared', async () => {
    const user = userEvent.setup(), input = props()
    render(<ProviderModelAddDialog {...input} />)
    await user.click(screen.getByRole('checkbox', { name: 'DeepSeek' }))
    const search = screen.getByRole('searchbox')
    await user.type(search, '  QWEN  ')
    expect(screen.getByRole('checkbox', { name: 'Qwen-A' })).toBeVisible()
    expect(screen.getByRole('checkbox', { name: 'Qwen-B' })).toBeVisible()
    expect(screen.queryByRole('checkbox', { name: 'DeepSeek' })).not.toBeInTheDocument()
    await user.clear(search)
    await user.type(search, 'not-a-model')
    expect(screen.getByText('settings.no_matching_models')).toBeVisible()
    expect(screen.getByRole('checkbox', { name: 'settings.select_filtered_models' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'settings.add_selected_models' })).toBeEnabled()
    await user.clear(search)
    expect(screen.getByRole('checkbox', { name: 'DeepSeek' })).toBeChecked()
    expect(screen.getByRole('searchbox')).toHaveValue('')
    expect(input.onRefreshCandidates).not.toHaveBeenCalled()
  })

  it('selects and deselects only visible matches while submitting all retained selections', async () => {
    const user = userEvent.setup(), input = props()
    render(<ProviderModelAddDialog {...input} />)
    await user.click(screen.getByRole('checkbox', { name: 'DeepSeek' }))
    const search = screen.getByRole('searchbox')
    await user.type(search, 'qwen')
    const selectFiltered = screen.getByRole('checkbox', { name: 'settings.select_filtered_models' })
    await user.click(selectFiltered)
    expect(screen.getByRole('checkbox', { name: 'Qwen-A' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Qwen-B' })).toBeChecked()
    await user.click(selectFiltered)
    expect(screen.getByRole('checkbox', { name: 'Qwen-A' })).not.toBeChecked()
    await user.click(screen.getByRole('checkbox', { name: 'Qwen-A' }))
    await user.clear(search)
    await user.type(search, 'deep')
    expect(screen.getByRole('checkbox', { name: 'DeepSeek' })).toBeChecked()
    expect(selectFiltered).toBeChecked()
    await user.click(screen.getByRole('button', { name: 'settings.add_selected_models' }))
    expect(input.onAddSelected).toHaveBeenCalledWith(['DeepSeek', 'Qwen-A'])
  })

  it('keeps the query across candidate refreshes and excludes removed selections', async () => {
    const user = userEvent.setup(), input = props()
    const view = render(<ProviderModelAddDialog {...input} />)
    await user.click(screen.getByRole('checkbox', { name: 'Qwen-A' }))
    await user.click(screen.getByRole('checkbox', { name: 'DeepSeek' }))
    await user.type(screen.getByRole('searchbox'), 'qwen')
    view.rerender(<ProviderModelAddDialog {...input} candidates={['Qwen-A', 'Qwen-C']} />)
    expect(screen.getByRole('searchbox')).toHaveValue('qwen')
    expect(screen.getByRole('checkbox', { name: 'Qwen-A' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Qwen-C' })).not.toBeChecked()
    await user.click(screen.getByRole('button', { name: 'settings.add_selected_models' }))
    expect(input.onAddSelected).toHaveBeenCalledWith(['Qwen-A'])
  })

  it('resets search and selections when the controlled dialog closes and reopens', async () => {
    const user = userEvent.setup(), input = props()
    const view = render(<ProviderModelAddDialog {...input} />)
    await user.click(screen.getByRole('checkbox', { name: 'DeepSeek' }))
    await user.type(screen.getByRole('searchbox'), 'qwen')
    view.rerender(<ProviderModelAddDialog {...input} open={false} />)
    view.rerender(<ProviderModelAddDialog {...input} />)
    expect(screen.getByRole('searchbox')).toHaveValue('')
    expect(screen.getByRole('checkbox', { name: 'DeepSeek' })).not.toBeChecked()
  })
})
