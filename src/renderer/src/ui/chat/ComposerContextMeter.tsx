import { PopoverContent } from '../PopoverContent'
import * as Popover from '@radix-ui/react-popover'
import { Calculator, ChevronRight, Cloud } from 'lucide-react'
import type { CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentContextStatus } from '@shared/agentTypes'
import { contextWindowUsageRatio, type AgentContextBudget } from '@shared/contextWindow'
import { NoFocusButton } from '../NoFocusButton'
import {
  UI_POPOVER_COLLISION_PADDING,
  UI_POPOVER_SIDE_OFFSET
} from '../uiConstants'

interface ComposerContextMeterProps {
  compressionBusy: boolean
  disabled: boolean
  status?: AgentContextStatus
  budget?: AgentContextBudget
  onCompress(): void | Promise<void>
}

function tokenCountLabel(value: number): string {
  if (value >= 1_000) return `${Math.round(value / 10) / 100}k`
  return String(value)
}

function usagePercent(status: AgentContextStatus): number {
  const currentWindowTokens = status.currentContextTokens
  return Math.max(
    0,
    Math.min(100, Math.round(
      contextWindowUsageRatio(
        currentWindowTokens,
        status.maxOutputTokens,
        status.maxContextTokens
      ) * 1000
    ) / 10)
  )
}

function tokenPercent(tokens: number, capacity: number): number {
  if (!Number.isFinite(capacity) || capacity <= 0) return 0
  return Math.max(0, Math.min(100, tokens / capacity * 100))
}

