import { CornerDownRight, CornerUpLeft, LoaderCircle, Paperclip, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentRunActivity } from '@shared/agentTypes'
import type { QueuedAgentMessage } from '../agent/useQueuedAgentMessages'
import { NoFocusButton } from '../NoFocusButton'

interface ComposerQueuedMessagesProps {
  messages: QueuedAgentMessage[]
  run?: Pick<AgentRunActivity, 'runId' | 'operation' | 'status'>
  onRemove(message: QueuedAgentMessage): void | Promise<unknown>
  onRetry(message: QueuedAgentMessage): void | Promise<unknown>
  onSteer(message: QueuedAgentMessage, runId: string): void | Promise<unknown>
}

export function ComposerQueuedMessages({
  messages,
  run,
  onRemove,
  onRetry,
  onSteer
}: ComposerQueuedMessagesProps) {
  const { t } = useTranslation()
  const listRef = useRef<HTMLDivElement>(null)
  const followingRef = useRef(true)
  const latestId = messages.at(-1)?.id
  const queueThreadId = messages[0]?.threadId

  useEffect(() => {
    followingRef.current = true
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [queueThreadId])

  useEffect(() => {
    const list = listRef.current
    if (!list || !followingRef.current) return
    list.scrollTop = list.scrollHeight
  }, [latestId])

  if (messages.length === 0) return null
  const steerableRunId = run?.operation === 'agent' && run.status === 'running'
    ? run.runId
    : undefined

  return (
    <section className="composer-queue" aria-label={t('chat.queued_messages')}>
      <div
        className="composer-queue-list"
        ref={listRef}
        role="list"
        onScroll={(event) => {
          const list = event.currentTarget
          followingRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 20
        }}
      >
        {messages.map((message) => (
          <div className="composer-queue-item" key={message.id} role="listitem">
            <CornerDownRight className="composer-queue-item-icon" size={15} aria-hidden="true" />
            <div className="composer-queue-item-content">
              <span className="composer-queue-item-text ui-truncate" data-tooltip={message.displayText}>
                {message.displayText}
              </span>
              {message.attachments.length > 0 && (
                <span
                  className="composer-queue-item-attachments ui-truncate"
                  data-tooltip={message.attachments.map((attachment) => attachment.name).join('\n')}
                >
                  <Paperclip size={12} aria-hidden="true" />
                  {message.attachments.map((attachment) => attachment.name).join(' · ')}
                </span>
              )}
            </div>
            <div className="composer-queue-item-actions">
              {message.status === 'direction_pending'
                ? (
                    <span className="composer-queue-status">
                      <CornerUpLeft size={14} aria-hidden="true" />
                      {t('chat.queued_direction_pending')}
                    </span>
                  )
                : message.status === 'dispatching'
                  ? (
                      <span className="composer-queue-status">
                        <LoaderCircle className="agent-spin" size={14} aria-hidden="true" />
                        {t('chat.queued_dispatching')}
                      </span>
                    )
                  : message.status === 'failed'
                    ? (
                        <NoFocusButton
                          className="composer-queue-retry"
                          type="button"
                          data-tooltip={message.error}
                          onClick={() => void onRetry(message)}
                        >
                          <RotateCcw size={14} aria-hidden="true" />
                          {t('chat.retry_queued_message')}
                        </NoFocusButton>
                      )
                  : (
                      <NoFocusButton
                        className="composer-queue-steer"
                        type="button"
                        disabled={!steerableRunId}
                        onClick={() => steerableRunId && void onSteer(message, steerableRunId)}
                      >
                        <CornerUpLeft size={14} aria-hidden="true" />
                        {t('chat.queued_direction')}
                      </NoFocusButton>
                    )}
              <NoFocusButton
                className="composer-queue-remove ui-tool-button"
                type="button"
                aria-label={t('chat.remove_queued_message')}
                disabled={message.status === 'dispatching'}
                onClick={() => void onRemove(message)}
              >
                <Trash2 size={14} />
              </NoFocusButton>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
