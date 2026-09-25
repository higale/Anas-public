import * as Dialog from '@radix-ui/react-dialog'
import { ShieldAlert, ShieldCheck } from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentAccessMode, AgentInterrupt, AgentInterruptResponse } from '@shared/agentTypes'
import { NoFocusButton } from '../NoFocusButton'
import { resizeAutosizeTextarea } from '../autosizeTextarea'
import {
  approvalDescriptionKind,
  approvalResponses,
  interruptActions,
  rejectionResponses,
  type ApprovalAction
} from './agentApproval'

function ActionDescription({ action }: { action: ApprovalAction }) {
  const { t } = useTranslation()
  if (action.recovery) return action.description ? <p>{action.description}</p> : null
  const kind = approvalDescriptionKind(action.name)
  if (kind === 'shell') return <p>{t('agent.approval_shell_action_description')}</p>
  if (kind === 'host_file') return <p>{t('agent.approval_host_file_action_description')}</p>
  if (kind === 'configuration') return <p>{t('agent.approval_configuration_action_description')}</p>
  return action.description ? <p>{action.description}</p> : null
}

function ShellAction({ action }: { action: ApprovalAction }) {
  const { t } = useTranslation()
  const command = typeof action.args.command === 'string' ? action.args.command : ''
  const workingDirectoryPreview = action.pathPreviews
    .find((preview) => preview.locator.length === 1 && preview.locator[0] === 'working_dir')
  const workingDirectory = typeof action.args.working_dir === 'string'
    ? action.args.working_dir
    : t('agent.shell_default_working_directory')
  const timeout = typeof action.args.timeout !== 'number'
    ? t('agent.shell_default_timeout')
    : action.args.timeout === 0
      ? t('agent.shell_no_timeout')
      : t('agent.shell_timeout_seconds', { count: action.args.timeout })

  return (
    <dl className="agent-approval-shell">
      <div>
        <dt>{t('agent.shell_command')}</dt>
        <dd><pre>{command}</pre></dd>
      </div>
      <div>
        <dt>{t('agent.shell_working_directory')}</dt>
        <dd>
          <code
            className={workingDirectoryPreview && ['relative', 'canonical'].includes(workingDirectoryPreview.source)
              ? 'agent-approval-relative-path'
              : undefined}
            data-tooltip={workingDirectoryPreview?.absolutePath}
          >
            {workingDirectory}
          </code>
        </dd>
      </div>
      <div>
        <dt>{t('agent.shell_timeout')}</dt>
        <dd>{timeout}</dd>
      </div>
    </dl>
  )
}

function pathPreview(
  action: ApprovalAction,
  locator: Array<string | number>
) {
  return action.pathPreviews.find((preview) =>
    preview.locator.length === locator.length
    && preview.locator.every((segment, index) => segment === locator[index])
  )
}

function scalarJson(value: unknown): string {
  const serialized = JSON.stringify(value)
  return serialized === undefined ? String(value) : serialized
}

function JsonValue({
  action,
  depth,
  locator,
  value
}: {
  action: ApprovalAction
  depth: number
  locator: Array<string | number>
  value: unknown
}): ReactNode {
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return <>
      {'[\n'}
      {value.map((item, index) => (
        <Fragment key={index}>
          {'  '.repeat(depth + 1)}
          <JsonValue
            action={action}
            depth={depth + 1}
            locator={[...locator, index]}
            value={item}
          />
          {index < value.length - 1 ? ',\n' : '\n'}
        </Fragment>
      ))}
      {'  '.repeat(depth)}]
    </>
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return '{}'
    return <>
      {'{\n'}
      {entries.map(([key, item], index) => (
        <Fragment key={key}>
          {'  '.repeat(depth + 1)}
          {JSON.stringify(key)}{': '}
          <JsonValue
            action={action}
            depth={depth + 1}
            locator={[...locator, key]}
            value={item}
          />
          {index < entries.length - 1 ? ',\n' : '\n'}
        </Fragment>
      ))}
      {'  '.repeat(depth)}{'}'}
    </>
  }

  const preview = pathPreview(action, locator)
  const content = scalarJson(value)
  return preview && ['relative', 'canonical'].includes(preview.source)
    ? <span className="agent-approval-relative-path" data-tooltip={preview.absolutePath}>{content}</span>
    : content
}

function ActionArguments({ action }: { action: ApprovalAction }) {
  if (approvalDescriptionKind(action.name) === 'shell') return <ShellAction action={action} />
  const args = ['apply_patch', 'restore_file_edit'].includes(action.name) && action.pathPreviews.length
    ? { ...action.args, targets: action.pathPreviews.map((preview) => ({ path: preview.absolutePath })) }
    : action.args
  return (
    <pre className="agent-approval-arguments">
      <JsonValue action={action} depth={0} locator={[]} value={args} />
    </pre>
  )
}

