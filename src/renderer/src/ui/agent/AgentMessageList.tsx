import {
  Activity,
  AudioLines,
  Brain,
  Braces,
  Check,
  ChevronRight,
  ChevronUp,
  CircleCheck,
  Copy,
  FileText,
  FileDiff,
  Globe,
  Image as ImageIcon,
  Info,
  LoaderCircle,
  Pencil,
  RotateCcw,
  ShieldAlert,
  Terminal,
  Trash2,
  Wrench
} from 'lucide-react'
import { Fragment, memo, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { NoFocusButton } from '../NoFocusButton'
import type {
  AgentContentBlock,
  AgentContextSummary,
  AgentMessage,
  AgentRunActivity,
  AgentToolCall
} from '@shared/agentTypes'
import { isCommandShellToolName } from '@shared/commandShell'
import {
  delegationToolForSubagent,
  subagentDescription,
  toolArgumentSummary,
  visibleToolsForAgent
} from '@shared/agentActivity'
import {
  projectRunActivityItems,
  projectTurnTimeline,
  type TurnTimelineActivityItem,
  type TurnTimelineActivityRange,
  type TurnTimelineCleanupItem
} from '@shared/agentTimeline'
import type { SelectedAttachment } from '@shared/types'
import { AttachmentGrid } from '../chat/AttachmentGrid'
import { ScrollBoundaryControls, useScrollBoundaryNavigation } from '../chat/ScrollBoundaryNavigation'
import { MarkdownText } from '../chat/MarkdownText'
import { ImageLightbox } from '../chat/ImageLightbox'
import { toolResultImages } from './toolResultImages'
import { CodeReviewResult } from './CodeReviewResult'
import {
  AgentSubagentActivityTrigger,
  AgentSubagentStatusIcon,
  subagentStatusLabel
} from './AgentSubagentActivityDock'
import type { AgentRunView } from './useAgentWorkspace'
import type { AgentSpeechState } from '../speech/useAgentSpeech'
import { notice } from '../notice'
import { MessagePaginationCoordinator, runMessagePagination } from './messagePagination'
import { localizeAgentError } from './agentErrorMessage'
import { usePanelDisclosure, usePanelRef, usePanelScroll } from './PanelViewState'

interface AgentMessageListProps {
  onOpenChanges?(runId: string): void
  title: string
  navigationKey?: string
  messages: AgentMessage[]
  activities: AgentRunActivity[]
  run?: AgentRunView
  panelRef: RefObject<HTMLElement | null>
  followOutputRef: RefObject<boolean>
  error?: string
  speech: AgentSpeechState
  earlierMessageCount?: number
  onOpenSubagent?(runId: string, subagentId: string): void
  onDeleteRound?(userMessageId: string): void
  onEditUserMessage?(message: AgentMessage): void
  onRegenerate?(userMessageId: string, action: 'regenerate' | 'resend'): void
  onLoadEarlier?(request: { threadId: string; signal: AbortSignal }): void | Promise<void>
  onLoadEarlierActivities?(request: EarlierActivityRequest): void | Promise<void>
  onLoadEarlierError?(threadId: string, error: string): void
  onSpeak(messageId: string, text: string): void | Promise<void>
}

export interface EarlierActivityRequest { threadId: string; runId: string; signal: AbortSignal }

function EarlierActivitiesButton({ activity, threadId, panelRef, onLoad, onError }: {
  activity: AgentRunActivity
  threadId?: string
  panelRef: RefObject<HTMLElement | null>
  onLoad?(request: EarlierActivityRequest): void | Promise<void>
  onError?(threadId: string, error: string): void
}) {
  const { t } = useTranslation()
  const [loading, setLoading] = useState(false)
  const coordinator = useRef(new MessagePaginationCoordinator())
  const threadRef = useRef(threadId)
  threadRef.current = threadId
  useEffect(() => {
    const current = coordinator.current
    current.invalidate()
    setLoading(false)
    return () => current.invalidate()
  }, [threadId, activity.runId])
  if (!activity.activityWindow?.hasEarlier || !threadId || !onLoad) return null
  const load = async () => {
    const panel = panelRef.current
    if (!panel || loading) return
    const request = coordinator.current.begin(threadId, panel)
    setLoading(true)
    try {
      await runMessagePagination({
        request, threadId, panel, currentThreadId: () => threadRef.current, currentPanel: () => panelRef.current,
        load: (signal) => onLoad({ threadId, runId: activity.runId, signal }),
        onError: (id, error) => onError?.(id, error), fallbackError: t('agent.load_earlier_activities_failed'),
        schedule: (callback) => window.requestAnimationFrame(callback)
      })
    } finally {
      if (request.isCurrent(threadRef.current, panelRef.current)) setLoading(false)
    }
  }
  return <NoFocusButton className="agent-load-earlier" type="button" disabled={loading} onClick={() => void load()}>
    {loading ? <LoaderCircle className="agent-spin" size={13} /> : <ChevronUp size={13} />}
    {t('agent.load_earlier_activities')}
  </NoFocusButton>
}

function textContent(content: AgentContentBlock[]): string {
  return content
    .filter((block): block is Extract<AgentContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

function formatMessageTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value

  const now = new Date()
  const pad = (part: number): string => String(part).padStart(2, '0')
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate()
  if (sameDay) return clock

  const day = `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  return date.getFullYear() === now.getFullYear()
    ? `${day} ${clock}`
    : `${date.getFullYear()}-${day} ${clock}`
}

export function formatCompactTokens(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) {
    const scaled = value / 1_000
    return `${scaled < 10 ? scaled.toFixed(1).replace(/\.0$/, '') : Math.round(scaled)}k`
  }
  const scaled = value / 1_000_000
  return `${scaled < 10 ? scaled.toFixed(1).replace(/\.0$/, '') : Math.round(scaled)}m`
}

export function messageRetryAction(role: 'assistant' | 'user'): 'regenerate' | 'resend' {
  return role === 'user' ? 'resend' : 'regenerate'
}

function imageAttachments(content: AgentContentBlock[]): SelectedAttachment[] {
  return content.flatMap((block, index) => {
    if (block.type !== 'image') return []
    const mimeType = block.mimeType ?? 'image/png'
    const path = block.path ?? ''
    const name = path.split(/[\\/]/).pop() || `image-${index + 1}`
    return [{
      path,
      name,
      size: block.data ? Math.floor(block.data.length * 0.75) : 0,
      kind: 'image' as const,
      mimeType,
      contextPolicy: 'one_turn' as const,
      dataUri: block.data ? `data:${mimeType};base64,${block.data}` : undefined,
      url: block.url
    }]
  })
}

function ContentBlocks({ message }: { message: AgentMessage }) {
  const { t } = useTranslation()
  const text = textContent(message.content)
  const archivedAttachments: SelectedAttachment[] = (message.attachments ?? []).map(
    (attachment) => ({
      path: attachment.path,
      name: attachment.name,
      size: attachment.size,
      kind: attachment.kind,
      mimeType: attachment.mimeType,
      contextPolicy: attachment.contextPolicy,
      truncated: attachment.textTruncated,
      skippedReason: attachment.available
        ? undefined
        : t('chat.attachment_file_unavailable')
    })
  )
  const attachments = archivedAttachments.length > 0
    ? archivedAttachments
    : imageAttachments(message.content)
  const media = message.content.filter(
    (block) => block.type !== 'text' && block.type !== 'reasoning' && block.type !== 'image'
  )

  return (
    <>
      {message.codeReview ? <CodeReviewResult review={message.codeReview} /> : text && (message.role === 'assistant'
        ? <MarkdownText text={text} />
        : <p data-native-context-menu="text">{text}</p>)}
      <AttachmentGrid attachments={attachments} mode="message" />
      {media.map((block, index) => {
        if (block.type === 'file') {
          return (
            <div className="agent-file" key={index}>
              <FileText size={15} />
              <span>{block.name || t('agent.file')}</span>
            </div>
          )
        }
        return (
          <details className="agent-json" key={index}>
            <summary tabIndex={-1} onMouseDown={(event) => event.preventDefault()}>{t('agent.data')}</summary>
            <div className="native-context-menu-text" data-native-context-menu="text">
              <pre>{JSON.stringify(block.value, null, 2)}</pre>
            </div>
          </details>
        )
      })}
    </>
  )
}

function MessageItem({
  message,
  roundUserMessageId,
  actionsDisabled,
  speech,
  onDeleteRound,
  onEditUserMessage,
  onRegenerate,
  onSpeak,
  onOpenChanges
}: {
  onOpenChanges?(runId: string): void
  message: AgentMessage
  roundUserMessageId?: string
  actionsDisabled: boolean
  speech: AgentSpeechState
  onDeleteRound?(userMessageId: string): void
  onEditUserMessage?(message: AgentMessage): void
  onRegenerate?(userMessageId: string, action: 'regenerate' | 'resend'): void
  onSpeak(messageId: string, text: string): void | Promise<void>
}) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const copyResetRef = useRef<number | undefined>(undefined)
  useEffect(() => () => {
    if (copyResetRef.current !== undefined) window.clearTimeout(copyResetRef.current)
  }, [])
  const copyMessage = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(textContent(message.content))
      setCopied(true)
      notice.success(t('chat.message_copied'))
      if (copyResetRef.current !== undefined) window.clearTimeout(copyResetRef.current)
      copyResetRef.current = window.setTimeout(() => setCopied(false), 1400)
    } catch {
      notice.error(t('chat.failed_copy_message'))
    }
  }
  if (message.role === 'system') return null
  if (message.role === 'tool') return null
  const retryAction = messageRetryAction(message.role)
  const text = textContent(message.content)
  const canEdit = message.role === 'user' && Boolean(text && onEditUserMessage)
  const canRegenerate = Boolean(roundUserMessageId && onRegenerate)
  const canSpeak = message.role === 'assistant' && Boolean(text)
  const canCopy = Boolean(text)
  const canDelete = Boolean(roundUserMessageId && onDeleteRound)
  const canShowChanges = Boolean(message.runId && onOpenChanges)
  const hasActions = canEdit || canRegenerate || canSpeak || canCopy || canDelete || canShowChanges
  const regenerateLabel = message.role === 'user'
    ? t('common.resend')
    : t('common.regenerate')
  const speechActive = speech.messageId === message.id
    && (speech.status === 'generating' || speech.status === 'playing')
  const speechError = speech.messageId === message.id && speech.status === 'error'
  const speechLabel = speechActive
    ? t('agent.stop_speech')
    : speechError
      ? speech.error ?? t('speech.generation_failed')
      : t('agent.read_aloud')
  return (
    <div className={`message-sequence ${message.role}`} data-message-id={message.id}>
      <article className={`message-row ${message.role}`}>
        <div className="bubble ui-surface">
          <ContentBlocks message={message} />
          {(hasActions || message.createdAt) && (
            <div className="message-meta">
              {hasActions && (
                <div className="message-actions">
                  {canShowChanges && <NoFocusButton className="ui-tool-button ui-tool-button-muted" type="button"
                    aria-label={t('agent.recorded_changes')} data-tooltip={t('agent.recorded_changes')}
                    onClick={() => onOpenChanges?.(message.runId!)}><FileDiff size={16} /></NoFocusButton>}
                  {canEdit && onEditUserMessage && (
                    <NoFocusButton
                      className="ui-tool-button ui-tool-button-muted"
                      type="button"
                      disabled={actionsDisabled}
                      aria-label={t('common.edit')}
                      data-tooltip={t('common.edit')}
                      onClick={() => onEditUserMessage(message)}
                    >
                      <Pencil size={15} />
                    </NoFocusButton>
                  )}
                  {canCopy && (
                    <NoFocusButton
                      className="ui-tool-button ui-tool-button-muted"
                      type="button"
                      aria-label={t('common.copy')}
                      data-tooltip={copied ? t('chat.message_copied') : t('common.copy')}
                      onClick={() => void copyMessage()}
                    >
                      {copied ? <Check size={16} /> : <Copy size={16} />}
                    </NoFocusButton>
                  )}
                  {message.role === 'assistant' && (
                    <NoFocusButton
                      className={[
                        'ui-tool-button ui-tool-button-muted',
                        speechActive ? 'active' : '',
                        speechError ? 'error' : ''
                      ].filter(Boolean).join(' ')}
                      type="button"
                      aria-label={speechLabel}
                      data-tooltip={speechLabel}
                      onClick={() => void onSpeak(message.id, text)}
                    >
                      <AudioLines size={16} />
                    </NoFocusButton>
                  )}
                  {canRegenerate && roundUserMessageId && onRegenerate && (
                    <NoFocusButton
                      className="ui-tool-button ui-tool-button-muted"
                      type="button"
                      disabled={actionsDisabled}
                      aria-label={regenerateLabel}
                      data-tooltip={regenerateLabel}
                      onClick={() => onRegenerate(
                        roundUserMessageId,
                        retryAction
                      )}
                    >
                      <RotateCcw size={16} />
                    </NoFocusButton>
                  )}
                  {canDelete && roundUserMessageId && onDeleteRound && (
                    <NoFocusButton
                      className="ui-tool-button ui-tool-button-muted"
                      type="button"
                      disabled={actionsDisabled}
                      aria-label={t('common.delete')}
                      data-tooltip={t('common.delete')}
                      onClick={() => onDeleteRound(roundUserMessageId)}
                    >
                      <Trash2 size={16} />
                    </NoFocusButton>
                  )}
                </div>
              )}
              {message.createdAt && (
                <time dateTime={message.createdAt}>{formatMessageTime(message.createdAt)}</time>
              )}
            </div>
          )}
        </div>
      </article>
    </div>
  )
}

function ContextSummaryItem({
  summary,
  number
}: {
  summary: AgentContextSummary
  number: number
}) {
  const tokenLabel = summary.inputTokensBefore !== undefined && summary.inputTokensAfter !== undefined
    ? `≈ ${formatCompactTokens(summary.inputTokensBefore)} → ${formatCompactTokens(summary.inputTokensAfter)} tokens`
    : undefined
  return (
    <div className="agent-context-summary-row">
      <details className="agent-context-summary" open={summary.status === 'running' || undefined}>
        <summary tabIndex={-1} onMouseDown={(event) => event.preventDefault()}>
          {summary.status === 'running'
            ? <LoaderCircle className="agent-spin" size={13} />
            : <Check size={13} />}
          <span>
            {summary.status === 'running'
              ? 'Compressing context'
              : `Context compressed #${number}`}
          </span>
          {tokenLabel && <small>· {tokenLabel}</small>}
          <time dateTime={summary.createdAt}>· {formatMessageTime(summary.createdAt)}</time>
        </summary>
        {summary.summaryText && <MarkdownText text={summary.summaryText} compact />}
      </details>
    </div>
  )
}

function formatTraceValue(value: unknown): string {
  if (value === undefined) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function reasoningTitleSummary(reasoning: string, summary: string | undefined): string | undefined {
  const compactSummary = summary?.replace(/\s+/g, ' ').trim()
  if (!compactSummary) return undefined
  const compactReasoning = reasoning.replace(/\s+/g, ' ').trim()
  return compactSummary === compactReasoning ? '...' : compactSummary
}

function ActivityDisclosure({
  stateKey,
  icon,
  label,
  text = '',
  defaultOpen = false,
  className = '',
  bodyClassName = '',
  statusIndicator,
  summaryActions,
  children,
  disabled = false,
  renderWhenEmpty = false
}: {
  stateKey: string
  icon: ReactNode
  label: ReactNode
  text?: string
  defaultOpen?: boolean
  className?: string
  bodyClassName?: string
  statusIndicator?: ReactNode
  summaryActions?: ReactNode
  children?: ReactNode | (() => ReactNode)
  disabled?: boolean
  renderWhenEmpty?: boolean
}) {
  const lazy = typeof children === 'function'
  const disclosure = usePanelDisclosure(stateKey, defaultOpen, lazy)
  if (!renderWhenEmpty && !text.trim() && !children) return null
  const body = (
    <>
      {text.trim() && (
        <div className="native-context-menu-text" data-native-context-menu="text">
          <pre>{text}</pre>
        </div>
      )}
      {lazy ? !disabled && disclosure.open && children() : children}
    </>
  )
  return (
    <details
      className={`agent-activity-disclosure ${className}`.trim()}
      {...disclosure}
      open={disabled ? false : disclosure.open}
    >
      <summary
        tabIndex={-1}
        aria-disabled={disabled || undefined}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => { if (disabled) event.preventDefault() }}
        onKeyDown={(event) => {
          if (disabled && (event.key === 'Enter' || event.key === ' ')) event.preventDefault()
        }}
      >
        <span className="agent-activity-summary-content">
          <span className="agent-activity-summary-icon">{icon}</span>
          <span className="agent-activity-summary-label">{label}</span>
          {statusIndicator && (
            <span className="agent-activity-summary-status">{statusIndicator}</span>
          )}
        </span>
        {!disabled && <ChevronRight className="agent-activity-disclosure-chevron" size={13} />}
        {summaryActions}
      </summary>
      {bodyClassName ? <div className={bodyClassName}>{body}</div> : body}
    </details>
  )
}

interface ToolPresentation {
  icon: ReactNode
  title: string
  codeTitle?: boolean
  showArgumentSummary?: boolean
}

function BackgroundCleanupDisclosure({ entry }: { entry: TurnTimelineCleanupItem }) {
  const { t } = useTranslation()
  const { cleanup } = entry
  const label = cleanup.status === 'completed' ? 'agent.background_cleanup_completed'
    : cleanup.status === 'unconfirmed' ? 'agent.background_cleanup_unconfirmed' : 'agent.background_cleanup'
  return (
    <ActivityDisclosure
      stateKey={entry.key}
      icon={<Info size={13} />}
      label={t(label)}
      statusIndicator={cleanup.status === 'running'
        ? <LoaderCircle className="agent-spin" size={13} role="status" aria-label={t('agent.background_cleanup_started')} />
        : undefined}
    >
      {() => <ToolTraceBody value={localizeAgentError(cleanup.report, t)} />}
    </ActivityDisclosure>
  )
}

function specialToolPresentation(call: AgentToolCall): ToolPresentation | undefined {
  if (isCommandShellToolName(call.name)) {
    return {
      icon: <Terminal size={13} />,
      title: call.name,
      codeTitle: true,
      showArgumentSummary: true
    }
  }
  switch (call.name.toLowerCase()) {
    case 'http_request':
      return {
        icon: <Globe size={13} />,
        title: call.name,
        codeTitle: true,
        showArgumentSummary: true
      }
    default:
      return undefined
  }
}

function toolPresentation(call: AgentToolCall): ToolPresentation {
  return specialToolPresentation(call) ?? {
    icon: <Wrench size={13} />,
    title: call.name,
    codeTitle: true,
    showArgumentSummary: true
  }
}

const ToolTraceBody = memo(function ToolTraceBody({ value }: { value: unknown }) {
  const text = useMemo(() => formatTraceValue(value), [value])
  return <div className="native-context-menu-text" data-native-context-menu="text"><pre>{text}</pre></div>
})

function ToolResultDisclosure({ tool }: { tool: AgentRunActivity['tools'][number] }) {
  const { t } = useTranslation()
  const images = useMemo(() => toolResultImages(tool.output), [tool.output])
  const [imageIndex, setImageIndex] = useState<number>()
  const imageLabel = (index: number) => t('agent.view_tool_image', { index: index + 1 })
  return (
    <>
      <ActivityDisclosure
        stateKey={`result:${tool.call.id}`}
        className="agent-activity-result"
        icon={<CircleCheck size={13} />}
        label="result"
        renderWhenEmpty
        summaryActions={images.length > 0 && (
          <span className="ui-toolbar">
            {images.map((_, index) => (
              <button
                key={index}
                type="button"
                className="ui-icon-button ui-icon-button-xs"
                aria-label={imageLabel(index)}
                data-tooltip={imageLabel(index)}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  setImageIndex(index)
                }}
              >
                <ImageIcon size={13} />
              </button>
            ))}
          </span>
        )}
      >
        {() => <ToolTraceBody value={tool.output} />}
      </ActivityDisclosure>
      {imageIndex !== undefined && (
        <ImageLightbox
          open
          index={imageIndex}
          slides={images.map((src, index) => ({ src, alt: imageLabel(index) }))}
          onView={setImageIndex}
          onClose={() => setImageIndex(undefined)}
        />
      )}
    </>
  )
}

