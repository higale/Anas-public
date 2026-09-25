import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { UserInputRequest, UserInputResponse, UserInputSnapshot } from '@shared/userInput'
import { notice } from '../notice'
import { resizeAutosizeTextarea, resizeAutosizeTextareasIn } from '../autosizeTextarea'

export function UserInputDialog() {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<UserInputSnapshot>({ revision: -1, requests: [] })
  useEffect(() => {
    let active = true
    const accept = (next: UserInputSnapshot) => {
      if (active) setSnapshot(current => next.revision >= current.revision ? next : current)
    }
    const unsubscribe = window.gale.agent.userInput.onChange(accept)
    void window.gale.agent.userInput.list().then(accept).catch(() => {
      if (active) notice.error(t('agent.user_input_failed'))
    })
    return () => { active = false; unsubscribe() }
  }, [t])
  const request = snapshot.requests[0]
  return request ? <UserInputForm key={request.id} request={request} pendingCount={snapshot.requests.length - 1} /> : null
}

function UserInputForm({ request, pendingCount }: { request: UserInputRequest; pendingCount: number }) {
  const { t } = useTranslation()
  const [answers, setAnswers] = useState(() => request.questions.map(question => ({
    question_id: question.id, selected_options: [] as string[], other: ''
  })))
  const [now, setNow] = useState(Date.now)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const interactionPending = useRef(false)
  const formRef = useRef<HTMLFormElement>(null)
  useLayoutEffect(() => { resizeAutosizeTextareasIn(formRef.current) }, [answers])
  useEffect(() => {
    const resize = () => resizeAutosizeTextareasIn(formRef.current)
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])
  useEffect(() => {
    void window.gale.agent.userInput.shown(request.id).catch(() => setError(t('agent.user_input_failed')))
  }, [request.id, t])
  useEffect(() => {
    if (request.deadline === undefined) return
    const timer = window.setInterval(() => setNow(Date.now()), 250)
    return () => window.clearInterval(timer)
  }, [request.deadline])
  const remaining = request.deadline === undefined ? request.timeoutSeconds
    : Math.min(request.timeoutSeconds, Math.max(0, Math.ceil((request.deadline - now) / 1_000)))
  const waiting = request.requireResponse || request.interacted
  const expired = !waiting && remaining === 0
  const complete = answers.every(answer => answer.selected_options.length > 0 || answer.other.trim())

  function interact(): void {
    if (waiting || busy || expired || interactionPending.current) return
    interactionPending.current = true
    void window.gale.agent.userInput.interact(request.id).catch(() => {
      interactionPending.current = false
      setError(t('agent.user_input_failed'))
    })
  }

  async function respond(response: UserInputResponse): Promise<void> {
    if (busy || expired) return
    setBusy(true)
    setError('')
    try {
      await window.gale.agent.userInput.respond(request.id, response)
    } catch {
      setError(t('agent.user_input_failed'))
      setBusy(false)
    }
  }

  return (
    <Dialog.Root open onOpenChange={open => { if (!open) void respond({ status: 'cancelled' }) }}>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-backdrop" />
        <Dialog.Content asChild aria-describedby={undefined} onInteractOutside={event => event.preventDefault()}
          onEscapeKeyDown={event => { if (event.isComposing) event.preventDefault() }}>
          <form ref={formRef} className="ui-dialog ui-dialog-medium ui-dialog-centered ui-dialog-fixed-footer ui-popover"
            onPointerDownCapture={interact} onKeyDownCapture={interact} onChangeCapture={interact}
            onCompositionStartCapture={interact} onWheelCapture={interact}
            onSubmit={event => { event.preventDefault(); if (complete) void respond({ status: 'answered', answers }) }}>
            <div className="ui-dialog-body ui-form-section">
              <header>
                <Dialog.Title className="ui-dialog-title">{t('agent.user_input_title')}</Dialog.Title>
                <div className="ui-field-hint">
                  <div>{t('agent.user_input_source', { project: request.source.projectName, thread: request.source.threadTitle })}</div>
                  {request.source.agentName && <div>{t('agent.user_input_agent', { name: request.source.agentName })}</div>}
                  {pendingCount > 0 && <div>{t('agent.user_input_pending', { count: pendingCount })}</div>}
                </div>
              </header>
              {request.questions.map((question, index) => {
                const answer = answers[index]
                return <div className="ui-field-stack" role="group" aria-label={question.question} key={question.id}>
                  <span className="ui-field-label">{question.question}</span>
                  {question.options.map(option => <label
                    className={`ui-check-card ui-list-item${answer.selected_options.includes(option.label) ? ' ui-list-item-active' : ''}`}
                    key={option.label}>
                    <input className="ui-checkbox" type={question.multiple ? 'checkbox' : 'radio'} name={`${request.id}-${question.id}`}
                      disabled={busy || expired} checked={answer.selected_options.includes(option.label)}
                      onChange={event => setAnswers(current => current.map((item, i) => i !== index ? item : {
                        ...item,
                        selected_options: question.multiple
                          ? event.target.checked ? [...item.selected_options, option.label] : item.selected_options.filter(label => label !== option.label)
                          : [option.label],
                        other: question.multiple ? item.other : ''
                      }))} />
                    <span className="ui-copy-stack"><span>{option.label}</span>
                      {option.description && <small className="ui-muted">{option.description}</small>}
                    </span>
                  </label>)}
                  <label className="ui-field-stack">
                    <span className="ui-muted">{t('agent.user_input_other')}</span>
                    <textarea ref={resizeAutosizeTextarea} className="ui-autosize-textarea ui-code-textarea ui-textarea-wrap"
                      rows={2} data-min-rows="2" data-max-rows="5" maxLength={8_000}
                      disabled={busy || expired} value={answer.other}
                      onChange={event => setAnswers(current => current.map((item, i) => i !== index ? item : {
                        ...item, other: event.target.value,
                        selected_options: !question.multiple && event.target.value.trim() ? [] : item.selected_options
                      }))} />
                  </label>
                </div>
              })}
              {error && <p role="alert">{error}</p>}
            </div>
            <footer className="ui-dialog-footer">
              <small className="ui-muted ui-dialog-footer-start" role="timer">
                {waiting ? t('agent.user_input_waiting') : t('agent.user_input_remaining', { count: remaining })}
              </small>
              <button className="ui-button ui-button-compact" type="button" disabled={busy || expired}
                onClick={() => void respond({ status: 'cancelled' })}>{t('common.cancel')}</button>
              <button className="ui-button ui-button-compact ui-button-primary" type="submit" disabled={busy || expired || !complete}>
                {t('agent.user_input_submit')}
              </button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
