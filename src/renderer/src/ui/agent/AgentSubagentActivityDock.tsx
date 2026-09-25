import { PopoverContent } from '../PopoverContent'
import * as Popover from '@radix-ui/react-popover'
import { Ban, Bot, CircleCheck, CircleX, LoaderCircle, ShieldAlert, Wrench } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentRunActivity, AgentSubagentActivityStatus } from '@shared/agentTypes'
import {
  subagentDescription,
  toolProvidedSummary,
  visibleToolsForAgent
} from '@shared/agentActivity'
import { NoFocusButton } from '../NoFocusButton'

interface AgentSubagentActivityDockProps {
  run?: AgentRunActivity
  onOpenSubagent(runId: string, subagentId: string): void
}

export function activeSubagentsForRun(run?: AgentRunActivity) {
  return (run?.subagents ?? [])
    .filter((subagent) => (
      subagent.status === 'running' || subagent.status === 'interrupted'
    ))
    .sort((left, right) => left.sequence - right.sequence)
}

export function subagentActivityDetails(run: AgentRunActivity, subagentId: string) {
  const models = run.models.filter((model) => model.subagentId === subagentId)
  const tools = visibleToolsForAgent(run, subagentId)
  const subagent = run.subagents.find((item) => item.id === subagentId)
  const childSubagents = run.subagents.filter(
    (subagent) => subagent.parentSubagentId === subagentId
  )
  const runningTools = tools
    .filter((tool) => tool.status === 'running')
    .sort((left, right) => right.sequence - left.sequence)
  const currentTool = runningTools[0]
  const currentModel = models
    .filter((model) => model.status === 'running')
    .sort((left, right) => right.sequence - left.sequence)[0]
  const hasReplyText = Boolean(currentModel?.text.trim())
  const hasReasoning = Boolean(currentModel?.reasoning.trim())

  return {
    generatingToolName: currentModel?.toolCallProgress?.find((preview) => !preview.complete)?.name,
    childSubagentCount: childSubagents.length,
    currentToolName: currentTool?.call.name,
    currentToolSummary: toolProvidedSummary(currentTool?.call.args),
    description: subagent ? subagentDescription(run, subagent) : undefined,
    modelCount: models.length,
    recoveryError: Boolean(
      subagent?.error?.trim()
      && (subagent.status === 'running' || subagent.status === 'interrupted')
    ),
    replying: hasReplyText,
    activeChildSubagentCount: childSubagents.filter(
      (subagent) => subagent.status === 'running' || subagent.status === 'interrupted'
    ).length,
    runningToolCount: runningTools.length,
    thinking: hasReasoning && !hasReplyText,
    toolCount: tools.length
  }
}

export function subagentActivityPhase(
  details: ReturnType<typeof subagentActivityDetails>,
  status: AgentSubagentActivityStatus
): string {
  if (details.recoveryError) return 'Recovery error'
  if (status === 'interrupted') return 'Waiting for approval'
  if (status === 'completed') return 'Completed'
  if (status === 'failed') return 'Failed'
  if (status === 'cancelled') return 'Cancelled'
  if (details.currentToolName) {
    const action = details.currentToolSummary ?? `call ${details.currentToolName}`
    const additionalToolCount = Math.max(0, details.runningToolCount - 1)
    return additionalToolCount > 0
      ? `${action} · +${additionalToolCount}`
      : action
  }
  if (details.activeChildSubagentCount > 0) return 'Waiting for subagent'
  if (details.generatingToolName) return `Generating ${details.generatingToolName} arguments`
  if (details.replying) return 'Replying'
  if (details.thinking) return 'Thinking'
  return 'Preparing'
}

export function subagentStatusLabel(status: AgentSubagentActivityStatus): string {
  switch (status) {
    case 'running': return 'Running'
    case 'interrupted': return 'Waiting for approval'
    case 'completed': return 'Completed'
    case 'failed': return 'Failed'
    case 'cancelled': return 'Cancelled'
  }
}

export function AgentSubagentStatusIcon({
  status,
  size = 12
}: {
  status: AgentSubagentActivityStatus
  size?: number
}) {
  switch (status) {
    case 'running': return <LoaderCircle className="agent-spin" size={size} />
    case 'interrupted': return <ShieldAlert size={size} />
    case 'completed': return <CircleCheck size={size} />
    case 'failed': return <CircleX size={size} />
    case 'cancelled': return <Ban size={size} />
  }
}

function countLabel(
  count: number,
  singular: string
): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