function ToolActivityDisclosure({
  tool,
  progress
}: {
  tool: AgentRunActivity['tools'][number]
  progress?: import('@shared/agentTypes').AgentToolCallProgress
}) {
  const { t } = useTranslation()
  const presentation = toolPresentation(tool.call)
  const summary = toolArgumentSummary(tool.call.args)
  const duration = activityDuration(tool.startedAt, tool.completedAt)
  const waitingForApproval = tool.approval?.status === 'pending_approval'
  return (
    <ActivityDisclosure
      stateKey={`tool:${tool.call.id}`}
      className="agent-activity-tool"
      bodyClassName="agent-activity-tool-body"
      disabled={Boolean(progress)}
      icon={presentation.icon}
      statusIndicator={waitingForApproval
        ? <ShieldAlert size={13} />
        : tool.status === 'running'
          ? <LoaderCircle className="agent-spin" size={13} />
          : undefined}
      label={(
        <>
          {!presentation.title ? <span>{t('agent.tool_call')}</span> : presentation.codeTitle
            ? <code>{presentation.title}</code>
            : <span>{presentation.title}</span>}
          {presentation.showArgumentSummary && summary && (
            <span className="agent-activity-argument">{summary}</span>
          )}
          {duration && <small>· {duration}</small>}
          {progress && <small>· {t(progress.complete ? 'agent.tool_arguments_ready' : 'agent.tool_arguments_generating', { count: progress.characterCount })}</small>}
        </>
      )}
      renderWhenEmpty
    >
      {() => (
        <>
          {tool.call.args !== undefined && (
            <ActivityDisclosure
              stateKey={`arguments:${tool.call.id}`}
              className="agent-activity-arguments"
              icon={<Braces size={13} />}
              label="arguments"
            >
              {() => <ToolTraceBody value={tool.call.args} />}
            </ActivityDisclosure>
          )}
          {tool.status === 'completed' && <ToolResultDisclosure tool={tool} />}
        </>
      )}
    </ActivityDisclosure>
  )
}

