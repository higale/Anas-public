import { PopoverContent } from '../PopoverContent'
import * as Popover from '@radix-ui/react-popover'
import { Check, Circle, CircleDot, ListChecks, LoaderCircle } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentTodo } from '@shared/agentTypes'
import { NoFocusButton } from '../NoFocusButton'

interface AgentTaskPlanProps {
  active: boolean
  todos: AgentTodo[]
}

export interface AgentTaskPlanSummary {
  completed: number
  total: number
}

export function agentTaskPlanSummary(todos: AgentTodo[]): AgentTaskPlanSummary {
  return {
    completed: todos.filter((todo) => todo.status === 'completed').length,
    total: todos.length
  }
}

function TodoStatusIcon({ active, status }: {
  active: boolean
  status: AgentTodo['status']
}) {
  if (status === 'completed') return <Check size={13} strokeWidth={2.5} />
  if (status === 'in_progress') {
    return active
      ? <LoaderCircle className="agent-spin" size={13} />
      : <CircleDot size={13} />
  }
  return <Circle size={12} />
}

export function AgentTaskPlan({ active, todos }: AgentTaskPlanProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const closeTimerRef = useRef<number | undefined>(undefined)
  const openReasonRef = useRef<'hover' | 'trigger'>('trigger')
  const summary = agentTaskPlanSummary(todos)
  const complete = summary.total > 0 && summary.completed === summary.total
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
  useEffect(() => {
    if (!complete) return
    setOpen(false)
  }, [complete])
  if (todos.length === 0) return null

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <NoFocusButton
          className={complete
            ? 'agent-task-plan-trigger agent-task-plan-complete'
            : 'agent-task-plan-trigger'}
          type="button"
          onClick={(event) => {
            if (open && openReasonRef.current === 'hover') event.preventDefault()
            cancelClose()
            openReasonRef.current = 'trigger'
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
              openReasonRef.current = 'trigger'
            }
          }}
          onMouseEnter={() => {
            cancelClose()
            if (open) return
            openReasonRef.current = 'hover'
            setOpen(true)
          }}
          onMouseLeave={() => {
            if (openReasonRef.current === 'hover') scheduleClose()
          }}
        >
          <strong>{complete ? t('agent.task_plan_completed') : t('agent.task_plan')}</strong>
          <span className="agent-task-plan-count">
            {t('agent.task_plan_progress', {
              completed: summary.completed,
              total: summary.total
            })}
          </span>
        </NoFocusButton>
      </Popover.Trigger>
      <Popover.Portal>
        <PopoverContent
          className="agent-task-plan-popover ui-popover"
          side="top"
          align="start"
          sideOffset={7}
          collisionPadding={12}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onMouseEnter={cancelClose}
          onMouseLeave={() => {
            if (openReasonRef.current === 'hover') scheduleClose()
          }}
        >
          <header className="agent-task-plan-popover-header">
            <span className="agent-task-plan-popover-icon">
              {complete
                ? <Check size={14} strokeWidth={2.5} />
                : <ListChecks size={14} />}
            </span>
            <strong>{complete ? t('agent.task_plan_completed') : t('agent.task_plan')}</strong>
            <span>{t('agent.task_plan_progress', {
              completed: summary.completed,
              total: summary.total
            })}</span>
          </header>
          <ol className="agent-task-plan-list">
            {todos.map((todo, index) => (
              <li className={`agent-task-plan-item agent-task-plan-item-${todo.status}`} key={`${index}:${todo.content}`}>
                <span className="agent-task-plan-item-icon">
                  <TodoStatusIcon active={active} status={todo.status} />
                </span>
                <span className="agent-task-plan-item-number">{index + 1}</span>
                <span>{todo.content}</span>
              </li>
            ))}
          </ol>
        </PopoverContent>
      </Popover.Portal>
    </Popover.Root>
  )
}
