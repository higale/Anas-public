import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { AgentContextStatus } from '@shared/agentTypes'
import { ComposerContextMeter } from './ComposerContextMeter'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => values
      ? `${key}:${JSON.stringify(values)}`
      : key
  })
}))

const status: AgentContextStatus = {
  modelConfigId: 'model-test',
  estimatedInputTokens: 4_000,
  currentContextTokens: 5_000,
  serverUsage: {
    inputTokens: 4_000,
    outputTokens: 1_000,
    totalTokens: 5_000,
    inputTokenDetails: { cacheReadTokens: 2_000 },
    outputTokenDetails: { reasoningTokens: 600 }
  },
  maxContextTokens: 10_000,
  maxOutputTokens: 1_000,
  inputCapacityTokens: 9_000,
  compressionEnabled: true,
  compressionThreshold: 0.8,
  compressionThresholdTokens: 7_200,
  compressionApplied: false,
  manualCompressionAvailable: true,
  breakdown: {
    profileTokens: 100,
    systemInstructionTokens: 200,
    runtimeContextTokens: 0,
    workspaceTokens: 300,
    memoryTokens: 0,
    skillTokens: 0,
    toolDefinitionTokens: 400,
    messageTokens: 3_000,
    attachmentTokens: 0
  }
}

describe('ComposerContextMeter interactions', () => {
  it('shows the effective runtime compression point and hides its marker when compression is off', async () => {
    const user = userEvent.setup()
    const { rerender } = render(<ComposerContextMeter compressionBusy={false} disabled={false} onCompress={vi.fn()}
      status={{ ...status, compressionThresholdTokens: 6300 }} />)
    await user.click(screen.getByRole('button', { name: /chat.context_window_title/ }))
    expect(screen.getByText('chat.context_auto_compress_at').parentElement).toHaveTextContent('6.3k · 70%')
    expect(screen.getByText('chat.context_input_capacity').parentElement).toHaveTextContent('9k')
    expect(document.querySelector('.context-meter-bar-threshold')).not.toBeNull()
    rerender(<ComposerContextMeter compressionBusy={false} disabled={false} onCompress={vi.fn()}
      status={{ ...status, compressionEnabled: false }} />)
    expect(document.querySelector('.context-meter-bar-threshold')).toBeNull()
  })
  it('expands current-window and local-estimate details independently', async () => {
    const user = userEvent.setup()
    render(
      <ComposerContextMeter
        compressionBusy={false}
        disabled={false}
        status={status}
        onCompress={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: /chat.context_window_title/ }))
    const responseReserve = await screen.findByText('chat.context_response_reserve')
    const autoCompress = screen.getByText('chat.context_auto_compress_at')
    expect(responseReserve.compareDocumentPosition(autoCompress) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
    const currentSummary = await screen.findByText('chat.context_current_window')
    const currentDetails = currentSummary.closest('details')
    const localSummary = screen.getByText('chat.context_local_estimate')
    const localDetails = localSummary.closest('details')

    expect(currentDetails).not.toHaveAttribute('open')
    expect(localDetails).not.toHaveAttribute('open')

    await user.click(currentSummary)
    expect(currentDetails).toHaveAttribute('open')
    expect(within(currentDetails as HTMLElement).getByText('chat.context_input_tokens'))
      .toBeInTheDocument()
    const cacheReadLabel = within(currentDetails as HTMLElement)
      .getByText('chat.context_cache_read')
    const cacheReadRow = cacheReadLabel.closest('.context-meter-row')
    expect(cacheReadRow).toHaveClass('context-meter-subrow')
    expect(cacheReadRow?.previousElementSibling)
      .toHaveTextContent('chat.context_input_tokens')
    const reasoningLabel = within(currentDetails as HTMLElement)
      .getByText('chat.context_reasoning_tokens')
    const reasoningRow = reasoningLabel.closest('.context-meter-row')
    expect(reasoningRow).toHaveClass('context-meter-subrow')
    expect(reasoningRow?.previousElementSibling)
      .toHaveTextContent('chat.context_output_tokens')
    expect(currentDetails).not.toContainElement(screen.getByText('chat.context_model_window'))

    await user.click(localSummary)
    expect(localDetails).toHaveAttribute('open')
    expect(within(localDetails as HTMLElement).getByText('chat.context_conversation_group'))
      .toBeInTheDocument()
  })

  it('hides the server-only current window when usage is unavailable', async () => {
    const user = userEvent.setup()
    render(
      <ComposerContextMeter
        compressionBusy={false}
        disabled={false}
        status={{ ...status, serverUsage: undefined }}
        onCompress={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: /chat.context_window_title/ }))
    expect(await screen.findByText('chat.context_local_estimate')).toBeInTheDocument()
    expect(screen.queryByText('chat.context_current_window')).not.toBeInTheDocument()
    expect(screen.getByText('chat.context_model_window')).toBeInTheDocument()
  })
})