export function AgentSubagentActivityTrigger({
  run,
  subagentId,
  variant = 'icon',
  onOpenSubagent
}: {
  run: AgentRunActivity
  subagentId: string
  variant?: 'icon' | 'labeled'
  onOpenSubagent(runId: string, subagentId: string): void
}) {
  const [open, setOpen] = useState(false)
  const closeTimerRef = useRef<number | undefined>(undefined)
  const subagent = run.subagents.find((item) => item.id === subagentId)
  const details = subagentActivityDetails(run, subagentId)
  const cancelClose = useCallback(() => {
    if (closeTimerRef.current === undefined) return
    window.clearTimeout(closeTimerRef.current)
    closeTimerRef.current = undefined
  }, [])
  const scheduleClose = useCallback(() => {
    cancelClose()
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = undefined
      setOpen(false)
    }, 160)
  }, [cancelClose])

  useEffect(() => () => cancelClose(), [cancelClose])
  if (!subagent) return null

  const running = subagent.status === 'running'
  const active = running || subagent.status === 'interrupted'
  const recoveryError = active && Boolean(subagent.error?.trim())
  const summary = [
    countLabel(details.modelCount, 'model round'),
    countLabel(details.toolCount, 'tool call'),
    ...(details.childSubagentCount > 0
      ? [countLabel(details.childSubagentCount, 'subagent')]
      : [])
  ].join(' · ')
  const phase = subagentActivityPhase(details, subagent.status)
  const statusLabel = recoveryError ? 'Recovery error' : subagentStatusLabel(subagent.status)
  const label = `${subagent.name} · ${phase}`
  const openDrawer = () => {
    setOpen(false)
    onOpenSubagent(run.runId, subagent.id)
  }
  const triggerContent = (
    <>
      <span className="agent-subagent-activity-trigger-icon">
        <Bot size={15} />
        {active && (
          <span
            className="agent-subagent-activity-dot"
            data-status={subagent.status}
            data-recovery-error={recoveryError ? '' : undefined}
            aria-hidden="true"
          />
        )}
      </span>
      {variant === 'labeled' && (
        <>
          <span className="agent-subagent-activity-name">{subagent.name}</span>
          <span className="agent-subagent-activity-live-phase">{phase}</span>
        </>
      )}
    </>
  )

  if (variant === 'labeled') {
    return (
      <NoFocusButton
        className="agent-subagent-activity-trigger labeled"
        type="button"
        aria-label={label}
        data-agent-subagent-trigger=""
        data-agent-run-id={run.runId}
        data-agent-subagent-id={subagent.id}
        data-status={subagent.status}
        data-recovery-error={recoveryError ? '' : undefined}
        onClick={openDrawer}
      >
        {triggerContent}
      </NoFocusButton>
    )
  }

  return (
    <Popover.Root open={open}>
      <Popover.Anchor asChild>
        <NoFocusButton
          className="agent-subagent-activity-trigger icon"
          type="button"
          aria-label={label}
          data-agent-subagent-trigger=""
          data-agent-run-id={run.runId}
          data-agent-subagent-id={subagent.id}
          data-state={open ? 'open' : 'closed'}
          data-status={subagent.status}
          data-recovery-error={recoveryError ? '' : undefined}
          onClick={openDrawer}
          onMouseEnter={() => {
            cancelClose()
            setOpen(true)
          }}
          onMouseLeave={scheduleClose}
        >
          {triggerContent}
        </NoFocusButton>
      </Popover.Anchor>
      <Popover.Portal>
        <PopoverContent
          className="agent-subagent-activity-popover ui-popover"
          side="top"
          align="end"
          sideOffset={7}
          collisionPadding={12}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
        >
          <header className="agent-subagent-activity-popover-header">
            <span className="agent-subagent-activity-popover-icon">
              <Bot size={15} />
            </span>
            <strong>{subagent.name}</strong>
            <span
              data-status={subagent.status}
              data-recovery-error={recoveryError ? '' : undefined}
            >
              {recoveryError
                ? <CircleX size={12} />
                : <AgentSubagentStatusIcon status={subagent.status} />}
              {statusLabel}
            </span>
          </header>
          <div className="agent-subagent-activity-popover-body">
            {details.description && (
              <p className="agent-subagent-activity-description">{details.description}</p>
            )}
            {recoveryError && (
              <p
                className="agent-subagent-activity-description agent-subagent-activity-error"
                data-native-context-menu="text"
              >
                {subagent.error}
              </p>
            )}
            <div className="agent-subagent-activity-phase">
              {recoveryError
                ? <CircleX size={13} />
                : running && details.currentToolName
                ? <Wrench size={13} />
                : running
                  ? <LoaderCircle className="agent-spin" size={13} />
                  : <AgentSubagentStatusIcon status={subagent.status} size={13} />}
              <span>{phase}</span>
            </div>
            <small>{summary}</small>
          </div>
        </PopoverContent>
      </Popover.Portal>
    </Popover.Root>
  )
}

export function AgentSubagentActivityDock({
  run,
  onOpenSubagent
}: AgentSubagentActivityDockProps) {
  const activeSubagents = activeSubagentsForRun(run)
  if (!run || activeSubagents.length === 0) return null
  const visible = activeSubagents.slice(0, 4)
  const overflow = activeSubagents.slice(4)

  return (
    <div className="agent-subagent-activity-dock">
      {visible.map((subagent) => (
        <AgentSubagentActivityTrigger
          key={subagent.id}
          run={run}
          subagentId={subagent.id}
          onOpenSubagent={onOpenSubagent}
        />
      ))}
      {overflow.length > 0 && (
        <Popover.Root>
          <Popover.Trigger asChild>
            <NoFocusButton
              className="agent-subagent-activity-trigger agent-subagent-activity-overflow-trigger icon"
              type="button"
              aria-label={`${overflow.length} more active subagents`}
            >
              +{overflow.length}
            </NoFocusButton>
          </Popover.Trigger>
          <Popover.Portal>
            <PopoverContent
              className="agent-subagent-activity-overflow-content ui-popover"
              side="top"
              align="end"
              sideOffset={7}
              collisionPadding={12}
              onOpenAutoFocus={(event) => event.preventDefault()}
              onCloseAutoFocus={(event) => event.preventDefault()}
            >
              {overflow.map((subagent) => (
                <AgentSubagentActivityTrigger
                  key={subagent.id}
                  run={run}
                  subagentId={subagent.id}
                  variant="labeled"
                  onOpenSubagent={onOpenSubagent}
                />
              ))}
            </PopoverContent>
          </Popover.Portal>
        </Popover.Root>
      )}
    </div>
  )
}
