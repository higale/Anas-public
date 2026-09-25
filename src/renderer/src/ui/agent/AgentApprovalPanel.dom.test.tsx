import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { AgentApprovalPanel } from './AgentApprovalPanel'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

const interrupts = [{
  id: 'approval-1',
  approvalGeneration: 'generation-1',
  value: {
    actionRequests: [{
      name: 'pwsh',
      args: { command: 'echo ok' }
    }]
  }
}]

describe('AgentApprovalPanel', () => {
  it.each(['apply_patch', 'restore_file_edit'])('shows all %s targets without sending display fields back to the framework', async (name) => {
    const user = userEvent.setup(), onResume = vi.fn()
    const args = name === 'apply_patch' ? { patch: '*** Begin Patch\n*** Update File: source.txt\n*** Move to: ../outside/中文 文件.txt\n*** End Patch' }
      : { operation_id: 'operation', request_id: 'origin' }
    const original = structuredClone(args)
    const paths = ['/project/source.txt', '/outside/中文 文件.txt']
    render(<AgentApprovalPanel accessMode="strict_approval" interrupts={[{
      ...interrupts[0], value: { actionRequests: [{ name, args }] },
      pathPreviews: paths.map((absolutePath, index) => ({ actionIndex: 0, absolutePath,
        locator: name === 'apply_patch' ? ['operations', 0, index === 0 ? 'path' : 'destination'] : ['targets', index, 'path'],
        source: name === 'apply_patch' ? 'relative' : 'resolved' }))
    }]} onRequestFullAccess={vi.fn()} onResume={onResume} />)
    const shown = screen.getByRole('dialog').querySelector('pre')!
    expect(shown).toBeVisible()
    for (const path of paths) expect(shown).toHaveTextContent(`"${path}"`)
    expect(JSON.parse(shown.textContent!)).toEqual({ ...original, targets: paths.map((path) => ({ path })) })
    await user.click(screen.getByRole('button', { name: /agent\.approve/ }))
    expect(onResume).toHaveBeenCalledExactlyOnceWith([{
      interruptId: 'approval-1', expectedGeneration: 'generation-1', decisions: [{ type: 'approve' }]
    }])
    expect(args).toEqual(original)
  })

  it('updates the rejection label only for nonblank guidance and restores it when cleared', async () => {
    const user = userEvent.setup()
    render(
      <AgentApprovalPanel
        accessMode="strict_approval"
        interrupts={interrupts}
        onRequestFullAccess={vi.fn()}
        onResume={vi.fn()}
      />
    )

    const guidance = screen.getByPlaceholderText('agent.rejection_guidance')
    expect(screen.getByRole('button', { name: 'agent.reject' })).toBeVisible()
    await user.type(guidance, '   ')
    expect(screen.getByRole('button', { name: 'agent.reject' })).toBeVisible()
    await user.type(guidance, 'Use the project folder.')
    expect(screen.getByRole('button', { name: 'agent.reject_with_reason' })).toBeVisible()
    await user.clear(guidance)
    expect(screen.getByRole('button', { name: 'agent.reject' })).toBeVisible()
  })

  it('sends the reason when the labeled rejection button is clicked', async () => {
    const user = userEvent.setup()
    const onResume = vi.fn()
    render(
      <AgentApprovalPanel
        accessMode="strict_approval"
        interrupts={interrupts}
        onRequestFullAccess={vi.fn()}
        onResume={onResume}
      />
    )

    await user.type(screen.getByPlaceholderText('agent.rejection_guidance'), '  Use the project folder.  ')
    await user.click(screen.getByRole('button', { name: 'agent.reject_with_reason' }))
    expect(onResume).toHaveBeenCalledExactlyOnceWith([{
      interruptId: 'approval-1',
      expectedGeneration: 'generation-1',
      decisions: [{
        type: 'reject',
        message: 'User rejected the tool call for `pwsh`.\nUser feedback: Use the project folder.'
      }]
    }])
  })

  it('inserts a newline with Enter without submitting rejection guidance', async () => {
    const user = userEvent.setup()
    const onResume = vi.fn()
    render(
      <AgentApprovalPanel
        accessMode="strict_approval"
        interrupts={interrupts}
        onRequestFullAccess={vi.fn()}
        onResume={onResume}
      />
    )

    expect(screen.getByText('agent.shell_default_timeout')).toBeVisible()
    const guidance = screen.getByPlaceholderText('agent.rejection_guidance')
    await user.type(guidance, 'Use the project folder.{Enter}Do not modify other files.')

    expect(guidance).toHaveValue('Use the project folder.\nDo not modify other files.')
    expect(onResume).not.toHaveBeenCalled()
  })

  it('keeps Shift+Enter available for multiline guidance', async () => {
    const user = userEvent.setup()
    const onResume = vi.fn()
    render(
      <AgentApprovalPanel
        accessMode="strict_approval"
        interrupts={interrupts}
        onRequestFullAccess={vi.fn()}
        onResume={onResume}
      />
    )

    const guidance = screen.getByPlaceholderText('agent.rejection_guidance')
    await user.type(guidance, 'First line{Shift>}{Enter}{/Shift}Second line')

    expect(guidance).toHaveValue('First line\nSecond line')
    expect(onResume).not.toHaveBeenCalled()
  })

  it('describes an explicit zero Shell timeout as unlimited', () => {
    render(
      <AgentApprovalPanel
        accessMode="strict_approval"
        interrupts={[{
          ...interrupts[0],
          value: {
            actionRequests: [{
              name: 'pwsh',
              args: { command: 'echo ok', timeout: 0 }
            }]
          }
        }]}
        onRequestFullAccess={vi.fn()}
        onResume={vi.fn()}
      />
    )

    expect(screen.getByText('agent.shell_no_timeout')).toBeVisible()
  })
})
