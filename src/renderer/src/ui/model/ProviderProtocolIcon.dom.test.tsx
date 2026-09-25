import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { ProviderProtocolIcon } from './ProviderProtocolIcon'

describe('ProviderProtocolIcon', () => {
  it('keeps an unconfigured provider icon muted', () => {
    const { container } = render(<ProviderProtocolIcon provider="openai_responses" />)

    expect(container.querySelector('svg')).toHaveClass(
      'provider-protocol-icon',
      'provider-protocol-icon-openai_responses'
    )
    expect(container.querySelector('svg')).not.toHaveClass('provider-protocol-icon-brand')
  })

  it('marks configured provider icons for their brand color', () => {
    const { container } = render(<ProviderProtocolIcon provider="anthropic_messages" brandColor />)

    expect(container.querySelector('svg')).toHaveClass(
      'provider-protocol-icon-anthropic_messages',
      'provider-protocol-icon-brand'
    )
  })
})