export function AgentApprovalPanel({
  error,
  accessMode,
  interrupts,
  onRequestFullAccess,
  onResume
}: {
  error?: string
  accessMode: AgentAccessMode
  interrupts: AgentInterrupt[]
  onRequestFullAccess(responses: AgentInterruptResponse[]): void
  onResume(responses: AgentInterruptResponse[]): void | Promise<void>
}) {
  const { t } = useTranslation()
  const actions = useMemo(() => interruptActions(interrupts), [interrupts])
  const approveResponses = useMemo(
    () => approvalResponses(actions),
    [actions]
  )
  const hasRecoveryAction = actions.some((action) => Boolean(action.recovery))
  const allActionsAreRecovery = actions.length > 0 && actions.every((action) => Boolean(action.recovery))
  const [guidance, setGuidance] = useState('')
  const guidanceRef = useRef<HTMLTextAreaElement>(null)
  const [submitError, setSubmitError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const submittingRef = useRef(false)

  useLayoutEffect(() => {
    resizeAutosizeTextarea(guidanceRef.current)
  }, [guidance])

  useEffect(() => {
    const resizeGuidance = (): void => resizeAutosizeTextarea(guidanceRef.current)
    window.addEventListener('resize', resizeGuidance)
    return () => window.removeEventListener('resize', resizeGuidance)
  }, [])

  useEffect(() => {
    setGuidance('')
    setSubmitError('')
    setSubmitting(false)
    submittingRef.current = false
  }, [actions])

  async function deliver(responses: AgentInterruptResponse[]): Promise<void> {
    if (submittingRef.current || responses.length === 0) return
    submittingRef.current = true
    setSubmitting(true)
    setSubmitError('')
    try {
      await onResume(responses)
    } catch {
      submittingRef.current = false
      setSubmitting(false)
      setSubmitError(t('agent.approval_submit_failed'))
    }
  }

  function approveAll(): void {
    void deliver(approveResponses)
  }

  function rejectAll(): void {
    void deliver(rejectionResponses(actions, guidance))
  }

  return (
    <Dialog.Root open modal>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-backdrop" />
        <Dialog.Content
          className="ui-dialog ui-dialog-wide ui-dialog-centered ui-popover agent-approval"
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            rejectAll()
          }}
          onInteractOutside={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const input = document.querySelector<HTMLTextAreaElement>('[data-agent-composer-input]')
            if (input && !input.disabled && input.isConnected) input.focus({ preventScroll: true })
          }}
        >
          <header className="ui-dialog-header">
            <div className="ui-dialog-icon agent-approval-icon">
              <ShieldAlert size={18} />
            </div>
            <div>
              <Dialog.Title asChild>
                <h2 className="ui-dialog-title">
                  {t(allActionsAreRecovery ? 'agent.effect_recovery_required' : 'agent.approval_required')}
                </h2>
              </Dialog.Title>
              <Dialog.Description asChild>
                <p className="ui-dialog-description">
                  {t(allActionsAreRecovery ? 'agent.effect_recovery_description' : 'agent.approval_description')}
                </p>
              </Dialog.Description>
            </div>
          </header>
          <div className="agent-approval-actions">
            {actions.map((action, index) => (
              <section className="agent-approval-action" key={`${action.interruptId}:${action.name}:${index}`}>
                <code className="agent-approval-tool-name">{action.name}</code>
                <ActionDescription action={action} />
                <ActionArguments action={action} />
              </section>
            ))}
          </div>
          <textarea
            ref={guidanceRef}
            className="ui-textarea ui-autosize-textarea ui-textarea-wrap agent-approval-guidance"
            data-max-height="160"
            rows={2}
            value={guidance}
            placeholder={t('agent.rejection_guidance')}
            disabled={submitting}
            onChange={(event) => {
              setGuidance(event.target.value)
              setSubmitError('')
            }}
          />
          {(submitError || error) && (
            <p className="ui-status-danger">{submitError || error}</p>
          )}
          <footer className="ui-dialog-footer agent-approval-footer">
            {accessMode !== 'full_access' && !hasRecoveryAction && approveResponses.length > 0 && (
              <NoFocusButton
                className="ui-button agent-approval-full-access"
                type="button"
                disabled={submitting}
                onClick={() => onRequestFullAccess(approveResponses)}
              >
                <ShieldCheck size={14} />
                <span>{t('chat.access_full')}</span>
              </NoFocusButton>
            )}
            <div className="ui-dialog-footer agent-approval-footer-actions">
              <NoFocusButton
                className="ui-button"
                type="button"
                disabled={submitting || actions.length === 0}
                onClick={rejectAll}
              >
                {t(allActionsAreRecovery
                  ? 'agent.do_not_retry'
                  : guidance.trim() ? 'agent.reject_with_reason' : 'agent.reject')}
              </NoFocusButton>
              <NoFocusButton
                className="ui-button ui-button-primary"
                type="button"
                disabled={submitting || actions.length === 0}
                onClick={approveAll}
              >
                {t(allActionsAreRecovery ? 'agent.retry' : 'agent.approve')}
              </NoFocusButton>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