type SubagentTimelineItem = Extract<TurnTimelineActivityItem, { type: 'subagent' }>
type TimelineRenderItem = Exclude<TurnTimelineActivityItem, SubagentTimelineItem> | {
  type: 'subagent-group'
  key: string
  items: SubagentTimelineItem[]
}

function groupAdjacentSubagents(items: TurnTimelineActivityItem[]): TimelineRenderItem[] {
  const grouped: TimelineRenderItem[] = []
  for (const item of items) {
    if (item.type !== 'subagent') {
      grouped.push(item)
      continue
    }
    const previous = grouped.at(-1)
    if (previous?.type === 'subagent-group') {
      previous.items.push(item)
    } else {
      grouped.push({ type: 'subagent-group', key: `subagents:${item.key}`, items: [item] })
    }
  }
  return grouped
}

function ActivityTimelineItems({
  run,
  items,
  onOpenSubagent
}: {
  run: AgentRunActivity
  items: TurnTimelineActivityItem[]
  onOpenSubagent?(runId: string, subagentId: string): void
}) {
  const { t } = useTranslation()
  return (
    <section className="agent-activity-timeline">
      {groupAdjacentSubagents(items).map((item) => {
        if (item.type === 'model') {
          const duration = activityDuration(item.model.startedAt, item.model.completedAt)
          const reasoningSummary = reasoningTitleSummary(
            item.model.reasoning,
            item.model.reasoningSummary
          )
          return (
            <Fragment key={item.key}>
              <section className="agent-activity-model">
                <header>
                  <span>{item.round === undefined ? 'round' : `round ${item.round}`}</span>
                  {duration && <small>· {duration}</small>}
                  {item.model.status === 'running' && (
                    <LoaderCircle className="agent-spin" size={13} />
                  )}
                </header>
                {item.model.reasoning && (
                  <ActivityDisclosure
                    stateKey={`reasoning:${item.model.id}`}
                    className="agent-activity-reasoning"
                    defaultOpen={item.model.status === 'running'}
                    icon={<Brain size={13} />}
                    label={reasoningSummary
                      ? (
                          <>
                            <span>reasoning</span>
                            <span className="agent-activity-argument">
                              {reasoningSummary}
                            </span>
                          </>
                        )
                      : 'reasoning'}
                    text={item.model.reasoning}
                  />
                )}
              </section>
              {item.showText && item.model.text.trim() && (
                <div className="message-sequence assistant agent-activity-model-message">
                  <article className="message-row assistant">
                    <div className="bubble ui-surface">
                      <MarkdownText text={item.model.text} />
                    </div>
                  </article>
                </div>
              )}
            </Fragment>
          )
        }
        if (item.type === 'tool') {
          return (
            <ToolActivityDisclosure
              key={item.key}
              tool={item.tool}
              progress={item.progress}
            />
          )
        }
        if (item.type === 'direction') {
          return (
            <div
              className="message-sequence user agent-activity-direction-message"
              data-message-id={item.message.id}
              key={item.key}
            >
              <article className="message-row user">
                <div className="bubble ui-surface">
                  <ContentBlocks message={item.message} />
                </div>
              </article>
            </div>
          )
        }
        if (item.type === 'subagent-group') {
          return (
            <div className="agent-activity-subagent-group" key={item.key}>
              {item.items.map((entry) => (
                <AgentSubagentActivityTrigger
                  key={entry.key}
                  run={run}
                  subagentId={entry.subagent.id}
                  variant="labeled"
                  onOpenSubagent={(runId, subagentId) => onOpenSubagent?.(runId, subagentId)}
                />
              ))}
            </div>
          )
        }
        if (item.type === 'summary') {
          return <ContextSummaryItem key={item.key} summary={item.summary} number={item.number} />
        }
        if (item.type === 'skill') {
          return (
            <ActivityDisclosure
              stateKey={item.key}
              className="agent-activity-input agent-activity-skill-input"
              key={item.key}
              icon={<FileText size={13} />}
              label={`/${item.invocation.name}${item.invocation.args ? ` ${item.invocation.args}` : ''}`}
              text={item.invocation.promptText}
            />
          )
        }
        if (item.type === 'memory') {
          const label = [
            t('agent.memory_recall', { count: item.recall.memoryCount }),
            item.recall.agentName
          ].filter(Boolean).join(' · ')
          return (
            <ActivityDisclosure
              stateKey={item.key}
              className="agent-activity-input agent-activity-memory-recall"
              key={item.key}
              icon={<Brain size={13} />}
              label={label}
              text={item.recall.promptText}
            />
          )
        }
        return null
      })}
    </section>
  )
}