export function ComposerContextMeter({
  compressionBusy,
  disabled,
  status,
  budget,
  onCompress
}: ComposerContextMeterProps) {
  const { t } = useTranslation()
  const limits = status ?? budget
  if (!limits) return null

  const currentWindowTokens = status?.currentContextTokens ?? 0
  const percent = status ? usagePercent(status) : 0
  const currentContextPercent = tokenPercent(
    Math.min(currentWindowTokens, limits.inputCapacityTokens),
    limits.maxContextTokens
  )
  const reservePercent = tokenPercent(limits.maxOutputTokens, limits.maxContextTokens)
  const thresholdPercent = tokenPercent(limits.compressionThresholdTokens, limits.maxContextTokens)
  const compressionPercent = tokenPercent(limits.compressionThresholdTokens, limits.inputCapacityTokens)
  const style = {
    '--context-percent': `${percent}%`,
    '--context-current-percent': `${currentContextPercent}%`,
    '--context-reserve-percent': `${reservePercent}%`,
    '--context-threshold-percent': `${thresholdPercent}%`
  } as CSSProperties
  const totalLabel = status ? t('chat.context_input_usage', {
    used: tokenCountLabel(currentWindowTokens),
    capacity: tokenCountLabel(limits.inputCapacityTokens),
    percent
  }) : t('common.loading')
  const tokenDetail = (tokens: number): string => {
    const ratio = limits.inputCapacityTokens > 0
      ? tokens / limits.inputCapacityTokens * 100
      : 0
    const ratioLabel = ratio > 0 && ratio < 0.1 ? '<0.1%' : `${ratio.toFixed(1)}%`
    return `≈ ${tokenCountLabel(tokens)} · ${ratioLabel}`
  }
  const systemRows = status ? [
    [t('chat.context_profile'), status.breakdown.profileTokens],
    [t('chat.context_system_instructions'), status.breakdown.systemInstructionTokens],
    [t('chat.context_runtime_environment'), status.breakdown.runtimeContextTokens],
    [t('chat.context_workspace'), status.breakdown.workspaceTokens],
    [t('chat.context_memory'), status.breakdown.memoryTokens],
    [t('chat.context_skills'), status.breakdown.skillTokens],
    [t('chat.context_tool_definitions'), status.breakdown.toolDefinitionTokens]
  ] as const : []
  const conversationTokens = status ? status.breakdown.messageTokens + status.breakdown.attachmentTokens : 0
  const serverInputDetailRows = status?.serverUsage
    ? [
        [t('chat.context_cache_read'), status.serverUsage.inputTokenDetails?.cacheReadTokens],
        [t('chat.context_cache_creation'), status.serverUsage.inputTokenDetails?.cacheCreationTokens]
      ] as const
    : []

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <NoFocusButton
          className={status?.compressionApplied ? 'context-meter compressed' : 'context-meter'}
          style={style}
          type="button"
          aria-label={`${t('chat.context_window_title')}: ${totalLabel}`}
          aria-busy={!status}
        >
          <span className="context-meter-pie" aria-hidden="true" />
        </NoFocusButton>
      </Popover.Trigger>
      <Popover.Portal>
        <PopoverContent
          className="context-meter-popover ui-popover"
          side="top"
          align="end"
          sideOffset={UI_POPOVER_SIDE_OFFSET}
          collisionPadding={UI_POPOVER_COLLISION_PADDING}
          style={style}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <span className="context-meter-heading">{t('chat.context_window')}</span>
          <strong className="context-meter-total">{totalLabel}</strong>
          <div className="context-meter-bar" aria-hidden="true">
            <span className="context-meter-bar-used" />
            <span className="context-meter-bar-reserve" />
            {limits.compressionEnabled && <span className="context-meter-bar-threshold" />}
          </div>
          <div className="context-meter-row">
            <span>{t('chat.context_model_window')}</span>
            <span>{tokenCountLabel(limits.maxContextTokens)}</span>
          </div>
          <div className="context-meter-row">
            <span>{t('chat.context_input_capacity')}</span>
            <span>{tokenCountLabel(limits.inputCapacityTokens)}</span>
          </div>
          <div className="context-meter-row">
            <span>{t('chat.context_response_reserve')}</span>
            <span>{tokenCountLabel(limits.maxOutputTokens)}</span>
          </div>
          <div className="context-meter-row">
            <span>{t('chat.context_auto_compress_at')}</span>
            {limits.compressionEnabled
              ? (
                  <span>
                    {tokenCountLabel(limits.compressionThresholdTokens)}
                    {' · '}
                    {Number(compressionPercent.toFixed(1))}%
                  </span>
                )
              : <span>{t('common.off')}</span>}
          </div>
          {status?.serverUsage && (
            <details className="context-meter-disclosure">
              <summary>
                <span className="context-meter-disclosure-label">
                  <Cloud aria-hidden="true" size={13} />
                  <span>{t('chat.context_current_window')}</span>
                </span>
                <span className="context-meter-disclosure-value">
                  <span>{tokenCountLabel(status.serverUsage.totalTokens)}</span>
                  <ChevronRight aria-hidden="true" size={13} />
                </span>
              </summary>
              <div className="context-meter-details">
                <div className="context-meter-row">
                  <span>{t('chat.context_input_tokens')}</span>
                  <span>{tokenCountLabel(status.serverUsage.inputTokens)}</span>
                </div>
                {serverInputDetailRows
                  .filter(([, tokens]) => tokens !== undefined)
                  .map(([label, tokens]) => (
                  <div className="context-meter-row context-meter-subrow" key={label}>
                    <span>{label}</span>
                    <span>{tokenCountLabel(tokens ?? 0)}</span>
                  </div>
                ))}
                <div className="context-meter-row">
                  <span>{t('chat.context_output_tokens')}</span>
                  <span>{tokenCountLabel(status.serverUsage.outputTokens)}</span>
                </div>
                {status.serverUsage.outputTokenDetails?.reasoningTokens !== undefined && (
                  <div className="context-meter-row context-meter-subrow">
                    <span>{t('chat.context_reasoning_tokens')}</span>
                    <span>
                      {tokenCountLabel(status.serverUsage.outputTokenDetails.reasoningTokens)}
                    </span>
                  </div>
                )}
              </div>
            </details>
          )}
          {status && <details className="context-meter-disclosure">
            <summary>
              <span className="context-meter-disclosure-label">
                <Calculator aria-hidden="true" size={13} />
                <span>{t('chat.context_local_estimate')}</span>
              </span>
              <span className="context-meter-disclosure-value">
                <span>≈ {tokenCountLabel(status.estimatedInputTokens)}</span>
                <ChevronRight aria-hidden="true" size={13} />
              </span>
            </summary>
            <div className="context-meter-details">
              {systemRows.filter(([, tokens]) => tokens > 0).map(([label, tokens]) => (
                <div className="context-meter-row" key={label}>
                  <span>{label}</span>
                  <span>{tokenDetail(tokens)}</span>
                </div>
              ))}
              <div className="context-meter-row">
                <span>{t('chat.context_conversation_group')}</span>
                <span>{tokenDetail(conversationTokens)}</span>
              </div>
              {status.breakdown.attachmentTokens > 0 && (
                <div className="context-meter-row">
                  <span>{t('chat.context_attachments')}</span>
                  <span>{tokenDetail(status.breakdown.attachmentTokens)}</span>
                </div>
              )}
            </div>
          </details>}
          <Popover.Close asChild>
            <NoFocusButton
              className="ui-button ui-button-compact context-compress-button"
              type="button"
              disabled={disabled || !status}
              onClick={() => void onCompress()}
            >
              {compressionBusy
                ? t('chat.context_compressing')
                : t('chat.compress_context_now')}
            </NoFocusButton>
          </Popover.Close>
        </PopoverContent>
      </Popover.Portal>
    </Popover.Root>
  )
}
