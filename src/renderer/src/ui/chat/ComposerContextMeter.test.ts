import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
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
  estimatedInputTokens: 7_000,
  currentContextTokens: 7_000,
  maxContextTokens: 10_000,
  maxOutputTokens: 1_000,
  inputCapacityTokens: 9_000,
  compressionEnabled: true,
  compressionThreshold: 0.8,
  compressionThresholdTokens: 7_200,
  compressionApplied: false,
  manualCompressionAvailable: true,
  breakdown: {
    profileTokens: 0,
    systemInstructionTokens: 0,
    runtimeContextTokens: 0,
    workspaceTokens: 0,
    memoryTokens: 0,
    skillTokens: 0,
    toolDefinitionTokens: 0,
    messageTokens: 7_000,
    attachmentTokens: 0
  }
}

describe('ComposerContextMeter', () => {
  it('shows zero used context even with a large response reserve', () => {
    const html = renderToStaticMarkup(createElement(ComposerContextMeter, {
      compressionBusy: false, disabled: false, onCompress: () => {},
      status: { ...status, currentContextTokens: 0, estimatedInputTokens: 0,
        maxContextTokens: 128000, maxOutputTokens: 32000, inputCapacityTokens: 96000 }
    }))
    expect(html).toContain('--context-percent:0%')
    expect(html).toContain('--context-current-percent:0%')
    expect(html).toContain('--context-reserve-percent:25%')
    expect(html).toContain('&quot;used&quot;:&quot;0&quot;')
  })
  it('uses current context over usable capacity and excludes output reserve', () => {
    const html = renderToStaticMarkup(createElement(ComposerContextMeter, {
      compressionBusy: false,
      disabled: false,
      status,
      onCompress: () => {}
    }))

    expect(html).toContain('--context-percent:77.8%')
    expect(html).toContain('--context-current-percent:70%')
    expect(html).not.toContain('--context-reserve-start-percent')
    expect(html).toContain('--context-reserve-percent:10%')
    expect(html).toContain('--context-threshold-percent:72%')
    expect(html).toContain('&quot;used&quot;:&quot;7k&quot;')
    expect(html).toContain('&quot;capacity&quot;:&quot;9k&quot;')
    expect(html).toContain('&quot;percent&quot;:77.8')
  })

  it('does not replace current context with the previous request usage', () => {
    const html = renderToStaticMarkup(createElement(ComposerContextMeter, {
      compressionBusy: false,
      disabled: false,
      status: {
        ...status,
        serverUsage: {
          inputTokens: 4_000,
          outputTokens: 1_000,
          totalTokens: 5_000
        }
      },
      onCompress: () => {}
    }))

    expect(html).toContain('--context-percent:77.8%')
    expect(html).toContain('--context-current-percent:70%')
    expect(html).not.toContain('--context-reserve-start-percent')
    expect(html).toContain('&quot;used&quot;:&quot;7k&quot;')
    expect(html).toContain('&quot;percent&quot;:77.8')
  })

  it('rounds k values to two decimal places without trailing zeroes', () => {
    const html = renderToStaticMarkup(createElement(ComposerContextMeter, {
      compressionBusy: false,
      disabled: false,
      status: {
        ...status,
        estimatedInputTokens: 11_345,
        currentContextTokens: 11_345,
        maxContextTokens: 128_765,
        inputCapacityTokens: 127_765
      },
      onCompress: () => {}
    }))

    expect(html).toContain('&quot;used&quot;:&quot;11.35k&quot;')
    expect(html).toContain('&quot;capacity&quot;:&quot;127.77k&quot;')
  })
})