export function AgentSubagentPanel({
  run,
  subagentId,
  onOpenSubagent,
  threadId,
  onLoadEarlierActivities,
  onLoadEarlierError,
  onLoadSubagentDetails
}: {
  run?: AgentRunActivity
  subagentId?: string
  onOpenSubagent?(runId: string, subagentId: string): void
  threadId?: string
  onLoadEarlierActivities?(request: EarlierActivityRequest): void | Promise<void>
  onLoadEarlierError?(threadId: string, error: string): void
  onLoadSubagentDetails?(threadId: string, runId: string, subagentId: string): Promise<void>
}) {
  const { t } = useTranslation()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const followOutputRef = usePanelRef('followOutput', true)
  const opened = usePanelRef('opened', false)
  const onScroll = usePanelScroll(panelRef, Boolean(run))
  const subagent = run?.subagents.find((item) => item.id === subagentId)
  const runId = run?.runId
  const deferredSubagentId = subagent?.detailsDeferred ? subagent.id : undefined
  const subagentStatus = subagent?.status
  const subagentCompletedAt = subagent?.completedAt
  const detailFailureRef = useRef({ onLoadEarlierError, t })
  detailFailureRef.current = { onLoadEarlierError, t }
  useEffect(() => {
    if (!threadId || !runId || !deferredSubagentId || !onLoadSubagentDetails) return
    let cancelled = false
    void onLoadSubagentDetails(threadId, runId, deferredSubagentId).catch(() => {
      if (!cancelled) detailFailureRef.current.onLoadEarlierError?.(threadId, detailFailureRef.current.t('agent.load_subagent_details_failed'))
    })
    return () => { cancelled = true }
  }, [threadId, runId, deferredSubagentId, subagentStatus, subagentCompletedAt, onLoadSubagentDetails])
  const open = Boolean(run && subagent)
  const navigation = useScrollBoundaryNavigation({
    contentRef,
    contentVersion: run,
    enabled: open,
    followOutputRef,
    panelRef,
    resetKey: subagentId
  })

  useEffect(() => {
    const panel = panelRef.current
    if (!open || !panel || opened.current) return
    opened.current = true
    followOutputRef.current = true
    const frame = window.requestAnimationFrame(() => {
      panel.scrollTop = panel.scrollHeight
    })
    return () => window.cancelAnimationFrame(frame)
  }, [open, subagentId, opened, followOutputRef])

  if (!run || !subagent) return null
  const delegationTool = delegationToolForSubagent(run, subagent)
  const summary = activitySummaryLabel(run, subagent.id, t)
  const description = subagentDescription(run, subagent)
  const resultText = formatTraceValue(subagent.result)
  const errorText = subagent.error ? localizeAgentError(subagent.error, t) : ''
  const recoveryError = Boolean(
    errorText
    && (subagent.status === 'running' || subagent.status === 'interrupted')
  )
  const displayedStatus = recoveryError
    ? 'Recovery error'
    : subagentStatusLabel(subagent.status)
  const items = projectRunActivityItems(run, new Map(), [], subagent.id)

  return (
    <section className="ui-detail-panel agent-subagent-panel">
          <header className="agent-subagent-panel-header">
            <div className="agent-subagent-panel-title">
              <AgentSubagentStatusIcon
                status={recoveryError ? 'failed' : subagent.status}
                size={14}
              />
              <h2 className="ui-dialog-title">{subagent.name}</h2>
              <small>· {displayedStatus} · {summary}</small>
            </div>
              <p className={description
                ? 'agent-subagent-panel-description'
                : 'ui-visually-hidden'}>
                {description ?? summary}
              </p>
          </header>
          <div className="scroll-boundary-frame agent-subagent-scroll-frame">
            <div
              className="agent-subagent-panel-body"
              role="region"
              aria-label={subagent.name}
              tabIndex={-1}
              ref={panelRef}
              onClickCapture={navigation.onClickCapture}
              onPointerDown={navigation.onPointerDown}
              onScroll={() => { navigation.onScroll(); onScroll() }}
              onTouchMove={navigation.onTouchMove}
              onTouchStart={navigation.onTouchStart}
              onWheel={navigation.onWheel}
            >
              <div ref={contentRef}>
                <EarlierActivitiesButton activity={run} threadId={threadId} panelRef={panelRef}
                  onLoad={onLoadEarlierActivities} onError={onLoadEarlierError} />
                {delegationTool && <ToolActivityDisclosure tool={delegationTool} />}
                <ActivityTimelineItems
                  run={run}
                  items={items}
                  onOpenSubagent={onOpenSubagent}
                />
                {subagent.detailsDeferred && <LoaderCircle className="agent-spin" size={14} aria-label={t('common.loading')} />}
                {subagent.status === 'completed' && !subagent.detailsDeferred && (
                  <ActivityDisclosure
                    stateKey="subagent-result"
                    className="agent-subagent-result"
                    icon={<CircleCheck size={13} />}
                    label="subagent result"
                    text={resultText}
                  />
                )}
                {errorText && (
                  <ActivityDisclosure
                    stateKey="subagent-error"
                    className="agent-subagent-result agent-subagent-error"
                    icon={<AgentSubagentStatusIcon status="failed" size={13} />}
                    label={recoveryError ? 'recovery error' : 'error'}
                    text={errorText}
                    renderWhenEmpty
                  />
                )}
              </div>
            </div>
            <ScrollBoundaryControls
              atBottom={navigation.boundaries.atBottom}
              atTop={navigation.boundaries.atTop}
              visible={navigation.showControls}
              onScrollToBottom={navigation.scrollToBottom}
              onScrollToTop={navigation.scrollToTop}
            />
          </div>
    </section>
  )
}

