import * as Dialog from '@radix-ui/react-dialog'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { NoticeHost, notice } from './notice'
import { readFileSync } from 'node:fs'

const noticeStyles = readFileSync('src/renderer/src/styles/notice.css', 'utf8')

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(() => notice.dismiss())

function ModalNoticeFixture() {
  const [open, setOpen] = useState(true)
  return <>
    <style>{noticeStyles}</style>
    <NoticeHost theme="light" />
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay data-testid="modal-overlay" />
        <Dialog.Content>
          <Dialog.Title>Edit project</Dialog.Title>
          <Dialog.Description>Keep the draft while handling notifications.</Dialog.Description>
          <input aria-label="Draft" defaultValue="Unsaved input" />
          <button onClick={() => notice.error('Save failed', { description: 'Duplicate project name' })}>Save</button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  </>
}

it('allows dismissing a notice through a modal without dismissing the modal or losing its draft', async () => {
  const user = userEvent.setup()
  render(<ModalNoticeFixture />)
  await user.click(screen.getByRole('button', { name: 'Save' }))
  await screen.findByText('Duplicate project name')
  const close = screen.getByRole('button', { name: 'common.close' })
  await user.click(close)
  await waitFor(() => expect(screen.queryByText('Duplicate project name')).not.toBeInTheDocument())
  expect(screen.getByRole('dialog')).toBeVisible()
  expect(screen.getByRole('textbox', { name: 'Draft' })).toHaveValue('Unsaved input')
  // The notice branch must not disable normal outside dismissal.
  await user.click(screen.getByTestId('modal-overlay'))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
})
