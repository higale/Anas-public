import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { ModelProtocol } from '@shared/types'
import { ModelExtraParametersField } from './ModelExtraParametersField'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => `${key}${values ? ` ${Object.values(values).join(' ')}` : ''}`
  })
}))

function Field({ initial = '', protocol = 'openai_chat_completions' }: { initial?: string, protocol?: ModelProtocol }) {
  const [value, setValue] = useState(initial)
  return <ModelExtraParametersField value={value} protocol={protocol} placeholder="{}" onCommit={setValue} />
}

async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'settings.add_extra_parameter' }))
  return screen.getByRole('menu')
}

describe('extra parameter insertion', () => {
  it('merges into the current uncommitted text and preserves existing values', async () => {
    const user = userEvent.setup()
    render(<Field />)
    const input = screen.getByRole('textbox')
    const existing = { temperature: 0, custom: [false, null, { value: 4 }] }
    await user.click(input)
    await user.paste(JSON.stringify(existing))
    const menu = await openMenu(user)
    expect(within(menu).getByRole('menuitem', { name: /^temperature\b/ })).toHaveAttribute('aria-disabled', 'true')
    const topP = within(menu).getByRole('menuitem', { name: /^top_p\b/ })
    expect(topP).toHaveTextContent('0–1')
    await user.click(topP)
    expect(JSON.parse((input as HTMLTextAreaElement).value)).toEqual({ ...existing, top_p: 0.9 })
    await openMenu(user)
    expect(screen.getByRole('menuitem', { name: /^top_p\b/ })).toHaveAttribute('aria-disabled', 'true')
  })

  it('adds a nested parameter while preserving siblings and unrelated nested values', async () => {
    const user = userEvent.setup()
    const existing = { text: { format: { type: 'text' } }, custom: { enabled: false } }
    render(<Field protocol="openai_responses" initial={JSON.stringify(existing)} />)
    const menu = await openMenu(user)
    expect(within(menu).queryByRole('menuitem', { name: /^reasoning_effort\b/ })).not.toBeInTheDocument()
    expect(within(menu).queryByRole('menuitem', { name: /^reasoning\.effort\b/ })).not.toBeInTheDocument()
    await user.click(within(menu).getByRole('menuitem', { name: /^text\.verbosity\b/ }))
    expect(JSON.parse((screen.getByRole('textbox') as HTMLTextAreaElement).value)).toEqual({
      ...existing, text: { format: { type: 'text' }, verbosity: 'medium' }
    })
  })

  it.each(['{"temperature":', '[]', 'null'])('preserves invalid or non-object JSON without allowing insertion: %s', async (initial) => {
    const user = userEvent.setup()
    render(<Field initial={initial} />)
    const menu = await openMenu(user)
    expect(within(menu).getByRole('alert')).toBeVisible()
    const parameter = within(menu).getByRole('menuitem', { name: /^temperature\b/ })
    expect(parameter).toHaveAttribute('aria-disabled', 'true')
    await user.click(parameter)
    expect(screen.getByRole('textbox')).toHaveValue(initial)
  })

  it('does not replace an incompatible parent object or an explicitly configured null', async () => {
    const user = userEvent.setup()
    const initial = '{"text":false,"temperature":null}'
    render(<Field protocol="openai_responses" initial={initial} />)
    const menu = await openMenu(user)
    const verbosity = within(menu).getByRole('menuitem', { name: /^text\.verbosity\b/ })
    expect(verbosity).toHaveAttribute('aria-disabled', 'true')
    expect(verbosity).toHaveTextContent('settings.parameter_structure_conflict')
    const temperature = within(menu).getByRole('menuitem', { name: /^temperature\b/ })
    expect(temperature).toHaveAttribute('aria-disabled', 'true')
    await user.click(temperature)
    await user.click(verbosity)
    expect(screen.getByRole('textbox')).toHaveValue(initial)
  })

  it('inserts a new object for an empty field using the selected protocol', async () => {
    const user = userEvent.setup()
    render(<Field protocol="anthropic_messages" />)
    const menu = await openMenu(user)
    expect(within(menu).queryByRole('menuitem', { name: /^reasoning_effort\b/ })).not.toBeInTheDocument()
    expect(within(menu).getByRole('menuitem', { name: /^temperature\b/ })).toHaveTextContent('0–1')
    expect(within(menu).queryByRole('menuitem', { name: /^thinking\./ })).not.toBeInTheDocument()
    await user.click(within(menu).getByRole('menuitem', { name: /^top_k\b/ }))
    expect(JSON.parse((screen.getByRole('textbox') as HTMLTextAreaElement).value)).toEqual({ top_k: 40 })
  })
})