function activityCountLabel(
  count: number,
  singular: string
): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

function activitySummaryLabel(
  run: AgentRunActivity,
  agentId: string | undefined,
  t: ReturnType<typeof useTranslation>['t']
): string {
  const modelCount = agentId
    ? run.models.filter((model) => model.subagentId === agentId).length
    : run.models.length
  const toolCount = visibleToolsForAgent(run, agentId).length
  const subagentCount = agentId
    ? run.subagents.filter((subagent) => subagent.parentSubagentId === agentId).length
    : run.subagents.length
  const summary = [
    activityCountLabel(modelCount, 'model round'),
    activityCountLabel(toolCount, 'tool call'),
    ...(subagentCount > 0
      ? [activityCountLabel(subagentCount, 'subagent')]
      : [])
  ].join(' · ')
  return run.activityWindow?.hasEarlier
    ? t('agent.loaded_activity_summary', { summary })
    : summary
}

function rangeLabel(
  range: TurnTimelineActivityRange,
  t: ReturnType<typeof useTranslation>['t']
): string {
  if (range.run.status === 'failed') return t('agent.run_failed')
  if (range.run.status === 'cancelled') return t('agent.run_cancelled')
  if (range.run.status === 'interrupted') return t('agent.run_waiting_for_approval')
  if (range.run.status === 'completed' && !range.finalMessageId) {
    return t('agent.run_completed_without_reply')
  }
  if (range.run.status === 'running') {
    return range.run.models.length > 0
      ? t('agent.run_replying')
      : t('agent.run_preparing')
  }
  const summary = [
    activityCountLabel(range.modelCount, 'model round'),
    activityCountLabel(range.toolCount, 'tool call'),
    ...(range.subagentCount > 0
      ? [activityCountLabel(range.subagentCount, 'subagent')]
      : [])
  ].join(' · ')
  return range.run.activityWindow?.hasEarlier
    ? t('agent.loaded_activity_summary', { summary })
    : summary
}

