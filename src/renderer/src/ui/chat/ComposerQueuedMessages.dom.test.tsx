import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { QueuedAgentMessage } from '../agent/useQueuedAgentMessages'
import { ComposerQueuedMessages } from './ComposerQueuedMessages'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}))

function queued(id: string, status: QueuedAgentMessage['status'] = 'queued'): QueuedAgentMessage {
  return {
    id,
    threadId: 'thread-1',
    text: `Message ${id}`,
    displayText: `Message ${id}`,
    attachments: [],
    status,
    createdAt: '2026-08-29T00:00:00.000Z',
    ...(status === 'direction_pending' ? { targetRunId: 'run-1' } : {})
  }
}

describe('ComposerQueuedMessages', () => {
  it('renders multiple messages in one bounded list and exposes per-item actions', () => {
    const onRemove = vi.fn()
    const onRetry = vi.fn()
    const onSteer = vi.fn()
    const messages = [queued('1'), queued('2'), queued('3')]
    messages[0].attachments = [{
      path: 'C:\\notes.txt',
      name: 'notes.txt',
      size: 12,
      kind: 'text',
      mimeType: 'text/plain',
      contextPolicy: 'one_turn'
    }]
    const { container } = render(
      <ComposerQueuedMessages
        messages={messages}
        run={{ runId: 'run-1', operation: 'agent', status: 'running' }}
        onRemove={onRemove}
        onRetry={onRetry}
        onSteer={onSteer}
      />
    )

    expect(container.querySelector('.composer-queue-list')).toHaveAttribute('role', 'list')
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
    expect(screen.getByText('notes.txt')).toBeInTheDocument()
    fireEvent.click(screen.getAllByText('chat.queued_direction')[1])
    expect(onSteer).toHaveBeenCalledWith(messages[1], 'run-1')
    fireEvent.click(screen.getAllByLabelText('chat.remove_queued_message')[2])
    expect(onRemove).toHaveBeenCalledWith(messages[2])
  })

  it('shows direction and dispatch states without offering duplicate actions', () => {
    render(
      <ComposerQueuedMessages
        messages={[queued('1', 'direction_pending'), queued('2', 'dispatching'), queued('3', 'failed')]}
        run={{ runId: 'run-1', operation: 'agent', status: 'running' }}
        onRemove={vi.fn()}
        onRetry={vi.fn()}
        onSteer={vi.fn()}
      />
    )

    expect(screen.getByText('chat.queued_direction_pending')).toBeInTheDocument()
    expect(screen.getByText('chat.queued_dispatching')).toBeInTheDocument()
    expect(screen.getByText('chat.retry_queued_message')).toBeInTheDocument()
    expect(screen.queryAllByText('chat.queued_direction')).toHaveLength(0)
    expect(screen.getAllByLabelText('chat.remove_queued_message')[1]).toBeDisabled()
  })

  it('resets auto-follow when the visible queue changes to another thread', () => {
    const props = {
      run: { runId: 'run-1', operation: 'agent' as const, status: 'running' as const },
      onRemove: vi.fn(),
      onRetry: vi.fn(),
      onSteer: vi.fn()
    }
    const { container, rerender } = render(
      <ComposerQueuedMessages messages={[queued('1')]} {...props} />
    )
    const list = container.querySelector('.composer-queue-list') as HTMLDivElement
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 500 }
    })
    list.scrollTop = 0
    fireEvent.scroll(list)

    const nextThreadMessage = { ...queued('2'), threadId: 'thread-2' }
    rerender(<ComposerQueuedMessages messages={[nextThreadMessage]} {...props} />)

    expect(list.scrollTop).toBe(500)
  })
})
