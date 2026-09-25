import { createRef } from 'react'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ModelListPane } from './ModelListPane'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

function renderModelListPane(onCreateModel: (templateId?: string) => void) {
  render(
    <ModelListPane
      config={undefined}
      listRef={createRef<HTMLDivElement>()}
      onCreateModel={onCreateModel}
      onDeleteModel={vi.fn()}
      onEditModel={vi.fn()}
      onMoveModel={vi.fn()}
    />
  )
}

describe('model template menu', () => {
  it('creates a hosted-service template from its country submenu', async () => {
    const user = userEvent.setup()
    const onCreateModel = vi.fn<(templateId?: string) => void>()
    renderModelListPane(onCreateModel)

    await user.click(screen.getByLabelText('settings.new_provider'))
    const unitedStates = screen.getByRole('menuitem', { name: 'United States' })
    unitedStates.focus()
    await user.keyboard('{ArrowRight}')

    await waitFor(() => expect(screen.getAllByRole('menu')).toHaveLength(2))
    const unitedStatesMenu = screen.getAllByRole('menu').at(-1)
    const openAi = within(unitedStatesMenu!).getByRole('menuitem', { name: 'OpenAI' })
    expect(openAi).toHaveClass('model-template-option')
    await user.click(openAi)

    expect(onCreateModel).toHaveBeenCalledWith('united-states/openai')
  })

  it('creates an official Anthropic protocol template from its provider submenu', async () => {
    const user = userEvent.setup()
    const onCreateModel = vi.fn<(templateId?: string) => void>()
    renderModelListPane(onCreateModel)

    await user.click(screen.getByLabelText('settings.new_provider'))
    const unitedStates = screen.getByRole('menuitem', { name: 'United States' })
    unitedStates.focus()
    await user.keyboard('{ArrowRight}')

    await waitFor(() => expect(screen.getAllByRole('menu')).toHaveLength(2))
    const unitedStatesMenu = screen.getAllByRole('menu').at(-1)
    const anthropic = within(unitedStatesMenu!).getByRole('menuitem', { name: 'Anthropic' })
    expect(anthropic).toHaveClass('model-template-group')
    anthropic.focus()
    await user.keyboard('{ArrowRight}')

    await waitFor(() => expect(screen.getAllByRole('menu')).toHaveLength(3))
    const anthropicMenu = screen.getAllByRole('menu').at(-1)
    const nativeAnthropic = within(anthropicMenu!).getByRole('menuitem', { name: 'Anthropic Messages' })
    await user.click(nativeAnthropic)

    expect(onCreateModel).toHaveBeenCalledWith('united-states/anthropic/anthropic')
  })

  it('creates a template from a provider submenu', async () => {
    const user = userEvent.setup()
    const onCreateModel = vi.fn<(templateId?: string) => void>()
    renderModelListPane(onCreateModel)

    await user.click(screen.getByLabelText('settings.new_provider'))
    const china = screen.getByRole('menuitem', { name: 'China' })
    china.focus()
    await user.keyboard('{ArrowRight}')

    await waitFor(() => expect(screen.getAllByRole('menu')).toHaveLength(2))
    const chinaMenu = screen.getAllByRole('menu').at(-1)
    const qwen = within(chinaMenu!).getByRole('menuitem', { name: 'Qwen' })
    expect(qwen).toHaveClass('model-template-group')
    qwen.focus()
    await user.keyboard('{ArrowRight}')

    await waitFor(() => expect(screen.getAllByRole('menu')).toHaveLength(3))
    const qwenMenu = screen.getAllByRole('menu').at(-1)
    const openAi = within(qwenMenu!).getByRole('menuitem', { name: 'OpenAI' })
    expect(openAi).toHaveClass('model-template-option')
    await user.keyboard('{Enter}')

    expect(onCreateModel).toHaveBeenCalledWith('china/qwen/openai')
  })

  it('creates a template from an arbitrarily nested submenu', async () => {
    const user = userEvent.setup()
    const onCreateModel = vi.fn<(templateId?: string) => void>()
    renderModelListPane(onCreateModel)

    await user.click(screen.getByLabelText('settings.new_provider'))
    const china = screen.getByRole('menuitem', { name: 'China' })
    china.focus()
    await user.keyboard('{ArrowRight}')
    await waitFor(() => expect(screen.getAllByRole('menu')).toHaveLength(2))
    const chinaMenu = screen.getAllByRole('menu').at(-1)
    const qwen = within(chinaMenu!).getByRole('menuitem', { name: 'Qwen' })
    qwen.focus()
    await user.keyboard('{ArrowRight}')
    await waitFor(() => expect(screen.getAllByRole('menu')).toHaveLength(3))
    const qwenMenu = screen.getAllByRole('menu').at(-1)
    const tokenPlan = within(qwenMenu!).getByRole('menuitem', { name: 'TokenPlan' })
    tokenPlan.focus()
    await user.keyboard('{ArrowRight}')

    await waitFor(() => expect(screen.getAllByRole('menu')).toHaveLength(4))
    const submenus = screen.getAllByRole('menu')
    const tokenPlanMenu = submenus.at(-1)
    expect(tokenPlanMenu).toHaveClass('model-template-submenu')
    within(tokenPlanMenu!).getByRole('menuitem', { name: 'Anthropic Messages' }).focus()
    await user.keyboard('{Enter}')

    expect(onCreateModel).toHaveBeenCalledWith('china/qwen/token-plan/anthropic')
  })
})