function activityDuration(startedAt?: string, completedAt?: string): string | undefined {
  if (!startedAt || !completedAt) return undefined
  const milliseconds = Date.parse(completedAt) - Date.parse(startedAt)
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return undefined
  if (milliseconds < 1_000) return `${milliseconds} ms`
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`
}

function AgentActivityRange({
  range,
  onOpenSubagent,
  earlierActivities
}: {
  range: TurnTimelineActivityRange
  onOpenSubagent?(runId: string, subagentId: string): void
  earlierActivities?: ReactNode
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(range.startsExpanded)
  const previousStatusRef = useRef(range.run.status)
  const topToggleRef = useRef<HTMLButtonElement | null>(null)
  const summary = rangeLabel(range, t)
  const canCollapse = range.run.status !== 'running' && range.run.status !== 'interrupted'
  const statusChanged = previousStatusRef.current !== range.run.status
  const effectiveExpanded = canCollapse
    ? statusChanged ? range.startsExpanded : expanded
    : true

  useEffect(() => {
    const previousStatus = previousStatusRef.current
    previousStatusRef.current = range.run.status
    if (previousStatus !== range.run.status) setExpanded(range.startsExpanded)
  }, [range.run.status, range.startsExpanded])

  const collapseFromBottom = (): void => {
    setExpanded(false)
    window.requestAnimationFrame(() => {
      topToggleRef.current?.scrollIntoView({ block: 'nearest' })
    })
  }

  return (
    <section className={`agent-activity-range ${effectiveExpanded ? 'expanded' : 'collapsed'}`}>
      <div className="agent-activity-range-boundary agent-activity-range-boundary-top">
        {canCollapse
          ? (
              <NoFocusButton
                className="agent-activity-range-toggle"
                type="button"
                aria-expanded={effectiveExpanded}
                data-scroll-follow-toggle
                ref={topToggleRef}
                onClick={() => setExpanded((current) => !current)}
              >
                <Activity size={14} />
                <span>{summary}</span>
                <time dateTime={range.run.updatedAt}>{formatMessageTime(range.run.updatedAt)}</time>
                <ChevronRight className="agent-activity-range-chevron" size={13} />
              </NoFocusButton>
            )
          : (
              <div className="agent-activity-range-status">
                {range.run.status === 'running'
                  ? <LoaderCircle className="agent-spin" size={14} />
                  : <Activity size={14} />}
                <span>{summary}</span>
                <time dateTime={range.run.updatedAt}>{formatMessageTime(range.run.updatedAt)}</time>
              </div>
            )}
      </div>
      {effectiveExpanded && (
        <>
          {earlierActivities}
          <ActivityTimelineItems
            run={range.run}
            items={range.items}
            onOpenSubagent={onOpenSubagent}
          />
          {canCollapse && (
            <div className="agent-activity-range-boundary agent-activity-range-boundary-bottom">
              <NoFocusButton
                className="agent-activity-range-toggle agent-activity-range-collapse-button"
                type="button"
                aria-label={t('agent.collapse_activity')}
                data-scroll-follow-toggle
                data-tooltip={t('agent.collapse_activity')}
                onClick={collapseFromBottom}
              >
                <ChevronUp size={14} />
              </NoFocusButton>
            </div>
          )}
        </>
      )}
    </section>
  )
}

export function AgentMessageList({
  onOpenChanges,
  title,
  navigationKey,
  messages,
  activities,
  run,
  panelRef,
  followOutputRef,
  error,
  speech,
  earlierMessageCount = 0,
  onDeleteRound,
  onEditUserMessage,
  onRegenerate,
  onLoadEarlier,
  onLoadEarlierActivities,
  onLoadEarlierError,
  onOpenSubagent,
  onSpeak
}: AgentMessageListProps) {
  const { t } = useTranslation()
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const paginationRef = useRef(new MessagePaginationCoordinator())
  const navigationKeyRef = useRef(navigationKey)
  navigationKeyRef.current = navigationKey
  const navigation = useScrollBoundaryNavigation({
    contentRef,
    followOutputRef,
    followThreshold: 96,
    panelRef,
    resetKey: navigationKey
  })
  const timeline = projectTurnTimeline(messages, activities, run)
  const errorRenderedInTimeline = Boolean(error && timeline.entries.some((entry) =>
    entry.type === 'error' && entry.message === error
  ))

  useEffect(() => {
    const pagination = paginationRef.current
    pagination.invalidate()
    setLoadingEarlier(false)
    return () => pagination.invalidate()
  }, [navigationKey])

  const loadEarlier = async (): Promise<void> => {
    const threadId = navigationKey
    if (!onLoadEarlier || loadingEarlier || !threadId) return
    const panel = panelRef.current
    if (!panel) return
    const request = paginationRef.current.begin(threadId, panel)
    setLoadingEarlier(true)
    try {
      await runMessagePagination({
        request,
        threadId,
        panel,
        currentThreadId: () => navigationKeyRef.current,
        currentPanel: () => panelRef.current,
        load: (signal) => onLoadEarlier({ threadId, signal }),
        onError: (failedThreadId, error) => onLoadEarlierError?.(failedThreadId, error),
        fallbackError: t('agent.load_earlier_failed'),
        schedule: (callback) => window.requestAnimationFrame(callback)
      })
    } finally {
      if (request.isCurrent(navigationKeyRef.current, panelRef.current)) {
        setLoadingEarlier(false)
      }
    }
  }
  return (
    <div className="scroll-boundary-frame agent-message-scroll-frame">
      <section
        className="agent-message-panel workspace-content-scroll"
        aria-label={title}
        tabIndex={-1}
        ref={panelRef}
        onClickCapture={navigation.onClickCapture}
        onPointerDown={navigation.onPointerDown}
        onScroll={navigation.onScroll}
        onTouchMove={navigation.onTouchMove}
        onTouchStart={navigation.onTouchStart}
        onWheel={navigation.onWheel}
      >
        <div className="agent-message-content" ref={contentRef}>
          {earlierMessageCount > 0 && onLoadEarlier && (
            <NoFocusButton
              className="agent-load-earlier"
              type="button"
              disabled={loadingEarlier}
              onClick={() => void loadEarlier()}
            >
              {loadingEarlier
                ? <LoaderCircle className="agent-spin" size={13} />
                : <ChevronUp size={13} />}
              {t('agent.load_earlier_messages', { count: earlierMessageCount })}
            </NoFocusButton>
          )}
          {timeline.entries.map((entry) => {
            if (entry.type === 'error') {
              return <div className="agent-activity-error" role="alert" key={entry.key} data-native-context-menu="text">
                {localizeAgentError(entry.message, t)}
              </div>
            }
            if (entry.type === 'cleanup') {
              return <BackgroundCleanupDisclosure key={entry.key} entry={entry} />
            }
            if (entry.type === 'summary') {
              return <ContextSummaryItem key={entry.key} summary={entry.summary} number={entry.number} />
            }
            if (entry.type === 'activity-range') {
              return (
                <AgentActivityRange
                  key={entry.key}
                  range={entry}
                  onOpenSubagent={onOpenSubagent}
                  earlierActivities={<EarlierActivitiesButton activity={entry.run} threadId={navigationKey} panelRef={panelRef}
                    onLoad={onLoadEarlierActivities} onError={onLoadEarlierError} />}
                />
              )
            }
            return (
              <MessageItem
                key={entry.key}
                message={entry.message}
                roundUserMessageId={entry.roundUserMessageId}
                actionsDisabled={Boolean(run)}
                speech={speech}
                onDeleteRound={onDeleteRound}
                onEditUserMessage={onEditUserMessage}
                onRegenerate={onRegenerate}
                onSpeak={onSpeak}
                onOpenChanges={onOpenChanges}
              />
            )
          })}
          {error && !errorRenderedInTimeline && (
            <div className="thread-title error" data-native-context-menu="text">
              {localizeAgentError(error, t)}
            </div>
          )}
        </div>
      </section>
      <ScrollBoundaryControls
        atBottom={navigation.boundaries.atBottom}
        atTop={navigation.boundaries.atTop}
        visible={navigation.showControls}
        onScrollToBottom={navigation.scrollToBottom}
        onScrollToTop={navigation.scrollToTop}
      />
    </div>
  )
}
